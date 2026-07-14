"use strict";

const crypto = require("crypto");
const fs = require("fs");
const path = require("path");
const vscode = require("vscode");
const { MagicApiClient, normalizeServerUrl } = require("./src/client");
const { SkillRequestBridge } = require("./src/skillRequestBridge");
const { AiSkillManager } = require("./src/skillManager");
const { WorkspaceConnectionStore } = require("./src/workspaceConnection");
const { registerMagicScriptLanguageFeatures } = require("./src/language");
const { openApiRunnerPanel } = require("./src/views/apiRunner");
const {
  renderMetadataEditorHtml,
  metadataEditorPayloadToEntity
} = require("./src/views/metadataEditor");
const {
  MANIFEST_VERSION,
  PATH_RESOURCE_TYPES,
  SERVER_OWNED_FIELDS,
  WorkspaceOperations,
  buildNewResourceEntity,
  defaultMetadata,
  describeResourcePath,
  discoverUntrackedResourceRecords,
  groupPathSegment,
  metadataPathForScript,
  normalizeGroupPath,
  normalizeRelativePath,
  normalizeResourcePath,
  resolveGroupId,
  resourceIdsFromTree,
  sanitizePathSegment,
  sourcePathForMetadata,
  toPosixPath,
  validateExistingEntity,
  validateResourceName
} = require("./src/workspaceSync");

const SCHEME = "magic-api";
const WORKSPACE_META_DIR = ".magic-api";
const WORKSPACE_MANIFEST = "manifest.json";
const WORKSPACE_SERVER = "server.json";
const WORKSPACE_GROUPS_DIR = "groups";

function activate(context) {
  const output = vscode.window.createOutputChannel("magic-api");
  const connectionStore = new WorkspaceConnectionStore(context, vscode);
  const client = new MagicApiClient(context, output, vscode, connectionStore);
  const fileSystem = new MagicApiFileSystemProvider(client, output);
  const workspaceMirror = new MagicApiWorkspaceMirror(context, client, output);
  const skillManager = new AiSkillManager({
    context,
    vscode,
    output,
    extensionPath: context.extensionPath
  });
  const skillRequestBridge = new SkillRequestBridge({
    client,
    output,
    resolveRoot: () => workspaceMirror.resolveRoot(),
    workspaceMirror,
    vscode,
    promptLogin: () => login(client),
    promptSetToken: () => promptSetToken(client),
    skillManager
  });
  const treeProvider = new MagicApiTreeDataProvider(client, fileSystem, workspaceMirror, output);
  const statusBar = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 100);

  statusBar.command = "magicApi.configureServer";
  statusBar.text = "$(plug) magic-api";
  statusBar.tooltip = "Configure magic-api server";
  statusBar.show();

  context.subscriptions.push(output, statusBar, skillRequestBridge);
  const registerWorkspaceCommand = (command, handler) =>
    vscode.commands.registerCommand(command, async (...args) => {
      if (!client.hasWorkspace()) {
        vscode.window.showWarningMessage("请先打开一个 VS Code 工作区；magic-api 连接和登录状态按工作区隔离。");
        return undefined;
      }
      return handler(...args);
    });
  const updateLocalFileContext = async (editor) => {
    try {
      const active = Boolean(editor && await workspaceMirror.isManagedUri(editor.document.uri));
      await vscode.commands.executeCommand("setContext", "magicApi.localFileActive", active);
    } catch (error) {
      await vscode.commands.executeCommand("setContext", "magicApi.localFileActive", false);
    }
  };
  context.subscriptions.push(
    vscode.window.onDidChangeActiveTextEditor((editor) => {
      updateLocalFileContext(editor);
    })
  );
  updateLocalFileContext(vscode.window.activeTextEditor);
  context.subscriptions.push(
    vscode.workspace.onDidSaveTextDocument(async (document) => {
      if (!client.hasWorkspace()) {
        return;
      }
      if (!connectionStore.getBehaviorSetting("syncOnSave", true)) {
        return;
      }
      try {
        const result = await workspaceMirror.pushDocumentIfManaged(document);
        if (result && result.created) {
          client.clearCache();
          await treeProvider.refresh();
          await updateLocalFileContext(vscode.window.activeTextEditor);
        }
      } catch (error) {
        output.appendLine(formatError(error));
        vscode.window.showErrorMessage(`magic-api 自动推送失败：${messageOf(error)}`);
      }
    })
  );
  context.subscriptions.push(
    vscode.workspace.registerFileSystemProvider(SCHEME, fileSystem, {
      isCaseSensitive: true,
      isReadonly: true
    })
  );
  context.subscriptions.push(
    vscode.window.registerTreeDataProvider("magicApiExplorer", treeProvider)
  );
  const languageFeatures = registerMagicScriptLanguageFeatures({ vscode, client, output, workspaceMirror });
  context.subscriptions.push(languageFeatures);

  const refreshConnectionState = async () => {
    client.clearCache();
    fileSystem.clearCache();
    languageFeatures.clearCache();
    await treeProvider.refresh();
    await updateLocalFileContext(vscode.window.activeTextEditor);
    await skillRequestBridge.refresh();
  };
  context.subscriptions.push(
    vscode.workspace.onDidChangeConfiguration((event) => {
      if (event.affectsConfiguration("magicApi.serverUrl") || event.affectsConfiguration("magicApi.workspaceDir")) {
        refreshConnectionState().catch((error) => output.appendLine(formatError(error)));
      }
    }),
    vscode.workspace.onDidChangeWorkspaceFolders(() => {
      refreshConnectionState().catch((error) => output.appendLine(formatError(error)));
    })
  );

  context.subscriptions.push(
    registerWorkspaceCommand("magicApi.configureServer", async () => {
      const current = client.getServerUrl();
      const serverUrl = await vscode.window.showInputBox({
        title: "magic-api server URL",
        prompt: "Enter the magic-api web workbench URL.",
        value: current,
        placeHolder: "http://localhost:9999/magic/web"
      });
      if (!serverUrl) {
        return;
      }
      await connectionStore.setServerUrl(serverUrl);
      await refreshConnectionState();
      vscode.window.showInformationMessage(`magic-api server set to ${normalizeServerUrl(serverUrl)}`);
    }),
    registerWorkspaceCommand("magicApi.login", async () => {
      await login(client);
      await refreshConnectionState();
    }),
    registerWorkspaceCommand("magicApi.setToken", async () => {
      const saved = await promptSetToken(client);
      if (!saved) {
        return;
      }
      await refreshConnectionState();
      vscode.window.showInformationMessage("Magic-Token 已保存。");
    }),
    registerWorkspaceCommand("magicApi.clearToken", async () => {
      await client.clearToken();
      await refreshConnectionState();
      vscode.window.showInformationMessage("magic-api 登录状态已清除。");
    }),
    registerWorkspaceCommand("magicApi.refreshResources", async () => {
      await refreshConnectionState();
    }),
    registerWorkspaceCommand("magicApi.syncWorkspace", async () => {
      const result = await workspaceMirror.pullAll({ full: false });
      if (result.cancelled) {
        return;
      }
      client.clearCache();
      await treeProvider.refresh();
      await updateLocalFileContext(vscode.window.activeTextEditor);
      await skillRequestBridge.refresh();
      vscode.window.showInformationMessage(
        `magic-api 增量同步完成：总计 ${result.count}，下载 ${result.downloaded}，复用 ${result.reused}。`
      );
    }),
    registerWorkspaceCommand("magicApi.pullWorkspace", async () => {
      const result = await workspaceMirror.pullAll({ full: true });
      if (result.cancelled) {
        return;
      }
      client.clearCache();
      await treeProvider.refresh();
      await updateLocalFileContext(vscode.window.activeTextEditor);
      await skillRequestBridge.refresh();
      vscode.window.showInformationMessage(
        `magic-api 已全量拉取 ${result.count} 个资源到 ${result.root}。`
      );
    }),
    registerWorkspaceCommand("magicApi.pushCurrentLocalFile", async () => {
      const editor = vscode.window.activeTextEditor;
      if (!editor) {
        vscode.window.showWarningMessage("请先打开一个本地 magic-api 镜像文件。");
        return;
      }
      if (editor.document.isDirty) {
        await editor.document.save();
      }
      const pushed = await workspaceMirror.pushUri(editor.document.uri);
      if (pushed && pushed.pushed) {
        client.clearCache();
        await treeProvider.refresh();
        await updateLocalFileContext(vscode.window.activeTextEditor);
        vscode.window.showInformationMessage(`magic-api 已推送 ${pushed.path}.`);
      } else if (pushed && pushed.skipped) {
        vscode.window.showInformationMessage(`magic-api 无需推送，${pushed.path} 没有本地变更。`);
      }
    }),
    registerWorkspaceCommand("magicApi.pushWorkspace", async () => {
      const result = await workspaceMirror.pushChanged();
      client.clearCache();
      await treeProvider.refresh();
      await updateLocalFileContext(vscode.window.activeTextEditor);
      const extra = [
        result.skipped ? `跳过 ${result.skipped}` : "",
        result.conflicts ? `冲突 ${result.conflicts}` : "",
        result.failed ? `失败 ${result.failed}` : "",
        result.pendingPaths && result.pendingPaths.length ? `待处理 ${result.pendingPaths.length}` : ""
      ].filter(Boolean).join("，");
      vscode.window.showInformationMessage(
        `magic-api 推送完成：分组新增 ${result.groupsCreated || 0}，资源新增 ${result.created}，修改 ${result.updated}，删除 ${result.deleted}${extra ? `，${extra}` : ""}。`
      );
    }),
    registerWorkspaceCommand("magicApi.resolvePendingCreateRequests", async () => {
      const result = await workspaceMirror.resolvePendingCreateRequestsInteractively();
      if (result && (result.adopted || result.cleared)) {
        vscode.window.showInformationMessage(
          `新增预请求处理完成：采用服务端资源 ${result.adopted}，确认未创建 ${result.cleared}，仍待确认 ${result.unresolved}。`
        );
      }
    }),
    registerWorkspaceCommand("magicApi.openResource", async (item) => {
      if (!item || !item.resource || !item.resource.entity || !item.resource.entity.id) {
        vscode.window.showWarningMessage("Select a saved magic-api resource first.");
        return;
      }
      const uri = await workspaceMirror.openResource(item.resource.folder, item.resource.entity);
      const document = await vscode.workspace.openTextDocument(uri);
      const editor = await vscode.window.showTextDocument(document, { preview: false });
      await updateLocalFileContext(editor);
    }),
    registerWorkspaceCommand("magicApi.createResourceFromExplorer", async (item) => {
      if (!item) {
        const folder = await vscode.window.showQuickPick(await treeProvider.getCreatableFolders(), {
          title: "新增 magic-api 资源",
          placeHolder: "选择资源类型",
          ignoreFocusOut: true
        });
        if (!folder) {
          return;
        }
        item = { kind: "root", folder };
      }
      let initialGroupPath = "";
      if (item.kind === "group" && item.raw && item.raw.node) {
        initialGroupPath = await treeProvider.getGroupPath(item.raw.node.id);
      }
      const definition = await promptExplorerResourceDefinition(item.folder, initialGroupPath);
      if (!definition) {
        return;
      }
      const result = await workspaceMirror.createResourceFromExplorer(item, definition);
      await refreshConnectionState();
      const document = await vscode.workspace.openTextDocument(result.uri);
      const editor = await vscode.window.showTextDocument(document, { preview: false });
      await updateLocalFileContext(editor);
      await treeProvider.refresh();
      vscode.window.showInformationMessage(`magic-api 已在本地暂存资源 ${result.entry.name}，请执行“推送本地全部变更”。`);
    }),
    registerWorkspaceCommand("magicApi.deleteResourceFromExplorer", async (item) => {
      const result = await workspaceMirror.deleteResourceFromExplorer(item);
      if (!result || result.cancelled) {
        return;
      }
      await refreshConnectionState();
      vscode.window.showInformationMessage(`magic-api 已删除资源 ${result.entry.name || result.entry.id}。`);
    }),
    registerWorkspaceCommand("magicApi.saveCurrentResource", async () => {
      const editor = vscode.window.activeTextEditor;
      if (!editor) {
        vscode.window.showWarningMessage("请先打开一个 magic-api 本地工作区文件。");
        return;
      }
      if (editor.document.isDirty) {
        await editor.document.save();
      }
      await workspaceMirror.pushUri(editor.document.uri);
    }),
    registerWorkspaceCommand("magicApi.openMetadataEditor", async (item) => {
      await workspaceMirror.openMetadataEditor(item);
    }),
    registerWorkspaceCommand("magicApi.runCurrentApi", async (item) => {
      await runCurrentApi(item, client, fileSystem, workspaceMirror, treeProvider, output);
    }),
    registerWorkspaceCommand("magicApi.showCurrentMetadata", async () => {
      const editor = vscode.window.activeTextEditor;
      if (!editor) {
        vscode.window.showWarningMessage("Open a magic-api resource first.");
        return;
      }
      if (await workspaceMirror.isManagedUri(editor.document.uri)) {
        await workspaceMirror.openMetadataEditor(editor.document.uri);
        return;
      }
      if (editor.document.uri.scheme === SCHEME) {
        const entity = await fileSystem.getEntity(editor.document.uri);
        const metadata = cloneWithoutScript(entity);
        const document = await vscode.workspace.openTextDocument({
          language: "json",
          content: JSON.stringify(metadata, null, 2)
        });
        await vscode.window.showTextDocument(document, { preview: true });
        return;
      }
      vscode.window.showWarningMessage("当前文件不是 magic-api 资源。");
    }),
    registerWorkspaceCommand("magicApi.openInWorkbench", async () => {
      await vscode.env.openExternal(vscode.Uri.parse(client.getServerUrl()));
    }),
    vscode.commands.registerCommand("magicApi.installAiSkills", async () => {
      await skillManager.installInteractively();
    })
  );

  treeProvider.refresh().catch((error) => {
    output.appendLine(formatError(error));
  });
  skillRequestBridge.refresh().catch((error) => {
    output.appendLine(formatError(error));
  });
  skillManager.autoUpdate().catch((error) => {
    output.appendLine(`[magic-api] AI Skills 自动更新检查失败：${formatError(error)}`);
  });
}

function deactivate() {}

async function promptExplorerResourceDefinition(folder, initialGroupPath = "") {
  const supported = new Set(["api", "function", "datasource", "task", "script", "component"]);
  if (!supported.has(folder)) {
    vscode.window.showWarningMessage(`当前资源类型 ${folder || "<未知>"} 不支持在资源管理器中新增。`);
    return undefined;
  }
  const ask = async (title, prompt, value, placeHolder, validator) => {
    const answer = await vscode.window.showInputBox({
      title,
      prompt,
      value,
      placeHolder,
      ignoreFocusOut: true,
      validateInput(input) {
        if (!input || !input.trim()) {
          return "此项不能为空。";
        }
        if (validator) {
          try {
            validator(input.trim());
          } catch (error) {
            return messageOf(error);
          }
        }
        return undefined;
      }
    });
    return answer === undefined ? undefined : answer.trim();
  };
  const typeName = displayFolderName(folder);
  const name = await ask(`新增 ${typeName}`, `${typeName} 名称`, "", undefined, validateResourceName);
  if (name === undefined) {
    return undefined;
  }
  const baseName = sanitizePathSegment(name);
  const metadata = defaultMetadata(folder, baseName);
  metadata.name = name;

  if (folder === "datasource") {
    const key = await ask("新增数据源", "数据源 key", baseName);
    if (key === undefined) {
      return undefined;
    }
    const url = await ask("新增数据源", "JDBC URL", "", "jdbc:mysql://localhost:3306/database");
    if (url === undefined) {
      return undefined;
    }
    metadata.key = key;
    metadata.url = url;
    return { metadata };
  }

  const groupPath = await ask(
    `新增 ${typeName}`,
    "目标分组路径（例如 admin/user，缺失层级会在本地暂存）",
    initialGroupPath,
    "admin/user",
    normalizeGroupPath
  );
  if (groupPath === undefined) {
    return undefined;
  }

  const defaultPath = defaultMetadata(folder, baseName).path;
  const resourcePath = await ask(
    `新增 ${typeName}`,
    "资源 path（支持如 user/profile/get 的嵌套路径）",
    defaultPath,
    undefined,
    (value) => normalizeResourcePath(folder, value)
  );
  if (resourcePath === undefined) {
    return undefined;
  }
  metadata.path = resourcePath;
  if (folder === "api") {
    const method = await vscode.window.showQuickPick(["GET", "POST", "PUT", "DELETE", "PATCH"], {
      title: "新增 API",
      placeHolder: "选择 HTTP 方法",
      ignoreFocusOut: true
    });
    if (!method) {
      return undefined;
    }
    metadata.method = method;
  } else if (folder === "task") {
    const cron = await ask("新增定时任务", "Cron 表达式", metadata.cron);
    if (cron === undefined) {
      return undefined;
    }
    metadata.cron = cron;
  }
  return {
    metadata,
    groupPath,
    script: `/**\n * ${name}\n *\n * ${typeName}，由 magic-api VS Code 资源管理器创建。\n */\nreturn null;\n`
  };
}

