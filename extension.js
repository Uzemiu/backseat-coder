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
// 文本修改远比保存频繁（每敲一个字都触发），用更长的空闲防抖避免疯狂调用 AI
const CHANGE_DEBOUNCE_MS = 2500;
// 定时轮询：即便没有保存/修改事件，也周期性检查 diff 是否变化
const POLL_INTERVAL_MS = 30 * 1000;

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
    isAfk: false,
    saveDebounceTimer: null,
    changeDebounceTimer: null,
    diffCheckInFlight: false
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

  async function runDiffCheck() {
    if (sensingState.isAfk || !sensingState.repoPath) return;
    // 重入锁：三个触发源（保存/修改/轮询）可能重叠调用。由于 lastDiffHash 只在
    // diffCheck 返回后才更新，重叠的调用会读到同一个旧 hash，把同一份 diff 判定为
    // changed 而重复推卡片。此锁保证同一时间只有一个检查在跑。
    if (sensingState.diffCheckInFlight) return;
    sensingState.diffCheckInFlight = true;
    try {
      const result = await handlers.diffCheck({
        repoPath: sensingState.repoPath,
        repoMap: sensingState.repoMap,
        previousDiffHash: sensingState.lastDiffHash
      });
      if (result.changed) {
        sensingState.lastDiffHash = result.diffHash;
        sidebarProvider.postMessage({ type: "card", kind: "diff", payload: result });
      }
    } catch (err) {
      log("warn", "sensing.diffCheck.failed", { error: err.message });
    } finally {
      sensingState.diffCheckInFlight = false;
    }
  }

  // --- Event listeners ---

  const saveListener = vscode.workspace.onDidSaveTextDocument((doc) => {
    markActivity();
    if (!sensingState.repoPath) return;
    const resolvedDoc = path.resolve(doc.fileName).toLowerCase();
    const resolvedRepo = path.resolve(sensingState.repoPath).toLowerCase();
    if (!resolvedDoc.startsWith(resolvedRepo)) return;
    clearTimeout(sensingState.saveDebounceTimer);
    sensingState.saveDebounceTimer = setTimeout(runDiffCheck, SAVE_DEBOUNCE_MS);
  });
  context.subscriptions.push(saveListener);

  const textChangeListener = vscode.workspace.onDidChangeTextDocument((event) => {
    markActivity();
    if (!sensingState.repoPath) return;
    const resolvedDoc = path.resolve(event.document.fileName).toLowerCase();
    const resolvedRepo = path.resolve(sensingState.repoPath).toLowerCase();
    if (!resolvedDoc.startsWith(resolvedRepo)) return;
    clearTimeout(sensingState.changeDebounceTimer);
    sensingState.changeDebounceTimer = setTimeout(runDiffCheck, CHANGE_DEBOUNCE_MS);
  });
  context.subscriptions.push(textChangeListener);

  const windowStateListener = vscode.window.onDidChangeWindowState((windowState) => {
    if (!windowState.focused) goAfk();
    else markActivity();
  });
  context.subscriptions.push(windowStateListener);

  const afkTimer = setInterval(tickAfk, 30_000);
  context.subscriptions.push({ dispose: () => clearInterval(afkTimer) });

  // 定时轮询：即便没有保存/修改事件，也周期性检查 diff（runDiffCheck 内部已按 diffHash 去重，
  // 且在 AFK 时会自行跳过，因此不会重复推送或在空闲时空耗）
  const pollTimer = setInterval(runDiffCheck, POLL_INTERVAL_MS);
  context.subscriptions.push({ dispose: () => clearInterval(pollTimer) });

  context.subscriptions.push({ dispose: () => clearTimeout(sensingState.saveDebounceTimer) });
  context.subscriptions.push({ dispose: () => clearTimeout(sensingState.changeDebounceTimer) });
}

function deactivate() {}

module.exports = { activate, deactivate };
