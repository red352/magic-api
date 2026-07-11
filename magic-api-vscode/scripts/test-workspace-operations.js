"use strict";

const assert = require("assert");
const crypto = require("crypto");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { spawnSync } = require("child_process");
const {
  WorkspaceOperations,
  normalizeGroupPath,
  normalizeResourcePath
} = require("../ai-skills/magic-api-workspace/scripts/workspace-operations");

assert.strictEqual(normalizeResourcePath("api", "users\\profile//get/"), "/users/profile/get");
assert.strictEqual(normalizeResourcePath("function", "/common//format/"), "common/format");
assert.strictEqual(normalizeResourcePath("task", "jobs/nightly"), "jobs/nightly");
assert.strictEqual(normalizeResourcePath("script", "/tools/run"), "tools/run");
assert.throws(() => normalizeResourcePath("api", "/users/../admin"), /非法/);
assert.strictEqual(normalizeGroupPath("admin\\user//profile/"), "admin/user/profile");
assert.throws(() => normalizeGroupPath("admin/../user"), /非法/);

run().then(() => {
  process.stdout.write("workspace operations tests passed\n");
}).catch((error) => {
  process.stderr.write(`${error.stack || error}\n`);
  process.exit(1);
});

async function run() {
  await testOfflineNestedGroupsAndIdempotence();
  await testCreateTypesAndCli();
  await testUpdatePreservesIdentityAndFileNames();
  await testDeleteAndSafety();
}

async function testOfflineNestedGroupsAndIdempotence() {
  const root = await createRoot();
  try {
    const operations = new WorkspaceOperations(root, { serverUrl: "http://localhost:9999/magic/web" });
    const preview = await operations.ensureGroup({ type: "api", groupPath: "admin/user" }, false);
    assert.strictEqual(preview.applied, false);
    assert.strictEqual(preview.localGroups.length, 2);
    assert.strictEqual((await readManifest(root)).localGroups.length, 0);

    const applied = await operations.ensureGroup({ type: "api", groupPath: "admin/user" }, true);
    assert.strictEqual(applied.applied, true);
    assert.strictEqual((await readManifest(root)).localGroups.length, 2);
    const repeatedGroup = await operations.ensureGroup({ type: "api", groupPath: "admin/user" }, true);
    assert.strictEqual(repeatedGroup.noOp, true);

    const created = await operations.create({
      type: "api",
      groupPath: "admin/user",
      name: "OfflineDetail",
      path: "/offline/detail",
      method: "GET",
      script: "return { ok: true };\n"
    }, true);
    assert.match(created.id, /^local:/);
    assert.strictEqual(created.groupPath, "admin/user");
    assert.strictEqual(created.entry.path, "api/admin/user/detail.ms");

    const repeated = await operations.create({
      type: "api",
      groupPath: "admin/user",
      name: "OfflineDetail",
      path: "/offline/detail",
      method: "GET",
      script: "return { ok: true };\n"
    }, true);
    assert.strictEqual(repeated.noOp, true);
    assert.strictEqual(repeated.id, created.id);
    await assert.rejects(
      () => operations.create({
        type: "api",
        groupPath: "admin/user",
        name: "OfflineDetail",
        path: "/offline/detail",
        method: "GET",
        script: "return { ok: false };\n"
      }, false),
      /内容不同.*update/
    );
    const local = (await operations.list("api")).filter((entry) => entry.state === "local");
    assert.strictEqual(local.length, 1);
    assert.strictEqual((await operations.get(created.id)).entity.name, "OfflineDetail");
    await operations.update({
      id: created.id,
      name: "OfflineDetailUpdated",
      script: "return { updated: true };\n"
    }, true);
    assert.strictEqual((await operations.get(created.id)).entity.name, "OfflineDetailUpdated");
    assert.strictEqual(
      await fs.promises.readFile(path.join(root, "api/admin/user/detail.ms"), "utf8"),
      "return { updated: true };\n"
    );
    assert.strictEqual((await operations.validate()).ok, true);

    const disposable = await operations.create({
      type: "api",
      groupPath: "admin/user",
      name: "Disposable",
      path: "/offline/disposable",
      method: "DELETE",
      script: "return true;\n"
    }, true);
    await operations.delete({ id: disposable.id }, true);
    assert.strictEqual(await exists(path.join(root, disposable.entry.path)), false);

    const partial = await operations.ensureGroup({ type: "api", groupPath: "main/nested" }, true);
    assert.strictEqual(partial.localGroups.length, 1, "existing top-level group must be reused");

    const migrationRoot = await createRoot();
    try {
      const migrated = await readManifest(migrationRoot);
      migrated.version = 2;
      delete migrated.localGroups;
      delete migrated.pendingGroupCreateRequests;
      delete migrated.pendingGroupCreates;
      await writeManifest(migrationRoot, migrated);
      await new WorkspaceOperations(migrationRoot).ensureGroup({ type: "api", groupPath: "legacy/migrated" }, true);
      assert.strictEqual((await readManifest(migrationRoot)).version, 3);
    } finally {
      await fs.promises.rm(migrationRoot, { recursive: true, force: true });
    }
  } finally {
    await fs.promises.rm(root, { recursive: true, force: true });
  }
}