async function runCurrentApi(item, client, fileSystem, workspaceMirror, treeProvider, output) {
  let folder;
  let entity;
  if (item && item.resource && item.resource.entity) {
    folder = item.resource.folder;
    entity = item.resource.entity.id
      ? await client.getFile(item.resource.entity.id)
      : item.resource.entity;
  } else {
    const editor = vscode.window.activeTextEditor;
    if (!editor) {
      vscode.window.showWarningMessage("请先打开一个 magic-api API 资源。");
      return;
    }
    if (await workspaceMirror.isManagedUri(editor.document.uri)) {
      const resource = await workspaceMirror.getResourceForUri(editor.document.uri);
      folder = resource.folder;
      entity = resource.entity;
    } else if (editor.document.uri.scheme === SCHEME) {
      const parsed = parseMagicApiUri(editor.document.uri);
      folder = parsed.folder;
      entity = await fileSystem.getEntity(editor.document.uri);
    } else {
      vscode.window.showWarningMessage("请先打开一个 magic-api API 资源。");
      return;
    }
  }
  if (folder !== "api" || !entity || !entity.path) {
    vscode.window.showWarningMessage("当前资源不是 API，暂时不能运行。");
    return;
  }

  const defaultUrl = await buildApiRequestUrl(client, treeProvider, entity);
  await openApiRunnerPanel({ vscode, client, entity, defaultUrl, output, helpers: { formatError, messageOf, prettifyResponseBody } });
}

async function login(client) {
  const savedUsername = await client.getUsername();
  const username = await vscode.window.showInputBox({
    title: "magic-api login",
    prompt: "Username",
    value: savedUsername,
    ignoreFocusOut: true
  });
  if (username === undefined) {
    return;
  }
  const password = await vscode.window.showInputBox({
    title: "magic-api login",
    prompt: "Password",
    password: true,
    ignoreFocusOut: true
  });
  if (password === undefined) {
    return;
  }
  await client.login(username, password);
  vscode.window.showInformationMessage("magic-api login succeeded.");
}

async function promptSetToken(client) {
  const token = await vscode.window.showInputBox({
    title: "magic-api Magic-Token",
    prompt: "粘贴从 magic-api Web 工作台获取到的 Magic-Token。",
    password: true,
    ignoreFocusOut: true
  });
  if (!token) {
    return false;
  }
  await client.setToken(token.trim());
  return true;
}

class MagicApiFileSystemProvider {
  constructor(client, output) {
    this.client = client;
    this.output = output;
    this.entities = new Map();
    this.onDidChangeFileEmitter = new vscode.EventEmitter();
    this.onDidChangeFile = this.onDidChangeFileEmitter.event;
  }

  watch() {
    return new vscode.Disposable(() => {});
  }

  clearCache() {
    this.entities.clear();
  }

  async stat(uri) {
    const parsed = parseMagicApiUri(uri);
    if (!parsed.id) {
      return {
        type: vscode.FileType.Directory,
        ctime: 0,
        mtime: Date.now(),
        size: 0
      };
    }
    const entity = await this.getEntity(uri);
    return {
      type: vscode.FileType.File,
      ctime: entity.createTime || 0,
      mtime: entity.updateTime || entity.createTime || Date.now(),
      size: Buffer.byteLength(this.entityToDocumentText(parsed.folder, entity))
    };
  }

  readDirectory() {
    return [];
  }

  createDirectory() {
    throw vscode.FileSystemError.NoPermissions("Creating magic-api folders from VS Code is not supported yet.");
  }

  delete() {
    throw vscode.FileSystemError.NoPermissions("Deleting magic-api resources from VS Code is not supported yet.");
  }

  rename() {
    throw vscode.FileSystemError.NoPermissions("Renaming magic-api resources from VS Code is not supported yet.");
  }

  async readFile(uri) {
    const parsed = parseMagicApiUri(uri);
    if (!parsed.id) {
      throw vscode.FileSystemError.FileNotFound(uri);
    }
    const entity = await this.getEntity(uri);
    return Buffer.from(this.entityToDocumentText(parsed.folder, entity), "utf8");
  }

  async writeFile(uri, content) {
    throw vscode.FileSystemError.NoPermissions("magic-api 虚拟资源已改为只读，请从本地工作区镜像编辑并同步。");
  }

  async getEntity(uri) {
    const parsed = parseMagicApiUri(uri);
    const key = entityKey(parsed.folder, parsed.id);
    if (this.entities.has(key)) {
      return this.entities.get(key);
    }
    const entity = await this.client.getFile(parsed.id);
    this.cacheEntity(parsed.folder, entity);
    return entity;
  }

  cacheEntity(folder, entity) {
    if (entity && entity.id) {
      this.entities.set(entityKey(folder, entity.id), entity);
    }
  }

  uriFor(folder, entity) {
    const extension = isJsonOnlyResource(folder, entity) ? "json" : "ms";
    const name = sanitizeFileName(entity.name || entity.path || entity.key || entity.id || "untitled");
    return vscode.Uri.from({
      scheme: SCHEME,
      path: `/${folder}/${entity.id}/${name}.${extension}`
    });
  }

  entityToDocumentText(folder, entity) {
    if (isJsonOnlyResource(folder, entity)) {
      return JSON.stringify(entity, null, 2);
    }
    return entity.script || "";
  }
}

class MagicApiWorkspaceMirror {
  constructor(context, client, output) {
    this.context = context;
    this.client = client;
    this.output = output;
    this.operationQueue = Promise.resolve();
  }

  async pullAll(options = {}) {
    return this.runExclusive(() =>
      vscode.window.withProgress(
        {
          location: vscode.ProgressLocation.Notification,
          title: options.full ? "magic-api 全量拉取本地工作区" : "magic-api 增量同步本地工作区",
          cancellable: false
        },
        (progress) => this.pullAllWithProgress(progress, options)
      )
    );
  }

  async pullAllWithProgress(progress, options = {}) {
    const root = await this.resolveRoot();
    await ensureDirectory(root);
    await this.assertWorkspaceRoot(root);
    this.output.appendLine(`[magic-api] 开始拉取资源到 ${root}`);
    progress.report({ message: "检查本地变更" });

    const oldManifest = await this.readManifest(root);
    if (oldManifest.serverUrl) {
      this.assertManifestServer(oldManifest);
    }
    this.assertNoPendingDeletes(oldManifest);
    this.assertNoPendingCreateRequests(oldManifest);
    this.assertNoPendingGroupCreateRequests(oldManifest);
    if ((oldManifest.localGroups || []).length || (oldManifest.pendingGroupCreates || []).length) {
      throw new Error("存在本地待同步或待恢复分组，请先执行“推送本地全部变更”。");
    }
    const localChanges = await this.scanLocalChanges(root, oldManifest);
    const localChangeCount = this.localChangeCount(localChanges);
    if (localChangeCount && !options.force) {
      const choice = await vscode.window.showWarningMessage(
        `本地镜像有 ${localChangeCount} 个未推送或不完整的变更，继续拉取可能覆盖这些文件。`,
        { modal: true },
        "覆盖本地变更"
      );
      if (choice !== "覆盖本地变更") {
        return { root, count: 0, cancelled: true };
      }
    }
    const pullSnapshot = await this.createPullSnapshot(root, oldManifest);

    progress.report({ message: "读取服务端资源树" });
    const resources = await this.client.getResources();
    const plan = buildMirrorPlan(resources);
    const usedPaths = new Set();
    const entries = [];
    const groupEntries = [];
    const oldEntriesById = new Map((oldManifest.entries || []).map((entry) => [entry.id, entry]));
    let downloaded = 0;
    let reused = 0;

    for (const group of plan.groups) {
      const groupEntry = this.createGroupEntry(group.folder, group.segments, group.group);
      await this.assertSnapshotUnchanged(root, groupEntry.path, pullSnapshot);
      await this.writeJson(root, groupEntry.path, group.group);
      groupEntries.push(groupEntry);
      usedPaths.add(groupEntry.path);
    }

    const total = Math.max(plan.files.length, 1);
    for (const item of plan.files) {
      const remoteTime = item.entity.updateTime || item.entity.createTime || 0;
      const oldEntry = oldEntriesById.get(item.entity.id);
      const plannedEntry = this.createResourceEntry(item.folder, item.segments, item.entity, usedPaths);
      if (!options.full && await this.canReuseEntry(root, oldEntry, plannedEntry, remoteTime)) {
        oldEntry.serverUpdateTime = remoteTime;
        oldEntry.groupId = plannedEntry.groupId;
        entries.push(oldEntry);
        reused++;
        progress.report({
          increment: 80 / total,
          message: `跳过未变化资源 ${reused}/${plan.files.length}`
        });
        continue;
      }
      const entity = await this.client.getFile(item.entity.id);
      await this.assertSnapshotUnchanged(root, plannedEntry.path, pullSnapshot);
      if (plannedEntry.metadataPath) {
        await this.assertSnapshotUnchanged(root, plannedEntry.metadataPath, pullSnapshot);
      }
      await this.writeResourceEntry(root, plannedEntry, entity);
      plannedEntry.serverUpdateTime = entity.updateTime || entity.createTime || remoteTime;
      plannedEntry.hash = this.hashCanonicalEntity(plannedEntry, entity);
      entries.push(plannedEntry);
      downloaded++;
      progress.report({
        increment: 80 / total,
        message: `下载资源 ${downloaded}/${plan.files.length}`
      });
    }

    progress.report({ message: "写入 manifest" });
    await this.removeMissingManagedFiles(root, oldManifest, entries, groupEntries, pullSnapshot);
    const unresolvedPendingCreates = await this.reconcilePendingCreates(root, oldManifest, entries, pullSnapshot);
    const manifest = {
      version: MANIFEST_VERSION,
      generatedAt: Date.now(),
      serverUrl: this.client.getServerUrl(),
      entries,
      groups: groupEntries,
      pendingCreates: unresolvedPendingCreates,
      pendingCreateRequests: [],
      pendingDeletes: [],
      localGroups: [],
      pendingGroupCreateRequests: [],
      pendingGroupCreates: []
    };
    await this.assertSnapshotUnchanged(
      root,
      path.posix.join(WORKSPACE_META_DIR, WORKSPACE_MANIFEST),
      pullSnapshot
    );
    await this.writeManifest(root, manifest);
    await this.writeServerInfo(root);
    this.output.appendLine(`[magic-api] 拉取完成：下载 ${downloaded}，复用 ${reused}，总计 ${entries.length}`);
    return { root, count: entries.length, downloaded, reused };
  }

  async reconcilePendingCreates(root, oldManifest, entries, snapshot) {
    const pendingCreates = Array.isArray(oldManifest.pendingCreates) ? oldManifest.pendingCreates : [];
    if (!pendingCreates.length) {
      return [];
    }
    const entriesById = new Map(entries.map((entry) => [entry.id, entry]));
    const managedPaths = new Set();
    entries.forEach((entry) => {
      managedPaths.add(entry.path);
      if (entry.metadataPath) {
        managedPaths.add(entry.metadataPath);
      }
    });
    const unresolved = [];
    for (const pending of pendingCreates) {
      const canonicalEntry = entriesById.get(pending.id);
      if (!canonicalEntry) {
        unresolved.push(pending);
        this.output.appendLine(`[magic-api] 未能从资源树恢复待完成新增：${pending.path} (${pending.id})`);
        continue;
      }
      for (const pendingPath of [pending.path, pending.metadataPath].filter(Boolean)) {
        if (!managedPaths.has(pendingPath)) {
          await this.assertSnapshotUnchanged(root, pendingPath, snapshot);
          await removeWorkspaceFileIfExists(root, pendingPath);
        }
      }
      this.output.appendLine(`[magic-api] 已从服务端恢复新增资源：${canonicalEntry.path} (${pending.id})`);
    }
    return unresolved;
  }

  async ensureManifestV3(root, manifest) {
    for (const key of ["localGroups", "pendingGroupCreateRequests", "pendingGroupCreates"]) {
      manifest[key] = Array.isArray(manifest[key]) ? manifest[key] : [];
    }
    if (manifest.version >= MANIFEST_VERSION) {
      return;
    }
    const hasLegacyPending = [manifest.pendingCreates, manifest.pendingCreateRequests, manifest.pendingDeletes]
      .some((items) => Array.isArray(items) && items.length);
    if (hasLegacyPending) {
      throw new Error("manifest v2 存在未完成 journal，请先恢复原有新增或删除状态后再升级 v3。");
    }
    manifest.version = MANIFEST_VERSION;
    manifest.generatedAt = Date.now();
    await this.writeManifest(root, manifest);
  }

  async syncLocalGroups(root, manifest) {
    await this.reconcilePendingGroupCreates(root, manifest);
    this.assertNoPendingGroupCreateRequests(manifest);
    this.assertNoPendingGroupCreates(manifest);
    let created = 0;
    let reused = 0;
    while (manifest.localGroups.length) {
      const local = manifest.localGroups.find((group) => group.parentRef === "0" || !group.parentRef.startsWith("local:"));
      if (!local) {
        throw new Error("本地分组依赖形成环或父分组尚未解析。");
      }
      const parentId = local.parentRef;
      let resources = await this.client.getResources();
      let plan = buildMirrorPlan(resources);
      const matches = plan.groups.filter((item) => item.folder === local.folder && item.group &&
        item.group.parentId === parentId && item.group.name === local.name && item.group.path === local.path);
      if (matches.length > 1) {
        throw new Error(`服务端存在多个匹配分组 ${local.workspacePath}，已停止幂等同步。`);
      }
      if (matches.length === 1) {
        await this.resolveLocalGroup(root, manifest, local, matches[0]);
        reused++;
        continue;
      }
      const operationId = crypto.randomUUID ? crypto.randomUUID() : crypto.randomBytes(16).toString("hex");
      const request = {
        operationId,
        clientId: local.clientId,
        folder: local.folder,
        parentId,
        name: local.name,
        path: local.path,
        workspacePath: local.workspacePath,
        requestedAt: Date.now(),
        semanticHash: hashText(JSON.stringify([local.folder, parentId, local.name, local.path]))
      };
      manifest.pendingGroupCreateRequests.push(request);
      manifest.generatedAt = Date.now();
      await this.writeManifest(root, manifest);
      let savedId;
      try {
        savedId = await this.client.saveGroup({
          name: local.name,
          path: local.path,
          type: local.folder,
          parentId,
          paths: [],
          options: []
        });
      } catch (error) {
        if (isDefiniteCreateRejection(error)) {
          manifest.pendingGroupCreateRequests = manifest.pendingGroupCreateRequests.filter(
            (item) => item.operationId !== operationId
          );
          manifest.generatedAt = Date.now();
          await this.writeManifest(root, manifest);
          throw new Error(`服务端明确拒绝新增分组 ${local.workspacePath}：${messageOf(error)}`);
        }
        throw new Error(
          `新增分组请求结果未知，已保留预请求 ${operationId}；请执行“处理结果未知的新增请求”后再继续。原因：${messageOf(error)}`
        );
      }
      if (!savedId) {
        manifest.pendingGroupCreateRequests = manifest.pendingGroupCreateRequests.filter(
          (item) => item.operationId !== operationId
        );
        manifest.generatedAt = Date.now();
        await this.writeManifest(root, manifest);
        throw new Error(`服务端明确未创建分组 ${local.workspacePath}：没有返回分组 ID。`);
      }
      manifest.pendingGroupCreates.push({
        clientId: local.clientId,
        id: savedId,
        folder: local.folder,
        workspacePath: local.workspacePath,
        createdAt: Date.now()
      });
      manifest.pendingGroupCreateRequests = manifest.pendingGroupCreateRequests.filter(
        (item) => item.operationId !== operationId
      );
      manifest.generatedAt = Date.now();
      await this.writeManifest(root, manifest);
      resources = await this.client.getResources();
      plan = buildMirrorPlan(resources);
      const canonical = plan.groups.find((item) => item.folder === local.folder && item.group && item.group.id === savedId);
      if (!canonical) {
        throw new Error(`服务端已创建分组 ${savedId}，但资源树尚未返回 canonical 分组；已保留恢复状态。`);
      }
      await this.resolveLocalGroup(root, manifest, local, canonical);
      created++;
    }
    return { created, reused };
  }

  async reconcilePendingGroupCreates(root, manifest) {
    if (!manifest.pendingGroupCreates.length) {
      return 0;
    }
    const plan = buildMirrorPlan(await this.client.getResources());
    let recovered = 0;
    for (const pending of manifest.pendingGroupCreates.slice()) {
      const local = manifest.localGroups.find((group) => group.clientId === pending.clientId);
      const canonical = plan.groups.find((item) => item.folder === pending.folder && item.group && item.group.id === pending.id);
      if (!local || !canonical) {
        continue;
      }
      await this.resolveLocalGroup(root, manifest, local, canonical);
      recovered++;
    }
    return recovered;
  }

  async resolveLocalGroup(root, manifest, local, canonical) {
    const group = canonical.group;
    const segments = local.workspacePath.split("/").slice(1);
    const entry = this.createGroupEntry(local.folder, segments, group);
    entry.workspacePath = local.workspacePath;
    await this.writeJson(root, entry.path, group);
    manifest.groups = manifest.groups.filter((item) => !(item.folder === local.folder && item.workspacePath === local.workspacePath));
    manifest.groups.push(entry);
    manifest.localGroups = manifest.localGroups.filter((item) => item.clientId !== local.clientId);
    manifest.pendingGroupCreates = manifest.pendingGroupCreates.filter((item) => item.clientId !== local.clientId);
    manifest.pendingGroupCreateRequests = manifest.pendingGroupCreateRequests.filter((item) => item.clientId !== local.clientId);
    manifest.localGroups.forEach((item) => {
      if (item.parentRef === `local:${local.clientId}`) {
        item.parentRef = group.id;
      }
    });
    manifest.generatedAt = Date.now();
    await this.writeManifest(root, manifest);
    this.output.appendLine(`[magic-api] 已解析分组 ${local.workspacePath} -> ${group.id}`);
  }

