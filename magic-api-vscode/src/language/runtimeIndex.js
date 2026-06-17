"use strict";

const {
  formatError,
  isUsableCompletionLabel,
  shortReceiverNames
} = require("./utils");

class RuntimeIndex {
  constructor(client, output) {
    this.client = client;
    this.output = output;
    this.failureLogged = false;
    this.classesTextFailureLogged = false;
    this.classDetailFailureLogged = false;
    this.javaClassIndex = undefined;
  }

  async getClasses() {
    try {
      return await this.client.getClasses();
    } catch (error) {
      if (!this.failureLogged) {
        this.output.appendLine(formatError(error));
        this.failureLogged = true;
      }
      return {};
    }
  }

  async getConfig() {
    try {
      return await this.client.getConfig();
    } catch (error) {
      return {};
    }
  }

  async getClassesText() {
    try {
      if (!this.client || typeof this.client.getClassesText !== "function") {
        return "";
      }
      return await this.client.getClassesText();
    } catch (error) {
      if (!this.classesTextFailureLogged) {
        this.output.appendLine(formatError(error));
        this.classesTextFailureLogged = true;
      }
      return "";
    }
  }

  async getClassDetails(className) {
    try {
      if (!this.client || typeof this.client.getClass !== "function") {
        return [];
      }
      return await this.client.getClass(className);
    } catch (error) {
      if (!this.classDetailFailureLogged) {
        this.output.appendLine(formatError(error));
        this.classDetailFailureLogged = true;
      }
      return [];
    }
  }

  async getRuntimeSymbols() {
    const classes = await this.getClasses();
    const globals = [];
    const membersByReceiver = new Map();
    const allMembers = [];
    addFunctionItems(globals, classes && classes.functions, "magic-api 函数");
    addClassItems(globals, membersByReceiver, allMembers, classes && classes.classes, "magic-api 类/模块");
    addClassItems(globals, membersByReceiver, allMembers, classes && classes.extensions, "magic-api 扩展");
    return {
      globals: mergeByLabel(globals),
      membersByReceiver,
      allMembers: mergeByLabel(allMembers)
    };
  }

  async getJavaClassIndex() {
    if (this.javaClassIndex === undefined) {
      this.javaClassIndex = parseCompressedClasses(await this.getClassesText());
    }
    return this.javaClassIndex;
  }

  async getJavaImportCompletions(prefix) {
    return getJavaImportCompletions(await this.getJavaClassIndex(), prefix);
  }

  async getImportedClassItems(text) {
    const imports = parseJavaImports(text);
    const items = [];
    imports.aliases.forEach((className, alias) => {
      items.push(createJavaClassItem(alias, className));
    });
    return mergeByLabel(items);
  }

  async getJavaClassItemForReceiver(text, receiver) {
    const className = await this.resolveJavaClassName(text, receiver);
    return className ? createJavaClassItem(receiver, className) : null;
  }

  async getJavaMembersForReceiver(text, receiver) {
    const className = await this.resolveJavaClassName(text, receiver);
    if (!className) {
      return [];
    }
    const details = await this.getClassDetails(className);
    return collectJavaClassMembers(receiver, details);
  }

  async resolveJavaClassName(text, receiver) {
    if (!isUsableCompletionLabel(receiver) && !String(receiver || "").includes(".")) {
      return "";
    }
    const imports = parseJavaImports(text);
    if (imports.aliases.has(receiver)) {
      return imports.aliases.get(receiver);
    }
    const index = await this.getJavaClassIndex();
    const variableTypes = await resolveJavaVariableTypes(text, imports, index, await this.getConfiguredImportPackages());
    if (variableTypes.has(receiver)) {
      return variableTypes.get(receiver);
    }
    if (String(receiver).includes(".") && hasJavaClass(index, receiver)) {
      return receiver;
    }
    const packages = [...imports.packages, ...(await this.getConfiguredImportPackages())];
    for (const packageName of packages) {
      const className = `${packageName}.${receiver}`;
      if (hasJavaClass(index, className)) {
        return className;
      }
    }
    return "";
  }

