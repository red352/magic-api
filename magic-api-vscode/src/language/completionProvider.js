"use strict";

const {
  collectVisibleVariables,
  dedupeByLabel,
  getCompletionReceiver,
  getImportContext,
  getSqlPlaceholderContext,
  isUsableCompletionLabel
} = require("./utils");
const { createMarkdownDocumentation } = require("./documentation");

class MagicScriptCompletionProvider {
  constructor(vscode, languageData, runtimeIndex, workspaceIndex) {
    this.vscode = vscode;
    this.languageData = languageData;
    this.runtimeIndex = runtimeIndex;
    this.workspaceIndex = workspaceIndex;
  }

  async provideCompletionItems(document, position) {
    const offset = document.offsetAt(position);
    const workspaceVariables = await this.workspaceIndex.getDocumentVariables(document, this.languageData);
    if (getSqlPlaceholderContext(document, position)) {
      return this.createVariableItems(collectVisibleVariables(document.getText(), offset, workspaceVariables));
    }

    const importContext = getImportContext(document, position);
    const runtime = await this.runtimeIndex.getRuntimeSymbols();
    if (importContext) {
      return this.createImportItems(importContext, runtime, position);
    }

    const receiver = getCompletionReceiver(document, position);
    if (receiver) {
      const members = this.buildMembers(runtime);
      const javaMembers = await this.runtimeIndex.getJavaMembersForReceiver(document.getText(), receiver);
      const specific = dedupeByLabel([...(members.byReceiver.get(receiver) || []), ...javaMembers]);
      const fallback = members.all;
      return dedupeByLabel(specific.length ? specific : fallback).map((item) => this.toCompletionItem(item, this.kindForMember(item)));
    }

    const workspace = await this.workspaceIndex.getIndex();
    const items = [];
    this.languageData.keywords.forEach((item) => items.push(this.toCompletionItem(item, this.vscode.CompletionItemKind.Keyword, "30_")));
    this.languageData.functions.forEach((item) => items.push(this.toCompletionItem(item, this.vscode.CompletionItemKind.Function, "40_")));
    Object.keys(this.languageData.modules || {}).forEach((label) => {
      const module = this.languageData.modules[label];
      items.push(this.toCompletionItem({ label, detail: module.detail, documentation: module.documentation, source: "static" }, this.vscode.CompletionItemKind.Module, "20_"));
    });
    this.languageData.snippets.forEach((snippet) => items.push(this.toSnippetItem(snippet)));
    collectVisibleVariables(document.getText(), offset, workspaceVariables).forEach((label) => {
      items.push(this.toCompletionItem({ label, detail: "当前脚本变量", source: "workspace" }, this.vscode.CompletionItemKind.Variable, "10_"));
    });
    runtime.globals.forEach((item) => items.push(this.toCompletionItem(item, this.vscode.CompletionItemKind.Function, "50_")));
    workspace.resources.forEach((resource) => {
      const kind = resource.folder === "datasource" ? this.vscode.CompletionItemKind.Value : this.vscode.CompletionItemKind.Reference;
      const label = resource.key || resource.apiPath || resource.name;
      if (isUsableCompletionLabel(label) || resource.folder === "api") {
        items.push(this.toCompletionItem({
          label,
          detail: resource.detail,
          documentation: resource.path,
          source: "workspace"
        }, kind, "60_"));
      }
    });
    (await this.runtimeIndex.getImportedClassItems(document.getText())).forEach((item) => {
      items.push(this.toCompletionItem(item, this.vscode.CompletionItemKind.Class, "15_"));
    });
    return dedupeByLabel(items);
  }

  async createImportItems(importContext, runtime, position) {
    const prefix = importContext.prefix || "";
    const items = [];
    if (!prefix.includes(".")) {
      (runtime.globals || [])
        .filter((item) => item.label && item.label.startsWith(prefix) && item.detail && /类|模块/.test(item.detail))
        .forEach((item) => items.push(this.toImportCompletionItem(item, importContext, position, this.vscode.CompletionItemKind.Module, "20_")));
    }
    (await this.runtimeIndex.getJavaImportCompletions(prefix)).forEach((item) => {
      items.push(this.toImportCompletionItem(item, importContext, position, this.kindForImport(item), item.kind === "package" ? "10_" : "30_"));
    });
    return dedupeByLabel(items);
  }

  buildMembers(runtime) {
    const byReceiver = new Map();
    const all = [];
    Object.keys(this.languageData.modules || {}).forEach((receiver) => {
      const methods = (this.languageData.modules[receiver].methods || []).map((method) =>
        Object.assign({ source: "static" }, method)
      );
      byReceiver.set(receiver, methods);
      methods.forEach((method) => all.push(method));
    });
    (runtime.allMembers || []).forEach((item) => all.push(item));
    (runtime.membersByReceiver || new Map()).forEach((items, receiver) => {
      byReceiver.set(receiver, dedupeByLabel([...(byReceiver.get(receiver) || []), ...items]));
    });
    return { byReceiver, all: dedupeByLabel(all) };
  }

  createVariableItems(labels) {
    return labels
      .filter(isUsableCompletionLabel)
      .map((label) => this.toCompletionItem({ label, detail: "SQL 参数变量", source: "workspace" }, this.vscode.CompletionItemKind.Variable));
  }

  toCompletionItem(source, kind, sortPrefix = "") {
    const item = new this.vscode.CompletionItem(source.label, kind);
    item.detail = source.signature || source.detail || source.source || "";
    item.sortText = `${sortPrefix}${source.label}`;
    item.filterText = source.filterText || source.label;
    if (source.insertText) {
      item.insertText = source.insertText;
    }
    const documentation = createMarkdownDocumentation(this.vscode, source);
    if (documentation) {
      item.documentation = documentation;
    }
    return item;
  }

  toSnippetItem(snippet) {
    const item = new this.vscode.CompletionItem(snippet.label, this.vscode.CompletionItemKind.Snippet);
    item.detail = snippet.detail || "magic-script 片段";
    item.insertText = new this.vscode.SnippetString(snippet.body);
    item.sortText = `00_${snippet.label}`;
    return item;
  }

  toImportCompletionItem(source, importContext, position, kind, sortPrefix = "") {
    const item = this.toCompletionItem(source, kind, sortPrefix);
    item.insertText = source.insertText || source.fullName || source.label;
    item.range = new this.vscode.Range(
      new this.vscode.Position(position.line, importContext.start),
      new this.vscode.Position(position.line, position.character)
    );
    return item;
  }

  kindForMember(item) {
    if (item && item.kind === "property") {
      return this.vscode.CompletionItemKind.Property || this.vscode.CompletionItemKind.Field || this.vscode.CompletionItemKind.Value || this.vscode.CompletionItemKind.Method;
    }
    return this.vscode.CompletionItemKind.Method;
  }

  kindForImport(item) {
    if (item && item.kind === "package") {
      return this.vscode.CompletionItemKind.Folder || this.vscode.CompletionItemKind.Module;
    }
    return this.vscode.CompletionItemKind.Class;
  }
}

module.exports = {
  MagicScriptCompletionProvider
};
