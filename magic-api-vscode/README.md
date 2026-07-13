# magic-api

在 Visual Studio Code 中编辑、同步和运行 magic-api 工作台资源。

此扩展连接到已有的 magic-api Web 工作台接口，不替换 magic-api 后端，也不直接读取数据库。安装后可以在 VS Code 资源管理器中浏览 API、函数、数据源、任务和组件，把服务端资源同步到本地工作区，并用 `.ms` 文件获得 magic-script 的补全、悬停文档、格式化和运行入口。

## 功能

- 连接 magic-api Web 工作台地址，例如 `http://localhost:9999/magic/web`。
- 通过 magic-api `/login` 接口登录，并按当前 VS Code 工作区隔离保存用户名和 `Magic-Token`；密码不会持久化。
- 在资源管理器中展示 magic-api 资源树。
- 把 API、函数等脚本资源同步为本地 `.ms` 文件，便于搜索、批量编辑、版本管理和 AI 工具读取上下文。
- 保存本地镜像文件时自动推送到 magic-api 服务端，并刷新服务端缓存。
- 支持增量同步、全量重新拉取、推送当前文件和推送全部本地变更。
- 支持从本地镜像新增资源，以及在明确确认后同步删除服务端资源。
- API、Function、Task 以及服务端动态提供的 Script 支持分别配置嵌套分组、资源名称和资源 path。
- 内置零依赖 Node.js 工作区操作层，扩展和 AI Skill 共用同一套增删查改及格式校验规则。
- 提供 magic-script 语法高亮、代码补全、悬停文档和保守格式化。
- 从服务端 `/classes`、`/classes.txt`、`/class` 接口读取运行时类、函数、扩展方法和模块信息，增强补全内容。
- 通过内置 REST 面板运行当前 API，并查看响应状态、响应头和响应体。
- 编辑 API、函数等资源的元数据。

## 安装

从 Marketplace 安装时，在 VS Code 扩展视图中搜索 `magic-api`，选择发布者为 `reddog` 的扩展并安装。

如果拿到的是 `.vsix` 文件，可以使用以下任一方式安装：

```bash
code --install-extension magic-api-vscode-<version>.vsix
```

或在 VS Code 中执行 `Extensions: Install from VSIX...`，选择对应的 `.vsix` 文件。

扩展 ID 为：

```text
reddog.magic-api-vscode
```

## 连接 magic-api

1. 执行命令 `magic-api: 配置服务地址`。
2. 填入 magic-api Web 工作台地址，例如 `http://localhost:9999/magic/web`。
3. 执行命令 `magic-api: 登录`。
4. 输入 Web 工作台使用的账号和密码。
5. 登录成功后，在资源管理器中打开 `magic-api` 视图。

服务地址、镜像目录、用户名和登录状态都按当前 VS Code 工作区隔离。单目录工作区的地址写入 `.vscode/settings.json`，多根工作区写入对应 `.code-workspace`；一个 VS Code 工作区只连接一个 magic-api 服务。Token 由 SecretStorage 安全保存并使用工作区专用 key，密码仅用于当次登录请求。

从旧版本升级后，历史全局 `magicApi.serverUrl` 和全局 `magic-api.token` 不会自动迁移、读取或删除。请在每个工作区重新执行“配置服务地址”并登录，避免把其他项目的连接或身份带入当前工作区。

如果已经在浏览器中登录 Web 工作台，VS Code 扩展不能自动读取浏览器的 localStorage、Cookie 或响应头。可以从浏览器开发者工具中复制 `magic-token`，然后在 VS Code 执行 `magic-api: 手动设置 Magic-Token`。

## 常用命令

- `magic-api: 配置服务地址`
- `magic-api: 登录`
- `magic-api: 手动设置 Magic-Token`
- `magic-api: 清除登录状态`
- `magic-api: 刷新资源`
- `magic-api: 增量同步本地工作区`
- `magic-api: 全量重新拉取本地工作区`
- `magic-api: 推送当前本地文件`
- `magic-api: 推送本地全部变更`
- `magic-api: 新增资源`（资源树顶部按钮，或分组/类型根节点右键）
- `magic-api: 删除资源`（资源树文件右键）
- `magic-api: 处理结果未知的新增请求`
- `magic-api: 编辑资源信息`
- `magic-api: 查看当前资源元数据`
- `magic-api: 运行当前 API`
- `magic-api: 安装 AI Skills 到工作区`
- `magic-api: 打开 Web 工作台`

## 本地镜像工作区

扩展会把服务端资源同步到本地镜像目录，默认路径为当前 VS Code 工作区下的 `.magic-api-workspace`。

```text
.magic-api-workspace/
  .magic-api/
    manifest.json
    server.json
    groups/
  api/
    user/
      list.ms
      list.magic.json
  function/
    common/
      format.ms
      format.magic.json
  datasource/
    default.json
```

脚本类资源由同目录、同 basename 的两个文件组成：`.ms` 保存脚本，`.magic.json` 保存 method、path、headers、parameters、服务端 ID 等元数据。可以直接编辑 `.magic.json`，也可以通过 `magic-api: 编辑资源信息` 修改。

