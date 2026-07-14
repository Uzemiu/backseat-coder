const { createApp, startServer } = require("./src/app");
const { createConfig } = require("./src/config");
const { createLogger } = require("./src/core/logger");
const { createAiService } = require("./src/services/ai");
const { createGitService } = require("./src/services/git");
const { createRepositoryService } = require("./src/services/repository");
const { createSessionStore } = require("./src/storage/sessions");

const config = createConfig();
const { log } = createLogger(config);

const repositoryService = createRepositoryService({ log });
const gitService = createGitService({ log });
const aiService = createAiService({ config, log });
const sessionStore = createSessionStore(config);

const { server } = createApp({
  aiService,
  config,
  gitService,
  log,
  repositoryService,
  sessionStore
});

startServer({ config, log, server });
