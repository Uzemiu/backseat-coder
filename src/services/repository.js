const fsp = require("node:fs/promises");
const path = require("node:path");

const IGNORE_DIRS = new Set([
  ".git",
  ".next",
  ".turbo",
  ".venv",
  "build",
  "coverage",
  "dist",
  "node_modules",
  "target",
  "vendor"
]);

const KEY_FILES = [
  "CLAUDE.md",
  "AGENTS.md",
  "AI_PAIR_GUIDE.md",
  "README.md",
  "package.json",
  "go.mod",
  "pyproject.toml",
  "requirements.txt",
  "Cargo.toml",
  "pom.xml",
  "build.gradle",
  "Dockerfile",
  "docker-compose.yml",
  ".env.example",
  "tsconfig.json",
  "vite.config.ts",
  "next.config.js"
];

const PROJECT_GUIDE_FILES = new Set([
  "CLAUDE.md",
  "AGENTS.md",
  "AI_PAIR_GUIDE.md"
]);

const TEXT_EXTENSIONS = new Set([
  ".c",
  ".cc",
  ".conf",
  ".cpp",
  ".cs",
  ".css",
  ".go",
  ".h",
  ".html",
  ".java",
  ".js",
  ".json",
  ".jsx",
  ".kt",
  ".md",
  ".mjs",
  ".php",
  ".py",
  ".rb",
  ".rs",
  ".sql",
  ".toml",
  ".ts",
  ".tsx",
  ".txt",
  ".xml",
  ".yaml",
  ".yml"
]);

function createRepositoryService({ log }) {
  async function scanRepo(repoPath) {
    const root = path.resolve(repoPath);
    const started = Date.now();
    log("info", "repo.scan.start", { repoPath: root });
    const stat = await fsp.stat(root);
    if (!stat.isDirectory()) throw new Error("Repo path must be a directory.");

    const files = [];
    const directories = [];
    const keyFiles = [];
    const maxFiles = 800;
    const maxDepth = 5;

    async function walk(current, depth) {
      if (files.length >= maxFiles || depth > maxDepth) return;
      const entries = await fsp.readdir(current, { withFileTypes: true });
      entries.sort((a, b) => Number(b.isDirectory()) - Number(a.isDirectory()) || a.name.localeCompare(b.name));

      for (const entry of entries) {
        if (files.length >= maxFiles) break;
        if (entry.name.startsWith(".") && entry.name !== ".env.example" && entry.name !== ".github") {
          if (entry.name !== ".git") continue;
        }
        if (entry.isDirectory() && IGNORE_DIRS.has(entry.name)) continue;

        const full = path.join(current, entry.name);
        const rel = path.relative(root, full).replaceAll("\\", "/");
        if (entry.isDirectory()) {
          directories.push(rel);
          await walk(full, depth + 1);
        } else {
          files.push(rel);
          if (KEY_FILES.includes(entry.name) || KEY_FILES.includes(rel)) keyFiles.push(rel);
        }
      }
    }

    await walk(root, 0);
    const keyFileContents = {};
    for (const rel of keyFiles.slice(0, 12)) {
      keyFileContents[rel] = await readSmallText(path.join(root, rel), 4000);
    }

    const result = {
      root,
      tree: buildTree(files, directories),
      files,
      directories,
      keyFiles,
      keyFileContents,
      localMap: buildLocalRepoMap(files, keyFiles, keyFileContents)
    };
    log("info", "repo.scan.complete", {
      repoPath: root,
      durationMs: Date.now() - started,
      files: files.length,
      directories: directories.length,
      keyFiles
    });
    return result;
  }

  async function searchRepo(repoPath, query, knownFiles) {
    const root = path.resolve(repoPath);
    const words = tokenize(query);
    const scored = [];
    const started = Date.now();
    log("info", "repo.search.start", {
      repoPath: root,
      query,
      tokenCount: words.length,
      knownFileCount: knownFiles.length
    });

    for (const rel of knownFiles.slice(0, 800)) {
      const lower = rel.toLowerCase();
      let score = words.reduce((sum, word) => sum + (lower.includes(word) ? 6 : 0), 0);
      let snippet = "";
      const full = path.join(root, rel);
      try {
        const text = await readSmallText(full, 6000);
        const lowerText = text.toLowerCase();
        for (const word of words) {
          const index = lowerText.indexOf(word);
          if (index >= 0) {
            score += 3;
            if (!snippet) snippet = text.slice(Math.max(0, index - 160), index + 360);
          }
        }
      } catch {
        // Ignore unreadable files.
      }
      if (score > 0) scored.push({ file: rel, score, snippet });
    }

    const results = scored.sort((a, b) => b.score - a.score).slice(0, 12);
    log("info", "repo.search.complete", {
      repoPath: root,
      query,
      durationMs: Date.now() - started,
      resultCount: results.length,
      topFiles: results.slice(0, 5).map((item) => ({ file: item.file, score: item.score }))
    });
    return results;
  }

  return { scanRepo, searchRepo };
}