数据源等非脚本资源保存为单个 `.json` 文件。manifest v3 记录本地文件、服务端资源 ID、服务端更新时间、本地 hash、目录到服务端分组的映射，以及离线分组计划和恢复 journal，用于增量同步、幂等增删改推送和冲突检查。

资源树同时提供导航和文件级增删入口。打开资源时，扩展会优先打开本地镜像文件；保存 manifest 已管理的本地资源时，如果 `magicApi.syncOnSave` 开启，会自动推送修改。未加入 manifest 的新资源不会在保存时自动创建，必须执行批量推送完成统一预检，或在资源树分组上右键执行 `magic-api: 新增资源`。

资源树始终显示 API、Functions、Tasks，即使服务端尚无任何对应分组或资源；动态 Script、Component、Datasource 仍以服务端已发现类型为准。资源树顶部的加号不依赖现有节点，根节点和分组右键也可新增。新增只写本地并标记“待同步”，删除仍会检查稳定文件 ID、远端冲突，要求用户模态确认，并在详情接口明确返回不存在后才完成。

### 新增资源

点击资源树顶部加号，或在类型根节点/具体分组上右键选择 `新增资源`。API、Functions、Tasks 即使为空也可进入表单；Scripts 只有服务端资源树实际返回 `script` 类型时才出现。表单把“目标分组路径”和“资源 path”分开，API 另选 method，Task 另填 cron。插件只生成本地计划和资源文件，随后统一执行 `magic-api: 推送本地全部变更`。

分组路径如 `admin/user` 会复用已有层级，并依次暂存缺失的 `admin`、`user` 分组；每段默认同时作为分组 name 和 path。分组路径决定真实本地目录。资源 path 仍是路由/调用路径：API 保存为 `/a/b/c`，Function、Task、Script、Component 保存为 `a/b/c`。两类路径都会统一斜杠并拒绝空段、`.`、`..`。

重复执行完全相同的新增操作会返回 no-op；相同分组、name、path/key 但内容不同会被拒绝并要求使用修改操作。不同资源只是在本地 basename 冲突时才使用确定性后缀。

脚本资源必须同时创建 `name.ms` 和 `name.magic.json`。例如新增 API：

```text
api/user/users.ms
api/user/users.magic.json
```

新 sidecar 不要填写 `id`、`groupId`、时间、用户或锁字段；扩展会从父目录映射真实分组，并在服务端创建成功后把 canonical 身份写入 manifest。为避免推送期间覆盖编辑器中的新改动，完整 canonical 元数据会在后续同步时写入本地文件：

```json
{
  "name": "创建用户",
  "path": "/users",
  "method": "POST",
  "parameters": [],
  "headers": [],
  "options": [],
  "paths": []
}
```

API 需要 `name`、`path`、`method`；function/component 需要 `name`、`path`；task 需要 `name`、`path`、`cron`。datasource 使用单个 `.json`，至少填写 `name`、`key`、`url`。

执行 `magic-api: 推送本地全部变更` 后，扩展会先恢复未完成状态，再按父分组、子分组、资源的顺序同步，最后处理修改和删除。分组按 type、parent、name、path 唯一匹配，已存在则复用。批量推送不是服务端事务；中途失败时已完成步骤会写入 manifest，可安全继续而不会盲目重复创建。同一批同时出现资源新增和删除仍会被阻止，请拆成两次操作。

### 删除资源

日常操作可在资源树文件上右键选择 `删除资源`。插件会确认本地镜像干净且资源没有远端冲突，再显示不可撤销确认；用户确认后才删除本地资源对并请求服务端删除。

删除脚本资源时同时删除 `.ms` 和 `.magic.json`；删除 datasource 时删除对应 `.json`。然后执行 `magic-api: 推送本地全部变更`。

扩展会把完整清单写入 `magic-api` 输出并展示待删除资源及稳定服务端 ID，只有选择“删除服务端资源”才会发起删除。接口返回后还会通过资源详情接口复核；只有详情明确返回不存在，才移除 manifest 记录和残留 sidecar。无权限、网络错误等无法证明“不存在”的结果都会保留恢复记录。脚本资源对只丢失其中一个文件会被视为本地损坏，不会删除服务端资源。

扩展会在分组、资源新增和删除请求发出前写入对应 journal：`pendingGroupCreateRequests`、`pendingGroupCreates`、`pendingCreateRequests`、`pendingCreates` 或 `pendingDeletes`。即使响应丢失或进程退出，也不会盲目重试。先执行 `magic-api: 处理结果未知的新增请求` 完成唯一匹配或人工确认，再继续批量推送。不要手工删除这些记录。

## 编辑 magic-script

打开 `.ms` 文件后，VS Code 会使用 `magic-script` 语言模式。

可用能力包括：

