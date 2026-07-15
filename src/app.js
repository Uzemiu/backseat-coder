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
    const ai = await aiService.aiDiffCoach(info, repoMap || {}, learningMemory);
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
      return { ...diffInfo, coach: ai.data, learningMemory, aiSource: ai.source, aiError: ai.error };
    },

    async diffCheck({ repoPath, repoMap, previousDiffHash }) {
      const diffInfo = await gitService.getDiff(repoPath);
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
