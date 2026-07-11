"use strict";

const assert = require("assert");
const path = require("path");
const { MagicApiClient } = require("../src/client");
const {
  DEFAULT_SERVER_URL,
  DEFAULT_WORKSPACE_DIR,
  TOKEN_SECRET_PREFIX,
  WorkspaceConnectionStore
} = require("../src/workspaceConnection");

main().catch((error) => {
  process.stderr.write(`${error.stack || error}\n`);
  process.exit(1);
});

async function main() {
  const sharedSecrets = new Map([["magic-api.token", "legacy-global-token"]]);
  const workspaceA = createContext(sharedSecrets, { "magicApi.connection.workspaceId": "workspace-a" });
  const workspaceB = createContext(sharedSecrets, { "magicApi.connection.workspaceId": "workspace-b" });
  const vscodeA = createVscode({
    folders: ["/workspace/a"],
    globalValues: {
      serverUrl: "http://global.example/magic/web",
      workspaceDir: "/global/mirror"
    }
  });
  const vscodeB = createVscode({ folders: ["/workspace/b", "/workspace/shared"] });
  const storeA = new WorkspaceConnectionStore(workspaceA.context, vscodeA.vscode);
  const storeB = new WorkspaceConnectionStore(workspaceB.context, vscodeB.vscode);

  assert.strictEqual(storeA.getServerUrl(), DEFAULT_SERVER_URL, "legacy global serverUrl must be ignored");
  assert.strictEqual(storeA.getWorkspaceDir(), DEFAULT_WORKSPACE_DIR, "legacy global workspaceDir must be ignored");
  assert.strictEqual(await storeA.getToken(), undefined, "legacy global token must be ignored");

  const behavior = createContext(sharedSecrets, { "magicApi.connection.workspaceId": "workspace-behavior" });
  const behaviorVscode = createVscode({
    folders: ["/workspace/behavior"],
    globalValues: { syncOnSave: false, autoPullOnOpen: true, checkConflicts: false },
    workspaceValues: { autoPullOnOpen: false, checkConflicts: true }
  });
  const behaviorStore = new WorkspaceConnectionStore(behavior.context, behaviorVscode.vscode);
  assert.strictEqual(behaviorStore.getBehaviorSetting("syncOnSave", true), false);
  assert.strictEqual(behaviorStore.getBehaviorSetting("autoPullOnOpen", true), false);
  assert.strictEqual(behaviorStore.getBehaviorSetting("checkConflicts", true), true);

  await storeA.setServerUrl("http://workspace-a.example/magic/web/");
  assert.strictEqual(storeA.getServerUrl(), "http://workspace-a.example/magic/web");
  assert.deepStrictEqual(vscodeA.updates, [{ key: "serverUrl", value: "http://workspace-a.example/magic/web", target: 2 }]);

  await storeA.setUsername("alice");
  assert.strictEqual(await storeA.getUsername(), "alice");
  assert.strictEqual(await storeB.getUsername(), "");
  assert.strictEqual(typeof storeA.setPassword, "undefined", "password persistence API must not exist");

  await storeA.setToken("token-a");
  await storeB.setToken("token-b");
  assert.deepStrictEqual(JSON.parse(sharedSecrets.get(`${TOKEN_SECRET_PREFIX}workspace-a`)), {
    serverUrl: "http://workspace-a.example/magic/web",
    token: "token-a"
  });
  assert.deepStrictEqual(JSON.parse(sharedSecrets.get(`${TOKEN_SECRET_PREFIX}workspace-b`)), {
    serverUrl: DEFAULT_SERVER_URL,
    token: "token-b"
  });
  assert.strictEqual(await storeA.getToken(), "token-a");
  assert.strictEqual(await storeB.getToken(), "token-b");
  await storeA.clearToken();
  assert.strictEqual(await storeA.getToken(), undefined);
  assert.strictEqual(await storeB.getToken(), "token-b", "clearing one workspace must not affect another");

  const client = new MagicApiClient(workspaceA.context, { appendLine() {} }, vscodeA.vscode, storeA);
  client.request = async (method, requestPath, body) => {
    assert.strictEqual(method, "POST");
    assert.strictEqual(requestPath, "/login");
    assert(body.includes("username=alice"));
    assert(body.includes("password=one-time-password"));
    return {
      text: JSON.stringify({ code: 1, data: true }),
      headers: { "magic-token": "login-token-a" }
    };
  };
  await client.login("alice", "one-time-password");
  assert.strictEqual(await client.getUsername(), "alice");
  assert.strictEqual(await storeA.getToken(), "login-token-a");
  const persistedValues = [
    ...workspaceA.state.values(),
    ...sharedSecrets.values()
  ].map(String);
  assert(!persistedValues.some((value) => value.includes("one-time-password")), "password must not be persisted");
  client.getJsonBean = async (method, requestPath, body, headers) => {
    assert.strictEqual(method, "POST");
    assert.strictEqual(requestPath, "/resource/folder/save");
    assert.deepStrictEqual(JSON.parse(body), {
      name: "admin",
      path: "admin",
      type: "api",
      parentId: "0"
    });
    assert.strictEqual(headers["content-type"], "application/json;charset=utf-8");
    return "group-admin";
  };
  assert.strictEqual(await client.saveGroup({ name: "admin", path: "admin", type: "api", parentId: "0" }), "group-admin");
  await storeA.setServerUrl("http://workspace-a-next.example/magic/web");
  assert.strictEqual(await storeA.getToken(), undefined, "token must not cross serverUrl changes");
  assert.strictEqual(await storeA.getUsername(), "", "username must not cross serverUrl changes");

  const failed = createContext(sharedSecrets, { "magicApi.connection.workspaceId": "workspace-failed" });
  const failedVscode = createVscode({ folders: ["/workspace/failed"] });
  const failedStore = new WorkspaceConnectionStore(failed.context, failedVscode.vscode);
  const failedClient = new MagicApiClient(failed.context, { appendLine() {} }, failedVscode.vscode, failedStore);
  failedClient.request = async () => ({
    text: JSON.stringify({ code: -10, data: false, message: "denied" }),
    headers: {}
  });
  await assert.rejects(() => failedClient.login("should-not-save", "temporary"), /denied/);
  assert.strictEqual(await failedStore.getUsername(), "");
  assert.strictEqual(await failedStore.getToken(), undefined);

  const empty = createContext(sharedSecrets);
  const emptyVscode = createVscode({ folders: [] });
  const emptyStore = new WorkspaceConnectionStore(empty.context, emptyVscode.vscode);
  assert.throws(() => emptyStore.getServerUrl(), /请先打开一个 VS Code 工作区/);
  await assert.rejects(() => emptyStore.getToken(), /请先打开一个 VS Code 工作区/);

  const packageJson = require(path.resolve(__dirname, "..", "package.json"));
  const properties = packageJson.contributes.configuration.properties;
  assert.strictEqual(properties["magicApi.serverUrl"].scope, "window");
  assert.strictEqual(properties["magicApi.workspaceDir"].scope, "window");
  ["syncOnSave", "autoPullOnOpen", "checkConflicts"].forEach((key) => {
    assert.strictEqual(properties[`magicApi.${key}`].scope, "resource");
  });

  process.stdout.write("workspace connection tests passed\n");
}

