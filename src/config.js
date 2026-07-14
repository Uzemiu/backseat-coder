const fs = require("node:fs");
const path = require("node:path");

const ROOT = path.resolve(__dirname, "..");

function loadEnvFile(filePath = path.join(ROOT, ".env")) {
  if (!fs.existsSync(filePath)) return;

  const lines = fs.readFileSync(filePath, "utf8").split(/\r?\n/);
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;

    const equalsAt = trimmed.indexOf("=");
    if (equalsAt <= 0) continue;

    const key = trimmed.slice(0, equalsAt).trim();
    let value = trimmed.slice(equalsAt + 1).trim();
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }

    if (!Object.prototype.hasOwnProperty.call(process.env, key)) {
      process.env[key] = value;
    }
  }
}

function readPositiveInt(value, fallback) {
  const parsed = Number.parseInt(value, 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

function getProxyUrl() {
  return process.env.AI_PROXY_URL ||
    process.env.HTTPS_PROXY ||
    process.env.HTTP_PROXY ||
    process.env.ALL_PROXY ||
    process.env.https_proxy ||
    process.env.http_proxy ||
    process.env.all_proxy ||
    "";
}

function createConfig() {
  loadEnvFile();

  const dataDir = path.join(ROOT, "data");
  return {
    root: ROOT,
    publicDir: path.join(ROOT, "public"),
    dataDir,
    sessionsFile: path.join(dataDir, "sessions.json"),
    appLogFile: path.join(dataDir, "app.log"),
    port: Number(process.env.PORT || 3000),
    startedAt: new Date().toISOString(),
    provider: {
      requested: (process.env.AI_PROVIDER || "auto").toLowerCase(),
      openAIKey: process.env.OPENAI_API_KEY || "",
      openAIBaseUrl: process.env.OPENAI_BASE_URL || "https://api.openai.com/v1",
      openAIModel: process.env.OPENAI_MODEL || "gpt-4.1-mini",
      anthropicKey: process.env.ANTHROPIC_API_KEY || "",
      anthropicBaseUrl: process.env.ANTHROPIC_BASE_URL || "https://api.anthropic.com",
      anthropicModel: process.env.ANTHROPIC_MODEL || "claude-sonnet-4-5",
      anthropicVersion: process.env.ANTHROPIC_VERSION || "2023-06-01",
      anthropicMaxTokens: readPositiveInt(process.env.ANTHROPIC_MAX_TOKENS, 4096)
    },
    proxyUrl: getProxyUrl()
  };
}

module.exports = {
  createConfig,
  getProxyUrl,
  loadEnvFile,
  readPositiveInt
};
