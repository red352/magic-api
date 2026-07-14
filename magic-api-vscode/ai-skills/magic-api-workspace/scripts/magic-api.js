#!/usr/bin/env node
"use strict";

const crypto = require("crypto");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { spawn } = require("child_process");
const { COMMANDS, COMMAND_SCHEMA_VERSION, findCommand } = require("./command-schema");
const { callControl } = require("./control-client");
const { WorkspaceOperations } = require("./workspace-operations");

if (require.main === module) {
  main().catch((error) => {
    process.stderr.write(`${JSON.stringify({
      ok: false,
      status: error.code === "blocked" ? "blocked" : "error",
      code: error.code || "magic-api-cli-error",
      error: error.message,
      details: error.details
    }, null, 2)}\n`);
    process.exitCode = error.code === "blocked" ? 4 : 1;
  });
}

async function main(argv = process.argv.slice(2)) {
  const [domain, action, ...tokens] = argv;
  if (!domain || domain === "--help" || domain === "help") {
    if (argv.includes("--json")) {
      process.stdout.write(`${JSON.stringify(schemaDocument(), null, 2)}\n`);
      return;
    }
    printHelp();
    return;
  }
  if (domain === "schema") {
    process.stdout.write(`${JSON.stringify(schemaDocument(), null, 2)}\n`);
    return;
  }
  const command = findCommand(domain, action);
  if (!command) {
    throw new Error(`未知命令：${[domain, action].filter(Boolean).join(" ")}`);
  }
  const args = parseArgs(tokens);
  assertKnownArguments(command, args);
  if (args.help) {
    process.stdout.write(args.json
      ? `${JSON.stringify(command, null, 2)}\n`
      : `${renderCommandHelp(command)}\n`);
    return;
  }
  const root = path.resolve(required(args, "root"));
  let result;
  if (domain === "workspace" && ["status", "validate"].includes(action)) {
    const operations = new WorkspaceOperations(root);
    result = action === "status" ? await operations.status() : await operations.validate();
    if (action === "validate" && !result.ok) {
      process.exitCode = 2;
    }
  } else if (domain === "group" && action === "list") {
    result = await new WorkspaceOperations(root).groups(args.type);
  } else if (domain === "resource" && action === "list") {
    result = await new WorkspaceOperations(root).list(args.type);
  } else if (domain === "resource" && action === "get") {
    result = await new WorkspaceOperations(root).get(required(args, "id"));
  } else if (domain === "group" && action === "ensure") {
    result = await runLocalMutation(root, command, args, (operations, apply) => operations.ensureGroup({
      type: required(args, "type"),
      groupPath: required(args, "groupPath")
    }, apply));
  } else if (domain === "resource" && ["create", "update", "delete"].includes(action)) {
    result = await runResourceMutation(root, command, args);
  } else if (domain === "request") {
    result = await runRequest(root, command, args);
  } else {
    result = await runBridgeCommand(root, command, args);
  }
  process.stdout.write(`${JSON.stringify({ ok: true, command: command.name, result }, null, 2)}\n`);
  const statusCode = targetStatusCode(result);
  if (domain === "request" && statusCode >= 400) {
    process.exitCode = 3;
  }
}

async function runResourceMutation(root, command, args) {
  if (command.action === "create") {
    return runLocalMutation(root, command, args, async (operations, apply) => operations.create({
      type: required(args, "type"),
      groupId: args.groupId,
      groupPath: args.groupPath,
      name: required(args, "name"),
      path: args.path,
      method: args.method,
      cron: args.cron,
      enabled: parseBoolean(args.enabled),
      key: args.key,
      url: args.url,
      script: await readOptionalText(args.scriptFile),
      metadata: await readOptionalJson(args.metadataPatch)
    }, apply));
  }
  if (command.action === "update") {
    return runLocalMutation(root, command, args, async (operations, apply) => operations.update({
      id: required(args, "id"),
      name: args.name,
      path: args.path,
      method: args.method,
      cron: args.cron,
      enabled: parseBoolean(args.enabled),
      script: await readOptionalText(args.scriptFile),
      metadataPatch: await readOptionalJson(args.metadataPatch)
    }, apply));
  }
  return runLocalMutation(root, command, args, (operations, apply) => operations.delete({
    id: required(args, "id")
  }, apply));
}

