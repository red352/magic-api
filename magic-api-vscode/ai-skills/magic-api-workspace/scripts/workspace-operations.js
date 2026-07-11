"use strict";

const crypto = require("crypto");
const fs = require("fs");
const path = require("path");

const MANIFEST_VERSION = 3;
const PREVIOUS_MANIFEST_VERSION = 2;
const SCRIPT_METADATA_SUFFIX = ".magic.json";
const PATH_RESOURCE_TYPES = new Set(["api", "function", "task", "script", "component"]);
const SERVER_OWNED_FIELDS = [
  "id", "groupId", "createTime", "updateTime", "createBy", "updateBy", "lock",
  "script", "folder", "hash", "serverUpdateTime"
];
const NAME_PATTERN = /^(?!\.)[\u4e00-\u9fa5_a-zA-Z0-9.\-()]+$/;

class WorkspaceOperations {
  constructor(root, options = {}) {
    if (!root) {
      throw new Error("必须显式提供 magic-api 本地镜像根目录。");
    }
    this.root = path.resolve(root);
    this.expectedServerUrl = options.serverUrl ? normalizeServerUrl(options.serverUrl) : "";
  }

  async readManifest() {
    await assertSafeRoot(this.root);
    const state = await inspectWorkspacePath(this.root, ".magic-api/manifest.json");
    if (!state.exists || !state.stat.isFile()) {
      throw new Error(`${this.root} 中没有 .magic-api/manifest.json，请先同步工作区。`);
    }
    let manifest;
    try {
      manifest = JSON.parse(await fs.promises.readFile(state.path, "utf8"));
    } catch (error) {
      throw new Error(`manifest 不是合法 JSON：${error.message}`);
    }
    manifest = migrateManifest(manifest);
    validateManifestShape(manifest);
    if (this.expectedServerUrl && normalizeServerUrl(manifest.serverUrl) !== this.expectedServerUrl) {
      throw new Error(`本地镜像属于 ${manifest.serverUrl}，当前服务为 ${this.expectedServerUrl}。`);
    }
    return manifest;
  }

  async status() {
    const manifest = await this.readManifest();
    const changes = await this.scanChanges(manifest);
    return {
      root: this.root,
      serverUrl: manifest.serverUrl,
      version: manifest.version,
      resources: manifest.entries.length,
      groups: manifest.groups.length,
      pending: {
        creates: manifest.pendingCreates.length,
        createRequests: manifest.pendingCreateRequests.length,
        deletes: manifest.pendingDeletes.length,
        localGroups: manifest.localGroups.length,
        groupCreates: manifest.pendingGroupCreates.length,
        groupCreateRequests: manifest.pendingGroupCreateRequests.length
      },
      changes
    };
  }

  async groups(type) {
    const manifest = await this.readManifest();
    const remote = manifest.groups
      .filter((group) => !type || group.folder === type)
      .map((group) => ({
        id: group.id,
        type: group.folder,
        workspacePath: group.workspacePath,
        state: "remote"
      }));
    const local = manifest.localGroups
      .filter((group) => !type || group.folder === type)
      .map((group) => ({
        id: `local:${group.clientId}`,
        clientId: group.clientId,
        type: group.folder,
        parentRef: group.parentRef,
        name: group.name,
        path: group.path,
        workspacePath: group.workspacePath,
        state: "local"
      }));
    return remote.concat(local).sort((left, right) => left.workspacePath.localeCompare(right.workspacePath));
  }

  async list(type) {
    const manifest = await this.readManifest();
    const managed = manifest.entries
      .filter((entry) => !type || entry.folder === type)
      .map((entry) => Object.assign(publicEntry(entry), { state: "remote" }));
    const local = (await this.discoverLocalEntries(manifest))
      .filter((entry) => !type || entry.folder === type)
      .map((entry) => Object.assign(publicEntry(entry), { state: "local" }));
    return managed.concat(local);
  }

  async get(id) {
    const manifest = await this.readManifest();
    const entry = await this.findResourceReference(manifest, id);
    return {
      entry: publicEntry(entry),
      entity: await this.readEntity(entry)
    };
  }

  async validate() {
    const manifest = await this.readManifest();
    const errors = [];
    const changes = await this.scanChanges(manifest);
    if (manifest.pendingCreateRequests.length) {
      errors.push(`存在 ${manifest.pendingCreateRequests.length} 个结果未知的新增请求。`);
    }
    if (manifest.pendingCreates.length) {
      errors.push(`存在 ${manifest.pendingCreates.length} 个待恢复的新增资源。`);
    }
    if (manifest.pendingDeletes.length) {
      errors.push(`存在 ${manifest.pendingDeletes.length} 个待复核的删除资源。`);
    }
    if (manifest.pendingGroupCreateRequests.length) {
      errors.push(`存在 ${manifest.pendingGroupCreateRequests.length} 个结果未知的分组新增请求。`);
    }
    if (manifest.pendingGroupCreates.length) {
      errors.push(`存在 ${manifest.pendingGroupCreates.length} 个待恢复的新增分组。`);
    }
    for (const entry of manifest.entries) {
      if (changes.deleted.includes(entry.path)) {
        continue;
      }
      try {
        const entity = await this.readEntity(entry);
        validateExistingEntity(entry, entity);
      } catch (error) {
        errors.push(`${entry.path}: ${error.message}`);
      }
    }
    for (const entry of await this.discoverLocalEntries(manifest)) {
      try {
        const entity = await this.readEntity(entry);
        validateExistingEntity(entry, entity);
      } catch (error) {
        errors.push(`${entry.path}: ${error.message}`);
      }
    }
    errors.push(...changes.invalid);
    if (changes.created.length && changes.deleted.length) {
      errors.push("工作区同时包含新增和删除，无法安全排除移动或重命名。");
    }
    return {
      ok: errors.length === 0,
      root: this.root,
      checked: manifest.entries.length + changes.created.length,
      localGroups: manifest.localGroups.length,
      changes,
      errors
    };
  }

  async create(input, apply = false) {
    const manifest = await this.readManifest();
    assertNoPending(manifest);
    const changes = await this.scanChanges(manifest);
    assertNoInvalidChanges(changes);
    if (changes.deleted.length) {
      throw new Error("已有待删除资源时禁止新增；请先恢复或完成删除。 ");
    }
    const plan = await this.planCreate(manifest, input);
    if (apply && !plan.noOp) {
      await this.applyWrites(plan.writes);
    }
    return publicPlan(plan, apply);
  }

