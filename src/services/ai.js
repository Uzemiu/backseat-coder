const { buildProjectGuide } = require("./repository");

function createAiService({ config, log }) {
  function getAiProvider() {
    const requested = config.provider.requested;
    if (requested === "local") return "local";
    if (requested === "anthropic") return config.provider.anthropicKey ? "anthropic" : "local";
    if (requested === "openai") return config.provider.openAIKey ? "openai" : "local";
    if (config.provider.anthropicKey) return "anthropic";
    if (config.provider.openAIKey) return "openai";
    return "local";
  }

  async function callAiJson(system, user, fallback) {
    const provider = getAiProvider();
    log("info", "ai.provider.selected", {
      requested: config.provider.requested,
      provider,
      hasOpenAIKey: Boolean(config.provider.openAIKey),
      hasAnthropicKey: Boolean(config.provider.anthropicKey)
    });
    try {
      if (provider === "anthropic") return await callAnthropicJson(system, user, fallback);
      if (provider === "openai") return await callOpenAIJson(system, user, fallback);
      return { source: "local", data: fallback };
    } catch (error) {
      log("error", "ai.provider.exception", { provider, error });
      return { source: "local", error: error.message || String(error), data: fallback };
    }
  }

  async function callOpenAIJson(system, user, fallback) {
    const started = Date.now();
    const requestUrl = joinUrl(config.provider.openAIBaseUrl, "/chat/completions");
    log("info", "ai.openai.request.start", {
      model: config.provider.openAIModel,
      baseUrl: config.provider.openAIBaseUrl,
      requestUrl,
      userChars: user.length
    });
    const response = await fetch(requestUrl, {
      method: "POST",
      headers: {
        "authorization": `Bearer ${config.provider.openAIKey}`,
        "content-type": "application/json"
      },
      body: JSON.stringify({
        model: config.provider.openAIModel,
        temperature: 0.2,
        response_format: { type: "json_object" },
        messages: [
          { role: "system", content: system },
          { role: "user", content: user }
        ]
      })
    });

    if (!response.ok) {
      const errorText = await response.text();
      log("error", "ai.openai.request.failed", {
        status: response.status,
        statusText: response.statusText,
        durationMs: Date.now() - started,
        body: errorText.slice(0, 1000)
      });
      return { source: "local", error: errorText.slice(0, 500), data: fallback };
    }

    const json = await response.json();
    const content = json.choices?.[0]?.message?.content || "{}";
    log("info", "ai.openai.request.complete", {
      model: config.provider.openAIModel,
      durationMs: Date.now() - started,
      responseChars: content.length
    });
    return { source: "openai", data: parseJsonOutput(content, fallback) };
  }

  async function callAnthropicJson(system, user, fallback) {
    const started = Date.now();
    const requestUrl = joinUrl(config.provider.anthropicBaseUrl, "/v1/messages");
    log("info", "ai.anthropic.request.start", {
      model: config.provider.anthropicModel,
      baseUrl: config.provider.anthropicBaseUrl,
      requestUrl,
      userChars: user.length
    });
    const response = await fetch(requestUrl, {
      method: "POST",
      headers: {
        "x-api-key": config.provider.anthropicKey,
        "anthropic-version": config.provider.anthropicVersion,
        "content-type": "application/json"
      },
      body: JSON.stringify({
        model: config.provider.anthropicModel,
        max_tokens: config.provider.anthropicMaxTokens,
        system,
        messages: [
          {
            role: "user",
            content: `${user}\n\nReturn valid JSON only. Do not wrap it in Markdown.`
          }
        ]
      })
    });

    if (!response.ok) {
      const errorText = await response.text();
      log("error", "ai.anthropic.request.failed", {
        status: response.status,
        statusText: response.statusText,
        durationMs: Date.now() - started,
        body: errorText.slice(0, 1000)
      });
      return { source: "local", error: errorText.slice(0, 500), data: fallback };
    }

    const json = await response.json();
    const content = (json.content || [])
      .filter((block) => block.type === "text")
      .map((block) => block.text)
      .join("\n");
    log("info", "ai.anthropic.request.complete", {
      model: config.provider.anthropicModel,
      durationMs: Date.now() - started,
      responseChars: content.length
    });
    return { source: "anthropic", data: parseJsonOutput(content, fallback) };
  }

  function aiRepoMap(scan) {
    const fallback = scan.localMap;
    return callAiJson(
      "You are an AI pair coding guide. Help a developer understand a repository without taking over implementation. Always respond in Chinese. Return only JSON.",
      `Create a concise repo map for a new developer.\n\nFiles:\n${scan.tree}\n\nKey files:\n${JSON.stringify(scan.keyFileContents).slice(0, 20000)}\n\nReturn JSON with projectType, mainEntryPoints, coreModules, recommendedReadingOrder, testingStrategy, unknowns, projectGuide, and brief. The projectGuide must be a concise Markdown guide similar to CLAUDE.md that can be passed into every later AI request as persistent repository context. The brief field must be 2-3 sentences in Chinese summarizing the project type and most important entry points — this is shown first to the developer before they expand for details. All text fields must be in Chinese.`,
      fallback
    );
  }

  function aiNavigator(task, repoMap, searchResults, learningMemory = []) {
    const fallback = localNavigator(task, repoMap, searchResults);
    const projectGuide = repoMap.projectGuide || buildProjectGuide(repoMap, [], {});
    const memoryContext = formatLearningMemory(learningMemory);
    return callAiJson(
      "You are an AI pair coding guide. You guide, explain, and ask useful context questions. Do not write the full implementation. Always respond in Chinese. Return only JSON.",
      `Project guide, always treat this as persistent repository context:\n${projectGuide.slice(0, 16000)}\n\nRelevant Learning Logs from previous work:\n${memoryContext}\n\nThe human's task is: ${task}\n\nRepo map:\n${JSON.stringify(repoMap)}\n\nRelevant search results:\n${JSON.stringify(searchResults).slice(0, 18000)}\n\nReturn JSON with brief, taskUnderstanding, filesToReadFirst, likelyFilesToChange, questionsBeforeCoding, suggestedSteps. The brief field must be 2-3 sentences in Chinese giving the most important insight about this task — shown first before the developer expands for full details. All text fields must be in Chinese.`,
      fallback
    );
  }

  function aiDiffCoach(diffInfo, repoMap, learningMemory = []) {
    const fallback = localDiffCoach(diffInfo);
    const projectGuide = repoMap.projectGuide || buildProjectGuide(repoMap, [], {});
    const memoryContext = formatLearningMemory(learningMemory);
    return callAiJson(
      "You are the developer's trusted senior colleague — the one they turn to when they want an honest opinion, not a rubber stamp. You've seen this codebase grow, you remember past mistakes, and you actually care whether this change lands well. You talk like a real person: casual, direct, occasionally opinionated. You notice things. You ask the question the developer probably already has in the back of their head but hasn't said out loud yet. You're not trying to be comprehensive — you're trying to be useful right now. Always respond in Chinese. Return only JSON.",
      `Project context:\n${projectGuide.slice(0, 16000)}\n\nWhat you remember from past sessions:\n${memoryContext}\n\nChanged files: ${JSON.stringify(diffInfo.changedFiles)}\n\nDiff:\n${diffInfo.diff}\n\nRespond as that colleague would — brief, honest, human. Return JSON:\n- brief: 2-3 sentences in Chinese with your gut reaction to this change — the one thing you'd say if you had 10 seconds. Shown first before the developer expands for full details.\n- summary: 1-2 sentences, say what actually changed and whether it feels right\n- impact: up to 3 short notes on what this touches or changes for users/callers\n- risks: up to 3 things that could bite them — only real concerns, skip the obvious\n- missingTests: up to 3 specific gaps, or empty array if coverage looks fine\n- followUpFiles: files worth a second look given this change\n- developerUnderstandingQuestions: 1-3 questions the developer should sit with — the kind a good colleague asks over coffee, not a quiz\nAll text fields must be in Chinese.`,
      fallback
    );
  }

  return {
    aiDiffCoach,
    aiNavigator,
    aiRepoMap,
    callAiJson,
    getAiProvider
  };
}

