const path = require("node:path");
const os = require("node:os");
const fs = require("node:fs/promises");
const crypto = require("node:crypto");
const { execFile } = require("node:child_process");

const DIFF_CAP = 45000;
const NUL_CHAR = String.fromCharCode(0);

// git diff --no-index 用临时文件路径当 a/b 标签，把它们改回真实的仓库相对路径，
// 让卡片和 changedFiles 读起来自然、也能和普通 git diff 的路径去重。
function relabelDiffHeader(diffText, baseTmp, bufTmp, relpath) {
  if (!diffText) return "";
  const posixRel = relpath.split(path.sep).join("/");
  const replaceAll = (s, from, to) => s.split(from).join(to);
  let out = diffText;
  // git 在输出里通常把路径规范成正斜杠；两种形式都替换以防万一
  out = replaceAll(out, baseTmp.split(path.sep).join("/"), posixRel);
  out = replaceAll(out, bufTmp.split(path.sep).join("/"), posixRel);
  out = replaceAll(out, baseTmp, posixRel);
  out = replaceAll(out, bufTmp, posixRel);
  return out;
}

// 把一份多文件 unified diff 按 `diff --git` 边界切开，丢掉 excludePaths 里的文件段。
// 用于：某文件有未保存缓冲区时，去掉它那份（陈旧的）磁盘 diff，只保留缓冲区版本。
function filterDiffByPaths(diffText, excludePaths) {
  if (!diffText || excludePaths.size === 0) return diffText;
  const sections = diffText.split(/(?=^diff --git )/m);
  return sections.filter((sec) => {
    const m = sec.match(/^diff --git a\/(.+?) b\//m);
    return !(m && excludePaths.has(m[1]));
  }).join("");
}

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
    // Register untracked files as intent-to-add so `git diff` reports them as new
    // files. `-N` records only their existence in the index (not their content),
    // so it does not actually stage the changes.
    await runGit(["add", "-N", "--", "."], root);
    const diff = await runGit(["diff", "--", "."], root);
    const names = await runGit(["diff", "--name-only", "--", "."], root);
    if (!diff.ok && !names.ok) {
      throw new Error(diff.stderr || "Unable to read git diff. Is this a git repository?");
    }
    const result = {
      diff: diff.stdout.slice(0, DIFF_CAP),
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

  // 取某文件在 HEAD 的内容作为 diff 基线。未跟踪 / 新文件在 HEAD 不存在，
  // 返回空串当作空基线（整个缓冲区渲染成新增），这是期望行为、不是错误。
  async function getHeadContent(root, relpath) {
    const posixRel = relpath.split(path.sep).join("/");
    const res = await runGit(["show", `HEAD:${posixRel}`], root);
    return res.ok ? res.stdout : "";
  }

  // 用 git diff --no-index 对比 HEAD 内容和未保存的缓冲区内容，生成一份 unified diff。
  async function diffBufferAgainstHead(root, relpath, content) {
    // 二进制缓冲区（含 NUL 字节）不参与文本 diff
    if (content.includes(NUL_CHAR)) return "";
    const headContent = await getHeadContent(root, relpath);
    if (headContent === content) return ""; // 缓冲区和 HEAD 一致，无需 diff

    const rand = crypto.randomBytes(8).toString("hex");
    const baseTmp = path.join(os.tmpdir(), `bsc-${rand}-a.txt`);
    const bufTmp = path.join(os.tmpdir(), `bsc-${rand}-b.txt`);
    // 传给 git 时统一用正斜杠路径：Windows 上反斜杠路径会让 git 把 diff 头
    // 加引号并转义反斜杠输出（如 "a/C:\\Users\\..."），relabel 难以稳定匹配。
    // 正斜杠路径则输出干净的 a/<path> 形式，替换可靠。
    const baseArg = baseTmp.split(path.sep).join("/");
    const bufArg = bufTmp.split(path.sep).join("/");
    try {
      await fs.writeFile(baseTmp, headContent, "utf8");
      await fs.writeFile(bufTmp, content, "utf8");
      // --ignore-cr-at-eol：忽略行尾 CR，避免 Windows 上 CRLF/LF 差异把整文件误报成全改。
      // --no-index 退出码：0=相同（无输出），1=有差异（正常），>1=真错误。
      const res = await runGit(
        ["diff", "--no-index", "--ignore-cr-at-eol", "--", baseArg, bufArg],
        root
      );
      if (res.code > 1) {
        log("warn", "diff.noindex.error", { relpath, code: res.code, stderr: res.stderr.slice(0, 500) });
        return "";
      }
      return relabelDiffHeader(res.stdout, baseArg, bufArg, relpath);
    } finally {
      // 无论写文件或 git 是否出错，都清理临时文件，且不掩盖原始错误
      await fs.rm(baseTmp, { force: true }).catch(() => {});
      await fs.rm(bufTmp, { force: true }).catch(() => {});
    }
  }

  // 综合"磁盘 diff"与"未保存缓冲区 diff"，缓冲区版本优先（覆盖同文件的陈旧磁盘段）。
  async function getDiffWithBuffers(repoPath, dirtyBuffers) {
    const base = await getDiff(repoPath);
    if (!dirtyBuffers || dirtyBuffers.length === 0) return base;

    const root = path.resolve(repoPath);
    const dirtyPaths = new Set();
    const bufferDiffs = [];
    for (const { relpath, content } of dirtyBuffers) {
      if (typeof content !== "string" || !relpath) continue;
      const single = await diffBufferAgainstHead(root, relpath, content);
      if (single) {
        bufferDiffs.push(single);
        dirtyPaths.add(relpath.split(path.sep).join("/"));
      }
    }

    const filteredBaseDiff = filterDiffByPaths(base.diff, dirtyPaths);
    // 缓冲区 diff 是这个功能的重点，放在最前，避免被 45000 上限截断掉
    const combinedDiff = [...bufferDiffs, filteredBaseDiff]
      .filter(Boolean)
      .join("\n")
      .slice(0, DIFF_CAP);

    const changedFiles = Array.from(new Set([
      ...base.changedFiles.map((f) => f.split(path.sep).join("/")),
      ...dirtyPaths
    ]));

    return { diff: combinedDiff, changedFiles };
  }

  return { getDiff, getDiffWithBuffers, runGit };
}

module.exports = { createGitService, relabelDiffHeader, filterDiffByPaths };
