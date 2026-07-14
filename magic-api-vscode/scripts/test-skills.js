"use strict";

const assert = require("assert");
const crypto = require("crypto");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { AiSkillManager } = require("../src/skillManager");

run().then(() => {
  process.stdout.write("AI Skill manager tests passed\n");
}).catch((error) => {
  process.stderr.write(`${error.stack || error}\n`);
  process.exit(1);
});

async function run() {
  const root = await fs.promises.mkdtemp(path.join(os.tmpdir(), "magic-api-skills-"));
  const extensionPath = path.join(root, "extension");
  const workspacePath = path.join(root, "workspace");
  const bundle = path.join(extensionPath, "ai-skills", "demo-skill");
  await fs.promises.mkdir(workspacePath, { recursive: true });
  try {
    await writeBundle(bundle, "1.0.0", "initial");
    const state = new Map();
    const warnings = [];
    const context = {
      workspaceState: {
        get(key, fallback) { return state.has(key) ? state.get(key) : fallback; },
        async update(key, value) { state.set(key, value); }
      }
    };
    const folder = { name: "workspace", uri: { fsPath: workspacePath } };
    const vscode = {
      workspace: { workspaceFolders: [folder] },
      window: {
        showWarningMessage(message) { warnings.push(message); },
        showInformationMessage() {}
      }
    };
    const manager = new AiSkillManager({
      context,
      vscode,
      output: { appendLine() {} },
      extensionPath
    });

    const installed = await manager.install({ force: true });
    assert.strictEqual(installed.skills[0].status, "installed");
    assert.strictEqual((await manager.status()).skills[0].status, "current");

    const installedSkill = path.join(workspacePath, ".codex", "skills", "demo-skill");
    await fs.promises.appendFile(path.join(installedSkill, "SKILL.md"), "modified\n", "utf8");
    assert.strictEqual((await manager.status()).skills[0].status, "modified");
    const preserved = await manager.update({ force: false });
    assert.strictEqual(preserved.skills[0].status, "preserved");
    assert.match(await fs.promises.readFile(path.join(installedSkill, "SKILL.md"), "utf8"), /modified/);

    await manager.update({ force: true });
    assert.doesNotMatch(await fs.promises.readFile(path.join(installedSkill, "SKILL.md"), "utf8"), /modified/);
    await writeBundle(bundle, "1.1.0", "updated");
    const updated = await manager.update({ force: false });
    assert.strictEqual(updated.skills[0].status, "updated");
    assert.match(await fs.promises.readFile(path.join(installedSkill, "SKILL.md"), "utf8"), /updated/);

    await fs.promises.rm(path.join(installedSkill, ".magic-api-skill.json"));
    assert.strictEqual((await manager.status()).skills[0].status, "legacy");
    const legacy = await manager.update({ force: false });
    assert.strictEqual(legacy.skills[0].status, "preserved");
    await manager.autoUpdate();
    assert.strictEqual(warnings.length, 1);
  } finally {
    await fs.promises.rm(root, { recursive: true, force: true });
  }
}

async function writeBundle(directory, version, marker) {
  await fs.promises.rm(directory, { recursive: true, force: true });
  await fs.promises.mkdir(path.join(directory, "agents"), { recursive: true });
  await fs.promises.writeFile(path.join(directory, "SKILL.md"), `---\nname: demo-skill\ndescription: Demo skill ${marker}.\n---\n\n# Demo\n\n${marker}\n`, "utf8");
  await fs.promises.writeFile(path.join(directory, "agents", "openai.yaml"), "interface:\n  display_name: \"Demo\"\n", "utf8");
  const files = {
    "SKILL.md": await hashFile(path.join(directory, "SKILL.md")),
    "agents/openai.yaml": await hashFile(path.join(directory, "agents", "openai.yaml"))
  };
  await fs.promises.writeFile(path.join(directory, ".magic-api-skill.json"), `${JSON.stringify({
    schemaVersion: 1,
    name: "demo-skill",
    version,
    files
  }, null, 2)}\n`, "utf8");
}

async function hashFile(file) {
  return crypto.createHash("sha256").update(await fs.promises.readFile(file)).digest("hex");
}
