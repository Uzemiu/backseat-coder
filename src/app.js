const http = require("node:http");
const crypto = require("node:crypto");
const {
  createRequestId,
  createStaticHandler,
  errorResponse,
  readBody,
  sendJson
} = require("./core/http");
const { setupHttpProxy } = require("./core/proxy");
const { normalizeRepoMap } = require("./services/repository");

function createHandlers(deps) {
  const { aiService, gitService, log, repositoryService, sessionStore } = deps;

  async function analyzeDiff(repoPath, repoMap, diffInfo) {
    const info = diffInfo || await gitService.getDiff(repoPath);
    const learningMemory = await sessionStore.findRelevantSessions({
      repoPath,
      query: info.diff.slice(0, 2000),
      changedFiles: info.changedFiles,
      limit: 5
    });
    // 感知阶段只生成轻量 brief，第一时间把卡片冒出来；详情等开发者点开再按需生成。
    const ai = await aiService.aiDiffBrief(info, repoMap || {}, learningMemory);
    return { diffInfo: info, ai, learningMemory };
  }

  return {
    async scan({ repoPath }) {
      const scan = await repositoryService.scanRepo(repoPath || ".");
      const ai = await aiService.aiRepoMap(scan);
      const repoMap = normalizeRepoMap(ai.data, scan.localMap);
      return { ...scan, repoMap, aiSource: ai.source, aiError: ai.error };
    },

    async navigate({ repoPath, task, repoMap, files }) {
      const searchResults = await repositoryService.searchRepo(repoPath, task, files || []);
      const learningMemory = await sessionStore.findRelevantSessions({
        repoPath,
        query: task,
        changedFiles: searchResults.map((item) => item.file),
        limit: 5
      });
      const ai = await aiService.aiNavigator(task, repoMap || {}, searchResults, learningMemory);
      return { searchResults, guide: ai.data, learningMemory, aiSource: ai.source, aiError: ai.error };
    },

    async diff({ repoPath, repoMap }) {
      const { diffInfo, ai, learningMemory } = await analyzeDiff(repoPath, repoMap);
      // 手动"看改动"是一次性主动请求，brief 和详情一起给全（并行，不额外拖慢）
      const details = await aiService.aiDiffDetails(diffInfo, repoMap || {}, learningMemory);
      return {
        ...diffInfo,
        coach: { ...(ai.data || {}), ...(details.data || {}) },
        learningMemory,
        aiSource: ai.source,
        aiError: ai.error
      };
    },

    // 按需生成详情：前端在开发者点开"详情"时调用，带上卡片当时的 diff 快照，
    // 保证详情对应的正是那张卡片的改动，而不是此刻磁盘上的最新状态。
    async diffDetails({ repoPath, repoMap, diff, changedFiles }) {
      const diffInfo = { diff: diff || "", changedFiles: changedFiles || [] };
      const learningMemory = await sessionStore.findRelevantSessions({
        repoPath,
        query: diffInfo.diff.slice(0, 2000),
        changedFiles: diffInfo.changedFiles,
        limit: 5
      });
      const details = await aiService.aiDiffDetails(diffInfo, repoMap || {}, learningMemory);
      return { coach: details.data, learningMemory, aiSource: details.source, aiError: details.error };
    },

    // 阅读陪伴：光标停在某段代码上时，讲解它的作用与角色（只解释，不建议改动）。
    async explainCode({ repoPath, repoMap, filePath, code, symbolName, lineNumber }) {
      const learningMemory = await sessionStore.findRelevantSessions({
        repoPath,
        query: (symbolName || "") + "\n" + String(code || "").slice(0, 1500),
        changedFiles: filePath ? [filePath] : [],
        limit: 3
      });
      const ai = await aiService.aiExplainCode({ filePath, code, symbolName }, repoMap || {}, learningMemory);
      return { explanation: ai.data, filePath, symbolName, lineNumber, aiSource: ai.source, aiError: ai.error };
    },

    async diffCheck({ repoPath, repoMap, previousDiffHash, dirtyBuffers }) {
      const diffInfo = (dirtyBuffers && dirtyBuffers.length)
        ? await gitService.getDiffWithBuffers(repoPath, dirtyBuffers)
        : await gitService.getDiff(repoPath);
      const diffHash = crypto.createHash("sha256").update(diffInfo.diff).digest("hex");
      const hasDiff = Boolean(diffInfo.diff.trim());
      const changed = hasDiff && diffHash !== previousDiffHash;
      let ai = { source: "local", data: null };
      let learningMemory = [];

      if (changed) {
        ({ ai, learningMemory } = await analyzeDiff(repoPath, repoMap, diffInfo));
      }

      return {
        checkedAt: new Date().toISOString(),
        changed,
        hasDiff,
        // AI 判断这次改动值不值得打断开发者（原则六 懂分寸）。无 coach 时视为 false。
        worthMentioning: Boolean(ai.data?.worthMentioning),
        diffHash,
        changedFiles: diffInfo.changedFiles,
        diff: changed ? diffInfo.diff : "",
        coach: ai.data,
        learningMemory,
        aiSource: ai.source,
        aiError: ai.error
      };
    },

    async saveSession(payload) {
      return sessionStore.saveSession(payload);
    },

    async getSessions() {
      return sessionStore.loadSessions();
    },

    async clearSessions() {
      await sessionStore.clearSessions();
      return { cleared: true };
    }
  };
}

