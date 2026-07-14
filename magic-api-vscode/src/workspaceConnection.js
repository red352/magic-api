"use strict";

const crypto = require("crypto");
const path = require("path");

const DEFAULT_SERVER_URL = "http://localhost:9999/magic/web";
const DEFAULT_WORKSPACE_DIR = ".magic-api-workspace";
const WORKSPACE_ID_STATE_KEY = "magicApi.connection.workspaceId";
const USERNAME_STATE_KEY = "magicApi.connection.username";
const TOKEN_SECRET_PREFIX = "magic-api.token:";

class WorkspaceConnectionStore {
  constructor(context, vscode) {
    this.context = context;
    this.vscode = vscode;
  }

  hasWorkspace() {
    return Boolean(this.vscode.workspace.workspaceFolders && this.vscode.workspace.workspaceFolders.length);
  }

  assertWorkspace() {
    if (!this.hasWorkspace()) {
      throw new Error("请先打开一个 VS Code 工作区；magic-api 连接和登录状态不会使用全局配置。");
    }
  }

  getServerUrl() {
    return normalizeServerUrl(this.getWorkspaceSetting("serverUrl", DEFAULT_SERVER_URL));
  }

  async setServerUrl(serverUrl) {
    this.assertWorkspace();
    const value = normalizeServerUrl(serverUrl);
    let parsed;
    try {
      parsed = new URL(value);
    } catch (_error) {
      throw new Error(`magicApi.serverUrl 非法：${serverUrl}`);
    }
    if (!["http:", "https:"].includes(parsed.protocol) || parsed.username || parsed.password || parsed.hash) {
      throw new Error("magicApi.serverUrl 必须是无凭据和 fragment 的 HTTP(S) 地址。");
    }
    await this.vscode.workspace
      .getConfiguration("magicApi")
      .update("serverUrl", value, this.vscode.ConfigurationTarget.Workspace);
    return value;
  }

  getWorkspaceDir() {
    const value = String(this.getWorkspaceSetting("workspaceDir", DEFAULT_WORKSPACE_DIR) || "").trim();
    return value || DEFAULT_WORKSPACE_DIR;
  }

  async setWorkspaceDir(workspaceDir) {
    this.assertWorkspace();
    const value = String(workspaceDir || "").trim();
    if (!value) {
      throw new Error("magicApi.workspaceDir 不能为空。");
    }
    if (!path.isAbsolute(value)) {
      const folder = this.vscode.workspace.workspaceFolders[0];
      const workspaceRoot = path.resolve(folder.uri.fsPath);
      const resolved = path.resolve(workspaceRoot, value);
      const relative = path.relative(workspaceRoot, resolved);
      if (relative.startsWith("..") || path.isAbsolute(relative)) {
        throw new Error(`相对 magicApi.workspaceDir 不能越出当前工作区：${value}`);
      }
    }
    await this.vscode.workspace
      .getConfiguration("magicApi")
      .update("workspaceDir", value, this.vscode.ConfigurationTarget.Workspace);
    return value;
  }

  getBehaviorSetting(key, fallback) {
    this.assertWorkspace();
    const value = this.vscode.workspace.getConfiguration("magicApi").get(key, fallback);
    return value === undefined ? fallback : value;
  }

  async setBehaviorSetting(key, value) {
    this.assertWorkspace();
    if (!["syncOnSave", "autoPullOnOpen", "checkConflicts"].includes(key)) {
      throw new Error(`不支持的 magic-api 行为设置：${key}`);
    }
    if (typeof value !== "boolean") {
      throw new Error(`${key} 必须是布尔值。`);
    }
    await this.vscode.workspace
      .getConfiguration("magicApi")
      .update(key, value, this.vscode.ConfigurationTarget.Workspace);
    return value;
  }

  async getUsername() {
    this.assertWorkspace();
    const record = this.context.workspaceState.get(USERNAME_STATE_KEY);
    if (!record || typeof record !== "object" || record.serverUrl !== this.getServerUrl()) {
      return "";
    }
    return String(record.username || "");
  }

  async setUsername(username) {
    this.assertWorkspace();
    await this.context.workspaceState.update(USERNAME_STATE_KEY, {
      serverUrl: this.getServerUrl(),
      username: String(username || "")
    });
  }

  async getToken() {
    const value = await this.context.secrets.get(await this.getTokenSecretKey());
    if (!value) {
      return undefined;
    }
    let record;
    try {
      record = JSON.parse(value);
    } catch (error) {
      return undefined;
    }
    if (!record || record.serverUrl !== this.getServerUrl() || typeof record.token !== "string") {
      return undefined;
    }
    return record.token;
  }

  async setToken(token) {
    await this.context.secrets.store(await this.getTokenSecretKey(), JSON.stringify({
      serverUrl: this.getServerUrl(),
      token: String(token || "")
    }));
  }

  async clearToken() {
    await this.context.secrets.delete(await this.getTokenSecretKey());
  }

  async getTokenSecretKey() {
    return `${TOKEN_SECRET_PREFIX}${await this.getWorkspaceId()}`;
  }

  async getWorkspaceId() {
    this.assertWorkspace();
    let workspaceId = this.context.workspaceState.get(WORKSPACE_ID_STATE_KEY);
    if (!workspaceId) {
      workspaceId = typeof crypto.randomUUID === "function"
        ? crypto.randomUUID()
        : crypto.randomBytes(16).toString("hex");
      await this.context.workspaceState.update(WORKSPACE_ID_STATE_KEY, workspaceId);
    }
    return workspaceId;
  }

  getWorkspaceSetting(key, fallback) {
    this.assertWorkspace();
    const configuration = this.vscode.workspace.getConfiguration("magicApi");
    const inspected = configuration.inspect(key);
    if (inspected && inspected.workspaceValue !== undefined) {
      return inspected.workspaceValue;
    }
    if (inspected && inspected.defaultValue !== undefined) {
      return inspected.defaultValue;
    }
    return fallback;
  }
}

function normalizeServerUrl(serverUrl) {
  return String(serverUrl || "").trim().replace(/\/+$/, "");
}

module.exports = {
  DEFAULT_SERVER_URL,
  DEFAULT_WORKSPACE_DIR,
  TOKEN_SECRET_PREFIX,
  USERNAME_STATE_KEY,
  WORKSPACE_ID_STATE_KEY,
  WorkspaceConnectionStore
};