async function runLocalMutation(root, command, args, operation) {
  const operations = new WorkspaceOperations(root);
  const preview = await operation(operations, false);
  const planId = await localPlanId(root, command.name, args, preview);
  const plan = Object.assign({}, preview, {
    planId,
    risk: command.risk,
    syncRequested: Boolean(args.sync),
    remoteEffects: args.sync ? projectedRemoteEffects(command, preview) : [],
    next: `使用 --apply --plan-id ${planId} 执行此计划。`
  });
  if (!args.apply) {
    await registerLocalPlan(root, planId);
    return plan;
  }
  assertPlanId(args, planId);
  await consumeLocalPlan(root, planId);
  const applied = await operation(operations, true);
  if (args.sync) {
    try {
      applied.sync = await previewAndApplyBridge(root, "workspace.reconcile", {});
    } catch (error) {
      error.details = {
        localApplied: applied,
        remote: error.details,
        next: "本地变更已保留；修复阻塞后使用 workspace reconcile，禁止重复 create/delete。"
      };
      throw error;
    }
  }
  return Object.assign({}, applied, { planId, risk: command.risk });
}

function projectedRemoteEffects(command, preview) {
  if (command.name === "group.ensure") {
    return [{ action: "ensure-groups", groups: preview.localGroups || [] }];
  }
  const action = {
    "resource.create": "create-resource",
    "resource.update": "update-resource",
    "resource.delete": "delete-resource"
  }[command.name];
  return action ? [{
    action,
    id: preview.id,
    type: preview.type,
    groupId: preview.groupId,
    path: preview.entry && preview.entry.path
  }] : [];
}

async function runBridgeCommand(root, command, args) {
  const bridgeArgs = bridgeArguments(command, args);
  if (!args.apply) {
    return callControl(root, command.name, bridgeArgs);
  }
  return callControl(root, command.name, bridgeArgs, {
    apply: true,
    planId: required(args, "planId")
  });
}

async function previewAndApplyBridge(root, operation, args) {
  const preview = await callControl(root, operation, args);
  if (!preview.planId) {
    return preview;
  }
  return callControl(root, operation, args, { apply: true, planId: preview.planId });
}

async function runRequest(root, command, args) {
  const requestArgs = legacyRequestArgs(root, args);
  const preview = await runLegacyRequest(requestArgs);
  if (command.action === "preview") {
    return Object.assign({}, preview, {
      next: "使用相同参数执行 request send 生成一次性发送计划。"
    });
  }
  if (!args.direct) {
    const controlArgs = await requestControlArguments(args);
    if (!args.apply) {
      return callControl(root, command.name, controlArgs);
    }
    return callControl(root, command.name, controlArgs, {
      apply: true,
      planId: required(args, "planId")
    });
  }
  const planId = await localPlanId(root, command.name, args, preview);
  const plan = Object.assign({}, preview, {
    planId,
    risk: command.risk,
    next: `使用 request send --apply --plan-id ${planId} 发送此请求。`
  });
  if (!args.apply) {
    await registerLocalPlan(root, planId);
    return plan;
  }
  assertPlanId(args, planId);
  await consumeLocalPlan(root, planId);
  return runLegacyRequest(requestArgs.concat("--send"));
}

async function requestControlArguments(args) {
  let headers = {};
  if (args.headersFile) {
    headers = await readLimitedJsonObject(args.headersFile, 2 * 1024 * 1024, "headers");
  }
  let bodyBase64;
  if (args.bodyFile) {
    const body = await readLimitedFile(args.bodyFile, 2 * 1024 * 1024, "body");
    bodyBase64 = body.toString("base64");
  }
  return {
    consolePath: args.consolePath,
    url: args.url,
    method: args.method,
    noToken: Boolean(args.noToken),
    timeoutMs: args.timeoutMs,
    headers,
    bodyBase64
  };
}

async function readLimitedJsonObject(file, limit, label) {
  const value = JSON.parse((await readLimitedFile(file, limit, label)).toString("utf8"));
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`${label} 文件必须包含 JSON 对象。`);
  }
  return value;
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

function bridgeArguments(command, args) {
  if (command.name === "connection.set") {
    return {
      serverUrl: args.serverUrl,
      workspaceDir: args.workspaceDir,
      syncOnSave: parseBoolean(args.syncOnSave),
      autoPullOnOpen: parseBoolean(args.autoPullOnOpen),
      checkConflicts: parseBoolean(args.checkConflicts)
    };
  }
  if (command.name === "workspace.pull") {
    const mode = args.mode || "incremental";
    if (!["incremental", "full"].includes(mode)) {
      throw new Error("--mode 只能是 incremental 或 full。");
    }
    return { mode };
  }
  if (command.name === "workspace.push") {
    return { file: args.file };
  }
  if (command.name === "skill.update") {
    return { force: Boolean(args.force) };
  }
  return {};
}

