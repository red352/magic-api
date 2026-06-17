"use strict";

const fs = require("fs");
const path = require("path");

function parseJson(text) {
  try {
    return JSON.parse(text);
  } catch (error) {
    return undefined;
  }
}

class WorkspaceIndex {
  constructor(vscode, workspaceMirror, output) {
    this.vscode = vscode;
    this.workspaceMirror = workspaceMirror;
    this.output = output;
  }

  async getIndex() {
    try {
      const root = await this.workspaceMirror.resolveRoot();
      const manifest = await this.workspaceMirror.readManifest(root);
      const resources = [];
      for (const entry of manifest.entries || []) {
        const metadata = await this.readMetadata(root, entry);
        resources.push(this.toResource(entry, metadata));
      }
      return { root, manifest, resources };
    } catch (error) {
      return { root: "", manifest: { entries: [] }, resources: [] };
    }
  }

  async getDocumentResource(document) {
    if (!document || !document.uri || document.uri.scheme !== "file") {
      return null;
    }
    try {
      const root = await this.workspaceMirror.resolveRoot();
      const manifest = await this.workspaceMirror.readManifest(root);
      const entry = this.workspaceMirror.findEntryByUri(root, manifest, document.uri);
      if (!entry) {
        return null;
      }
      const metadata = await this.readMetadata(root, entry);
      return { root, manifest, entry, metadata };
    } catch (error) {
      return null;
    }
  }

  async getDocumentVariables(document, languageData) {
    const resource = await this.getDocumentResource(document);
    const names = new Set(languageData.requestRoots || []);
    if (!resource || !resource.metadata) {
      return Array.from(names);
    }
    collectDefinitionNames(resource.metadata.parameters, names);
    collectDefinitionNames(resource.metadata.headers, names);
    collectDefinitionNames(resource.metadata.pathVariables, names);
    collectDefinitionNames(resource.metadata.requestBodyDefinition && resource.metadata.requestBodyDefinition.children, names);
    if (resource.metadata.requestBody && resource.metadata.requestBody.name) {
      names.add(resource.metadata.requestBody.name);
    }
    return Array.from(names);
  }

  async readMetadata(root, entry) {
    if (!entry) {
      return {};
    }
    if (entry.metadataPath) {
      return parseJson(await fs.promises.readFile(path.join(root, entry.metadataPath), "utf8")) || {};
    }
    if (entry.type === "json") {
      return parseJson(await fs.promises.readFile(path.join(root, entry.path), "utf8")) || {};
    }
    return {};
  }

  toResource(entry, metadata) {
    const name = metadata.name || metadata.path || metadata.key || entry.name || entry.id || "";
    const detailParts = [entry.folder];
    if (metadata.method) {
      detailParts.push(String(metadata.method).toUpperCase());
    }
    if (metadata.path) {
      detailParts.push(metadata.path);
    }
    return {
      id: entry.id,
      folder: entry.folder,
      path: entry.path,
      name,
      method: metadata.method,
      apiPath: metadata.path,
      key: metadata.key,
      detail: detailParts.join(" "),
      source: "workspace"
    };
  }
}

function collectDefinitionNames(definitions, names) {
  (definitions || []).forEach((definition) => {
    if (definition && definition.name) {
      names.add(definition.name);
    }
    collectDefinitionNames(definition && definition.children, names);
  });
}

module.exports = {
  WorkspaceIndex
};