  async ensureGroup(input, apply = false) {
    const manifest = await this.readManifest();
    assertNoPending(manifest);
    assertNoInvalidChanges(await this.scanChanges(manifest));
    const groupPlan = await this.planGroupPath(manifest, input && input.type, input && input.groupPath);
    const writes = groupPlan.changed
      ? [{ path: ".magic-api/manifest.json", content: jsonText(groupPlan.manifest), internal: true }]
      : [];
    const plan = {
      operation: "ensure-group",
      id: groupPlan.groupId || `local:${groupPlan.clientId}`,
      type: groupPlan.folder,
      groupId: groupPlan.groupId || `local:${groupPlan.clientId}`,
      groupPath: groupPlan.groupPath,
      localGroups: groupPlan.created,
      entry: null,
      entity: null,
      writes,
      removes: [],
      noOp: !groupPlan.changed
    };
    if (apply && !plan.noOp) {
      await this.applyWrites(plan.writes);
    }
    return publicPlan(plan, apply);
  }

  async planCreate(manifest, input) {
    const folder = String(input && input.type || "").trim();
    if (!folder) {
      throw new Error("create 缺少 type。");
    }
    const requestedGroupId = String(input && input.groupId || "").trim();
    const requestedGroupPath = String(input && input.groupPath || "").trim();
    if (requestedGroupId && requestedGroupPath) {
      throw new Error("--group-id 与 --group-path 不能同时使用。");
    }
    let groupPlan;
    if (requestedGroupId) {
      const groups = manifest.groups.filter((group) =>
        group.folder === folder && group.id === requestedGroupId && group.id !== "0" && group.workspacePath
      );
      if (groups.length !== 1) {
        throw new Error(`type=${folder}, groupId=${requestedGroupId || "<empty>"} 没有唯一真实分组。`);
      }
      groupPlan = {
        folder,
        groupId: requestedGroupId,
        clientId: null,
        groupPath: groups[0].workspacePath.slice(folder.length + 1),
        workspacePath: groups[0].workspacePath,
        manifest: cloneJson(manifest),
        created: [],
        changed: Boolean(manifest._migratedFrom)
      };
    } else {
      groupPlan = await this.planGroupPath(manifest, folder, requestedGroupPath);
    }
    const groupId = groupPlan.groupId || `local:${groupPlan.clientId}`;
    const name = validateResourceName(input.name);
    const baseName = sanitizePathSegment(resourcePathBase(input.path || name));
    const metadata = Object.assign(defaultMetadata(folder, baseName), input.metadata || {}, {
      name
    });
    if (PATH_RESOURCE_TYPES.has(folder)) {
      metadata.path = normalizeResourcePath(folder, input.path);
    }
    if (folder === "api" && input.method !== undefined) {
      metadata.method = String(input.method).toUpperCase();
    }
    if (folder === "task") {
      if (input.cron !== undefined) {
        metadata.cron = String(input.cron).trim();
      }
      if (input.enabled !== undefined) {
        metadata.enabled = Boolean(input.enabled);
      }
    }
    if (folder === "datasource") {
      if (input.key !== undefined) {
        metadata.key = String(input.key).trim();
      }
      if (input.url !== undefined) {
        metadata.url = String(input.url).trim();
      }
    }
    rejectServerOwnedFields(metadata, "新资源 metadata");
    const extension = folder === "datasource" ? ".json" : ".ms";
    const desired = buildNewResourceEntity(
      { folder, type: folder === "datasource" ? "json" : "script", path: `${groupPlan.workspacePath}/placeholder${folder === "datasource" ? ".json" : ".ms"}` },
      metadata,
      folder === "datasource" ? undefined : String(input.script || defaultScript(folder, name)),
      groupId
    );
    const idempotent = await this.findIdempotentCreate(manifest, folder, groupPlan.workspacePath, desired);
    if (idempotent) {
      if (!idempotent.equal) {
        throw new Error(`相同分组、名称和 path/key 的资源已存在但内容不同：${idempotent.entry.id}，请使用 update。`);
      }
      return {
        operation: "create",
        id: idempotent.entry.id,
        type: folder,
        groupId,
        groupPath: groupPlan.groupPath,
        localGroups: groupPlan.created,
        entry: idempotent.entry,
        entity: idempotent.entity,
        writes: groupPlan.changed
          ? [{ path: ".magic-api/manifest.json", content: jsonText(groupPlan.manifest), internal: true }]
          : [],
        removes: [],
        noOp: !groupPlan.changed
      };
    }
    const relativePath = await this.allocateCreatePath(
      groupPlan.workspacePath,
      baseName,
      extension,
      `${folder}\0${groupPlan.workspacePath}\0${metadata.path || metadata.key || ""}\0${name}`
    );
    const descriptor = describeResourcePath(relativePath);
    const script = descriptor.type === "script"
      ? String(input.script || defaultScript(folder, name))
      : undefined;
    const entity = buildNewResourceEntity(descriptor, metadata, script, groupId);
    const writes = descriptor.type === "json"
      ? [{ path: descriptor.path, content: jsonText(metadata) }]
      : [
        { path: descriptor.path, content: script },
        { path: descriptor.metadataPath, content: jsonText(metadata) }
      ];
    if (groupPlan.changed) {
      writes.push({ path: ".magic-api/manifest.json", content: jsonText(groupPlan.manifest), internal: true });
    }
    const localId = localResourceId(descriptor.path);
    return {
      operation: "create",
      id: localId,
      type: folder,
      groupId,
      groupPath: groupPlan.groupPath,
      localGroups: groupPlan.created,
      entry: {
        id: localId,
        folder,
        groupId,
        type: descriptor.type,
        path: descriptor.path,
        metadataPath: descriptor.metadataPath,
        name
      },
      entity,
      writes,
      removes: [],
      noOp: false
    };
  }

