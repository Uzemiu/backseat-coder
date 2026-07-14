const assert = require("node:assert/strict");
const test = require("node:test");
const { createAiService } = require("../src/services/ai");

function providerFor(provider) {
  const ai = createAiService({
    config: {
      provider: {
        requested: provider.requested,
        openAIKey: provider.openAIKey || "",
        anthropicKey: provider.anthropicKey || ""
      }
    },
    log: () => {}
  });
  return ai.getAiProvider();
}

test("local provider mode never falls through to configured remote keys", () => {
  assert.equal(providerFor({
    requested: "local",
    openAIKey: "openai-key",
    anthropicKey: "anthropic-key"
  }), "local");
});

test("auto provider mode prefers Anthropic, then OpenAI, then local", () => {
  assert.equal(providerFor({
    requested: "auto",
    openAIKey: "openai-key",
    anthropicKey: "anthropic-key"
  }), "anthropic");
  assert.equal(providerFor({
    requested: "auto",
    openAIKey: "openai-key"
  }), "openai");
  assert.equal(providerFor({ requested: "auto" }), "local");
});
