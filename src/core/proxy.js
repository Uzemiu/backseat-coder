function setupHttpProxy(proxyUrl, log) {
  if (!proxyUrl) {
    log("info", "proxy.disabled");
    return;
  }

  try {
    const { ProxyAgent, setGlobalDispatcher } = require("undici");
    setGlobalDispatcher(new ProxyAgent(proxyUrl));
    log("info", "proxy.enabled", { proxyUrl });
  } catch (error) {
    log("error", "proxy.setup_failed", {
      proxyUrl,
      error,
      hint: "Run npm install, or remove AI_PROXY_URL/HTTPS_PROXY if proxy is not needed."
    });
  }
}

module.exports = { setupHttpProxy };
