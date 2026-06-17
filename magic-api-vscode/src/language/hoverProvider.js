"use strict";

const { createMarkdownDocumentation } = require("./documentation");

class MagicScriptHoverProvider {
  constructor(vscode, languageData, runtimeIndex) {
    this.vscode = vscode;
    this.languageData = languageData;
    this.runtimeIndex = runtimeIndex;
  }

  async provideHover(document, position) {
    const line = document.lineAt(position.line).text;
    const member = getMemberAtPosition(line, position.character);
    if (member) {
      const runtime = await this.getRuntimeSymbols();
      const method = findModuleMethod(this.languageData, member.receiver, member.member)
        || findRuntimeMember(runtime, member.receiver, member.member)
        || await this.findJavaMember(document, member.receiver, member.member);
      if (method) {
        return this.createHover(Object.assign({ source: "static" }, method), Object.assign({ line: position.line }, member.range));
      }
    }

    const word = getWordAtPosition(line, position.character);
    if (!word) {
      return null;
    }
    const source = findKeyword(this.languageData, word.text)
      || findModule(this.languageData, word.text)
      || findFunction(this.languageData, word.text)
      || findRuntimeGlobal(await this.getRuntimeSymbols(), word.text)
      || await this.findJavaClass(document, word.text);
    if (!source) {
      return null;
    }
    return this.createHover(source, Object.assign({ line: position.line }, word.range));
  }

  createHover(source, rawRange) {
    const documentation = createMarkdownDocumentation(this.vscode, source);
    if (!documentation) {
      return null;
    }
    const range = new this.vscode.Range(
      new this.vscode.Position(rawRange.line || 0, rawRange.start),
      new this.vscode.Position(rawRange.line || 0, rawRange.end)
    );
    return new this.vscode.Hover(documentation, range);
  }

  async getRuntimeSymbols() {
    if (!this.runtimeIndex || typeof this.runtimeIndex.getRuntimeSymbols !== "function") {
      return {};
    }
    return this.runtimeIndex.getRuntimeSymbols();
  }

  async findJavaMember(document, receiver, member) {
    if (!this.runtimeIndex || typeof this.runtimeIndex.getJavaMembersForReceiver !== "function") {
      return null;
    }
    const members = await this.runtimeIndex.getJavaMembersForReceiver(document.getText(), receiver);
    return members.find((item) => item.label === member) || null;
  }

  async findJavaClass(document, receiver) {
    if (!this.runtimeIndex || typeof this.runtimeIndex.getJavaClassItemForReceiver !== "function") {
      return null;
    }
    return this.runtimeIndex.getJavaClassItemForReceiver(document.getText(), receiver);
  }
}

function findKeyword(languageData, label) {
  const keyword = (languageData.keywords || []).find((item) => item.label === label);
  return keyword && Object.assign({ source: "static" }, keyword);
}

function findModule(languageData, label) {
  const module = languageData.modules && languageData.modules[label];
  return module && {
    label,
    detail: module.detail,
    documentation: module.documentation,
    source: "static"
  };
}

function findFunction(languageData, label) {
  const fn = (languageData.functions || []).find((item) => item.label === label);
  return fn && Object.assign({ source: "static" }, fn);
}

function findModuleMethod(languageData, receiver, member) {
  const module = languageData.modules && languageData.modules[receiver];
  return module && (module.methods || []).find((method) => method.label === member);
}

function findRuntimeMember(runtime, receiver, member) {
  const membersByReceiver = runtime && runtime.membersByReceiver;
  if (!membersByReceiver || typeof membersByReceiver.get !== "function") {
    return null;
  }
  const methods = membersByReceiver.get(receiver) || [];
  return methods.find((method) => method.label === member) || null;
}

function findRuntimeGlobal(runtime, label) {
  const globals = runtime && runtime.globals;
  if (!Array.isArray(globals)) {
    return null;
  }
  return globals.find((item) => item.label === label) || null;
}

function getMemberAtPosition(line, character) {
  const pattern = /\b([A-Za-z_$][\w$]*)\s*(?:\.|\?\.)\s*([A-Za-z_$][\w$]*)/g;
  let match;
  while ((match = pattern.exec(line))) {
    const full = match[0];
    const receiver = match[1];
    const member = match[2];
    const memberStart = match.index + full.lastIndexOf(member);
    const memberEnd = memberStart + member.length;
    if (character >= memberStart && character <= memberEnd) {
      return {
        receiver,
        member,
        range: { start: memberStart, end: memberEnd }
      };
    }
  }
  return null;
}

function getWordAtPosition(line, character) {
  const pattern = /[A-Za-z_$][\w$]*/g;
  let match;
  while ((match = pattern.exec(line))) {
    const start = match.index;
    const end = start + match[0].length;
    if (character >= start && character <= end) {
      return {
        text: match[0],
        range: { start, end }
      };
    }
  }
  return null;
}

module.exports = {
  MagicScriptHoverProvider
};