  async getConfiguredImportPackages() {
    const config = await this.getConfig();
    return normalizeImportPackages(config && config.autoImportPackage);
  }
}

function addFunctionItems(items, source, detail) {
  collectMethodItems(source, "", detail).forEach((item) => items.push(item));
}

function addClassItems(globals, membersByReceiver, allMembers, source, detail) {
  if (!source || typeof source !== "object") {
    return;
  }
  Object.keys(source).forEach((label) => {
    const scriptClass = source[label];
    if (isUsableCompletionLabel(label)) {
      globals.push(createClassItem(label, scriptClass, detail));
    }
    const members = collectClassMembers(label, scriptClass);
    if (!members.length) {
      return;
    }
    shortReceiverNames(label).forEach((receiver) => {
      membersByReceiver.set(receiver, mergeByLabel([...(membersByReceiver.get(receiver) || []), ...members]));
    });
    members.forEach((item) => allMembers.push(item));
  });
}

function parseCompressedClasses(text) {
  const packages = new Map();
  const packageNames = new Set();
  const classNames = new Set();
  String(text || "").split(/\r?\n/).forEach((line) => {
    const index = line.indexOf(":");
    if (index < 0) {
      return;
    }
    const packageName = line.slice(0, index).trim();
    const classes = line.slice(index + 1)
      .split(",")
      .map((item) => item.trim())
      .filter(isUsableJavaClassName);
    if (!classes.length) {
      return;
    }
    addPackageParents(packageNames, packageName);
    packages.set(packageName, mergeUnique(packages.get(packageName) || [], classes));
    classes.forEach((className) => {
      classNames.add(packageName ? `${packageName}.${className}` : className);
    });
  });
  return { packages, packageNames, classNames };
}

function addPackageParents(packageNames, packageName) {
  if (!packageName) {
    return;
  }
  const parts = packageName.split(".");
  for (let index = 1; index <= parts.length; index++) {
    packageNames.add(parts.slice(0, index).join("."));
  }
}

function isUsableJavaClassName(className) {
  return isUsableCompletionLabel(className) && className !== "package-info";
}

function getJavaImportCompletions(index, prefix) {
  const normalized = String(prefix || "").replace(/\*$/, "");
  const hasTrailingDot = normalized.endsWith(".");
  const exactPrefix = hasTrailingDot ? normalized.slice(0, -1) : normalized;
  const exactPackage = index.packageNames.has(exactPrefix);
  const lastDot = normalized.lastIndexOf(".");
  const base = hasTrailingDot || exactPackage
    ? exactPrefix
    : (lastDot >= 0 ? normalized.slice(0, lastDot) : "");
  const fragment = hasTrailingDot || exactPackage
    ? ""
    : (lastDot >= 0 ? normalized.slice(lastDot + 1) : normalized);
  const items = [];
  const basePrefix = base ? `${base}.` : "";

  index.packageNames.forEach((packageName) => {
    if (base && !packageName.startsWith(basePrefix)) {
      return;
    }
    if (!base && packageName.includes(".")) {
      packageName = packageName.split(".")[0];
    }
    const rest = base ? packageName.slice(basePrefix.length) : packageName;
    if (!rest || rest.includes(".")) {
      return;
    }
    if (fragment && !rest.startsWith(fragment)) {
      return;
    }
    const fullName = base ? `${base}.${rest}` : rest;
    items.push({
      label: rest,
      insertText: fullName,
      filterText: fullName,
      detail: `Java 包 ${fullName}`,
      documentation: `Java 包：${fullName}`,
      source: "server",
      kind: "package",
      fullName
    });
  });

  const classes = index.packages.get(base) || [];
  classes.forEach((className) => {
    if (fragment && !className.startsWith(fragment)) {
      return;
    }
    const fullName = base ? `${base}.${className}` : className;
    items.push({
      label: className,
      insertText: fullName,
      filterText: fullName,
      detail: `Java 类 ${fullName}`,
      documentation: `Java 类型：${fullName}`,
      source: "server",
      kind: "class",
      fullName
    });
  });

  return mergeImportItems(items);
}