function parseJsonOutput(content, fallback) {
  const text = String(content || "").trim();
  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/i);
  const candidate = fenced ? fenced[1].trim() : text;
  try {
    return JSON.parse(candidate);
  } catch {
    return { raw: text, fallback };
  }
}

function joinUrl(baseUrl, pathname) {
  return `${String(baseUrl).replace(/\/+$/, "")}/${String(pathname).replace(/^\/+/, "")}`;
}

function formatLearningMemory(sessions) {
  if (!sessions?.length) return "No relevant learning logs found.";

  return sessions.slice(0, 5).map((session, index) => {
    const lines = [
      `## Memory ${index + 1}: ${session.task || "Untitled session"}`,
      `- Created: ${session.createdAt || "unknown"}`,
      `- Summary: ${session.summary || "No summary"}`,
      `- Changed files: ${(session.changedFiles || []).join(", ") || "none recorded"}`,
      `- Learned concepts: ${(session.learnedConcepts || []).join(", ") || "none recorded"}`,
      `- Open questions: ${(session.openQuestions || []).join(" | ") || "none recorded"}`
    ];
    if (session.navigation?.filesToReadFirst?.length) {
      lines.push(`- Previously suggested files: ${session.navigation.filesToReadFirst.join(", ")}`);
    }
    return lines.join("\n");
  }).join("\n\n").slice(0, 10000);
}

