const state = {
  repoPath: "",
  scan: null,
  repoMap: null,
  task: ""
};

const $ = (id) => document.getElementById(id);

// VS Code Webview API (undefined when running in a normal browser)
const vscode = typeof acquireVsCodeApi !== "undefined" ? acquireVsCodeApi() : null;

// Pending promise callbacks keyed by request id
const pending = new Map();
let nextId = 1;

// Message router: handles both API responses and push events from the extension
window.addEventListener("message", (event) => {
  const msg = event.data;

  // API response: has numeric id
  if (typeof msg.id === "number") {
    const callbacks = pending.get(msg.id);
    if (!callbacks) return;
    pending.delete(msg.id);
    if (msg.error) callbacks.reject(Object.assign(new Error(msg.error.message), msg.error));
    else callbacks.resolve(msg.result);
    return;
  }

  // Push events from extension
  if (msg.type === "init") {
    if (!state.repoPath && msg.workspacePath) {
      $("repoPath").value = msg.workspacePath;
      state.repoPath = msg.workspacePath;
    }
    return;
  }
  if (msg.type === "card") {
    appendCard(msg.kind, msg.payload);
    return;
  }
  if (msg.type === "afk") {
    appendCard("afk", null);
    return;
  }
  if (msg.type === "wake") {
    appendCard("wake", null);
    return;
  }
});

