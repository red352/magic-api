"use strict";

const fs = require("fs");
const path = require("path");

const root = path.resolve(__dirname, "..", "ai-skills");

run().catch((error) => {
  process.stderr.write(`${error.stack || error}\n`);
  process.exit(1);
});

async function run() {
  const entries = await fs.promises.readdir(root, { withFileTypes: true });
  for (const entry of entries.filter((item) => item.isDirectory())) {
    const file = path.join(root, entry.name, "SKILL.md");
    const text = await fs.promises.readFile(file, "utf8");
    const match = text.match(/^---\n([\s\S]*?)\n---\n/);
    if (!match) {
      throw new Error(`${entry.name}/SKILL.md 缺少 YAML frontmatter。`);
    }
    const keys = match[1].split("\n").filter(Boolean).map((line) => line.split(":", 1)[0].trim());
    if (keys.join(",") !== "name,description") {
      throw new Error(`${entry.name}/SKILL.md frontmatter 只能包含 name 和 description。`);
    }
    if (!match[1].includes(`name: ${entry.name}`)) {
      throw new Error(`${entry.name}/SKILL.md 的 name 必须与目录一致。`);
    }
    await fs.promises.access(path.join(root, entry.name, "agents", "openai.yaml"));
  }
  process.stdout.write("AI Skills are valid.\n");
}
