"use strict";

class MagicScriptFormattingProvider {
  constructor(vscode) {
    this.vscode = vscode;
  }

  provideDocumentFormattingEdits(document, options) {
    const range = new this.vscode.Range(
      document.positionAt(0),
      document.positionAt(document.getText().length)
    );
    return [
      this.vscode.TextEdit.replace(range, formatMagicScript(document.getText(), options))
    ];
  }
}

function formatMagicScript(text, options) {
  const indentText = options && options.insertSpaces === false
    ? "\t"
    : " ".repeat((options && options.tabSize) || 2);
  const lines = text.replace(/\r\n/g, "\n").replace(/\r/g, "\n").split("\n");
  let indent = 0;
  let inBlockComment = false;
  const formatted = lines.map((line) => {
    const trimmed = line.trim();
    if (!trimmed) {
      return "";
    }
    const code = stripStringsAndComments(trimmed, { inBlockComment });
    inBlockComment = code.inBlockComment;
    const sanitized = code.text;
    const startsWithClose = /^[}\])]/.test(trimmed);
    const startsWithContinuation = /^(else|catch|finally)\b/.test(trimmed);
    let lineIndent = indent;
    if (startsWithClose || startsWithContinuation) {
      lineIndent = Math.max(0, lineIndent - 1);
    }
    let net = countChar(sanitized, "{") - countChar(sanitized, "}");
    if (startsWithClose) {
      net += 1;
    }
    const result = indentText.repeat(lineIndent) + trimmed.replace(/[ \t]+$/g, "");
    indent = Math.max(0, lineIndent + net);
    return result;
  });
  return formatted.join("\n");
}

function stripStringsAndComments(text, state) {
  let result = "";
  let quote = "";
  let escaping = false;
  let inBlockComment = Boolean(state && state.inBlockComment);
  for (let index = 0; index < text.length; index++) {
    const char = text[index];
    const next = text[index + 1];
    if (inBlockComment) {
      if (char === "*" && next === "/") {
        inBlockComment = false;
        index++;
      }
      continue;
    }
    if (quote) {
      if (escaping) {
        escaping = false;
      } else if (char === "\\") {
        escaping = true;
      } else if (char === quote) {
        quote = "";
      }
      continue;
    }
    if (char === "/" && next === "/") {
      break;
    }
    if (char === "/" && next === "*") {
      inBlockComment = true;
      index++;
      continue;
    }
    if (char === "\"" || char === "'") {
      quote = char;
      continue;
    }
    result += char;
  }
  return { text: result, inBlockComment };
}

function countChar(text, char) {
  let count = 0;
  for (let index = 0; index < text.length; index++) {
    if (text[index] === char) {
      count++;
    }
  }
  return count;
}

module.exports = {
  MagicScriptFormattingProvider,
  formatMagicScript
};