function createApp(deps) {
  const { config, log } = deps;
  const serveStatic = createStaticHandler({ publicDir: config.publicDir });
  const handlers = createHandlers(deps);

  const pathToHandler = {
    "POST /api/scan": (body) => handlers.scan(body),
    "POST /api/navigate": (body) => handlers.navigate(body),
    "POST /api/diff": (body) => handlers.diff(body),
    "POST /api/diff/details": (body) => handlers.diffDetails(body),
    "POST /api/explain": (body) => handlers.explainCode(body),
    "POST /api/diff/check": (body) => handlers.diffCheck(body),
    "POST /api/sessions": (body) => handlers.saveSession(body),
    "POST /api/clearSessions": () => handlers.clearSessions(),
    "GET /api/sessions": () => handlers.getSessions()
  };

  async function handleApi(req, res) {
    const url = new URL(req.url, `http://${req.headers.host}`);
    const requestId = createRequestId();
    const started = Date.now();
    log("info", "api.request.start", { requestId, method: req.method, path: url.pathname });

    try {
      const key = `${req.method} ${url.pathname}`;
      const handler = pathToHandler[key];

      if (!handler) {
        log("warn", "api.request.not_found", { requestId, method: req.method, path: url.pathname });
        return sendJson(res, 404, { error: "Unknown API route." });
      }

      const body = req.method === "POST" ? await readBody(req) : {};
      const result = await handler(body);
      log("info", "api.request.complete", { requestId, path: url.pathname, status: 200, durationMs: Date.now() - started });
      return sendJson(res, 200, { ...result, requestId });
    } catch (error) {
      log("error", "api.request.failed", { requestId, method: req.method, path: url.pathname, durationMs: Date.now() - started, error });
      return sendJson(res, 500, errorResponse(error, requestId));
    }
  }

  const server = http.createServer((req, res) => {
    if (req.url.startsWith("/api/")) {
      handleApi(req, res);
    } else {
      serveStatic(req, res);
    }
  });

  return { handleApi, server };
}

function startServer({ config, log, server }) {
  setupHttpProxy(config.proxyUrl, log);
  server.listen(config.port, () => {
    log("info", "server.started", {
      port: config.port,
      startedAt: config.startedAt,
      provider: config.provider.requested,
      hasOpenAIKey: Boolean(config.provider.openAIKey),
      hasAnthropicKey: Boolean(config.provider.anthropicKey),
      proxyEnabled: Boolean(config.proxyUrl),
      logFile: config.appLogFile
    });
    console.log(`AI Pair Coding Guide running at http://localhost:${config.port}`);
  });
}

module.exports = {
  createApp,
  createHandlers,
  startServer
};
