"use strict";

const crypto = require("crypto");
const fs = require("fs");
const path = require("path");

const root = path.resolve(__dirname, "..");
const packageJson = require(path.join(root, "package.json"));
const skillsRoot = path.join(root, "ai-skills");
const manifestName = ".magic-api-skill.json";
const check = process.argv.includes("--check");

run().catch((error) => {
  process.stderr.write(`${error.stack || error}\n`);
  process.exit(1);
});

async function run() {
  const entries = await fs.promises.readdir(skillsRoot, { withFileTypes: true });
  for (const entry of entries.filter((item) => item.isDirectory())) {
    const directory = path.join(skillsRoot, entry.name);
    if (!await exists(path.join(directory, "SKILL.md"))) {
      continue;
    }
    const files = {};
    for (const relative of await listFiles(directory)) {
      if (relative !== manifestName) {
        files[relative] = await hashFile(path.join(directory, relative));
      }
    }
    const expected = `${JSON.stringify({
      schemaVersion: 1,
      name: entry.name,
      version: packageJson.version,
      files
    }, null, 2)}\n`;
    const file = path.join(directory, manifestName);
    const current = await fs.promises.readFile(file, "utf8").catch((error) => {
      if (error && error.code === "ENOENT") {
        return undefined;
      }
      throw error;
    });
    if (current !== expected) {
      if (check) {
        throw new Error(`${path.relative(root, file)} 已过期，请运行 npm run skills:manifests。`);
      }
      await fs.promises.writeFile(file, expected, "utf8");
    }
  }
  process.stdout.write(check ? "Skill manifests are synchronized.\n" : "Skill manifests updated.\n");
}

async function listFiles(directory) {
  const result = [];
  async function walk(current, relativeDirectory) {
    const entries = await fs.promises.readdir(current, { withFileTypes: true });
    entries.sort((left, right) => left.name.localeCompare(right.name));
    for (const entry of entries) {
      const relative = relativeDirectory ? `${relativeDirectory}/${entry.name}` : entry.name;
      const full = path.join(current, entry.name);
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
  await walk(directory, "");
  return result;
}

async function hashFile(file) {
  return crypto.createHash("sha256").update(await fs.promises.readFile(file)).digest("hex");
}

async function exists(file) {
  try {
    await fs.promises.access(file);
    return true;
  } catch (_error) {
    return false;
  }
}