async function testCreateTypesAndCli() {
  const root = await createRoot();
  try {
    const cli = path.resolve(__dirname, "../ai-skills/magic-api-workspace/scripts/magic-api-workspace.js");
    const groupDry = runCli(cli, [
      "ensure-group", "--root", root, "--type", "api", "--group-path", "cli/nested"
    ]);
    assert.strictEqual(groupDry.status, 0, groupDry.stderr);
    assert.strictEqual(JSON.parse(groupDry.stdout).applied, false);
    const groupApplied = runCli(cli, [
      "ensure-group", "--root", root, "--type", "api", "--group-path", "cli/nested", "--apply"
    ]);
    assert.strictEqual(groupApplied.status, 0, groupApplied.stderr);
    assert.strictEqual((await readManifest(root)).localGroups.length, 2);
    const dry = runCli(cli, [
      "create", "--root", root, "--type", "api", "--group-id", "api-group",
      "--name", "UserDetail", "--path", "users\\profile//detail", "--method", "post"
    ]);
    assert.strictEqual(dry.status, 0, dry.stderr);
    const dryResult = JSON.parse(dry.stdout);
    assert.strictEqual(dryResult.applied, false);
    assert.strictEqual(dryResult.entity.path, "/users/profile/detail");
    assert.strictEqual(dryResult.entity.method, "POST");
    assert.strictEqual(await exists(path.join(root, "api/main/detail.ms")), false);

    const applied = runCli(cli, [
      "create", "--root", root, "--type", "api", "--group-id", "api-group",
      "--name", "UserDetail", "--path", "users/profile/detail", "--method", "post", "--apply"
    ]);
    assert.strictEqual(applied.status, 0, applied.stderr);
    const appliedResult = JSON.parse(applied.stdout);
    assert.strictEqual(appliedResult.applied, true);
    const apiMetadata = JSON.parse(await fs.promises.readFile(path.join(root, "api/main/detail.magic.json"), "utf8"));
    assert.strictEqual(apiMetadata.path, "/users/profile/detail");
    assert.strictEqual(apiMetadata.method, "POST");
    assert.strictEqual(apiMetadata.id, undefined);
    assert.strictEqual(apiMetadata.groupId, undefined);

    const operations = new WorkspaceOperations(root, { serverUrl: "http://localhost:9999/magic/web" });
    const secondApi = await operations.create({
      type: "api",
      groupId: "api-group",
      name: "AdminDetail",
      path: "/admin/detail",
      method: "GET"
    }, true);
    assert.match(secondApi.entry.path, /^api\/main\/detail-[a-f0-9]{8}\.ms$/);

    const functionResult = await operations.create({
      type: "function",
      groupId: "function-group",
      name: "FormatValue",
      path: "/common//format"
    }, true);
    assert.strictEqual(functionResult.entity.path, "common/format");
    assert.strictEqual(functionResult.entity.parameters.length, 0);

    const taskResult = await operations.create({
      type: "task",
      groupId: "task-group",
      name: "NightlyJob",
      path: "jobs/nightly"
    }, true);
    assert.strictEqual(taskResult.entity.path, "jobs/nightly");
    assert.strictEqual(taskResult.entity.cron, "0 0/5 * * * ?");
    assert.strictEqual(taskResult.entity.enabled, false);

    const scriptResult = await operations.create({
      type: "script",
      groupId: "script-group",
      name: "CleanupScript",
      path: "/maintenance//cleanup",
      script: "return true;\n"
    }, true);
    assert.strictEqual(scriptResult.entity.path, "maintenance/cleanup");
    assert.strictEqual(await fs.promises.readFile(path.join(root, scriptResult.entry.path), "utf8"), "return true;\n");

    await assert.rejects(
      () => operations.create({
        type: "script",
        groupId: "missing-group",
        name: "MissingScript",
        path: "missing"
      }, false),
      /没有唯一真实分组/
    );
    await assert.rejects(
      () => operations.create({
        type: "api",
        groupId: "api-group",
        name: "Bad Name",
        path: "/bad"
      }, false),
      /非法资源名称/
    );
  } finally {
    await fs.promises.rm(root, { recursive: true, force: true });
  }
}

