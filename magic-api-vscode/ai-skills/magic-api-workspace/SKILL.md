---
name: magic-api-workspace
description: Safely inspect, create, update, delete, validate, and synchronize magic-api resources and nested groups through the workspace-scoped local mirror, and make controlled requests through the current VS Code workspace plugin connection and SecretStorage identity, including sandboxed agents that must request host execution. Use for magic-api 工作区增删查改, 离线嵌套分组, API/function/task/script resources, `.magic-api-workspace`, manifest v3, `.ms + .magic.json` pairs, datasource JSON, journal recovery, pushing local changes, console inspection with `magic-token`, testing deployed APIs, or sandbox access failures around the plugin bridge.
---

# Magic API Workspace

## 强制流程

1. 定位当前 VS Code 工作区的 `magicApi.workspaceDir`，默认是 `.magic-api-workspace`。禁止复用其他工作区的连接、用户名、Token、manifest 或 pending 状态。
2. 使用本 Skill 的 `scripts/magic-api-workspace.js` 查询和修改镜像。不要手工创建、删除或拼接 `.ms/.magic.json`，不要手工修改 manifest。
3. 所有写操作先不带 `--apply` 预览 JSON；核对本地引用、groupPath、path、localGroups 和 files 后，再用同一命令增加 `--apply`。
4. 写入后执行 `validate`，再由扩展执行 `magic-api: 推送本地全部变更` 和 `magic-api: 增量同步本地工作区`。
5. 服务端验证完成前只报告“本地待同步”。AI 不得替用户确认不可撤销的服务端删除、清除结果未知的新增请求或自动重试未知请求。

CLI 路径通常为：

```bash
node .codex/skills/magic-api-workspace/scripts/magic-api-workspace.js <command> --root <mirror-root>
```

如果 Skill 从其他位置加载，使用当前 Skill 目录中的同名脚本。本地操作 CLI 只读写镜像，不读取 SecretStorage、Token 或密码；服务端访问必须使用下述独立请求脚本。

## 查询与校验

```bash
node .codex/skills/magic-api-workspace/scripts/magic-api-workspace.js status --root <mirror-root>
node .codex/skills/magic-api-workspace/scripts/magic-api-workspace.js groups --root <mirror-root> --type api
node .codex/skills/magic-api-workspace/scripts/magic-api-workspace.js list --root <mirror-root> --type function
node .codex/skills/magic-api-workspace/scripts/magic-api-workspace.js get --root <mirror-root> --id <resource-id>
node .codex/skills/magic-api-workspace/scripts/magic-api-workspace.js validate --root <mirror-root>
```

- 已同步资源以 manifest 的稳定 ID 为准；未同步资源使用 CLI 返回的 `local:<hash>` 引用。不要自行猜 ID、groupId 或本地引用。
- `groups` 同时返回 `state=remote` 与 `state=local`；`localGroups` 是合法待同步计划，`pendingGroupCreateRequests/pendingGroupCreates` 才是必须先恢复的阻塞状态。
- 查询脚本资源时把 `.ms` 与 `.magic.json` 视为一个资源；datasource 是单个 `.json`。
- `validate` 失败时停止推送，修复其 JSON 输出列出的具体错误。

## 新增

把分组路径与资源 path 分开。缺失分组先预览或暂存：

```bash
node .codex/skills/magic-api-workspace/scripts/magic-api-workspace.js ensure-group \
  --root <mirror-root> --type api --group-path admin/user
```

`group-path` 使用 `admin/user`，每段默认同时作为分组 name 和 path；已有层级会复用。`script` 只有在服务端镜像中实际出现过该动态类型时才允许创建。

```bash
node .codex/skills/magic-api-workspace/scripts/magic-api-workspace.js create \
  --root <mirror-root> --type api --group-path admin/user \
  --name UserDetail --path /users/profile/detail --method GET \
  --script-file /tmp/user-detail.ms
```

核对预览后追加 `--apply`。已有分组也可改用 `--group-id`，但不能与 `--group-path` 同时使用。Function 使用 `--type function`；Task 另传 `--cron` 和可选 `--enabled true|false`；Script 使用 `--type script --script-file`。Component 与 Datasource 保持兼容；Datasource 使用已发现的根 groupId 及 `--key --url`。

- name 必须符合服务端文件名规则，不能包含空格、路径分隔符或 `.ms/.json` 后缀。
- `group-path` 决定真实嵌套分组和本地目录；资源 `--path` 仍是路由/调用路径。API path 规范为 `/a/b/c`，Function、Task、Script、Component 规范为 `a/b/c`。
- API 默认 GET 和空 parameters/headers/options/paths；Function 默认空 parameters；Task 默认 cron `0 0/5 * * * ?` 且禁用。
- 新资源禁止包含 id、groupId、时间、用户、锁、hash 等服务端字段。CLI 会创建完整资源对并拒绝未知或歧义分组。
- 重复执行完全相同的 create 返回 `noOp=true`；相同分组、name、path/key 但内容不同会拒绝，必须使用 update。

## 修改

```bash
node .codex/skills/magic-api-workspace/scripts/magic-api-workspace.js update \
  --root <mirror-root> --id <resource-id-or-local-ref> \
  --name RenamedResource --path nested/new/path \
  --script-file /tmp/updated.ms
```

- 修改 name 只更新 metadata，不移动本地文件。
- 用 `--metadata-patch <json-file>` 修改高级字段；CLI 会合并现有完整 metadata，保留未知字段，并拒绝 id/groupId 等服务端字段。
- 保存接口是完整对象覆盖，不是 PATCH；不要用手写稀疏 sidecar 覆盖资源。
- 编辑 magic-script 正文时同时遵循 `$magic-script`。

