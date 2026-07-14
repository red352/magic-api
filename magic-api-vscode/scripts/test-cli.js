"use strict";

const assert = require("assert");
const crypto = require("crypto");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { spawnSync } = require("child_process");

const cli = path.resolve(__dirname, "../ai-skills/magic-api-workspace/scripts/magic-api.js");

run().then(() => {
  process.stdout.write("standard CLI tests passed\n");
}).catch((error) => {
  process.stderr.write(`${error.stack || error}\n`);
  process.exit(1);
});

async function run() {
  const schema = runCli(["schema"]);
  assert.strictEqual(schema.status, 0, schema.stderr);
  const schemaValue = JSON.parse(schema.stdout);
  assert.ok(schemaValue.commands.some((item) => item.name === "workspace.reconcile"));
  assert.ok(schemaValue.commands.some((item) => item.name === "request.send"));
  const jsonHelp = runCli(["--help", "--json"]);
  assert.strictEqual(JSON.parse(jsonHelp.stdout).version, schemaValue.version);
  const unknownArgument = runCli(["workspace", "status", "--root", "/tmp", "--unknown", "value"]);
  assert.strictEqual(unknownArgument.status, 1);
  assert.match(unknownArgument.stderr, /不支持参数/);

  const root = await createRoot();
  const scriptFile = path.join(os.tmpdir(), `magic-api-cli-script-${process.pid}.ms`);
  try {
    await fs.promises.writeFile(scriptFile, "return { ok: true };\n", "utf8");
    const baseArgs = [
      "resource", "create", "--root", root, "--type", "api", "--group-id", "api-group",
      "--name", "CliDetail", "--path", "/cli/detail", "--method", "GET", "--script-file", scriptFile
    ];
    const preview = runCli(baseArgs);
    assert.strictEqual(preview.status, 0, preview.stderr);
    const plan = JSON.parse(preview.stdout).result;
    assert.match(plan.planId, /^plan:[a-f0-9]{64}$/);
    assert.strictEqual(plan.applied, false);
    assert.strictEqual(await exists(path.join(root, "api/main/detail.ms")), false);

    const applied = runCli(baseArgs.concat("--apply", "--plan-id", plan.planId));
    assert.strictEqual(applied.status, 0, applied.stderr);
    assert.strictEqual(JSON.parse(applied.stdout).result.applied, true);
    assert.strictEqual(await exists(path.join(root, "api/main/detail.ms")), true);

    const replay = runCli(baseArgs.concat("--apply", "--plan-id", plan.planId));
    assert.strictEqual(replay.status, 1);
    assert.match(replay.stderr, /计划 ID.*不匹配/);

    const updateArgs = [
      "resource", "update", "--root", root, "--id", "local:" +
        crypto.createHash("sha256").update("resource\0api/main/detail.ms").digest("hex").slice(0, 24),
      "--script-file", scriptFile
    ];
    const updatePreview = runCli(updateArgs);
    assert.strictEqual(updatePreview.status, 0, updatePreview.stderr);
    const updatePlan = JSON.parse(updatePreview.stdout).result;
    await fs.promises.writeFile(scriptFile, "return { ok: false };\n", "utf8");
    const changedInput = runCli(updateArgs.concat("--apply", "--plan-id", updatePlan.planId));
    assert.strictEqual(changedInput.status, 1);
    assert.match(changedInput.stderr, /计划 ID.*不匹配/);

    const status = runCli(["workspace", "status", "--root", root]);
    assert.strictEqual(status.status, 0, status.stderr);
    assert.strictEqual(JSON.parse(status.stdout).command, "workspace.status");
  } finally {
    await fs.promises.rm(root, { recursive: true, force: true });
    await fs.promises.rm(scriptFile, { force: true });
  }
}

async function createRoot() {
  const root = await fs.promises.mkdtemp(path.join(os.tmpdir(), "magic-api-cli-"));
  await fs.promises.mkdir(path.join(root, ".magic-api"), { recursive: true });
  await fs.promises.writeFile(path.join(root, ".magic-api", "manifest.json"), `${JSON.stringify({
    version: 3,
    generatedAt: Date.now(),
    serverUrl: "http://localhost:9999/magic/web",
    entries: [],
    groups: [{
      folder: "api",
      id: "api-group",
      workspacePath: "api/main",
      path: ".magic-api/groups/api/api-group.json"
    }],
    pendingCreates: [],
    pendingCreateRequests: [],
    pendingDeletes: [],
    localGroups: [],
    pendingGroupCreateRequests: [],
    pendingGroupCreates: []
  }, null, 2)}\n`, "utf8");
  return root;
}

function runCli(args) {
  return spawnSync(process.execPath, [cli, ...args], { encoding: "utf8" });
}

async function exists(file) {
  try {
    await fs.promises.access(file);
    return true;
  } catch (_error) {
    return false;
  }
}
