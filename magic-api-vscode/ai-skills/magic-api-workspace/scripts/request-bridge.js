"use strict";

const crypto = require("crypto");
const fs = require("fs");
const os = require("os");
const path = require("path");

const BRIDGE_VERSION = 1;
const BRIDGE_TOKEN_HEADER = "x-magic-api-bridge-token";

function bridgeDescriptorPath(root) {
  const user = typeof process.getuid === "function" ? String(process.getuid()) : "user";
  const rootKey = crypto.createHash("sha256").update(path.resolve(root)).digest("hex").slice(0, 32);
  return path.join(os.tmpdir(), `magic-api-vscode-${user}`, `request-bridge-${rootKey}.json`);
}

async function readBridgeDescriptor(root) {
  const file = bridgeDescriptorPath(root);
  let stat;
  try {
    stat = await fs.promises.lstat(file);
  } catch (error) {
    if (error && error.code === "ENOENT") {
      return undefined;
    }
    throw error;
  }
  if (!stat.isFile() || stat.isSymbolicLink()) {
    throw new Error(`请求桥接描述文件不是安全的普通文件：${file}`);
  }
  if (process.platform !== "win32" && (stat.mode & 0o077) !== 0) {
    throw new Error(`请求桥接描述文件权限过宽：${file}`);
  }
  let value;
  try {
    value = JSON.parse(await fs.promises.readFile(file, "utf8"));
  } catch (error) {
    throw new Error(`请求桥接描述文件无效：${error.message}`);
  }
  if (!value || value.version !== BRIDGE_VERSION || value.host !== "127.0.0.1" ||
      !Number.isInteger(value.port) || value.port < 1 || value.port > 65535 ||
      typeof value.bridgeToken !== "string" || value.bridgeToken.length < 32 ||
      typeof value.serverUrl !== "string" || typeof value.requestBaseUrl !== "string") {
    throw new Error(`请求桥接描述文件格式无效：${file}`);
  }
  return value;
}

async function writeBridgeDescriptor(root, descriptor) {
  const file = bridgeDescriptorPath(root);
  const directory = path.dirname(file);
  await fs.promises.mkdir(directory, { recursive: true, mode: 0o700 });
  if (process.platform !== "win32") {
    await fs.promises.chmod(directory, 0o700);
  }
  const temp = `${file}.${process.pid}.${crypto.randomBytes(6).toString("hex")}.tmp`;
  let handle;
  try {
    handle = await fs.promises.open(temp, "wx", 0o600);
    await handle.writeFile(`${JSON.stringify(descriptor, null, 2)}\n`, "utf8");
    await handle.sync();
    await handle.close();
    handle = undefined;
    await fs.promises.rename(temp, file);
    if (process.platform !== "win32") {
      await fs.promises.chmod(file, 0o600);
    }
  } catch (error) {
    if (handle) {
      await handle.close().catch(() => undefined);
    }
    await fs.promises.rm(temp, { force: true }).catch(() => undefined);
    throw error;
  }
  return file;
}

async function removeBridgeDescriptor(root, bridgeToken) {
  const descriptor = await readBridgeDescriptor(root).catch(() => undefined);
  if (descriptor && descriptor.bridgeToken === bridgeToken) {
    await fs.promises.rm(bridgeDescriptorPath(root), { force: true });
  }
}

module.exports = {
  BRIDGE_TOKEN_HEADER,
  BRIDGE_VERSION,
  bridgeDescriptorPath,
  readBridgeDescriptor,
  removeBridgeDescriptor,
  writeBridgeDescriptor
};
