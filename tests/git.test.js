const assert = require("node:assert/strict");
const test = require("node:test");
const { relabelDiffHeader, filterDiffByPaths } = require("../src/services/git");

test("relabelDiffHeader rewrites temp paths back to the repo-relative path", () => {
  // 真实 git diff --no-index 输出：路径规范成正斜杠，形如 `--- a/<绝对临时路径>`
  const baseTmp = "C:/Users/x/AppData/Local/Temp/bsc-abc-a.txt";
  const bufTmp = "C:/Users/x/AppData/Local/Temp/bsc-abc-b.txt";
  const raw = [
    `diff --git a/${baseTmp} b/${bufTmp}`,
    "index 0906fba..86ba82a 100644",
    `--- a/${baseTmp}`,
    `+++ b/${bufTmp}`,
    "@@ -1 +1 @@",
    "-old",
    "+new"
  ].join("\n");

  const out = relabelDiffHeader(raw, baseTmp, bufTmp, "src/foo.js");

  assert.ok(out.includes("--- a/src/foo.js"), "old label points at relpath");
  assert.ok(out.includes("+++ b/src/foo.js"), "new label points at relpath");
  assert.ok(!out.includes("bsc-abc"), "no temp-file fragment leaks through");
});

test("relabelDiffHeader returns empty string for empty input", () => {
  assert.equal(relabelDiffHeader("", "/tmp/a", "/tmp/b", "x.js"), "");
});

test("filterDiffByPaths drops only the excluded file section", () => {
  const twoFileDiff = [
    "diff --git a/src/keep.js b/src/keep.js",
    "@@ -1 +1 @@",
    "-a",
    "+b",
    "diff --git a/src/drop.js b/src/drop.js",
    "@@ -1 +1 @@",
    "-c",
    "+d"
  ].join("\n");

  const out = filterDiffByPaths(twoFileDiff, new Set(["src/drop.js"]));

  assert.ok(out.includes("a/src/keep.js"), "kept file remains");
  assert.ok(!out.includes("a/src/drop.js"), "excluded file removed");
});

test("filterDiffByPaths is a no-op when exclude set is empty", () => {
  const diff = "diff --git a/x.js b/x.js\n@@ -1 +1 @@\n-a\n+b";
  assert.equal(filterDiffByPaths(diff, new Set()), diff);
});
