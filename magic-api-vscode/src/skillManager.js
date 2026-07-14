"use strict";

const crypto = require("crypto");
const fs = require("fs");
const path = require("path");

const SKILL_MANIFEST = ".magic-api-skill.json";
const UPDATE_NOTICE_STATE_KEY = "magicApi.skills.updateNotices";

class AiSkillManager {
  constructor(options) {
    this.context = options.context;
    this.vscode = options.vscode;
    this.output = options.output;
    this.skillsRoot = path.join(options.extensionPath, "ai-skills");
  }

  async status(workspaceFolder) {
    const folder = workspaceFolder || this.defaultWorkspaceFolder();
    const bundled = await this.listBundledSkills();
    const result = [];
    for (const skill of bundled) {
      const destination = this.destination(folder, skill.name);
      result.push(await this.inspectInstalled(skill, destination));
    }
    return {
      workspace: folder.uri.fsPath,
      skills: result
    };
  }

  async install(options = {}) {
    const folder = options.workspaceFolder || this.defaultWorkspaceFolder();
    const bundled = await this.listBundledSkills();
    const results = [];
    for (const skill of bundled) {
      const destination = this.destination(folder, skill.name);
      const exists = await fileExists(destination);
      if (exists && !options.force) {
        results.push({ name: skill.name, status: "preserved", reason: "already-exists" });
        continue;
      }
      await atomicReplaceDirectory(skill.source, destination);
      results.push({ name: skill.name, status: exists ? "replaced" : "installed", version: skill.manifest.version });
      this.output.appendLine(`[magic-api] AI Skill ${skill.name} 已安装到 ${destination}`);
    }
    return { workspace: folder.uri.fsPath, skills: results };
  }

  async update(options = {}) {
    const folder = options.workspaceFolder || this.defaultWorkspaceFolder();
    const bundled = await this.listBundledSkills();
    const results = [];
    for (const skill of bundled) {
      const destination = this.destination(folder, skill.name);
      const state = await this.inspectInstalled(skill, destination);
      if (state.status === "missing") {
        if (options.installMissing === false) {
          results.push({ name: skill.name, status: "missing", version: skill.manifest.version });
        } else {
          await atomicReplaceDirectory(skill.source, destination);
          results.push({ name: skill.name, status: "installed", version: skill.manifest.version });
        }
      } else if (state.status === "current") {
        results.push({ name: skill.name, status: "current", version: skill.manifest.version });
      } else if (options.force || state.status === "outdated") {
        await atomicReplaceDirectory(skill.source, destination);
        results.push({ name: skill.name, status: "updated", version: skill.manifest.version });
        this.output.appendLine(`[magic-api] AI Skill ${skill.name} 已安全更新到 ${skill.manifest.version}`);
      } else {
        results.push({
          name: skill.name,
          status: "preserved",
          reason: state.status,
          installedVersion: state.installedVersion,
          availableVersion: skill.manifest.version
        });
      }
    }
    return { workspace: folder.uri.fsPath, skills: results };
  }

  async installInteractively() {
    const folder = await pickWorkspaceFolder(this.vscode);
    if (!folder) {
      return { cancelled: true };
    }
    const status = await this.status(folder);
    const existing = status.skills.filter((item) => item.status !== "missing").map((item) => item.name);
    let force = false;
    if (existing.length) {
      const choice = await this.vscode.window.showWarningMessage(
        `工作区已存在 ${existing.join("、")}，是否覆盖这些 AI Skills？`,
        { modal: true },
        "覆盖"
      );
      if (choice !== "覆盖") {
        return { cancelled: true };
      }
      force = true;
    }
    const result = await this.install({ workspaceFolder: folder, force });
    this.vscode.window.showInformationMessage(
      `magic-api AI Skills 已安装到 ${path.relative(folder.uri.fsPath, path.join(folder.uri.fsPath, ".codex", "skills"))}。`
    );
    return result;
  }

