#!/usr/bin/env node
"use strict";

const fs = require("fs");
const http = require("http");
const https = require("https");
const path = require("path");
const {
  BRIDGE_TOKEN_HEADER,
  BRIDGE_VERSION,
  readBridgeDescriptor
} = require("./request-bridge");
const { WorkspaceOperations } = require("./workspace-operations");

const DEFAULT_TOKEN_ENV = "MAGIC_API_TOKEN";
const DEFAULT_TIMEOUT_MS = 30000;
const MAX_TIMEOUT_MS = 120000;
const MAX_REQUEST_BYTES = 2 * 1024 * 1024;
const MAX_RESPONSE_BYTES = 2 * 1024 * 1024;
const MAX_BRIDGE_RESPONSE_BYTES = 6 * 1024 * 1024;
const METHODS = new Set(["GET", "POST", "PUT", "PATCH", "DELETE", "HEAD", "OPTIONS"]);
const FORBIDDEN_REQUEST_HEADERS = new Set([
  "connection", "content-length", "host", "magic-token", "transfer-encoding"
]);
const REDACTED_HEADERS = new Set([
  "authorization", "cookie", "magic-token", "proxy-authorization", "set-cookie"
]);

if (require.main === module) {
  main().catch((error) => {
    process.stderr.write(`${JSON.stringify({ ok: false, error: error.message }, null, 2)}\n`);
    process.exitCode = 1;
  });
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) {
    printHelp();
    return;
  }
  const root = path.resolve(required(args, "root"));
  const manifest = await new WorkspaceOperations(root).readManifest();
  const bridge = await readCurrentBridge(root, manifest.serverUrl);
  if (!args.direct && (args.tokenEnv || args.tokenStdin)) {
    throw new Error("插件桥接模式会自动读取当前工作区 SecretStorage，不能使用 --token-env 或 --token-stdin。");
  }
  const plan = buildRequestPlan(manifest.serverUrl, args, {
    requestBaseUrl: bridge && bridge.requestBaseUrl
  });
  const headers = await readHeaders(args.headersFile);
  const body = await readBody(args.bodyFile);
  if (!args.send) {
    process.stdout.write(`${JSON.stringify(publicPlan(plan, headers, body, bridge, args), null, 2)}\n`);
    return;
  }

  const startedAt = Date.now();
  let response;
  if (args.direct) {
    let token;
    if (!args.noToken) {
      token = await readToken(args);
      if (!token) {
        const tokenEnv = args.tokenEnv || DEFAULT_TOKEN_ENV;
        throw new Error(`缺少控制台 Token：请预先设置 ${tokenEnv}，或使用 --token-stdin。`);
      }
      // 无 VS Code 扩展的显式 direct 模式仍固定使用 lowercase magic-token。
      headers["magic-token"] = token;
    }
    if (body) {
      headers["content-length"] = String(body.length);
    }
    response = await requestText(plan.url, plan.method, body, headers, plan.timeoutMs);
  } else {
    response = await requestThroughPlugin(root, manifest.serverUrl, bridge, args, plan, headers, body);
  }
  const result = {
    ok: response.statusCode < 400,
    operation: "request",
    sent: true,
    kind: plan.kind,
    method: plan.method,
    url: plan.url.toString(),
    statusCode: response.statusCode,
    elapsedMs: Date.now() - startedAt,
    headers: redactHeaders(response.headers),
    body: formatBody(response.body, response.headers["content-type"])
  };
  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
  if (!result.ok) {
    process.exitCode = 3;
  }
}

