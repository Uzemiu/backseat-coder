const vscode = require("vscode");
const path = require("node:path");
const { createSidebarProvider } = require("./src/webview");
const { createConfig } = require("./src/config");
const { createLogger } = require("./src/core/logger");
const { createAiService } = require("./src/services/ai");
const { createGitService } = require("./src/services/git");
const { createRepositoryService } = require("./src/services/repository");
const { createSessionStore } = require("./src/storage/sessions");
const { createHandlers } = require("./src/app");

const AFK_TIMEOUT_MS = 2 * 60 * 1000;
const SAVE_DEBOUNCE_MS = 1500;
// 文本修改远比保存频繁（每敲一个字都触发），用空闲防抖等你真正停手再检查。
// 2.5s 是经验值：太短会在你还在打字时就触发，太长又显得迟钝。
const CHANGE_DEBOUNCE_MS = 2500;
// 定时轮询：即便没有保存/修改事件，也周期性检查 diff 是否变化
const POLL_INTERVAL_MS = 30 * 1000;
// 未保存编辑的最小 AI 检查间隔：change/poll 触发时，距上次检查不足此值就跳过，
// 避免打字过程中反复烧 token。保存(save)是明确的检查点信号，不受此限。
const MIN_UNSAVED_CHECK_INTERVAL_MS = 5 * 1000;
// 阅读陪伴：光标在一处停留超过此值（且无编辑）→ 讲解光标所在函数/块
const EXPLAIN_DEBOUNCE_MS = 4000;
// 讲解只关心光标停驻，若最近刚有编辑活动说明你在写而非读，跳过讲解
const EXPLAIN_MIN_IDLE_AFTER_EDIT_MS = 1500;