function api(path, body) {
  if (vscode) {
    const segments = path.replace(/^\/api\//, "").split("/");
    const base = segments.length === 1
      ? segments[0]
      : segments[0] + segments.slice(1).map((s) => s[0].toUpperCase() + s.slice(1)).join("");
    const command = body === undefined ? "get" + base[0].toUpperCase() + base.slice(1) : base;

    return new Promise((resolve, reject) => {
      const id = nextId++;
      pending.set(id, { resolve, reject });
      vscode.postMessage({ id, command, payload: body || {} });
    });
  }

  // Browser / standalone server mode
  const isGet = body === undefined;
  return fetch(path, {
    method: isGet ? "GET" : "POST",
    headers: isGet ? {} : { "content-type": "application/json" },
    body: isGet ? undefined : JSON.stringify(body)
  }).then(async (response) => {
    let json;
    try { json = await response.json(); } catch {
      const err = new Error(`Server returned non-JSON response with HTTP ${response.status}`);
      err.hint = "Check data/server.err.log and data/app.log.";
      throw err;
    }
    if (!response.ok) {
      const err = new Error(json.error || `Request failed with HTTP ${response.status}`);
      err.requestId = json.requestId;
      err.hint = json.hint;
      throw err;
    }
    return json;
  }).catch((error) => {
    if (error.message?.startsWith("Server returned") || error.requestId) throw error;
    const wrapped = new Error(`Network request failed: ${error.message || error}`);
    wrapped.hint = "Check that the server is running at http://localhost:3000 and inspect data/app.log.";
    throw wrapped;
  });
}

// Tell extension the current context so it can run diffCheck on save
function syncContext() {
  if (vscode) {
    vscode.postMessage({
      command: "setContext",
      payload: {
        repoPath: state.repoPath,
        repoMap: state.repoMap,
        task: state.task
      }
    });
  }
}

function setStatus(text, mode = "ready") {
  $("statusText").textContent = text;
  $("statusDot").className = `dot${mode === "ready" ? "" : " " + mode}`;
}

function setError(error) {
  const message = error.message || String(error);
  setStatus(message, "error");
  console.error(error);
  appendCard("error", { message, hint: error.hint, requestId: error.requestId });
}

function escapeHtml(value) {
  return String(value ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
}

function normalizeList(items) {
  if (Array.isArray(items)) return items;
  if (items == null || items === "") return [];
  return [items];
}

function listHtml(items, tag = "ul") {
  const rows = normalizeList(items);
  if (!rows.length) return "";
  const lis = rows.map((item) => `<li>${escapeHtml(typeof item === "string" ? item : JSON.stringify(item))}</li>`).join("");
  return `<${tag}>${lis}</${tag}>`;
}

function aiSourceBadge(source, error) {
  if (!source) return "";
  let label = source === "anthropic" ? "Anthropic" : source === "openai" ? "OpenAI" : "local";
  if (error) label += " (fallback)";
  return `<span class="badge">${escapeHtml(label)}</span>`;
}

function memoryHtml(sessions) {
  if (!sessions || !sessions.length) return "";
  const items = sessions.map((s) => `
    <li>
      <strong>${escapeHtml(s.task || "Untitled")}</strong>
      <span class="badge">${escapeHtml(s.createdAt || "")}</span>
      <p>${escapeHtml(s.summary || "")}</p>
    </li>`).join("");
  return `<h4>召回记忆</h4><ul>${items}</ul>`;
}

function buildCardHtml(kind, payload) {
  if (kind === "afk") {
    return `<div class="afk-banner">💤 已静默 · 检测到你离开了</div>`;
  }

  if (kind === "wake") {
    const context = state.repoPath ? `你上次在改 <em>${escapeHtml(state.repoPath)}</em>` : "";
    return `<div class="wake-banner">👋 欢迎回来${context ? " · " + context : ""}</div>`;
  }

  if (kind === "error") {
    const p = payload || {};
    return `
      <h3>错误</h3>
      <p>${escapeHtml(p.message || "未知错误")}</p>
      ${p.hint ? `<p>${escapeHtml(p.hint)}</p>` : ""}
      ${p.requestId ? `<p>requestId: ${escapeHtml(p.requestId)}</p>` : ""}
    `;
  }

  if (kind === "scan") {
    const map = payload.repoMap || payload.localMap || {};
    const modules = normalizeList(map.coreModules || []).map((mod) => {
      const name = typeof mod === "string" ? mod : (mod.name || mod.path || "module");
      const path = typeof mod === "string" ? "" : (mod.path || "");
      const purpose = typeof mod === "string" ? "" : (mod.purpose || "");
      return `<li><strong>${escapeHtml(name)}</strong>${path ? " <span class='badge'>" + escapeHtml(path) + "</span>" : ""}${purpose ? "<br>" + escapeHtml(purpose) : ""}</li>`;
    }).join("");

    const brief = map.brief || "";
    const detailHtml = `
      <p><strong>类型：</strong>${escapeHtml(map.projectType || "未知")}</p>
      <p><strong>关键文件：</strong>${escapeHtml(String(payload.keyFiles?.length || 0))}
         &nbsp;<strong>扫描文件：</strong>${escapeHtml(String(payload.files?.length || 0))}</p>
      ${map.mainEntryPoints?.length ? `<h4>入口</h4>${listHtml(map.mainEntryPoints)}` : ""}
      ${map.recommendedReadingOrder?.length ? `<h4>推荐阅读顺序</h4>${listHtml(map.recommendedReadingOrder)}` : ""}
      ${modules ? `<h4>核心模块</h4><ul>${modules}</ul>` : ""}
      ${map.projectGuide ? `<details><summary>项目指南</summary><pre>${escapeHtml(map.projectGuide)}</pre></details>` : ""}
      ${payload.tree ? `<details><summary>文件树</summary><pre>${escapeHtml(payload.tree)}</pre></details>` : ""}
    `;

    return `
      <div class="card-title-row">
        <h3>项目理解</h3>
        ${aiSourceBadge(payload.aiSource, payload.aiError)}
      </div>
      ${brief ? `<p class="card-brief">${escapeHtml(brief)}</p>` : ""}
      <details class="card-details"><summary>详情</summary>${detailHtml}</details>
    `;
  }

  if (kind === "diff") {
    const coach = payload.coach || {};
    const ts = payload.checkedAt ? new Date(payload.checkedAt).toLocaleTimeString() : "";
    const brief = coach.brief || "";
    // 详情（影响/风险/测试/反思问题）不在感知阶段生成，点"展开详情"时才按需请求，
    // 这样卡片能第一时间冒出来。已生成的详情（如手动"看改动"）直接内联渲染。
    const hasDetails = coach.impact?.length || coach.risks?.length || coach.missingTests?.length || coach.developerUnderstandingQuestions?.length;
    const detailHtml = `
      ${coach.summary ? `<p>${escapeHtml(coach.summary)}</p>` : ""}
      ${payload.changedFiles?.length ? `<h4>改动文件</h4>${listHtml(payload.changedFiles)}` : ""}
      ${coach.impact?.length ? `<h4>影响</h4>${listHtml(coach.impact)}` : ""}
      ${coach.risks?.length ? `<h4>风险</h4>${listHtml(coach.risks)}` : ""}
      ${coach.missingTests?.length ? `<h4>缺失测试</h4>${listHtml(coach.missingTests)}` : ""}
      ${coach.developerUnderstandingQuestions?.length ? `<h4>反思问题</h4>${listHtml(coach.developerUnderstandingQuestions, "ol")}` : ""}
      ${memoryHtml(payload.learningMemory)}
      ${payload.diff ? `<details><summary>raw diff</summary><pre>${escapeHtml(payload.diff)}</pre></details>` : ""}
    `;
    const detailSection = hasDetails
      ? `<details class="card-details"><summary>详情</summary>${detailHtml}</details>`
      : `<button class="btn-secondary details-btn">展开详情</button>
         <div class="details-slot"></div>`;
    return `
      <div class="card-title-row">
        <h3>改动审视${ts ? " · " + escapeHtml(ts) : ""}</h3>
        ${aiSourceBadge(payload.aiSource, payload.aiError)}
      </div>
      ${brief ? `<p class="card-brief">${escapeHtml(brief)}</p>` : ""}
      ${detailSection}
    `;
  }

  if (kind === "navigate") {
    const guide = payload.guide || {};
    const brief = guide.brief || "";
    const detailHtml = `
      ${guide.taskUnderstanding ? `<p>${escapeHtml(guide.taskUnderstanding)}</p>` : ""}
      ${guide.filesToReadFirst?.length ? `<h4>优先阅读</h4>${listHtml(guide.filesToReadFirst)}` : ""}
      ${guide.likelyFilesToChange?.length ? `<h4>可能修改</h4>${listHtml(guide.likelyFilesToChange)}` : ""}
      ${guide.questionsBeforeCoding?.length ? `<h4>动手前的问题</h4>${listHtml(guide.questionsBeforeCoding)}` : ""}
      ${guide.suggestedSteps?.length ? `<h4>建议步骤</h4>${listHtml(guide.suggestedSteps, "ol")}` : ""}
      ${memoryHtml(payload.learningMemory)}
    `;
    return `
      <div class="card-title-row">
        <h3>任务导航</h3>
        ${aiSourceBadge(payload.aiSource, payload.aiError)}
      </div>
      ${brief ? `<p class="card-brief">${escapeHtml(brief)}</p>` : ""}
      <details class="card-details"><summary>详情</summary>${detailHtml}</details>
    `;
  }

  if (kind === "explain") {
    const ex = payload.explanation || {};
    const loc = payload.symbolName
      ? escapeHtml(payload.symbolName)
      : (payload.filePath ? escapeHtml(payload.filePath) + (payload.lineNumber ? ":" + payload.lineNumber : "") : "");
    const detailHtml = `
      ${ex.role ? `<p><strong>角色：</strong>${escapeHtml(ex.role)}</p>` : ""}
      ${ex.watchOut ? `<p><strong>留意：</strong>${escapeHtml(ex.watchOut)}</p>` : ""}
      ${payload.filePath ? `<p class="card-loc">${escapeHtml(payload.filePath)}${payload.lineNumber ? ":" + payload.lineNumber : ""}</p>` : ""}
    `;
    const hasDetail = ex.role || ex.watchOut || payload.filePath;
    return `
      <div class="card-title-row">
        <h3>📖 读到这里${loc ? " · " + loc : ""}</h3>
        ${aiSourceBadge(payload.aiSource, payload.aiError)}
      </div>
      ${ex.brief ? `<p class="card-brief">${escapeHtml(ex.brief)}</p>` : ""}
      ${hasDetail ? `<details class="card-details"><summary>更多</summary>${detailHtml}</details>` : ""}
    `;
  }

  // Unknown kind fallback
  return `<h3>${escapeHtml(kind)}</h3><pre>${escapeHtml(JSON.stringify(payload, null, 2))}</pre>`;
}

// diff 卡片的快照（供"展开详情"按需请求时回传当时的 diff，而非此刻磁盘状态）
const cardSnapshots = new Map();
let nextCardId = 1;

function appendCard(kind, payload) {
  const feed = $("cardFeed");
  const card = document.createElement("article");
  card.className = `card card-${kind}`;
  card.dataset.kind = kind;
  card.innerHTML = buildCardHtml(kind, payload);

  // 为可"展开详情"的 diff 卡片挂上快照与 id，按钮点击时据此按需生成详情
  const detailsBtn = card.querySelector(".details-btn");
  if (kind === "diff" && detailsBtn && payload?.diff) {
    const cardId = String(nextCardId++);
    card.dataset.cardId = cardId;
    cardSnapshots.set(cardId, {
      repoPath: state.repoPath,
      repoMap: state.repoMap,
      diff: payload.diff,
      changedFiles: payload.changedFiles || []
    });
  }

  feed.appendChild(card);
  card.scrollIntoView({ behavior: "smooth", block: "end" });
  persistCards();
}

async function loadCardDetails(card) {
  const cardId = card.dataset.cardId;
  const snapshot = cardId && cardSnapshots.get(cardId);
  const slot = card.querySelector(".details-slot");
  const btn = card.querySelector(".details-btn");
  if (!slot || !btn) return;
  if (!snapshot) {
    slot.innerHTML = `<p>详情快照已失效（可能重载过窗口），请重新编辑以生成新的审视。</p>`;
    btn.remove();
    return;
  }
  btn.disabled = true;
  btn.textContent = "正在生成详情…";
  try {
    const data = await api("/api/diff/details", {
      repoPath: snapshot.repoPath,
      repoMap: snapshot.repoMap,
      diff: snapshot.diff,
      changedFiles: snapshot.changedFiles
    });
    const coach = data.coach || {};
    slot.innerHTML = `
      ${coach.impact?.length ? `<h4>影响</h4>${listHtml(coach.impact)}` : ""}
      ${coach.risks?.length ? `<h4>风险</h4>${listHtml(coach.risks)}` : ""}
      ${coach.missingTests?.length ? `<h4>缺失测试</h4>${listHtml(coach.missingTests)}` : ""}
      ${coach.developerUnderstandingQuestions?.length ? `<h4>反思问题</h4>${listHtml(coach.developerUnderstandingQuestions, "ol")}` : ""}
      ${memoryHtml(data.learningMemory)}
      <details><summary>raw diff</summary><pre>${escapeHtml(snapshot.diff)}</pre></details>
    `;
    btn.remove();
    persistCards();
  } catch (error) {
    btn.disabled = false;
    btn.textContent = "展开详情";
    slot.innerHTML = `<p>生成详情失败：${escapeHtml(error.message || String(error))}</p>`;
  }
}

function persistCards() {
  if (!vscode) return;
  const cards = Array.from($("cardFeed").querySelectorAll(".card")).map((el) => ({
    kind: el.dataset.kind,
    html: el.innerHTML
  }));
  vscode.setState({ cards, repoPath: state.repoPath, task: state.task, hasScan: !!state.scan });
}

function restoreCards() {
  if (!vscode) return;
  const saved = vscode.getState();
  if (!saved || !saved.cards || !saved.cards.length) return;
  const feed = $("cardFeed");
  for (const { kind, html } of saved.cards) {
    const card = document.createElement("article");
    card.className = `card card-${kind}`;
    card.dataset.kind = kind;
    card.innerHTML = html;
    feed.appendChild(card);
  }
  if (saved.repoPath) {
    state.repoPath = saved.repoPath;
    $("repoPath").value = saved.repoPath;
  }
  if (saved.task) state.task = saved.task;
  if (saved.hasScan) $("taskBar").hidden = false;
  feed.lastElementChild?.scrollIntoView({ block: "end" });
}

function requireRepo() {
  const repoPath = $("repoPath").value.trim();
  if (!repoPath) throw new Error("请先输入仓库路径。");
  state.repoPath = repoPath;
  return repoPath;
}

$("scanBtn").addEventListener("click", async () => {
  try {
    setStatus("正在扫描仓库…", "busy");
    const repoPath = requireRepo();
    const scan = await api("/api/scan", { repoPath });
    state.scan = scan;
    state.repoMap = scan.repoMap || scan.localMap || {};
    appendCard("scan", scan);
    syncContext();
    $("taskBar").hidden = false;
    setStatus("就绪");
  } catch (error) {
    setError(error);
  }
});

// 注意：VS Code Webview 中原生 confirm()/alert() 被禁用会直接返回 false，
// 因此用「二次点击确认」代替，避免按钮看似无反应。
let clearMemoryArmed = false;
let clearMemoryTimer = null;

$("clearMemoryBtn").addEventListener("click", async () => {
  const btn = $("clearMemoryBtn");

  if (!clearMemoryArmed) {
    clearMemoryArmed = true;
    const originalText = btn.textContent;
    btn.textContent = "再次点击确认清除";
    setStatus("再次点击「清除记忆」以确认（3 秒内）", "busy");
    clearMemoryTimer = setTimeout(() => {
      clearMemoryArmed = false;
      btn.textContent = originalText;
      setStatus("就绪");
    }, 3000);
    return;
  }

  clearTimeout(clearMemoryTimer);
  clearMemoryArmed = false;
  btn.textContent = "清除记忆";

  try {
    setStatus("正在清除记忆…", "busy");
    await api("/api/clearSessions", {});
    // 清空卡片流（含 Diff Coach 卡片）和持久化状态
    $("cardFeed").innerHTML = "";
    state.scan = null;
    state.repoMap = null;
    state.task = "";
    $("taskBar").hidden = true;
    $("taskInput").value = "";
    if (vscode) vscode.setState(null);
    setStatus("记忆已清除");
    appendCard("wake", { message: "记忆已清除，卡片历史已重置。" });
  } catch (error) {
    setError(error);
  }
});

$("navigateBtn").addEventListener("click", async () => {
  try {
    const task = $("taskInput").value.trim();
    if (!task) throw new Error("请先输入任务。");
    if (!state.scan) throw new Error("请先扫描仓库。");
    state.task = task;
    setStatus("正在生成任务路线…", "busy");
    const data = await api("/api/navigate", {
      repoPath: requireRepo(),
      task,
      repoMap: state.repoMap,
      files: state.scan.files
    });
    appendCard("navigate", data);
    syncContext();
    setStatus("就绪");
  } catch (error) {
    setError(error);
  }
});

// 事件委托：点击 diff 卡片的"展开详情"按钮 → 按需生成详情
$("cardFeed").addEventListener("click", (event) => {
  const btn = event.target.closest(".details-btn");
  if (!btn) return;
  const card = btn.closest(".card");
  if (card) loadCardDetails(card);
});

// Restore persisted state, then notify extension the webview is ready
restoreCards();
if (vscode) {
  vscode.postMessage({ command: "ready" });
}
