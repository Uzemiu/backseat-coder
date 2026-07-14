const state = {
  repoPath: "",
  scan: null,
  repoMap: null,
  task: "",
  navigation: null,
  diff: null,
  watchTimer: null,
  watchRunning: false,
  lastDiffHash: ""
};

const $ = (id) => document.getElementById(id);

function formatAiSource(source) {
  if (source === "anthropic") return "Anthropic mode";
  if (source === "openai") return "OpenAI mode";
  return "local mode";
}

function formatGenerationStatus(action, source, error) {
  if (source !== "local") return `${action} with ${formatAiSource(source)}`;
  if (error) return `${action} locally after provider error`;
  return `${action} locally`;
}

function setStatus(text, mode = "ready") {
  $("statusText").textContent = text;
  $("statusDot").className = `dot ${mode === "ready" ? "" : mode}`;
  if (mode !== "error") {
    $("errorDetails").hidden = true;
    $("errorDetails").textContent = "";
  }
}

function setError(error) {
  const message = error.message || String(error);
  setStatus(message, "error");
  $("errorDetails").hidden = false;
  $("errorDetails").textContent = [
    message,
    error.requestId ? `requestId: ${error.requestId}` : "",
    error.hint || ""
  ].filter(Boolean).join("\n");
  console.error(error);
}

async function api(path, body) {
  let response;
  try {
    response = await fetch(path, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body)
    });
  } catch (error) {
    const wrapped = new Error(`Network request failed: ${error.message || error}`);
    wrapped.hint = "Check that the server is running at http://localhost:3000 and inspect data/app.log.";
    throw wrapped;
  }

  let json;
  try {
    json = await response.json();
  } catch (error) {
    const wrapped = new Error(`Server returned non-JSON response with HTTP ${response.status}`);
    wrapped.hint = "Check data/server.err.log and data/app.log.";
    throw wrapped;
  }

  if (!response.ok) {
    const wrapped = new Error(json.error || `Request failed with HTTP ${response.status}`);
    wrapped.requestId = json.requestId;
    wrapped.hint = json.hint;
    throw wrapped;
  }
  return json;
}

function renderList(id, items) {
  const node = $(id);
  node.innerHTML = "";
  for (const item of normalizeList(items)) {
    const li = document.createElement("li");
    li.textContent = typeof item === "string" ? item : JSON.stringify(item);
    node.appendChild(li);
  }
}

function normalizeList(items) {
  if (Array.isArray(items)) return items;
  if (items == null || items === "") return [];
  return [items];
}

function renderRepoMap(scan) {
  const map = scan.repoMap || scan.localMap || {};
  state.repoMap = map;
  $("aiSource").textContent = formatAiSource(scan.aiSource);
  $("projectType").textContent = map.projectType || "Unknown";
  $("keyFileCount").textContent = String(scan.keyFiles?.length || 0);
  $("fileCount").textContent = String(scan.files?.length || 0);
  $("fileTree").textContent = scan.tree || "No files found.";
  $("projectGuide").textContent = map.projectGuide || "No project guide generated.";
  renderList("readingOrder", map.recommendedReadingOrder || []);
  renderList("entryPoints", map.mainEntryPoints || []);

  const modules = $("coreModules");
  modules.innerHTML = "";
  for (const mod of map.coreModules || []) {
    const normalized = typeof mod === "string"
      ? { name: mod.split("/").pop(), path: mod, purpose: "AI identified this as a core module; inspect to confirm responsibility." }
      : mod;
    const card = document.createElement("div");
    card.className = "module";
    card.innerHTML = `<strong>${escapeHtml(normalized.name || normalized.path || "module")}</strong><span class="muted">${escapeHtml(normalized.path || "")}</span><p class="muted">${escapeHtml(normalized.purpose || "")}</p>`;
    modules.appendChild(card);
  }
}