function activate(context) {
  const config = createConfig();
  const { log } = createLogger(config);
  const repositoryService = createRepositoryService({ log });
  const gitService = createGitService({ log });
  const aiService = createAiService({ config, log });
  const sessionStore = createSessionStore(config);

  const deps = { aiService, config, gitService, log, repositoryService, sessionStore };
  const handlers = createHandlers(deps);
  deps.handlers = handlers;

  const sensingState = {
    repoPath: "",
    repoMap: null,
    task: "",
    lastDiffHash: "",
    lastActivityAt: Date.now(),
    lastCheckAt: 0,
    lastEditAt: 0,
    isAfk: false,
    saveDebounceTimer: null,
    changeDebounceTimer: null,
    selectionDebounceTimer: null,
    diffCheckInFlight: false,
    explainInFlight: false,
    lastExplainKey: ""
  };

  deps.workspacePath = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath ?? "";
  if (deps.workspacePath) sensingState.repoPath = deps.workspacePath;

  deps.onContext = (payload) => {
    if (payload.repoPath) sensingState.repoPath = payload.repoPath;
    if (payload.repoMap)  sensingState.repoMap  = payload.repoMap;
    if (payload.task)     sensingState.task      = payload.task;
  };

  const sidebarProvider = createSidebarProvider(context, deps);

  const providerDisposable = vscode.window.registerWebviewViewProvider(
    "backseatCoder.sidebar",
    sidebarProvider
  );
  context.subscriptions.push(providerDisposable);

  const openCommand = vscode.commands.registerCommand("backseat-coder.open", () => {
    vscode.commands.executeCommand("backseatCoder.sidebar.focus");
  });
  context.subscriptions.push(openCommand);

  // --- Sensing helpers ---

  function markActivity() {
    sensingState.lastActivityAt = Date.now();
    if (sensingState.isAfk) wakeUp();
  }

  function goAfk() {
    if (sensingState.isAfk) return;
    sensingState.isAfk = true;
    sidebarProvider.postMessage({ type: "afk" });
  }

  function wakeUp() {
    if (!sensingState.isAfk) return;
    sensingState.isAfk = false;
    sidebarProvider.postMessage({ type: "wake" });
  }

  function tickAfk() {
    const idle = Date.now() - sensingState.lastActivityAt;
    if (!sensingState.isAfk && idle >= AFK_TIMEOUT_MS) goAfk();
  }

  // 采集当前 repo 内所有未保存（dirty）的文件缓冲区，供大脑层生成"未保存内容的 diff"。
  function collectDirtyBuffers() {
    if (!sensingState.repoPath) return [];
    const resolvedRepo = path.resolve(sensingState.repoPath).toLowerCase();
    const out = [];
    for (const doc of vscode.workspace.textDocuments) {
      if (!doc.isDirty) continue;
      if (doc.uri.scheme !== "file") continue; // 跳过 untitled / output / git 等非磁盘文档
      const abs = path.resolve(doc.fileName);
      if (!abs.toLowerCase().startsWith(resolvedRepo)) continue; // repo 外的文件
      const relpath = path.relative(sensingState.repoPath, abs);
      if (relpath.startsWith("..")) continue;
      out.push({ relpath, content: doc.getText() });
    }
    return out;
  }

  // trigger: 'save' | 'change' | 'poll'
  // - save 是明确的检查点信号，任何时候都跑
  // - change / poll 是"打字/轮询"触发，距上次检查不足最小间隔就跳过，省 token
  async function runDiffCheck(trigger = "poll") {
    if (sensingState.isAfk || !sensingState.repoPath) return;
    if (sensingState.diffCheckInFlight) return;

    if (trigger !== "save") {
      const sinceLast = Date.now() - sensingState.lastCheckAt;
      if (sinceLast < MIN_UNSAVED_CHECK_INTERVAL_MS) return;
    }

    // 重入锁：三个触发源（保存/修改/轮询）可能重叠调用。由于 lastDiffHash 只在
    // diffCheck 返回后才更新，重叠的调用会读到同一个旧 hash，把同一份 diff 判定为
    // changed 而重复推卡片。此锁保证同一时间只有一个检查在跑。
    sensingState.diffCheckInFlight = true;
    sensingState.lastCheckAt = Date.now();
    try {
      const result = await handlers.diffCheck({
        repoPath: sensingState.repoPath,
        repoMap: sensingState.repoMap,
        previousDiffHash: sensingState.lastDiffHash,
        dirtyBuffers: collectDirtyBuffers()
      });
      if (result.changed) {
        // diff 内容变了就记住新 hash（哪怕不推卡片），避免对同一份内容反复评估
        sensingState.lastDiffHash = result.diffHash;
        // 只有 AI 认为"值得说"时才推卡片（原则六 懂分寸）。本地兜底默认 worthMentioning=true。
        if (result.worthMentioning) {
          sidebarProvider.postMessage({ type: "card", kind: "diff", payload: result });
        }
      }
    } catch (err) {
      log("warn", "sensing.diffCheck.failed", { error: err.message });
    } finally {
      sensingState.diffCheckInFlight = false;
    }
  }

  // 找出包含指定行的最内层函数/方法/类符号。用语言服务的 DocumentSymbolProvider，
  // 拿不到（无语言服务/未索引）时返回 null，由调用方回退到光标附近固定行数。
  async function findEnclosingSymbol(uri, line) {
    let symbols;
    try {
      symbols = await vscode.commands.executeCommand("vscode.executeDocumentSymbolProvider", uri);
    } catch {
      return null;
    }
    if (!symbols || !symbols.length) return null;

    const wanted = new Set([
      vscode.SymbolKind.Function,
      vscode.SymbolKind.Method,
      vscode.SymbolKind.Constructor,
      vscode.SymbolKind.Class
    ]);
    let best = null;
    const visit = (nodes) => {
      for (const s of nodes) {
        if (s.range.start.line <= line && line <= s.range.end.line) {
          // 越靠内层的符号 range 越小，用它覆盖外层，得到最贴近光标的那个
          if (wanted.has(s.kind) && (!best || s.range.start.line >= best.range.start.line)) {
            best = s;
          }
          if (s.children?.length) visit(s.children);
        }
      }
    };
    visit(symbols);
    return best;
  }

  // 取光标所在的"可讲解范围"：优先整个函数/块，回退到光标上下各 20 行。
  async function getExplainTarget(editor) {
    const doc = editor.document;
    const line = editor.selection.active.line;
    const symbol = await findEnclosingSymbol(doc.uri, line);

    if (symbol) {
      const text = doc.getText(symbol.range);
      return { code: text, symbolName: symbol.name, startLine: symbol.range.start.line };
    }
    // 回退：光标上下各 20 行
    const start = Math.max(0, line - 20);
    const end = Math.min(doc.lineCount - 1, line + 20);
    const range = new vscode.Range(start, 0, end, doc.lineAt(end).text.length);
    return { code: doc.getText(range), symbolName: "", startLine: start };
  }

  // 光标停驻讲解：陪你"读"代码。护栏——AFK 跳过、刚编辑过跳过（那是在写不是在读）、
  // 同一函数不重复讲、重入锁；讲解范围过大或过小都不讲，避免浪费与噪音。
  async function runExplain() {
    if (sensingState.isAfk || !sensingState.repoPath) return;
    if (sensingState.explainInFlight) return;
    if (Date.now() - sensingState.lastEditAt < EXPLAIN_MIN_IDLE_AFTER_EDIT_MS) return;

    const editor = vscode.window.activeTextEditor;
    if (!editor) return;
    const doc = editor.document;
    if (doc.uri.scheme !== "file") return;
    const abs = path.resolve(doc.fileName);
    const resolvedRepo = path.resolve(sensingState.repoPath).toLowerCase();
    if (!abs.toLowerCase().startsWith(resolvedRepo)) return;

    let target;
    try {
      target = await getExplainTarget(editor);
    } catch (err) {
      log("warn", "sensing.explain.target_failed", { error: err.message });
      return;
    }
    const code = (target.code || "").trim();
    if (code.length < 20 || code.length > 6000) return; // 太短没内容、太长成本高且多半选错范围

    const relpath = path.relative(sensingState.repoPath, abs);
    // 去重键：同一文件 + 同一符号（或回退起始行）→ 视为同一段，不重复讲
    const key = `${relpath}::${target.symbolName || "L" + target.startLine}`;
    if (key === sensingState.lastExplainKey) return;

    sensingState.explainInFlight = true;
    try {
      const result = await handlers.explainCode({
        repoPath: sensingState.repoPath,
        repoMap: sensingState.repoMap,
        filePath: relpath,
        code,
        symbolName: target.symbolName,
        lineNumber: target.startLine + 1
      });
      sensingState.lastExplainKey = key;
      sidebarProvider.postMessage({ type: "card", kind: "explain", payload: result });
    } catch (err) {
      log("warn", "sensing.explain.failed", { error: err.message });
    } finally {
      sensingState.explainInFlight = false;
    }
  }

  // --- Event listeners ---

  const saveListener = vscode.workspace.onDidSaveTextDocument((doc) => {
    markActivity();
    sensingState.lastEditAt = Date.now();
    if (!sensingState.repoPath) return;
    const resolvedDoc = path.resolve(doc.fileName).toLowerCase();
    const resolvedRepo = path.resolve(sensingState.repoPath).toLowerCase();
    if (!resolvedDoc.startsWith(resolvedRepo)) return;
    clearTimeout(sensingState.saveDebounceTimer);
    sensingState.saveDebounceTimer = setTimeout(() => runDiffCheck("save"), SAVE_DEBOUNCE_MS);
  });
  context.subscriptions.push(saveListener);

  const textChangeListener = vscode.workspace.onDidChangeTextDocument((event) => {
    markActivity();
    sensingState.lastEditAt = Date.now();
    if (!sensingState.repoPath) return;
    const resolvedDoc = path.resolve(event.document.fileName).toLowerCase();
    const resolvedRepo = path.resolve(sensingState.repoPath).toLowerCase();
    if (!resolvedDoc.startsWith(resolvedRepo)) return;
    clearTimeout(sensingState.changeDebounceTimer);
    sensingState.changeDebounceTimer = setTimeout(() => runDiffCheck("change"), CHANGE_DEBOUNCE_MS);
  });
  context.subscriptions.push(textChangeListener);

  // 光标移动：既算"在场活动"（避免只读代码不编辑被误判 AFK），也触发阅读讲解防抖
  const selectionListener = vscode.window.onDidChangeTextEditorSelection((event) => {
    markActivity();
    if (!sensingState.repoPath) return;
    if (event.textEditor.document.uri.scheme !== "file") return;
    clearTimeout(sensingState.selectionDebounceTimer);
    sensingState.selectionDebounceTimer = setTimeout(runExplain, EXPLAIN_DEBOUNCE_MS);
  });
  context.subscriptions.push(selectionListener);

  const windowStateListener = vscode.window.onDidChangeWindowState((windowState) => {
    if (!windowState.focused) goAfk();
    else markActivity();
  });
  context.subscriptions.push(windowStateListener);

  const afkTimer = setInterval(tickAfk, 30_000);
  context.subscriptions.push({ dispose: () => clearInterval(afkTimer) });

  // 定时轮询：即便没有保存/修改事件，也周期性检查 diff（runDiffCheck 内部已按 diffHash 去重，
  // 且在 AFK 时会自行跳过，因此不会重复推送或在空闲时空耗）
  const pollTimer = setInterval(() => runDiffCheck("poll"), POLL_INTERVAL_MS);
  context.subscriptions.push({ dispose: () => clearInterval(pollTimer) });

  context.subscriptions.push({ dispose: () => clearTimeout(sensingState.saveDebounceTimer) });
  context.subscriptions.push({ dispose: () => clearTimeout(sensingState.changeDebounceTimer) });
  context.subscriptions.push({ dispose: () => clearTimeout(sensingState.selectionDebounceTimer) });
}

function deactivate() {}

module.exports = { activate, deactivate };