  async autoUpdate() {
    const folders = this.vscode.workspace.workspaceFolders || [];
    const notices = Object.assign({}, this.context.workspaceState.get(UPDATE_NOTICE_STATE_KEY, {}));
    for (const folder of folders) {
      const result = await this.update({ workspaceFolder: folder, force: false, installMissing: false });
      const preserved = result.skills.filter((item) => item.status === "preserved");
      for (const item of preserved) {
        const noticeKey = `${folder.uri.fsPath}\0${item.name}`;
        const version = item.availableVersion || "unknown";
        if (notices[noticeKey] === version) {
          continue;
        }
        notices[noticeKey] = version;
        this.vscode.window.showWarningMessage(
          `magic-api AI Skill ${item.name} 有新版本，但当前工作区副本缺少托管清单或已被修改，扩展未覆盖它。请执行“安装 AI Skills 到工作区”核对后更新。`
        );
      }
    }
    await this.context.workspaceState.update(UPDATE_NOTICE_STATE_KEY, notices);
  }

  defaultWorkspaceFolder() {
    const folders = this.vscode.workspace.workspaceFolders || [];
    if (!folders.length) {
      throw new Error("请先打开一个 VS Code 工作区。");
    }
    return folders[0];
  }

  destination(folder, name) {
    return path.join(folder.uri.fsPath, ".codex", "skills", name);
  }

  async listBundledSkills() {
    const entries = await fs.promises.readdir(this.skillsRoot, { withFileTypes: true });
    const skills = [];
    for (const entry of entries) {
      if (!entry.isDirectory()) {
        continue;
      }
      const source = path.join(this.skillsRoot, entry.name);
      if (!await fileExists(path.join(source, "SKILL.md"))) {
        continue;
      }
      const manifest = await readSkillManifest(source);
      skills.push({ name: entry.name, source, manifest });
    }
    return skills.sort((left, right) => left.name.localeCompare(right.name));
  }

  async inspectInstalled(skill, destination) {
    if (!await fileExists(destination)) {
      return { name: skill.name, status: "missing", availableVersion: skill.manifest.version };
    }
    let installedManifest;
    try {
      installedManifest = await readSkillManifest(destination);
    } catch (error) {
      return {
        name: skill.name,
        status: "legacy",
        availableVersion: skill.manifest.version,
        reason: error.message
      };
    }
    const verification = await verifySkillFiles(destination, installedManifest);
    if (!verification.ok) {
      return {
        name: skill.name,
        status: "modified",
        installedVersion: installedManifest.version,
        availableVersion: skill.manifest.version,
        changedFiles: verification.changedFiles
      };
    }
    const sameBundle = installedManifest.name === skill.manifest.name &&
      installedManifest.version === skill.manifest.version &&
      stableStringify(installedManifest.files) === stableStringify(skill.manifest.files);
    return {
      name: skill.name,
      status: sameBundle ? "current" : "outdated",
      installedVersion: installedManifest.version,
      availableVersion: skill.manifest.version
    };
  }
}

async function readSkillManifest(directory) {
  const file = path.join(directory, SKILL_MANIFEST);
  const value = JSON.parse(await fs.promises.readFile(file, "utf8"));
  if (!value || typeof value.version !== "string" || !value.files || typeof value.files !== "object" || Array.isArray(value.files)) {
    throw new Error(`${file} 不是合法的 Skill 托管清单。`);
  }
  return value;
}

async function verifySkillFiles(directory, manifest) {
  const currentFiles = await listRegularFiles(directory);
  const expectedFiles = Object.keys(manifest.files).sort();
  const changedFiles = [];
  for (const relative of expectedFiles) {
    if (!currentFiles.includes(relative)) {
      changedFiles.push(relative);
      continue;
    }
    const actual = await hashFile(path.join(directory, relative));
    if (actual !== manifest.files[relative]) {
      changedFiles.push(relative);
    }
  }
  currentFiles.filter((relative) => relative !== SKILL_MANIFEST && !expectedFiles.includes(relative))
    .forEach((relative) => changedFiles.push(relative));
  return { ok: changedFiles.length === 0, changedFiles };
}

