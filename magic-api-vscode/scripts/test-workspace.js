"use strict";

const assert = require("assert");
const fs = require("fs");
const os = require("os");
const path = require("path");
const Module = require("module");
const extensionManifest = require("../package.json");
const {
  MANIFEST_VERSION,
  buildNewResourceEntity,
  describeResourcePath,
  discoverUntrackedResourceRecords,
  groupPathSegment,
  metadataPathForScript,
  resolveGroupId,
  resourceIdsFromTree,
  sourcePathForMetadata
} = require("../src/workspaceSync");

const contributedCommands = new Set(extensionManifest.contributes.commands.map((item) => item.command));
assert.ok(extensionManifest.activationEvents.includes("workspaceContains:**/.magic-api/manifest.json"));
assert.ok(contributedCommands.has("magicApi.createResourceFromExplorer"));
assert.ok(contributedCommands.has("magicApi.deleteResourceFromExplorer"));
const explorerMenus = extensionManifest.contributes.menus["view/item/context"];
const explorerTitleMenus = extensionManifest.contributes.menus["view/title"];
assert.ok(explorerTitleMenus.some((item) => item.command === "magicApi.createResourceFromExplorer"));
assert.ok(explorerMenus.some((item) =>
  item.command === "magicApi.createResourceFromExplorer" && item.when.includes("magicApiGroup")
));
assert.ok(explorerMenus.some((item) =>
  item.command === "magicApi.deleteResourceFromExplorer" && item.when.includes("magicApiFile")
));

assert.strictEqual(MANIFEST_VERSION, 3);
assert.strictEqual(metadataPathForScript("api/user/list.ms"), "api/user/list.magic.json");
assert.strictEqual(sourcePathForMetadata("api/user/list.magic.json"), "api/user/list.ms");
assert.deepStrictEqual(describeResourcePath("api/user/list.ms"), {
  folder: "api",
  type: "script",
  path: "api/user/list.ms",
  metadataPath: "api/user/list.magic.json"
});
assert.deepStrictEqual(describeResourcePath("datasource/default.json"), {
  folder: "datasource",
  type: "json",
  path: "datasource/default.json"
});
assert.strictEqual(describeResourcePath("api/user/notes.json"), undefined);
assert.throws(() => describeResourcePath("datasource/bad.ms"), /只支持单个 \.json/);

assert.strictEqual(groupPathSegment("datasource", { id: "datasource:0" }), "");
assert.strictEqual(groupPathSegment("api", { id: "group-1", name: "用户 接口" }), "用户 接口");

const groups = [
  { id: "0", folder: "api", workspacePath: "api" },
  { id: "api-root", folder: "api", workspacePath: "api" },
  { id: "api-user", folder: "api", workspacePath: "api/user" },
  { id: "datasource:0", folder: "datasource", workspacePath: "datasource" }
];
assert.strictEqual(resolveGroupId(groups, "api", "api/user/list.ms"), "api-user");
assert.strictEqual(resolveGroupId(groups, "datasource", "datasource/default.json"), "datasource:0");
assert.throws(
  () => resolveGroupId(groups, "api", "api/unknown/list.ms"),
  /没有对应的 magic-api 服务端分组/
);
assert.throws(
  () => resolveGroupId(groups.concat({ id: "api-user-2", folder: "api", workspacePath: "api/user" }), "api", "api/user/list.ms"),
  /对应多个 magic-api 分组/
);

const discovery = discoverUntrackedResourceRecords([
  { path: "api/user/list.ms", symlink: false },
  { path: "api/user/list.magic.json", symlink: false },
  { path: "function/common/broken.ms", symlink: false },
  { path: "datasource/default.json", symlink: false },
  { path: "api/user/link.ms", symlink: true }
], []);
assert.deepStrictEqual(discovery.created, ["api/user/list.ms", "datasource/default.json"]);
assert.ok(discovery.invalid.some((message) => message.includes("broken.magic.json")));
assert.ok(discovery.invalid.some((message) => message.includes("符号链接")));
const unknownDiscovery = discoverUntrackedResourceRecords([
  { path: "unknown/demo.ms", symlink: false },
  { path: "unknown/demo.magic.json", symlink: false }
], [], ["api", "function"]);
assert.strictEqual(unknownDiscovery.created.length, 0);
assert.ok(unknownDiscovery.invalid.some((message) => message.includes("未知的 magic-api 资源类型")));

const apiDescriptor = describeResourcePath("api/user/list.ms");
const apiEntity = buildNewResourceEntity(
  apiDescriptor,
  { name: "用户列表", path: "/users", method: "POST", parameters: [] },
  "return [];",
  "api-user"
);
assert.strictEqual(apiEntity.groupId, "api-user");
assert.strictEqual(apiEntity.method, "POST");
assert.strictEqual(apiEntity.script, "return [];");
assert.strictEqual(apiEntity.id, undefined);
assert.throws(
  () => buildNewResourceEntity(apiDescriptor, { id: "local-id", name: "x", path: "/x", method: "GET" }, "return 1;", "api-user"),
  /不能包含服务端字段：id/
);
assert.throws(
  () => buildNewResourceEntity(apiDescriptor, { name: "x.ms", path: "/x", method: "GET" }, "return 1;", "api-user"),
  /name 不能包含/
);
assert.throws(
  () => buildNewResourceEntity(describeResourcePath("datasource/default.json"), { name: "default", key: "default" }, undefined, "datasource:0"),
  /缺少 url/
);

const ids = resourceIdsFromTree({
  api: {
    node: { id: "0" },
    children: [
      {
        node: { id: "group", name: "group" },
        children: [{ node: { id: "file-1", groupId: "group", name: "file" }, children: [] }]
      }
    ]
  }
});
assert.deepStrictEqual(Array.from(ids), ["file-1"]);

runIntegrationTests()
  .then(() => process.stdout.write("workspace sync tests passed\n"))
  .catch((error) => {
    process.stderr.write(`${error.stack || error}\n`);
    process.exit(1);
  });