function buildRequestPlan(serverUrlValue, args, options = {}) {
  const serverUrl = new URL(String(serverUrlValue || ""));
  if (!["http:", "https:"].includes(serverUrl.protocol)) {
    throw new Error(`不支持的工作区服务协议：${serverUrl.protocol}`);
  }
  if (serverUrl.username || serverUrl.password || serverUrl.hash) {
    throw new Error("工作区服务地址不能包含用户名、密码或 fragment。");
  }
  const hasConsolePath = args.consolePath !== undefined;
  const hasUrl = args.url !== undefined;
  if (hasConsolePath === hasUrl) {
    throw new Error("必须且只能指定 --console-path 或 --url。");
  }
  const method = String(args.method || "GET").toUpperCase();
  if (!METHODS.has(method)) {
    throw new Error(`不支持的 HTTP method：${method}`);
  }
  const timeoutMs = parseTimeout(args.timeoutMs);
  let url;
  let kind;
  if (hasConsolePath) {
    const consolePath = normalizeConsolePath(args.consolePath);
    assertAllowedConsoleRequest(method, consolePath.pathname);
    url = new URL(serverUrl.origin);
    url.pathname = joinUrlPath(serverUrl.pathname, consolePath.pathname);
    url.search = consolePath.search;
    kind = "console";
    if (args.noToken) {
      throw new Error("控制台查询必须携带 magic-token，不能使用 --no-token。");
    }
  } else {
    url = resolveApiUrl(serverUrl, args.url, options.requestBaseUrl);
    if (isConsoleUrl(serverUrl, url)) {
      throw new Error("控制台地址只能通过 --console-path 的只读白名单访问。");
    }
    kind = "api";
  }
  if (url.username || url.password || url.hash) {
    throw new Error("请求 URL 不能包含用户名、密码或 fragment。");
  }
  return { kind, method, timeoutMs, url, bodyFile: args.bodyFile, noToken: Boolean(args.noToken) };
}

function publicPlan(plan, headers, body, bridge, args) {
  return {
    ok: true,
    operation: "request",
    sent: false,
    kind: plan.kind,
    method: plan.method,
    url: plan.url.toString(),
    timeoutMs: plan.timeoutMs,
    connection: args.direct ? "direct" : (bridge ? "vscode-workspace" : "vscode-workspace-unavailable"),
    requestBaseUrl: bridge ? bridge.requestBaseUrl : new URL(plan.url).origin,
    authentication: plan.noToken
      ? "none"
      : (args.direct ? "direct-magic-token" : "vscode-secret-storage:magic-token"),
    headerNames: Object.keys(headers).sort(),
    bodyFile: plan.bodyFile ? path.resolve(plan.bodyFile) : null,
    bodyBytes: body ? body.length : 0,
    next: "核对请求后追加 --send；非幂等业务请求必须先获得用户明确授权。"
  };
}