  async pushDocumentIfManaged(document) {
    if (!document || !document.uri || document.uri.scheme !== "file") {
      return null;
    }
    const root = await this.resolveRoot();
    const manifest = await this.readManifest(root);
    if (!this.findEntryByUri(root, manifest, document.uri)) {
      // 新资源必须经过批量预检，避免自动保存绕过移动/重命名检测和删除确认。
      return null;
    }
    return this.pushUri(document.uri, { silent: true });
  }

  async createResourceFromExplorer(item, definition) {
    return this.runExclusive(async () => {
      if (!item || !["group", "root"].includes(item.kind) || !item.folder) {
        throw new Error("请在 magic-api 资源树的分组或类型根节点上执行新增资源。");
      }
      const root = await this.resolveRoot();
      const manifest = await this.readManifest(root);
      this.assertManifestServer(manifest);
      this.assertNoPendingCreates(manifest);
      this.assertNoPendingDeletes(manifest);
      const metadata = Object.assign({}, definition && definition.metadata);
      const workspaceOperations = new WorkspaceOperations(root, { serverUrl: this.client.getServerUrl() });
      const operationInput = {
        type: item.folder,
        groupPath: definition && definition.groupPath,
        name: metadata.name,
        path: metadata.path,
        method: metadata.method,
        cron: metadata.cron,
        enabled: metadata.enabled,
        key: metadata.key,
        url: metadata.url,
        metadata,
        script: definition && definition.script
      };
      if (item.folder === "datasource" || !operationInput.groupPath) {
        const group = this.resolveExplorerGroup(item, manifest);
        operationInput.groupId = group.id;
        delete operationInput.groupPath;
      }
      const applied = await workspaceOperations.create(operationInput, true);
      return {
        entry: applied.entry,
        uri: vscode.Uri.file(path.join(root, applied.entry.path)),
        noOp: applied.noOp
      };
    });
  }

  resolveExplorerGroup(item, manifest) {
    if (manifest.version < MANIFEST_VERSION || (manifest.groups || []).some((group) => !group.workspacePath)) {
      throw new Error("本地 manifest 版本过旧，请先执行 magic-api: 增量同步本地工作区。");
    }
    let matches;
    if (item.kind === "group") {
      const groupId = item.raw && item.raw.node && item.raw.node.id;
      matches = (manifest.groups || []).filter((group) =>
        group.folder === item.folder && group.id === groupId && group.id !== "0"
      );
    } else {
      matches = (manifest.groups || []).filter((group) =>
        group.folder === item.folder &&
        group.id !== "0" &&
        group.workspacePath === item.folder
      );
    }
    if (matches.length !== 1) {
      throw new Error(
        matches.length ? "当前节点对应多个服务端分组，已阻止新增。" : "当前节点没有可写的服务端分组，请在具体分组上新增。"
      );
    }
    return matches[0];
  }

  async deleteResourceFromExplorer(item) {
    return this.runExclusive(async () => {
      const entity = item && item.resource && item.resource.entity;
      if (!item || item.kind !== "file" || !entity || !entity.id) {
        throw new Error("请在 magic-api 资源树的已保存文件上执行删除资源。");
      }
      const root = await this.resolveRoot();
      let manifest = await this.readManifest(root);
      this.assertManifestServer(manifest);
      this.assertNoPendingCreates(manifest);
      this.assertNoPendingDeletes(manifest);
      let entry = this.findEntryById(manifest, entity.id);
      if (!entry || !(await this.entryExists(root, entry))) {
        throw new Error("本地镜像中没有该资源或资源对不完整，请先执行增量同步本地工作区。");
      }
      const changes = await this.scanLocalChanges(root, manifest);
      if (this.localChangeCount(changes)) {
        throw new Error("本地镜像存在未推送或不完整变更，请先推送或恢复这些变更后再从资源树删除。");
      }
      const visibleFileIds = resourceIdsFromTree(await this.client.getResources());
      if (!entry.id || entry.id === "0" || String(entry.id).endsWith(":0") || !visibleFileIds.has(entry.id)) {
        throw new Error(`无法确认 ${entry.id || "<empty>"} 是当前可见文件资源，已拒绝删除。`);
      }
      if (!(await this.confirmNoRemoteConflict(entry, { action: "delete" }))) {
        return { cancelled: true };
      }
      const choice = await vscode.window.showWarningMessage(
        `将永久删除服务端资源 ${entry.name || entry.id}（${entry.id}），此操作不可撤销。`,
        { modal: true },
        "删除服务端资源"
      );
      if (choice !== "删除服务端资源") {
        return { cancelled: true };
      }

      manifest = await this.readManifest(root);
      entry = this.findEntryById(manifest, entity.id);
      if (!entry || !(await this.entryExists(root, entry))) {
        throw new Error("资源在确认删除期间发生变化，请重新执行删除。");
      }
      const latestChanges = await this.scanLocalChanges(root, manifest);
      if (this.localChangeCount(latestChanges)) {
        throw new Error("本地镜像在确认删除期间发生变化，请重新执行删除。");
      }
      if (!(await this.confirmNoRemoteConflict(entry, { action: "delete" }))) {
        return { cancelled: true };
      }
      const backups = [];
      for (const relativePath of [entry.path, entry.metadataPath].filter(Boolean)) {
        backups.push({ relativePath, content: await this.readWorkspaceText(root, relativePath) });
      }
      const workspaceOperations = new WorkspaceOperations(root, { serverUrl: this.client.getServerUrl() });
      let result;
      try {
        await workspaceOperations.delete({ id: entry.id }, true);
        result = await this.deleteEntries(root, manifest, [entry], {
          confirmed: true,
          visibleFileIds,
          skipConflictCheck: true
        });
      } catch (error) {
        const hasRecoveryRecord = await this.hasPendingDelete(root, entry.id);
        if (!hasRecoveryRecord) {
          await this.restoreExplorerBackups(root, backups);
        }
        throw error;
      }
      if (result.deleted !== 1) {
        const hasRecoveryRecord = await this.hasPendingDelete(root, entry.id);
        if (!hasRecoveryRecord) {
          await this.restoreExplorerBackups(root, backups);
        }
        throw new Error(
          hasRecoveryRecord
            ? `删除请求未能完成确认，已保留恢复记录；请执行“推送本地全部变更”复核 ${entry.path}。`
            : `服务端删除未完成，已恢复本地文件 ${entry.path}。`
        );
      }
      await this.client.reload();
      return { cancelled: false, entry };
    });
  }

  async hasPendingDelete(root, id) {
    try {
      const manifest = await this.readManifest(root);
      return (manifest.pendingDeletes || []).some((pending) => pending.id === id);
    } catch (error) {
      this.output.appendLine(`[magic-api] 无法读取删除恢复记录 ${id}：${messageOf(error)}`);
      return true;
    }
  }

  async restoreExplorerBackups(root, backups) {
    for (const backup of backups) {
      const state = await inspectWorkspacePath(root, backup.relativePath);
      if (!state.exists) {
        await this.writeText(root, backup.relativePath, backup.content);
      }
    }
  }

  async pushUri(uri, options = {}) {
    return this.runExclusive(() => {
      if (options.silent) {
        return this.pushUriWithProgress(uri, null, options);
      }
      return vscode.window.withProgress(
        {
          location: vscode.ProgressLocation.Notification,
          title: "magic-api 推送当前资源",
          cancellable: false
        },
        (progress) => this.pushUriWithProgress(uri, progress, options)
      );
    });
  }

  async pushUriWithProgress(uri, progress, options = {}) {
    if (uri.scheme !== "file") {
      vscode.window.showWarningMessage("当前文件不是本地 magic-api 镜像文件。");
      return null;
    }
    const root = await this.resolveRoot();
    const manifest = await this.readManifest(root);
    this.assertManifestServer(manifest);
    this.assertNoPendingCreates(manifest);
    this.assertNoPendingDeletes(manifest);
    const relativePath = toPosixPath(path.relative(root, uri.fsPath));
    let entry = this.findEntryByPath(manifest, relativePath);
    if (!entry) {
      let candidate;
      try {
        candidate = await this.prepareNewCandidate(root, manifest, relativePath);
      } catch (error) {
        if (options.silent) {
          return null;
        }
        throw error;
      }
      if (!candidate) {
        if (!options.silent) {
          vscode.window.showWarningMessage("当前文件不是可推送的 magic-api 本地镜像资源。");
        }
        return null;
      }
      if (!options.silent) {
        vscode.window.showWarningMessage(
          `新增资源 ${this.displayEntryPath(candidate.entry)} 必须执行“magic-api: 推送本地全部变更”，以完成统一预检。`
        );
      }
      return null;
    }
    if (progress) {
      progress.report({ message: this.displayEntryPath(entry), increment: 20 });
    }
    const result = await this.pushEntry(root, manifest, entry, options);
    if (result.pushed || result.created) {
      if (progress) {
        progress.report({ message: "刷新服务端缓存", increment: 80 });
      }
      await this.client.reload();
      vscode.window.setStatusBarMessage(`magic-api 已同步 ${this.displayEntryPath(entry)}`, 3000);
    }
    return Object.assign({ path: this.displayEntryPath(entry) }, result);
  }

  async pushChanged(options = {}) {
    return this.runExclusive(() =>
      vscode.window.withProgress(
        {
          location: vscode.ProgressLocation.Notification,
          title: "magic-api 推送本地变更",
          cancellable: false
        },
        async (progress) => {
        const root = await this.resolveRoot();
        const manifest = await this.readManifest(root);
        this.assertManifestServer(manifest);
        await this.ensureManifestV3(root, manifest);
        this.assertNoPendingCreates(manifest);
        const groupResult = await this.syncLocalGroups(root, manifest);
        const recoveredDeleted = await this.reconcilePendingDeletes(root, manifest);
        this.assertNoPendingDeletes(manifest);
        const changes = await this.scanLocalChanges(root, manifest);
        const candidates = [];
        const sharedValidation = await new WorkspaceOperations(root, {
          serverUrl: this.client.getServerUrl()
        }).validate();
        const validationErrors = Array.from(new Set(changes.invalid.concat(sharedValidation.errors)));
        for (const relativePath of changes.created) {
          try {
            const candidate = await this.prepareNewCandidate(root, manifest, relativePath);
            if (!candidate) {
              throw new Error("无法识别新资源。");
            }
            candidates.push(candidate);
          } catch (error) {
            validationErrors.push(`${relativePath}: ${messageOf(error)}`);
          }
        }
        for (const entry of changes.modified) {
          try {
            await this.readEntityFromEntry(root, entry);
          } catch (error) {
            validationErrors.push(`${entry.path}: ${messageOf(error)}`);
          }
        }
        for (const candidate of candidates) {
          const suspectedMove = changes.deleted.find((entry) =>
            entry.groupId === candidate.entry.groupId && entry.name === candidate.entry.name
          );
          if (suspectedMove) {
            validationErrors.push(
              `${candidate.entry.path}: 与待删除资源 ${suspectedMove.path} 的名称和分组相同，疑似移动或重命名；请恢复原路径。`
            );
          }
        }
        if (candidates.length && changes.deleted.length) {
          validationErrors.push(
            "同一批次同时包含新增和删除，无法安全区分独立操作与移动/重命名；请先恢复其中一类，分两次推送。"
          );
        }
        if (!validationErrors.length && candidates.length) {
          const remotePlan = buildMirrorPlan(await this.client.getResources());
          const visibleGroups = new Set(
            remotePlan.groups.map((item) => `${item.folder}\0${item.group && item.group.id}`)
          );
          for (const candidate of candidates) {
            const groupKey = `${candidate.entry.folder}\0${candidate.entry.groupId}`;
            if (!visibleGroups.has(groupKey)) {
              validationErrors.push(
                `${candidate.entry.path}: 当前服务端资源树中看不到目标分组 ${candidate.entry.groupId}，已拒绝新增。`
              );
              continue;
            }
            const duplicate = remotePlan.files.find((item) =>
              item.folder === candidate.entry.folder &&
              item.entity &&
              item.entity.groupId === candidate.entry.groupId &&
              item.entity.name === candidate.entity.name &&
              resourceIdentityValue(item.folder, item.entity) ===
                resourceIdentityValue(candidate.entry.folder, candidate.entity)
            );
            if (duplicate) {
              validationErrors.push(
                `${candidate.entry.path}: 服务端已存在相同分组、名称和路径/key 的资源 ${duplicate.entity.id}，已拒绝重复新增。`
              );
            }
          }
        }
        if (validationErrors.length) {
          validationErrors.forEach((message) => this.output.appendLine(`[magic-api] 预检失败：${message}`));
          throw new Error(
            `本地工作区预检失败，共 ${validationErrors.length} 项。未对服务端执行任何修改，请查看“magic-api”输出。`
          );
        }

        let created = 0;
        let updated = 0;
        let deleted = recoveredDeleted;
        let skipped = 0;
        let conflicts = 0;
        let failed = 0;
        const pendingPaths = [];
        const total = Math.max(candidates.length + changes.modified.length + changes.deleted.length, 1);
        this.output.appendLine(
          `[magic-api] 开始推送：分组新增 ${groupResult.created}，分组复用 ${groupResult.reused}，资源新增 ${candidates.length}，修改 ${changes.modified.length}，删除 ${changes.deleted.length}`
        );

        for (let index = 0; index < candidates.length; index++) {
          const candidate = candidates[index];
          try {
            const result = await this.pushNewCandidate(root, manifest, candidate);
            if (result.created) {
              created++;
            }
          } catch (error) {
            failed++;
            pendingPaths.push(candidate.entry.path);
            const remainingCandidates = candidates.slice(index + 1).map((item) => item.entry.path);
            pendingPaths.push(...remainingCandidates);
            skipped += remainingCandidates.length;
            this.output.appendLine(`[magic-api] 新增失败 ${candidate.entry.path}: ${messageOf(error)}`);
            break;
          }
          progress.report({ increment: 75 / total, message: `新增 ${created}/${candidates.length}` });
        }

        if (failed === 0) {
          for (let index = 0; index < changes.modified.length; index++) {
            const entry = changes.modified[index];
            try {
              const result = await this.pushEntry(root, manifest, entry, {
                autoApprove: Boolean(options.autoApprove)
              });
              if (result.conflict) {
                conflicts++;
                pendingPaths.push(entry.path);
              } else if (result.pushed) {
                updated++;
              } else {
                skipped++;
              }
            } catch (error) {
              failed++;
              pendingPaths.push(entry.path);
              const remainingModified = changes.modified.slice(index + 1).map((item) => item.path);
              pendingPaths.push(...remainingModified);
              skipped += remainingModified.length;
              this.output.appendLine(`[magic-api] 修改失败 ${entry.path}: ${messageOf(error)}`);
              break;
            }
            progress.report({ increment: 75 / total, message: `修改 ${updated}/${changes.modified.length}` });
          }
        } else {
          pendingPaths.push(...changes.modified.map((entry) => entry.path));
          skipped += changes.modified.length;
        }

        if (failed === 0 && changes.deleted.length) {
          const deleteResult = await this.deleteEntries(root, manifest, changes.deleted, {
            confirmed: Boolean(options.autoApprove),
            autoApprove: Boolean(options.autoApprove)
          });
          deleted += deleteResult.deleted;
          conflicts += deleteResult.conflicts;
          failed += deleteResult.failed;
          skipped += deleteResult.cancelled ? changes.deleted.length : 0;
          pendingPaths.push(...deleteResult.pendingPaths);
        } else if (failed > 0 && changes.deleted.length) {
          skipped += changes.deleted.length;
          pendingPaths.push(...changes.deleted.map((entry) => entry.path));
          this.output.appendLine("[magic-api] 因前序新增或修改失败，已跳过全部删除操作，避免把移动/重命名误处理为删除。");
        }

        await this.writeManifest(root, manifest);
        const count = created + updated + deleted;
        if (count > 0) {
          progress.report({ increment: 25, message: "刷新服务端缓存" });
          await this.client.reload();
        }
        this.output.appendLine(
          `[magic-api] 推送完成：新增 ${created}，修改 ${updated}，删除 ${deleted}，跳过 ${skipped}，冲突 ${conflicts}，失败 ${failed}`
        );
        const uniquePendingPaths = Array.from(new Set(pendingPaths));
        uniquePendingPaths.forEach((pendingPath) => this.output.appendLine(`[magic-api] 仍待同步：${pendingPath}`));
        return {
          root,
          count,
          groupsCreated: groupResult.created,
          groupsReused: groupResult.reused,
          created,
          updated,
          deleted,
          skipped,
          conflicts,
          failed,
          pendingPaths: uniquePendingPaths
        };
        }
      )
    );
  }

  runExclusive(operation) {
    const result = this.operationQueue.then(operation, operation);
    this.operationQueue = result.catch(() => undefined);
    return result;
  }

