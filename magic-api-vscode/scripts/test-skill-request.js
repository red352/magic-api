"use strict";

const assert = require("assert");
const fs = require("fs");
const http = require("http");
const os = require("os");
const path = require("path");
const { spawn } = require("child_process");
const { MagicApiClient } = require("../src/client");
const { SkillRequestBridge } = require("../src/skillRequestBridge");

run().then(() => {
  process.stdout.write("skill request tests passed\n");
}).catch((error) => {
  process.stderr.write(`${error.stack || error}\n`);
  process.exit(1);
});

async function run() {
  const requests = [];
  const server = http.createServer((request, response) => {
    const chunks = [];
    request.on("data", (chunk) => chunks.push(chunk));
    request.on("end", () => {
      requests.push({
        method: request.method,
        url: request.url,
        headers: request.headers,
        rawHeaders: request.rawHeaders,
        body: Buffer.concat(chunks).toString("utf8")
      });
      response.setHeader("content-type", "application/json");
      response.setHeader("Magic-Token", "rotated-secret");
      response.end(JSON.stringify({ code: 1, data: { received: true } }));
    });
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  const root = await fs.promises.mkdtemp(path.join(os.tmpdir(), "magic-api-request-"));
  const cli = path.resolve(__dirname, "../ai-skills/magic-api-workspace/scripts/magic-api-request.js");
  let bridge;
  try {
    await fs.promises.mkdir(path.join(root, ".magic-api"), { recursive: true });
    await fs.promises.writeFile(path.join(root, ".magic-api/manifest.json"), `${JSON.stringify({
      version: 3,
      generatedAt: Date.now(),
      serverUrl: `http://127.0.0.1:${address.port}/magic/web`,
      entries: [],
      groups: [],
      pendingCreates: [],
      pendingCreateRequests: [],
      pendingDeletes: [],
      localGroups: [],
      pendingGroupCreateRequests: [],
      pendingGroupCreates: []
    }, null, 2)}\n`, "utf8");
    const connectionStore = {
      hasWorkspace() {
        return true;
      },
      getServerUrl() {
        return `http://127.0.0.1:${address.port}/magic/web`;
      },
      async getToken() {
        return "workspace-secret";
      }
    };
    const client = new MagicApiClient({}, { appendLine() {} }, {}, connectionStore);
    bridge = new SkillRequestBridge({
      client,
      output: { appendLine() {} },
      resolveRoot: async () => root
    });
    const descriptor = await bridge.refresh();
    assert.strictEqual(descriptor.requestBaseUrl, `http://127.0.0.1:${address.port}`);
    assert.ok(!JSON.stringify(descriptor).includes("workspace-secret"));

    const preview = await runCli(cli, [
      "--root", root, "--console-path", "/resource", "--method", "POST"
    ]);
    assert.strictEqual(preview.code, 0, preview.stderr);
    assert.strictEqual(JSON.parse(preview.stdout).sent, false);
    assert.strictEqual(JSON.parse(preview.stdout).connection, "vscode-workspace");
    assert.strictEqual(JSON.parse(preview.stdout).authentication, "vscode-secret-storage:magic-token");
    assert.strictEqual(JSON.parse(preview.stdout).requestBaseUrl, `http://127.0.0.1:${address.port}`);
    assert.strictEqual(requests.length, 0);

    const sent = await runCli(cli, [
      "--root", root, "--console-path", "/resource", "--method", "POST", "--send"
    ], { MAGIC_API_TOKEN: "wrong-global-token" });
    assert.strictEqual(sent.code, 0, sent.stderr);
    const sentResult = JSON.parse(sent.stdout);
    assert.strictEqual(sentResult.statusCode, 200);
    assert.strictEqual(sentResult.headers["magic-token"], "[REDACTED]");
    assert.strictEqual(requests.length, 1);
    assert.strictEqual(requests[0].url, "/magic/web/resource");
    assert.strictEqual(requests[0].headers["magic-token"], "workspace-secret");
    const tokenHeaderIndex = requests[0].rawHeaders.indexOf("magic-token");
    assert.ok(tokenHeaderIndex >= 0, `expected lowercase magic-token in ${requests[0].rawHeaders}`);
    assert.strictEqual(requests[0].rawHeaders[tokenHeaderIndex + 1], "workspace-secret");

    const bodyFile = path.join(root, "request-body.json");
    await fs.promises.writeFile(bodyFile, JSON.stringify({ ping: true }), "utf8");
    const apiResult = await runCli(cli, [
      "--root", root, "--url", `/api/ping?source=skill`, "--method", "POST",
      "--body-file", bodyFile, "--send"
    ]);
    assert.strictEqual(apiResult.code, 0, apiResult.stderr);
    assert.strictEqual(requests[1].url, "/api/ping?source=skill");
    assert.strictEqual(requests[1].headers["magic-token"], "workspace-secret");
    assert.strictEqual(requests[1].body, JSON.stringify({ ping: true }));

    const stdinTokenResult = await runCli(cli, [
      "--root", root, "--url", "/api/stdin-token", "--direct", "--token-stdin", "--send"
    ], {}, "one-shot-secret\n");
    assert.strictEqual(stdinTokenResult.code, 0, stdinTokenResult.stderr);
    assert.strictEqual(requests[2].headers["magic-token"], "one-shot-secret");

    const forbiddenMutation = await runCli(cli, [
      "--root", root, "--console-path", "/resource/delete", "--method", "POST", "--send"
    ], { MAGIC_API_TOKEN: "workspace-secret" });
    assert.strictEqual(forbiddenMutation.code, 1);
    assert.match(forbiddenMutation.stderr, /只读白名单/);

    const bypass = await runCli(cli, [
      "--root", root, "--url", `http://127.0.0.1:${address.port}/magic/web/resource`, "--method", "POST"
    ]);
    assert.strictEqual(bypass.code, 1);
    assert.match(bypass.stderr, /只能通过 --console-path/);

    const headersFile = path.join(root, "headers.json");
    await fs.promises.writeFile(headersFile, JSON.stringify({ "magic-token": "leaked" }), "utf8");
    const unsafeHeaders = await runCli(cli, [
      "--root", root, "--url", "/api/ping", "--headers-file", headersFile
    ], { MAGIC_API_TOKEN: "workspace-secret" });
    assert.strictEqual(unsafeHeaders.code, 1);
    assert.match(unsafeHeaders.stderr, /禁止的请求头：magic-token/);
  } finally {
    if (bridge) {
      await bridge.stop();
    }
    await fs.promises.rm(root, { recursive: true, force: true });
    await new Promise((resolve) => server.close(resolve));
  }
}

function runCli(cli, args, extraEnv = {}, stdin = undefined) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [cli, ...args], {
      env: Object.assign({}, process.env, extraEnv),
      stdio: [stdin === undefined ? "ignore" : "pipe", "pipe", "pipe"]
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => { stdout += chunk; });
    child.stderr.on("data", (chunk) => { stderr += chunk; });
    child.on("error", reject);
    child.on("close", (code) => resolve({ code, stdout, stderr }));
    if (stdin !== undefined) {
      child.stdin.end(stdin);
    }
  });
}
