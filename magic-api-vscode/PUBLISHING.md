# 发布到 VS Code Marketplace

本文档说明 `magic-api-vscode` 发布到 Visual Studio Code Marketplace 的流程。用户安装和使用说明放在 `README.md`，因为 Marketplace 会把扩展根目录的 `README.md` 作为扩展详情页展示。

官方参考：

- [Publishing Extensions](https://code.visualstudio.com/api/working-with-extensions/publishing-extension)
- [Extension Manifest](https://code.visualstudio.com/api/references/extension-manifest)
- [Extension Marketplace](https://code.visualstudio.com/docs/configure/extensions/extension-marketplace)

## 发布前检查

确认 `package.json` 中的 Marketplace 元数据完整：

- `name`：扩展唯一名称，只使用小写和连字符，例如 `magic-api-vscode`。
- `publisher`：发布者 ID，例如 `reddog`。
- `displayName`：Marketplace 展示名称。
- `description`：一句话说明扩展用途。
- `version`：SemVer 版本号，每次发布必须递增。
- `engines.vscode`：支持的 VS Code 版本范围，不能写成 `*`。
- `categories`、`keywords`：帮助用户在 Marketplace 中发现扩展。
- `icon`：建议使用随包发布的 PNG 图标，至少 128x128。
- `repository`、`license`、`bugs`、`homepage`：有公开仓库时建议补齐。

确认发布包内容：

- `README.md` 面向最终用户，避免包含调试、源码结构、开发环境说明。
- `CHANGELOG.md` 记录版本变化。
- `LICENSE` 说明许可证。
- `SUPPORT.md` 说明反馈和支持渠道。
- `.vscodeignore` 排除开发文件、测试文件、日志、历史 VSIX、`node_modules` 等不需要发布的内容。
- 如果希望把 `ai-skills` 随扩展分发，不要在 `.vscodeignore` 中排除 `ai-skills/**`。

Marketplace 对资源有安全限制：扩展图标不能使用 SVG；`README.md` 和 `CHANGELOG.md` 中的图片应使用可访问的 HTTPS 地址；用户提供的 SVG 图片通常不能发布。

## 安装发布工具

```bash
npm install -g @vscode/vsce
```

也可以在项目脚本中使用：

```bash
npx @vscode/vsce --help
```

## 本地打包验证

在扩展根目录执行：

```bash
cd magic-api-vscode
vsce package
```

生成的文件类似：

```text
magic-api-vscode-0.1.0.vsix
```

本地安装验证：

```bash
code --install-extension magic-api-vscode-<version>.vsix
```

确认扩展 ID：

```bash
code --list-extensions --show-versions | grep '^reddog.magic-api-vscode@'
```

如果要确认 `ai-skills` 已进入安装目录，可以检查：

```bash
ls ~/.vscode/extensions/reddog.magic-api-vscode-*/ai-skills/magic-script
```

## 创建发布者

1. 登录 [Visual Studio Marketplace publisher management page](https://marketplace.visualstudio.com/manage/publishers/)。
2. 创建 publisher。
3. publisher 的 ID 必须和 `package.json` 中的 `publisher` 字段一致。
4. 创建后不要随意更改扩展 `name`，Marketplace 扩展标识为 `${publisher}.${name}`。

## 认证方式

VS Code Marketplace 使用 Azure DevOps 作为发布和认证体系。

官方当前推荐自动化发布使用 Microsoft Entra ID 的 workload identity federation 或 managed identity，避免在 CI 中保存长期 Personal Access Token。

PAT 仍可用于手动发布，但 Azure DevOps 全局 PAT 会在 2026-12-01 退役。后续自动发布应迁移到 Entra ID 方案。

## 使用 PAT 登录

在 Azure DevOps 中创建 PAT 时，选择 Marketplace 的 `Manage` 权限。

登录发布者：

```bash
vsce login reddog
```

根据提示粘贴 PAT。登录成功后，`vsce` 会保存发布凭据。

## 发布扩展

在扩展根目录执行：

```bash
cd magic-api-vscode
vsce publish
```

如果要在发布时自动递增版本：

```bash
vsce publish patch
vsce publish minor
vsce publish major
```

也可以指定明确版本：

```bash
vsce publish 0.1.2
```

`vsce publish` 会修改 `package.json` 的 `version`。如果命令运行在 Git 仓库中，默认还会创建版本提交和 tag；发布前确认工作区状态符合团队流程。

## 手动上传 VSIX

也可以先打包：

```bash
vsce package
```

然后在 [publisher management page](https://marketplace.visualstudio.com/manage/publishers/) 中选择对应 publisher，手动上传生成的 `.vsix`。

## 自动化发布建议

CI 发布建议使用官方的 Entra ID 方案：

1. 在 Azure DevOps 创建 Service Connection。
2. 使用 Workload Identity Federation。
3. 在 Azure 创建 user-assigned managed identity。
4. 给 managed identity 配置 federated credential。
5. 在 Marketplace publisher 中把 managed identity 加为成员并授予 Contributor。
6. 在流水线中安装 `@vscode/vsce`。
7. 使用 `vsce publish --azure-credential` 发布。

PAT 方式适合本地手动发布；长期自动化发布不要依赖即将退役的全局 PAT。

## 版本发布清单

1. 更新 `package.json` 的版本和展示元数据。
2. 更新 `README.md`、`CHANGELOG.md`、`LICENSE`、`SUPPORT.md`。
3. 确认 `.vscodeignore` 不会排除运行时必需文件。
4. 执行扩展检查和本地打包。
5. 安装 VSIX 到本地 VS Code 验证主要命令。
6. 发布到 Marketplace。
7. 在 Marketplace 页面确认图标、说明、命令、分类和安装包内容。