  async planGroupPath(manifest, folderValue, groupPathValue) {
    const folder = String(folderValue || "").trim();
    if (!folder || !/^[A-Za-z0-9._-]+$/.test(folder)) {
      throw new Error(`非法资源类型：${folder || "<empty>"}`);
    }
    const fallbackTypes = new Set(["api", "function", "task"]);
    if (!fallbackTypes.has(folder) &&
        !manifest.groups.some((group) => group.folder === folder) &&
        !manifest.localGroups.some((group) => group.folder === folder)) {
      throw new Error(`服务端镜像中未发现动态资源类型 ${folder}，禁止离线创建分组。`);
    }
    const groupPath = normalizeGroupPath(groupPathValue);
    const migrated = Boolean(manifest._migratedFrom);
    const nextManifest = cloneJson(manifest);
    let parentRef = "0";
    let groupId = null;
    let clientId = null;
    let workspacePath = folder;
    const created = [];
    for (const segment of groupPath.split("/")) {
      workspacePath = `${workspacePath}/${segment}`;
      const remoteMatches = nextManifest.groups.filter((group) =>
        group.folder === folder && group.workspacePath === workspacePath
      );
      const localMatches = nextManifest.localGroups.filter((group) =>
        group.folder === folder && group.workspacePath === workspacePath
      );
      if (remoteMatches.length + localMatches.length > 1) {
        throw new Error(`分组路径 ${workspacePath} 对应多个本地或服务端分组。`);
      }
      if (remoteMatches.length === 1) {
        const definition = await this.readGroupDefinition(remoteMatches[0]);
        if (definition && ((definition.name && definition.name !== segment) || (definition.path && definition.path !== segment))) {
          throw new Error(`已有分组 ${workspacePath} 的 name/path 与 ${segment} 不一致。`);
        }
        groupId = remoteMatches[0].id;
        clientId = null;
        parentRef = groupId;
        continue;
      }
      if (localMatches.length === 1) {
        const local = localMatches[0];
        if (local.parentRef !== parentRef || local.name !== segment || local.path !== segment) {
          throw new Error(`本地分组 ${workspacePath} 的定义与当前请求不一致。`);
        }
        clientId = local.clientId;
        groupId = null;
        parentRef = `local:${clientId}`;
        continue;
      }
      clientId = localGroupId(folder, workspacePath);
      const local = {
        clientId,
        folder,
        parentRef,
        name: segment,
        path: segment,
        workspacePath,
        createdAt: Date.now()
      };
      nextManifest.localGroups.push(local);
      created.push(local);
      groupId = null;
      parentRef = `local:${clientId}`;
    }
    return {
      folder,
      groupId,
      clientId,
      groupPath,
      workspacePath,
      manifest: nextManifest,
      created,
      changed: created.length > 0 || migrated
    };
  }

  async readGroupDefinition(group) {
    if (!group || !group.path) {
      return undefined;
    }
    try {
      return await readJsonFile(this.root, group.path);
    } catch (_error) {
      return undefined;
    }
  }

  async findIdempotentCreate(manifest, folder, workspacePath, desired) {
    const candidates = [];
    const groupIds = new Set(manifest.groups
      .filter((group) => group.folder === folder && group.workspacePath === workspacePath)
      .map((group) => group.id));
    for (const entry of manifest.entries) {
      if (entry.folder !== folder || !groupIds.has(entry.groupId)) {
        continue;
      }
      const entity = await this.readEntity(entry);
      if (resourceIdentity(entry.folder, entity) === resourceIdentity(entry.folder, desired)) {
        candidates.push({ entry, entity });
      }
    }
    for (const entry of await this.discoverLocalEntries(manifest)) {
      if (entry.folder !== folder || path.posix.dirname(entry.path) !== workspacePath) {
        continue;
      }
      const entity = await this.readEntity(entry);
      if (resourceIdentity(entry.folder, entity) === resourceIdentity(entry.folder, desired)) {
        candidates.push({ entry, entity });
      }
    }
    if (candidates.length > 1) {
      throw new Error("相同语义身份对应多个本地资源，已阻止幂等新增。");
    }
    if (!candidates.length) {
      return undefined;
    }
    return Object.assign(candidates[0], {
      equal: canonicalResourceHash(candidates[0].entry.folder, candidates[0].entity) ===
        canonicalResourceHash(candidates[0].entry.folder, desired)
    });
  }

  async update(input, apply = false) {
    const manifest = await this.readManifest();
    assertNoPending(manifest);
    assertNoInvalidChanges(await this.scanChanges(manifest));
    const plan = await this.planUpdate(manifest, input);
    if (apply) {
      await this.applyWrites(plan.writes);
    }
    return publicPlan(plan, apply);
  }

  async planUpdate(manifest, input) {
    const entry = await this.findResourceReference(manifest, input && input.id);
    const current = await this.readEntity(entry);
    const patch = Object.assign({}, input && input.metadataPatch || {});
    if (input && input.name !== undefined) {
      patch.name = input.name;
    }
    if (input && input.path !== undefined) {
      patch.path = input.path;
    }
    if (input && input.method !== undefined) {
      patch.method = String(input.method).toUpperCase();
    }
    if (input && input.cron !== undefined) {
      patch.cron = input.cron;
    }
    if (input && input.enabled !== undefined) {
      patch.enabled = Boolean(input.enabled);
    }
    rejectServerOwnedFields(patch, "metadata patch");
    const next = Object.assign({}, current, patch);
    if (patch.name !== undefined) {
      next.name = validateResourceName(patch.name);
    }
    if (PATH_RESOURCE_TYPES.has(entry.folder)) {
      next.path = normalizeResourcePath(entry.folder, next.path);
    }
    if (entry.folder === "api") {
      requireText(next.method, `${entry.path} 缺少 method。`);
    }
    if (entry.folder === "task") {
      requireText(next.cron, `${entry.path} 缺少 cron。`);
    }
    let script = next.script;
    if (entry.type === "script" && input && input.script !== undefined) {
      script = String(input.script);
    }
    if (entry.type === "script") {
      requireText(script, `${entry.path} 的脚本内容不能为空。`);
      next.script = script;
    }
    validateExistingEntity(entry, next);
    const writes = entry.type === "json"
      ? [{ path: entry.path, content: jsonText(next) }]
      : [
        ...(input && input.script !== undefined ? [{ path: entry.path, content: script }] : []),
        { path: entry.metadataPath, content: jsonText(withoutScript(next)) }
      ];
    return {
      operation: "update",
      id: entry.id,
      type: entry.folder,
      groupId: entry.groupId,
      entry: Object.assign({}, entry),
      entity: next,
      writes,
      removes: []
    };
  }