async function testUpdatePreservesIdentityAndFileNames() {
  const root = await createRoot();
  try {
    const entry = await addManagedApi(root, "update-id", "api/main/original.ms");
    const manifest = await readManifest(root);
    manifest.entries.push(entry);
    await writeManifest(root, manifest);
    const operations = new WorkspaceOperations(root);
    const preview = await operations.update({
      id: "update-id",
      name: "RenamedResource",
      path: "nested\\updated//path",
      metadataPatch: { description: "updated", customField: { keep: true } }
    }, false);
    assert.strictEqual(preview.applied, false);
    assert.deepStrictEqual(preview.files, [{ action: "write", path: entry.metadataPath }]);
    assert.strictEqual(await exists(path.join(root, entry.path)), true);

    await operations.update({
      id: "update-id",
      name: "RenamedResource",
      path: "nested/updated/path",
      metadataPatch: { description: "updated" },
      script: "return 2;\n"
    }, true);
    assert.strictEqual(await exists(path.join(root, "api/main/RenamedResource.ms")), false);
    const metadata = JSON.parse(await fs.promises.readFile(path.join(root, entry.metadataPath), "utf8"));
    assert.strictEqual(metadata.id, "update-id");
    assert.strictEqual(metadata.groupId, "api-group");
    assert.strictEqual(metadata.name, "RenamedResource");
    assert.strictEqual(metadata.path, "/nested/updated/path");
    assert.deepStrictEqual(metadata.unknown, { preserved: true });
    assert.strictEqual(metadata.description, "updated");
    assert.strictEqual(await fs.promises.readFile(path.join(root, entry.path), "utf8"), "return 2;\n");

    await assert.rejects(
      () => operations.update({ id: "update-id", metadataPatch: { groupId: "other" } }, false),
      /不能包含服务端字段：groupId/
    );
  } finally {
    await fs.promises.rm(root, { recursive: true, force: true });
  }
}

