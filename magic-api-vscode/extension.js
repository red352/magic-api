"use strict";

const crypto = require("crypto");
const fs = require("fs");
const path = require("path");
const vscode = require("vscode");
const { MagicApiClient, normalizeServerUrl } = require("./src/client");
const { registerMagicScriptLanguageFeatures } = require("./src/language");
const { openApiRunnerPanel } = require("./src/views/apiRunner");
const {
  renderMetadataEditorHtml,
  metadataEditorPayloadToEntity
} = require("./src/views/metadataEditor");

const SCHEME = "magic-api";
const WORKSPACE_META_DIR = ".magic-api";
const WORKSPACE_MANIFEST = "manifest.json";
const WORKSPACE_SERVER = "server.json";
const WORKSPACE_METADATA_DIR = "metadata";
const WORKSPACE_GROUPS_DIR = "groups";
const DEFAULT_WORKSPACE_DIR = ".magic-api-workspace";

function activate(context) {
  const output = vscode.window.createOutputChannel("magic-api");
  const client = new MagicApiClient(context, output, vscode);
  const fileSystem = new MagicApiFileSystemProvider(client, output);
  const workspaceMirror = new MagicApiWorkspaceMirror(context, client, output);
  const treeProvider = new MagicApiTreeDataProvider(client, fileSystem, output);
  const statusBar = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 100);

  statusBar.command = "magicApi.configureServer";
  statusBar.text = "$(plug) magic-api";
  statusBar.tooltip = "Configure magic-api server";
  statusBar.show();

  context.subscriptions.push(output, statusBar);
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
      if (!vscode.workspace.getConfiguration("magicApi").get("syncOnSave")) {
        return;
      }
      try {
        await workspaceMirror.pushDocumentIfManaged(document);
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
  context.subscriptions.push(registerMagicScriptLanguageFeatures({ vscode, client, output, workspaceMirror }));

  context.subscriptions.push(
    vscode.commands.registerCommand("magicApi.configureServer", async () => {
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
      await vscode.workspace
        .getConfiguration("magicApi")
        .update("serverUrl", normalizeServerUrl(serverUrl), vscode.ConfigurationTarget.Global);
      client.clearCache();
      await treeProvider.refresh();
      vscode.window.showInformationMessage(`magic-api server set to ${normalizeServerUrl(serverUrl)}`);
    }),
    vscode.commands.registerCommand("magicApi.login", async () => {
      await login(client);
      await treeProvider.refresh();
    }),
    vscode.commands.registerCommand("magicApi.setToken", async () => {
      const token = await vscode.window.showInputBox({
        title: "magic-api Magic-Token",
        prompt: "粘贴从 magic-api Web 工作台获取到的 Magic-Token。",
        password: true,
        ignoreFocusOut: true
      });
      if (!token) {
        return;
      }
      await client.setToken(token.trim());
      await treeProvider.refresh();
      vscode.window.showInformationMessage("Magic-Token 已保存。");
    }),
    vscode.commands.registerCommand("magicApi.clearToken", async () => {
      await client.clearToken();
      client.clearCache();
      await treeProvider.refresh();
      vscode.window.showInformationMessage("magic-api 登录状态已清除。");
    }),
    vscode.commands.registerCommand("magicApi.refreshResources", async () => {
      client.clearCache();
      await treeProvider.refresh();
    }),
    vscode.commands.registerCommand("magicApi.syncWorkspace", async () => {
      const result = await workspaceMirror.pullAll({ full: false });
      if (result.cancelled) {
        return;
      }
      client.clearCache();
      await treeProvider.refresh();
      await updateLocalFileContext(vscode.window.activeTextEditor);
      vscode.window.showInformationMessage(
        `magic-api 增量同步完成：总计 ${result.count}，下载 ${result.downloaded}，复用 ${result.reused}。`
      );
    }),
    vscode.commands.registerCommand("magicApi.pullWorkspace", async () => {
      const result = await workspaceMirror.pullAll({ full: true });
      if (result.cancelled) {
        return;
      }
      client.clearCache();
      await treeProvider.refresh();
      await updateLocalFileContext(vscode.window.activeTextEditor);
      vscode.window.showInformationMessage(
        `magic-api 已全量拉取 ${result.count} 个资源到 ${result.root}。`
      );
    }),
    vscode.commands.registerCommand("magicApi.pushCurrentLocalFile", async () => {
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
        vscode.window.showInformationMessage(`magic-api 已推送 ${pushed.path}.`);
      } else if (pushed && pushed.skipped) {
        vscode.window.showInformationMessage(`magic-api 无需推送，${pushed.path} 没有本地变更。`);
      }
    }),
    vscode.commands.registerCommand("magicApi.pushWorkspace", async () => {
      const result = await workspaceMirror.pushChanged();
      const skipped = result.skipped ? `，跳过 ${result.skipped} 个删除项` : "";
      const conflicts = result.conflicts ? `，冲突 ${result.conflicts} 个` : "";
      vscode.window.showInformationMessage(`magic-api 已推送 ${result.count} 个本地变更${skipped}${conflicts}。`);
    }),
    vscode.commands.registerCommand("magicApi.openResource", async (item) => {
      if (!item || !item.resource || !item.resource.entity || !item.resource.entity.id) {
        vscode.window.showWarningMessage("Select a saved magic-api resource first.");
        return;
      }
      const uri = await workspaceMirror.openResource(item.resource.folder, item.resource.entity);
      const document = await vscode.workspace.openTextDocument(uri);
      const editor = await vscode.window.showTextDocument(document, { preview: false });
      await updateLocalFileContext(editor);
    }),
    vscode.commands.registerCommand("magicApi.saveCurrentResource", async () => {
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
    vscode.commands.registerCommand("magicApi.openMetadataEditor", async (item) => {
      await workspaceMirror.openMetadataEditor(item);
    }),
    vscode.commands.registerCommand("magicApi.runCurrentApi", async (item) => {
      await runCurrentApi(item, client, fileSystem, workspaceMirror, treeProvider, output);
    }),
    vscode.commands.registerCommand("magicApi.showCurrentMetadata", async () => {
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
    vscode.commands.registerCommand("magicApi.openInWorkbench", async () => {
      await vscode.env.openExternal(vscode.Uri.parse(client.getServerUrl()));
    }),
    vscode.commands.registerCommand("magicApi.installAiSkills", async () => {
      await installAiSkillsToWorkspace(context, output);
    })
  );

  treeProvider.refresh().catch((error) => {
    output.appendLine(formatError(error));
  });
}

function deactivate() {}

async function installAiSkillsToWorkspace(context, output) {
  const workspaceFolder = await pickWorkspaceFolder();
  if (!workspaceFolder) {
    return;
  }

  const source = path.join(context.extensionPath, "ai-skills", "magic-script");
  if (!await fileExists(path.join(source, "SKILL.md"))) {
    vscode.window.showErrorMessage("当前扩展包中没有找到 magic-script AI Skill。");
    return;
  }

  const destination = path.join(workspaceFolder.uri.fsPath, ".codex", "skills", "magic-script");
  if (await fileExists(destination)) {
    const choice = await vscode.window.showWarningMessage(
      `工作区已存在 ${path.relative(workspaceFolder.uri.fsPath, destination)}，是否覆盖？`,
      { modal: true },
      "覆盖"
    );
    if (choice !== "覆盖") {
      return;
    }
    await fs.promises.rm(destination, { recursive: true, force: true });
  }

  await copyDirectory(source, destination);
  output.appendLine(`AI Skill installed: ${destination}`);
  vscode.window.showInformationMessage(`magic-api AI Skills 已安装到 ${path.relative(workspaceFolder.uri.fsPath, destination)}。`);
}

async function pickWorkspaceFolder() {
  const folders = vscode.workspace.workspaceFolders || [];
  if (!folders.length) {
    vscode.window.showWarningMessage("请先打开一个 VS Code 工作区。");
    return undefined;
  }
  if (folders.length === 1) {
    return folders[0];
  }

  const selected = await vscode.window.showQuickPick(
    folders.map((folder) => ({
      label: folder.name,
      description: folder.uri.fsPath,
      folder
    })),
    {
      title: "选择安装 AI Skills 的工作区"
    }
  );
  return selected && selected.folder;
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
  const username = await vscode.window.showInputBox({
    title: "magic-api login",
    prompt: "Username",
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
  }

  async pullAll(options = {}) {
    return vscode.window.withProgress(
      {
        location: vscode.ProgressLocation.Notification,
        title: options.full ? "magic-api 全量拉取本地工作区" : "magic-api 增量同步本地工作区",
        cancellable: false
      },
      (progress) => this.pullAllWithProgress(progress, options)
    );
  }

  async pullAllWithProgress(progress, options = {}) {
    const root = await this.resolveRoot();
    await ensureDirectory(root);
    this.output.appendLine(`[magic-api] 开始拉取资源到 ${root}`);
    progress.report({ message: "检查本地变更" });

    const oldManifest = await this.readManifest(root);
    const dirtyEntries = await this.findDirtyEntries(root, oldManifest);
    if (dirtyEntries.length) {
      const choice = await vscode.window.showWarningMessage(
        `本地镜像有 ${dirtyEntries.length} 个未推送变更，继续拉取会覆盖这些文件。`,
        { modal: true },
        "覆盖本地变更"
      );
      if (choice !== "覆盖本地变更") {
        return { root, count: 0, cancelled: true };
      }
    }

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
        entries.push(oldEntry);
        reused++;
        progress.report({
          increment: 80 / total,
          message: `跳过未变化资源 ${reused}/${plan.files.length}`
        });
        continue;
      }
      const entity = await this.client.getFile(item.entity.id);
      await this.writeResourceEntry(root, plannedEntry, entity);
      plannedEntry.serverUpdateTime = entity.updateTime || entity.createTime || remoteTime;
      plannedEntry.hash = await this.hashEntry(root, plannedEntry);
      entries.push(plannedEntry);
      downloaded++;
      progress.report({
        increment: 80 / total,
        message: `下载资源 ${downloaded}/${plan.files.length}`
      });
    }

    progress.report({ message: "写入 manifest" });
    await this.removeMissingManagedFiles(root, oldManifest, entries, groupEntries);
    const manifest = {
      version: 1,
      generatedAt: Date.now(),
      serverUrl: this.client.getServerUrl(),
      entries,
      groups: groupEntries
    };
    await this.writeManifest(root, manifest);
    await this.writeServerInfo(root);
    this.output.appendLine(`[magic-api] 拉取完成：下载 ${downloaded}，复用 ${reused}，总计 ${entries.length}`);
    return { root, count: entries.length, downloaded, reused };
  }

  async pushDocumentIfManaged(document) {
    if (!document || !(await this.isManagedUri(document.uri))) {
      return null;
    }
    return this.pushUri(document.uri, { silent: true });
  }

  async pushUri(uri, options = {}) {
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
  }

  async pushUriWithProgress(uri, progress, options = {}) {
    if (uri.scheme !== "file") {
      vscode.window.showWarningMessage("当前文件不是本地 magic-api 镜像文件。");
      return null;
    }
    const root = await this.resolveRoot();
    const manifest = await this.readManifest(root);
    const relativePath = toPosixPath(path.relative(root, uri.fsPath));
    const entry = this.findEntryByPath(manifest, relativePath);
    if (!entry) {
      if (!options.silent) {
        vscode.window.showWarningMessage("当前文件不在 magic-api 本地镜像 manifest 中。");
      }
      return null;
    }
    if (progress) {
      progress.report({ message: this.displayEntryPath(entry), increment: 20 });
    }
    const result = await this.pushEntry(root, manifest, entry, options);
    if (result.pushed) {
      if (progress) {
        progress.report({ message: "刷新服务端缓存", increment: 80 });
      }
      await this.client.reload();
      vscode.window.setStatusBarMessage(`magic-api 已同步 ${this.displayEntryPath(entry)}`, 3000);
    }
    return Object.assign({ path: this.displayEntryPath(entry) }, result);
  }

  async pushChanged() {
    return vscode.window.withProgress(
      {
        location: vscode.ProgressLocation.Notification,
        title: "magic-api 推送本地变更",
        cancellable: false
      },
      async (progress) => {
        const root = await this.resolveRoot();
        const manifest = await this.readManifest(root);
        const entries = await this.findDirtyEntries(root, manifest);
        let count = 0;
        let skipped = 0;
        let conflicts = 0;
        const total = Math.max(entries.length, 1);
        this.output.appendLine(`[magic-api] 开始推送本地变更：${entries.length} 个候选项`);
        for (const entry of entries) {
          if (!(await this.entryExists(root, entry))) {
            skipped++;
            this.output.appendLine(`[magic-api] 跳过删除项：${this.displayEntryPath(entry)}`);
            progress.report({ increment: 80 / total, message: `跳过删除项 ${skipped}` });
            continue;
          }
          const result = await this.pushEntry(root, manifest, entry);
          if (result.conflict) {
            conflicts++;
          } else if (result.pushed) {
            count++;
          } else {
            skipped++;
          }
          progress.report({ increment: 80 / total, message: `${count}/${entries.length}` });
        }
        await this.writeManifest(root, manifest);
        if (count > 0) {
          progress.report({ increment: 20, message: "刷新服务端缓存" });
          await this.client.reload();
        }
        this.output.appendLine(`[magic-api] 推送完成：成功 ${count}，跳过 ${skipped}，冲突 ${conflicts}`);
        return { root, count, skipped, conflicts };
      }
    );
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
    const entity = await this.readEntityFromEntry(root, entry);
    const savedId = await this.client.saveFile(entry.folder, entity);
    if (savedId) {
      entry.id = savedId;
      entity.id = savedId;
    }
    const canonical = await this.client.getFile(entry.id || savedId);
    await this.writeResourceEntry(root, entry, canonical);
    entry.name = canonical.name || canonical.path || canonical.key || entry.name || "";
    entry.serverUpdateTime = canonical.updateTime || canonical.createTime || Date.now();
    entry.hash = await this.hashEntry(root, entry);
    manifest.generatedAt = Date.now();
    await this.writeManifest(root, manifest);
    this.output.appendLine(`[magic-api] 已推送 ${this.displayEntryPath(entry)}`);
    return { pushed: true };
  }

  async confirmNoRemoteConflict(entry, options = {}) {
    if (!vscode.workspace.getConfiguration("magicApi").get("checkConflicts")) {
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
    const choice = await vscode.window.showWarningMessage(
      `服务端资源 ${entry.name || entry.id} 在本地拉取后发生过修改。`,
      { modal: !options.silent },
      "覆盖服务端",
      "取消"
    );
    return choice === "覆盖服务端";
  }

  async readEntityFromEntry(root, entry) {
    if (entry.type === "json") {
      const text = await fs.promises.readFile(path.join(root, entry.path), "utf8");
      const entity = parseJson(text);
      if (!entity || typeof entity !== "object") {
        throw new Error(`${entry.path} 不是合法 JSON。`);
      }
      if (entry.id && !entity.id) {
        entity.id = entry.id;
      }
      return entity;
    }

    const metadataText = await fs.promises.readFile(path.join(root, entry.metadataPath), "utf8");
    const metadata = parseJson(metadataText);
    if (!metadata || typeof metadata !== "object") {
      throw new Error(`${entry.metadataPath} 不是合法 JSON。`);
    }
    const script = await fs.promises.readFile(path.join(root, entry.path), "utf8");
    const entity = Object.assign({}, metadata, { script });
    if (entry.id && !entity.id) {
      entity.id = entry.id;
    }
    return entity;
  }

  async getResourceForUri(uri) {
    const root = await this.resolveRoot();
    const manifest = await this.readManifest(root);
    const entry = this.findEntryByUri(root, manifest, uri);
    if (!entry) {
      throw new Error("当前文件不是 magic-api 本地镜像资源。");
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
    const panel = vscode.window.createWebviewPanel(
      "magicApiMetadata",
      `magic-api: ${entry.name || entry.id}`,
      vscode.ViewColumn.Beside,
      { enableScripts: true }
    );
    panel.webview.html = renderMetadataEditorHtml(entry, entity, panel.webview.cspSource);
    panel.webview.onDidReceiveMessage(async (message) => {
      try {
        if (!message || !["saveLocal", "savePush"].includes(message.command)) {
          return;
        }
        const nextEntity = metadataEditorPayloadToEntity(entity, message);
        await this.writeMetadataFromEditor(root, entry, nextEntity);
        entry.name = nextEntity.name || nextEntity.path || nextEntity.key || entry.name || "";
        entry.hash = await this.hashEntry(root, entry);
        manifest.generatedAt = Date.now();
        await this.writeManifest(root, manifest);
        if (message.command === "savePush") {
          const result = await this.pushEntry(root, manifest, entry, { force: true });
          if (result.pushed) {
            await this.client.reload();
          }
          vscode.window.showInformationMessage(`magic-api 已保存并推送 ${this.displayEntryPath(entry)}。`);
        } else {
          vscode.window.showInformationMessage(`magic-api 已保存本地元数据 ${entry.name || entry.id}。`);
        }
      } catch (error) {
        this.output.appendLine(formatError(error));
        vscode.window.showErrorMessage(`保存 magic-api 元数据失败：${messageOf(error)}`);
      }
    });
  }

  async writeMetadataFromEditor(root, entry, entity) {
    if (entry.type === "script") {
      await this.writeJson(root, entry.metadataPath, cloneWithoutScript(entity));
      return;
    }
    await this.writeResourceEntry(root, entry, entity);
  }

  async openResource(folder, entity) {
    const root = await this.resolveRoot();
    let manifest = await this.readManifest(root);
    let entry = this.findEntryById(manifest, entity.id);
    if (!entry || !(await this.entryExists(root, entry))) {
      if (!vscode.workspace.getConfiguration("magicApi").get("autoPullOnOpen")) {
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
    return Boolean(this.findEntryByUri(root, manifest, uri));
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

  async findDirtyEntries(root, manifest) {
    const entries = Array.isArray(manifest.entries) ? manifest.entries : [];
    const dirty = [];
    for (const entry of entries) {
      if (!(await this.entryExists(root, entry))) {
        dirty.push(entry);
        continue;
      }
      const hash = await this.hashEntry(root, entry);
      if (hash !== entry.hash) {
        dirty.push(entry);
      }
    }
    return dirty;
  }

  async canReuseEntry(root, oldEntry, plannedEntry, remoteTime) {
    if (!oldEntry || !remoteTime || oldEntry.serverUpdateTime !== remoteTime) {
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
    if (!(await fileExists(path.join(root, entry.path)))) {
      return false;
    }
    if (entry.type !== "script") {
      return true;
    }
    return fileExists(path.join(root, entry.metadataPath));
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
      type,
      path: filePath,
      name: entity.name || entity.path || entity.key || entity.id || "",
      serverUpdateTime: entity.updateTime || entity.createTime || 0
    };
    if (type === "script") {
      entry.metadataPath = path.posix.join(WORKSPACE_META_DIR, WORKSPACE_METADATA_DIR, folder, `${safeId(entity.id)}.json`);
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
    const fullPath = path.join(root, relativePath);
    await ensureDirectory(path.dirname(fullPath));
    await fs.promises.writeFile(fullPath, content, "utf8");
  }

  async writeJson(root, relativePath, value) {
    await this.writeText(root, relativePath, `${JSON.stringify(value, null, 2)}\n`);
  }

  async hashEntry(root, entry) {
    if (entry.type === "json") {
      return hashText(await fs.promises.readFile(path.join(root, entry.path), "utf8"));
    }
    const script = await fs.promises.readFile(path.join(root, entry.path), "utf8");
    const metadata = await fs.promises.readFile(path.join(root, entry.metadataPath), "utf8");
    return hashText(`${metadata}\n${script}`);
  }

  displayEntryPath(entry) {
    return entry.type === "script" ? `${entry.path} + ${entry.metadataPath}` : entry.path;
  }

  async removeMissingManagedFiles(root, oldManifest, entries, groups) {
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
        await removeFileIfExists(path.join(root, oldPath));
      }
    }
  }

  async resolveRoot() {
    const configured = vscode.workspace.getConfiguration("magicApi").get("workspaceDir");
    const workspaceDir = String(configured || DEFAULT_WORKSPACE_DIR).trim() || DEFAULT_WORKSPACE_DIR;
    if (path.isAbsolute(workspaceDir)) {
      return workspaceDir;
    }
    const workspaceFolder = vscode.workspace.workspaceFolders && vscode.workspace.workspaceFolders[0];
    if (!workspaceFolder) {
      throw new Error("请先打开一个 VS Code 工作区，或把 magicApi.workspaceDir 配置为绝对路径。");
    }
    return path.join(workspaceFolder.uri.fsPath, workspaceDir);
  }

  async readManifest(root) {
    const file = path.join(root, WORKSPACE_META_DIR, WORKSPACE_MANIFEST);
    if (!(await fileExists(file))) {
      return { version: 1, entries: [], groups: [] };
    }
    const manifest = parseJson(await fs.promises.readFile(file, "utf8"));
    if (!manifest || typeof manifest !== "object") {
      throw new Error(`${file} 不是合法 manifest。`);
    }
    manifest.entries = Array.isArray(manifest.entries) ? manifest.entries : [];
    manifest.groups = Array.isArray(manifest.groups) ? manifest.groups : [];
    return manifest;
  }

  async writeManifest(root, manifest) {
    await this.writeJson(root, path.posix.join(WORKSPACE_META_DIR, WORKSPACE_MANIFEST), manifest);
  }

  async writeServerInfo(root) {
    await this.writeJson(root, path.posix.join(WORKSPACE_META_DIR, WORKSPACE_SERVER), {
      serverUrl: this.client.getServerUrl(),
      updatedAt: Date.now()
    });
  }
}

class MagicApiTreeDataProvider {
  constructor(client, fileSystem, output) {
    this.client = client;
    this.fileSystem = fileSystem;
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
        this.resources = await this.client.getResources();
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
        this.resources = {};
      }
    }
    return this.resources || {};
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
          item.contextValue = node.id ? "magicApiFile" : "magicApiVirtualFile";
          item.description = descriptionForResource(folder, node);
          item.tooltip = tooltipForResource(folder, node);
          item.iconPath = new vscode.ThemeIcon(iconForResource(folder, node));
          if (node.id) {
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
        item.description = node.path || "";
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
    const segment = sanitizePathSegment(node.path || node.name || node.id);
    segments = parentSegments.concat(segment);
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

function sanitizePathSegment(name) {
  return String(name || "untitled")
    .replace(/[\\/:*?"<>|#%&{}$!'@+`=]/g, "_")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 80) || "untitled";
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

function toPosixPath(filePath) {
  return String(filePath || "").split(path.sep).join("/");
}

function isPathInside(parent, child) {
  const relative = path.relative(parent, child);
  return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
}

async function ensureDirectory(directory) {
  await fs.promises.mkdir(directory, { recursive: true });
}

async function copyDirectory(source, destination) {
  await ensureDirectory(destination);
  const entries = await fs.promises.readdir(source, { withFileTypes: true });
  for (const entry of entries) {
    const sourcePath = path.join(source, entry.name);
    const destinationPath = path.join(destination, entry.name);
    if (entry.isDirectory()) {
      await copyDirectory(sourcePath, destinationPath);
    } else if (entry.isFile()) {
      await fs.promises.copyFile(sourcePath, destinationPath);
    }
  }
}

async function fileExists(filePath) {
  try {
    await fs.promises.access(filePath);
    return true;
  } catch (error) {
    return false;
  }
}

async function removeFileIfExists(filePath) {
  if (await fileExists(filePath)) {
    await fs.promises.rm(filePath, { force: true });
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
    component: "Components"
  };
  return names[folder] || capitalize(folder);
}

function descriptionForResource(folder, entity) {
  if (folder === "api") {
    return [entity.method, entity.path].filter(Boolean).join(" ");
  }
  if (folder === "function" || folder === "task" || folder === "component") {
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

module.exports = {
  activate,
  deactivate
};