  async delete(input, apply = false) {
    const manifest = await this.readManifest();
    assertNoPending(manifest);
    const changes = await this.scanChanges(manifest);
    assertNoInvalidChanges(changes);
    const plan = await this.planDelete(manifest, input);
    if (!String(plan.id).startsWith("local:") && changes.created.length) {
      throw new Error("已有待新增资源时禁止删除已同步资源；请先完成或恢复新增。 ");
    }
    if (apply) {
      await this.applyRemoves(plan.removes);
    }
    return publicPlan(plan, apply);
  }

  async planDelete(manifest, input) {
    const entry = await this.findResourceReference(manifest, input && input.id);
    if (entry.id === "0" || String(entry.id).endsWith(":0")) {
      throw new Error(`禁止删除分组或根 ID：${entry.id}`);
    }
    await this.readEntity(entry);
    return {
      operation: "delete",
      id: entry.id,
      type: entry.folder,
      groupId: entry.groupId,
      entry: Object.assign({}, entry),
      entity: null,
      writes: [],
      removes: [entry.path, entry.metadataPath].filter(Boolean)
    };
  }

  async readEntity(entry) {
    if (entry.type === "json") {
      return readJsonFile(this.root, entry.path);
    }
    const metadata = await readJsonFile(this.root, entry.metadataPath);
    const script = await readTextFile(this.root, entry.path);
    return Object.assign({}, metadata, { script });
  }

  async discoverLocalEntries(manifest) {
    const managed = new Set();
    for (const entry of manifest.entries) {
      managed.add(entry.path);
      if (entry.metadataPath) {
        managed.add(entry.metadataPath);
      }
    }
    const records = await listWorkspaceFiles(this.root);
    const regular = new Set(records.filter((record) => !record.symlink).map((record) => record.path));
    const result = [];
    for (const record of records) {
      if (managed.has(record.path) || record.symlink) {
        continue;
      }
      let descriptor;
      try {
        descriptor = describeResourcePath(record.path);
      } catch (_error) {
        continue;
      }
      if (!descriptor || descriptor.type === "metadata") {
        continue;
      }
      if (descriptor.type === "script" && !regular.has(descriptor.metadataPath)) {
        continue;
      }
      let entity;
      try {
        const pseudo = {
          id: localResourceId(descriptor.path),
          folder: descriptor.folder,
          groupId: this.resolveLocalGroupReference(manifest, descriptor.folder, path.posix.dirname(descriptor.path)),
          type: descriptor.type,
          path: descriptor.path,
          metadataPath: descriptor.metadataPath,
          name: path.posix.basename(descriptor.path)
        };
        entity = await this.readEntity(pseudo);
        pseudo.name = entity.name;
        result.push(pseudo);
      } catch (_error) {
        // scanChanges/validate reports malformed pairs; list only returns usable local resources.
      }
    }
    return result;
  }

  resolveLocalGroupReference(manifest, folder, workspacePath) {
    const remote = manifest.groups.filter((group) => group.folder === folder && group.workspacePath === workspacePath);
    const local = manifest.localGroups.filter((group) => group.folder === folder && group.workspacePath === workspacePath);
    if (remote.length + local.length !== 1) {
      throw new Error(`目录 ${workspacePath} 没有唯一分组。`);
    }
    return remote.length ? remote[0].id : `local:${local[0].clientId}`;
  }

  async findResourceReference(manifest, id) {
    const value = String(id || "").trim();
    if (!value) {
      throw new Error("缺少稳定资源 ID 或本地引用。");
    }
    const managed = manifest.entries.filter((entry) => entry.id === value);
    if (managed.length === 1) {
      return managed[0];
    }
    const local = (await this.discoverLocalEntries(manifest)).filter((entry) => entry.id === value);
    if (local.length !== 1) {
      throw new Error(`找不到唯一资源 ID 或本地引用：${value}`);
    }
    return local[0];
  }

  async scanChanges(manifest) {
    const created = [];
    const modified = [];
    const deleted = [];
    const invalid = [];
    const managed = new Set();
    for (const entry of manifest.entries) {
      managed.add(entry.path);
      if (entry.metadataPath) {
        managed.add(entry.metadataPath);
      }
      try {
        const paths = [entry.path, entry.metadataPath].filter(Boolean);
        const states = [];
        for (const relativePath of paths) {
          states.push(await inspectWorkspacePath(this.root, relativePath));
        }
        const present = states.filter((state) => state.exists).length;
        if (present === 0) {
          deleted.push(entry.path);
        } else if (present !== paths.length) {
          invalid.push(`${entry.path}: 资源对不完整。`);
        } else if (states.some((state) => !state.stat.isFile())) {
          invalid.push(`${entry.path}: 资源必须是普通文件。`);
        } else if (entry.hash && await hashEntry(this.root, entry) !== entry.hash) {
          modified.push(entry.path);
        }
      } catch (error) {
        invalid.push(`${entry.path}: ${error.message}`);
      }
    }
    const records = await listWorkspaceFiles(this.root);
    const regular = new Set(records.filter((item) => !item.symlink).map((item) => item.path));
    for (const record of records) {
      if (managed.has(record.path)) {
        continue;
      }
      let descriptor;
      try {
        descriptor = describeResourcePath(record.path);
      } catch (error) {
        invalid.push(`${record.path}: ${error.message}`);
        continue;
      }
      if (!descriptor) {
        continue;
      }
      if (record.symlink) {
        invalid.push(`${record.path}: 不允许符号链接。`);
      } else if (descriptor.type === "script" && !regular.has(descriptor.metadataPath)) {
        invalid.push(`${record.path}: 缺少 ${descriptor.metadataPath}。`);
      } else if (descriptor.type === "metadata" && !regular.has(descriptor.sourcePath)) {
        invalid.push(`${record.path}: 缺少 ${descriptor.sourcePath}。`);
      } else if (descriptor.type !== "metadata") {
        try {
          this.resolveLocalGroupReference(manifest, descriptor.folder, path.posix.dirname(descriptor.path));
          created.push(descriptor.path);
        } catch (error) {
          invalid.push(`${record.path}: ${error.message}`);
        }
      }
    }
    return {
      created: unique(created),
      modified: unique(modified),
      deleted: unique(deleted),
      invalid: unique(invalid)
    };
  }