function createContext(sharedSecrets, initialState = {}) {
  const state = new Map(Object.entries(initialState));
  return {
    state,
    context: {
      workspaceState: {
        get(key, fallback) {
          return state.has(key) ? state.get(key) : fallback;
        },
        async update(key, value) {
          state.set(key, value);
        }
      },
      secrets: {
        async get(key) {
          return sharedSecrets.get(key);
        },
        async store(key, value) {
          sharedSecrets.set(key, value);
        },
        async delete(key) {
          sharedSecrets.delete(key);
        }
      }
    }
  };
}

function createVscode(options = {}) {
  const workspaceValues = Object.assign({}, options.workspaceValues);
  const globalValues = Object.assign({}, options.globalValues);
  const defaults = {
    serverUrl: DEFAULT_SERVER_URL,
    workspaceDir: DEFAULT_WORKSPACE_DIR
  };
  const updates = [];
  return {
    updates,
    vscode: {
      ConfigurationTarget: { Global: 1, Workspace: 2, WorkspaceFolder: 3 },
      workspace: {
        workspaceFolders: (options.folders || []).map((fsPath, index) => ({
          name: `workspace-${index}`,
          uri: { fsPath }
        })),
        getConfiguration() {
          return {
            get(key, fallback) {
              if (workspaceValues[key] !== undefined) {
                return workspaceValues[key];
              }
              if (globalValues[key] !== undefined) {
                return globalValues[key];
              }
              return defaults[key] === undefined ? fallback : defaults[key];
            },
            inspect(key) {
              return {
                defaultValue: defaults[key],
                globalValue: globalValues[key],
                workspaceValue: workspaceValues[key]
              };
            },
            async update(key, value, target) {
              updates.push({ key, value, target });
              if (target === 2) {
                workspaceValues[key] = value;
              }
            }
          };
        }
      }
    }
  };
}