function legacyRequestArgs(root, args) {
  const result = ["--root", root];
  const valueOptions = [
    ["url", "--url"], ["consolePath", "--console-path"], ["method", "--method"],
    ["headersFile", "--headers-file"], ["bodyFile", "--body-file"], ["timeoutMs", "--timeout-ms"],
    ["tokenEnv", "--token-env"]
  ];
  valueOptions.forEach(([key, flag]) => {
    if (args[key] !== undefined) {
      result.push(flag, args[key]);
    }
  });
  [["noToken", "--no-token"], ["direct", "--direct"], ["tokenStdin", "--token-stdin"]]
    .forEach(([key, flag]) => {
      if (args[key]) {
        result.push(flag);
      }
    });
  return result;
}

function runLegacyRequest(args) {
  const file = path.join(__dirname, "magic-api-request.js");
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [file, ...args], {
      stdio: ["inherit", "pipe", "pipe"]
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => { stdout += chunk; });
    child.stderr.on("data", (chunk) => { stderr += chunk; });
    child.on("error", reject);
    child.on("close", (code) => {
      if (code !== 0 && code !== 3) {
        reject(new Error(parseChildError(stderr) || `请求 CLI 退出码 ${code}`));
        return;
      }
      try {
        resolve(JSON.parse(stdout));
      } catch (_error) {
        reject(new Error("请求 CLI 返回了无效 JSON。"));
      }
    });
  });
}

function targetStatusCode(result) {
  let current = result;
  for (let depth = 0; depth < 4 && current && typeof current === "object"; depth++) {
    if (Number.isInteger(current.statusCode)) {
      return current.statusCode;
    }
    current = current.result;
  }
  return 0;
}

function parseChildError(stderr) {
  try {
    return JSON.parse(stderr).error;
  } catch (_error) {
    return String(stderr || "").trim();
  }
}

async function localPlanId(root, command, args, preview) {
  const fingerprint = await workspaceFingerprint(root);
  const argumentFiles = await argumentFilesFingerprint(args);
  const normalizedArgs = Object.assign({}, args);
  delete normalizedArgs.apply;
  delete normalizedArgs.planId;
  return `plan:${crypto.createHash("sha256").update(stableStringify({
    version: COMMAND_SCHEMA_VERSION,
    root: path.resolve(root),
    command,
    args: normalizedArgs,
    preview,
    fingerprint,
    argumentFiles
  })).digest("hex")}`;
}

async function argumentFilesFingerprint(args) {
  const result = {};
  for (const key of ["scriptFile", "metadataPatch", "headersFile", "bodyFile"]) {
    if (!args[key]) {
      continue;
    }
    const absolute = path.resolve(args[key]);
    const stat = await fs.promises.lstat(absolute);
    if (!stat.isFile() || stat.isSymbolicLink()) {
      throw new Error(`${key} 必须指向普通文件且不能是符号链接：${absolute}`);
    }
    result[key] = crypto.createHash("sha256").update(await fs.promises.readFile(absolute)).digest("hex");
  }
  return result;
}

async function workspaceFingerprint(root) {
  const hash = crypto.createHash("sha256");
  async function walk(directory, relativeDirectory) {
    const entries = await fs.promises.readdir(directory, { withFileTypes: true });
    entries.sort((left, right) => left.name.localeCompare(right.name));
    for (const entry of entries) {
      const relative = relativeDirectory ? `${relativeDirectory}/${entry.name}` : entry.name;
      const full = path.join(directory, entry.name);
      const stat = await fs.promises.lstat(full);
      if (stat.isSymbolicLink()) {
        throw new Error(`工作区路径不允许符号链接：${relative}`);
      }
      if (stat.isDirectory()) {
        await walk(full, relative);
      } else if (stat.isFile()) {
        hash.update(`${relative}\0${stat.size}\0`);
        hash.update(await fs.promises.readFile(full));
      }
    }
  }
  await walk(root, "");
  return hash.digest("hex");
}

function assertPlanId(args, expected) {
  const actual = required(args, "planId");
  if (actual !== expected) {
    const error = new Error("计划 ID 与当前工作区状态不匹配，请重新预览后执行。");
    error.code = "plan-mismatch";
    throw error;
  }
}

