"use strict";

function createMarkdownDocumentation(vscode, source) {
  const markdown = new vscode.MarkdownString();
  markdown.supportHtml = false;
  markdown.isTrusted = false;
  let hasContent = false;
  const signatures = Array.isArray(source.signatures) && source.signatures.length
    ? source.signatures
    : [source.signature].filter(Boolean);
  if (signatures.length) {
    markdown.appendCodeblock(signatures.join("\n"), "magic-script");
    hasContent = true;
  }
  if (source.documentation) {
    if (hasContent) {
      markdown.appendMarkdown("\n\n");
    }
    markdown.appendMarkdown(escapeMarkdownText(source.documentation));
    hasContent = true;
  }
  if (Array.isArray(source.parameters) && source.parameters.length) {
    markdown.appendMarkdown("\n\n**参数**\n\n");
    source.parameters.forEach((parameter) => {
      markdown.appendMarkdown(formatParameter(parameter));
    });
    hasContent = true;
  }
  if (source.example) {
    markdown.appendMarkdown("\n\n**示例**\n\n");
    markdown.appendCodeblock(source.example, "magic-script");
    hasContent = true;
  }
  if (source.source) {
    markdown.appendMarkdown(`\n\n来源：\`${source.source}\``);
    hasContent = true;
  }
  return hasContent ? markdown : undefined;
}

function formatParameter(parameter) {
  if (!parameter || typeof parameter !== "object") {
    return `- \`${parameter}\`\n`;
  }
  const name = parameter.name || parameter.label || "";
  const type = parameter.type ? `: ${parameter.type}` : "";
  const varArgs = parameter.varArgs ? "..." : "";
  const documentation = parameter.documentation ? ` - ${escapeMarkdownText(parameter.documentation)}` : "";
  return `- \`${name}${varArgs}${type}\`${documentation}\n`;
}

function escapeMarkdownText(text) {
  return String(text || "").replace(/[\\`*_{}[\]()#+\-.!|]/g, "\\$&");
}

module.exports = {
  createMarkdownDocumentation
};
