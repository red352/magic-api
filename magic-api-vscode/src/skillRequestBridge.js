"use strict";

const crypto = require("crypto");
const fs = require("fs");
const http = require("http");
const path = require("path");
const {
  buildRequestPlan,
  redactHeaders
} = require("../ai-skills/magic-api-workspace/scripts/magic-api-request");
const {
  BRIDGE_TOKEN_HEADER,
  BRIDGE_VERSION,
  removeBridgeDescriptor,
  writeBridgeDescriptor
} = require("../ai-skills/magic-api-workspace/scripts/request-bridge");
const { WorkspaceOperations } = require("./workspaceSync");

const MAX_BRIDGE_REQUEST_BYTES = 4 * 1024 * 1024;
const MAX_TARGET_BODY_BYTES = 2 * 1024 * 1024;
const MAX_TARGET_RESPONSE_BYTES = 2 * 1024 * 1024;
const FORBIDDEN_REQUEST_HEADERS = new Set([
  "connection", "content-length", "host", "magic-token", "transfer-encoding"
]);

class SkillRequestBridge {
  constructor(options) {
    this.client = options.client;
    this.output = options.output;
    this.resolveRoot = options.resolveRoot;
    this.server = undefined;
    this.root = undefined;
    this.bridgeToken = undefined;
    this.serverUrl = undefined;
    this.queue = Promise.resolve();
  }

  refresh() {
    const operation = () => this.refreshNow();
    this.queue = this.queue.then(operation, operation);
    return this.queue;
  }

  async refreshNow() {
    await this.stopNow();
    if (!this.client.hasWorkspace()) {
      return undefined;
    }
    const root = await this.resolveRoot();
    const manifestFile = path.join(root, ".magic-api", "manifest.json");
    try {
      const stat = await fs.promises.lstat(manifestFile);
      if (!stat.isFile() || stat.isSymbolicLink()) {
        return undefined;
      }
    } catch (error) {
      if (error && error.code === "ENOENT") {
        return undefined;
      }
      throw error;
    }
    await new WorkspaceOperations(root, { serverUrl: this.client.getServerUrl() }).readManifest();

    const bridgeToken = crypto.randomBytes(32).toString("hex");
    const server = http.createServer((request, response) => {
      this.handleRequest(request, response, bridgeToken).catch((error) => {
        this.output.appendLine(`[magic-api] AI Skill 请求桥接失败：${messageOf(error)}`);
        sendJson(response, statusForError(error), { ok: false, error: messageOf(error) });
      });
    });
    await new Promise((resolve, reject) => {
      server.once("error", reject);
      server.listen(0, "127.0.0.1", () => {
        server.removeListener("error", reject);
        resolve();
      });
    });
    server.unref();
    const address = server.address();
    const serverUrl = this.client.getServerUrl();
    const descriptor = {
      version: BRIDGE_VERSION,
      host: "127.0.0.1",
      port: address.port,
      bridgeToken,
      serverUrl,
      requestBaseUrl: this.client.getRequestBaseUrl(),
      pid: process.pid,
      createdAt: Date.now()
    };
    try {
      await writeBridgeDescriptor(root, descriptor);
    } catch (error) {
      await closeServer(server);
      throw error;
    }
    this.server = server;
    this.root = root;
    this.bridgeToken = bridgeToken;
    this.serverUrl = serverUrl;
    this.output.appendLine(`[magic-api] AI Skill 请求桥接已连接当前工作区：${descriptor.requestBaseUrl}`);
    return descriptor;
  }