async function atomicReplaceDirectory(source, destination) {
  const parent = path.dirname(destination);
  await fs.promises.mkdir(parent, { recursive: true });
  const suffix = `${process.pid}-${crypto.randomBytes(6).toString("hex")}`;
  const stage = `${destination}.stage-${suffix}`;
  const backup = `${destination}.backup-${suffix}`;
  await copyDirectory(source, stage);
  const exists = await fileExists(destination);
  try {
    if (exists) {
      await fs.promises.rename(destination, backup);
    }
    await fs.promises.rename(stage, destination);
    if (exists) {
      await fs.promises.rm(backup, { recursive: true, force: true });
    }
  } catch (error) {
    await fs.promises.rm(stage, { recursive: true, force: true }).catch(() => undefined);
    if (exists && !await fileExists(destination) && await fileExists(backup)) {
      await fs.promises.rename(backup, destination).catch(() => undefined);
    }
    throw error;
  }
}

async function copyDirectory(source, destination) {
  const stat = await fs.promises.lstat(source);
  if (!stat.isDirectory() || stat.isSymbolicLink()) {
    throw new Error(`Skill 源目录非法：${source}`);
  }
  await fs.promises.mkdir(destination, { recursive: true });
  const entries = await fs.promises.readdir(source, { withFileTypes: true });
  for (const entry of entries) {
    const sourcePath = path.join(source, entry.name);
    const destinationPath = path.join(destination, entry.name);
    const entryStat = await fs.promises.lstat(sourcePath);
    if (entryStat.isSymbolicLink()) {
      throw new Error(`Skill 不允许包含符号链接：${sourcePath}`);
    }
    if (entryStat.isDirectory()) {
      await copyDirectory(sourcePath, destinationPath);
    } else if (entryStat.isFile()) {
      await fs.promises.copyFile(sourcePath, destinationPath);
    }
  }
}

async function listRegularFiles(root) {
  const result = [];
  async function walk(directory, relativeDirectory) {
    const entries = await fs.promises.readdir(directory, { withFileTypes: true });
    entries.sort((left, right) => left.name.localeCompare(right.name));
    for (const entry of entries) {
      const relative = relativeDirectory ? `${relativeDirectory}/${entry.name}` : entry.name;
      const full = path.join(directory, entry.name);
      const stat = await fs.promises.lstat(full);
      if (stat.isSymbolicLink()) {
        throw new Error(`Skill 不允许包含符号链接：${relative}`);
      }
      if (stat.isDirectory()) {
        await walk(full, relative);
      } else if (stat.isFile()) {
        result.push(relative);
      }
    }
  }
  await walk(root, "");
  return result;
}

async function hashFile(file) {
  return crypto.createHash("sha256").update(await fs.promises.readFile(file)).digest("hex");
}

async function fileExists(file) {
  try {
    await fs.promises.access(file);
    return true;
  } catch (_error) {
    return false;
  }
}

function stableStringify(value) {
  if (Array.isArray(value)) {
    return `[${value.map(stableStringify).join(",")}]`;
  }
  if (value && typeof value === "object") {
    return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${stableStringify(value[key])}`).join(",")}}`;
  }
  return JSON.stringify(value);
}

async function pickWorkspaceFolder(vscode) {
  const folders = vscode.workspace.workspaceFolders || [];
  if (!folders.length) {
    vscode.window.showWarningMessage("请先打开一个 VS Code 工作区。");
    return undefined;
  }
  if (folders.length === 1) {
    return folders[0];
  }
  const selected = await vscode.window.showQuickPick(
    folders.map((folder) => ({ label: folder.name, description: folder.uri.fsPath, folder })),
    { title: "选择安装 AI Skills 的工作区" }
  );
  return selected && selected.folder;
}

module.exports = {
  AiSkillManager,
  SKILL_MANIFEST,
  atomicReplaceDirectory,
  readSkillManifest,
  verifySkillFiles
};