async function runIntegrationTests() {
  let warningChoice = "删除服务端资源";
  let warningCalls = 0;
  let configuredWorkspaceDir;
  const vscode = {
    TreeItem: class TreeItem {
      constructor(label, collapsibleState) {
        this.label = label;
        this.collapsibleState = collapsibleState;
      }
    },
    EventEmitter: class EventEmitter {
      constructor() {
        this.event = () => {};
      }
      fire() {}
    },
    ThemeIcon: class ThemeIcon {
      constructor(id) {
        this.id = id;
      }
    },
    TreeItemCollapsibleState: { None: 0, Collapsed: 1, Expanded: 2 },
    window: {
      async showWarningMessage() {
        warningCalls++;
        return warningChoice;
      },
      withProgress(options, task) {
        return task({ report() {} });
      },
      setStatusBarMessage() {}
    },
    workspace: {
      getConfiguration() {
        return {
          get(key) {
            if (key === "checkConflicts") {
              return false;
            }
            if (key === "workspaceDir") {
              return configuredWorkspaceDir;
            }
            return undefined;
          }
        };
      }
    },
    ProgressLocation: { Notification: 1 }
  };
  vscode.Uri = {
    file(fsPath) {
      return { scheme: "file", fsPath };
    }
  };
  const originalLoad = Module._load;
  Module._load = function load(request, parent, isMain) {
    if (request === "vscode") {
      return vscode;
    }
    return originalLoad.call(this, request, parent, isMain);
  };
  let MagicApiWorkspaceMirror;
  let MagicApiTreeDataProvider;
  try {
    ({ MagicApiWorkspaceMirror, MagicApiTreeDataProvider } = require("../extension").__test);
  } finally {
    Module._load = originalLoad;
  }

  const root = await fs.promises.mkdtemp(path.join(os.tmpdir(), "magic-api-vscode-workspace-"));
  vscode.workspace.workspaceFolders = [{ uri: { fsPath: root } }];
  const outputLines = [];
  const output = {
    appendLine(line) {
      outputLines.push(line);
    },
    show() {}
  };
  const baseClient = {
    connectionStore: {
      getWorkspaceDir() {
        return configuredWorkspaceDir || ".magic-api-workspace";
      },
      getBehaviorSetting(key, fallback) {
        return key === "checkConflicts" ? false : fallback;
      }
    },
    getServerUrl() {
      return "http://localhost:9999/magic/web";
    },
    getRequestBaseUrl() {
      return "http://localhost:9999";
    }
  };
  const mirror = new MagicApiWorkspaceMirror({}, baseClient, output);

  try {
    const conflictMirror = new MagicApiWorkspaceMirror({}, {
      ...baseClient,
      connectionStore: {
        ...baseClient.connectionStore,
        getBehaviorSetting() { return true; }
      },
      async getFile() { return { id: "conflict-id", updateTime: 20 }; }
    }, output);
    const warningsBeforeAutoApprove = warningCalls;
    assert.strictEqual(await conflictMirror.confirmNoRemoteConflict({
      id: "conflict-id",
      path: "api/main/conflict.ms",
      serverUpdateTime: 10
    }, { autoApprove: true }), true);
    assert.strictEqual(warningCalls, warningsBeforeAutoApprove);

    const emptyTreeProvider = new MagicApiTreeDataProvider({
      ...baseClient,
      async getResources() {
        return {};
      }
    }, {}, mirror, output);
    const emptyRoots = await emptyTreeProvider.getChildren();
    assert.deepStrictEqual(emptyRoots.map((item) => item.folder).sort(), ["api", "function", "task"]);

    configuredWorkspaceDir = "../outside";
    await assert.rejects(() => mirror.resolveRoot(), /不能越出当前 VS Code 工作区/);
    configuredWorkspaceDir = undefined;

    const group = {
      id: "api-user",
      folder: "api",
      workspacePath: "api/user",
      path: ".magic-api/groups/api/api-user.json"
    };
    const baseManifest = () => ({
      version: 3,
      generatedAt: Date.now(),
      serverUrl: baseClient.getServerUrl(),
      entries: [],
      groups: [group],
      pendingCreates: [],
      pendingCreateRequests: [],
      pendingDeletes: [],
      localGroups: [],
      pendingGroupCreateRequests: [],
      pendingGroupCreates: []
    });

    assert.throws(() => mirror.validateManifest({
      version: 3,
      serverUrl: baseClient.getServerUrl(),
      entries: [{
        id: "bad",
        folder: "api",
        groupId: "api-user",
        type: "script",
        path: "../outside.ms",
        metadataPath: "api/outside.magic.json",
        name: "bad",
        hash: "hash"
      }],
      groups: [Object.assign({}, group)],
      pendingCreates: [],
      pendingCreateRequests: [],
      pendingDeletes: [],
      localGroups: [],
      pendingGroupCreateRequests: [],
      pendingGroupCreates: []
    }, "test-manifest"), /非法工作区相对路径|不在 api 资源目录/);
    assert.throws(
      () => mirror.assertManifestServer(Object.assign(baseManifest(), { serverUrl: "http://other/magic/web" })),
      /已阻止推送/
    );
    const legacyRoot = await fs.promises.mkdtemp(path.join(os.tmpdir(), "magic-api-vscode-v2-"));
    try {
      const legacyManifest = baseManifest();
      legacyManifest.version = 2;
      delete legacyManifest.localGroups;
      delete legacyManifest.pendingGroupCreateRequests;
      delete legacyManifest.pendingGroupCreates;
      await mirror.writeManifest(legacyRoot, legacyManifest);
      await mirror.ensureManifestV3(legacyRoot, legacyManifest);
      assert.strictEqual((await mirror.readManifest(legacyRoot)).version, 3);

      const blockedLegacy = baseManifest();
      blockedLegacy.version = 2;
      blockedLegacy.pendingCreateRequests.push({ operationId: "legacy-pending" });
      await assert.rejects(() => mirror.ensureManifestV3(legacyRoot, blockedLegacy), /未完成 journal/);
    } finally {
      await fs.promises.rm(legacyRoot, { recursive: true, force: true });
    }

    const nestedGroupRoot = await fs.promises.mkdtemp(path.join(os.tmpdir(), "magic-api-vscode-groups-"));
    try {
      const nestedManifest = baseManifest();
      nestedManifest.groups = [];
      nestedManifest.localGroups = [
        {
          clientId: "local-admin",
          folder: "api",
          parentRef: "0",
          name: "admin",
          path: "admin",
          workspacePath: "api/admin",
          createdAt: 1
        },
        {
          clientId: "local-user",
          folder: "api",
          parentRef: "local:local-admin",
          name: "user",
          path: "user",
          workspacePath: "api/admin/user",
          createdAt: 2
        }
      ];
      await mirror.writeManifest(nestedGroupRoot, nestedManifest);
      const remoteGroups = [];
      const saveOrder = [];
      const nestedMirror = new MagicApiWorkspaceMirror({}, {
        ...baseClient,
        async getResources() {
          return groupResourceTree(remoteGroups);
        },
        async saveGroup(value) {
          saveOrder.push([value.name, value.parentId]);
          const id = `group-${value.name}`;
          remoteGroups.push(Object.assign({ id }, value));
          return id;
        }
      }, output);
      const result = await nestedMirror.syncLocalGroups(nestedGroupRoot, nestedManifest);
      assert.deepStrictEqual(saveOrder, [["admin", "0"], ["user", "group-admin"]]);
      assert.deepStrictEqual(result, { created: 2, reused: 0 });
      assert.deepStrictEqual(nestedManifest.groups.map((item) => item.workspacePath).sort(), ["api/admin", "api/admin/user"]);
      assert.strictEqual(nestedManifest.localGroups.length, 0);

      const lossManifest = baseManifest();
      lossManifest.groups = [];
      lossManifest.localGroups = [{
        clientId: "local-loss",
        folder: "api",
        parentRef: "0",
        name: "loss",
        path: "loss",
        workspacePath: "api/loss",
        createdAt: 3
      }];
      await nestedMirror.writeManifest(nestedGroupRoot, lossManifest);
      const lossRemoteGroups = [];
      const lossMirror = new MagicApiWorkspaceMirror({}, {
        ...baseClient,
        async getResources() {
          return groupResourceTree(lossRemoteGroups);
        },
        async saveGroup(value) {
          lossRemoteGroups.push(Object.assign({ id: "group-loss" }, value));
          throw new Error("response lost");
        }
      }, output);
      await assert.rejects(() => lossMirror.syncLocalGroups(nestedGroupRoot, lossManifest), /结果未知/);
      assert.strictEqual(lossManifest.pendingGroupCreateRequests.length, 1);
      const recovered = await lossMirror.resolvePendingGroupCreateRequestsInteractively(nestedGroupRoot, lossManifest);
      assert.deepStrictEqual(recovered, { adopted: 1, cleared: 0, unresolved: 0 });
      assert.strictEqual(lossManifest.localGroups.length, 0);
      assert.strictEqual(lossManifest.pendingGroupCreateRequests.length, 0);

      const batchRoot = await fs.promises.mkdtemp(path.join(os.tmpdir(), "magic-api-vscode-group-batch-"));
      try {
        const batchManifest = baseManifest();
        batchManifest.groups = [];
        batchManifest.localGroups = [{
          clientId: "local-batch",
          folder: "api",
          parentRef: "0",
          name: "batch",
          path: "batch",
          workspacePath: "api/batch",
          createdAt: 4
        }];
        await mirror.writeManifest(batchRoot, batchManifest);
        await writeRawApiPair(batchRoot, "api/batch/create.ms", {
          name: "BatchCreate",
          path: "/batch/create",
          method: "POST",
          parameters: [],
          options: [],
          headers: [],
          paths: []
        }, "return true;\n");
        const batchRemoteGroups = [];
        const batchOrder = [];
        const batchMirror = new MagicApiWorkspaceMirror({}, {
          ...baseClient,
          async getResources() {
            return groupResourceTree(batchRemoteGroups);
          },
          async saveGroup(value) {
            batchOrder.push("group");
            batchRemoteGroups.push(Object.assign({ id: "group-batch" }, value));
            return "group-batch";
          },
          async saveFile(folder, entity) {
            batchOrder.push("resource");
            assert.strictEqual(folder, "api");
            assert.strictEqual(entity.groupId, "group-batch");
            return "resource-batch";
          },
          async getFile(id) {
            return {
              id,
              groupId: "group-batch",
              name: "BatchCreate",
              path: "/batch/create",
              method: "POST",
              script: "return true;\n",
              createTime: 5
            };
          },
          async reload() {}
        }, output);
        batchMirror.resolveRoot = async () => batchRoot;
        const batchResult = await batchMirror.pushChanged();
        assert.deepStrictEqual(batchOrder, ["group", "resource"]);
        assert.strictEqual(batchResult.groupsCreated, 1);
        assert.strictEqual(batchResult.created, 1);
        const batchOnDisk = await batchMirror.readManifest(batchRoot);
        assert.deepStrictEqual(batchOnDisk.entries.map((entry) => entry.id), ["resource-batch"]);
      } finally {
        await fs.promises.rm(batchRoot, { recursive: true, force: true });
      }
    } finally {
      await fs.promises.rm(nestedGroupRoot, { recursive: true, force: true });
    }

    const remoteTaskRoot = await fs.promises.mkdtemp(path.join(os.tmpdir(), "magic-api-vscode-remote-task-"));
    try {
      const sourcePath = "task/telegram/tg-yunxiao-bot/pollUpdates.ms";
      await writeRawApiPair(remoteTaskRoot, sourcePath, {
        id: "remote-task-id",
        groupId: "task-group",
        name: "PollUpdates",
        path: "/pollUpdates",
        cron: "0 0/5 * * * ?",
        enabled: true,
        updateTime: 1
      }, "return null;\n");
      const taskEntry = {
        id: "remote-task-id",
        folder: "task",
        groupId: "task-group",
        type: "script",
        path: sourcePath,
        metadataPath: sourcePath.replace(/\.ms$/, ".magic.json"),
        name: "PollUpdates",
        serverUpdateTime: 1
      };
      taskEntry.hash = await mirror.hashEntry(remoteTaskRoot, taskEntry);
      const taskManifest = baseManifest();
      taskManifest.groups = [{
        id: "task-group",
        folder: "task",
        workspacePath: "task/telegram/tg-yunxiao-bot",
        path: ".magic-api/groups/task/task-group.json"
      }];
      taskManifest.entries.push(taskEntry);
      await mirror.writeManifest(remoteTaskRoot, taskManifest);

      const taskMirror = new MagicApiWorkspaceMirror({}, baseClient, output);
      taskMirror.resolveRoot = async () => remoteTaskRoot;
      const pushResult = await taskMirror.pushChanged();
      assert.strictEqual(pushResult.count, 0);
      assert.strictEqual(pushResult.failed, 0);
    } finally {
      await fs.promises.rm(remoteTaskRoot, { recursive: true, force: true });
    }

    const managedEntry = await writeManagedApiPair(root, mirror, "managed-id", "api/user/managed.ms");
    const managedManifest = baseManifest();
    managedManifest.entries.push(managedEntry);
    await mirror.writeManifest(root, managedManifest);

    mirror.resolveRoot = async () => root;
    const autoPushed = [];
    mirror.pushUri = async (uri, options) => {
      autoPushed.push({ uri, options });
      return { pushed: true };
    };
    await mirror.pushDocumentIfManaged({
      uri: { scheme: "file", fsPath: path.join(root, managedEntry.path) }
    });
    assert.strictEqual(autoPushed.length, 1);
    await writeRawApiPair(root, "api/user/untracked.ms", {
      name: "untracked",
      path: "/untracked",
      method: "GET"
    }, "return 1;\n");
    await mirror.pushDocumentIfManaged({
      uri: { scheme: "file", fsPath: path.join(root, "api/user/untracked.ms") }
    });
    assert.strictEqual(autoPushed.length, 1, "auto-save must not create untracked resources");
    let singleCreateCalled = false;
    mirror.pushNewCandidate = async () => {
      singleCreateCalled = true;
      return { created: true };
    };
    const singleCreateResult = await mirror.pushUriWithProgress(
      { scheme: "file", fsPath: path.join(root, "api/user/untracked.ms") },
      null,
      {}
    );
    assert.strictEqual(singleCreateResult, null);
    assert.strictEqual(singleCreateCalled, false, "single-file push must not bypass batch create preflight");
    await fs.promises.rm(path.join(root, "api/user/untracked.ms"));
    await fs.promises.rm(path.join(root, "api/user/untracked.magic.json"));

    await fs.promises.rm(path.join(root, managedEntry.path));
    let changes = await mirror.scanLocalChanges(root, managedManifest);
    assert.strictEqual(changes.deleted.length, 0);
    assert.ok(changes.invalid.some((message) => message.includes("明确删除完整资源对")));

    await fs.promises.writeFile(path.join(root, managedEntry.path), "return 1;\n", "utf8");
    await fs.promises.rm(path.join(root, managedEntry.metadataPath));
    changes = await mirror.scanLocalChanges(root, managedManifest);
    assert.strictEqual(changes.deleted.length, 0);
    assert.ok(changes.invalid.some((message) => message.includes("对应元数据")));

    await fs.promises.rm(path.join(root, managedEntry.path));
    changes = await mirror.scanLocalChanges(root, managedManifest);
    assert.deepStrictEqual(changes.deleted.map((entry) => entry.id), ["managed-id"]);

    await writeRawApiPair(root, managedEntry.path, {
      id: "managed-id",
      groupId: "api-user",
      name: "managed",
      path: "/managed",
      method: "GET"
    }, "return 1;\n");
    const symlinkTarget = path.join(os.tmpdir(), `magic-api-vscode-symlink-${process.pid}.ms`);
    await fs.promises.writeFile(symlinkTarget, "return 'outside';\n", "utf8");
    await fs.promises.rm(path.join(root, managedEntry.path));
    await fs.promises.symlink(symlinkTarget, path.join(root, managedEntry.path));
    changes = await mirror.scanLocalChanges(root, managedManifest);
    assert.ok(changes.invalid.some((message) => message.includes("符号链接")));
    await fs.promises.rm(path.join(root, managedEntry.path));
    await fs.promises.rm(symlinkTarget, { force: true });

    await writeRawApiPair(root, "api/user/new.ms", {
      name: "new",
      path: "/new",
      method: "GET"
    }, "return 2;\n");
    const createManifest = baseManifest();
    await mirror.writeManifest(root, createManifest);
    const createCandidate = await mirror.prepareNewCandidate(root, createManifest, "api/user/new.ms");
    const createClient = {
      ...baseClient,
      async saveFile() {
        return "new-id";
      },
      async getFile() {
        return {
          id: "new-id",
          groupId: "api-user",
          name: "new",
          path: "/new",
          method: "GET",
          script: "return 2;\n",
          createTime: 1
        };
      }
    };
    const createMirror = new MagicApiWorkspaceMirror({}, createClient, output);
    await createMirror.pushNewCandidate(root, createManifest, createCandidate);
    const createdManifest = await createMirror.readManifest(root);
    assert.deepStrictEqual(createdManifest.entries.map((entry) => entry.id), ["new-id"]);
    assert.strictEqual(createdManifest.pendingCreates.length, 0);
    assert.strictEqual(createdManifest.pendingCreateRequests.length, 0);
    assert.strictEqual(createdManifest.entries[0].needsCanonical, true);
    assert.strictEqual(
      createdManifest.entries[0].hash,
      await createMirror.hashEntry(root, createdManifest.entries[0])
    );
    assert.strictEqual(
      await createMirror.canReuseEntry(
        root,
        createdManifest.entries[0],
        Object.assign({}, createdManifest.entries[0]),
        createdManifest.entries[0].serverUpdateTime
      ),
      false,
      "the first incremental pull after create must download canonical metadata"
    );
    const canonicalSidecar = JSON.parse(await fs.promises.readFile(path.join(root, "api/user/new.magic.json"), "utf8"));
    assert.strictEqual(canonicalSidecar.id, undefined, "push must not overwrite local files with canonical data");

    const explorerRoot = await fs.promises.mkdtemp(path.join(os.tmpdir(), "magic-api-vscode-explorer-crud-"));
    try {
      const explorerManifest = baseManifest();
      await mirror.writeManifest(explorerRoot, explorerManifest);
      let explorerReloads = 0;
      let explorerSaveCalls = 0;
      const explorerCreateMirror = new MagicApiWorkspaceMirror({}, {
        ...baseClient,
        async getResources() {
          return resourceTree();
        },
        async saveFile(folder, entity) {
          explorerSaveCalls++;
          assert.strictEqual(folder, "api");
          assert.strictEqual(entity.groupId, "api-user");
          assert.strictEqual(entity.path, "/explorer");
          return "explorer-id";
        },
        async getFile(id) {
          return {
            id,
            groupId: "api-user",
            name: "Explorer-resource",
            path: "/explorer",
            method: "POST",
            script: "return null;\n",
            createTime: 3
          };
        },
        async reload() {
          explorerReloads++;
        }
      }, output);
      explorerCreateMirror.resolveRoot = async () => explorerRoot;
      const explorerItem = {
        kind: "group",
        folder: "api",
        raw: { node: { id: "api-user", name: "user" } }
      };
      const createdFromExplorer = await explorerCreateMirror.createResourceFromExplorer(explorerItem, {
        metadata: {
          name: "Explorer-resource",
          path: "/explorer",
          method: "POST",
          parameters: [],
          options: [],
          headers: [],
          paths: []
        },
        script: "/**\n * Explorer-resource\n */\nreturn null;\n"
      });
      assert.match(createdFromExplorer.entry.id, /^local:/);
      assert.strictEqual(createdFromExplorer.uri.fsPath, path.join(explorerRoot, "api/user/explorer.ms"));
      assert.strictEqual(explorerReloads, 0);
      assert.strictEqual(explorerSaveCalls, 0, "explorer create must remain offline until batch push");
      assert.ok(await fs.promises.stat(path.join(explorerRoot, "api/user/explorer.ms")));
      const explorerOnDisk = await explorerCreateMirror.readManifest(explorerRoot);
      assert.deepStrictEqual(explorerOnDisk.entries.map((entry) => entry.id), []);

      const repeatedExplorerCreate = await explorerCreateMirror.createResourceFromExplorer(explorerItem, {
        metadata: {
          name: "Explorer-resource",
          path: "/explorer",
          method: "POST",
          parameters: [],
          options: [],
          headers: [],
          paths: []
        },
        script: "/**\n * Explorer-resource\n */\nreturn null;\n"
      });
      assert.strictEqual(repeatedExplorerCreate.noOp, true, "repeated offline create must be idempotent");

      await writeRawApiPair(explorerRoot, "api/user/dirty.ms", {
        name: "dirty",
        path: "/dirty",
        method: "GET"
      }, "return null;\n");
      await explorerCreateMirror.createResourceFromExplorer(explorerItem, {
        metadata: { name: "blocked", path: "/blocked", method: "GET" },
        script: "return null;\n"
      });
      assert.strictEqual(explorerSaveCalls, 0, "multiple compatible local creates must remain offline");
      await fs.promises.rm(path.join(explorerRoot, "api/user/dirty.ms"));
      await fs.promises.rm(path.join(explorerRoot, "api/user/dirty.magic.json"));
      for (const name of ["explorer", "blocked"]) {
        await fs.promises.rm(path.join(explorerRoot, `api/user/${name}.ms`), { force: true });
        await fs.promises.rm(path.join(explorerRoot, `api/user/${name}.magic.json`), { force: true });
      }

      const managedExplorerEntry = await writeManagedApiPair(
        explorerRoot,
        explorerCreateMirror,
        "explorer-id",
        "api/user/explorer.ms"
      );
      const managedExplorerManifest = baseManifest();
      managedExplorerManifest.entries.push(managedExplorerEntry);
      await explorerCreateMirror.writeManifest(explorerRoot, managedExplorerManifest);

      let explorerDeleteCalls = 0;
      const explorerDeleteMirror = new MagicApiWorkspaceMirror({}, {
        ...baseClient,
        async getResources() {
          return resourceTree("explorer-id");
        },
        async deleteResource(id) {
          explorerDeleteCalls++;
          assert.strictEqual(id, "explorer-id");
          return true;
        },
        async getFile() {
          return null;
        },
        async reload() {
          explorerReloads++;
        }
      }, output);
      explorerDeleteMirror.resolveRoot = async () => explorerRoot;
      const deletedFromExplorer = await explorerDeleteMirror.deleteResourceFromExplorer({
        kind: "file",
        resource: { entity: { id: "explorer-id" } }
      });
      assert.strictEqual(deletedFromExplorer.cancelled, false);
      assert.strictEqual(explorerDeleteCalls, 1);
      assert.strictEqual(explorerReloads, 1);
      assert.strictEqual(await fileExistsForTest(path.join(explorerRoot, "api/user/explorer.ms")), false);
      assert.strictEqual((await explorerDeleteMirror.readManifest(explorerRoot)).entries.length, 0);
    } finally {
      await fs.promises.rm(explorerRoot, { recursive: true, force: true });
    }

    const explorerCancelRoot = await fs.promises.mkdtemp(path.join(os.tmpdir(), "magic-api-vscode-explorer-cancel-"));
    try {
      const cancelEntry = await writeManagedApiPair(
        explorerCancelRoot,
        mirror,
        "cancel-id",
        "api/user/cancel.ms"
      );
      const cancelManifest = baseManifest();
      cancelManifest.entries.push(cancelEntry);
      await mirror.writeManifest(explorerCancelRoot, cancelManifest);
      let deleteCalled = false;
      const cancelMirror = new MagicApiWorkspaceMirror({}, {
        ...baseClient,
        async getResources() {
          return resourceTree("cancel-id");
        },
        async deleteResource() {
          deleteCalled = true;
          return true;
        }
      }, output);
      cancelMirror.resolveRoot = async () => explorerCancelRoot;
      warningChoice = undefined;
      const cancelled = await cancelMirror.deleteResourceFromExplorer({
        kind: "file",
        resource: { entity: { id: "cancel-id" } }
      });
      assert.strictEqual(cancelled.cancelled, true);
      assert.strictEqual(deleteCalled, false);
      assert.strictEqual(await fileExistsForTest(path.join(explorerCancelRoot, cancelEntry.path)), true);
      warningChoice = "删除服务端资源";

      const responseLossMirror = new MagicApiWorkspaceMirror({}, {
        ...baseClient,
        async getResources() {
          return resourceTree("cancel-id");
        },
        async deleteResource() {
          throw new Error("response lost");
        }
      }, output);
      responseLossMirror.resolveRoot = async () => explorerCancelRoot;
      await assert.rejects(
        () => responseLossMirror.deleteResourceFromExplorer({
          kind: "file",
          resource: { entity: { id: "cancel-id" } }
        }),
        /已保留恢复记录/
      );
      const responseLossManifest = await responseLossMirror.readManifest(explorerCancelRoot);
      assert.deepStrictEqual(responseLossManifest.pendingDeletes.map((item) => item.id), ["cancel-id"]);
      assert.strictEqual(await fileExistsForTest(path.join(explorerCancelRoot, cancelEntry.path)), false);
      assert.strictEqual(await fileExistsForTest(path.join(explorerCancelRoot, cancelEntry.metadataPath)), false);
    } finally {
      await fs.promises.rm(explorerCancelRoot, { recursive: true, force: true });
    }

    await writeRawApiPair(root, "api/user/pending.ms", {
      name: "pending",
      path: "/pending",
      method: "GET"
    }, "return 3;\n");
    const pendingManifest = baseManifest();
    await mirror.writeManifest(root, pendingManifest);
    const pendingCandidate = await mirror.prepareNewCandidate(root, pendingManifest, "api/user/pending.ms");
    const pendingMirror = new MagicApiWorkspaceMirror({}, {
      ...baseClient,
      async saveFile() {
        return "pending-id";
      },
      async getFile() {
        throw new Error("network down");
      }
    }, output);
    await assert.rejects(
      () => pendingMirror.pushNewCandidate(root, pendingManifest, pendingCandidate),
      /pending-id.*canonical 读取或状态落盘失败/
    );
    const pendingOnDisk = await pendingMirror.readManifest(root);
    assert.deepStrictEqual(pendingOnDisk.pendingCreates.map((item) => item.id), ["pending-id"]);
    assert.strictEqual(pendingOnDisk.pendingCreateRequests.length, 0);
    assert.throws(() => pendingMirror.assertNoPendingCreates(pendingOnDisk), /未完成的服务端新增/);

    const requestRoot = await fs.promises.mkdtemp(path.join(os.tmpdir(), "magic-api-vscode-create-request-"));
    try {
      await writeRawApiPair(requestRoot, "api/user/unknown.ms", {
        name: "unknown",
        path: "/unknown",
        method: "GET"
      }, "return 4;\n");
      const requestManifest = baseManifest();
      await mirror.writeManifest(requestRoot, requestManifest);
      const requestCandidate = await mirror.prepareNewCandidate(
        requestRoot,
        requestManifest,
        "api/user/unknown.ms"
      );
      const requestMirror = new MagicApiWorkspaceMirror({}, {
        ...baseClient,
        async saveFile() {
          throw new Error("response lost");
        }
      }, output);
      await assert.rejects(
        () => requestMirror.pushNewCandidate(requestRoot, requestManifest, requestCandidate),
        /新增请求结果未知.*禁止直接重试/
      );
      const requestOnDisk = await requestMirror.readManifest(requestRoot);
      assert.strictEqual(requestOnDisk.pendingCreateRequests.length, 1);
      assert.strictEqual(requestOnDisk.pendingCreates.length, 0);
      assert.throws(() => requestMirror.assertNoPendingCreates(requestOnDisk), /结果未知/);

      requestMirror.resolveRoot = async () => requestRoot;
      requestMirror.client = {
        ...baseClient,
        async getResources() {
          return {
            api: {
              node: { id: "0", name: "root" },
              children: [{
                node: { id: "api-user", name: "user" },
                children: [{
                  node: {
                    id: "unknown-id",
                    groupId: "api-user",
                    name: "unknown",
                    path: "/unknown"
                  },
                  children: []
                }]
              }]
            }
          };
        },
        async getFile(id) {
          return Object.assign({}, requestCandidate.entity, { id, groupId: "api-user" });
        }
      };
      const resolvedRequest = await requestMirror.recoverAutomatically();
      assert.strictEqual(resolvedRequest.resourcesAdopted, 1);
      assert.strictEqual(resolvedRequest.groupsAdopted, 0);
      const resolvedOnDisk = await requestMirror.readManifest(requestRoot);
      assert.strictEqual(resolvedOnDisk.pendingCreateRequests.length, 0);
      assert.deepStrictEqual(resolvedOnDisk.pendingCreates.map((item) => item.id), ["unknown-id"]);
      warningChoice = "删除服务端资源";

      await writeRawApiPair(requestRoot, "api/user/rejected.ms", {
        name: "rejected",
        path: "/rejected",
        method: "GET"
      }, "return 5;\n");
      const rejectedManifest = baseManifest();
      await mirror.writeManifest(requestRoot, rejectedManifest);
      const rejectedCandidate = await mirror.prepareNewCandidate(
        requestRoot,
        rejectedManifest,
        "api/user/rejected.ms"
      );
      const businessError = new Error("path conflict");
      businessError.magicApiResponse = true;
      businessError.magicApiCode = 1009;
      const rejectedMirror = new MagicApiWorkspaceMirror({}, {
        ...baseClient,
        async saveFile() {
          throw businessError;
        }
      }, output);
      await assert.rejects(
        () => rejectedMirror.pushNewCandidate(requestRoot, rejectedManifest, rejectedCandidate),
        /服务端明确拒绝新增.*path conflict/
      );
      assert.strictEqual((await rejectedMirror.readManifest(requestRoot)).pendingCreateRequests.length, 0);

      const unknownServerError = new Error("publisher failed after write");
      unknownServerError.magicApiResponse = true;
      unknownServerError.magicApiCode = -1;
      const unknownServerMirror = new MagicApiWorkspaceMirror({}, {
        ...baseClient,
        async saveFile() {
          throw unknownServerError;
        }
      }, output);
      await assert.rejects(
        () => unknownServerMirror.pushNewCandidate(requestRoot, rejectedManifest, rejectedCandidate),
        /新增请求结果未知/
      );
      assert.strictEqual((await unknownServerMirror.readManifest(requestRoot)).pendingCreateRequests.length, 1);

      await writeRawApiPair(requestRoot, "api/user/absent.ms", {
        name: "absent",
        path: "/absent",
        method: "GET"
      }, "return 6;\n");
      const absentManifest = baseManifest();
      await mirror.writeManifest(requestRoot, absentManifest);
      const absentCandidate = await mirror.prepareNewCandidate(
        requestRoot,
        absentManifest,
        "api/user/absent.ms"
      );
      const absentMirror = new MagicApiWorkspaceMirror({}, {
        ...baseClient,
        async saveFile() {
          throw new Error("offline");
        }
      }, output);
      await assert.rejects(
        () => absentMirror.pushNewCandidate(requestRoot, absentManifest, absentCandidate),
        /新增请求结果未知/
      );
      absentMirror.resolveRoot = async () => requestRoot;
      absentMirror.client = {
        ...baseClient,
        async getResources() {
          return resourceTree();
        }
      };
      await assert.rejects(
        () => absentMirror.recoverAutomatically(),
        (error) => error.code === "blocked" && Array.isArray(error.details) &&
          error.details.some((item) => item.reason === "no-unique-match")
      );
      assert.strictEqual((await absentMirror.readManifest(requestRoot)).pendingCreateRequests.length, 1);
      warningChoice = "已确认未创建，允许重试";
      const clearedRequest = await absentMirror.resolvePendingCreateRequestsInteractively();
      assert.deepStrictEqual(clearedRequest, { adopted: 0, cleared: 1, unresolved: 0 });
      assert.strictEqual((await absentMirror.readManifest(requestRoot)).pendingCreateRequests.length, 0);
      warningChoice = "删除服务端资源";
    } finally {
      await fs.promises.rm(requestRoot, { recursive: true, force: true });
    }

    const updateRoot = await fs.promises.mkdtemp(path.join(os.tmpdir(), "magic-api-vscode-update-"));
    try {
      const updateEntry = await writeManagedApiPair(updateRoot, mirror, "update-id", "api/user/update.ms");
      const updateManifest = baseManifest();
      updateManifest.entries.push(updateEntry);
      await mirror.writeManifest(updateRoot, updateManifest);
      await fs.promises.writeFile(path.join(updateRoot, updateEntry.path), "return 2;\n", "utf8");
      const updateMirror = new MagicApiWorkspaceMirror({}, {
        ...baseClient,
        async saveFile(folder, entity) {
          assert.strictEqual(entity.script, "return 2;\n");
          await fs.promises.writeFile(path.join(updateRoot, updateEntry.path), "return 99;\n", "utf8");
          return "update-id";
        },
        async getFile() {
          return {
            id: "update-id",
            groupId: "api-user",
            name: "update",
            path: "/update",
            method: "GET",
            script: "return 2;\n",
            updateTime: 2
          };
        }
      }, output);
      await updateMirror.pushEntry(updateRoot, updateManifest, updateEntry);
      assert.strictEqual(await fs.promises.readFile(path.join(updateRoot, updateEntry.path), "utf8"), "return 99;\n");
      assert.notStrictEqual(updateEntry.hash, await updateMirror.hashEntry(updateRoot, updateEntry));
      assert.strictEqual(updateEntry.needsCanonical, true);
      assert.strictEqual(
        await updateMirror.canReuseEntry(
          updateRoot,
          updateEntry,
          Object.assign({}, updateEntry),
          updateEntry.serverUpdateTime
        ),
        false
      );
    } finally {
      await fs.promises.rm(updateRoot, { recursive: true, force: true });
    }

    const deleteRoot = await fs.promises.mkdtemp(path.join(os.tmpdir(), "magic-api-vscode-delete-"));
    try {
      const deleteEntry = await writeManagedApiPair(deleteRoot, mirror, "delete-id", "api/user/delete.ms");
      const deleteManifest = baseManifest();
      deleteManifest.entries.push(deleteEntry);
      await fs.promises.rm(path.join(deleteRoot, deleteEntry.path));
      await fs.promises.rm(path.join(deleteRoot, deleteEntry.metadataPath));
      await mirror.writeManifest(deleteRoot, deleteManifest);
      let treeCall = 0;
      const deleteMirror = new MagicApiWorkspaceMirror({}, {
        ...baseClient,
        async getResources() {
          treeCall++;
          return treeCall === 1 ? resourceTree("delete-id") : resourceTree();
        },
        async deleteResource(id) {
          assert.strictEqual(id, "delete-id");
          return true;
        },
        async getFile(id) {
          assert.strictEqual(id, "delete-id");
          return null;
        }
      }, output);
      const deleteResult = await deleteMirror.deleteEntries(deleteRoot, deleteManifest, [deleteEntry]);
      assert.strictEqual(deleteResult.deleted, 1);
      assert.strictEqual((await deleteMirror.readManifest(deleteRoot)).entries.length, 0);

      const omittedDataManifest = baseManifest();
      const omittedDataEntry = Object.assign({}, deleteEntry, { id: "omitted-data-id" });
      omittedDataManifest.entries.push(omittedDataEntry);
      await deleteMirror.writeManifest(deleteRoot, omittedDataManifest);
      const omittedDataMirror = new MagicApiWorkspaceMirror({}, {
        ...baseClient,
        async getResources() {
          return resourceTree("omitted-data-id");
        },
        async deleteResource() {
          return true;
        },
        async getFile() {
          return undefined;
        }
      }, output);
      const omittedDataResult = await omittedDataMirror.deleteEntries(
        deleteRoot,
        omittedDataManifest,
        [omittedDataEntry]
      );
      assert.strictEqual(omittedDataResult.deleted, 1, "omitted JsonBean data must mean the file is missing");
      assert.strictEqual((await omittedDataMirror.readManifest(deleteRoot)).pendingDeletes.length, 0);

      const existsManifest = baseManifest();
      const existsEntry = Object.assign({}, deleteEntry, { id: "exists-id" });
      existsManifest.entries.push(existsEntry);
      await deleteMirror.writeManifest(deleteRoot, existsManifest);
      const existsMirror = new MagicApiWorkspaceMirror({}, {
        ...baseClient,
        async getResources() {
          return resourceTree("exists-id");
        },
        async deleteResource() {
          return true;
        },
        async getFile() {
          return { id: "exists-id", groupId: "api-user" };
        }
      }, output);
      const existsResult = await existsMirror.deleteEntries(deleteRoot, existsManifest, [existsEntry]);
      assert.strictEqual(existsResult.failed, 1);
      const existsOnDisk = await existsMirror.readManifest(deleteRoot);
      assert.deepStrictEqual(existsOnDisk.pendingDeletes.map((item) => item.id), ["exists-id"]);
      assert.deepStrictEqual(existsOnDisk.entries.map((item) => item.id), ["exists-id"]);

      const unsafeManifest = baseManifest();
      const unsafeEntry = Object.assign({}, deleteEntry, { id: "api-user" });
      unsafeManifest.entries.push(unsafeEntry);
      await deleteMirror.writeManifest(deleteRoot, unsafeManifest);
      let unsafeDeleteCalled = false;
      const unsafeMirror = new MagicApiWorkspaceMirror({}, {
        ...baseClient,
        async getResources() {
          return resourceTree();
        },
        async deleteResource() {
          unsafeDeleteCalled = true;
          return true;
        }
      }, output);
      const unsafeResult = await unsafeMirror.deleteEntries(deleteRoot, unsafeManifest, [unsafeEntry]);
      assert.strictEqual(unsafeResult.failed, 1);
      assert.strictEqual(unsafeDeleteCalled, false);
      assert.strictEqual((await unsafeMirror.readManifest(deleteRoot)).entries.length, 1);

      const recoveryManifest = baseManifest();
      const recoveryEntry = Object.assign({}, deleteEntry, { id: "recovery-id" });
      recoveryManifest.entries.push(recoveryEntry);
      await mirror.writeManifest(deleteRoot, recoveryManifest);
      let recoveryTreeCall = 0;
      const recoveryMirror = new MagicApiWorkspaceMirror({}, {
        ...baseClient,
        async getResources() {
          recoveryTreeCall++;
          if (recoveryTreeCall === 1) {
            return resourceTree("recovery-id");
          }
          throw new Error("verification unavailable");
        },
        async deleteResource() {
          return true;
        },
        async getFile() {
          throw new Error("verification unavailable");
        }
      }, output);
      const recoveryResult = await recoveryMirror.deleteEntries(deleteRoot, recoveryManifest, [recoveryEntry]);
      assert.strictEqual(recoveryResult.failed, 1);
      const recoveryOnDisk = await recoveryMirror.readManifest(deleteRoot);
      assert.deepStrictEqual(recoveryOnDisk.pendingDeletes.map((item) => item.id), ["recovery-id"]);
      await recoveryMirror.reconcilePendingDeletes(deleteRoot, recoveryOnDisk);
      const stillPending = await recoveryMirror.readManifest(deleteRoot);
      assert.deepStrictEqual(stillPending.pendingDeletes.map((item) => item.id), ["recovery-id"]);
      assert.deepStrictEqual(stillPending.entries.map((item) => item.id), ["recovery-id"]);
      recoveryMirror.client = {
        ...baseClient,
        async getFile(id) {
          assert.strictEqual(id, "recovery-id");
          return null;
        }
      };
      await recoveryMirror.reconcilePendingDeletes(deleteRoot, stillPending);
      const recovered = await recoveryMirror.readManifest(deleteRoot);
      assert.strictEqual(recovered.pendingDeletes.length, 0);
      assert.strictEqual(recovered.entries.length, 0);

      const lostManifest = baseManifest();
      const lostEntry = Object.assign({}, deleteEntry, { id: "lost-response-id" });
      lostManifest.entries.push(lostEntry);
      await mirror.writeManifest(deleteRoot, lostManifest);
      const lostMirror = new MagicApiWorkspaceMirror({}, {
        ...baseClient,
        async getResources() {
          return resourceTree("lost-response-id");
        },
        async deleteResource() {
          throw new Error("response lost");
        }
      }, output);
      const lostResult = await lostMirror.deleteEntries(deleteRoot, lostManifest, [lostEntry]);
      assert.strictEqual(lostResult.failed, 1);
      const lostOnDisk = await lostMirror.readManifest(deleteRoot);
      assert.deepStrictEqual(lostOnDisk.pendingDeletes.map((item) => item.id), ["lost-response-id"]);
      lostMirror.client = {
        ...baseClient,
        async getFile() {
          return undefined;
        }
      };
      await lostMirror.reconcilePendingDeletes(deleteRoot, lostOnDisk);
      assert.strictEqual((await lostMirror.readManifest(deleteRoot)).entries.length, 0);
    } finally {
      await fs.promises.rm(deleteRoot, { recursive: true, force: true });
    }

    const mixedRoot = await fs.promises.mkdtemp(path.join(os.tmpdir(), "magic-api-vscode-mixed-"));
    try {
      const deletedEntry = await writeManagedApiPair(mixedRoot, mirror, "move-id", "api/user/old.ms");
      const mixedManifest = baseManifest();
      mixedManifest.entries.push(deletedEntry);
      await mirror.writeManifest(mixedRoot, mixedManifest);
      await fs.promises.rm(path.join(mixedRoot, deletedEntry.path));
      await fs.promises.rm(path.join(mixedRoot, deletedEntry.metadataPath));
      await writeRawApiPair(mixedRoot, "api/user/renamed.ms", {
        name: "renamed",
        path: "/renamed",
        method: "GET"
      }, "return 1;\n");
      let mixedRemoteWrite = false;
      const mixedMirror = new MagicApiWorkspaceMirror({}, {
        ...baseClient,
        async saveFile() {
          mixedRemoteWrite = true;
          return "unexpected";
        },
        async deleteResource() {
          mixedRemoteWrite = true;
          return true;
        }
      }, output);
      mixedMirror.resolveRoot = async () => mixedRoot;
      await assert.rejects(() => mixedMirror.pushChanged(), /本地工作区预检失败/);
      assert.strictEqual(mixedRemoteWrite, false, "mixed create/delete must fail before remote side effects");
    } finally {
      await fs.promises.rm(mixedRoot, { recursive: true, force: true });
    }

    const snapshot = await mirror.createPullSnapshot(root, await mirror.readManifest(root));
    await fs.promises.appendFile(path.join(root, "api/user/pending.ms"), "// changed\n", "utf8");
    await assert.rejects(
      () => mirror.assertSnapshotUnchanged(root, "api/user/pending.ms", snapshot),
      /拉取期间发生变化/
    );

    const order = [];
    await Promise.all([
      mirror.runExclusive(async () => {
        order.push("first-start");
        await new Promise((resolve) => setTimeout(resolve, 10));
        order.push("first-end");
      }),
      mirror.runExclusive(async () => order.push("second"))
    ]);
    assert.deepStrictEqual(order, ["first-start", "first-end", "second"]);

    const manifestSymlinkRoot = await fs.promises.mkdtemp(path.join(os.tmpdir(), "magic-api-vscode-manifest-link-"));
    const externalManifest = path.join(os.tmpdir(), `magic-api-vscode-manifest-${process.pid}.json`);
    try {
      await fs.promises.mkdir(path.join(manifestSymlinkRoot, ".magic-api"), { recursive: true });
      await fs.promises.writeFile(externalManifest, `${JSON.stringify(baseManifest())}\n`, "utf8");
      await fs.promises.symlink(externalManifest, path.join(manifestSymlinkRoot, ".magic-api", "manifest.json"));
      await assert.rejects(() => mirror.readManifest(manifestSymlinkRoot), /符号链接/);
    } finally {
      await fs.promises.rm(manifestSymlinkRoot, { recursive: true, force: true });
      await fs.promises.rm(externalManifest, { force: true });
    }

    const realWorkspaceRoot = await fs.promises.mkdtemp(path.join(os.tmpdir(), "magic-api-vscode-real-root-"));
    const linkedWorkspaceRoot = `${realWorkspaceRoot}-link`;
    try {
      await fs.promises.symlink(realWorkspaceRoot, linkedWorkspaceRoot, "dir");
      await assert.rejects(() => mirror.assertWorkspaceRoot(linkedWorkspaceRoot), /根路径不允许包含符号链接/);
      await fs.promises.mkdir(path.join(realWorkspaceRoot, "nested"));
      await assert.rejects(
        () => mirror.assertWorkspaceRoot(path.join(linkedWorkspaceRoot, "nested")),
        /根路径不允许包含符号链接/
      );
    } finally {
      await fs.promises.rm(linkedWorkspaceRoot, { force: true });
      await fs.promises.rm(realWorkspaceRoot, { recursive: true, force: true });
    }
  } finally {
    warningChoice = undefined;
    await fs.promises.rm(root, { recursive: true, force: true });
  }
}

