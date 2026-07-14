"use strict";

const COMMAND_SCHEMA_VERSION = 1;

const COMMANDS = [
  command("connection", "show", "读取当前工作区连接与行为配置。", "read", "bridge"),
  command("connection", "set", "修改当前工作区连接或行为配置。", "write", "bridge", [
    "--server-url", "--workspace-dir", "--sync-on-save", "--auto-pull-on-open", "--check-conflicts"
  ]),
  command("auth", "status", "读取当前工作区认证状态，不返回 Token。", "read", "bridge"),
  command("auth", "login", "在 VS Code 中打开用户名和密码输入框并登录。", "write", "bridge"),
  command("auth", "set-token", "在 VS Code 中打开 Magic-Token 安全输入框。", "write", "bridge"),
  command("auth", "clear", "清除当前工作区登录状态。", "destructive", "bridge"),
  command("workspace", "status", "读取本地镜像、journal 和文件变更状态。", "read", "local"),
  command("workspace", "validate", "校验 manifest、资源对、路径和待同步状态。", "read", "local"),
  command("workspace", "pull", "从服务端增量或全量拉取工作区。", "write", "bridge", ["--mode incremental|full"]),
  command("workspace", "push", "推送当前文件或全部本地变更。", "write", "bridge", ["--file"]),
  command("workspace", "reconcile", "自动恢复、推送、reload 并增量拉取 canonical 数据。", "destructive", "bridge"),
  command("workspace", "recover", "自动恢复能够唯一确认的新增和删除 journal。", "write", "bridge"),
  command("group", "list", "列出远端与离线嵌套分组。", "read", "local", ["--type"]),
  command("group", "ensure", "复用或暂存嵌套分组。", "write", "local", ["--type", "--group-path", "--sync"]),
  command("resource", "tree", "读取服务端资源树。", "read", "bridge"),
  command("resource", "list", "列出本地已管理和待同步资源。", "read", "local", ["--type"]),
  command("resource", "get", "按稳定资源 ID 或本地引用读取完整资源。", "read", "local", ["--id"]),
  command("resource", "create", "创建本地资源对并可自动同步。", "write", "local", [
    "--type", "--group-id|--group-path", "--name", "--path", "--method", "--cron", "--enabled",
    "--key", "--url", "--script-file", "--metadata-patch", "--sync"
  ]),
  command("resource", "update", "修改资源正文或合并 metadata。", "write", "local", [
    "--id", "--name", "--path", "--method", "--cron", "--enabled", "--script-file", "--metadata-patch", "--sync"
  ]),
  command("resource", "delete", "按稳定资源 ID 删除本地资源对并可自动同步远端删除。", "destructive", "local", ["--id", "--sync"]),
  command("request", "preview", "预览同源控制台或业务接口请求。", "read", "hybrid", requestArguments()),
  command("request", "send", "发送同源控制台或业务接口请求。", "destructive", "hybrid", requestArguments()),
  command("skill", "status", "检查当前工作区内置 Skills 的版本和漂移。", "read", "bridge"),
  command("skill", "install", "安装当前扩展内置 Skills。", "write", "bridge"),
  command("skill", "update", "安全更新未被人工修改的内置 Skills。", "write", "bridge", ["--force"])
];

function command(domain, action, description, risk, transport, args = []) {
  const options = Array.from(new Set((args.join(" ").match(/--[a-z][a-z-]*/g) || [])
    .map((value) => value.slice(2).replace(/-([a-z])/g, (_, letter) => letter.toUpperCase()))));
  return { domain, action, name: `${domain}.${action}`, description, risk, transport, args, options };
}

function requestArguments() {
  return [
    "--console-path|--url", "--method", "--headers-file", "--body-file", "--timeout-ms",
    "--no-token", "--direct", "--token-env", "--token-stdin"
  ];
}

function findCommand(domain, action) {
  return COMMANDS.find((item) => item.domain === domain && item.action === action);
}

module.exports = {
  COMMANDS,
  COMMAND_SCHEMA_VERSION,
  findCommand
};
