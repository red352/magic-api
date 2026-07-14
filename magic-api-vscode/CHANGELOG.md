# Changelog

## 1.2.0

- 新增统一零依赖 Node.js CLI，覆盖工作区连接、认证状态、本地资源与嵌套分组 CRUD、校验、拉取、推送、自动 reconcile、journal 恢复、实际接口请求和 AI Skill 管理。
- 新增绑定工作区文件状态、服务地址和操作参数的一次性计划协议；CLI 可自动执行明确计划中的远端删除和冲突覆盖，无法唯一复核时返回结构化阻塞信息。
- 将 AI 请求桥扩展为工作区控制桥，继续由扩展读取当前工作区 SecretStorage Token，CLI 与日志均不可见凭据。
- `magic-api-workspace` Skill 改为自动计划、apply、同步和 canonical 核对流程，不再要求用户手动点击推送或增量同步。
- 新增 command schema 驱动的 CLI 文档检查和 Skill 托管清单；未修改的已安装 Skill 可安全自动更新，旧安装或人工修改版本会保留。

## 1.1.1

- 修复从远端初始化后，历史 Task、Function、Script 等资源 path 带前导斜杠时被批量推送预检误判为“不规范”的问题；等价 path 现在使用统一语义身份参与幂等比较。
- 修复只修改资源名称等非 path 字段时意外重写远端历史 path 的问题；只有显式修改 path 时才写入本地规范形式。
- 为 `magic-api-workspace` Skill 新增实际接口请求 CLI，通过当前工作区的 VS Code 扩展桥接读取服务地址和 SecretStorage Token，并使用 lowercase `magic-token` 请求头，避免凭据进入命令、环境变量或工作区文件。
- 增加请求同源校验、控制台只读白名单、响应大小与超时限制，以及敏感响应头隐藏；服务端写操作仍由扩展 journal 和确认流程管理。
- 修复 AI 沙箱无法读取扩展桥接时缺少恢复路径的问题；Skill 会申请最小范围的宿主机执行授权重试同一命令，不使用 `sudo`、root 或宽泛命令授权。

## 1.1.0

- 本地镜像升级为 manifest v3，脚本资源使用同目录 `.ms + .magic.json` 资源对，并记录离线分组计划与分组新增 journal。
- 支持发现并新增本地资源，服务端生成 canonical ID 后再写入 manifest。
- 支持批量确认删除本地缺失资源，并仅在详情接口明确确认不存在后清理 manifest。
- 资源管理器始终显示空的 API、Functions、Tasks 根节点，增加顶部新增按钮、本地待同步分组/资源标记和文件右键删除资源。
- API、Function、Task 与动态 Script 新增表单拆分嵌套分组路径、资源名称和资源 path；Explorer 新增改为离线暂存后统一推送。
- 批量推送按父分组、子分组、资源依赖顺序同步，支持响应丢失恢复和插件侧幂等复用。
- 新增扩展与 `magic-api-workspace` Skill 共用的零依赖 Node.js CRUD/校验核心及预览优先 CLI。
- 新增未知分组、服务器不匹配、元数据损坏、疑似移动/重命名和符号链接保护。
- 新增远端写操作前 journal、分组/资源响应丢失恢复、重复 create no-op 和 create/delete 混合批次阻断。
- 服务地址、镜像目录、用户名和 Token 改为工作区隔离；密码不持久化，历史全局连接与 Token 不再读取。
- 新增 `magic-api-workspace` AI Skill，定义工作区增删查改与完成验证规则。
- AI Skills 安装命令改为安装扩展内全部内置 skills。

## 0.1.0

- 首版发布。
- 支持连接 magic-api Web 工作台、登录、浏览资源树和同步本地工作区。
- 支持 magic-script 语法高亮、补全、悬停文档和格式化。
- 支持运行当前 API、编辑资源信息，以及安装内置 `magic-script` AI Skill 到当前工作区。
