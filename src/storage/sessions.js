const fsp = require("node:fs/promises");
const { pathExists } = require("../core/http");

function createSessionStore({ dataDir, sessionsFile }) {
  async function loadSessions() {
    if (!(await pathExists(sessionsFile))) return [];
    return JSON.parse(await fsp.readFile(sessionsFile, "utf8"));
  }

  async function saveSession(session) {
    await fsp.mkdir(dataDir, { recursive: true });
    const sessions = await loadSessions();
    const next = {
      id: `session-${Date.now()}`,
      createdAt: new Date().toISOString(),
      ...session
    };
    sessions.unshift(next);
    await fsp.writeFile(sessionsFile, JSON.stringify(sessions.slice(0, 100), null, 2));
    return next;
  }

  return { loadSessions, saveSession };
}

module.exports = { createSessionStore };