  async allocateCreatePath(workspacePath, baseName, extension, signature) {
    const primary = normalizeRelativePath(path.posix.join(workspacePath, `${baseName}${extension}`));
    if (!(await inspectWorkspacePath(this.root, primary)).exists) {
      return primary;
    }
    const suffix = crypto.createHash("sha256").update(signature).digest("hex").slice(0, 8);
    const fallback = normalizeRelativePath(path.posix.join(workspacePath, `${baseName}-${suffix}${extension}`));
    if ((await inspectWorkspacePath(this.root, fallback)).exists) {
      throw new Error(`本地资源路径已存在：${primary} / ${fallback}`);
    }
    return fallback;
  }

  async applyWrites(writes) {
    const backups = [];
    try {
      for (const write of writes) {
        const state = await inspectWorkspacePath(this.root, write.path);
        backups.push({ path: write.path, existed: state.exists, content: state.exists ? await readTextFile(this.root, write.path) : "" });
        await writeTextFile(this.root, write.path, write.content);
      }
    } catch (error) {
      await restoreBackups(this.root, backups);
      throw error;
    }
  }

  async applyRemoves(removes) {
    const backups = [];
    try {
      for (const relativePath of removes) {
        const state = await inspectWorkspacePath(this.root, relativePath);
        if (!state.exists || !state.stat.isFile()) {
          throw new Error(`拒绝删除缺失或非普通文件：${relativePath}`);
        }
        backups.push({ path: relativePath, existed: true, content: await fs.promises.readFile(state.path, "utf8") });
      }
      for (const backup of backups) {
        await fs.promises.rm(path.join(this.root, backup.path), { force: true });
      }
    } catch (error) {
      await restoreBackups(this.root, backups);
      throw error;
    }
  }
}

function defaultMetadata(folder, baseName) {
  const metadata = { name: baseName };
  if (PATH_RESOURCE_TYPES.has(folder)) {
    metadata.path = folder === "api" ? `/${baseName}` : baseName;
  }
  if (folder === "api") {
    Object.assign(metadata, { method: "GET", parameters: [], options: [], headers: [], paths: [] });
  } else if (folder === "function") {
    metadata.parameters = [];
  } else if (folder === "task") {
    Object.assign(metadata, { cron: "0 0/5 * * * ?", enabled: false });
  } else if (folder === "datasource") {
    Object.assign(metadata, { key: baseName, maxRows: -1 });
  }
  return metadata;
}

function buildNewResourceEntity(descriptor, rawMetadata, content, groupId) {
  if (!descriptor || !["script", "json"].includes(descriptor.type)) {
    throw new Error("不支持的新资源文件类型。");
  }
  if (!rawMetadata || typeof rawMetadata !== "object" || Array.isArray(rawMetadata)) {
    throw new Error(`${descriptor.path} 的资源元数据必须是 JSON 对象。`);
  }
  rejectServerOwnedFields(rawMetadata, `${descriptor.path} 新资源`);
  const baseName = path.posix.basename(descriptor.path, descriptor.type === "script" ? ".ms" : ".json");
  const entity = Object.assign(defaultMetadata(descriptor.folder, baseName), rawMetadata, { groupId });
  entity.name = validateResourceName(entity.name);
  if (PATH_RESOURCE_TYPES.has(descriptor.folder)) {
    const normalizedPath = normalizeResourcePath(descriptor.folder, entity.path);
    if (Object.prototype.hasOwnProperty.call(rawMetadata, "path") && rawMetadata.path !== normalizedPath) {
      throw new Error(`${descriptor.folder} path 必须规范化为 ${normalizedPath}。`);
    }
    entity.path = normalizedPath;
  }
  if (descriptor.folder === "api") {
    requireText(entity.method, `${descriptor.path} 缺少 method。`);
    if (entity.method !== String(entity.method).toUpperCase()) {
      throw new Error(`${descriptor.path} 的 method 必须使用大写。`);
    }
  }
  if (descriptor.folder === "task") {
    requireText(entity.cron, `${descriptor.path} 缺少 cron。`);
  }
  if (descriptor.folder === "datasource") {
    requireText(entity.key, `${descriptor.path} 缺少 key。`);
    requireText(entity.url, `${descriptor.path} 缺少 url。`);
  }
  if (descriptor.type === "script") {
    requireText(content, `${descriptor.path} 的脚本内容不能为空。`);
    entity.script = content;
  }
  return entity;
}

function normalizeResourcePath(folder, value) {
  let normalized = String(value || "").trim().replace(/\\/g, "/").replace(/\/+/g, "/");
  const segments = normalized.split("/").filter(Boolean);
  if (!segments.length || segments.some((segment) => segment === "." || segment === ".." || /[\0\r\n]/.test(segment))) {
    throw new Error(`非法 ${folder} 资源 path：${value}`);
  }
  normalized = segments.join("/");
  return folder === "api" ? `/${normalized}` : normalized;
}

function normalizeGroupPath(value) {
  const normalized = String(value || "").trim().replace(/\\/g, "/").replace(/\/+/g, "/").replace(/^\/|\/$/g, "");
  const segments = normalized.split("/");
  if (!normalized || segments.some((segment) => !segment || segment === "." || segment === ".." || /[\0\r\n]/.test(segment))) {
    throw new Error(`非法嵌套分组路径：${value || "<empty>"}`);
  }
  segments.forEach(validateResourceName);
  return segments.join("/");
}

function validateResourceName(value) {
  const name = String(value || "").trim();
  if (/\.(?:ms|json)$/i.test(name)) {
    throw new Error("name 不能包含 .ms 或 .json 扩展名。");
  }
  if (!name || !NAME_PATTERN.test(name)) {
    throw new Error(`非法资源名称：${value || "<empty>"}`);
  }
  return name;
}

