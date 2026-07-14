"use strict";

const fs = require("fs");
const path = require("path");
const { COMMANDS, COMMAND_SCHEMA_VERSION } = require("../ai-skills/magic-api-workspace/scripts/command-schema");

const root = path.resolve(__dirname, "..");
const check = process.argv.includes("--check");
const referenceFile = path.join(root, "ai-skills", "magic-api-workspace", "references", "cli.md");
const readmeFile = path.join(root, "README.md");
const startMarker = "<!-- magic-api-cli:start -->";
const endMarker = "<!-- magic-api-cli:end -->";

run().catch((error) => {
  process.stderr.write(`${error.stack || error}\n`);
  process.exit(1);
});

async function run() {
  const reference = renderReference();
  await syncFile(referenceFile, reference);
  const readme = await fs.promises.readFile(readmeFile, "utf8");
  const block = `${startMarker}\n${renderReadme()}\n${endMarker}`;
  const nextReadme = replaceMarkedBlock(readme, block);
  await syncFile(readmeFile, nextReadme);
  process.stdout.write(check ? "CLI documentation is synchronized.\n" : "CLI documentation updated.\n");
}

function renderReference() {
  const lines = [
    "# CLI Reference",
    "",
    `Schema version: ${COMMAND_SCHEMA_VERSION}`,
    "",
    "所有命令使用统一入口：",
    "",
    "```bash",
    "node .codex/skills/magic-api-workspace/scripts/magic-api.js <domain> <action> --root <mirror-root>",
    "```",
    "",
    "读取命令直接执行。变更命令默认只生成五分钟有效、单次使用的计划；使用返回的 `planId` 原样追加 `--apply --plan-id <id>`。",
    "",
    "| 命令 | 风险 | 执行位置 | 说明 | 主要参数 |",
    "| --- | --- | --- | --- | --- |"
  ];
  for (const item of COMMANDS) {
    lines.push(
      `| \`${item.domain} ${item.action}\` | ${riskName(item.risk)} | ${transportName(item.transport)} | ${item.description} | ${item.args.map((arg) => `\`${arg}\``).join(" ") || "-"} |`
    );
  }
  lines.push(
    "",
    "## 自动同步",
    "",
    "单个资源或分组变更优先增加 `--sync`。apply 后 CLI 会自动调用工作区控制桥完成恢复、校验、推送、reload 和增量拉取。批量编辑完成后使用 `workspace reconcile` 的计划/apply 流程。",
    "",
    "## 连接与认证",
    "",
    "`connection`、`auth`、远端 `workspace`、`resource tree` 和 `skill` 命令要求当前 VS Code 工作区扩展正在运行。Token 只由扩展从 SecretStorage 读取；CLI 只返回 `authenticated`，不会返回 Token。",
    "",
    "## 请求",
    "",
    "`request preview` 和 `request send` 继续执行同源校验。控制台端点保持只读白名单，业务请求使用当前工作区请求域名并由扩展注入 lowercase `magic-token`。",
    "",
    "## 退出码",
    "",
    "- `0`：成功或计划生成成功。",
    "- `1`：参数、连接或执行错误。",
    "- `2`：`workspace validate` 发现校验错误。",
    "- `3`：请求已发送，但目标服务返回 HTTP 4xx/5xx。",
    "- `4`：远端状态无法唯一复核，返回结构化 `blocked`。"
  );
  return `${lines.join("\n")}\n`;
}

function renderReadme() {
  const domains = Array.from(new Set(COMMANDS.map((item) => item.domain)));
  return [
    "统一零依赖 Node.js CLI：",
    "",
    "```bash",
    "node .codex/skills/magic-api-workspace/scripts/magic-api.js <domain> <action> --root <mirror-root>",
    "```",
    "",
    `命令域：${domains.map((item) => `\`${item}\``).join("、")}。执行 \`schema\` 或 \`--help --json\` 可读取机器接口。`,
    "",
    "变更默认生成绑定当前工作区状态的计划；AI 使用返回的 `planId` 执行 apply。资源 CRUD 增加 `--sync` 后会自动完成校验、推送、reload 和 canonical 增量拉取，无需用户再点击同步命令。"
  ].join("\n");
}

function replaceMarkedBlock(text, block) {
  const start = text.indexOf(startMarker);
  const end = text.indexOf(endMarker);
  if (start < 0 || end < start) {
    throw new Error(`README 缺少 ${startMarker}/${endMarker} 标记。`);
  }
  return `${text.slice(0, start)}${block}${text.slice(end + endMarker.length)}`;
}

async function syncFile(file, expected) {
  let current;
  try {
    current = await fs.promises.readFile(file, "utf8");
  } catch (error) {
    if (!error || error.code !== "ENOENT") {
      throw error;
    }
    current = undefined;
  }
  if (current === expected) {
    return;
  }
  if (check) {
    throw new Error(`${path.relative(root, file)} 与 command schema 不同步，请运行 npm run docs:generate。`);
  }
  await fs.promises.mkdir(path.dirname(file), { recursive: true });
  await fs.promises.writeFile(file, expected, "utf8");
}

function riskName(value) {
  return { read: "只读", write: "写入", destructive: "危险" }[value] || value;
}

function transportName(value) {
  return { local: "本地", bridge: "插件桥", hybrid: "混合" }[value] || value;
}
