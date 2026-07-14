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
      "You are an AI pair coding guide. Help a developer understand a repository without taking over implementation. Return only JSON.",
      `Create a concise repo map for a new developer.\n\nFiles:\n${scan.tree}\n\nKey files:\n${JSON.stringify(scan.keyFileContents).slice(0, 20000)}\n\nReturn JSON with projectType, mainEntryPoints, coreModules, recommendedReadingOrder, testingStrategy, unknowns, and projectGuide. The projectGuide must be a concise Markdown guide similar to CLAUDE.md that can be passed into every later AI request as persistent repository context.`,
      fallback
    );
  }

  function aiNavigator(task, repoMap, searchResults, learningMemory = []) {
    const fallback = localNavigator(task, repoMap, searchResults);
    const projectGuide = repoMap.projectGuide || buildProjectGuide(repoMap, [], {});
    const memoryContext = formatLearningMemory(learningMemory);
    return callAiJson(
      "You are an AI pair coding guide. You guide, explain, and ask useful context questions. Do not write the full implementation. Return only JSON.",
      `Project guide, always treat this as persistent repository context:\n${projectGuide.slice(0, 16000)}\n\nRelevant Learning Logs from previous work:\n${memoryContext}\n\nThe human's task is: ${task}\n\nRepo map:\n${JSON.stringify(repoMap)}\n\nRelevant search results:\n${JSON.stringify(searchResults).slice(0, 18000)}\n\nReturn JSON with taskUnderstanding, filesToReadFirst, likelyFilesToChange, questionsBeforeCoding, suggestedSteps.`,
      fallback
    );
  }

  function aiDiffCoach(diffInfo, repoMap, learningMemory = []) {
    const fallback = localDiffCoach(diffInfo);
    const projectGuide = repoMap.projectGuide || buildProjectGuide(repoMap, [], {});
    const memoryContext = formatLearningMemory(learningMemory);
    return callAiJson(
      "Analyze git diff as a helpful onboarding mentor, not an adversarial reviewer. Explain impact and tests. Return only JSON.",
      `Project guide, always treat this as persistent repository context:\n${projectGuide.slice(0, 16000)}\n\nRelevant Learning Logs from previous work:\n${memoryContext}\n\nRepo map:\n${JSON.stringify(repoMap)}\n\nChanged files:\n${JSON.stringify(diffInfo.changedFiles)}\n\nDiff:\n${diffInfo.diff}\n\nReturn JSON with summary, impact, risks, missingTests, followUpFiles, developerUnderstandingQuestions.`,
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
    taskUnderstanding: `Work through "${task}" by first locating the existing behavior, then making the smallest targeted change.`,
    filesToReadFirst: filesToReadFirst.length ? filesToReadFirst : repoMap.recommendedReadingOrder?.slice(0, 6) || [],
    likelyFilesToChange,
    questionsBeforeCoding: [
      "Where is the current behavior defined?",
      "Is the behavior configured in code, environment variables, or data?",
      "Which tests or examples already describe the expected behavior?"
    ],
    suggestedSteps: [
      "Read the first two files and identify the main control flow.",
      "Trace one realistic request or function call through the relevant modules.",
      "Make a narrow change and rerun the closest test or manual check.",
      "Use Diff Coach before considering the task finished."
    ]
  };
}

function localDiffCoach(diffInfo) {
  if (!diffInfo.diff.trim()) {
    return {
      summary: "No unstaged code diff was found.",
      impact: [],
      risks: ["There may be staged changes or untracked files that are not included in plain git diff."],
      missingTests: [],
      followUpFiles: [],
      developerUnderstandingQuestions: ["Are your changes staged already, or is the working tree clean?"]
    };
  }
  const added = diffInfo.diff.split(/\r?\n/).filter((line) => line.startsWith("+") && !line.startsWith("+++")).length;
  const removed = diffInfo.diff.split(/\r?\n/).filter((line) => line.startsWith("-") && !line.startsWith("---")).length;
  const testFiles = diffInfo.changedFiles.filter((file) => /(\.test\.|\.spec\.|_test\.|\/test\/|\/tests\/|__tests__)/i.test(file));
  return {
    summary: `The current diff touches ${diffInfo.changedFiles.length} file(s), with roughly ${added} added and ${removed} removed lines.`,
    impact: diffInfo.changedFiles.map((file) => `Changed ${file}; confirm callers and tests that depend on it.`),
    risks: [
      "Check whether config, docs, or examples need the same update.",
      "Confirm the changed behavior is covered for both normal and edge cases."
    ],
    missingTests: testFiles.length ? [] : ["No changed test file detected in the current diff."],
    followUpFiles: [],
    developerUnderstandingQuestions: [
      "What user-visible behavior changes because of this diff?",
      "Which existing test would fail if this change were wrong?",
      "Is there a smaller way to verify the same behavior?"
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
