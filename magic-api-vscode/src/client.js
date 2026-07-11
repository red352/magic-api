"use strict";

const http = require("http");
const https = require("https");
const { WorkspaceConnectionStore } = require("./workspaceConnection");

const RESOURCE_SEPARATOR = "\r\n================================\r\n";

class MagicApiClient {
  constructor(context, output, vscode, connectionStore) {
    this.context = context;
    this.output = output;
    this.vscode = vscode;
    this.connectionStore = connectionStore || new WorkspaceConnectionStore(context, vscode);
    this.configCache = undefined;
    this.classesCache = undefined;
    this.classesTextCache = undefined;
    this.classCache = new Map();
  }

  getServerUrl() {
    return this.connectionStore.getServerUrl();
  }

  hasWorkspace() {
    return this.connectionStore.hasWorkspace();
  }

  assertWorkspace() {
    this.connectionStore.assertWorkspace();
  }

  async getUsername() {
    return this.connectionStore.getUsername();
  }

  clearCache() {
    this.configCache = undefined;
    this.classesCache = undefined;
    this.classesTextCache = undefined;
    this.classCache.clear();
  }

  async login(username, password) {
    const body = formEncode({ username, password });
    const response = await this.request("POST", "/login", body, {
      "content-type": "application/x-www-form-urlencoded;charset=utf-8"
    }, false);
    const payload = parseJson(response.text);
    if (!payload || payload.code !== 1 || payload.data !== true) {
      throw new Error(payload && payload.message ? payload.message : "Login failed.");
    }
    const token = response.headers["magic-token"] || response.headers["Magic-Token".toLowerCase()];
    if (token) {
      await this.setToken(Array.isArray(token) ? token[0] : token);
    }
    await this.connectionStore.setUsername(username);
  }

  async setToken(token) {
    await this.connectionStore.setToken(token);
  }

  async clearToken() {
    await this.connectionStore.clearToken();
  }

  async getConfig() {
    if (!this.configCache) {
      const response = await this.request("GET", "/config.json", undefined, undefined, true);
      this.configCache = parseJson(response.text) || {};
    }
    return this.configCache;
  }

  async getResources() {
    return this.getJsonBean("POST", "/resource");
  }

  async getFile(id) {
    return this.getJsonBean("GET", `/resource/file/${encodeURIComponent(id)}`);
  }

  async saveFile(folder, entity) {
    const serialized = serializeResource(folder, entity);
    const encrypted = encryptForMagicApi(serialized);
    const savedId = await this.getJsonBean(
      "POST",
      `/resource/file/${encodeURIComponent(folder)}/save?auto=0`,
      encrypted,
      { "content-type": "text/plain;charset=utf-8" }
    );
    return savedId;
  }

  async saveGroup(group) {
    return this.getJsonBean(
      "POST",
      "/resource/folder/save",
      JSON.stringify(group),
      { "content-type": "application/json;charset=utf-8" }
    );
  }

  async deleteResource(id) {
    return this.getJsonBean(
      "POST",
      "/resource/delete",
      formEncode({ id }),
      { "content-type": "application/x-www-form-urlencoded;charset=utf-8" }
    );
  }

  async reload() {
    return this.getJsonBean("GET", "/reload");
  }

  async getClasses() {
    if (!this.classesCache) {
      this.classesCache = await this.getJsonBean("POST", "/classes");
    }
    return this.classesCache;
  }

  async getClassesText() {
    if (this.classesTextCache === undefined) {
      const response = await this.request("GET", "/classes.txt", undefined, undefined, false);
      this.classesTextCache = response.text || "";
    }
    return this.classesTextCache;
  }

  async getClass(className) {
    const key = String(className || "").trim();
    if (!key) {
      return [];
    }
    if (!this.classCache.has(key)) {
      const body = formEncode({ className: key });
      this.classCache.set(key, await this.getJsonBean("POST", "/class", body, {
        "content-type": "application/x-www-form-urlencoded;charset=utf-8"
      }));
    }
    return this.classCache.get(key);
  }

  async requestAbsolute(method, absoluteUrl, body, headers, includeToken, rejectOnError) {
    const token = includeToken ? await this.connectionStore.getToken() : undefined;
    const allHeaders = Object.assign({}, headers || {});
    if (token) {
      allHeaders["Magic-Token"] = token;
    }
    if (body !== undefined && body !== null) {
      allHeaders["content-length"] = Buffer.byteLength(body);
    }
    return requestText(new URL(absoluteUrl), method, body, allHeaders, rejectOnError);
  }

  async getJsonBean(method, path, body, headers) {
    const response = await this.request(method, path, body, headers, true);
    const payload = parseJson(response.text);
    if (!payload) {
      throw new Error(`Expected JSON from ${path}.`);
    }
    if (typeof payload.code === "number" && payload.code !== 1) {
      const error = new Error(payload.message || `magic-api returned code ${payload.code}.`);
      error.magicApiCode = payload.code;
      error.magicApiResponse = true;
      throw error;
    }
    return payload.data;
  }

  async request(method, path, body, headers, includeToken) {
    const url = new URL(this.getServerUrl() + (path.startsWith("/") ? path : `/${path}`));
    const token = includeToken ? await this.connectionStore.getToken() : undefined;
    const allHeaders = Object.assign({}, headers || {});
    if (token) {
      allHeaders["Magic-Token"] = token;
    }
    if (body !== undefined && body !== null) {
      allHeaders["content-length"] = Buffer.byteLength(body);
    }
    return requestText(url, method, body, allHeaders, true);
  }
}

function requestText(url, method, body, headers, rejectOnError) {
  return new Promise((resolve, reject) => {
    const transport = url.protocol === "https:" ? https : http;
    const request = transport.request(
      url,
      {
        method,
        headers
      },
      (response) => {
        const chunks = [];
        response.on("data", (chunk) => chunks.push(chunk));
        response.on("end", () => {
          const text = Buffer.concat(chunks).toString("utf8");
          if (rejectOnError !== false && response.statusCode >= 400) {
            reject(new Error(`HTTP ${response.statusCode}: ${text || response.statusMessage}`));
            return;
          }
          resolve({
            statusCode: response.statusCode,
            headers: response.headers,
            text
          });
        });
      }
    );
    request.on("error", reject);
    if (body !== undefined && body !== null) {
      request.write(body);
    }
    request.end();
  });
}

function normalizeServerUrl(serverUrl) {
  return String(serverUrl || "").trim().replace(/\/+$/, "");
}

function formEncode(values) {
  return Object.keys(values)
    .map((key) => `${encodeURIComponent(key)}=${encodeURIComponent(values[key] || "")}`)
    .join("&");
}

function parseJson(text) {
  try {
    return JSON.parse(text);
  } catch (error) {
    return undefined;
  }
}

function encryptForMagicApi(text) {
  return rot13(Buffer.from(text, "utf8").toString("base64"));
}

function rot13(text) {
  return String(text).replace(/[a-zA-Z]/g, (char) => {
    const base = char <= "Z" ? 65 : 97;
    return String.fromCharCode(((char.charCodeAt(0) - base + 13) % 26) + base);
  });
}

function serializeResource(folder, entity) {
  if (folder === "datasource") {
    return JSON.stringify(entity);
  }
  const metadata = Object.assign({}, entity || {});
  delete metadata.script;
  return JSON.stringify(metadata) + RESOURCE_SEPARATOR + (entity.script || "");
}

module.exports = {
  MagicApiClient,
  normalizeServerUrl
};