  async pushNewCandidate(root, manifest, candidate) {
    const beforeSaveHash = await this.hashEntry(root, candidate.entry);
    if (beforeSaveHash !== candidate.localHash) {
      throw new Error(`${candidate.entry.path} 在预检后又发生变化，请重新执行推送。`);
    }
    const operationId = crypto.randomUUID
      ? crypto.randomUUID()
      : crypto.randomBytes(16).toString("hex");
    const semanticSignature = createSemanticSignature(candidate.entity);
    const request = {
      operationId,
      folder: candidate.entry.folder,
      groupId: candidate.entry.groupId,
      path: candidate.entry.path,
      metadataPath: candidate.entry.metadataPath,
      name: candidate.entity.name,
      resourceKey: resourceIdentityValue(candidate.entry.folder, candidate.entity),
      localHash: candidate.localHash,
      semanticKeys: semanticSignature.keys,
      semanticHash: semanticSignature.hash,
      requestedAt: Date.now()
    };
    manifest.pendingCreateRequests = Array.isArray(manifest.pendingCreateRequests)
      ? manifest.pendingCreateRequests
      : [];
    manifest.pendingCreateRequests.push(request);
    manifest.generatedAt = Date.now();
    await this.writeManifest(root, manifest);

    let savedId;
    try {
      savedId = await this.client.saveFile(candidate.entry.folder, candidate.entity);
    } catch (error) {
      if (isDefiniteCreateRejection(error)) {
        manifest.pendingCreateRequests = manifest.pendingCreateRequests.filter(
          (item) => item.operationId !== operationId
        );
        manifest.generatedAt = Date.now();
        await this.writeManifest(root, manifest);
        throw new Error(`服务端明确拒绝新增 ${candidate.entry.path}：${messageOf(error)}`);
      }
      throw new Error(
        `新增请求结果未知，已在 manifest 保留预请求 ${operationId}；请先执行“magic-api: 处理结果未知的新增请求”，禁止直接重试。原因：${messageOf(error)}`
      );
    }
    if (!savedId) {
      manifest.pendingCreateRequests = manifest.pendingCreateRequests.filter(
        (item) => item.operationId !== operationId
      );
      manifest.generatedAt = Date.now();
      await this.writeManifest(root, manifest);
      throw new Error(`服务端明确未创建 ${candidate.entry.path}：没有返回资源 ID。`);
    }
    if (this.findEntryById(manifest, savedId)) {
      throw new Error(`服务端返回的资源 ID ${savedId} 已存在于 manifest。`);
    }
    const pending = {
      id: savedId,
      folder: candidate.entry.folder,
      groupId: candidate.entry.groupId,
      path: candidate.entry.path,
      metadataPath: candidate.entry.metadataPath,
      createdAt: Date.now()
    };
    manifest.pendingCreates = Array.isArray(manifest.pendingCreates) ? manifest.pendingCreates : [];
    manifest.pendingCreates.push(pending);
    manifest.pendingCreateRequests = manifest.pendingCreateRequests.filter((item) => item.operationId !== operationId);
    manifest.generatedAt = Date.now();
    await this.writeManifest(root, manifest);
    try {
      const canonical = await this.client.getFile(savedId);
      const entry = Object.assign(candidate.entry, {
        id: savedId,
        groupId: canonical.groupId || candidate.entry.groupId,
        name: canonical.name || canonical.path || canonical.key || candidate.entry.name || "",
        serverUpdateTime: canonical.updateTime || canonical.createTime || Date.now(),
        needsCanonical: true
      });
      const latestHash = await this.hashEntry(root, entry);
      entry.hash = candidate.localHash;
      if (latestHash !== candidate.localHash) {
        this.output.appendLine(`[magic-api] ${entry.path} 在新增期间又被编辑，已保留较新的本地内容并标记为待推送。`);
      }
      manifest.entries.push(entry);
      manifest.pendingCreates = manifest.pendingCreates.filter((item) => item.id !== savedId);
      manifest.generatedAt = Date.now();
      await this.writeManifest(root, manifest);
      this.output.appendLine(`[magic-api] 已新增 ${this.displayEntryPath(entry)} (${savedId})`);
      return { created: true, pushed: true, entry };
    } catch (error) {
      throw new Error(
        `服务端已为 ${candidate.entry.path} 创建资源 ${savedId}，但 canonical 读取或状态落盘失败；请先同步工作区再重试。原因：${messageOf(error)}`
      );
    }
  }

  async pushEntry(root, manifest, entry, options = {}) {
    if (!(await this.entryExists(root, entry))) {
      return { skipped: true };
    }
    const currentHash = await this.hashEntry(root, entry);
    if (!options.force && currentHash === entry.hash) {
      return { skipped: true };
    }
    if (!(await this.confirmNoRemoteConflict(entry, options))) {
      return { conflict: true };
    }
    const beforeReadHash = await this.hashEntry(root, entry);
    const entity = await this.readEntityFromEntry(root, entry);
    const submittedHash = await this.hashEntry(root, entry);
    if (submittedHash !== beforeReadHash) {
      throw new Error(`${entry.path} 在读取期间发生变化，请重新执行推送。`);
    }
    const savedId = await this.client.saveFile(entry.folder, entity);
    if (!savedId) {
      throw new Error(`服务端没有确认保存 ${entry.path}。`);
    }
    if (entry.id && savedId !== entry.id) {
      throw new Error(`服务端为已有资源返回了不同 ID：${entry.id} -> ${savedId}，已停止写回本地。`);
    }
    entry.id = savedId;
    entity.id = savedId;
    const canonical = await this.client.getFile(savedId);
    entry.name = canonical.name || canonical.path || canonical.key || entry.name || "";
    entry.groupId = canonical.groupId || entry.groupId;
    entry.serverUpdateTime = canonical.updateTime || canonical.createTime || Date.now();
    entry.needsCanonical = true;
    const latestHash = await this.hashEntry(root, entry);
    entry.hash = submittedHash;
    if (latestHash !== submittedHash) {
      this.output.appendLine(`[magic-api] ${entry.path} 在推送期间又被编辑，已保留较新的本地内容并标记为待推送。`);
    }
    manifest.generatedAt = Date.now();
    await this.writeManifest(root, manifest);
    this.output.appendLine(`[magic-api] 已推送 ${this.displayEntryPath(entry)}`);
    return { pushed: true };
  }

  hashCanonicalEntity(entry, entity) {
    const text = `${JSON.stringify(entry.type === "json" ? entity : cloneWithoutScript(entity), null, 2)}\n`;
    return entry.type === "json" ? hashText(text) : hashText(`${text}\n${entity.script || ""}`);
  }

  async deleteEntries(root, manifest, entries, options = {}) {
    this.output.appendLine(`[magic-api] 待删除服务端文件清单（${entries.length} 项）：`);
    entries.forEach((entry) => this.output.appendLine(`  - ${entry.path} (${entry.id})`));
    this.output.show(true);
    const preview = entries.slice(0, 8).map((entry) => `• ${entry.path} (${entry.id})`).join("\n");
    const suffix = entries.length > 8
      ? `\n…另有 ${entries.length - 8} 项，请先在“magic-api”输出中核对完整清单。`
      : "";
    if (!options.confirmed) {
      const choice = await vscode.window.showWarningMessage(
        `检测到 ${entries.length} 个本地资源文件已删除。继续会删除服务端资源且不可撤销：\n${preview}${suffix}`,
        { modal: true },
        "删除服务端资源"
      );
      if (choice !== "删除服务端资源") {
        return { deleted: 0, conflicts: 0, failed: 0, cancelled: true, pendingPaths: entries.map((entry) => entry.path) };
      }
    }

    let deleted = 0;
    let conflicts = 0;
    let failed = 0;
    const pendingPaths = [];
    const visibleFileIds = options.visibleFileIds || resourceIdsFromTree(await this.client.getResources());
    for (const entry of entries) {
      try {
        if (!entry.id || entry.id === "0" || String(entry.id).endsWith(":0")) {
          throw new Error(`非法资源 ID：${entry.id || "<empty>"}`);
        }
        if (!visibleFileIds.has(entry.id)) {
          throw new Error(`无法确认 ${entry.id} 是当前可见文件资源，已拒绝调用可能递归删除分组的接口。`);
        }
        if (await this.anyEntryFileExists(root, entry)) {
          throw new Error("本地资源文件已重新出现，取消服务端删除。");
        }
        if (!options.skipConflictCheck && !(await this.confirmNoRemoteConflict(entry, {
          action: "delete",
          autoApprove: Boolean(options.autoApprove)
        }))) {
          conflicts++;
          pendingPaths.push(entry.path);
          continue;
        }
        manifest.pendingDeletes = Array.isArray(manifest.pendingDeletes) ? manifest.pendingDeletes : [];
        manifest.pendingDeletes.push({
          id: entry.id,
          folder: entry.folder,
          path: entry.path,
          metadataPath: entry.metadataPath,
          requestedAt: Date.now()
        });
        manifest.generatedAt = Date.now();
        await this.writeManifest(root, manifest);
        if (await this.anyEntryFileExists(root, entry)) {
          manifest.pendingDeletes = manifest.pendingDeletes.filter((item) => item.id !== entry.id);
          manifest.generatedAt = Date.now();
          await this.writeManifest(root, manifest);
          throw new Error("本地资源文件在删除请求前重新出现，已取消服务端删除。");
        }
        const accepted = await this.client.deleteResource(entry.id);
        if (accepted !== true) {
          throw new Error("删除接口未返回 true，已保留请求恢复记录。");
        }

        const probe = await this.probeRemoteFile(entry.id);
        if (probe.state === "exists") {
          throw new Error("删除接口返回 true，但服务端详情接口仍能读取该文件；已保留恢复记录。");
        }
        if (probe.state === "unknown") {
          throw new Error(`无法确认服务端文件已不存在，已保留恢复记录：${probe.reason}`);
        }

        if (await this.anyEntryFileExists(root, entry)) {
          throw new Error("本地资源文件在删除期间重新出现，已保留恢复记录且未清理这些文件。");
        }
        await removeWorkspaceFileIfExists(root, entry.path);
        if (entry.metadataPath) {
          await removeWorkspaceFileIfExists(root, entry.metadataPath);
        }
        manifest.entries = manifest.entries.filter((item) => item.id !== entry.id);
        manifest.pendingDeletes = manifest.pendingDeletes.filter((item) => item.id !== entry.id);
        manifest.generatedAt = Date.now();
        await this.writeManifest(root, manifest);
        deleted++;
        this.output.appendLine(`[magic-api] 已确认服务端删除 ${entry.path} (${entry.id})`);
      } catch (error) {
        failed++;
        pendingPaths.push(entry.path);
        this.output.appendLine(`[magic-api] 删除失败 ${entry.path}: ${messageOf(error)}`);
      }
    }
    return { deleted, conflicts, failed, cancelled: false, pendingPaths };
  }

  async confirmNoRemoteConflict(entry, options = {}) {
    if (!this.client.connectionStore.getBehaviorSetting("checkConflicts", true)) {
      return true;
    }
    if (!entry.id || !entry.serverUpdateTime) {
      return true;
    }
    const remote = await this.client.getFile(entry.id);
    const remoteTime = remote && (remote.updateTime || remote.createTime || 0);
    if (!remoteTime || remoteTime <= entry.serverUpdateTime) {
      return true;
    }
    if (options.autoApprove) {
      this.output.appendLine(`[magic-api] CLI 计划已批准覆盖远端冲突：${entry.path} (${entry.id})`);
      return true;
    }
    const confirmLabel = options.action === "delete" ? "仍然删除" : "覆盖服务端";
    const choice = await vscode.window.showWarningMessage(
      `服务端资源 ${entry.name || entry.id} 在本地拉取后发生过修改。`,
      { modal: !options.silent },
      confirmLabel,
      "取消"
    );
    return choice === confirmLabel;
  }

  async probeRemoteFile(id) {
    try {
      const remote = await this.client.getFile(id);
      // JsonBean may omit a null `data` property, so getJsonBean returns undefined
      // after a successful lookup of a resource that no longer exists.
      if (remote === null || remote === undefined) {
        return { state: "missing" };
      }
      if (remote && typeof remote === "object" && remote.id === id) {
        return { state: "exists", remote };
      }
      return { state: "unknown", reason: "详情接口返回了无法匹配资源 ID 的结果。" };
    } catch (error) {
      return { state: "unknown", reason: messageOf(error) };
    }
  }

  async readEntityFromEntry(root, entry) {
    if (entry.type === "json") {
      const text = await this.readWorkspaceText(root, entry.path);
      const entity = parseJson(text);
      if (!entity || typeof entity !== "object") {
        throw new Error(`${entry.path} 不是合法 JSON。`);
      }
      this.applyManagedIdentity(entry, entity);
      validateExistingEntity(entry, entity);
      return entity;
    }
    const metadataText = await this.readWorkspaceText(root, entry.metadataPath);
    const metadata = parseJson(metadataText);
    if (!metadata || typeof metadata !== "object") {
      throw new Error(`${entry.metadataPath} 不是合法 JSON。`);
    }
    const script = await this.readWorkspaceText(root, entry.path);
    const entity = Object.assign({}, metadata, { script });
    this.applyManagedIdentity(entry, entity);
    validateExistingEntity(entry, entity);
    return entity;
  }

  applyManagedIdentity(entry, entity) {
    if (entry.id && entity.id && entity.id !== entry.id) {
      throw new Error(`${entry.path} 的元数据 ID 与 manifest 不一致，已阻止疑似移动或覆盖。`);
    }
    if (entry.groupId && entity.groupId && entity.groupId !== entry.groupId) {
      throw new Error(`${entry.path} 的 groupId 已改变；当前版本不支持移动资源。`);
    }
    if (entry.id) {
      entity.id = entry.id;
    }
    if (entry.groupId) {
      entity.groupId = entry.groupId;
    }
  }

  async getResourceForUri(uri) {
    const root = await this.resolveRoot();
    const manifest = await this.readManifest(root);
    const entry = this.findEntryByUri(root, manifest, uri);
    if (!entry) {
      const relativePath = toPosixPath(path.relative(root, uri.fsPath));
      const candidate = await this.prepareNewCandidate(root, manifest, relativePath);
      if (!candidate) {
        throw new Error("当前文件不是 magic-api 本地镜像资源。");
      }
      return { folder: candidate.entry.folder, entity: candidate.entity };
    }
    return {
      folder: entry.folder,
      entity: await this.readEntityFromEntry(root, entry)
    };
  }

  async openMetadataEditor(itemOrUri) {
    const root = await this.resolveRoot();
    let manifest = await this.readManifest(root);
    let entry = null;
    if (itemOrUri && itemOrUri.resource && itemOrUri.resource.entity) {
      entry = this.findEntryById(manifest, itemOrUri.resource.entity.id);
      if (!entry) {
        await this.openResource(itemOrUri.resource.folder, itemOrUri.resource.entity);
        manifest = await this.readManifest(root);
        entry = this.findEntryById(manifest, itemOrUri.resource.entity.id);
      }
    } else {
      const uri = itemOrUri && itemOrUri.scheme ? itemOrUri : vscode.window.activeTextEditor && vscode.window.activeTextEditor.document.uri;
      entry = uri ? this.findEntryByUri(root, manifest, uri) : null;
    }
    if (!entry) {
      vscode.window.showWarningMessage("请先打开一个 magic-api 本地工作区资源。");
      return;
    }
    const entity = await this.readEntityFromEntry(root, entry);
    let panelHash = await this.hashEntry(root, entry);
    const panel = vscode.window.createWebviewPanel(
      "magicApiMetadata",
      `magic-api: ${entry.name || entry.id}`,
      vscode.ViewColumn.Beside,
      { enableScripts: true }
    );
    panel.webview.html = renderMetadataEditorHtml(entry, entity, panel.webview.cspSource);
    panel.webview.onDidReceiveMessage(async (message) => {
      await this.runExclusive(async () => {
        try {
          if (!message || !["saveLocal", "savePush"].includes(message.command)) {
            return;
          }
          const currentManifest = await this.readManifest(root);
          const currentEntry = entry.id
            ? this.findEntryById(currentManifest, entry.id)
            : this.findEntryByPath(currentManifest, entry.path);
          if (!currentEntry) {
            throw new Error("资源已不在当前 manifest 中，请关闭元数据面板并重新打开。");
          }
          const currentHash = await this.hashEntry(root, currentEntry);
          if (currentHash !== panelHash) {
            throw new Error("资源在元数据面板打开后已发生变化，请关闭面板并重新打开，避免覆盖新内容。");
          }
          const nextEntity = metadataEditorPayloadToEntity(entity, message);
          this.applyManagedIdentity(currentEntry, nextEntity);
          await this.writeMetadataFromEditor(root, currentEntry, nextEntity);
          panelHash = await this.hashEntry(root, currentEntry);
          currentManifest.generatedAt = Date.now();
          await this.writeManifest(root, currentManifest);
          if (message.command === "savePush") {
            this.assertManifestServer(currentManifest);
            this.assertNoPendingCreates(currentManifest);
            this.assertNoPendingDeletes(currentManifest);
            const result = await this.pushEntry(root, currentManifest, currentEntry, { force: true });
            if (result.pushed) {
              await this.client.reload();
              panelHash = await this.hashEntry(root, currentEntry);
              vscode.window.showInformationMessage(`magic-api 已保存并推送 ${this.displayEntryPath(currentEntry)}。`);
            } else if (result.conflict) {
              vscode.window.showWarningMessage("magic-api 元数据已保存到本地，但未覆盖服务端冲突版本。");
            }
          } else {
            vscode.window.showInformationMessage(
              `magic-api 已保存本地元数据 ${nextEntity.name || nextEntity.path || nextEntity.key || currentEntry.name || currentEntry.id}。`
            );
          }
        } catch (error) {
          this.output.appendLine(formatError(error));
          vscode.window.showErrorMessage(`保存 magic-api 元数据失败：${messageOf(error)}`);
        }
      });
    });
  }