function mergeImportItems(items) {
  const seen = new Set();
  return items.filter((item) => {
    const key = `${item.kind}:${item.fullName}`;
    if (seen.has(key)) {
      return false;
    }
    seen.add(key);
    return true;
  });
}

function hasJavaClass(index, className) {
  return Boolean(index && index.classNames && index.classNames.has(className));
}

function parseJavaImports(text) {
  const aliases = new Map();
  const packages = [];
  String(text || "").split(/\r?\n/).forEach((line) => {
    const match = line.match(/^\s*import\s+(.+?)(?:\s+as\s+([A-Za-z_$][\w$]*))?\s*;?\s*$/);
    if (!match) {
      return;
    }
    const target = normalizeImportTarget(match[1]);
    const alias = match[2];
    if (!target || target.startsWith("@") || (!target.includes(".") && !target.endsWith(".*"))) {
      return;
    }
    if (target.endsWith(".*")) {
      packages.push(target.slice(0, -2));
      return;
    }
    const simpleName = target.slice(target.lastIndexOf(".") + 1);
    aliases.set(alias || simpleName, target);
  });
  return {
    aliases,
    packages: mergeUnique([], packages)
  };
}

async function resolveJavaVariableTypes(text, imports, index, configuredPackages) {
  const types = new Map();
  const packages = [...(imports.packages || []), ...(configuredPackages || [])];
  for (const statement of splitStatements(stripComments(text))) {
    const declaration = parseJavaVariableDeclaration(statement);
    if (!declaration) {
      continue;
    }
    const className = resolveJavaTypeName(declaration.type, imports, index, packages)
      || resolveJavaTypeName(declaration.newType, imports, index, packages);
    if (className && isUsableCompletionLabel(declaration.name)) {
      types.set(declaration.name, className);
    }
  }
  return types;
}

