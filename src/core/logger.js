const fsp = require("node:fs/promises");

function safeLogValue(value) {
  if (value instanceof Error) {
    return {
      name: value.name,
      message: value.message,
      stack: value.stack?.split(/\r?\n/).slice(0, 8).join("\n"),
      cause: value.cause ? safeLogValue(value.cause) : undefined
    };
  }
  if (Array.isArray(value)) return value.map(safeLogValue);
  if (!value || typeof value !== "object") return value;

  const output = {};
  for (const [key, item] of Object.entries(value)) {
    if (/api[_-]?key|token|secret|authorization|password/i.test(key)) {
      output[key] = item ? "<redacted>" : item;
    } else if (typeof item === "string" && item.length > 1000) {
      output[key] = `${item.slice(0, 1000)}...<truncated ${item.length - 1000} chars>`;
    } else {
      output[key] = safeLogValue(item);
    }
  }
  return output;
}

function createLogger({ dataDir, appLogFile }) {
  let logWriteChain = fsp.mkdir(dataDir, { recursive: true });

  function log(level, event, details = {}) {
    const entry = {
      ts: new Date().toISOString(),
      level,
      event,
      ...safeLogValue(details)
    };
    const line = JSON.stringify(entry);
    if (level === "error") {
      console.error(line);
    } else if (level === "warn") {
      console.warn(line);
    } else {
      console.log(line);
    }

    logWriteChain = logWriteChain
      .then(() => fsp.appendFile(appLogFile, `${line}\n`))
      .catch((error) => console.error(JSON.stringify({
        ts: new Date().toISOString(),
        level: "error",
        event: "log.write_failed",
        error: safeLogValue(error)
      })));
  }

  return { log };
}

module.exports = {
  createLogger,
  safeLogValue
};