function validateExistingEntity(entry, entity) {
  if (!entity || typeof entity !== "object" || Array.isArray(entity)) {
    throw new Error("资源 metadata 必须是 JSON 对象。");
  }
  validateResourceName(entity.name);
  if (entity.id !== undefined && entity.id !== entry.id) {
    throw new Error("metadata id 与 manifest 不一致。");
  }
  if (entity.groupId !== undefined && entity.groupId !== entry.groupId) {
    throw new Error("metadata groupId 与 manifest 不一致。");
  }
  if (PATH_RESOURCE_TYPES.has(entry.folder)) {
    const normalized = normalizeResourcePath(entry.folder, entity.path);
    if (entity.path !== normalized) {
      throw new Error(`${entry.folder} path 必须规范化为 ${normalized}。`);
    }
  }
  if (entry.folder === "api") {
    requireText(entity.method, "API 缺少 method。");
    if (entity.method !== String(entity.method).toUpperCase()) {
      throw new Error("API method 必须使用大写。");
    }
  }
  if (entry.folder === "task") {
    requireText(entity.cron, "Task 缺少 cron。");
  }
  if (entry.folder === "datasource") {
    requireText(entity.key, "Datasource 缺少 key。");
    requireText(entity.url, "Datasource 缺少 url。");
  }
  if (entry.type === "script") {
    requireText(entity.script, "脚本内容不能为空。");
  }
}

function describeResourcePath(relativePath) {
  const normalized = normalizeRelativePath(relativePath);
  const segments = normalized.split("/");
  if (segments.length < 2 || segments[0] === ".magic-api") {
    return undefined;
  }
  const folder = segments[0];
  const lower = normalized.toLowerCase();
  if (folder === "datasource" && (lower.endsWith(".ms") || lower.endsWith(SCRIPT_METADATA_SUFFIX))) {
    throw new Error(`datasource 只支持单个 .json 文件：${normalized}`);
  }
  if (lower.endsWith(SCRIPT_METADATA_SUFFIX)) {
    return { folder, type: "metadata", path: normalized, sourcePath: sourcePathForMetadata(normalized) };
  }
  if (lower.endsWith(".ms")) {
    return { folder, type: "script", path: normalized, metadataPath: metadataPathForScript(normalized) };
  }
  if (folder === "datasource" && lower.endsWith(".json")) {
    return { folder, type: "json", path: normalized };
  }
  return undefined;
}

function metadataPathForScript(resourcePath) {
  const normalized = toPosixPath(resourcePath);
  if (!normalized.toLowerCase().endsWith(".ms")) {
    throw new Error(`${normalized} 不是 magic-script 文件。`);
  }
  return `${normalized.slice(0, -3)}${SCRIPT_METADATA_SUFFIX}`;
}

function sourcePathForMetadata(metadataPath) {
  const normalized = toPosixPath(metadataPath);
  return normalized.toLowerCase().endsWith(SCRIPT_METADATA_SUFFIX)
    ? `${normalized.slice(0, -SCRIPT_METADATA_SUFFIX.length)}.ms`
    : undefined;
}

