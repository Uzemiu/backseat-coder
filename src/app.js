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

function createApp(deps) {
  const {
    aiService,
    config,
    gitService,
    log,
    repositoryService,
    sessionStore
  } = deps;
  const serveStatic = createStaticHandler({ publicDir: config.publicDir });

  async function handleApi(req, res) {
    const url = new URL(req.url, `http://${req.headers.host}`);
    const requestId = createRequestId();
    const started = Date.now();
    log("info", "api.request.start", {
      requestId,
      method: req.method,
      path: url.pathname
    });

    try {
      if (req.method === "POST" && url.pathname === "/api/scan") {
        const { repoPath } = await readBody(req);
        log("info", "api.scan.input", { requestId, repoPath });
        const scan = await repositoryService.scanRepo(repoPath || ".");
        const ai = await aiService.aiRepoMap(scan);
        const repoMap = normalizeRepoMap(ai.data, scan.localMap);
        const body = { ...scan, repoMap, aiSource: ai.source, aiError: ai.error, requestId };
        log("info", "api.request.complete", {
          requestId,
          path: url.pathname,
          status: 200,
          durationMs: Date.now() - started,
          aiSource: ai.source,
          fileCount: scan.files.length
        });
        return sendJson(res, 200, body);
      }

      if (req.method === "POST" && url.pathname === "/api/navigate") {
        const { repoPath, task, repoMap, files } = await readBody(req);
        log("info", "api.navigate.input", {
          requestId,
          repoPath,
          task,
          fileCount: files?.length || 0
        });
        const searchResults = await repositoryService.searchRepo(repoPath, task, files || []);
        const ai = await aiService.aiNavigator(task, repoMap || {}, searchResults);
        log("info", "api.request.complete", {
          requestId,
          path: url.pathname,
          status: 200,
          durationMs: Date.now() - started,
          aiSource: ai.source,
          searchResults: searchResults.length
        });
        return sendJson(res, 200, { searchResults, guide: ai.data, aiSource: ai.source, aiError: ai.error, requestId });
      }

      if (req.method === "POST" && url.pathname === "/api/diff") {
        const { repoPath, repoMap } = await readBody(req);
        log("info", "api.diff.input", { requestId, repoPath });
        const diffInfo = await gitService.getDiff(repoPath);
        const ai = await aiService.aiDiffCoach(diffInfo, repoMap || {});
        log("info", "api.request.complete", {
          requestId,
          path: url.pathname,
          status: 200,
          durationMs: Date.now() - started,
          aiSource: ai.source,
          changedFiles: diffInfo.changedFiles.length
        });
        return sendJson(res, 200, { ...diffInfo, coach: ai.data, aiSource: ai.source, aiError: ai.error, requestId });
      }

      if (req.method === "POST" && url.pathname === "/api/diff/check") {
        const { repoPath, repoMap, previousDiffHash } = await readBody(req);
        log("info", "api.diff_check.input", { requestId, repoPath, previousDiffHash });
        const diffInfo = await gitService.getDiff(repoPath);
        const diffHash = crypto.createHash("sha256").update(diffInfo.diff).digest("hex");
        const hasDiff = Boolean(diffInfo.diff.trim());
        const changed = hasDiff && diffHash !== previousDiffHash;
        let ai = { source: "local", data: null };

        if (changed) {
          ai = await aiService.aiDiffCoach(diffInfo, repoMap || {});
        }

        log("info", "api.request.complete", {
          requestId,
          path: url.pathname,
          status: 200,
          durationMs: Date.now() - started,
          changed,
          hasDiff,
          aiSource: ai.source,
          changedFiles: diffInfo.changedFiles.length
        });
        return sendJson(res, 200, {
          checkedAt: new Date().toISOString(),
          changed,
          hasDiff,
          diffHash,
          changedFiles: diffInfo.changedFiles,
          diff: changed ? diffInfo.diff : "",
          coach: ai.data,
          aiSource: ai.source,
          aiError: ai.error,
          requestId
        });
      }

      if (req.method === "POST" && url.pathname === "/api/sessions") {
        const session = await sessionStore.saveSession(await readBody(req));
        log("info", "api.request.complete", {
          requestId,
          path: url.pathname,
          status: 200,
          durationMs: Date.now() - started,
          sessionId: session.id
        });
        return sendJson(res, 200, session);
      }

      if (req.method === "GET" && url.pathname === "/api/sessions") {
        const sessions = await sessionStore.loadSessions();
        log("info", "api.request.complete", {
          requestId,
          path: url.pathname,
          status: 200,
          durationMs: Date.now() - started,
          sessionCount: sessions.length
        });
        return sendJson(res, 200, sessions);
      }

      log("warn", "api.request.not_found", {
        requestId,
        method: req.method,
        path: url.pathname,
        durationMs: Date.now() - started
      });
      return sendJson(res, 404, { error: "Unknown API route." });
    } catch (error) {
      log("error", "api.request.failed", {
        requestId,
        method: req.method,
        path: url.pathname,
        durationMs: Date.now() - started,
        error
      });
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
  startServer
};
