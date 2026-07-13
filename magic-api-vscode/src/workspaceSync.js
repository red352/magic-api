"use strict";

const path = require("path");
const {
  MANIFEST_VERSION,
  PATH_RESOURCE_TYPES,
  SCRIPT_METADATA_SUFFIX,
  SERVER_OWNED_FIELDS,
  WorkspaceOperations,
  buildNewResourceEntity,
  defaultMetadata,
  describeResourcePath,
  metadataPathForScript,
  normalizeRelativePath,
  normalizeGroupPath,
  normalizeResourcePath,
  sanitizePathSegment,
  sourcePathForMetadata,
  toPosixPath,
  validateExistingEntity,
  validateResourceName
} = require("../ai-skills/magic-api-workspace/scripts/workspace-operations");

function groupPathSegment(folder, group) {
  if (!group || group.id === "0") {
    return "";
  }
  const value = group.path || group.name;
  if (!value && group.id === `${folder}:0`) {
    return "";
  }
  return sanitizePathSegment(value || group.id);
}

function discoverUntrackedResourceRecords(records, managedPathValues, allowedFolderValues) {
  const managedPaths = new Set(managedPathValues || []);
  const allowedFolders = allowedFolderValues === undefined ? undefined : new Set(allowedFolderValues);
  const regularPaths = new Set((records || []).filter((record) => !record.symlink).map((record) => record.path));
  const created = [];
  const invalid = [];

  for (const record of records || []) {
    if (managedPaths.has(record.path)) {
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
    if (allowedFolders && !allowedFolders.has(descriptor.folder)) {
      invalid.push(`${record.path}: 未知的 magic-api 资源类型或分组根目录 ${descriptor.folder}。`);
      continue;
    }
    if (record.symlink) {
      invalid.push(`${record.path}: 不允许用符号链接创建 magic-api 资源。`);
      continue;
    }
    if (descriptor.type === "script") {
      if (!regularPaths.has(descriptor.metadataPath)) {
        invalid.push(`${descriptor.path}: 新脚本必须同时提供 ${descriptor.metadataPath}。`);
      } else {
        created.push(descriptor.path);
      }
    } else if (descriptor.type === "json") {
      created.push(descriptor.path);
    } else if (descriptor.type === "metadata" && !regularPaths.has(descriptor.sourcePath)) {
      invalid.push(`${descriptor.path}: 找不到对应脚本 ${descriptor.sourcePath}。`);
    }
  }
  return { created: Array.from(new Set(created)).sort(), invalid };
}

function resolveGroupId(groups, folder, resourcePath) {
  const workspacePath = path.posix.dirname(toPosixPath(resourcePath));
  const matches = (groups || []).filter((group) =>
    group &&
    group.id &&
    group.id !== "0" &&
    group.folder === folder &&
    group.workspacePath &&
    normalizeRelativePath(group.workspacePath || "") === workspacePath
  );
  if (matches.length === 0) {
    throw new Error(`目录 ${workspacePath} 没有对应的 magic-api 服务端分组，请先同步工作区。`);
  }
  if (matches.length > 1) {
    throw new Error(`目录 ${workspacePath} 对应多个 magic-api 分组，已阻止新增资源。`);
  }
  return matches[0].id;
}

function resourceIdsFromTree(resources) {
  const ids = new Set();
  Object.values(resources || {}).forEach((tree) => collectResourceIds(tree, ids));
  return ids;
}

function collectResourceIds(treeNode, ids) {
  if (!treeNode || !treeNode.node) {
    return;
  }
  const node = treeNode.node;
  if (Object.prototype.hasOwnProperty.call(node, "groupId") && node.id) {
    ids.add(node.id);
  }
  (treeNode.children || []).forEach((child) => collectResourceIds(child, ids));
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
  discoverUntrackedResourceRecords,
  groupPathSegment,
  metadataPathForScript,
  normalizeRelativePath,
  normalizeGroupPath,
  normalizeResourcePath,
  resolveGroupId,
  resourceIdsFromTree,
  sanitizePathSegment,
  sourcePathForMetadata,
  toPosixPath,
  validateExistingEntity,
  validateResourceName
};
