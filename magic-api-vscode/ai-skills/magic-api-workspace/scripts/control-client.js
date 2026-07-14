"use strict";

const http = require("http");
const {
  BRIDGE_TOKEN_HEADER,
  BRIDGE_VERSION,
  readBridgeDescriptor
} = require("./request-bridge");

const MAX_CONTROL_RESPONSE_BYTES = 8 * 1024 * 1024;

async function callControl(root, operation, args = {}, options = {}) {
  const bridge = await readBridgeDescriptor(root);
  if (!bridge) {
    const error = new Error(
      "当前工作区没有可用的插件控制桥；请保持 VS Code 扩展运行。若沙箱隔离了扩展临时目录，请按 Skill 规则申请宿主机执行。"
    );
    error.code = "vscode-workspace-unavailable";
    throw error;
  }
  const payload = Buffer.from(JSON.stringify({
    version: BRIDGE_VERSION,
    operation,
    args,
    apply: Boolean(options.apply),
    planId: options.planId
  }), "utf8");
  const response = await requestJson(new URL(`http://${bridge.host}:${bridge.port}/control`), payload, {
    "content-type": "application/json;charset=utf-8",
    "content-length": String(payload.length),
    [BRIDGE_TOKEN_HEADER]: bridge.bridgeToken
  });
  if (response.statusCode >= 400 || !response.value || response.value.ok !== true) {
    const error = new Error(response.value && response.value.error
      ? response.value.error
      : `插件控制桥失败：HTTP ${response.statusCode}`);
    error.code = response.value && response.value.code;
    error.details = response.value && response.value.details;
    throw error;
  }
  return response.value.result;
}

function requestJson(url, body, headers) {
  return new Promise((resolve, reject) => {
    const request = http.request(url, { method: "POST", headers }, (response) => {
      const chunks = [];
      let size = 0;
      response.on("data", (chunk) => {
        size += chunk.length;
        if (size > MAX_CONTROL_RESPONSE_BYTES) {
          request.destroy(new Error(`控制桥响应超过 ${MAX_CONTROL_RESPONSE_BYTES} 字节限制。`));
          return;
        }
        chunks.push(chunk);
      });
      response.on("end", () => {
        let value;
        try {
          value = JSON.parse(Buffer.concat(chunks).toString("utf8"));
        } catch (_error) {
          reject(new Error(`插件控制桥返回无效 JSON（HTTP ${response.statusCode}）。`));
          return;
        }
        resolve({ statusCode: response.statusCode || 0, value });
      });
    });
    request.setTimeout(122000, () => request.destroy(new Error("插件控制桥请求超时。")));
    request.on("error", reject);
    request.end(body);
  });
}

module.exports = {
  callControl
};