  async handleRequest(request, response, bridgeToken) {
    if (!isLoopback(request.socket && request.socket.remoteAddress)) {
      throw httpError(403, "请求桥接只接受本机连接。");
    }
    if (request.method !== "POST" || request.url !== "/request") {
      throw httpError(404, "请求桥接路径不存在。");
    }
    if (!safeEqual(String(request.headers[BRIDGE_TOKEN_HEADER] || ""), bridgeToken)) {
      throw httpError(401, "请求桥接凭据无效。");
    }
    if (this.client.getServerUrl() !== this.serverUrl) {
      throw httpError(409, "插件服务地址已经变化，请等待请求桥接刷新。");
    }
    const payload = JSON.parse((await readRequestBody(request, MAX_BRIDGE_REQUEST_BYTES)).toString("utf8"));
    if (!payload || payload.version !== BRIDGE_VERSION) {
      throw httpError(400, "请求桥接协议版本无效。");
    }
    const plan = buildRequestPlan(this.client.getServerUrl(), {
      consolePath: payload.consolePath,
      url: payload.url,
      method: payload.method,
      noToken: Boolean(payload.noToken),
      timeoutMs: payload.timeoutMs
    }, { requestBaseUrl: this.client.getRequestBaseUrl() });
    const headers = validateHeaders(payload.headers);
    let body;
    if (payload.bodyBase64) {
      body = Buffer.from(String(payload.bodyBase64), "base64");
      if (body.length > MAX_TARGET_BODY_BYTES) {
        throw httpError(413, `请求正文超过 ${MAX_TARGET_BODY_BYTES} 字节限制。`);
      }
    }
    if (!plan.noToken && !await this.client.connectionStore.getToken()) {
      throw httpError(401, "当前工作区尚未登录或未配置 Magic-Token。");
    }
    const startedAt = Date.now();
    const targetResponse = await this.client.requestAbsolute(
      plan.method,
      plan.url.toString(),
      body,
      headers,
      !plan.noToken,
      false,
      { timeoutMs: plan.timeoutMs, maxResponseBytes: MAX_TARGET_RESPONSE_BYTES }
    );
    sendJson(response, 200, {
      ok: true,
      statusCode: targetResponse.statusCode,
      elapsedMs: Date.now() - startedAt,
      headers: redactHeaders(targetResponse.headers),
      body: targetResponse.text
    });
  }

  async stop() {
    const operation = () => this.stopNow();
    this.queue = this.queue.then(operation, operation);
    return this.queue;
  }

  async stopNow() {
    const server = this.server;
    const root = this.root;
    const bridgeToken = this.bridgeToken;
    this.server = undefined;
    this.root = undefined;
    this.bridgeToken = undefined;
    this.serverUrl = undefined;
    if (server) {
      await closeServer(server);
    }
    if (root && bridgeToken) {
      await removeBridgeDescriptor(root, bridgeToken);
    }
  }

  dispose() {
    this.stop().catch((error) => this.output.appendLine(`[magic-api] 关闭 AI Skill 请求桥接失败：${messageOf(error)}`));
  }
}

function validateHeaders(value) {
  if (value === undefined) {
    return {};
  }
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw httpError(400, "请求头必须是 JSON 对象。");
  }
  const result = {};
  for (const [name, rawValue] of Object.entries(value)) {
    const normalizedName = String(name || "").trim();
    const lowerName = normalizedName.toLowerCase();
    if (!normalizedName || /[\0\r\n:]/.test(normalizedName) || FORBIDDEN_REQUEST_HEADERS.has(lowerName)) {
      throw httpError(400, `禁止的请求头：${normalizedName || "<empty>"}`);
    }
    if (rawValue === undefined || rawValue === null || /[\0\r\n]/.test(String(rawValue))) {
      throw httpError(400, `非法请求头值：${normalizedName}`);
    }
    result[normalizedName] = String(rawValue);
  }
  return result;
}

function readRequestBody(request, limit) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    request.on("data", (chunk) => {
      size += chunk.length;
      if (size > limit) {
        reject(httpError(413, `桥接请求超过 ${limit} 字节限制。`));
        request.destroy();
        return;
      }
      chunks.push(chunk);
    });
    request.on("end", () => resolve(Buffer.concat(chunks)));
    request.on("error", reject);
  });
}

function isLoopback(address) {
  return ["127.0.0.1", "::1", "::ffff:127.0.0.1"].includes(String(address || ""));
}

function safeEqual(left, right) {
  const leftBuffer = Buffer.from(left);
  const rightBuffer = Buffer.from(right);
  return leftBuffer.length === rightBuffer.length && crypto.timingSafeEqual(leftBuffer, rightBuffer);
}

function sendJson(response, statusCode, value) {
  if (response.headersSent || response.destroyed) {
    return;
  }
  const body = Buffer.from(JSON.stringify(value), "utf8");
  response.writeHead(statusCode, {
    "content-type": "application/json;charset=utf-8",
    "content-length": body.length,
    "cache-control": "no-store"
  });
  response.end(body);
}

function closeServer(server) {
  return new Promise((resolve) => server.close(() => resolve()));
}

function httpError(statusCode, message) {
  const error = new Error(message);
  error.statusCode = statusCode;
  return error;
}

function statusForError(error) {
  return error && Number.isInteger(error.statusCode) ? error.statusCode : 500;
}

function messageOf(error) {
  return error && error.message ? error.message : String(error);
}

module.exports = {
  SkillRequestBridge,
  validateHeaders
};
