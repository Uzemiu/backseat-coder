const fs = require("node:fs");
const fsp = require("node:fs/promises");
const path = require("node:path");

function createRequestId() {
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}

function send(res, status, body, headers = {}) {
  const payload = typeof body === "string" ? body : JSON.stringify(body);
  res.writeHead(status, {
    "content-type": typeof body === "string" ? "text/plain; charset=utf-8" : "application/json; charset=utf-8",
    ...headers
  });
  res.end(payload);
}

function sendJson(res, status, body) {
  send(res, status, body, { "content-type": "application/json; charset=utf-8" });
}

async function readBody(req, maxBytes = 1024 * 1024) {
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > maxBytes) throw new Error("Request body too large.");
    chunks.push(chunk);
  }
  if (chunks.length === 0) return {};
  return JSON.parse(Buffer.concat(chunks).toString("utf8"));
}

async function pathExists(target) {
  try {
    await fsp.access(target);
    return true;
  } catch {
    return false;
  }
}

function errorResponse(error, requestId) {
  return {
    error: error.message || String(error),
    requestId,
    hint: "Check data/app.log or data/server.err.log for server-side details."
  };
}

function createStaticHandler({ publicDir }) {
  return async function serveStatic(req, res) {
    const url = new URL(req.url, `http://${req.headers.host}`);
    const pathname = url.pathname === "/" ? "/index.html" : url.pathname;
    const filePath = path.normalize(path.join(publicDir, pathname));
    if (!filePath.startsWith(publicDir)) return send(res, 403, "Forbidden");
    if (!(await pathExists(filePath))) return send(res, 404, "Not found");

    const ext = path.extname(filePath);
    const contentTypes = {
      ".html": "text/html; charset=utf-8",
      ".css": "text/css; charset=utf-8",
      ".js": "text/javascript; charset=utf-8"
    };
    res.writeHead(200, {
      "cache-control": "no-store",
      "content-type": contentTypes[ext] || "application/octet-stream"
    });
    fs.createReadStream(filePath).pipe(res);
  };
}

module.exports = {
  createRequestId,
  createStaticHandler,
  errorResponse,
  pathExists,
  readBody,
  send,
  sendJson
};