function isTextFile(filePath) {
  const base = path.basename(filePath);
  if (KEY_FILES.includes(base) || base.startsWith(".env")) return true;
  return TEXT_EXTENSIONS.has(path.extname(filePath).toLowerCase());
}

async function readSmallText(filePath, maxChars = 8000) {
  if (!isTextFile(filePath)) return "";
  const stat = await fsp.stat(filePath);
  if (stat.size > 512 * 1024) return "";
  const text = await fsp.readFile(filePath, "utf8");
  return text.slice(0, maxChars);
}

function buildTree(files, directories) {
  const all = [...directories.map((name) => `${name}/`), ...files].sort();
  return all.slice(0, 500).join("\n");
}

function detectProjectType(files, keyFileContents) {
  if (files.includes("package.json")) {
    const pkg = safeJson(keyFileContents["package.json"]);
    const deps = { ...(pkg?.dependencies || {}), ...(pkg?.devDependencies || {}) };
    if (deps.next) return "Next.js web app";
    if (deps.react || deps.vite) return "React web app";
    if (deps.express || deps.fastify) return "Node.js service";
    return "JavaScript/TypeScript project";
  }
  if (files.includes("go.mod")) return "Go module";
  if (files.includes("pyproject.toml") || files.includes("requirements.txt")) return "Python project";
  if (files.includes("Cargo.toml")) return "Rust project";
  if (files.includes("pom.xml") || files.includes("build.gradle")) return "Java project";
  return "Unknown project type";
}

