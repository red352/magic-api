"use strict";

function renderMetadataEditorHtml(entry, entity, cspSource) {
  const metadata = cloneWithoutScript(entity);
  const fields = metadataEditorFields(metadata);
  const nonce = createNonce();
  const fieldHtml = fields.map((field) => {
    const value = metadata[field] === undefined || metadata[field] === null ? "" : String(metadata[field]);
    const input = field === "description" || value.length > 80
      ? `<textarea data-field="${htmlEscape(field)}" rows="3">${htmlEscape(value)}</textarea>`
      : `<input data-field="${htmlEscape(field)}" value="${htmlEscape(value)}">`;
    return `<label><span>${htmlEscape(field)}</span>${input}</label>`;
  }).join("");
  return `<!doctype html>
<html lang="zh-CN">
<head>
  <meta charset="UTF-8">
  <meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src ${cspSource} 'unsafe-inline'; script-src 'nonce-${nonce}';">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <style>
    body { font-family: var(--vscode-font-family); color: var(--vscode-foreground); background: var(--vscode-editor-background); padding: 16px; }
    header { display: flex; align-items: center; justify-content: space-between; gap: 12px; margin-bottom: 16px; }
    h1 { font-size: 16px; font-weight: 600; margin: 0; }
    .actions { display: flex; gap: 8px; }
    button { background: var(--vscode-button-background); color: var(--vscode-button-foreground); border: 0; padding: 6px 12px; cursor: pointer; }
    button.secondary { background: var(--vscode-button-secondaryBackground); color: var(--vscode-button-secondaryForeground); }
    main { display: grid; grid-template-columns: minmax(260px, 420px) minmax(320px, 1fr); gap: 16px; }
    label { display: grid; gap: 4px; margin-bottom: 10px; }
    label span { color: var(--vscode-descriptionForeground); font-size: 12px; }
    input, textarea { box-sizing: border-box; width: 100%; background: var(--vscode-input-background); color: var(--vscode-input-foreground); border: 1px solid var(--vscode-input-border); padding: 6px 8px; font-family: var(--vscode-font-family); }
    textarea { resize: vertical; font-family: var(--vscode-editor-font-family); }
    #rawJson { min-height: 520px; }
    @media (max-width: 760px) { main { grid-template-columns: 1fr; } }
  </style>
</head>
<body>
  <header>
    <h1>${htmlEscape(entry.name || entry.id || "magic-api 资源")}</h1>
    <div class="actions">
      <button class="secondary" id="saveLocal">保存本地</button>
      <button id="savePush">保存并推送</button>
    </div>
  </header>
  <main>
    <section>${fieldHtml || "<p>没有可视化字段。</p>"}</section>
    <section>
      <label>
        <span>高级元数据 JSON</span>
        <textarea id="rawJson">${htmlEscape(JSON.stringify(metadata, null, 2))}</textarea>
      </label>
    </section>
  </main>
  <script nonce="${nonce}">
    const vscode = acquireVsCodeApi();
    function collect(command) {
      const fields = {};
      document.querySelectorAll("[data-field]").forEach((item) => {
        fields[item.getAttribute("data-field")] = item.value;
      });
      vscode.postMessage({ command, fields, rawJson: document.getElementById("rawJson").value });
    }
    document.getElementById("saveLocal").addEventListener("click", () => collect("saveLocal"));
    document.getElementById("savePush").addEventListener("click", () => collect("savePush"));
  </script>
</body>
</html>`;
}

function metadataEditorPayloadToEntity(original, message) {
  const raw = parseJson(message.rawJson);
  if (!raw || typeof raw !== "object") {
    throw new Error("高级元数据 JSON 格式不正确。");
  }
  const entity = Object.assign({}, raw);
  Object.keys(message.fields || {}).forEach((field) => {
    entity[field] = coerceMetadataValue(raw[field], message.fields[field]);
  });
  if (Object.prototype.hasOwnProperty.call(original, "script")) {
    entity.script = original.script || "";
  }
  return entity;
}

function metadataEditorFields(metadata) {
  const preferred = ["name", "path", "method", "description", "key", "url", "cron", "groupId", "lock"];
  const fields = [];
  preferred.forEach((field) => {
    if (Object.prototype.hasOwnProperty.call(metadata, field) && isScalar(metadata[field])) {
      fields.push(field);
    }
  });
  Object.keys(metadata).sort().forEach((field) => {
    if (!fields.includes(field) && !["id", "script", "properties", "createTime", "updateTime", "createBy", "updateBy"].includes(field) && isScalar(metadata[field])) {
      fields.push(field);
    }
  });
  return fields;
}

function coerceMetadataValue(previous, value) {
  if (typeof previous === "number") {
    const number = Number(value);
    return Number.isFinite(number) ? number : previous;
  }
  if (typeof previous === "boolean") {
    return value === true || value === "true";
  }
  return value;
}

function cloneWithoutScript(entity) {
  const metadata = Object.assign({}, entity || {});
  delete metadata.script;
  return metadata;
}

function isScalar(value) {
  return value === null || ["string", "number", "boolean"].includes(typeof value);
}

function parseJson(text) {
  try {
    return JSON.parse(text);
  } catch (error) {
    return undefined;
  }
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
  renderMetadataEditorHtml,
  metadataEditorPayloadToEntity
};