- magic-script 关键字、代码片段和常用模块成员补全。
- `db.`、`http.`、`response.`、`log.` 等模块成员补全。
- SQL 占位符 `#{...}` 中的脚本变量和 API 参数补全。
- 本地工作区资源名补全。
- 服务端运行时类、函数、扩展方法、`@MagicModule` 模块成员补全。
- `import` 语句中的 Java 包名和类名补全。
- 已导入 Java 类的静态方法补全。
- 对局部变量的轻量类型推断补全。
- 悬停查看关键字、模块、方法签名、参数、示例和来源说明。
- 执行 VS Code 内置 `Format Document` 对 `.ms` 文件做保守缩进格式化。

格式化只处理缩进和行尾空白，不重写表达式结构。

## 运行 API

打开 API 资源后，可以通过编辑器标题栏或资源树右键菜单执行 `magic-api: 运行当前 API`。

扩展会根据以下信息拼接请求地址：

- `magicApi.serverUrl`
- 后端 `config.json` 中的 `prefix`
- 分组路径
- API 路径

运行前可以在 REST 面板中调整 Method、URL、Headers JSON 和 Body。响应状态、响应头和响应体会显示在同一个面板中。

## 配置项

- `magicApi.serverUrl`：当前工作区专用的 magic-api Web 工作台地址，默认 `http://localhost:9999/magic/web`；全局用户值不会用于连接。
- `magicApi.workspaceDir`：当前工作区专用的本地镜像目录，默认 `.magic-api-workspace`；全局用户值不会生效。
- `magicApi.syncOnSave`：保存 manifest 已管理资源时自动推送修改，默认开启；使用全局默认并允许工作区覆盖。
- `magicApi.autoPullOnOpen`：从资源树打开资源时自动拉取本地镜像，使用全局默认并允许工作区覆盖。
- `magicApi.checkConflicts`：推送前检查服务端资源是否被其他客户端修改，使用全局默认并允许工作区覆盖。

## AI Skills

扩展内置 `magic-script` 与 `magic-api-workspace` 两个 AI Skills。执行命令 `magic-api: 安装 AI Skills 到工作区` 后，扩展会把它们安装到当前 VS Code 工作区：

```text
.codex/
  skills/
    magic-script/
      SKILL.md
      agents/openai.yaml
      references/
    magic-api-workspace/
      SKILL.md
      agents/openai.yaml
      scripts/
        magic-api-request.js
        magic-api-workspace.js
        request-bridge.js
        workspace-operations.js
```

如果任一目标目录已存在，扩展会询问是否覆盖。`magic-script` 提供脚本语法与 API 规则；`magic-api-workspace` 内置零依赖 Node.js CLI，提供本地镜像查询、新增、修改、删除、校验、冲突检查、完成验证和实际接口请求规则。

AI 工作区操作统一使用：

```bash
node .codex/skills/magic-api-workspace/scripts/magic-api-workspace.js <command> --root <mirror-root>
```

可用命令为 `status/groups/list/get/ensure-group/create/update/delete/validate`。`ensure-group --type api --group-path admin/user` 可预览或暂存缺失分组；`create` 使用 `--group-path` 自动补齐分组，或用 `--group-id` 指向已有分组。变更命令默认只输出 JSON 预览，追加 `--apply` 才写本地镜像；CLI 只会为离线分组计划更新当前工作区 manifest，不读取凭据也不访问服务端。完成本地操作后仍由扩展执行批量推送、journal、冲突检查和删除确认。

实际接口请求使用 `magic-api-request.js`。脚本默认通过当前工作区的本地桥接，让扩展从该工作区 SecretStorage 读取 Token，并以 lowercase `magic-token` 请求头发送；Token 不会复制到环境变量、工作区或 CLI 输出。请求基址自动取 `magicApi.serverUrl` 去掉控制台 path 后的域名，例如 `http://localhost:9999/magic/web` 对应 `http://localhost:9999`。所有请求默认只预览，追加 `--send` 才发送；控制台仅开放查询白名单，写操作仍由扩展同步和 journal 管理。

若 AI 沙箱无法读取当前用户临时目录中的插件桥接，Skill 会要求对同一条请求 CLI 自动发起最小范围的宿主机执行授权，而不是复制 Token 或切换到全局配置。实际是否免确认由运行平台的沙箱策略决定；Skill 不会绕过平台审批，也不会使用 `sudo` 或扩大到其他命令。

## 使用边界

- 支持离线新增嵌套分组；删除、移动和重命名分组仍需在 magic-api Web 工作台中完成。
- 旧服务端无法区分“Task 未安装”和“尚无 Task 分组”，因此 Tasks 根节点始终显示；未安装 Task 插件时首次同步会保留本地计划并报告服务端不支持。
- 移动和重命名资源暂不支持，不会自动解释为删除加新增。
- 删除服务端资源必须通过资源树删除或批量推送的模态确认；未确认或服务端复核失败时会保留 manifest 恢复记录。
- manifest 的 serverUrl 与当前配置不一致时会阻止任何推送。
- 不在工作区之间复制服务地址、用户名、Token、manifest 或 pending 恢复状态；没有打开工作区时扩展不会连接服务端。
- 复杂元数据仍可通过高级 JSON 区域编辑。
- 当前提供的是普通运行 API，不包含断点调试协议。