function renderNavigation(data) {
  const guide = data.guide || {};
  state.navigation = data;
  $("taskUnderstanding").textContent = guide.taskUnderstanding || "No task understanding returned.";
  renderList("suggestedSteps", guide.suggestedSteps || []);
  renderList("filesToRead", guide.filesToReadFirst || []);
  renderList("questionsBeforeCoding", guide.questionsBeforeCoding || []);
  renderMemory("navigationMemory", data.learningMemory || []);

  const results = $("searchResults");
  results.innerHTML = "";
  for (const result of data.searchResults || []) {
    const card = document.createElement("div");
    card.className = "result";
    card.innerHTML = `<strong>${escapeHtml(result.file)}</strong><span class="muted">score ${result.score}</span><pre>${escapeHtml(result.snippet || "Matched by file name.")}</pre>`;
    results.appendChild(card);
  }
}

function renderDiff(data) {
  const coach = data.coach || {};
  state.diff = data;
  $("diffSummary").textContent = coach.summary || "No summary returned.";
  $("rawDiff").textContent = data.diff || "No unstaged diff found.";
  renderList("changedFiles", data.changedFiles || []);
  renderList("risks", coach.risks || []);
  renderList("missingTests", coach.missingTests || []);
  renderList("reflectionQuestions", coach.developerUnderstandingQuestions || []);
  renderMemory("diffMemory", data.learningMemory || []);
}

function renderMemory(id, sessions) {
  const node = $(id);
  node.innerHTML = "";
  for (const session of sessions || []) {
    const card = document.createElement("div");
    card.className = "session";
    card.innerHTML = `
      <strong>${escapeHtml(session.task || "Untitled session")}</strong>
      <span class="muted">${escapeHtml(session.createdAt || "")}</span>
      <p class="muted">${escapeHtml(session.summary || "No summary.")}</p>
      <p><b>Files:</b> ${escapeHtml((session.changedFiles || []).join(", ") || "none")}</p>
    `;
    node.appendChild(card);
  }
}

function renderWatchResult(data) {
  state.lastDiffHash = data.diffHash || state.lastDiffHash;
  const checkedAt = new Date(data.checkedAt || Date.now()).toLocaleTimeString();

  if (!data.hasDiff) {
    $("watchStatus").textContent = `Last checked at ${checkedAt}: no unstaged diff.`;
    return;
  }

  if (!data.changed) {
    $("watchStatus").textContent = `Last checked at ${checkedAt}: diff unchanged.`;
    return;
  }

  $("watchStatus").textContent = `Last checked at ${checkedAt}: new changes found in ${data.changedFiles.length} file(s).`;
  renderDiff(data);

  const item = document.createElement("div");
  item.className = "session";
  item.innerHTML = `
    <strong>${escapeHtml(checkedAt)} - ${escapeHtml(data.changedFiles.join(", ") || "Changed files")}</strong>
    <p class="muted">${escapeHtml(data.coach?.summary || "Changes detected.")}</p>
  `;
  $("watchHistory").prepend(item);

  while ($("watchHistory").children.length > 6) {
    $("watchHistory").lastElementChild.remove();
  }
}

async function loadSessions() {
  const response = await fetch("/api/sessions");
  const sessions = await response.json();
  const node = $("sessions");
  node.innerHTML = "";
  for (const session of sessions) {
    const card = document.createElement("div");
    card.className = "session";
    card.innerHTML = `
      <strong>${escapeHtml(session.task || "Untitled session")}</strong>
      <span class="muted">${escapeHtml(session.createdAt || "")}</span>
      <p class="muted">${escapeHtml(session.summary || "No summary.")}</p>
      <p><b>Repo:</b> ${escapeHtml(session.repoPath || "")}</p>
    `;
    node.appendChild(card);
  }
}

function escapeHtml(value) {
  return String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
}

function requireRepo() {
  const repoPath = $("repoPath").value.trim();
  if (!repoPath) throw new Error("Enter a repository path first.");
  state.repoPath = repoPath;
  return repoPath;
}

document.querySelectorAll(".tab").forEach((tab) => {
  tab.addEventListener("click", () => {
    document.querySelectorAll(".tab").forEach((node) => node.classList.remove("active"));
    document.querySelectorAll(".view").forEach((node) => node.classList.remove("active"));
    tab.classList.add("active");
    $(tab.dataset.view).classList.add("active");
  });
});