function parseJavaVariableDeclaration(statement) {
  const source = normalizeStatement(statement);
  if (!source || /^import\s+/.test(source)) {
    return null;
  }

  const varMatch = source.match(/^(?:var|let|const)\s+([A-Za-z_$][\w$]*)\s*=\s*new\s+([A-Za-z_$][\w$]*(?:\.[A-Za-z_$][\w$]*)*)(?:\s*<[^;=()]*>)?\s*\(/);
  if (varMatch) {
    return {
      type: "",
      name: varMatch[1],
      newType: varMatch[2]
    };
  }

  const typedMatch = source.match(/^([A-Za-z_$][\w$]*(?:\.[A-Za-z_$][\w$]*)*(?:\s*<[^;=()]*>)?(?:\s*\[\])?)\s+([A-Za-z_$][\w$]*)\s*(?:=|$)/);
  if (!typedMatch) {
    return null;
  }
  const rawType = cleanJavaType(typedMatch[1]);
  if (!rawType || isIgnoredDeclarationType(rawType)) {
    return null;
  }
  const newMatch = source.match(/=\s*new\s+([A-Za-z_$][\w$]*(?:\.[A-Za-z_$][\w$]*)*)(?:\s*<[^;=()]*>)?\s*\(/);
  return {
    type: rawType,
    name: typedMatch[2],
    newType: newMatch && newMatch[1]
  };
}

function normalizeStatement(statement) {
  return String(statement || "")
    .replace(/\s+/g, " ")
    .trim();
}

function stripComments(text) {
  return String(text || "")
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/\/\/.*$/gm, "");
}

function splitStatements(text) {
  return String(text || "")
    .split(/[;\r\n]+/)
    .map((statement) => statement.trim())
    .filter(Boolean);
}

function cleanJavaType(type) {
  return String(type || "")
    .replace(/\s+/g, "")
    .replace(/<.*>$/, "")
    .replace(/\[\]$/, "");
}

function isIgnoredDeclarationType(type) {
  return [
    "var",
    "let",
    "const",
    "return",
    "if",
    "for",
    "while",
    "new",
    "throw"
  ].includes(type);
}

function resolveJavaTypeName(type, imports, index, packages) {
  const raw = cleanJavaType(type);
  if (!raw) {
    return "";
  }
  if (imports.aliases.has(raw)) {
    return imports.aliases.get(raw);
  }
  if (raw.includes(".") && hasJavaClass(index, raw)) {
    return raw;
  }
  for (const packageName of packages) {
    const className = `${packageName}.${raw}`;
    if (hasJavaClass(index, className)) {
      return className;
    }
  }
  return "";
}

function normalizeImportTarget(value) {
  const text = String(value || "").trim();
  if ((text.startsWith("'") && text.endsWith("'")) || (text.startsWith("\"") && text.endsWith("\""))) {
    return text.slice(1, -1);
  }
  return text;
}

function normalizeImportPackages(value) {
  if (!value) {
    return [];
  }
  const values = Array.isArray(value) ? value : String(value).split(",");
  return mergeUnique([], values
    .map((item) => normalizeImportTarget(item).replace(/\s/g, "").replace(/\.\*$/, ""))
    .filter((item) => item && item.includes(".")));
}

function createJavaClassItem(label, className) {
  return {
    label,
    detail: `Java 类 ${className}`,
    documentation: `Java 类型：${className}`,
    source: "server",
    kind: "class"
  };
}

function collectJavaClassMembers(receiver, details) {
  const classDetails = Array.isArray(details) ? details : [details];
  return mergeByLabel(classDetails.flatMap((scriptClass) => collectClassMembers(receiver, scriptClass)));
}

function createClassItem(label, scriptClass, detail) {
  const className = readString(scriptClass, ["className", "type", "name"]);
  const isModule = Boolean(scriptClass && scriptClass.module);
  const documentation = [];
  if (isModule) {
    documentation.push(`运行时模块：${label}`);
  }
  if (className && className !== label) {
    documentation.push(`Java 类型：${className}`);
  }
  return {
    label,
    detail: isModule ? "magic-api 运行时模块" : detail,
    documentation: documentation.join("\n"),
    source: "server"
  };
}

function collectClassMembers(receiver, scriptClass) {
  if (!scriptClass || typeof scriptClass !== "object") {
    return [];
  }
  return mergeByLabel([
    ...collectMethodItems(scriptClass.methods, receiver, receiver),
    ...collectMethodItems(scriptClass.functions, receiver, receiver),
    ...collectMethodItems(scriptClass.members, receiver, receiver),
    ...collectMethodItems(scriptClass.extensionMethods, receiver, receiver),
    ...collectAttributeItems(scriptClass.attributes, receiver),
    ...collectAttributeItems(scriptClass.fields, receiver),
    ...collectAttributeItems(scriptClass.properties, receiver)
  ]);
}

function collectMethodItems(source, receiver, detail) {
  const items = [];
  forEachCandidate(source, (candidate, fallbackName) => {
    const label = extractLabel(candidate, fallbackName);
    if (!isUsableCompletionLabel(label)) {
      return;
    }
    const parameters = extractParameters(candidate);
    const returnType = shortType(readString(candidate, ["returnType", "type"]));
    const signature = createSignature(receiver, label, parameters, returnType);
    items.push({
      label,
      detail: signature || detail,
      signature,
      signatures: signature ? [signature] : undefined,
      documentation: extractDocumentation(candidate),
      parameters,
      source: "server",
      deprecated: Boolean(candidate && candidate.deprecated)
    });
  });
  return mergeByLabel(items);
}

function collectAttributeItems(source, receiver) {
  const items = [];
  forEachCandidate(source, (candidate, fallbackName) => {
    const label = extractLabel(candidate, fallbackName);
    if (!isUsableCompletionLabel(label)) {
      return;
    }
    const type = shortType(readString(candidate, ["type", "returnType"]));
    const signature = type ? `${receiver}.${label}: ${type}` : `${receiver}.${label}`;
    items.push({
      label,
      detail: signature,
      signature,
      signatures: [signature],
      documentation: extractDocumentation(candidate),
      source: "server",
      kind: "property"
    });
  });
  return mergeByLabel(items);
}

function forEachCandidate(source, visit, fallbackName) {
  if (!source) {
    return;
  }
  if (Array.isArray(source)) {
    source.forEach((item) => forEachCandidate(item, visit, fallbackName));
    return;
  }
  if (typeof source !== "object") {
    visit(source, fallbackName);
    return;
  }
  if (looksLikeSymbol(source)) {
    visit(source, fallbackName);
    return;
  }
  Object.keys(source).forEach((key) => {
    const value = source[key];
    if (Array.isArray(value)) {
      value.forEach((item) => forEachCandidate(item, visit, key));
    } else if (value && typeof value === "object") {
      forEachCandidate(value, visit, key);
    } else {
      visit({ name: key, value }, key);
    }
  });
}

function looksLikeSymbol(value) {
  return Boolean(value && typeof value === "object" && (
    readString(value, ["label", "name", "methodName", "functionName", "key"]) ||
    Array.isArray(value.parameters) ||
    readString(value, ["returnType", "comment", "documentation", "description", "doc"])
  ));
}

function extractLabel(value, fallbackName) {
  if (typeof value === "string") {
    return value;
  }
  const label = readString(value, ["label", "name", "methodName", "functionName", "key"]);
  return label || fallbackName || "";
}

function extractDocumentation(value) {
  return readString(value, ["comment", "documentation", "description", "doc"]);
}

function extractParameters(value) {
  if (!value || typeof value !== "object" || !Array.isArray(value.parameters)) {
    return [];
  }
  return value.parameters.map((parameter, index) => normalizeParameter(parameter, index));
}

function normalizeParameter(parameter, index) {
  if (typeof parameter === "string") {
    return { name: parameter };
  }
  const name = readString(parameter, ["name", "label", "key"]) || `arg${index + 1}`;
  return {
    name,
    type: shortType(readString(parameter, ["type", "className", "returnType"])),
    documentation: readString(parameter, ["comment", "documentation", "description", "doc", "value"]),
    varArgs: Boolean(parameter && parameter.varArgs)
  };
}

function createSignature(receiver, label, parameters, returnType) {
  if (!isUsableCompletionLabel(label)) {
    return "";
  }
  const prefix = receiver ? `${receiver}.` : "";
  const parameterList = (parameters || [])
    .map((parameter) => `${parameter.name || "arg"}${parameter.varArgs ? "..." : ""}`)
    .join(", ");
  const result = returnType ? `: ${returnType}` : "";
  return `${prefix}${label}(${parameterList})${result}`;
}

function readString(value, fields) {
  if (!value || typeof value !== "object") {
    return "";
  }
  for (const field of fields) {
    const text = value[field];
    if (typeof text === "string" && text.trim()) {
      return text.trim();
    }
  }
  return "";
}

function shortType(type) {
  if (!type) {
    return "";
  }
  if (type.endsWith("[]")) {
    return `${shortType(type.slice(0, -2))}[]`;
  }
  const parts = String(type).split(".");
  return parts[parts.length - 1] || type;
}

function mergeByLabel(items) {
  const merged = new Map();
  items.filter(Boolean).forEach((item) => {
    if (!isUsableCompletionLabel(item.label)) {
      return;
    }
    const existing = merged.get(item.label);
    if (!existing) {
      merged.set(item.label, Object.assign({}, item));
      return;
    }
    existing.signatures = mergeUnique(existing.signatures || [existing.signature].filter(Boolean), item.signatures || [item.signature].filter(Boolean));
    existing.documentation = mergeText(existing.documentation, item.documentation);
    existing.parameters = existing.parameters && existing.parameters.length ? existing.parameters : item.parameters;
    existing.deprecated = existing.deprecated || item.deprecated;
  });
  return Array.from(merged.values());
}

function mergeUnique(left, right) {
  const values = [];
  [...(left || []), ...(right || [])].forEach((value) => {
    if (value && !values.includes(value)) {
      values.push(value);
    }
  });
  return values;
}

function mergeText(left, right) {
  if (!left) {
    return right || "";
  }
  if (!right || left.includes(right)) {
    return left;
  }
  return `${left}\n\n${right}`;
}

module.exports = {
  RuntimeIndex
};