function normalizeConsolePath(value) {
  const text = String(value || "").trim();
  if (!text.startsWith("/") || text.startsWith("//")) {
    throw new Error("--console-path 必须是以单个 / 开头的控制台相对路径。");
  }
  const rawPath = text.split(/[?#]/, 1)[0];
  const segments = rawPath.split("/").filter(Boolean);
  for (const segment of segments) {
    let decoded;
    try {
      decoded = decodeURIComponent(segment);
    } catch (_error) {
      throw new Error(`控制台路径包含非法编码：${value}`);
    }
    if (decoded === "." || decoded === ".." || /[\0\r\n]/.test(decoded)) {
      throw new Error(`控制台路径包含非法分段：${value}`);
    }
  }
  const parsed = new URL(text, "http://magic-api.invalid");
  return { pathname: parsed.pathname, search: parsed.search };
}

function assertAllowedConsoleRequest(method, pathname) {
  const allowed = (
    (method === "GET" && ["/config.json", "/classes.txt", "/plugins", "/options"].includes(pathname)) ||
    (method === "POST" && ["/resource", "/classes", "/class", "/user"].includes(pathname)) ||
    (method === "GET" && /^\/resource\/file\/[^/]+$/.test(pathname))
  );
  if (!allowed) {
    throw new Error(`控制台接口不在只读白名单中：${method} ${pathname}`);
  }
}

function resolveApiUrl(serverUrl, value, requestBaseUrlValue) {
  const text = String(value || "").trim();
  if (!text) {
    throw new Error("--url 不能为空。");
  }
  let url;
  try {
    const requestBaseUrl = new URL(String(requestBaseUrlValue || serverUrl.origin));
    if (requestBaseUrl.origin !== serverUrl.origin) {
      throw new Error("requestBaseUrl origin mismatch");
    }
    url = text.startsWith("/") ? new URL(text.replace(/^\/+/, ""), ensureTrailingSlash(requestBaseUrl)) : new URL(text);
  } catch (_error) {
    throw new Error(`请求 URL 非法：${value}`);
  }
  if (url.origin !== serverUrl.origin) {
    throw new Error(`请求 URL 必须与当前工作区服务同源：${serverUrl.origin}`);
  }
  if (!["http:", "https:"].includes(url.protocol)) {
    throw new Error(`不支持的请求协议：${url.protocol}`);
  }
  return url;
}

function ensureTrailingSlash(url) {
  const value = new URL(url.toString());
  value.pathname = `${value.pathname.replace(/\/+$/, "")}/`;
  value.search = "";
  value.hash = "";
  return value;
}

function isConsoleUrl(serverUrl, targetUrl) {
  const basePath = normalizeUrlPath(serverUrl.pathname);
  const targetPath = normalizeUrlPath(targetUrl.pathname);
  return targetUrl.origin === serverUrl.origin &&
    (targetPath === basePath || targetPath.startsWith(`${basePath}/`));
}

async function readCurrentBridge(root, serverUrl) {
  const bridge = await readBridgeDescriptor(root);
  if (!bridge) {
    return undefined;
  }
  if (normalizeServerUrl(bridge.serverUrl) !== normalizeServerUrl(serverUrl)) {
    throw new Error("插件请求桥接属于其他服务地址，请等待扩展刷新当前工作区连接。");
  }
  return bridge;
}

async function requestThroughPlugin(root, serverUrl, bridgeValue, args, plan, headers, body) {
  const bridge = bridgeValue || await readCurrentBridge(root, serverUrl);
  if (!bridge) {
    throw new Error("当前工作区没有可用的插件请求桥接；请保持 VS Code 扩展运行并完成登录。若沙箱隔离了扩展临时目录，请按 Skill 规则申请宿主机执行，不要复制 Token。");
  }
  const payload = Buffer.from(JSON.stringify({
    version: BRIDGE_VERSION,
    consolePath: args.consolePath,
    url: args.url,
    method: plan.method,
    noToken: plan.noToken,
    timeoutMs: plan.timeoutMs,
    headers,
    bodyBase64: body ? body.toString("base64") : undefined
  }), "utf8");
  const bridgeUrl = new URL(`http://${bridge.host}:${bridge.port}/request`);
  const response = await requestText(bridgeUrl, "POST", payload, {
    "content-type": "application/json;charset=utf-8",
    "content-length": String(payload.length),
    [BRIDGE_TOKEN_HEADER]: bridge.bridgeToken
  }, plan.timeoutMs + 2000, MAX_BRIDGE_RESPONSE_BYTES);
  let value;
  try {
    value = JSON.parse(response.body);
  } catch (_error) {
    throw new Error(`插件请求桥接返回了无效 JSON（HTTP ${response.statusCode}）。`);
  }
  if (response.statusCode >= 400 || !value || value.ok !== true) {
    throw new Error(value && value.error ? value.error : `插件请求桥接失败：HTTP ${response.statusCode}`);
  }
  return {
    statusCode: value.statusCode,
    headers: value.headers || {},
    body: value.body || ""
  };
}

async function readHeaders(file) {
  if (!file) {
    return {};
  }
  const text = await readLimitedFile(file, MAX_REQUEST_BYTES, "headers");
  const value = JSON.parse(text.toString("utf8"));
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("--headers-file 必须指向 JSON 对象文件。");
  }
  const headers = {};
  for (const [name, rawValue] of Object.entries(value)) {
    const normalizedName = String(name || "").trim();
    const lowerName = normalizedName.toLowerCase();
    if (!normalizedName || /[\0\r\n:]/.test(normalizedName) || FORBIDDEN_REQUEST_HEADERS.has(lowerName)) {
      throw new Error(`禁止的请求头：${normalizedName || "<empty>"}`);
    }
    if (rawValue === undefined || rawValue === null || /[\0\r\n]/.test(String(rawValue))) {
      throw new Error(`非法请求头值：${normalizedName}`);
    }
    headers[normalizedName] = String(rawValue);
  }
  return headers;
}

async function readBody(file) {
  return file ? readLimitedFile(file, MAX_REQUEST_BYTES, "body") : undefined;
}

async function readLimitedFile(file, limit, label) {
  const absolute = path.resolve(file);
  const stat = await fs.promises.lstat(absolute);
  if (!stat.isFile() || stat.isSymbolicLink()) {
    throw new Error(`${label} 文件必须是普通文件且不能是符号链接：${absolute}`);
  }
  if (stat.size > limit) {
    throw new Error(`${label} 文件超过 ${limit} 字节限制：${absolute}`);
  }
  return fs.promises.readFile(absolute);
}

async function readToken(args) {
  if (args.tokenStdin) {
    if (args.tokenEnv) {
      throw new Error("--token-stdin 与 --token-env 不能同时使用。");
    }
    const chunks = [];
    for await (const chunk of process.stdin) {
      chunks.push(Buffer.from(chunk));
    }
    return Buffer.concat(chunks).toString("utf8").trim();
  }
  const name = args.tokenEnv || DEFAULT_TOKEN_ENV;
  if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(name)) {
    throw new Error(`非法环境变量名称：${name}`);
  }
  return String(process.env[name] || "").trim();
}