$("scanBtn").addEventListener("click", async () => {
  try {
    setStatus("Scanning repository", "busy");
    const scan = await api("/api/scan", { repoPath: requireRepo() });
    state.scan = scan;
    state.lastDiffHash = "";
    renderRepoMap(scan);
    setStatus(formatGenerationStatus("Repo map generated", scan.aiSource, scan.aiError));
  } catch (error) {
    setError(error);
  }
});

$("navigateBtn").addEventListener("click", async () => {
  try {
    const task = $("taskInput").value.trim();
    if (!task) throw new Error("Enter a task first.");
    if (!state.scan) throw new Error("Scan a repository first.");
    state.task = task;
    setStatus("Creating task route", "busy");
    const data = await api("/api/navigate", {
      repoPath: requireRepo(),
      task,
      repoMap: state.repoMap,
      files: state.scan.files
    });
    renderNavigation(data);
    setStatus(formatGenerationStatus("Route generated", data.aiSource, data.aiError));
  } catch (error) {
    setError(error);
  }
});

$("diffBtn").addEventListener("click", async () => {
  try {
    if (!state.scan) throw new Error("Scan a repository first.");
    setStatus("Analyzing git diff", "busy");
    const data = await api("/api/diff", {
      repoPath: requireRepo(),
      repoMap: state.repoMap
    });
    renderDiff(data);
    setStatus(formatGenerationStatus("Diff analyzed", data.aiSource, data.aiError));
  } catch (error) {
    setError(error);
  }
});

async function runScheduledDiffCheck() {
  if (!state.scan) throw new Error("Scan a repository first.");
  const data = await api("/api/diff/check", {
    repoPath: requireRepo(),
    repoMap: state.repoMap,
    previousDiffHash: state.lastDiffHash
  });
  renderWatchResult(data);
  return data;
}

$("startWatchBtn").addEventListener("click", async () => {
  try {
    if (state.watchRunning) return;
    if (!state.scan) throw new Error("Scan a repository first.");

    const intervalSeconds = Number.parseInt($("watchInterval").value, 10);
    if (!Number.isFinite(intervalSeconds) || intervalSeconds < 10) {
      throw new Error("Interval must be at least 10 seconds.");
    }

    state.watchRunning = true;
    $("startWatchBtn").disabled = true;
    $("stopWatchBtn").disabled = false;
    $("watchInterval").disabled = true;
    setStatus("Scheduled diff watcher started");
    $("watchStatus").textContent = "Checking current diff now.";

    await runScheduledDiffCheck();
    state.watchTimer = window.setInterval(async () => {
      try {
        await runScheduledDiffCheck();
      } catch (error) {
        setError(error);
        stopWatch();
      }
    }, intervalSeconds * 1000);
  } catch (error) {
    setError(error);
    stopWatch();
  }
});

function stopWatch() {
  if (state.watchTimer) {
    window.clearInterval(state.watchTimer);
    state.watchTimer = null;
  }
  state.watchRunning = false;
  $("startWatchBtn").disabled = false;
  $("stopWatchBtn").disabled = true;
  $("watchInterval").disabled = false;
  $("watchStatus").textContent = "Watcher is stopped.";
}

$("stopWatchBtn").addEventListener("click", () => {
  stopWatch();
  setStatus("Scheduled diff watcher stopped");
});

$("saveLogBtn").addEventListener("click", async () => {
  try {
    const summary = state.diff?.coach?.summary || state.navigation?.guide?.taskUnderstanding || "Session saved.";
    setStatus("Saving session", "busy");
    await api("/api/sessions", {
      repoPath: state.repoPath || $("repoPath").value.trim(),
      task: state.task || $("taskInput").value.trim() || "Explored repository",
      summary,
      repoMap: state.repoMap,
      navigation: state.navigation?.guide,
      changedFiles: state.diff?.changedFiles || [],
      learnedConcepts: [
        ...(state.navigation?.guide?.filesToReadFirst || []),
        ...(state.diff?.changedFiles || [])
      ].slice(0, 12),
      openQuestions: state.diff?.coach?.developerUnderstandingQuestions || state.navigation?.guide?.questionsBeforeCoding || []
    });
    await loadSessions();
    setStatus("Session saved");
  } catch (error) {
    setError(error);
  }
});

loadSessions().catch(() => {});