async function writeManagedApiPair(root, mirror, id, sourcePath) {
  const metadataPath = sourcePath.replace(/\.ms$/, ".magic.json");
  await writeRawApiPair(root, sourcePath, {
    id,
    groupId: "api-user",
    name: path.basename(sourcePath, ".ms"),
    path: `/${path.basename(sourcePath, ".ms")}`,
    method: "GET",
    updateTime: 1
  }, "return 1;\n");
  const entry = {
    id,
    folder: "api",
    groupId: "api-user",
    type: "script",
    path: sourcePath,
    metadataPath,
    name: path.basename(sourcePath, ".ms"),
    serverUpdateTime: 1
  };
  entry.hash = await mirror.hashEntry(root, entry);
  return entry;
}

async function writeRawApiPair(root, sourcePath, metadata, script) {
  const metadataPath = sourcePath.replace(/\.ms$/, ".magic.json");
  await fs.promises.mkdir(path.dirname(path.join(root, sourcePath)), { recursive: true });
  await fs.promises.writeFile(path.join(root, sourcePath), script, "utf8");
  await fs.promises.writeFile(path.join(root, metadataPath), `${JSON.stringify(metadata, null, 2)}\n`, "utf8");
}

async function fileExistsForTest(filePath) {
  try {
    await fs.promises.access(filePath);
    return true;
  } catch (error) {
    return false;
  }
}

function resourceTree(fileId) {
  const children = [];
  if (fileId) {
    children.push({ node: { id: fileId, groupId: "api-user", name: "resource" }, children: [] });
  }
  return {
    api: {
      node: { id: "0", name: "root" },
      children: [{ node: { id: "api-user", name: "user" }, children }]
    }
  };
}

function groupResourceTree(groups) {
  const byParent = new Map();
  for (const group of groups || []) {
    const children = byParent.get(group.parentId) || [];
    children.push(group);
    byParent.set(group.parentId, children);
  }
  const build = (group) => ({
    node: Object.assign({}, group),
    children: (byParent.get(group.id) || []).map(build)
  });
  return {
    api: {
      node: { id: "0", name: "root" },
      children: (byParent.get("0") || []).map(build)
    }
  };
}