async function registerLocalPlan(root, planId) {
  const file = localPlanFile(root, planId);
  await fs.promises.mkdir(path.dirname(file), { recursive: true, mode: 0o700 });
  if (process.platform !== "win32") {
    await fs.promises.chmod(path.dirname(file), 0o700);
  }
  const value = `${JSON.stringify({ planId, expiresAt: Date.now() + 5 * 60 * 1000 })}\n`;
  const temporary = `${file}.${process.pid}.${crypto.randomBytes(4).toString("hex")}.tmp`;
  await fs.promises.writeFile(temporary, value, { encoding: "utf8", mode: 0o600, flag: "wx" });
  await fs.promises.rm(file, { force: true });
  await fs.promises.rename(temporary, file);
  if (process.platform !== "win32") {
    await fs.promises.chmod(file, 0o600);
  }
}

async function consumeLocalPlan(root, planId) {
  const file = localPlanFile(root, planId);
  let value;
  try {
    value = JSON.parse(await fs.promises.readFile(file, "utf8"));
  } catch (error) {
    const planError = new Error("本地计划不存在或已被使用，请重新预览。");
    planError.code = "plan-expired";
    throw planError;
  }
  await fs.promises.rm(file, { force: true });
  if (!value || value.planId !== planId || !Number.isFinite(value.expiresAt) || value.expiresAt < Date.now()) {
    const planError = new Error("本地计划已经过期，请重新预览。");
    planError.code = "plan-expired";
    throw planError;
  }
}

function localPlanFile(root, planId) {
  const user = typeof process.getuid === "function" ? String(process.getuid()) : "user";
  const rootHash = crypto.createHash("sha256").update(path.resolve(root)).digest("hex").slice(0, 24);
  const planHash = crypto.createHash("sha256").update(planId).digest("hex");
  return path.join(os.tmpdir(), `magic-api-cli-${user}`, "plans", rootHash, `${planHash}.json`);
}

function parseArgs(tokens) {
  const result = {};
  const flags = new Set(["apply", "sync", "help", "json", "force", "direct", "noToken", "tokenStdin"]);
  for (let index = 0; index < tokens.length; index++) {
    const token = tokens[index];
    if (!token.startsWith("--")) {
      throw new Error(`无法识别参数：${token}`);
    }
    const key = token.slice(2).replace(/-([a-z])/g, (_, letter) => letter.toUpperCase());
    if (flags.has(key)) {
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

function assertKnownArguments(command, args) {
  const global = new Set(["root", "apply", "planId", "help", "json"]);
  const allowed = new Set([...(command.options || []), ...global]);
  const unknown = Object.keys(args).filter((key) => !allowed.has(key));
  if (unknown.length) {
    throw new Error(`命令 ${command.name} 不支持参数：${unknown.map((key) => `--${key.replace(/[A-Z]/g, (letter) => `-${letter.toLowerCase()}`)}`).join("、")}`);
  }
}

function parseBoolean(value) {
  if (value === undefined) {
    return undefined;
  }
  if (value === "true") {
    return true;
  }
  if (value === "false") {
    return false;
  }
  throw new Error(`布尔值只能是 true 或 false：${value}`);
}

async function readOptionalText(file) {
  return file ? fs.promises.readFile(path.resolve(file), "utf8") : undefined;
}

async function readOptionalJson(file) {
  if (!file) {
    return {};
  }
  const value = JSON.parse(await fs.promises.readFile(path.resolve(file), "utf8"));
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`${file} 必须包含 JSON 对象。`);
  }
  return value;
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

function schemaDocument() {
  return {
    ok: true,
    name: "magic-api",
    version: COMMAND_SCHEMA_VERSION,
    globalArguments: ["--root", "--apply", "--plan-id", "--help", "--json"],
    commands: COMMANDS
  };
}

function renderCommandHelp(command) {
  return [
    `magic-api ${command.domain} ${command.action}`,
    "",
    command.description,
    "",
    "Required global option: --root <mirror-root>",
    command.args.length ? `Options: ${command.args.join(" ")}` : "",
    command.risk === "read" ? "Read-only command." : "Mutations preview by default; execute with --apply --plan-id <id>."
  ].filter(Boolean).join("\n");
}

function printHelp() {
  const domains = Array.from(new Set(COMMANDS.map((item) => item.domain)));
  process.stdout.write(
    `magic-api standardized workspace CLI\n\n` +
    `Usage: magic-api <domain> <action> --root <mirror-root>\n` +
    `Domains: ${domains.join(" ")}\n` +
    `Schema: magic-api schema\n`
  );
}

module.exports = {
  localPlanId,
  main,
  parseArgs,
  schemaDocument,
  workspaceFingerprint
};
