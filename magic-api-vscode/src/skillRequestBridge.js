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
const { findCommand } = require("../ai-skills/magic-api-workspace/scripts/command-schema");

const MAX_BRIDGE_REQUEST_BYTES = 4 * 1024 * 1024;
const MAX_TARGET_BODY_BYTES = 2 * 1024 * 1024;
const MAX_TARGET_RESPONSE_BYTES = 2 * 1024 * 1024;
const CONTROL_PLAN_TTL_MS = 5 * 60 * 1000;
const FORBIDDEN_REQUEST_HEADERS = new Set([
  "connection", "content-length", "host", "magic-token", "transfer-encoding"
]);

class SkillRequestBridge {
  constructor(options) {
    this.client = options.client;
    this.output = options.output;
    this.resolveRoot = options.resolveRoot;
    this.workspaceMirror = options.workspaceMirror;
    this.vscode = options.vscode;
    this.promptLogin = options.promptLogin;
    this.promptSetToken = options.promptSetToken;
    this.skillManager = options.skillManager;
    this.server = undefined;
    this.root = undefined;
    this.bridgeToken = undefined;
    this.serverUrl = undefined;
    this.queue = Promise.resolve();
    this.controlPlans = new Map();
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

    const bridgeToken = crypto.randomBytes(32).toString("hex");
    const server = http.createServer((request, response) => {
      this.handleRequest(request, response, bridgeToken).catch((error) => {
        this.output.appendLine(`[magic-api] AI Skill 请求桥接失败：${messageOf(error)}`);
        sendJson(response, statusForError(error), {
          ok: false,
          error: messageOf(error),
          code: error && error.code,
          details: error && error.details
        });
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
      createdAt: Date.now(),
      capabilities: ["request-v1", "control-v1"]
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
    if (request.method !== "POST" || !["/request", "/control"].includes(request.url)) {
      throw httpError(404, "请求桥接路径不存在。");
    }
    if (!safeEqual(String(request.headers[BRIDGE_TOKEN_HEADER] || ""), bridgeToken)) {
      throw httpError(401, "请求桥接凭据无效。");
    }
    if (this.client.getServerUrl() !== this.serverUrl) {
      throw httpError(409, "插件服务地址已经变化，请等待请求桥接刷新。");
    }
    if (request.url === "/control") {
      await this.handleControl(request, response);
      return;
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

  async handleControl(request, response) {
    const payload = JSON.parse((await readRequestBody(request, MAX_BRIDGE_REQUEST_BYTES)).toString("utf8"));
    if (!payload || payload.version !== BRIDGE_VERSION || typeof payload.operation !== "string") {
      throw httpError(400, "插件控制桥协议无效。");
    }
    const definition = findCommand(...payload.operation.split("."));
    if (!definition || definition.transport === "local" || definition.name === "request.preview") {
      throw httpError(403, `控制桥不允许操作：${payload.operation}`);
    }
    const root = await this.resolveRoot();
    if (path.resolve(root) !== path.resolve(this.root)) {
      throw httpError(409, "工作区镜像目录已经变化，请等待控制桥刷新。 ");
    }
    const args = validateControlArgs(payload.args);
    assertControlArgumentKeys(definition, args);
    if (payload.operation === "request.send") {
      this.validateRequestControl(args);
    }
    if (definition.risk === "read") {
      const result = await this.executeControl(payload.operation, args, root);
      sendJson(response, 200, { ok: true, result });
      return;
    }
    const digest = await this.computeControlDigest(payload.operation, root);
    if (!payload.apply) {
      const planId = `plan:${crypto.randomBytes(24).toString("hex")}`;
      const expiresAt = Date.now() + CONTROL_PLAN_TTL_MS;
      this.controlPlans.set(planId, {
        operation: payload.operation,
        args,
        root: path.resolve(root),
        serverUrl: this.client.getServerUrl(),
        digest,
        expiresAt
      });
      this.pruneControlPlans();
      const effects = await this.describeControlEffects(payload.operation, args, root);
      sendJson(response, 200, {
        ok: true,
        result: {
          operation: payload.operation,
          applied: false,
          planId,
          risk: definition.risk,
          expiresAt,
          root,
          serverUrl: this.client.getServerUrl(),
          arguments: publicControlArgs(args),
          effects,
          next: `使用 --apply --plan-id ${planId} 执行此计划。`
        }
      });
      return;
    }
    const plan = this.controlPlans.get(String(payload.planId || ""));
    this.controlPlans.delete(String(payload.planId || ""));
    if (!plan || plan.expiresAt < Date.now()) {
      throw httpError(409, "控制计划不存在或已经过期，请重新预览。", "plan-expired");
    }
    if (plan.operation !== payload.operation || stableStringify(plan.args) !== stableStringify(args) ||
        plan.root !== path.resolve(root) || plan.serverUrl !== this.client.getServerUrl() || plan.digest !== digest) {
      throw httpError(409, "控制计划与当前工作区状态不匹配，请重新预览。", "plan-mismatch");
    }
    const result = await this.executeControl(payload.operation, args, root);
    sendJson(response, 200, {
      ok: true,
      result: {
        operation: payload.operation,
        applied: true,
        planId: payload.planId,
        result
      }
    });
  }

  async executeControl(operation, args, root) {
    const store = this.client.connectionStore;
    if (operation === "connection.show") {
      return {
        serverUrl: this.client.getServerUrl(),
        workspaceDir: store.getWorkspaceDir(),
        syncOnSave: store.getBehaviorSetting("syncOnSave", true),
        autoPullOnOpen: store.getBehaviorSetting("autoPullOnOpen", true),
        checkConflicts: store.getBehaviorSetting("checkConflicts", true)
      };
    }
    if (operation === "connection.set") {
      const changed = {};
      if (args.serverUrl !== undefined) {
        changed.serverUrl = await store.setServerUrl(args.serverUrl);
      }
      if (args.workspaceDir !== undefined) {
        changed.workspaceDir = await store.setWorkspaceDir(args.workspaceDir);
      }
      for (const key of ["syncOnSave", "autoPullOnOpen", "checkConflicts"]) {
        if (args[key] !== undefined) {
          changed[key] = await store.setBehaviorSetting(key, args[key]);
        }
      }
      if (!Object.keys(changed).length) {
        throw httpError(400, "connection set 至少需要一个配置参数。");
      }
      return changed;
    }
    if (operation === "auth.status") {
      return {
        username: await this.client.getUsername(),
        authenticated: Boolean(await store.getToken())
      };
    }
    if (operation === "auth.login") {
      if (typeof this.promptLogin !== "function") {
        throw httpError(503, "当前扩展未提供交互式登录入口。");
      }
      await this.promptLogin();
      return { authenticated: Boolean(await store.getToken()) };
    }
    if (operation === "auth.set-token") {
      if (typeof this.promptSetToken !== "function") {
        throw httpError(503, "当前扩展未提供 Token 安全输入入口。");
      }
      await this.promptSetToken();
      return { authenticated: Boolean(await store.getToken()) };
    }
    if (operation === "auth.clear") {
      await this.client.clearToken();
      return { authenticated: false };
    }
    if (operation === "workspace.pull") {
      return this.workspaceMirror.pullAll({ full: args.mode === "full", force: true, source: "cli" });
    }
    if (operation === "workspace.push") {
      if (args.file) {
        const absolute = safeWorkspaceFile(root, args.file);
        return this.workspaceMirror.pushUri(this.vscode.Uri.file(absolute), { autoApprove: true, source: "cli" });
      }
      return this.workspaceMirror.pushChanged({ autoApprove: true, source: "cli" });
    }
    if (operation === "workspace.reconcile") {
      return this.workspaceMirror.reconcileAutomatically();
    }
    if (operation === "workspace.recover") {
      return this.workspaceMirror.recoverAutomatically();
    }
    if (operation === "resource.tree") {
      return this.client.getResources();
    }
    if (operation === "request.send") {
      const plan = buildRequestPlan(this.client.getServerUrl(), {
        consolePath: args.consolePath,
        url: args.url,
        method: args.method,
        noToken: Boolean(args.noToken),
        timeoutMs: args.timeoutMs
      }, { requestBaseUrl: this.client.getRequestBaseUrl() });
      const headers = validateHeaders(args.headers);
      const body = args.bodyBase64 ? Buffer.from(String(args.bodyBase64), "base64") : undefined;
      if (body && body.length > MAX_TARGET_BODY_BYTES) {
        throw httpError(413, `请求正文超过 ${MAX_TARGET_BODY_BYTES} 字节限制。`);
      }
      if (!plan.noToken && !await store.getToken()) {
        throw httpError(401, "当前工作区尚未登录或未配置 Magic-Token。");
      }
      const startedAt = Date.now();
      const response = await this.client.requestAbsolute(
        plan.method,
        plan.url.toString(),
        body,
        headers,
        !plan.noToken,
        false,
        { timeoutMs: plan.timeoutMs, maxResponseBytes: MAX_TARGET_RESPONSE_BYTES }
      );
      return {
        sent: true,
        kind: plan.kind,
        method: plan.method,
        url: plan.url.toString(),
        statusCode: response.statusCode,
        elapsedMs: Date.now() - startedAt,
        headers: redactHeaders(response.headers),
        body: response.text
      };
    }
    if (operation.startsWith("skill.")) {
      if (!this.skillManager) {
        throw httpError(503, "AI Skill 管理器尚未初始化。");
      }
      if (operation === "skill.status") {
        return this.skillManager.status();
      }
      if (operation === "skill.install") {
        return this.skillManager.install({ force: false, interactive: false });
      }
      return this.skillManager.update({ force: Boolean(args.force), interactive: false });
    }
    throw httpError(400, `未实现的控制操作：${operation}`);
  }

  async computeControlDigest(operation, root) {
    const values = {
      root: await computeRootDigest(root),
      serverUrl: this.client.getServerUrl()
    };
    if (operation.startsWith("connection.") || operation.startsWith("auth.")) {
      const store = this.client.connectionStore;
      const token = await store.getToken();
      values.connection = {
        workspaceDir: store.getWorkspaceDir(),
        syncOnSave: store.getBehaviorSetting("syncOnSave", true),
        autoPullOnOpen: store.getBehaviorSetting("autoPullOnOpen", true),
        checkConflicts: store.getBehaviorSetting("checkConflicts", true),
        username: await this.client.getUsername(),
        tokenHash: token ? crypto.createHash("sha256").update(token).digest("hex") : null
      };
    }
    if (operation.startsWith("skill.") && this.skillManager) {
      values.skills = await this.skillManager.status();
    }
    return crypto.createHash("sha256").update(stableStringify(values)).digest("hex");
  }

  async describeControlEffects(operation, args, root) {
    if (["workspace.push", "workspace.reconcile", "workspace.recover"].includes(operation)) {
      try {
        const status = await new WorkspaceOperations(root, {
          serverUrl: this.client.getServerUrl()
        }).status();
        return {
          changes: status.changes,
          pending: status.pending,
          file: args.file || null
        };
      } catch (error) {
        return { unavailable: messageOf(error) };
      }
    }
    if (operation === "workspace.pull") {
      return { localOverwritePossible: true, mode: args.mode || "incremental" };
    }
    if (operation === "connection.set") {
      return { settings: publicControlArgs(args) };
    }
    if (operation.startsWith("auth.")) {
      return { authentication: operation.slice("auth.".length) };
    }
    if (operation === "request.send") {
      const plan = buildRequestPlan(this.client.getServerUrl(), {
        consolePath: args.consolePath,
        url: args.url,
        method: args.method,
        noToken: Boolean(args.noToken),
        timeoutMs: args.timeoutMs
      }, { requestBaseUrl: this.client.getRequestBaseUrl() });
      return {
        kind: plan.kind,
        method: plan.method,
        url: plan.url.toString(),
        headerNames: Object.keys(args.headers || {}).sort(),
        bodyBytes: args.bodyBase64 ? Buffer.from(args.bodyBase64, "base64").length : 0
      };
    }
    if (operation.startsWith("skill.") && this.skillManager) {
      return this.skillManager.status();
    }
    return {};
  }

  validateRequestControl(args) {
    buildRequestPlan(this.client.getServerUrl(), {
      consolePath: args.consolePath,
      url: args.url,
      method: args.method,
      noToken: Boolean(args.noToken),
      timeoutMs: args.timeoutMs
    }, { requestBaseUrl: this.client.getRequestBaseUrl() });
    validateHeaders(args.headers);
    if (args.bodyBase64) {
      const body = Buffer.from(String(args.bodyBase64), "base64");
      if (body.length > MAX_TARGET_BODY_BYTES) {
        throw httpError(413, `请求正文超过 ${MAX_TARGET_BODY_BYTES} 字节限制。`);
      }
    }
  }

  pruneControlPlans() {
    const now = Date.now();
    for (const [planId, plan] of this.controlPlans) {
      if (plan.expiresAt < now) {
        this.controlPlans.delete(planId);
      }
    }
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
    this.controlPlans.clear();
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

function validateControlArgs(value) {
  if (value === undefined) {
    return {};
  }
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw httpError(400, "控制桥参数必须是 JSON 对象。");
  }
  const encoded = JSON.stringify(value);
  if (Buffer.byteLength(encoded) > 256 * 1024) {
    throw httpError(413, "控制桥参数过大。");
  }
  return JSON.parse(encoded);
}

function assertControlArgumentKeys(definition, args) {
  const allowed = new Set(definition.options || []);
  if (definition.name === "request.send") {
    ["direct", "tokenEnv", "tokenStdin"].forEach((key) => allowed.delete(key));
    ["headersFile", "bodyFile"].forEach((key) => allowed.delete(key));
    ["headers", "bodyBase64"].forEach((key) => allowed.add(key));
  }
  const unknown = Object.keys(args).filter((key) => !allowed.has(key));
  if (unknown.length) {
    throw httpError(400, `控制操作 ${definition.name} 不支持参数：${unknown.join("、")}`);
  }
}

function publicControlArgs(args) {
  const result = {};
  for (const [key, value] of Object.entries(args || {})) {
    if (/password|token|secret/i.test(key)) {
      continue;
    }
    if (key === "bodyBase64") {
      result.bodyBytes = value ? Buffer.from(String(value), "base64").length : 0;
    } else if (key === "headers") {
      result.headerNames = Object.keys(value || {}).sort();
    } else {
      result[key] = value;
    }
  }
  return result;
}

async function computeRootDigest(root) {
  const hash = crypto.createHash("sha256");
  async function walk(directory, relativeDirectory) {
    let entries;
    try {
      entries = await fs.promises.readdir(directory, { withFileTypes: true });
    } catch (error) {
      if (error && error.code === "ENOENT" && !relativeDirectory) {
        hash.update("<missing-root>");
        return;
      }
      throw error;
    }
    entries.sort((left, right) => left.name.localeCompare(right.name));
    for (const entry of entries) {
      const relative = relativeDirectory ? `${relativeDirectory}/${entry.name}` : entry.name;
      const full = path.join(directory, entry.name);
      const stat = await fs.promises.lstat(full);
      if (stat.isSymbolicLink()) {
        throw httpError(409, `工作区路径不允许符号链接：${relative}`, "unsafe-workspace");
      }
      if (stat.isDirectory()) {
        await walk(full, relative);
      } else if (stat.isFile()) {
        hash.update(`${relative}\0${stat.size}\0`);
        hash.update(await fs.promises.readFile(full));
      }
    }
  }
  await walk(path.resolve(root), "");
  return hash.digest("hex");
}

function safeWorkspaceFile(root, file) {
  const absoluteRoot = path.resolve(root);
  const absolute = path.isAbsolute(file) ? path.resolve(file) : path.resolve(absoluteRoot, file);
  const relative = path.relative(absoluteRoot, absolute);
  if (!relative || relative.startsWith("..") || path.isAbsolute(relative)) {
    throw httpError(400, `--file 必须指向镜像内文件：${file}`);
  }
  return absolute;
}

function stableStringify(value) {
  if (Array.isArray(value)) {
    return `[${value.map(stableStringify).join(",")}]`;
  }
  if (value && typeof value === "object") {
    return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${stableStringify(value[key])}`).join(",")}}`;
  }
  return JSON.stringify(value);
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

function httpError(statusCode, message, code, details) {
  const error = new Error(message);
  error.statusCode = statusCode;
  error.code = code;
  error.details = details;
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
