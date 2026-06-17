"use strict";

async function openApiRunnerPanel({ vscode, client, entity, defaultUrl, output, helpers }) {
  const panel = vscode.window.createWebviewPanel(
    "magicApiRunner",
    `magic-api: ${entity.name || entity.path || "Run API"}`,
    vscode.ViewColumn.Beside,
    { enableScripts: true, retainContextWhenHidden: true }
  );
  panel.webview.html = renderApiRunnerHtml(entity, defaultUrl, panel.webview.cspSource);
  panel.webview.onDidReceiveMessage(async (message) => {
    if (!message || message.command !== "send") {
      return;
    }
    try {
      const method = String(message.method || "GET").toUpperCase();
      const url = String(message.url || "").trim();
      if (!url) {
        throw new Error("请求 URL 不能为空。");
      }
      const headers = parseHeaders(message.headers);
      let body = message.body || undefined;
      if (body !== undefined && !String(body).trim()) {
        body = undefined;
      }
      output.appendLine(`[magic-api] ${method} ${url}`);
      const startedAt = Date.now();
      const response = await client.requestAbsolute(method, url, body, headers, true, false);
      const contentType = String(response.headers["content-type"] || "");
      const bodyText = helpers.prettifyResponseBody(response.text, contentType);
      panel.webview.postMessage({
        command: "response",
        ok: response.statusCode < 400,
        statusCode: response.statusCode,
        elapsed: Date.now() - startedAt,
        headers: JSON.stringify(response.headers, null, 2),
        body: bodyText
      });
    } catch (error) {
      output.appendLine(helpers.formatError(error));
      panel.webview.postMessage({
        command: "response",
        ok: false,
        statusCode: "ERR",
        elapsed: 0,
        headers: "",
        body: helpers.messageOf(error)
      });
    }
  });
}

function renderApiRunnerHtml(entity, defaultUrl, cspSource) {
  const method = String(entity.method || "GET").toUpperCase();
  const headers = headersToObject(entity.headers);
  const body = entity.requestBody || "";
  const nonce = createNonce();
  return `<!doctype html>
<html lang="zh-CN">
<head>
  <meta charset="UTF-8">
  <meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src ${cspSource} 'unsafe-inline'; script-src 'nonce-${nonce}';">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <style>
    body { font-family: var(--vscode-font-family); color: var(--vscode-foreground); background: var(--vscode-editor-background); padding: 14px; }
    .request-line { display: grid; grid-template-columns: 110px minmax(240px, 1fr) auto; gap: 8px; align-items: center; }
    select, input, textarea { box-sizing: border-box; width: 100%; background: var(--vscode-input-background); color: var(--vscode-input-foreground); border: 1px solid var(--vscode-input-border); padding: 6px 8px; font: inherit; }
    textarea { min-height: 140px; resize: vertical; font-family: var(--vscode-editor-font-family); }
    button { background: var(--vscode-button-background); color: var(--vscode-button-foreground); border: 0; padding: 7px 14px; cursor: pointer; }
    .grid { display: grid; grid-template-columns: minmax(280px, 420px) minmax(320px, 1fr); gap: 14px; margin-top: 14px; }
    label { display: grid; gap: 5px; margin-bottom: 10px; }
    label span, .status { color: var(--vscode-descriptionForeground); font-size: 12px; }
    pre { margin: 0; padding: 10px; overflow: auto; min-height: 180px; background: var(--vscode-textCodeBlock-background); white-space: pre-wrap; }
    @media (max-width: 800px) { .request-line, .grid { grid-template-columns: 1fr; } }
  </style>
</head>
<body>
  <div class="request-line">
    <select id="method">
      ${["GET", "POST", "PUT", "PATCH", "DELETE", "HEAD", "OPTIONS"].map((item) => `<option value="${item}" ${item === method ? "selected" : ""}>${item}</option>`).join("")}
    </select>
    <input id="url" value="${htmlEscape(defaultUrl)}">
    <button id="send">发送</button>
  </div>
  <div class="grid">
    <section>
      <label><span>Headers JSON</span><textarea id="headers">${htmlEscape(JSON.stringify(headers, null, 2))}</textarea></label>
      <label><span>Body</span><textarea id="body">${htmlEscape(body)}</textarea></label>
    </section>
    <section>
      <div class="status" id="status">未发送</div>
      <label><span>响应头</span><pre id="responseHeaders"></pre></label>
      <label><span>响应体</span><pre id="responseBody"></pre></label>
    </section>
  </div>
  <script nonce="${nonce}">
    const vscode = acquireVsCodeApi();
    document.getElementById("send").addEventListener("click", () => {
      document.getElementById("status").textContent = "请求中...";
      vscode.postMessage({
        command: "send",
        method: document.getElementById("method").value,
        url: document.getElementById("url").value,
        headers: document.getElementById("headers").value,
        body: document.getElementById("body").value
      });
    });
    window.addEventListener("message", (event) => {
      const message = event.data || {};
      if (message.command !== "response") return;
      document.getElementById("status").textContent = "HTTP " + message.statusCode + " · " + message.elapsed + "ms";
      document.getElementById("responseHeaders").textContent = message.headers || "";
      document.getElementById("responseBody").textContent = message.body || "";
    });
  </script>
</body>
</html>`;
}

function parseHeaders(text) {
  if (!String(text || "").trim()) {
    return {};
  }
  const parsed = JSON.parse(text);
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error("Headers 必须是 JSON 对象。");
  }
  return parsed;
}

function headersToObject(headers) {
  const result = {};
  (headers || []).forEach((header) => {
    if (header && header.name) {
      result[header.name] = header.value === undefined || header.value === null ? "" : String(header.value);
    }
  });
  return result;
}

function htmlEscape(value) {
  return String(value === undefined || value === null ? "" : value)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function createNonce() {
  const chars = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789";
  let text = "";
  for (let index = 0; index < 32; index++) {
    text += chars.charAt(Math.floor(Math.random() * chars.length));
  }
  return text;
}

module.exports = {
  openApiRunnerPanel
};