function normalizeRelativePath(relativePath) {
  const normalized = path.posix.normalize(toPosixPath(relativePath)).replace(/^\.\//, "");
  if (!normalized || normalized === "." || normalized === ".." || normalized.startsWith("../") || path.posix.isAbsolute(normalized)) {
    throw new Error(`非法工作区相对路径：${relativePath}`);
  }
  return normalized;
}

function toPosixPath(filePath) {
  return String(filePath || "").replace(/\\/g, "/").split(path.sep).join("/");
}

function sanitizePathSegment(name) {
  return String(name || "untitled")
    .replace(/[\\/:*?"<>|#%&{}$!'@+`=]/g, "_")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 80) || "untitled";
}

function defaultScript(folder, name) {
  return `/**\n * ${name}\n *\n * ${folder} resource.\n */\nreturn null;\n`;
}

function rejectServerOwnedFields(value, label, allowed = []) {
  const allowedSet = new Set(allowed);
  const forbidden = SERVER_OWNED_FIELDS.filter((field) =>
    !allowedSet.has(field) && Object.prototype.hasOwnProperty.call(value || {}, field)
  );
  if (forbidden.length) {
    throw new Error(`${label} 不能包含服务端字段：${forbidden.join(", ")}。`);
  }
}

function migrateManifest(raw) {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    throw new Error("manifest 不是合法对象。");
  }
  if (raw.version === PREVIOUS_MANIFEST_VERSION) {
    const blocking = ["pendingCreates", "pendingCreateRequests", "pendingDeletes"]
      .some((key) => Array.isArray(raw[key]) && raw[key].length);
    if (blocking) {
      throw new Error("manifest v2 存在未完成 journal，请先用原扩展完成恢复后再升级 v3。");
    }
    raw = Object.assign({}, raw, { version: MANIFEST_VERSION });
    Object.defineProperty(raw, "_migratedFrom", { value: PREVIOUS_MANIFEST_VERSION, enumerable: false });
  }
  if (raw.version !== MANIFEST_VERSION) {
    throw new Error(`只支持 manifest v${PREVIOUS_MANIFEST_VERSION} 或 v${MANIFEST_VERSION}。`);
  }
  for (const key of [
    "entries", "groups", "pendingCreates", "pendingCreateRequests", "pendingDeletes",
    "localGroups", "pendingGroupCreateRequests", "pendingGroupCreates"
  ]) {
    if (raw[key] === undefined) {
      raw[key] = [];
    }
  }
  return raw;
}

function validateManifestShape(manifest) {
  if (!manifest || typeof manifest !== "object" || manifest.version !== MANIFEST_VERSION) {
    throw new Error(`只支持 manifest v${MANIFEST_VERSION}。`);
  }
  if (!manifest.serverUrl || typeof manifest.serverUrl !== "string") {
    throw new Error("manifest 缺少 serverUrl。");
  }
  for (const key of [
    "entries", "groups", "pendingCreates", "pendingCreateRequests", "pendingDeletes",
    "localGroups", "pendingGroupCreateRequests", "pendingGroupCreates"
  ]) {
    if (!Array.isArray(manifest[key])) {
      throw new Error(`manifest.${key} 必须是数组。`);
    }
  }
  const groupKeys = new Set();
  for (const group of manifest.groups) {
    if (!group || typeof group.id !== "string" || !group.id || typeof group.folder !== "string" || !group.folder) {
      throw new Error("manifest 包含非法分组。");
    }
    if (typeof group.workspacePath !== "string" || !group.workspacePath) {
      throw new Error(`分组 ${group.id} 缺少 workspacePath。`);
    }
    const workspacePath = normalizeRelativePath(group.workspacePath);
    if (workspacePath !== group.folder && !workspacePath.startsWith(`${group.folder}/`)) {
      throw new Error(`分组 ${group.id} 的 workspacePath 不属于 ${group.folder}。`);
    }
    groupKeys.add(`${group.folder}\0${group.id}`);
  }
  const localIds = new Set();
  const localPaths = new Set();
  for (const group of manifest.localGroups) {
    if (!group || typeof group.clientId !== "string" || !group.clientId || localIds.has(group.clientId)) {
      throw new Error("manifest.localGroups 包含缺失或重复 clientId。");
    }
    localIds.add(group.clientId);
    if (typeof group.folder !== "string" || !group.folder || typeof group.workspacePath !== "string") {
      throw new Error(`本地分组 ${group.clientId} 缺少 folder/workspacePath。`);
    }
    const expectedPath = `${group.folder}/${normalizeGroupPath(group.workspacePath.slice(group.folder.length + 1))}`;
    if (group.workspacePath !== expectedPath || localPaths.has(group.workspacePath)) {
      throw new Error(`本地分组 ${group.clientId} 的 workspacePath 非法或重复。`);
    }
    localPaths.add(group.workspacePath);
    validateResourceName(group.name);
    validateResourceName(group.path);
    if (typeof group.parentRef !== "string" || !group.parentRef) {
      throw new Error(`本地分组 ${group.clientId} 缺少 parentRef。`);
    }
    if (manifest.groups.some((remote) => remote.folder === group.folder && remote.workspacePath === group.workspacePath)) {
      throw new Error(`本地分组 ${group.clientId} 与服务端分组路径重复。`);
    }
  }
  for (const group of manifest.localGroups) {
    if (group.parentRef === "0") {
      continue;
    }
    if (group.parentRef.startsWith("local:")) {
      const parentId = group.parentRef.slice("local:".length);
      const parent = manifest.localGroups.find((item) => item.clientId === parentId && item.folder === group.folder);
      if (!parent || path.posix.dirname(group.workspacePath) !== parent.workspacePath) {
        throw new Error(`本地分组 ${group.clientId} 的 parentRef 非法。`);
      }
    } else if (!groupKeys.has(`${group.folder}\0${group.parentRef}`)) {
      throw new Error(`本地分组 ${group.clientId} 的 parentRef 不属于同类型服务端分组。`);
    }
  }
  for (const request of manifest.pendingGroupCreateRequests) {
    if (!request || typeof request.operationId !== "string" || typeof request.clientId !== "string") {
      throw new Error("manifest.pendingGroupCreateRequests 包含非法记录。");
    }
  }
  for (const pending of manifest.pendingGroupCreates) {
    if (!pending || typeof pending.id !== "string" || typeof pending.clientId !== "string") {
      throw new Error("manifest.pendingGroupCreates 包含非法记录。");
    }
  }
  const ids = new Set();
  const resourcePaths = new Set();
  for (const entry of manifest.entries) {
    if (!entry || typeof entry.id !== "string" || !entry.id || ids.has(entry.id)) {
      throw new Error(`manifest 包含缺失或重复资源 ID：${entry && entry.id || "<empty>"}`);
    }
    ids.add(entry.id);
    if (!groupKeys.has(`${entry.folder}\0${entry.groupId}`)) {
      throw new Error(`资源 ${entry.id} 的 groupId 不属于 ${entry.folder}。`);
    }
    if (!["script", "json"].includes(entry.type) || (entry.folder === "datasource") !== (entry.type === "json")) {
      throw new Error(`资源 ${entry.id} 的本地文件类型非法。`);
    }
    const resourcePath = normalizeRelativePath(entry.path);
    if ((resourcePath !== entry.folder && !resourcePath.startsWith(`${entry.folder}/`)) || resourcePaths.has(resourcePath)) {
      throw new Error(`资源 ${entry.id} 的 path 缺失、重复或越出类型目录。`);
    }
    resourcePaths.add(resourcePath);
    if (entry.type === "script") {
      const metadataPath = normalizeRelativePath(entry.metadataPath);
      if (metadataPath !== metadataPathForScript(resourcePath) || resourcePaths.has(metadataPath)) {
        throw new Error(`资源 ${entry.id} 的 metadataPath 非法或重复。`);
      }
      resourcePaths.add(metadataPath);
    }
  }
}

function assertNoPending(manifest) {
  const counts = [
    manifest.pendingCreates.length,
    manifest.pendingCreateRequests.length,
    manifest.pendingDeletes.length,
    manifest.pendingGroupCreateRequests.length,
    manifest.pendingGroupCreates.length
  ];
  if (counts.some(Boolean)) {
    throw new Error("manifest 存在未完成的新增或删除恢复状态，请先由扩展完成复核。");
  }
}

function assertNoInvalidChanges(changes) {
  if (changes.invalid.length) {
    throw new Error(`工作区存在不完整或非法资源：${changes.invalid.join("；")}`);
  }
}

function findEntry(manifest, id) {
  const value = String(id || "").trim();
  if (!value) {
    throw new Error("缺少稳定资源 ID。");
  }
  const matches = manifest.entries.filter((entry) => entry.id === value);
  if (matches.length !== 1) {
    throw new Error(`manifest 中找不到唯一资源 ID：${value}`);
  }
  return matches[0];
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
        return { exists: false, path: current };
      }
      throw error;
    }
    if (stat.isSymbolicLink()) {
      throw new Error(`工作区路径不允许符号链接：${normalized}`);
    }
    if (index < segments.length - 1 && !stat.isDirectory()) {
      throw new Error(`工作区父路径不是目录：${normalized}`);
    }
    if (index === segments.length - 1) {
      return { exists: true, path: current, stat };
    }
  }
  return { exists: false, path: current };
}

