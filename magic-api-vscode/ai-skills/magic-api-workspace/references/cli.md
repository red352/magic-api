# CLI Reference

Schema version: 1

所有命令使用统一入口：

```bash
node .codex/skills/magic-api-workspace/scripts/magic-api.js <domain> <action> --root <mirror-root>
```

读取命令直接执行。变更命令默认只生成五分钟有效、单次使用的计划；使用返回的 `planId` 原样追加 `--apply --plan-id <id>`。

| 命令 | 风险 | 执行位置 | 说明 | 主要参数 |
| --- | --- | --- | --- | --- |
| `connection show` | 只读 | 插件桥 | 读取当前工作区连接与行为配置。 | - |
| `connection set` | 写入 | 插件桥 | 修改当前工作区连接或行为配置。 | `--server-url` `--workspace-dir` `--sync-on-save` `--auto-pull-on-open` `--check-conflicts` |
| `auth status` | 只读 | 插件桥 | 读取当前工作区认证状态，不返回 Token。 | - |
| `auth login` | 写入 | 插件桥 | 在 VS Code 中打开用户名和密码输入框并登录。 | - |
| `auth set-token` | 写入 | 插件桥 | 在 VS Code 中打开 Magic-Token 安全输入框。 | - |
| `auth clear` | 危险 | 插件桥 | 清除当前工作区登录状态。 | - |
| `workspace status` | 只读 | 本地 | 读取本地镜像、journal 和文件变更状态。 | - |
| `workspace validate` | 只读 | 本地 | 校验 manifest、资源对、路径和待同步状态。 | - |
| `workspace pull` | 写入 | 插件桥 | 从服务端增量或全量拉取工作区。 | `--mode incremental|full` |
| `workspace push` | 写入 | 插件桥 | 推送当前文件或全部本地变更。 | `--file` |
| `workspace reconcile` | 危险 | 插件桥 | 自动恢复、推送、reload 并增量拉取 canonical 数据。 | - |
| `workspace recover` | 写入 | 插件桥 | 自动恢复能够唯一确认的新增和删除 journal。 | - |
| `group list` | 只读 | 本地 | 列出远端与离线嵌套分组。 | `--type` |
| `group ensure` | 写入 | 本地 | 复用或暂存嵌套分组。 | `--type` `--group-path` `--sync` |
| `resource tree` | 只读 | 插件桥 | 读取服务端资源树。 | - |
| `resource list` | 只读 | 本地 | 列出本地已管理和待同步资源。 | `--type` |
| `resource get` | 只读 | 本地 | 按稳定资源 ID 或本地引用读取完整资源。 | `--id` |
| `resource create` | 写入 | 本地 | 创建本地资源对并可自动同步。 | `--type` `--group-id|--group-path` `--name` `--path` `--method` `--cron` `--enabled` `--key` `--url` `--script-file` `--metadata-patch` `--sync` |
| `resource update` | 写入 | 本地 | 修改资源正文或合并 metadata。 | `--id` `--name` `--path` `--method` `--cron` `--enabled` `--script-file` `--metadata-patch` `--sync` |
| `resource delete` | 危险 | 本地 | 按稳定资源 ID 删除本地资源对并可自动同步远端删除。 | `--id` `--sync` |
| `request preview` | 只读 | 混合 | 预览同源控制台或业务接口请求。 | `--console-path|--url` `--method` `--headers-file` `--body-file` `--timeout-ms` `--no-token` `--direct` `--token-env` `--token-stdin` |
| `request send` | 危险 | 混合 | 发送同源控制台或业务接口请求。 | `--console-path|--url` `--method` `--headers-file` `--body-file` `--timeout-ms` `--no-token` `--direct` `--token-env` `--token-stdin` |
| `skill status` | 只读 | 插件桥 | 检查当前工作区内置 Skills 的版本和漂移。 | - |
| `skill install` | 写入 | 插件桥 | 安装当前扩展内置 Skills。 | - |
| `skill update` | 写入 | 插件桥 | 安全更新未被人工修改的内置 Skills。 | `--force` |

## 自动同步

单个资源或分组变更优先增加 `--sync`。apply 后 CLI 会自动调用工作区控制桥完成恢复、校验、推送、reload 和增量拉取。批量编辑完成后使用 `workspace reconcile` 的计划/apply 流程。

## 连接与认证

`connection`、`auth`、远端 `workspace`、`resource tree` 和 `skill` 命令要求当前 VS Code 工作区扩展正在运行。Token 只由扩展从 SecretStorage 读取；CLI 只返回 `authenticated`，不会返回 Token。

## 请求

`request preview` 和 `request send` 继续执行同源校验。控制台端点保持只读白名单，业务请求使用当前工作区请求域名并由扩展注入 lowercase `magic-token`。

## 退出码

- `0`：成功或计划生成成功。
- `1`：参数、连接或执行错误。
- `2`：`workspace validate` 发现校验错误。
- `3`：请求已发送，但目标服务返回 HTTP 4xx/5xx。
- `4`：远端状态无法唯一复核，返回结构化 `blocked`。
