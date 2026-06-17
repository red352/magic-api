"use strict";

const { loadLanguageData } = require("./data");
const { MagicScriptCompletionProvider } = require("./completionProvider");
const { MagicScriptFormattingProvider } = require("./formattingProvider");
const { MagicScriptHoverProvider } = require("./hoverProvider");
const { RuntimeIndex } = require("./runtimeIndex");
const { WorkspaceIndex } = require("./workspaceIndex");

function registerMagicScriptLanguageFeatures({ vscode, client, output, workspaceMirror }) {
  const languageData = loadLanguageData();
  const runtimeIndex = new RuntimeIndex(client, output);
  const workspaceIndex = new WorkspaceIndex(vscode, workspaceMirror, output);
  const selector = { language: "magic-script" };
  const disposables = [
    vscode.languages.registerCompletionItemProvider(
      selector,
      new MagicScriptCompletionProvider(vscode, languageData, runtimeIndex, workspaceIndex),
      ".",
      "$",
      ":",
      "#",
      "@",
      "?"
    ),
    vscode.languages.registerDocumentFormattingEditProvider(
      selector,
      new MagicScriptFormattingProvider(vscode)
    ),
    vscode.languages.registerHoverProvider(
      selector,
      new MagicScriptHoverProvider(vscode, languageData, runtimeIndex)
    )
  ];
  return vscode.Disposable.from(...disposables);
}

module.exports = {
  registerMagicScriptLanguageFeatures
};
