#!/usr/bin/env node
"use strict";

const fs = require("fs");
const path = require("path");
const { WorkspaceOperations } = require("./workspace-operations");

main().catch((error) => {
  process.stderr.write(`${JSON.stringify({ ok: false, error: error.message }, null, 2)}\n`);
  process.exitCode = 1;
});

async function main() {
  const [command, ...tokens] = process.argv.slice(2);
  const args = parseArgs(tokens);
  if (!command || args.help) {
    printHelp();
    return;
  }
  if (!args.root) {
    throw new Error("所有命令都必须显式提供 --root <mirror-root>。");
  }
  const operations = new WorkspaceOperations(path.resolve(args.root), { serverUrl: args.serverUrl });
  let result;
  if (command === "status") {
    result = await operations.status();
  } else if (command === "groups") {
    result = await operations.groups(args.type);
  } else if (command === "list") {
    result = await operations.list(args.type);
  } else if (command === "get") {
    result = await operations.get(required(args, "id"));
  } else if (command === "validate") {
    result = await operations.validate();
    if (!result.ok) {
      process.exitCode = 2;
    }
  } else if (command === "create") {
    result = await operations.create(await createInput(args), Boolean(args.apply));
  } else if (command === "ensure-group") {
    result = await operations.ensureGroup({
      type: required(args, "type"),
      groupPath: required(args, "groupPath")
    }, Boolean(args.apply));
  } else if (command === "update") {
    result = await operations.update(await updateInput(args), Boolean(args.apply));
  } else if (command === "delete") {
    result = await operations.delete({ id: required(args, "id") }, Boolean(args.apply));
  } else {
    throw new Error(`未知命令：${command}`);
  }
  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
}

async function createInput(args) {
  const input = {
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
    metadata: await readJsonOption(args.metadataPatch)
  };
  if (args.scriptFile) {
    input.script = await fs.promises.readFile(path.resolve(args.scriptFile), "utf8");
  }
  return input;
}

async function updateInput(args) {
  const input = {
    id: required(args, "id"),
    name: args.name,
    path: args.path,
    method: args.method,
    cron: args.cron,
    enabled: parseBoolean(args.enabled),
    metadataPatch: await readJsonOption(args.metadataPatch)
  };
  if (args.scriptFile) {
    input.script = await fs.promises.readFile(path.resolve(args.scriptFile), "utf8");
  }
  return input;
}

async function readJsonOption(file) {
  if (!file) {
    return {};
  }
  const value = JSON.parse(await fs.promises.readFile(path.resolve(file), "utf8"));
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("--metadata-patch 必须指向 JSON 对象文件。");
  }
  return value;
}

function parseArgs(tokens) {
  const result = {};
  for (let index = 0; index < tokens.length; index++) {
    const token = tokens[index];
    if (!token.startsWith("--")) {
      throw new Error(`无法识别参数：${token}`);
    }
    const rawKey = token.slice(2);
    const key = rawKey.replace(/-([a-z])/g, (_, letter) => letter.toUpperCase());
    if (["apply", "help"].includes(key)) {
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

function printHelp() {
  process.stdout.write(`magic-api workspace operations\n\n` +
    `Commands: status groups list get ensure-group create update delete validate\n` +
    `Required: --root <mirror-root>\n` +
    `Mutations are previews unless --apply is present.\n` +
    `ensure-group: --type --group-path <a/b>\n` +
    `create: --type (--group-id | --group-path) --name --path [--method|--cron|--enabled] [--script-file] [--metadata-patch]\n` +
    `update: --id [--name] [--path] [--method|--cron|--enabled] [--script-file] [--metadata-patch]\n` +
    `delete/get: --id\n`);
}
