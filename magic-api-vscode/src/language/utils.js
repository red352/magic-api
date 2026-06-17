"use strict";

function messageOf(error) {
  return error && error.message ? error.message : String(error);
}

function formatError(error) {
  if (error && error.stack) {
    return error.stack;
  }
  return messageOf(error);
}

function isUsableCompletionLabel(label) {
  return typeof label === "string" && /^[A-Za-z_$][\w$]*$/.test(label) && label.length < 100;
}

function collectLabelsDeep(value, depth, seen = new Set()) {
  const labels = [];
  if (!value || depth < 0 || seen.has(value)) {
    return labels;
  }
  if (typeof value !== "object") {
    return labels;
  }
  seen.add(value);
  if (Array.isArray(value)) {
    value.forEach((item) => labels.push(...collectLabelsDeep(item, depth - 1, seen)));
    return labels;
  }
  ["name", "methodName", "functionName", "key", "value"].forEach((field) => {
    const label = value[field];
    if (isUsableCompletionLabel(label)) {
      labels.push(label);
    }
  });
  Object.keys(value).forEach((key) => {
    if (isUsableCompletionLabel(key) && !["properties", "children"].includes(key)) {
      labels.push(key);
    }
    labels.push(...collectLabelsDeep(value[key], depth - 1, seen));
  });
  return labels;
}

function collectMemberLabels(value) {
  const labels = [];
  [
    "methods",
    "functions",
    "constructors",
    "fields",
    "properties",
    "attributes",
    "members",
    "extensionMethods"
  ].forEach((field) => {
    if (value && value[field]) {
      labels.push(...collectLabelsDeep(value[field], 4));
    }
  });
  labels.push(...collectLabelsDeep(value, 2));
  return Array.from(new Set(labels.filter(isUsableCompletionLabel)));
}

function shortReceiverNames(receiver) {
  const parts = String(receiver).split(".");
  const names = [receiver];
  if (parts.length > 1) {
    names.push(parts[parts.length - 1]);
  }
  return names;
}

function dedupeByLabel(items) {
  const seen = new Set();
  return items.filter((item) => {
    const rawLabel = item && item.label;
    const label = typeof rawLabel === "string" ? rawLabel : rawLabel && rawLabel.label;
    if (!label || seen.has(label)) {
      return false;
    }
    seen.add(label);
    return true;
  });
}

function getCompletionReceiver(document, position) {
  const linePrefix = document.lineAt(position.line).text.slice(0, position.character);
  const match = linePrefix.match(/([A-Za-z_$][\w$]*(?:(?:\.|\?\.)[A-Za-z_$][\w$]*)*)(?:\.|\?\.)$/);
  return match ? match[1].replace(/\?\./g, ".") : "";
}

function getSqlPlaceholderContext(document, position) {
  const linePrefix = document.lineAt(position.line).text.slice(0, position.character);
  return /[#@]\{[A-Za-z_$][\w$.]*$/.test(linePrefix);
}

function getImportContext(document, position) {
  const linePrefix = document.lineAt(position.line).text.slice(0, position.character);
  const match = linePrefix.match(/^(\s*import\s+)(.*)$/);
  if (!match || /\s+as\s+/.test(match[2])) {
    return null;
  }
  let raw = match[2];
  let start = match[1].length;
  let quoted = false;
  if (raw.startsWith("'") || raw.startsWith("\"")) {
    quoted = true;
    raw = raw.slice(1);
    start++;
    if (/['"]/.test(raw)) {
      return null;
    }
  }
  if (!/^[A-Za-z0-9_.$*]*$/.test(raw)) {
    return null;
  }
  return {
    prefix: raw,
    start,
    quoted
  };
}

function collectVisibleVariables(text, offset, extraNames = []) {
  const source = typeof offset === "number" ? text.slice(0, offset) : text;
  const names = new Set(extraNames.filter(isUsableCompletionLabel));
  const varPattern = /\b(?:var|let|const)\s+([A-Za-z_$][\w$]*)/g;
  let match;
  while ((match = varPattern.exec(source))) {
    names.add(match[1]);
  }
  const typedPattern = /(?:^|[;\n\r{])\s*[A-Za-z_$][\w$]*(?:<[^>\n]+>)?\s+([A-Za-z_$][\w$]*)\s*(?:=|;|\n|\r)/g;
  while ((match = typedPattern.exec(source))) {
    names.add(match[1]);
  }
  const lambdaPattern = /(?:\(([^(){}\n]*)\)|([A-Za-z_$][\w$]*))\s*(?:=>|->)/g;
  while ((match = lambdaPattern.exec(source))) {
    const raw = match[1] || match[2] || "";
    raw.split(",").map((part) => part.trim()).forEach((part) => {
      const name = part.match(/[A-Za-z_$][\w$]*$/);
      if (name) {
        names.add(name[0]);
      }
    });
  }
  return Array.from(names);
}

function extractMemberCalls(text) {
  const calls = [];
  const pattern = /\b([A-Za-z_$][\w$]*)\s*(?:\?\.|\.)\s*([A-Za-z_$][\w$]*)\s*\(/g;
  let match;
  while ((match = pattern.exec(text))) {
    calls.push({
      receiver: match[1],
      member: match[2],
      start: match.index,
      end: match.index + match[0].length
    });
  }
  return calls;
}

function getCallExpressionAt(document, position) {
  const offset = document.offsetAt(position);
  const text = document.getText().slice(0, offset);
  const lineStart = Math.max(text.lastIndexOf("\n"), text.lastIndexOf("\r")) + 1;
  const prefix = text.slice(lineStart);
  const match = prefix.match(/([A-Za-z_$][\w$]*(?:\.[A-Za-z_$][\w$]*)?)\s*\(([^()]*)$/);
  if (!match) {
    return null;
  }
  return {
    name: match[1],
    activeParameter: match[2].trim() ? match[2].split(",").length - 1 : 0
  };
}

function lineStartOffsets(text) {
  const offsets = [0];
  for (let index = 0; index < text.length; index++) {
    if (text[index] === "\n") {
      offsets.push(index + 1);
    }
  }
  return offsets;
}

function offsetFromOneBasedLineColumn(text, line, column) {
  const starts = lineStartOffsets(text);
  const lineIndex = Math.max(0, Math.min((line || 1) - 1, starts.length - 1));
  return Math.min(text.length, starts[lineIndex] + Math.max(0, (column || 1) - 1));
}

module.exports = {
  collectLabelsDeep,
  collectMemberLabels,
  collectVisibleVariables,
  dedupeByLabel,
  extractMemberCalls,
  formatError,
  getCallExpressionAt,
  getCompletionReceiver,
  getImportContext,
  getSqlPlaceholderContext,
  isUsableCompletionLabel,
  messageOf,
  offsetFromOneBasedLineColumn,
  shortReceiverNames
};
