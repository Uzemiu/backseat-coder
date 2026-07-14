const path = require("node:path");
const { execFile } = require("node:child_process");

function createGitService({ log }) {
  function runGit(args, cwd) {
    const started = Date.now();
    log("info", "git.start", { cwd, args });
    return new Promise((resolve) => {
      execFile("git", args, { cwd, timeout: 10000, maxBuffer: 1024 * 1024 * 8 }, (error, stdout, stderr) => {
        log(error ? "error" : "info", "git.complete", {
          cwd,
          args,
          ok: !error,
          code: error?.code || 0,
          durationMs: Date.now() - started,
          stdoutBytes: Buffer.byteLength(stdout || "", "utf8"),
          stderr: stderr?.slice(0, 1000) || "",
          error
        });
        resolve({
          ok: !error,
          stdout: stdout || "",
          stderr: stderr || "",
          code: error?.code || 0
        });
      });
    });
  }

  async function getDiff(repoPath) {
    const root = path.resolve(repoPath);
    const started = Date.now();
    log("info", "diff.start", { repoPath: root });
    const diff = await runGit(["diff", "--", "."], root);
    const names = await runGit(["diff", "--name-only", "--", "."], root);
    if (!diff.ok && !names.ok) {
      throw new Error(diff.stderr || "Unable to read git diff. Is this a git repository?");
    }
    const result = {
      diff: diff.stdout.slice(0, 45000),
      changedFiles: names.stdout.split(/\r?\n/).filter(Boolean)
    };
    log("info", "diff.complete", {
      repoPath: root,
      durationMs: Date.now() - started,
      changedFiles: result.changedFiles,
      diffBytes: Buffer.byteLength(result.diff, "utf8")
    });
    return result;
  }

  return { getDiff, runGit };
}

module.exports = { createGitService };
