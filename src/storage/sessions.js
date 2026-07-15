const fsp = require("node:fs/promises");
const path = require("node:path");
const { pathExists } = require("../core/http");
const { tokenize } = require("../core/text");

function createSessionStore({ dataDir, sessionsFile }) {
  async function loadSessions() {
    if (!(await pathExists(sessionsFile))) return [];
    try {
      return JSON.parse(await fsp.readFile(sessionsFile, "utf8"));
    } catch {
      return [];
    }
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

  async function findRelevantSessions({ repoPath, query = "", changedFiles = [], limit = 5 }) {
    const sessions = await loadSessions();
    const root = normalizePath(repoPath);
    const terms = tokenize([query, ...changedFiles].join(" "));

    return sessions
      .map((session, index) => ({
        session,
        score: scoreSession(session, { root, terms, changedFiles }) + Math.max(0, 20 - index) / 100
      }))
      .filter((item) => item.score > 0)
      .sort((a, b) => b.score - a.score)
      .slice(0, limit)
      .map((item) => compactSession(item.session));
  }

  async function clearSessions() {
    await fsp.mkdir(dataDir, { recursive: true });
    await fsp.writeFile(sessionsFile, JSON.stringify([], null, 2));
  }

  return { clearSessions, findRelevantSessions, loadSessions, saveSession };
}

function compactSession(session) {
  return {
    id: session.id,
    createdAt: session.createdAt,
    repoPath: session.repoPath,
    task: session.task,
    summary: session.summary,
    changedFiles: session.changedFiles || [],
    learnedConcepts: session.learnedConcepts || [],
    openQuestions: session.openQuestions || [],
    navigation: session.navigation ? {
      filesToReadFirst: session.navigation.filesToReadFirst || [],
      likelyFilesToChange: session.navigation.likelyFilesToChange || [],
      suggestedSteps: session.navigation.suggestedSteps || []
    } : undefined
  };
}

function scoreSession(session, { root, terms, changedFiles }) {
  let score = 0;
  const sessionRepo = normalizePath(session.repoPath);
  if (root && sessionRepo && sessionRepo === root) score += 10;
  if (root && sessionRepo && sessionRepo !== root) return 0;

  const haystack = [
    session.task,
    session.summary,
    ...(session.changedFiles || []),
    ...(session.learnedConcepts || []),
    ...(session.openQuestions || [])
  ].join(" ").toLowerCase();

  for (const term of terms) {
    if (haystack.includes(term)) score += 2;
  }

  const sessionFiles = new Set((session.changedFiles || []).map((file) => file.toLowerCase()));
  for (const file of changedFiles || []) {
    if (sessionFiles.has(String(file).toLowerCase())) score += 4;
  }

  if (!terms.length && !changedFiles?.length && root && sessionRepo === root) score += 1;
  return score;
}

function normalizePath(value) {
  if (!value) return "";
  return path.resolve(String(value)).toLowerCase();
}

module.exports = {
  compactSession,
  createSessionStore,
  scoreSession
};
