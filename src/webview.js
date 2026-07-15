const vscode = require("vscode");
const path = require("node:path");
const fs = require("node:fs");
const { createHandlers } = require("./app");

function createSidebarProvider(context, deps) {
  let _view = null;

  function postMessage(msg) {
    if (_view) {
      _view.webview.postMessage(msg);
    }
  }

  function resolveWebviewView(webviewView, _resolveContext, _token) {
    _view = webviewView;

    webviewView.webview.options = {
      enableScripts: true,
      retainContextWhenHidden: true,
      localResourceRoots: [vscode.Uri.file(path.join(context.extensionPath, "public"))]
    };

    webviewView.webview.html = getWebviewHtml(webviewView.webview, context.extensionPath);

    webviewView.webview.onDidReceiveMessage(async (msg) => {
      if (msg.command === "setContext") {
        if (typeof deps.onContext === "function") {
          deps.onContext(msg.payload);
        }
        return;
      }

      if (msg.command === "ready") {
        if (deps.workspacePath) {
          webviewView.webview.postMessage({ type: "init", workspacePath: deps.workspacePath });
        }
        return;
      }

      // API call: has numeric id
      const { id, command, payload } = msg;
      try {
        const handler = deps.handlers[command];
        if (typeof handler !== "function") {
          throw new Error(`未知命令 "${command}"。扩展可能加载的是旧代码，请执行 Developer: Reload Window 后重试。`);
        }
        const result = await handler(payload);
        webviewView.webview.postMessage({ id, result });
      } catch (error) {
        webviewView.webview.postMessage({
          id,
          error: { message: error.message || String(error) }
        });
      }
    });

    webviewView.onDidDispose(() => {
      _view = null;
    });
  }

  return { resolveWebviewView, postMessage };
}

function getWebviewHtml(webview, extensionPath) {
  const publicDir = path.join(extensionPath, "public");

  const appJsUri = webview.asWebviewUri(
    vscode.Uri.file(path.join(publicDir, "app.js"))
  );
  const cssUri = webview.asWebviewUri(
    vscode.Uri.file(path.join(publicDir, "styles.css"))
  );

  const htmlPath = path.join(publicDir, "index.html");
  let html = fs.readFileSync(htmlPath, "utf8");

  html = html
    .replace('href="/styles.css"', `href="${cssUri}"`)
    .replace('src="/app.js"', `src="${appJsUri}"`);

  return html;
}

module.exports = { createSidebarProvider };