  async writeMetadataFromEditor(root, entry, entity) {
    if (!entry.id) {
      throw new Error("只有 manifest 已管理的稳定资源才能使用元数据编辑器。");
    }
    const metadataPatch = cloneWithoutScript(entity);
    SERVER_OWNED_FIELDS.forEach((field) => delete metadataPatch[field]);
    const workspaceOperations = new WorkspaceOperations(root, { serverUrl: this.client.getServerUrl() });
    await workspaceOperations.update({ id: entry.id, metadataPatch }, true);
  }

  async openResource(folder, entity) {
    const root = await this.resolveRoot();
    let manifest = await this.readManifest(root);
    let entry = this.findEntryById(manifest, entity.id);
    if (!entry || !(await this.entryExists(root, entry))) {
      if (!this.client.connectionStore.getBehaviorSetting("autoPullOnOpen", true)) {
        throw new Error("本地工作区没有该资源，请先执行 magic-api: 拉取到本地工作区。");
      }
      await this.pullAll();
      manifest = await this.readManifest(root);
      entry = this.findEntryById(manifest, entity.id);
    }
    if (!entry) {
      throw new Error(`本地工作区中未找到资源 ${entity.id}`);
    }
    return vscode.Uri.file(path.join(root, entry.path));
  }

  async isManagedUri(uri) {
    if (!uri || uri.scheme !== "file") {
      return false;
    }
    const root = await this.resolveRoot();
    const manifest = await this.readManifest(root);
    if (this.findEntryByUri(root, manifest, uri)) {
      return true;
    }
    try {
      const relativePath = toPosixPath(path.relative(root, uri.fsPath));
      return Boolean(await this.prepareNewCandidate(root, manifest, relativePath));
    } catch (error) {
      return false;
    }
  }

  findEntryByUri(root, manifest, uri) {
    if (!uri || uri.scheme !== "file" || !isPathInside(root, uri.fsPath)) {
      return null;
    }
    const relativePath = toPosixPath(path.relative(root, uri.fsPath));
    return this.findEntryByPath(manifest, relativePath);
  }

  findEntryById(manifest, id) {
    return (manifest.entries || []).find((entry) => entry.id === id);
  }

  async scanLocalChanges(root, manifest) {
    const changes = { created: [], modified: [], deleted: [], invalid: [] };
    const entries = Array.isArray(manifest.entries) ? manifest.entries : [];
    for (const entry of entries) {
      let sourceState;
      let metadataState;
      try {
        sourceState = await inspectWorkspacePath(root, entry.path);
        if (sourceState.exists && !sourceState.stat.isFile()) {
          throw new Error(`${entry.path} 不是普通文件。`);
        }
        if (entry.type === "script") {
          metadataState = await inspectWorkspacePath(root, entry.metadataPath);
          if (metadataState.exists && !metadataState.stat.isFile()) {
            throw new Error(`${entry.metadataPath} 不是普通文件。`);
          }
        }
      } catch (error) {
        changes.invalid.push(`${entry.path}: ${messageOf(error)}`);
        continue;
      }
      const sourceExists = sourceState.exists;
      const metadataExists = entry.type !== "script" || metadataState.exists;
      if (!sourceExists) {
        if (entry.type === "script" && metadataExists) {
          changes.invalid.push(`${entry.path}: 脚本缺失但 ${entry.metadataPath} 仍存在；请恢复脚本或明确删除完整资源对。`);
        } else {
          changes.deleted.push(entry);
        }
        continue;
      }
      if (!metadataExists) {
        changes.invalid.push(`${entry.path}: 对应元数据 ${entry.metadataPath} 缺失，不能推送或删除远端。`);
        continue;
      }
      try {
        const hash = await this.hashEntry(root, entry);
        if (hash !== entry.hash) {
          changes.modified.push(entry);
        }
      } catch (error) {
        changes.invalid.push(`${entry.path}: ${messageOf(error)}`);
      }
    }

    const discovered = await this.discoverUntrackedResources(root, manifest);
    changes.created.push(...discovered.created);
    changes.invalid.push(...discovered.invalid);
    return changes;
  }

  async discoverUntrackedResources(root, manifest) {
    const records = await listWorkspaceFiles(root);
    const managedPaths = new Set();
    (manifest.entries || []).forEach((entry) => {
      managedPaths.add(entry.path);
      if (entry.metadataPath) {
        managedPaths.add(entry.metadataPath);
      }
    });
    const allowedFolders = new Set([
      ...(manifest.groups || []).map((group) => group.folder),
      ...(manifest.entries || []).map((entry) => entry.folder)
    ].filter(Boolean));
    if (!allowedFolders.size) {
      ["api", "function", "datasource", "task", "script", "component"].forEach((folder) => allowedFolders.add(folder));
    }
    return discoverUntrackedResourceRecords(records, managedPaths, allowedFolders);
  }

  async createPullSnapshot(root, manifest) {
    const paths = new Set([
      path.posix.join(WORKSPACE_META_DIR, WORKSPACE_MANIFEST)
    ]);
    (manifest.entries || []).forEach((entry) => {
      paths.add(entry.path);
      if (entry.metadataPath) {
        paths.add(entry.metadataPath);
      }
    });
    (manifest.groups || []).forEach((group) => paths.add(group.path));
    (manifest.pendingCreates || []).forEach((pending) => {
      paths.add(pending.path);
      if (pending.metadataPath) {
        paths.add(pending.metadataPath);
      }
    });
    (manifest.pendingCreateRequests || []).forEach((pending) => {
      paths.add(pending.path);
      if (pending.metadataPath) {
        paths.add(pending.metadataPath);
      }
    });

    const records = await listWorkspaceFiles(root);
    records.forEach((record) => {
      if (describeResourcePath(record.path)) {
        paths.add(record.path);
      }
    });

    const snapshot = new Map();
    for (const relativePath of paths) {
      const state = await inspectWorkspacePath(root, relativePath);
      if (!state.exists) {
        continue;
      }
      if (!state.stat.isFile()) {
        throw new Error(`工作区快照只允许普通文件：${relativePath}`);
      }
      snapshot.set(relativePath, hashText(await fs.promises.readFile(state.path, "utf8")));
    }
    return snapshot;
  }

  async assertSnapshotUnchanged(root, relativePath, snapshot) {
    if (!snapshot) {
      return;
    }
    const state = await inspectWorkspacePath(root, relativePath);
    const hadFile = snapshot.has(relativePath);
    if (!state.exists) {
      if (hadFile) {
        throw new Error(`${relativePath} 在拉取期间被删除，已停止覆盖。`);
      }
      return;
    }
    if (!state.stat.isFile()) {
      throw new Error(`${relativePath} 在拉取期间变成了非普通文件，已停止覆盖。`);
    }
    const currentHash = hashText(await fs.promises.readFile(state.path, "utf8"));
    if (!hadFile || snapshot.get(relativePath) !== currentHash) {
      throw new Error(`${relativePath} 在拉取期间发生变化，已停止覆盖。`);
    }
  }

  async prepareNewCandidate(root, manifest, relativePath) {
    if (manifest.version < MANIFEST_VERSION || (manifest.groups || []).some((group) => !group.workspacePath)) {
      throw new Error("本地 manifest 版本过旧，请先执行 magic-api: 增量同步本地工作区。");
    }
    let descriptor = describeResourcePath(relativePath);
    if (descriptor && descriptor.type === "metadata") {
      descriptor = describeResourcePath(descriptor.sourcePath);
    }
    if (!descriptor || !["script", "json"].includes(descriptor.type)) {
      return undefined;
    }
    if (this.findEntryByPath(manifest, descriptor.path)) {
      return undefined;
    }

    const groupId = resolveGroupId(manifest.groups, descriptor.folder, descriptor.path);
    const entry = {
      folder: descriptor.folder,
      groupId,
      type: descriptor.type,
      path: descriptor.path,
      name: "",
      serverUpdateTime: 0
    };
    if (descriptor.type === "script") {
      entry.metadataPath = descriptor.metadataPath;
    }
    const beforeReadHash = await this.hashEntry(root, entry);
    let rawMetadata;
    let content;
    if (descriptor.type === "script") {
      rawMetadata = parseJson(await this.readWorkspaceText(root, descriptor.metadataPath));
      content = await this.readWorkspaceText(root, descriptor.path);
    } else {
      rawMetadata = parseJson(await this.readWorkspaceText(root, descriptor.path));
    }
    const afterReadHash = await this.hashEntry(root, entry);
    if (afterReadHash !== beforeReadHash) {
      throw new Error(`${descriptor.path} 在读取期间发生变化，请重新执行推送。`);
    }
    const entity = buildNewResourceEntity(descriptor, rawMetadata, content, groupId);
    entry.name = entity.name;
    return { entry, entity, localHash: afterReadHash };
  }

  localChangeCount(changes) {
    return changes.created.length + changes.modified.length + changes.deleted.length + changes.invalid.length;
  }

  assertManifestServer(manifest) {
    if (!manifest.serverUrl) {
      throw new Error("manifest 缺少 serverUrl，请先同步本地工作区。");
    }
    const manifestServer = normalizeServerUrl(manifest.serverUrl);
    const currentServer = normalizeServerUrl(this.client.getServerUrl());
    if (manifestServer !== currentServer) {
      throw new Error(`本地镜像属于 ${manifestServer}，当前配置为 ${currentServer}，已阻止推送。`);
    }
  }

  async resolvePendingCreateRequestsInteractively() {
    return this.runExclusive(async () => {
      const root = await this.resolveRoot();
      const manifest = await this.readManifest(root);
      this.assertManifestServer(manifest);
      await this.ensureManifestV3(root, manifest);
      const groupResolution = await this.resolvePendingGroupCreateRequestsInteractively(root, manifest);
      const requests = Array.isArray(manifest.pendingCreateRequests) ? manifest.pendingCreateRequests : [];
      if (!requests.length) {
        if (!groupResolution.adopted && !groupResolution.cleared && !groupResolution.unresolved) {
          vscode.window.showInformationMessage("当前没有结果未知的新增预请求。");
        }
        return {
          adopted: groupResolution.adopted,
          cleared: groupResolution.cleared,
          unresolved: groupResolution.unresolved
        };
      }
      let plan = { files: [] };
      try {
        plan = buildMirrorPlan(await this.client.getResources());
      } catch (error) {
        this.output.appendLine(`[magic-api] 无法读取资源树，新增预请求只能人工确认未创建：${messageOf(error)}`);
      }
      manifest.pendingCreates = Array.isArray(manifest.pendingCreates) ? manifest.pendingCreates : [];
      const knownIds = new Set([
        ...(manifest.entries || []).map((item) => item.id),
        ...manifest.pendingCreates.map((item) => item.id)
      ]);
      const unresolved = [];
      let adopted = 0;
      let cleared = 0;
      for (const request of requests) {
        const identityMatches = (plan.files || []).filter((item) =>
          item.folder === request.folder &&
          item.entity &&
          item.entity.groupId === request.groupId &&
          item.entity.name === request.name &&
          resourceIdentityValue(item.folder, item.entity) === request.resourceKey
        );
        const semanticMatches = [];
        for (const item of identityMatches) {
          if (!item.entity.id || knownIds.has(item.entity.id)) {
            continue;
          }
          try {
            const detail = await this.client.getFile(item.entity.id);
            if (detail && detail.id === item.entity.id && matchesSemanticSignature(detail, request)) {
              semanticMatches.push(detail);
            }
          } catch (error) {
            this.output.appendLine(
              `[magic-api] 无法读取新增候选详情 ${item.entity.id}：${messageOf(error)}`
            );
          }
        }
        const candidate = semanticMatches.length === 1 ? semanticMatches[0] : undefined;
        this.output.appendLine(
          `[magic-api] 新增预请求 ${request.path} | group=${request.groupId} | name=${request.name} | path/key=${request.resourceKey} | 语义匹配=${semanticMatches.map((item) => item.id).join(",") || "无"}`
        );
        this.output.show(true);
        const adoptLabel = candidate ? `采用服务端资源 ${candidate.id}` : undefined;
        const buttons = [adoptLabel, "已确认未创建，允许重试"].filter(Boolean);
        const choice = await vscode.window.showWarningMessage(
          `新增请求 ${request.path} 的响应结果未知。资源树受 VIEW 权限过滤，插件不会自动认领或判定不存在。${candidate ? `\n检测到内容语义一致的候选 ${candidate.id}，仍需你确认它就是本次请求创建的资源。` : ""}\n只有已在 Web 工作台或由管理员核对后才能继续。`,
          { modal: true },
          ...buttons
        );
        if (candidate && choice === adoptLabel) {
          manifest.pendingCreates.push({
            id: candidate.id,
            folder: request.folder,
            groupId: request.groupId,
            path: request.path,
            metadataPath: request.metadataPath,
            createdAt: request.requestedAt
          });
          knownIds.add(candidate.id);
          adopted++;
        } else if (choice === "已确认未创建，允许重试") {
          cleared++;
        } else {
          unresolved.push(request);
        }
      }
      if (adopted || cleared) {
        manifest.pendingCreateRequests = unresolved;
        manifest.generatedAt = Date.now();
        await this.writeManifest(root, manifest);
      }
      return {
        adopted: adopted + groupResolution.adopted,
        cleared: cleared + groupResolution.cleared,
        unresolved: unresolved.length + groupResolution.unresolved
      };
    });
  }

  async resolvePendingGroupCreateRequestsInteractively(root, manifest) {
    const requests = Array.isArray(manifest.pendingGroupCreateRequests)
      ? manifest.pendingGroupCreateRequests.slice()
      : [];
    if (!requests.length) {
      return { adopted: 0, cleared: 0, unresolved: 0 };
    }
    const plan = buildMirrorPlan(await this.client.getResources());
    let adopted = 0;
    let cleared = 0;
    let unresolved = 0;
    for (const request of requests) {
      const matches = plan.groups.filter((item) => item.folder === request.folder && item.group &&
        item.group.parentId === request.parentId && item.group.name === request.name && item.group.path === request.path);
      const local = manifest.localGroups.find((group) => group.clientId === request.clientId);
      if (matches.length === 1 && local) {
        await this.resolveLocalGroup(root, manifest, local, matches[0]);
        adopted++;
        continue;
      }
      if (matches.length > 1) {
        this.output.appendLine(`[magic-api] 分组预请求 ${request.workspacePath} 匹配多个服务端分组，保留待确认状态。`);
        unresolved++;
        continue;
      }
      const choice = await vscode.window.showWarningMessage(
        `分组新增请求 ${request.workspacePath} 的结果未知，当前资源树中没有唯一匹配。只有在 Web 工作台或由管理员确认未创建后才能允许重试。`,
        { modal: true },
        "已确认未创建，允许重试"
      );
      if (choice === "已确认未创建，允许重试") {
        manifest.pendingGroupCreateRequests = manifest.pendingGroupCreateRequests.filter(
          (item) => item.operationId !== request.operationId
        );
        cleared++;
      } else {
        unresolved++;
      }
    }
    if (cleared) {
      manifest.generatedAt = Date.now();
      await this.writeManifest(root, manifest);
    }
    return { adopted, cleared, unresolved };
  }

  async recoverAutomatically() {
    return this.runExclusive(async () => {
      const root = await this.resolveRoot();
      const manifest = await this.readManifest(root);
      this.assertManifestServer(manifest);
      await this.ensureManifestV3(root, manifest);
      const blocked = [];
      let groupsAdopted = 0;
      let resourcesAdopted = 0;

      await this.reconcilePendingGroupCreates(root, manifest);
      const remotePlan = buildMirrorPlan(await this.client.getResources());
      if ((manifest.pendingGroupCreates || []).length) {
        blocked.push(...manifest.pendingGroupCreates.map((item) => ({
          kind: "group-create",
          id: item.id,
          path: item.workspacePath,
          reason: "canonical-group-not-visible"
        })));
      }
      for (const request of (manifest.pendingGroupCreateRequests || []).slice()) {
        const matches = remotePlan.groups.filter((item) => item.folder === request.folder && item.group &&
          item.group.parentId === request.parentId && item.group.name === request.name && item.group.path === request.path);
        const local = manifest.localGroups.find((group) => group.clientId === request.clientId);
        if (matches.length === 1 && local) {
          await this.resolveLocalGroup(root, manifest, local, matches[0]);
          groupsAdopted++;
        } else {
          blocked.push({
            kind: "group-create-request",
            operationId: request.operationId,
            path: request.workspacePath,
            candidates: matches.map((item) => item.group && item.group.id).filter(Boolean),
            reason: matches.length ? "multiple-matches" : "no-unique-match"
          });
        }
      }

      const knownIds = new Set([
        ...(manifest.entries || []).map((item) => item.id),
        ...(manifest.pendingCreates || []).map((item) => item.id)
      ]);
      for (const request of (manifest.pendingCreateRequests || []).slice()) {
        const identityMatches = remotePlan.files.filter((item) =>
          item.folder === request.folder && item.entity && item.entity.groupId === request.groupId &&
          item.entity.name === request.name &&
          resourceIdentityValue(item.folder, item.entity) === request.resourceKey
        );
        const semanticMatches = [];
        for (const item of identityMatches) {
          if (!item.entity.id || knownIds.has(item.entity.id)) {
            continue;
          }
          try {
            const detail = await this.client.getFile(item.entity.id);
            if (detail && detail.id === item.entity.id && matchesSemanticSignature(detail, request)) {
              semanticMatches.push(detail);
            }
          } catch (error) {
            this.output.appendLine(`[magic-api] 自动恢复无法读取候选 ${item.entity.id}：${messageOf(error)}`);
          }
        }
        if (semanticMatches.length === 1) {
          const candidate = semanticMatches[0];
          manifest.pendingCreates.push({
            id: candidate.id,
            folder: request.folder,
            groupId: request.groupId,
            path: request.path,
            metadataPath: request.metadataPath,
            createdAt: request.requestedAt
          });
          manifest.pendingCreateRequests = manifest.pendingCreateRequests.filter(
            (item) => item.operationId !== request.operationId
          );
          knownIds.add(candidate.id);
          resourcesAdopted++;
        } else {
          blocked.push({
            kind: "resource-create-request",
            operationId: request.operationId,
            path: request.path,
            candidates: semanticMatches.map((item) => item.id),
            reason: semanticMatches.length ? "multiple-matches" : "no-unique-match"
          });
        }
      }
      manifest.generatedAt = Date.now();
      await this.writeManifest(root, manifest);
      const deletesRecovered = await this.reconcilePendingDeletes(root, manifest);
      if ((manifest.pendingDeletes || []).length) {
        blocked.push(...manifest.pendingDeletes.map((item) => ({
          kind: "delete",
          id: item.id,
          path: item.path,
          reason: "remote-state-unknown"
        })));
      }
      if (blocked.length) {
        throw blockedOperationError(
          "存在无法唯一复核的远端操作，自动恢复已停止；不会猜测资源身份。",
          blocked
        );
      }
      return {
        root,
        groupsAdopted,
        resourcesAdopted,
        deletesRecovered,
        pendingCreates: (manifest.pendingCreates || []).length,
        pendingGroupCreates: (manifest.pendingGroupCreates || []).length
      };
    });
  }