async function testDeleteAndSafety() {
  const root = await createRoot();
  const outside = path.join(os.tmpdir(), `magic-api-operation-link-${process.pid}.ms`);
  try {
    const entry = await addManagedApi(root, "delete-id", "api/main/delete.ms");
    const manifest = await readManifest(root);
    manifest.entries.push(entry);
    await writeManifest(root, manifest);
    const operations = new WorkspaceOperations(root);
    const preview = await operations.delete({ id: "delete-id" }, false);
    assert.strictEqual(preview.applied, false);
    assert.strictEqual(await exists(path.join(root, entry.path)), true);
    await operations.delete({ id: "delete-id" }, true);
    assert.strictEqual(await exists(path.join(root, entry.path)), false);
    assert.strictEqual(await exists(path.join(root, entry.metadataPath)), false);
    assert.strictEqual((await readManifest(root)).entries.length, 1, "CLI must not edit manifest");

    const pendingManifest = await readManifest(root);
    pendingManifest.pendingDeletes.push({ id: "delete-id", folder: "api", path: entry.path });
    await writeManifest(root, pendingManifest);
    const pendingStatus = await operations.status();
    assert.strictEqual(pendingStatus.pending.deletes, 1);
    const pendingValidation = await operations.validate();
    assert.strictEqual(pendingValidation.ok, false);
    assert.ok(pendingValidation.errors.some((error) => error.includes("待复核的删除资源")));
    await assert.rejects(
      () => operations.update({ id: "delete-id", name: "Blocked" }, false),
      /未完成的新增或删除恢复状态/
    );

    const symlinkRoot = await createRoot();
    try {
      await fs.promises.writeFile(outside, "return false;\n", "utf8");
      await fs.promises.mkdir(path.join(symlinkRoot, "api/main"), { recursive: true });
      await fs.promises.symlink(outside, path.join(symlinkRoot, "api/main/link.ms"));
      const symlinkOperations = new WorkspaceOperations(symlinkRoot);
      const validation = await symlinkOperations.validate();
      assert.strictEqual(validation.ok, false);
      assert.ok(validation.errors.some((error) => error.includes("符号链接")));
    } finally {
      await fs.promises.rm(symlinkRoot, { recursive: true, force: true });
    }
  } finally {
    await fs.promises.rm(root, { recursive: true, force: true });
    await fs.promises.rm(outside, { force: true });
  }
}

async function createRoot() {
  const root = await fs.promises.mkdtemp(path.join(os.tmpdir(), "magic-api-operations-"));
  await fs.promises.mkdir(path.join(root, ".magic-api"), { recursive: true });
  await writeManifest(root, {
    version: 3,
    generatedAt: Date.now(),
    serverUrl: "http://localhost:9999/magic/web",
    entries: [],
    groups: [
      group("api", "api-group", "api/main"),
      group("function", "function-group", "function/main"),
      group("task", "task-group", "task/main"),
      group("script", "script-group", "script/main"),
      group("component", "component-group", "component/main"),
      group("datasource", "datasource:0", "datasource")
    ],
    pendingCreates: [],
    pendingCreateRequests: [],
    pendingDeletes: [],
    localGroups: [],
    pendingGroupCreateRequests: [],
    pendingGroupCreates: []
  });
  return root;
}

function group(folder, id, workspacePath) {
  return {
    folder,
    id,
    workspacePath,
    path: `.magic-api/groups/${folder}/${id.replace(/:/g, "_")}.json`
  };
}

async function addManagedApi(root, id, sourcePath) {
  const metadataPath = sourcePath.replace(/\.ms$/, ".magic.json");
  const metadata = {
    id,
    groupId: "api-group",
    name: path.basename(sourcePath, ".ms"),
    path: "/original",
    method: "GET",
    parameters: [],
    headers: [],
    options: [],
    paths: [],
    unknown: { preserved: true }
  };
  const script = "return 1;\n";
  await fs.promises.mkdir(path.dirname(path.join(root, sourcePath)), { recursive: true });
  await fs.promises.writeFile(path.join(root, sourcePath), script, "utf8");
  const metadataText = `${JSON.stringify(metadata, null, 2)}\n`;
  await fs.promises.writeFile(path.join(root, metadataPath), metadataText, "utf8");
  return {
    id,
    folder: "api",
    groupId: "api-group",
    type: "script",
    path: sourcePath,
    metadataPath,
    name: metadata.name,
    serverUpdateTime: 1,
    hash: hash(`${metadataText}\n${script}`)
  };
}

function runCli(cli, args) {
  return spawnSync(process.execPath, [cli, ...args], { encoding: "utf8" });
}

async function readManifest(root) {
  return JSON.parse(await fs.promises.readFile(path.join(root, ".magic-api/manifest.json"), "utf8"));
}

async function writeManifest(root, manifest) {
  await fs.promises.writeFile(
    path.join(root, ".magic-api/manifest.json"),
    `${JSON.stringify(manifest, null, 2)}\n`,
    "utf8"
  );
}

async function exists(file) {
  try {
    await fs.promises.access(file);
    return true;
  } catch (error) {
    return false;
  }
}

function hash(value) {
  return crypto.createHash("sha256").update(value, "utf8").digest("hex");
}