function localNavigator(task, repoMap, searchResults) {
  const filesToReadFirst = searchResults.slice(0, 6).map((item) => item.file);
  const likelyFilesToChange = searchResults.slice(0, 4).map((item) => item.file);
  return {
    brief: `任务「${task}」已收到。先定位现有逻辑，再做最小改动。`,
    taskUnderstanding: `通过先找到现有行为，然后做最小范围的修改来完成「${task}」。`,
    filesToReadFirst: filesToReadFirst.length ? filesToReadFirst : repoMap.recommendedReadingOrder?.slice(0, 6) || [],
    likelyFilesToChange,
    questionsBeforeCoding: [
      "当前行为在哪里定义？",
      "该行为是通过代码、环境变量还是数据来配置的？",
      "已有哪些测试或示例描述了期望行为？"
    ],
    suggestedSteps: [
      "先读前两个文件，找出主要控制流。",
      "沿着相关模块追踪一次真实的请求或函数调用。",
      "做最小改动，然后重跑最近的测试或手动验证。",
      "完成前用「改动审视」检查一遍。"
    ]
  };
}

function localDiffCoach(diffInfo) {
  if (!diffInfo.diff.trim()) {
    return {
      brief: "没有找到未暂存的改动。",
      summary: "没有找到未暂存的代码差异。",
      impact: [],
      risks: ["可能存在已暂存的改动，普通 git diff 不会显示。"],
      missingTests: [],
      followUpFiles: [],
      developerUnderstandingQuestions: ["你的改动已经暂存了，还是工作区本来就是干净的？"]
    };
  }
  const added = diffInfo.diff.split(/\r?\n/).filter((line) => line.startsWith("+") && !line.startsWith("+++")).length;
  const removed = diffInfo.diff.split(/\r?\n/).filter((line) => line.startsWith("-") && !line.startsWith("---")).length;
  const testFiles = diffInfo.changedFiles.filter((file) => /(\.test\.|\.spec\.|_test\.|\/test\/|\/tests\/|__tests__)/i.test(file));
  return {
    brief: `本次改动涉及 ${diffInfo.changedFiles.length} 个文件，约新增 ${added} 行、删除 ${removed} 行。`,
    summary: `当前差异涉及 ${diffInfo.changedFiles.length} 个文件，约新增 ${added} 行、删除 ${removed} 行。`,
    impact: diffInfo.changedFiles.map((file) => `修改了 ${file}，请确认依赖它的调用方和测试。`),
    risks: [
      "确认配置、文档或示例是否需要同步更新。",
      "确认改动行为在正常情况和边界情况下都有测试覆盖。"
    ],
    missingTests: testFiles.length ? [] : ["当前差异中未检测到测试文件的改动。"],
    followUpFiles: [],
    developerUnderstandingQuestions: [
      "这次改动会改变哪些用户可见的行为？",
      "如果这次改动有误，哪个现有测试会失败？",
      "有没有更小的方式来验证同样的行为？"
    ]
  };
}

module.exports = {
  createAiService,
  formatLearningMemory,
  localDiffCoach,
  localNavigator,
  parseJsonOutput
};
