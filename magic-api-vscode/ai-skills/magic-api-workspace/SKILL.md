---
name: magic-api-workspace
description: Safely inspect, create, update, delete, validate, and synchronize magic-api resources and nested groups through the workspace-scoped local mirror and bundled deterministic Node.js CLI. Use for magic-api 工作区增删查改, 离线嵌套分组, API/function/task/script resources, `.magic-api-workspace`, manifest v3, `.ms + .magic.json` pairs, datasource JSON, journal recovery, or pushing local changes.
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

如果 Skill 从其他位置加载，使用当前 Skill 目录中的同名脚本。CLI 只读写本地镜像，不读取 SecretStorage、Token 或密码，也不直接访问服务端。

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

## 安全边界

- pendingCreateRequests、pendingCreates、pendingDeletes、pendingGroupCreateRequests 或 pendingGroupCreates 非空时停止本地写操作，先由扩展恢复。
- 同一待推送状态不能同时包含新增和删除；移动和本地文件重命名仍不支持。
- 只允许新增分组；禁止 AI 删除、移动或重命名分组。
- 拒绝 serverUrl 不一致、路径穿越、符号链接、不完整资源对和歧义分组。
- 密码不得写入文件、日志或命令；Token 只能由扩展的工作区专用 SecretStorage 管理。