  async reconcileAutomatically() {
    const recovery = await this.recoverAutomatically();
    let root = await this.resolveRoot();
    let manifest = await this.readManifest(root);
    if ((manifest.pendingCreates || []).length) {
      if ((manifest.localGroups || []).length || (manifest.pendingGroupCreates || []).length) {
        throw blockedOperationError(
          "服务端新增等待 canonical 恢复时仍存在本地分组计划，无法确定安全顺序。",
          { pendingCreates: manifest.pendingCreates, localGroups: manifest.localGroups }
        );
      }
      await this.pullAll({ full: false, force: true, source: "cli-recovery" });
    }
    const pushed = await this.pushChanged({ autoApprove: true, source: "cli" });
    if (pushed.failed || pushed.conflicts || (pushed.pendingPaths && pushed.pendingPaths.length)) {
      throw blockedOperationError("推送未完全完成，已保留本地与 journal 状态，未继续拉取覆盖。", pushed);
    }
    const pulled = await this.pullAll({ full: false, force: true, source: "cli" });
    root = await this.resolveRoot();
    manifest = await this.readManifest(root);
    return {
      root,
      recovery,
      pushed,
      pulled,
      manifestGeneratedAt: manifest.generatedAt
    };
  }

  assertNoPendingCreates(manifest) {
    this.assertNoPendingCreateRequests(manifest);
    const pending = Array.isArray(manifest.pendingCreates) ? manifest.pendingCreates : [];
    if (!pending.length) {
      return;
    }
    const details = pending.map((item) => `${item.path} (${item.id})`).join("、");
    throw new Error(`存在未完成的服务端新增：${details}。请先增量同步本地工作区以恢复 canonical 状态。`);
  }

  assertNoPendingCreateRequests(manifest) {
    const requests = Array.isArray(manifest.pendingCreateRequests) ? manifest.pendingCreateRequests : [];
    if (!requests.length) {
      return;
    }
    const details = requests.map((item) => `${item.path} (${item.operationId})`).join("、");
    throw new Error(
      `存在结果未知的新增预请求：${details}。请先执行“magic-api: 处理结果未知的新增请求”，禁止直接重试或同步。`
    );
  }

  assertNoPendingGroupCreateRequests(manifest) {
    const requests = Array.isArray(manifest.pendingGroupCreateRequests)
      ? manifest.pendingGroupCreateRequests
      : [];
    if (!requests.length) {
      return;
    }
    const details = requests.map((item) => `${item.workspacePath} (${item.operationId})`).join("、");
    throw new Error(
      `存在结果未知的分组新增预请求：${details}。请先执行“magic-api: 处理结果未知的新增请求”，禁止直接重试。`
    );
  }

  assertNoPendingGroupCreates(manifest) {
    const pending = Array.isArray(manifest.pendingGroupCreates) ? manifest.pendingGroupCreates : [];
    if (!pending.length) {
      return;
    }
    const details = pending.map((item) => `${item.workspacePath} (${item.id})`).join("、");
    throw new Error(`存在已创建但尚未从资源树确认的分组：${details}。请稍后重新推送以恢复 canonical 状态。`);
  }

  assertNoPendingDeletes(manifest) {
    const pending = Array.isArray(manifest.pendingDeletes) ? manifest.pendingDeletes : [];
    if (!pending.length) {
      return;
    }
    const details = pending.map((item) => `${item.path} (${item.id})`).join("、");
    throw new Error(`存在待复核的服务端删除：${details}。请执行“推送本地全部变更”完成复核。`);
  }

  async reconcilePendingDeletes(root, manifest) {
    const pending = Array.isArray(manifest.pendingDeletes) ? manifest.pendingDeletes : [];
    if (!pending.length) {
      return 0;
    }
    const completedIds = new Set();
    const unresolved = [];
    for (const item of pending) {
      const probe = await this.probeRemoteFile(item.id);
      if (probe.state === "unknown") {
        unresolved.push(item);
        this.output.appendLine(
          `[magic-api] 无法通过详情接口复核待删除资源，已保留恢复记录：${item.path} (${item.id})：${probe.reason}`
        );
        continue;
      }
      if (probe.state === "exists") {
        this.output.appendLine(`[magic-api] 待复核删除仍存在于服务端，将重新进入删除流程：${item.path} (${item.id})`);
        continue;
      }
      if (await this.anyEntryFileExists(root, item)) {
        unresolved.push(item);
        this.output.appendLine(`[magic-api] 待复核删除的本地文件重新出现，已暂停自动清理：${item.path} (${item.id})`);
        continue;
      }
      completedIds.add(item.id);
      await removeWorkspaceFileIfExists(root, item.path);
      if (item.metadataPath) {
        await removeWorkspaceFileIfExists(root, item.metadataPath);
      }
      this.output.appendLine(`[magic-api] 已完成上次服务端删除复核：${item.path} (${item.id})`);
    }
    manifest.entries = manifest.entries.filter((entry) => !completedIds.has(entry.id));
    manifest.pendingDeletes = unresolved;
    manifest.generatedAt = Date.now();
    await this.writeManifest(root, manifest);
    return completedIds.size;
  }

  async anyEntryFileExists(root, entry) {
    for (const relativePath of [entry.path, entry.metadataPath].filter(Boolean)) {
      const state = await inspectWorkspacePath(root, relativePath);
      if (state.exists) {
        return true;
      }
    }
    return false;
  }

  async canReuseEntry(root, oldEntry, plannedEntry, remoteTime) {
    if (!oldEntry || oldEntry.needsCanonical || !remoteTime || oldEntry.serverUpdateTime !== remoteTime) {
      return false;
    }
    if (oldEntry.path !== plannedEntry.path || oldEntry.metadataPath !== plannedEntry.metadataPath) {
      return false;
    }
    if (!(await this.entryExists(root, oldEntry))) {
      return false;
    }
    return await this.hashEntry(root, oldEntry) === oldEntry.hash;
  }

  async entryExists(root, entry) {
    const sourceState = await inspectWorkspacePath(root, entry.path);
    if (!sourceState.exists) {
      return false;
    }
    if (!sourceState.stat.isFile()) {
      throw new Error(`${entry.path} 不是普通文件。`);
    }
    if (entry.type !== "script") {
      return true;
    }
    const metadataState = await inspectWorkspacePath(root, entry.metadataPath);
    if (!metadataState.exists) {
      return false;
    }
    if (!metadataState.stat.isFile()) {
      throw new Error(`${entry.metadataPath} 不是普通文件。`);
    }
    return true;
  }

  findEntryByPath(manifest, relativePath) {
    const normalized = toPosixPath(relativePath);
    return (manifest.entries || []).find((entry) =>
      entry.path === normalized || entry.metadataPath === normalized
    );
  }

  createGroupEntry(folder, segments, group) {
    return {
      id: group.id,
      folder,
      workspacePath: path.posix.join(folder, ...segments),
      path: path.posix.join(WORKSPACE_META_DIR, WORKSPACE_GROUPS_DIR, folder, `${safeId(group.id)}.json`)
    };
  }

  createResourceEntry(folder, segments, entity, usedPaths) {
    const base = resourceBaseName(folder, entity);
    const safeBase = sanitizePathSegment(base);
    const type = isJsonOnlyResource(folder, entity) ? "json" : "script";
    const extension = type === "json" ? ".json" : ".ms";
    const candidate = path.posix.join(folder, ...segments, `${safeBase}${extension}`);
    const filePath = reserveUniquePath(candidate, usedPaths, entity.id);
    const entry = {
      id: entity.id,
      folder,
      groupId: entity.groupId,
      type,
      path: filePath,
      name: entity.name || entity.path || entity.key || entity.id || "",
      serverUpdateTime: entity.updateTime || entity.createTime || 0
    };
    if (type === "script") {
      entry.metadataPath = metadataPathForScript(filePath);
      usedPaths.add(entry.metadataPath);
    }
    return entry;
  }

  async writeResourceEntry(root, entry, entity) {
    if (entry.type === "json") {
      await this.writeJson(root, entry.path, entity);
      return;
    }
    await this.writeText(root, entry.path, entity.script || "");
    await this.writeJson(root, entry.metadataPath, cloneWithoutScript(entity));
  }

  async writeText(root, relativePath, content) {
    const normalized = normalizeRelativePath(relativePath);
    const targetState = await inspectWorkspacePath(root, normalized);
    if (targetState.exists && !targetState.stat.isFile()) {
      throw new Error(`拒绝覆盖非普通文件：${normalized}`);
    }
    const fullPath = path.join(root, normalized);
    const parentRelativePath = path.posix.dirname(normalized);
    if (parentRelativePath !== ".") {
      const parentState = await inspectWorkspacePath(root, parentRelativePath);
      if (parentState.exists && !parentState.stat.isDirectory()) {
        throw new Error(`工作区父路径不是目录：${parentRelativePath}`);
      }
    }
    await ensureDirectory(path.dirname(fullPath));
    if (parentRelativePath !== ".") {
      const parentState = await inspectWorkspacePath(root, parentRelativePath);
      if (!parentState.exists || !parentState.stat.isDirectory()) {
        throw new Error(`无法安全创建工作区父目录：${parentRelativePath}`);
      }
    }
    const latestTargetState = await inspectWorkspacePath(root, normalized);
    if (latestTargetState.exists && !latestTargetState.stat.isFile()) {
      throw new Error(`拒绝覆盖非普通文件：${normalized}`);
    }
    await fs.promises.writeFile(fullPath, content, "utf8");
  }

  async readWorkspaceText(root, relativePath) {
    const state = await assertWorkspaceRegularFile(root, relativePath);
    return fs.promises.readFile(state.path, "utf8");
  }

  async writeJson(root, relativePath, value) {
    await this.writeText(root, relativePath, `${JSON.stringify(value, null, 2)}\n`);
  }

  async hashEntry(root, entry) {
    if (entry.type === "json") {
      return hashText(await this.readWorkspaceText(root, entry.path));
    }
    const script = await this.readWorkspaceText(root, entry.path);
    const metadata = await this.readWorkspaceText(root, entry.metadataPath);
    return hashText(`${metadata}\n${script}`);
  }

  displayEntryPath(entry) {
    return entry.type === "script" ? `${entry.path} + ${entry.metadataPath}` : entry.path;
  }

  async removeMissingManagedFiles(root, oldManifest, entries, groups, snapshot) {
    const nextPaths = new Set();
    entries.forEach((entry) => {
      nextPaths.add(entry.path);
      if (entry.metadataPath) {
        nextPaths.add(entry.metadataPath);
      }
    });
    groups.forEach((group) => nextPaths.add(group.path));

    const oldPaths = [];
    (oldManifest.entries || []).forEach((entry) => {
      oldPaths.push(entry.path);
      if (entry.metadataPath) {
        oldPaths.push(entry.metadataPath);
      }
    });
    (oldManifest.groups || []).forEach((group) => oldPaths.push(group.path));

    for (const oldPath of oldPaths) {
      if (!nextPaths.has(oldPath)) {
        await this.assertSnapshotUnchanged(root, oldPath, snapshot);
        await removeWorkspaceFileIfExists(root, oldPath);
      }
    }
  }

  async resolveRoot() {
    const workspaceDir = this.client.connectionStore.getWorkspaceDir();
    let root;
    if (path.isAbsolute(workspaceDir)) {
      root = workspaceDir;
    } else {
      const workspaceFolder = vscode.workspace.workspaceFolders && vscode.workspace.workspaceFolders[0];
      if (!workspaceFolder) {
        throw new Error("请先打开一个 VS Code 工作区，或把 magicApi.workspaceDir 配置为绝对路径。");
      }
      const workspaceRoot = path.resolve(workspaceFolder.uri.fsPath);
      root = path.resolve(workspaceRoot, workspaceDir);
      if (!isPathInside(workspaceRoot, root)) {
        throw new Error(`相对 magicApi.workspaceDir 不能越出当前 VS Code 工作区：${workspaceDir}`);
      }
    }
    await this.assertWorkspaceRoot(root);
    return root;
  }

  async assertWorkspaceRoot(root) {
    const absoluteRoot = path.resolve(root);
    const parsed = path.parse(absoluteRoot);
    const segments = absoluteRoot.slice(parsed.root.length).split(path.sep).filter(Boolean);
    let current = parsed.root;
    for (const segment of segments) {
      current = path.join(current, segment);
      let stat;
      try {
        stat = await fs.promises.lstat(current);
      } catch (error) {
        if (error && error.code === "ENOENT") {
          return;
        }
        throw error;
      }
      if (stat.isSymbolicLink()) {
        throw new Error(`工作区根路径不允许包含符号链接：${current}`);
      }
      if (!stat.isDirectory()) {
        throw new Error(`工作区根路径的父级或自身不是目录：${current}`);
      }
    }
  }