async function assertSafeRoot(root) {
  const absolute = path.resolve(root);
  const parsed = path.parse(absolute);
  const segments = absolute.slice(parsed.root.length).split(path.sep).filter(Boolean);
  let current = parsed.root;
  for (const segment of segments) {
    current = path.join(current, segment);
    let stat;
    try {
      stat = await fs.promises.lstat(current);
    } catch (error) {
      if (error && error.code === "ENOENT") {
        throw new Error(`镜像根目录不存在：${root}`);
      }
      throw error;
    }
    if (stat.isSymbolicLink()) {
      throw new Error(`镜像根路径不允许符号链接：${current}`);
    }
    if (!stat.isDirectory()) {
      throw new Error(`镜像根路径不是目录：${current}`);
    }
  }
}

async function readTextFile(root, relativePath) {
  const state = await inspectWorkspacePath(root, relativePath);
  if (!state.exists || !state.stat.isFile()) {
    throw new Error(`${relativePath} 必须是普通文件。`);
  }
  return fs.promises.readFile(state.path, "utf8");
}

async function readJsonFile(root, relativePath) {
  const text = await readTextFile(root, relativePath);
  try {
    const value = JSON.parse(text);
    if (!value || typeof value !== "object" || Array.isArray(value)) {
      throw new Error("必须是 JSON 对象");
    }
    return value;
  } catch (error) {
    throw new Error(`${relativePath} 不是合法 JSON 对象：${error.message}`);
  }
}

async function writeTextFile(root, relativePath, content) {
  const normalized = normalizeRelativePath(relativePath);
  const state = await inspectWorkspacePath(root, normalized);
  if (state.exists && !state.stat.isFile()) {
    throw new Error(`拒绝覆盖非普通文件：${normalized}`);
  }
  const fullPath = path.join(root, normalized);
  await fs.promises.mkdir(path.dirname(fullPath), { recursive: true });
  const checked = await inspectWorkspacePath(root, normalized);
  if (checked.exists && !checked.stat.isFile()) {
    throw new Error(`拒绝覆盖非普通文件：${normalized}`);
  }
  const temporary = `${fullPath}.tmp-${process.pid}-${crypto.randomBytes(4).toString("hex")}`;
  await fs.promises.writeFile(temporary, String(content), "utf8");
  await fs.promises.rename(temporary, fullPath);
}

async function restoreBackups(root, backups) {
  for (const backup of backups.slice().reverse()) {
    if (backup.existed) {
      await writeTextFile(root, backup.path, backup.content);
    } else {
      const state = await inspectWorkspacePath(root, backup.path);
      if (state.exists && state.stat.isFile()) {
        await fs.promises.rm(state.path, { force: true });
      }
    }
  }
}

async function listWorkspaceFiles(root) {
  const records = [];
  await walk(root, "");
  return records;

  async function walk(directory, relativeDirectory) {
    const entries = await fs.promises.readdir(directory, { withFileTypes: true });
    for (const entry of entries) {
      if (!relativeDirectory && entry.name === ".magic-api") {
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

async function hashEntry(root, entry) {
  if (entry.type === "json") {
    return hashText(await readTextFile(root, entry.path));
  }
  const script = await readTextFile(root, entry.path);
  const metadata = await readTextFile(root, entry.metadataPath);
  return hashText(`${metadata}\n${script}`);
}

function publicEntry(entry) {
  return {
    id: entry.id,
    type: entry.folder,
    groupId: entry.groupId,
    name: entry.name,
    path: entry.path,
    metadataPath: entry.metadataPath
  };
}

function publicPlan(plan, applied) {
  return {
    ok: true,
    operation: plan.operation,
    applied,
    id: plan.id,
    type: plan.type,
    groupId: plan.groupId,
    groupPath: plan.groupPath,
    localGroups: plan.localGroups || [],
    noOp: Boolean(plan.noOp),
    entry: plan.entry,
    entity: plan.entity ? withoutScript(plan.entity) : null,
    files: [
      ...plan.writes.filter((item) => !item.internal).map((item) => ({ action: "write", path: item.path })),
      ...plan.removes.map((item) => ({ action: "delete", path: item }))
    ]
  };
}

function localGroupId(folder, workspacePath) {
  return crypto.createHash("sha256").update(`group\0${folder}\0${workspacePath}`).digest("hex").slice(0, 24);
}

function localResourceId(resourcePath) {
  return `local:${crypto.createHash("sha256").update(`resource\0${resourcePath}`).digest("hex").slice(0, 24)}`;
}

function resourceIdentity(folder, entity) {
  return JSON.stringify([
    entity && entity.name || "",
    folder === "datasource" ? entity && entity.key || "" : entity && entity.path || ""
  ]);
}

function canonicalResourceHash(folder, entity) {
  const value = {};
  Object.keys(entity || {}).sort().forEach((key) => {
    if (!["id", "groupId", "createTime", "updateTime", "createBy", "updateBy", "lock"].includes(key)) {
      value[key] = entity[key];
    }
  });
  return hashText(`${folder}\0${JSON.stringify(value)}`);
}

function cloneJson(value) {
  return JSON.parse(JSON.stringify(value));
}

function withoutScript(entity) {
  const value = Object.assign({}, entity || {});
  delete value.script;
  return value;
}

function resourcePathBase(value) {
  const normalized = String(value || "").replace(/\\/g, "/").replace(/\/+$/g, "");
  const parts = normalized.split("/").filter(Boolean);
  return parts.length ? parts[parts.length - 1] : normalized;
}

function normalizeServerUrl(value) {
  return String(value || "").trim().replace(/\/+$/, "");
}

function jsonText(value) {
  return `${JSON.stringify(value, null, 2)}\n`;
}

function hashText(value) {
  return crypto.createHash("sha256").update(value, "utf8").digest("hex");
}

function requireText(value, message) {
  if (typeof value !== "string" || !value.trim()) {
    throw new Error(message);
  }
}

function unique(values) {
  return Array.from(new Set(values)).sort();
}

module.exports = {
  MANIFEST_VERSION,
  PATH_RESOURCE_TYPES,
  SCRIPT_METADATA_SUFFIX,
  SERVER_OWNED_FIELDS,
  WorkspaceOperations,
  buildNewResourceEntity,
  defaultMetadata,
  describeResourcePath,
  metadataPathForScript,
  normalizeGroupPath,
  normalizeRelativePath,
  normalizeResourcePath,
  sanitizePathSegment,
  sourcePathForMetadata,
  toPosixPath,
  validateExistingEntity,
  validateResourceName
};
