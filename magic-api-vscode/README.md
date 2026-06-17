# magic-api

在 Visual Studio Code 中编辑、同步和运行 magic-api 工作台资源。

此扩展连接到已有的 magic-api Web 工作台接口，不替换 magic-api 后端，也不直接读取数据库。安装后可以在 VS Code 资源管理器中浏览 API、函数、数据源、任务和组件，把服务端资源同步到本地工作区，并用 `.ms` 文件获得 magic-script 的补全、悬停文档、格式化和运行入口。

## 功能

- 连接 magic-api Web 工作台地址，例如 `http://localhost:9999/magic/web`。
- 通过 magic-api `/login` 接口登录，并把返回的 `Magic-Token` 保存到 VS Code SecretStorage。
- 在资源管理器中展示 magic-api 资源树。
- 把 API、函数等脚本资源同步为本地 `.ms` 文件，便于搜索、批量编辑、版本管理和 AI 工具读取上下文。
- 保存本地镜像文件时自动推送到 magic-api 服务端，并刷新服务端缓存。
- 支持增量同步、全量重新拉取、推送当前文件和推送全部本地变更。
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
    metadata/
    groups/
  api/
    user/
      list.ms
  function/
    common/
      format.ms
  datasource/
    default.json
```

脚本类资源保存为 `.ms` 文件。method、path、headers、parameters 等资源信息保存到隐藏目录 `.magic-api/metadata`，可以通过 `magic-api: 编辑资源信息` 修改。

数据源等非脚本资源保存为 `.json` 文件。`.magic-api/manifest.json` 记录本地文件、服务端资源 ID、服务端更新时间和本地 hash，用于增量同步、推送和冲突检查。

资源树主要作为导航入口。打开资源时，扩展会优先打开本地镜像文件；保存本地镜像文件时，如果 `magicApi.syncOnSave` 开启，会自动推送到服务端。

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

- `magicApi.serverUrl`：magic-api Web 工作台地址，默认 `http://localhost:9999/magic/web`。
- `magicApi.workspaceDir`：本地镜像目录，默认 `.magic-api-workspace`。相对路径会放在当前 VS Code 工作区下，绝对路径会直接使用。
- `magicApi.syncOnSave`：保存本地镜像文件时自动推送到服务端，默认开启。
- `magicApi.autoPullOnOpen`：从资源树打开资源时自动拉取本地镜像，默认开启。
- `magicApi.checkConflicts`：推送前检查服务端资源是否被其他客户端修改，默认开启。

## AI Skills

扩展内置 `magic-script` AI Skill。执行命令 `magic-api: 安装 AI Skills 到工作区` 后，扩展会把 skill 安装到当前 VS Code 工作区：

```text
.codex/
  skills/
    magic-script/
      SKILL.md
      agents/openai.yaml
      references/
```

如果目标目录已存在，扩展会询问是否覆盖。安装后，在该工作区使用 Codex 处理 `.ms` 文件、magic-api API/函数脚本、`db`/`request`/`response`/`http`/`env`/`log` 模块和 SQL 占位符时，可以使用 `magic-script` skill。

## 使用边界

- 新建、删除、移动、重命名资源仍建议在 magic-api Web 工作台中完成。
- 删除本地镜像文件不会自动删除服务端资源。
- 批量推送会跳过已删除的本地文件。
- 复杂元数据仍可通过高级 JSON 区域编辑。
- 当前提供的是普通运行 API，不包含断点调试协议。