  validateManifest(manifest, file) {
    const label = file || "manifest";
    if (!manifest || typeof manifest !== "object" || Array.isArray(manifest)) {
      throw new Error(`${label} 不是合法 manifest。`);
    }
    if (!Number.isInteger(manifest.version) || manifest.version < 1 || manifest.version > MANIFEST_VERSION) {
      throw new Error(`${label} 的 version 不受支持。`);
    }
    if (manifest.serverUrl !== undefined && typeof manifest.serverUrl !== "string") {
      throw new Error(`${label} 的 serverUrl 必须是字符串。`);
    }
    const entries = Array.isArray(manifest.entries) ? manifest.entries : [];
    const groups = Array.isArray(manifest.groups) ? manifest.groups : [];
    const pendingCreates = Array.isArray(manifest.pendingCreates) ? manifest.pendingCreates : [];
    const pendingCreateRequests = Array.isArray(manifest.pendingCreateRequests) ? manifest.pendingCreateRequests : [];
    const pendingDeletes = Array.isArray(manifest.pendingDeletes) ? manifest.pendingDeletes : [];
    const localGroups = Array.isArray(manifest.localGroups) ? manifest.localGroups : [];
    const pendingGroupCreateRequests = Array.isArray(manifest.pendingGroupCreateRequests)
      ? manifest.pendingGroupCreateRequests
      : [];
    const pendingGroupCreates = Array.isArray(manifest.pendingGroupCreates) ? manifest.pendingGroupCreates : [];
    const ids = new Set();
    const resourcePaths = new Set();

    entries.forEach((entry, index) => {
      const entryLabel = `${label}.entries[${index}]`;
      this.validateManifestFolder(entry && entry.folder, `${entryLabel}.folder`);
      if (!entry.id || typeof entry.id !== "string") {
        throw new Error(`${entryLabel}.id 缺失或非法。`);
      }
      if (ids.has(entry.id)) {
        throw new Error(`${label} 包含重复资源 ID：${entry.id}`);
      }
      ids.add(entry.id);
      if (manifest.version >= MANIFEST_VERSION) {
        if (!entry.groupId || typeof entry.groupId !== "string" || entry.groupId === "0") {
          throw new Error(`${entryLabel}.groupId 缺失或非法。`);
        }
        if (typeof entry.name !== "string" || !entry.name.trim()) {
          throw new Error(`${entryLabel}.name 缺失或非法。`);
        }
        if (typeof entry.hash !== "string" || !entry.hash) {
          throw new Error(`${entryLabel}.hash 缺失或非法。`);
        }
        if (entry.needsCanonical !== undefined && typeof entry.needsCanonical !== "boolean") {
          throw new Error(`${entryLabel}.needsCanonical 必须是布尔值。`);
        }
      }
      if (!entry.type || !["script", "json"].includes(entry.type)) {
        throw new Error(`${entryLabel}.type 必须是 script 或 json。`);
      }
      if ((entry.folder === "datasource") !== (entry.type === "json")) {
        throw new Error(`${entryLabel}.type 与资源目录 ${entry.folder} 不匹配。`);
      }
      entry.path = this.validateManifestResourcePath(entry.path, entry.folder, `${entryLabel}.path`);
      if (resourcePaths.has(entry.path)) {
        throw new Error(`${label} 包含重复资源路径：${entry.path}`);
      }
      resourcePaths.add(entry.path);
      if (entry.type === "script") {
        entry.metadataPath = this.validateManifestPath(entry.metadataPath, `${entryLabel}.metadataPath`);
        const legacyPrefix = `${WORKSPACE_META_DIR}/metadata/${entry.folder}/`;
        if (manifest.version >= MANIFEST_VERSION && entry.metadataPath !== metadataPathForScript(entry.path)) {
          throw new Error(`${entryLabel}.metadataPath 与脚本路径不匹配。`);
        }
        if (manifest.version < MANIFEST_VERSION &&
            entry.metadataPath !== metadataPathForScript(entry.path) &&
            !entry.metadataPath.startsWith(legacyPrefix)) {
          throw new Error(`${entryLabel}.metadataPath 不在允许的工作区位置。`);
        }
        if (resourcePaths.has(entry.metadataPath)) {
          throw new Error(`${label} 包含重复资源路径：${entry.metadataPath}`);
        }
        resourcePaths.add(entry.metadataPath);
      }
    });

    groups.forEach((group, index) => {
      const groupLabel = `${label}.groups[${index}]`;
      this.validateManifestFolder(group && group.folder, `${groupLabel}.folder`);
      if (!group.id || typeof group.id !== "string") {
        throw new Error(`${groupLabel}.id 缺失或非法。`);
      }
      group.path = this.validateManifestPath(group.path, `${groupLabel}.path`);
      const expectedPrefix = `${WORKSPACE_META_DIR}/${WORKSPACE_GROUPS_DIR}/${group.folder}/`;
      if (!group.path.startsWith(expectedPrefix)) {
        throw new Error(`${groupLabel}.path 不在分组元数据目录中。`);
      }
      if (group.workspacePath !== undefined) {
        group.workspacePath = this.validateManifestResourcePath(
          group.workspacePath,
          group.folder,
          `${groupLabel}.workspacePath`,
          true
        );
      }
    });
    const localGroupIds = new Set();
    const localGroupPaths = new Set();
    localGroups.forEach((group, index) => {
      const groupLabel = `${label}.localGroups[${index}]`;
      this.validateManifestFolder(group && group.folder, `${groupLabel}.folder`);
      if (!group.clientId || typeof group.clientId !== "string" || localGroupIds.has(group.clientId)) {
        throw new Error(`${groupLabel}.clientId 缺失、非法或重复。`);
      }
      localGroupIds.add(group.clientId);
      if (!group.parentRef || typeof group.parentRef !== "string") {
        throw new Error(`${groupLabel}.parentRef 缺失或非法。`);
      }
      validateResourceName(group.name);
      validateResourceName(group.path);
      group.workspacePath = this.validateManifestResourcePath(
        group.workspacePath,
        group.folder,
        `${groupLabel}.workspacePath`
      );
      if (localGroupPaths.has(group.workspacePath)) {
        throw new Error(`${label} 包含重复本地分组路径：${group.workspacePath}`);
      }
      if (groups.some((remote) => remote.folder === group.folder && remote.workspacePath === group.workspacePath)) {
        throw new Error(`${groupLabel}.workspacePath 与服务端分组重复。`);
      }
      localGroupPaths.add(group.workspacePath);
    });
    const remoteGroupKeys = new Set(groups.map((group) => `${group.folder}\0${group.id}`));
    localGroups.forEach((group, index) => {
      if (group.parentRef === "0") {
        return;
      }
      if (group.parentRef.startsWith("local:")) {
        const parentId = group.parentRef.slice("local:".length);
        const parent = localGroups.find((item) => item.clientId === parentId && item.folder === group.folder);
        if (!parent || path.posix.dirname(group.workspacePath) !== parent.workspacePath) {
          throw new Error(`${label}.localGroups[${index}].parentRef 非法。`);
        }
      } else if (!remoteGroupKeys.has(`${group.folder}\0${group.parentRef}`)) {
        throw new Error(`${label}.localGroups[${index}].parentRef 不属于同类型服务端分组。`);
      }
    });
    const groupRequestIds = new Set();
    pendingGroupCreateRequests.forEach((request, index) => {
      const requestLabel = `${label}.pendingGroupCreateRequests[${index}]`;
      this.validateManifestFolder(request && request.folder, `${requestLabel}.folder`);
      if (!request.operationId || typeof request.operationId !== "string" || groupRequestIds.has(request.operationId)) {
        throw new Error(`${requestLabel}.operationId 缺失、非法或重复。`);
      }
      groupRequestIds.add(request.operationId);
      if (!request.clientId || !localGroupIds.has(request.clientId)) {
        throw new Error(`${requestLabel}.clientId 不属于本地分组。`);
      }
      if (!request.parentId || typeof request.parentId !== "string") {
        throw new Error(`${requestLabel}.parentId 缺失或非法。`);
      }
      validateResourceName(request.name);
      validateResourceName(request.path);
      request.workspacePath = this.validateManifestResourcePath(
        request.workspacePath,
        request.folder,
        `${requestLabel}.workspacePath`
      );
      if (typeof request.semanticHash !== "string" || !request.semanticHash) {
        throw new Error(`${requestLabel}.semanticHash 缺失或非法。`);
      }
    });
    const pendingGroupIds = new Set();
    pendingGroupCreates.forEach((pending, index) => {
      const pendingLabel = `${label}.pendingGroupCreates[${index}]`;
      this.validateManifestFolder(pending && pending.folder, `${pendingLabel}.folder`);
      if (!pending.id || typeof pending.id !== "string" || pendingGroupIds.has(pending.id)) {
        throw new Error(`${pendingLabel}.id 缺失、非法或重复。`);
      }
      pendingGroupIds.add(pending.id);
      if (!pending.clientId || !localGroupIds.has(pending.clientId)) {
        throw new Error(`${pendingLabel}.clientId 不属于本地分组。`);
      }
      pending.workspacePath = this.validateManifestResourcePath(
        pending.workspacePath,
        pending.folder,
        `${pendingLabel}.workspacePath`
      );
    });
    if (manifest.version >= MANIFEST_VERSION) {
      const groupKeys = new Set(groups.map((group) => `${group.folder}\0${group.id}`));
      entries.forEach((entry, index) => {
        if (!groupKeys.has(`${entry.folder}\0${entry.groupId}`)) {
          throw new Error(`${label}.entries[${index}].groupId 不属于同类型 manifest 分组。`);
        }
      });
      pendingCreates.forEach((pending, index) => {
        if (!pending.groupId || !groupKeys.has(`${pending.folder}\0${pending.groupId}`)) {
          throw new Error(`${label}.pendingCreates[${index}].groupId 不属于同类型 manifest 分组。`);
        }
      });
      pendingCreateRequests.forEach((pending, index) => {
        if (!pending.groupId || !groupKeys.has(`${pending.folder}\0${pending.groupId}`)) {
          throw new Error(`${label}.pendingCreateRequests[${index}].groupId 不属于同类型 manifest 分组。`);
        }
      });
    }

    pendingCreates.forEach((pending, index) => {
      const pendingLabel = `${label}.pendingCreates[${index}]`;
      this.validateManifestFolder(pending && pending.folder, `${pendingLabel}.folder`);
      if (!pending.id || typeof pending.id !== "string") {
        throw new Error(`${pendingLabel}.id 缺失或非法。`);
      }
      pending.path = this.validateManifestResourcePath(pending.path, pending.folder, `${pendingLabel}.path`);
      if (pending.metadataPath !== undefined) {
        pending.metadataPath = this.validateManifestPath(pending.metadataPath, `${pendingLabel}.metadataPath`);
        if (pending.metadataPath !== metadataPathForScript(pending.path)) {
          throw new Error(`${pendingLabel}.metadataPath 与脚本路径不匹配。`);
        }
      }
    });
    const requestIds = new Set();
    pendingCreateRequests.forEach((pending, index) => {
      const pendingLabel = `${label}.pendingCreateRequests[${index}]`;
      this.validateManifestFolder(pending && pending.folder, `${pendingLabel}.folder`);
      if (!pending.operationId || typeof pending.operationId !== "string" || requestIds.has(pending.operationId)) {
        throw new Error(`${pendingLabel}.operationId 缺失、非法或重复。`);
      }
      requestIds.add(pending.operationId);
      pending.path = this.validateManifestResourcePath(pending.path, pending.folder, `${pendingLabel}.path`);
      if (pending.metadataPath !== undefined) {
        pending.metadataPath = this.validateManifestPath(pending.metadataPath, `${pendingLabel}.metadataPath`);
        if (pending.metadataPath !== metadataPathForScript(pending.path)) {
          throw new Error(`${pendingLabel}.metadataPath 与脚本路径不匹配。`);
        }
      }
      if (typeof pending.name !== "string" || !pending.name.trim()) {
        throw new Error(`${pendingLabel}.name 缺失或非法。`);
      }
      if (typeof pending.resourceKey !== "string" || !pending.resourceKey.trim()) {
        throw new Error(`${pendingLabel}.resourceKey 缺失或非法。`);
      }
      if (typeof pending.localHash !== "string" || !pending.localHash) {
        throw new Error(`${pendingLabel}.localHash 缺失或非法。`);
      }
      if (!Array.isArray(pending.semanticKeys) || !pending.semanticKeys.length ||
          pending.semanticKeys.some((key) => typeof key !== "string" || !key) ||
          new Set(pending.semanticKeys).size !== pending.semanticKeys.length) {
        throw new Error(`${pendingLabel}.semanticKeys 缺失、非法或重复。`);
      }
      if (typeof pending.semanticHash !== "string" || !pending.semanticHash) {
        throw new Error(`${pendingLabel}.semanticHash 缺失或非法。`);
      }
      if (!Number.isFinite(pending.requestedAt) || pending.requestedAt <= 0) {
        throw new Error(`${pendingLabel}.requestedAt 缺失或非法。`);
      }
    });
    pendingDeletes.forEach((pending, index) => {
      const pendingLabel = `${label}.pendingDeletes[${index}]`;
      this.validateManifestFolder(pending && pending.folder, `${pendingLabel}.folder`);
      if (!pending.id || typeof pending.id !== "string") {
        throw new Error(`${pendingLabel}.id 缺失或非法。`);
      }
      pending.path = this.validateManifestResourcePath(pending.path, pending.folder, `${pendingLabel}.path`);
      if (pending.metadataPath !== undefined) {
        pending.metadataPath = this.validateManifestPath(pending.metadataPath, `${pendingLabel}.metadataPath`);
        if (pending.metadataPath !== metadataPathForScript(pending.path)) {
          throw new Error(`${pendingLabel}.metadataPath 与脚本路径不匹配。`);
        }
      }
    });
    const pendingIds = new Set();
    pendingCreates.forEach((pending, index) => {
      if (ids.has(pending.id) || pendingIds.has(pending.id)) {
        throw new Error(`${label}.pendingCreates[${index}].id 与已有状态重复。`);
      }
      pendingIds.add(pending.id);
    });
    pendingDeletes.forEach((pending, index) => {
      if (pendingIds.has(pending.id)) {
        throw new Error(`${label}.pendingDeletes[${index}].id 与已有状态重复。`);
      }
      const entry = entries.find((item) => item.id === pending.id);
      if (!entry || entry.folder !== pending.folder || entry.path !== pending.path || entry.metadataPath !== pending.metadataPath) {
        throw new Error(`${label}.pendingDeletes[${index}] 与 manifest 资源不匹配。`);
      }
      pendingIds.add(pending.id);
    });
    manifest.entries = entries;
    manifest.groups = groups;
    manifest.pendingCreates = pendingCreates;
    manifest.pendingCreateRequests = pendingCreateRequests;
    manifest.pendingDeletes = pendingDeletes;
    manifest.localGroups = localGroups;
    manifest.pendingGroupCreateRequests = pendingGroupCreateRequests;
    manifest.pendingGroupCreates = pendingGroupCreates;
    return manifest;
  }

  validateManifestFolder(folder, label) {
    if (typeof folder !== "string" || !/^[A-Za-z0-9._-]+$/.test(folder)) {
      throw new Error(`${label} 非法。`);
    }
  }

  validateManifestResourcePath(value, folder, label, allowFolderRoot = false) {
    const normalized = this.validateManifestPath(value, label);
    if ((!allowFolderRoot && normalized === folder) || (normalized !== folder && !normalized.startsWith(`${folder}/`))) {
      throw new Error(`${label} 不在 ${folder} 资源目录中。`);
    }
    return normalized;
  }

  validateManifestPath(value, label) {
    if (typeof value !== "string" || !value || value.includes("\0")) {
      throw new Error(`${label} 缺失或非法。`);
    }
    const posixPath = toPosixPath(value);
    if (/^[A-Za-z]:\//.test(posixPath)) {
      throw new Error(`${label} 不能是绝对路径。`);
    }
    return normalizeRelativePath(posixPath);
  }

  async readManifest(root) {
    const relativePath = path.posix.join(WORKSPACE_META_DIR, WORKSPACE_MANIFEST);
    const state = await inspectWorkspacePath(root, relativePath);
    if (!state.exists) {
      return { version: 1, entries: [], groups: [] };
    }
    if (!state.stat.isFile()) {
      throw new Error(`${state.path} 不是普通 manifest 文件。`);
    }
    const manifest = parseJson(await fs.promises.readFile(state.path, "utf8"));
    return this.validateManifest(manifest, state.path);
  }

  async writeManifest(root, manifest) {
    this.validateManifest(manifest, "manifest");
    const relativePath = path.posix.join(WORKSPACE_META_DIR, WORKSPACE_MANIFEST);
    const parentRelativePath = WORKSPACE_META_DIR;
    const parentState = await inspectWorkspacePath(root, parentRelativePath);
    if (parentState.exists && !parentState.stat.isDirectory()) {
      throw new Error(`${parentRelativePath} 不是普通目录。`);
    }
    await ensureDirectory(path.join(root, parentRelativePath));
    const safeParentState = await inspectWorkspacePath(root, parentRelativePath);
    if (!safeParentState.exists || !safeParentState.stat.isDirectory()) {
      throw new Error(`无法安全创建 ${parentRelativePath}。`);
    }
    const targetState = await inspectWorkspacePath(root, relativePath);
    if (targetState.exists && !targetState.stat.isFile()) {
      throw new Error(`${relativePath} 不是普通文件。`);
    }

    const tempName = `.${WORKSPACE_MANIFEST}.${process.pid}.${crypto.randomBytes(6).toString("hex")}.tmp`;
    const tempPath = path.join(root, parentRelativePath, tempName);
    let handle;
    try {
      handle = await fs.promises.open(tempPath, "wx", 0o600);
      await handle.writeFile(`${JSON.stringify(manifest, null, 2)}\n`, "utf8");
      await handle.sync();
      await handle.close();
      handle = undefined;
      const latestTargetState = await inspectWorkspacePath(root, relativePath);
      if (latestTargetState.exists && !latestTargetState.stat.isFile()) {
        throw new Error(`${relativePath} 在写入期间变成了非普通文件。`);
      }
      await fs.promises.rename(tempPath, path.join(root, relativePath));
    } catch (error) {
      if (handle) {
        await handle.close().catch(() => undefined);
      }
      await fs.promises.rm(tempPath, { force: true }).catch(() => undefined);
      throw error;
    }
  }

  async writeServerInfo(root) {
    await this.writeJson(root, path.posix.join(WORKSPACE_META_DIR, WORKSPACE_SERVER), {
      serverUrl: this.client.getServerUrl(),
      requestBaseUrl: this.client.getRequestBaseUrl(),
      updatedAt: Date.now()
    });
  }
}

class MagicApiTreeDataProvider {
  constructor(client, fileSystem, workspaceMirror, output) {
    this.client = client;
    this.fileSystem = fileSystem;
    this.workspaceMirror = workspaceMirror;
    this.output = output;
    this.onDidChangeTreeDataEmitter = new vscode.EventEmitter();
    this.onDidChangeTreeData = this.onDidChangeTreeDataEmitter.event;
    this.resources = undefined;
    this.groupPaths = new Map();
  }

  async refresh() {
    this.resources = undefined;
    this.groupPaths.clear();
    this.onDidChangeTreeDataEmitter.fire();
  }

  getTreeItem(element) {
    return element;
  }

  async getChildren(element) {
    if (!element) {
      const resources = await this.loadResources();
      return Object.keys(resources)
        .sort()
        .map((folder) => this.createRootItem(folder, resources[folder]));
    }
    if (element.kind === "root") {
      return this.createChildren(element.folder, element.raw && element.raw.children);
    }
    if (element.kind === "group") {
      return this.createChildren(element.folder, element.raw && element.raw.children);
    }
    return [];
  }

  async loadResources() {
    if (!this.resources) {
      try {
        const remote = await this.client.getResources();
        this.resources = cloneResourceTree(remote);
        for (const folder of ["api", "function", "task"]) {
          if (!this.resources[folder]) {
            this.resources[folder] = emptyResourceRoot();
          }
        }
        await this.mergeLocalResources(this.resources);
        this.rebuildGroupPaths(this.resources);
      } catch (error) {
        this.output.appendLine(formatError(error));
        const choice = await vscode.window.showErrorMessage(
          `Failed to load magic-api resources: ${messageOf(error)}`,
          "Login",
          "Configure Server"
        );
        if (choice === "Login") {
          await vscode.commands.executeCommand("magicApi.login");
        } else if (choice === "Configure Server") {
          await vscode.commands.executeCommand("magicApi.configureServer");
        }
        this.resources = {
          api: emptyResourceRoot(),
          function: emptyResourceRoot(),
          task: emptyResourceRoot()
        };
        await this.mergeLocalResources(this.resources);
        this.rebuildGroupPaths(this.resources);
      }
    }
    return this.resources || {};
  }