## 删除

```bash
node .codex/skills/magic-api-workspace/scripts/magic-api-workspace.js delete \
  --root <mirror-root> --id <resource-id-or-local-ref>
```

仅在用户明确指定删除后追加 `--apply`。CLI 只删除该 ID/本地引用对应的完整资源对，不删除目录或分组。随后由扩展批量推送并由用户亲自确认“删除服务端资源”。详情接口未明确返回不存在时，保留 pendingDeletes，不能声称删除成功。

## 请求实际接口

使用 `scripts/magic-api-request.js`，所有请求默认只输出 JSON 预览，追加 `--send` 才会发送。脚本从当前镜像 manifest 读取服务地址，只允许请求同源地址。

控制台查询使用 `--console-path`。请求头必须由脚本以 lowercase `magic-token` 注入；不要在 `--headers-file`、命令参数、工作区文件或日志中写 Token：

```bash
node .codex/skills/magic-api-workspace/scripts/magic-api-request.js \
  --root <mirror-root> --console-path /resource --method POST
```

默认使用当前 VS Code 工作区的插件请求桥接：扩展从该工作区的 SecretStorage 读取 Token，并以 `magic-token` 请求头发送；Skill 和 CLI 都看不到 Token。保持 VS Code 扩展运行并完成当前工作区登录，确认预览中的 `connection=vscode-workspace` 后再追加 `--send`。桥接不可用时停止并提示用户打开对应工作区，不要复制其他工作区 Token。

控制台只允许读取 `/config.json`、`/resource`、`/resource/file/{id}`、`/classes`、`/classes.txt`、`/class`、`/user`、`/plugins` 和 `/options`。禁止通过请求脚本调用登录、保存、删除、分组写入或 reload；这些状态变更继续交给扩展的工作区隔离连接和 journal 流程。

调用已部署的业务 API 时优先使用以 `/` 开头的应用路径。请求域名自动读取插件当前工作区的 `magicApi.serverUrl` 并去掉控制台 path；例如 `http://localhost:9999/magic/web` 的请求基址为 `http://localhost:9999`。也可使用同源绝对 URL：

```bash
node .codex/skills/magic-api-workspace/scripts/magic-api-request.js \
  --root <mirror-root> --url /api/users \
  --method POST --headers-file /tmp/request-headers.json \
  --body-file /tmp/request-body.json
```

- 实际业务请求默认也携带 `magic-token`；公开接口明确不需要控制台身份时才使用 `--no-token`。
- 只有没有运行 VS Code 扩展的明确 headless 场景才使用 `--direct`，此时 Token 仅允许通过 `--token-stdin` 或已存在的 `--token-env <name>` 临时提供；不得把 Token 值写进命令。
- GET 等只读请求也先预览。POST、PUT、PATCH、DELETE 等可能产生业务副作用的请求，必须获得用户对具体 URL、method 和 body 的明确授权后才能追加 `--send`。
- 响应会返回状态码、耗时、响应头和正文；`magic-token`、Cookie、Authorization 等敏感响应头会被隐藏。不要把包含密钥或个人数据的响应原样写入仓库。
- 请求失败只报告实际 HTTP/网络结果，不修改 manifest，也不自动重试非幂等请求。

## 沙箱与宿主机执行

- 先在当前沙箱运行不带 `--send` 的预览。若显示 `connection=vscode-workspace-unavailable`，或出现 `EACCES`、`EPERM`、无法读取系统临时目录、无法连接本机插件桥接等沙箱限制，不要改用其他工作区 Token，也不要把扩展或桥接文件复制进沙箱。
- 把上述沙箱错误视为应自动申请宿主机执行的信号：使用运行环境提供的提权/沙箱外执行机制，原样重跑同一个 `node .../magic-api-request.js` 命令。在支持该参数的 Codex 环境中使用 `sandbox_permissions=require_escalated`，理由说明为“读取当前用户临时目录中的 VS Code magic-api 工作区桥接并执行同源请求”。
- “提权”仅指越过 AI 文件/网络沙箱访问当前用户的 VS Code 扩展，不得使用 `sudo`、root、宽泛 shell 前缀或持久化授权。只提升请求 CLI 本身及其当前 `--root`、URL、method 和 body。
- 若运行环境可自动批准则继续；若平台要求用户审批则只发起一次最小权限申请。Skill 指令不能绕过平台审批或把拒绝视为授权。
- 获得宿主机执行能力后仍遵守预览、同源限制、控制台只读白名单和非幂等请求的明确授权规则。不得因为沙箱提权而追加 `--send` 或扩大请求范围。

## 安全边界

- pendingCreateRequests、pendingCreates、pendingDeletes、pendingGroupCreateRequests 或 pendingGroupCreates 非空时停止本地写操作，先由扩展恢复。
- 同一待推送状态不能同时包含新增和删除；移动和本地文件重命名仍不支持。
- 只允许新增分组；禁止 AI 删除、移动或重命名分组。
- 拒绝 serverUrl 不一致、路径穿越、符号链接、不完整资源对和歧义分组。
- 密码和 Token 不得写入工作区、日志或命令。默认请求由扩展读取工作区专用 SecretStorage；临时桥接描述文件不包含控制台 Token，并按镜像根目录和当前系统用户隔离。无扩展的 direct 模式只能临时读取环境变量或标准输入。
