const assert = require("node:assert/strict");
const test = require("node:test");
const { scoreSession } = require("../src/storage/sessions");

test("session scoring prefers same repo and matching task terms", () => {
  const score = scoreSession({
    repoPath: "G:\\code\\target",
    task: "change login session timeout",
    summary: "Updated auth timeout",
    changedFiles: ["src/auth/session.ts"]
  }, {
    root: "g:\\code\\target",
    terms: ["login", "timeout"],
    changedFiles: []
  });

  assert.ok(score >= 14);
});

test("session scoring excludes other repositories", () => {
  const score = scoreSession({
    repoPath: "G:\\code\\other",
    task: "change login session timeout"
  }, {
    root: "g:\\code\\target",
    terms: ["login", "timeout"],
    changedFiles: []
  });

  assert.equal(score, 0);
});

test("session scoring boosts exact changed file matches", () => {
  const score = scoreSession({
    repoPath: "G:\\code\\target",
    changedFiles: ["src/auth/session.ts"]
  }, {
    root: "g:\\code\\target",
    terms: [],
    changedFiles: ["src/auth/session.ts"]
  });

  assert.ok(score >= 14);
});