function requestText(url, method, body, headers, timeoutMs, maxResponseBytes = MAX_RESPONSE_BYTES) {
  return new Promise((resolve, reject) => {
    const transport = url.protocol === "https:" ? https : http;
    const request = transport.request(url, { method, headers }, (response) => {
      const chunks = [];
      let size = 0;
      response.on("data", (chunk) => {
        size += chunk.length;
        if (size > maxResponseBytes) {
          request.destroy(new Error(`响应超过 ${maxResponseBytes} 字节限制。`));
          return;
        }
        chunks.push(chunk);
      });
      response.on("end", () => resolve({
        statusCode: response.statusCode || 0,
        headers: response.headers,
        body: Buffer.concat(chunks).toString("utf8")
      }));
    });
    request.setTimeout(timeoutMs, () => request.destroy(new Error(`请求超过 ${timeoutMs}ms。`)));
    request.on("error", reject);
    if (body) {
      request.write(body);
    }
    request.end();
  });
}

function redactHeaders(headers) {
  const result = {};
  for (const [name, value] of Object.entries(headers || {})) {
    result[name] = REDACTED_HEADERS.has(name.toLowerCase()) ? "[REDACTED]" : value;
  }
  return result;
}

function formatBody(body, contentType) {
  const text = String(body || "");
  if (!text) {
    return "";
  }
  if (String(contentType || "").includes("json") || /^[\s\r\n]*[\[{]/.test(text)) {
    try {
      return JSON.stringify(JSON.parse(text), null, 2);
    } catch (_error) {
      return text;
    }
  }
  return text;
}

function parseArgs(tokens) {
  const result = {};
  for (let index = 0; index < tokens.length; index++) {
    const token = tokens[index];
    if (!token.startsWith("--")) {
      throw new Error(`无法识别参数：${token}`);
    }
    const key = token.slice(2).replace(/-([a-z])/g, (_, letter) => letter.toUpperCase());
    if (["direct", "help", "send", "noToken", "tokenStdin"].includes(key)) {
      result[key] = true;
      continue;
    }
    const value = tokens[++index];
    if (value === undefined || value.startsWith("--")) {
      throw new Error(`${token} 缺少值。`);
    }
    result[key] = value;
  }
  return result;
}

function required(args, key) {
  if (args[key] === undefined || args[key] === "") {
    throw new Error(`缺少 --${key.replace(/[A-Z]/g, (letter) => `-${letter.toLowerCase()}`)}。`);
  }
  return args[key];
}

function parseTimeout(value) {
  if (value === undefined) {
    return DEFAULT_TIMEOUT_MS;
  }
  const timeout = Number(value);
  if (!Number.isInteger(timeout) || timeout < 1 || timeout > MAX_TIMEOUT_MS) {
    throw new Error(`--timeout-ms 必须是 1-${MAX_TIMEOUT_MS} 的整数。`);
  }
  return timeout;
}

function normalizeUrlPath(value) {
  const text = `/${String(value || "").replace(/^\/+|\/+$/g, "")}`;
  return text === "/" ? "" : text;
}

function joinUrlPath(left, right) {
  return `/${[left, right].map((item) => String(item || "").replace(/^\/+|\/+$/g, ""))
    .filter(Boolean).join("/")}`.replace(/\/+/g, "/");
}

function normalizeServerUrl(value) {
  return String(value || "").trim().replace(/\/+$/, "");
}

function printHelp() {
  process.stdout.write(`magic-api request\n\n` +
    `Required: --root <mirror-root> and exactly one of --url or --console-path\n` +
    `Options: --method --headers-file --body-file --timeout-ms --no-token --send\n` +
    `Default connection: current VS Code workspace configuration and SecretStorage token.\n` +
    `Headless fallback: --direct [--token-env NAME | --token-stdin].\n` +
    `Default is JSON preview only; append --send to perform the request.\n` +
    `Console requests use lowercase magic-token and are limited to read-only endpoints.\n`);
}

module.exports = {
  assertAllowedConsoleRequest,
  buildRequestPlan,
  isConsoleUrl,
  normalizeConsolePath,
  redactHeaders
};