function safeJson(text) {
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

function buildLocalRepoMap(files, keyFiles, keyFileContents) {
  const projectType = detectProjectType(files, keyFileContents);
  const entryHints = files.filter((file) =>
    /(^|\/)(main|index|app|server|page|route)\.(go|js|jsx|mjs|ts|tsx|py|rs|java)$/.test(file)
  ).slice(0, 12);
  const tests = files.filter((file) => /(\.test\.|\.spec\.|_test\.|\/test\/|\/tests\/|__tests__)/i.test(file)).slice(0, 12);
  const modules = inferModules(files);

  const repoMap = {
    projectType,
    mainEntryPoints: entryHints,
    coreModules: modules,
    recommendedReadingOrder: [
      ...keyFiles.filter((file) => /readme/i.test(file)).slice(0, 1),
      ...entryHints.slice(0, 4),
      ...modules.map((mod) => mod.path).slice(0, 5),
      ...tests.slice(0, 2)
    ],
    testingStrategy: tests.length ? `Found ${tests.length} likely test files.` : "No obvious tests found in the scanned files.",
    unknowns: [
      "Runtime behavior still needs confirmation from source flow.",
      "Generated map is based on file names and selected config files."
    ]
  };
  repoMap.projectGuide = buildProjectGuide(repoMap, keyFiles, keyFileContents);
  return repoMap;
}

function buildProjectGuide(repoMap, keyFiles, keyFileContents) {
  const embeddedGuides = keyFiles
    .filter((file) => PROJECT_GUIDE_FILES.has(path.basename(file)))
    .map((file) => ({
      file,
      content: (keyFileContents[file] || "").trim().slice(0, 6000)
    }))
    .filter((guide) => guide.content);

  const lines = [
    "# Project Guide",
    "",
    "Use this guide as persistent repository context for AI guidance in this app.",
    "",
    "## Project Snapshot",
    `- Type: ${repoMap.projectType || "Unknown"}`,
    `- Testing: ${repoMap.testingStrategy || "Unknown"}`,
    "",
    "## Main Entry Points",
    ...(repoMap.mainEntryPoints?.length ? repoMap.mainEntryPoints.map((file) => `- ${file}`) : ["- Unknown"]),
    "",
    "## Core Modules",
    ...(repoMap.coreModules?.length
      ? repoMap.coreModules.map((mod) => `- ${mod.path}: ${mod.purpose}`)
      : ["- Unknown"]),
    "",
    "## Recommended Reading Order",
    ...(repoMap.recommendedReadingOrder?.length
      ? repoMap.recommendedReadingOrder.map((file) => `- ${file}`)
      : ["- Unknown"]),
    "",
    "## Known Unknowns",
    ...(repoMap.unknowns?.length ? repoMap.unknowns.map((item) => `- ${item}`) : ["- None recorded"])
  ];

  if (embeddedGuides.length) {
    lines.push("", "## Repository-Provided AI Instructions");
    for (const guide of embeddedGuides) {
      lines.push("", `### ${guide.file}`, "", guide.content);
    }
  }

  return lines.join("\n").slice(0, 16000);
}

function normalizeRepoMap(repoMap, fallback) {
  const normalized = {
    ...fallback,
    ...(repoMap && typeof repoMap === "object" ? repoMap : {})
  };

  normalized.mainEntryPoints = Array.isArray(normalized.mainEntryPoints) ? normalized.mainEntryPoints : [];
  normalized.recommendedReadingOrder = Array.isArray(normalized.recommendedReadingOrder) ? normalized.recommendedReadingOrder : [];
  normalized.unknowns = Array.isArray(normalized.unknowns) ? normalized.unknowns : [];
  normalized.coreModules = Array.isArray(normalized.coreModules)
    ? normalized.coreModules.map((mod) => {
      if (typeof mod === "string") {
        return { name: path.basename(mod), path: mod, purpose: "AI identified this as a core module; inspect to confirm responsibility." };
      }
      return mod;
    })
    : [];

  if (!normalized.projectGuide) {
    normalized.projectGuide = buildProjectGuide(normalized, [], {});
  }

  return normalized;
}

function inferModules(files) {
  const counts = new Map();
  for (const file of files) {
    const parts = file.split("/");
    if (parts.length < 2) continue;
    const first = parts[0];
    if (["src", "app", "lib", "server", "cmd", "internal", "pkg"].includes(first) && parts[1]) {
      const key = first === "src" || first === "app" ? `${first}/${parts[1]}` : first;
      counts.set(key, (counts.get(key) || 0) + 1);
    } else {
      counts.set(first, (counts.get(first) || 0) + 1);
    }
  }
  return [...counts.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, 8)
    .map(([name, count]) => ({
      name: name.split("/").pop(),
      path: name,
      purpose: `Contains ${count} scanned file${count === 1 ? "" : "s"}; inspect to confirm responsibility.`
    }));
}

function tokenize(text) {
  return [...new Set(String(text).toLowerCase().match(/[a-z0-9_\-\u4e00-\u9fff]+/g) || [])]
    .filter((word) => word.length > 1 && !["the", "and", "for", "with", "this", "that"].includes(word));
}

module.exports = {
  buildProjectGuide,
  createRepositoryService,
  normalizeRepoMap
};