  async getCreatableFolders() {
    const resources = await this.loadResources();
    return Object.keys(resources)
      .filter((folder) => ["api", "function", "task", "script", "component", "datasource"].includes(folder))
      .sort();
  }

  async mergeLocalResources(resources) {
    try {
      const root = await this.workspaceMirror.resolveRoot();
      const operations = new WorkspaceOperations(root, { serverUrl: this.client.getServerUrl() });
      const groups = (await operations.groups()).filter((group) => group.state === "local");
      const localResources = (await operations.list()).filter((entry) => entry.state === "local");
      const nodesByPath = new Map();
      Object.keys(resources).forEach((folder) => {
        indexTreeGroups(resources[folder], folder, [], nodesByPath);
      });
      for (const group of groups.sort((left, right) => left.workspacePath.split("/").length - right.workspacePath.split("/").length)) {
        if (!resources[group.type]) {
          resources[group.type] = emptyResourceRoot();
        }
        if (nodesByPath.has(group.workspacePath)) {
          continue;
        }
        const parentPath = path.posix.dirname(group.workspacePath);
        const parent = parentPath === "." || parentPath === group.type
          ? resources[group.type]
          : nodesByPath.get(parentPath);
        if (!parent) {
          throw new Error(`找不到本地分组 ${group.workspacePath} 的父分组。`);
        }
        const tree = {
          node: {
            id: group.id,
            name: group.name,
            path: group.path,
            type: group.type,
            parentId: group.parentRef,
            __local: true,
            __workspacePath: group.workspacePath
          },
          children: []
        };
        parent.children = Array.isArray(parent.children) ? parent.children : [];
        parent.children.push(tree);
        nodesByPath.set(group.workspacePath, tree);
      }
      for (const entry of localResources) {
        const workspacePath = path.posix.dirname(entry.path);
        const parent = nodesByPath.get(workspacePath);
        if (!parent) {
          continue;
        }
        parent.children.push({
          node: {
            id: entry.id,
            groupId: entry.groupId,
            name: entry.name,
            __local: true,
            __localPath: path.join(root, entry.path)
          },
          children: []
        });
      }
    } catch (error) {
      this.output.appendLine(`[magic-api] 读取本地待同步资源失败：${messageOf(error)}`);
    }
  }

  async getGroupPath(groupId) {
    await this.loadResources();
    return this.groupPaths.get(groupId) || "";
  }

  rebuildGroupPaths(resources) {
    this.groupPaths.clear();
    Object.keys(resources || {}).forEach((folder) => {
      walkGroupTree(resources[folder], [], this.groupPaths);
    });
  }

  createRootItem(folder, raw) {
    const label = displayFolderName(folder);
    const item = new MagicApiTreeItem(label, "root", folder, raw, undefined, vscode.TreeItemCollapsibleState.Expanded);
    item.iconPath = new vscode.ThemeIcon(iconForFolder(folder));
    return item;
  }

  createChildren(folder, children) {
    return (children || [])
      .filter((child) => child && child.node)
      .map((child) => {
        const node = child.node;
        const isFile = Object.prototype.hasOwnProperty.call(node, "groupId");
        if (isFile) {
          const label = node.name || node.path || node.key || node.id || "Untitled";
          const item = new MagicApiTreeItem(label, "file", folder, child, node, vscode.TreeItemCollapsibleState.None);
          item.contextValue = node.__local ? "magicApiLocalFile" : (node.id ? "magicApiFile" : "magicApiVirtualFile");
          item.description = descriptionForResource(folder, node);
          item.tooltip = tooltipForResource(folder, node);
          item.iconPath = new vscode.ThemeIcon(iconForResource(folder, node));
          if (node.__local && node.__localPath) {
            item.description = [item.description, "待同步"].filter(Boolean).join(" · ");
            item.resourceUri = vscode.Uri.file(node.__localPath);
            item.command = {
              command: "vscode.open",
              title: "Open Local Resource",
              arguments: [item.resourceUri]
            };
          } else if (node.id) {
            item.resourceUri = this.fileSystem.uriFor(folder, node);
            item.command = {
              command: "magicApi.openResource",
              title: "Open Resource",
              arguments: [item]
            };
          }
          return item;
        }
        const label = node.name || "Group";
        const item = new MagicApiTreeItem(label, "group", folder, child, node, vscode.TreeItemCollapsibleState.Collapsed);
        item.description = node.__local ? `${node.path || ""} · 待同步` : (node.path || "");
        item.tooltip = node.path ? `${label} (${node.path})` : label;
        item.iconPath = new vscode.ThemeIcon("folder");
        return item;
      });
  }
}

class MagicApiTreeItem extends vscode.TreeItem {
  constructor(label, kind, folder, raw, entity, collapsibleState) {
    super(label, collapsibleState);
    this.kind = kind;
    this.folder = folder;
    this.raw = raw;
    this.resource = entity ? { folder, entity } : undefined;
    this.contextValue = kind === "file" ? "magicApiFile" : `magicApi${capitalize(kind)}`;
  }
}

function parseJson(text) {
  try {
    return JSON.parse(text);
  } catch (error) {
    return undefined;
  }
}

function cloneWithoutScript(entity) {
  const metadata = Object.assign({}, entity || {});
  delete metadata.script;
  return metadata;
}

function isJsonOnlyResource(folder, entity) {
  return folder === "datasource";
}

function buildMirrorPlan(resources) {
  const plan = {
    groups: [],
    files: []
  };
  Object.keys(resources || {}).sort().forEach((folder) => {
    collectMirrorNode(resources[folder], folder, [], plan);
  });
  return plan;
}

function collectMirrorNode(treeNode, folder, parentSegments, plan) {
  if (!treeNode || !treeNode.node) {
    return;
  }
  const node = treeNode.node;
  const isFile = Object.prototype.hasOwnProperty.call(node, "groupId");
  if (isFile) {
    if (node.id) {
      plan.files.push({ folder, segments: parentSegments, entity: node });
    }
    return;
  }

  let segments = parentSegments;
  if (node.id && node.id !== "0") {
    const segment = groupPathSegment(folder, node);
    segments = segment ? parentSegments.concat(segment) : parentSegments;
    plan.groups.push({ folder, segments, group: node });
  } else if (node.id === "0") {
    plan.groups.push({ folder, segments, group: node });
  }

  (treeNode.children || []).forEach((child) => {
    collectMirrorNode(child, folder, segments, plan);
  });
}

function resourceBaseName(folder, entity) {
  if (folder === "datasource") {
    return entity.key || entity.name || entity.id || "datasource";
  }
  const value = entity.path || entity.name || entity.key || entity.id || "resource";
  const normalized = String(value).replace(/\\/g, "/").replace(/\/+$/g, "");
  const parts = normalized.split("/").filter(Boolean);
  return parts.length ? parts[parts.length - 1] : normalized;
}

function resourceIdentityValue(folder, entity) {
  const value = folder === "datasource" ? entity && entity.key : entity && entity.path;
  if (PATH_RESOURCE_TYPES.has(folder)) {
    return normalizeResourcePath(folder, value);
  }
  return String(value || "").trim();
}

function isDefiniteCreateRejection(error) {
  const code = error && error.magicApiResponse ? error.magicApiCode : undefined;
  // 仅清理由控制器/服务在 fileResource.write 之前抛出的已知校验码；-1 等异常可能发生在写入后的事件发布阶段。
  return new Set([
    -2, -10, 1001, 1009,
    1012, 1013, 1014, 1017, 1018, 1019,
    1020, 1021, 1022, 1023, 1024, 1025, 1026, 1027,
    1028, 1029, 1030, 1031
  ]).has(code);
}

function createSemanticSignature(entity) {
  const serverFields = new Set([
    "id", "groupId", "createTime", "updateTime", "createBy", "updateBy", "lock"
  ]);
  const snapshot = {};
  Object.keys(entity || {}).sort().forEach((key) => {
    if (!serverFields.has(key) && entity[key] !== undefined) {
      snapshot[key] = entity[key];
    }
  });
  return {
    keys: Object.keys(snapshot),
    hash: hashText(JSON.stringify(sortJsonValue(snapshot)))
  };
}

function matchesSemanticSignature(entity, request) {
  const snapshot = {};
  for (const key of request.semanticKeys || []) {
    if (entity && entity[key] !== undefined) {
      snapshot[key] = entity[key];
    }
  }
  return hashText(JSON.stringify(sortJsonValue(snapshot))) === request.semanticHash;
}

function sortJsonValue(value) {
  if (Array.isArray(value)) {
    return value.map(sortJsonValue);
  }
  if (value && typeof value === "object") {
    const result = {};
    Object.keys(value).sort().forEach((key) => {
      result[key] = sortJsonValue(value[key]);
    });
    return result;
  }
  return value;
}

function reserveUniquePath(candidate, usedPaths, id) {
  let next = candidate;
  let index = 1;
  const extension = path.posix.extname(candidate);
  const base = candidate.slice(0, candidate.length - extension.length);
  while (usedPaths.has(next)) {
    const suffix = id ? shortId(id) : String(index);
    next = `${base}-${suffix}${index > 1 ? `-${index}` : ""}${extension}`;
    index++;
  }
  usedPaths.add(next);
  return next;
}

function shortId(id) {
  return String(id || "").replace(/[^A-Za-z0-9]/g, "").slice(0, 8) || "resource";
}

function safeId(id) {
  return String(id || "root").replace(/[^A-Za-z0-9._-]/g, "_") || "root";
}

function isPathInside(parent, child) {
  const relative = path.relative(parent, child);
  return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
}

async function ensureDirectory(directory) {
  await fs.promises.mkdir(directory, { recursive: true });
}

async function inspectWorkspacePath(root, relativePath) {
  const normalized = normalizeRelativePath(relativePath);
  const segments = normalized.split("/");
  let current = root;
  for (let index = 0; index < segments.length; index++) {
    current = path.join(current, segments[index]);
    let stat;
    try {
      stat = await fs.promises.lstat(current);
    } catch (error) {
      if (error && error.code === "ENOENT") {
        return { exists: false, path: current, relativePath: normalized };
      }
      throw error;
    }
    if (stat.isSymbolicLink()) {
      throw new Error(`工作区路径不允许包含符号链接：${normalized}`);
    }
    if (index < segments.length - 1 && !stat.isDirectory()) {
      throw new Error(`工作区路径的父级不是目录：${normalized}`);
    }
    if (index === segments.length - 1) {
      return { exists: true, path: current, relativePath: normalized, stat };
    }
  }
  return { exists: false, path: current, relativePath: normalized };
}

async function assertWorkspaceRegularFile(root, relativePath) {
  const state = await inspectWorkspacePath(root, relativePath);
  if (!state.exists || !state.stat.isFile()) {
    throw new Error(`${relativePath} 必须是工作区内的普通文件。`);
  }
  return state;
}

async function removeWorkspaceFileIfExists(root, relativePath) {
  const state = await inspectWorkspacePath(root, relativePath);
  if (!state.exists) {
    return;
  }
  if (!state.stat.isFile()) {
    throw new Error(`拒绝删除非普通文件：${relativePath}`);
  }
  await fs.promises.rm(state.path, { force: true });
}

async function listWorkspaceFiles(root) {
  const records = [];
  await walk(root, "");
  return records;

  async function walk(directory, relativeDirectory) {
    const entries = await fs.promises.readdir(directory, { withFileTypes: true });
    for (const entry of entries) {
      if (!relativeDirectory && entry.name === WORKSPACE_META_DIR) {
        continue;
      }
      const relativePath = toPosixPath(path.join(relativeDirectory, entry.name));
      const fullPath = path.join(directory, entry.name);
      if (entry.isSymbolicLink()) {
        records.push({ path: relativePath, symlink: true });
      } else if (entry.isDirectory()) {
        await walk(fullPath, relativePath);
      } else if (entry.isFile()) {
        records.push({ path: relativePath, symlink: false });
      }
    }
  }
}

function hashText(text) {
  return crypto.createHash("sha256").update(text, "utf8").digest("hex");
}

async function buildApiRequestUrl(client, treeProvider, entity) {
  const config = await client.getConfig();
  const serverUrl = new URL(client.getServerUrl());
  const webPath = normalizeUrlPath(config.web || serverUrl.pathname);
  let appPath = normalizeUrlPath(serverUrl.pathname);
  if (webPath && appPath.endsWith(webPath)) {
    appPath = appPath.slice(0, appPath.length - webPath.length);
  }
  const groupPath = await treeProvider.getGroupPath(entity.groupId);
  const apiPath = joinUrlPath(config.prefix || "", groupPath || "", entity.path || "");
  return serverUrl.origin + joinUrlPath(appPath, apiPath);
}

function joinUrlPath(...parts) {
  const joined = parts
    .filter((part) => part !== undefined && part !== null && String(part).trim() !== "")
    .map((part) => String(part).replace(/^\/+|\/+$/g, ""))
    .filter(Boolean)
    .join("/");
  return `/${joined}`.replace(/\/+/g, "/");
}

function normalizeUrlPath(path) {
  const value = String(path || "").trim();
  if (!value || value === "/") {
    return "";
  }
  return `/${value.replace(/^\/+|\/+$/g, "")}`;
}

function prettifyResponseBody(text, contentType) {
  if (!text) {
    return "";
  }
  const shouldTryJson = contentType.includes("json") || /^[\s\r\n]*[\[{]/.test(text);
  if (shouldTryJson) {
    const parsed = parseJson(text);
    if (parsed !== undefined) {
      return JSON.stringify(parsed, null, 2);
    }
  }
  return text;
}

function walkGroupTree(treeNode, parentSegments, groupPaths) {
  if (!treeNode || !treeNode.node) {
    return;
  }
  const node = treeNode.node;
  const isFile = Object.prototype.hasOwnProperty.call(node, "groupId");
  let segments = parentSegments;
  if (!isFile && node.id && node.id !== "0") {
    segments = node.path ? parentSegments.concat(node.path) : parentSegments;
    groupPaths.set(node.id, segments.join("/"));
  }
  (treeNode.children || []).forEach((child) => {
    walkGroupTree(child, segments, groupPaths);
  });
}

function emptyResourceRoot() {
  return { node: { id: "0", name: "root" }, children: [] };
}

function cloneResourceTree(resources) {
  return resources && typeof resources === "object"
    ? JSON.parse(JSON.stringify(resources))
    : {};
}

function indexTreeGroups(treeNode, folder, parentSegments, nodesByPath) {
  if (!treeNode || !treeNode.node) {
    return;
  }
  const node = treeNode.node;
  if (Object.prototype.hasOwnProperty.call(node, "groupId")) {
    return;
  }
  let segments = parentSegments;
  if (node.id && node.id !== "0" && node.id !== `${folder}:0`) {
    const segment = groupPathSegment(folder, node);
    segments = segment ? parentSegments.concat(segment) : parentSegments;
  }
  const workspacePath = segments.length ? `${folder}/${segments.join("/")}` : folder;
  nodesByPath.set(workspacePath, treeNode);
  (treeNode.children || []).forEach((child) => indexTreeGroups(child, folder, segments, nodesByPath));
}

function parseMagicApiUri(uri) {
  const parts = uri.path.split("/").filter(Boolean);
  return {
    folder: parts[0],
    id: parts[1]
  };
}

function entityKey(folder, id) {
  return `${folder}:${id}`;
}

function sanitizeFileName(name) {
  return String(name || "untitled")
    .replace(/[\\/:*?"<>|#%&{}$!'@+`=]/g, "_")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 80) || "untitled";
}

function displayFolderName(folder) {
  const names = {
    api: "API",
    function: "Functions",
    datasource: "Data Sources",
    task: "Tasks",
    script: "Scripts",
    component: "Components"
  };
  return names[folder] || capitalize(folder);
}

function descriptionForResource(folder, entity) {
  if (folder === "api") {
    return [entity.method, entity.path].filter(Boolean).join(" ");
  }
  if (folder === "function" || folder === "task" || folder === "script" || folder === "component") {
    return entity.path || "";
  }
  if (folder === "datasource") {
    return entity.key || "";
  }
  return entity.path || entity.key || "";
}

function tooltipForResource(folder, entity) {
  const description = descriptionForResource(folder, entity);
  return description ? `${entity.name || entity.id} - ${description}` : (entity.name || entity.id || folder);
}

function iconForFolder(folder) {
  if (folder === "datasource") {
    return "database";
  }
  if (folder === "function") {
    return "symbol-function";
  }
  if (folder === "script") {
    return "file-code";
  }
  return "server";
}

function iconForResource(folder) {
  if (folder === "api") {
    return "symbol-method";
  }
  if (folder === "function") {
    return "symbol-function";
  }
  if (folder === "datasource") {
    return "database";
  }
  if (folder === "task") {
    return "watch";
  }
  if (folder === "script") {
    return "file-code";
  }
  return "file-code";
}

function capitalize(value) {
  const text = String(value || "");
  return text ? text.charAt(0).toUpperCase() + text.slice(1) : text;
}

function messageOf(error) {
  return error && error.message ? error.message : String(error);
}

function formatError(error) {
  return error && error.stack ? error.stack : messageOf(error);
}

function blockedOperationError(message, details) {
  const error = new Error(message);
  error.code = "blocked";
  error.details = details;
  return error;
}

module.exports = {
  activate,
  deactivate,
  __test: {
    MagicApiWorkspaceMirror,
    MagicApiTreeDataProvider,
    inspectWorkspacePath
  }
};
