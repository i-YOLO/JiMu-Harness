# JiMu Harness

中文 | [English](README.en.md)

基于 [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) 与 Cordis 插件运行时的本地优先桌面工作台，面向 macOS 与 Windows，提供 Agent 对话、插件管理和 Markdown 知识库接入。

**作者与维护者：JiMu** · [官方仓库](https://github.com/i-YOLO/JiMu-Harness) · [下载安装](https://github.com/i-YOLO/JiMu-Harness/releases) · [问题反馈](https://github.com/i-YOLO/JiMu-Harness/issues) · [MIT License](LICENSE)

## 项目简介

JiMu Harness 提供原生 Electron 宿主、JiMu 界面、受策略约束的插件管理，以及内置 Harness 的启动与停止管理。配套的 [JiMu Knowledge](https://github.com/i-YOLO/JiMu-Knowledge) 是独立维护的空白 Markdown 知识库模板，支持知识索引、对标博主库和自媒体工厂目录。

本项目由 JiMu 独立维护，属于 DeepSeek Harness 的下游发行版，不是 DeepSeek 官方产品。本仓库保留上游 Git 历史、标签和版权声明；JiMu 自有功能与上游代码分别维护。

## 快速开始

1. 前往 [Releases](https://github.com/i-YOLO/JiMu-Harness/releases/latest)，选择对应系统的安装包。
2. 安装并打开 JiMu，按首次配置向导选择是否启用“对标博主库”和“自媒体工厂”。
3. 使用默认配置初始化知识库，选择一个上级目录创建 `JiMu-Knowledge`，或选择已有知识库。
4. 在应用内配置并验证自己的 DeepSeek API Key，再开始使用。

| 平台 | 安装包 |
| --- | --- |
| macOS Apple Silicon（arm64） | `.dmg` |
| Windows x64 | `-Setup.exe` |

使用安装包无需安装 Node.js 或 pnpm。模型调用与在线模板下载需要网络；本地优先不代表完全离线运行。

## 隐私与知识库

仓库与安装包不包含用户的知识内容、项目记录、会话、凭据或演示数据。应用不扫描用户主目录；知识库位置由用户选择，Git 同步由用户自己的 Git 工具处理，应用不保存 Git 仓库凭据。

默认配置从锁定的 GitHub Release 安装完整空白模板，断网时使用安装包内置的同版本副本。用户指定上级目录时，JiMu 会在其中原子创建 `JiMu-Knowledge`。两个按需模块可以独立关闭；关闭不会创建、扫描或删除相应目录。

详见[隐私与发布边界](docs/jimu/privacy.md)。

## 代码结构

| 路径 | 职责 |
| --- | --- |
| [apps/jimu-desktop/](apps/jimu-desktop/) | Electron 主进程、preload 安全边界、插件策略、Harness 生命周期、原生目录选择与打包 |
| [apps/jimu-ui-preview/](apps/jimu-ui-preview/) | JiMu 界面、只读知识索引和仅在真实写入操作发生时创建目录的自媒体工厂 |
| [knowledge-schema.mjs](apps/jimu-ui-preview/shared/knowledge-schema.mjs) | 八个公开知识分类的统一配置 |
| [packages/](packages/)、[apps/cli/](apps/cli/)、[vendor/](vendor/)、[examples/](examples/) | DeepSeek Harness 上游实现及依赖；官方示例不进入 JiMu 桌面安装包 |

完整说明见[JiMu 架构](docs/jimu/architecture.md)。

<a id="run"></a><a id="run-from-source"></a>

## 本地开发

需要 Git、Node.js `^22.19.0 || >=24.0.0`，以及 [package.json](package.json) 锁定的 pnpm `11.7.0`。桌面开发请使用对应平台的原生环境。

```sh
git clone https://github.com/i-YOLO/JiMu-Harness.git
cd JiMu-Harness
pnpm install --frozen-lockfile
pnpm run build:lib
pnpm --filter @i-yolo/jimu-desktop dev:isolated
```

`dev:isolated` 准备锁定版本的知识库模板、构建桌面应用并启动隔离的开发实例。该实例使用临时应用设置和测试知识库，退出后清理，不用于保存个人内容。首次准备模板需要访问 GitHub Release。

仅预览浏览器界面：

```sh
pnpm --filter @i-yolo/jimu-ui-preview dev
```

浏览器预览没有接入本地数据时只显示空态，不能替代 Electron 桌面功能验证。

### 打包

分别在 macOS Apple Silicon 与原生 Windows x64 主机上执行对应命令：

```sh
# macOS Apple Silicon
pnpm --filter @i-yolo/jimu-desktop dist:mac

# Windows x64
pnpm --filter @i-yolo/jimu-desktop dist:win
```

发布构建按 [knowledge-template-lock.json](apps/jimu-desktop/config/knowledge-template-lock.json) 下载指定 Release，校验 SHA-256、Manifest 和空目录结构后打入安装包。它不接受未锁定的本地模板，也不会因配套仓库的 README 更新而自动替换已锁定的发布包。

## 兼容矩阵

| JiMu Harness | Knowledge Schema | Knowledge Template |
| --- | --- | --- |
| 0.1.x–0.2.x | 1 | 1.0.x |

没有 Manifest 但具备核心标准目录的知识库以 `legacy-schema-1` 兼容模式加载，仅打开不会产生写入；已启用的按需模块仍须存在。损坏或版本过高的 Manifest 会被拒绝，并保留当前可用知识库。

内容分类目录必须是真实目录。`assets` 可以是解析后仍位于知识库根目录内的目录符号链接；指向外部、已失效或指向文件的链接会被拒绝。

## 反馈与上游

JiMu 的安装、界面与知识库问题请提交到[本仓库 Issues](https://github.com/i-YOLO/JiMu-Harness/issues)，附上系统、应用版本、复现步骤与去除敏感信息的日志，不要上传 API Key、会话原文或私人知识库。

如需原版 DeepSeek Harness Web UI 或 CLI，请参阅[上游文档](https://github.com/deepseek-ai/deepseek-harness)。维护者的双远端配置见[上游同步说明](docs/jimu/upstream-sync.md)；普通克隆不会自动创建或禁用 `upstream`。上游贡献政策见 [CONTRIBUTING.md](CONTRIBUTING.md)。

## 开源许可与品牌

本项目代码采用 [MIT License](LICENSE)。JiMu 自有部分由 JiMu 维护，DeepSeek 上游版权与其他第三方声明继续保留。第三方组件按各自许可证分发，详见 [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md)。

MIT 许可证不授予将 JiMu 名称、Logo 或角色形象用作商标、产品标识或背书的权利，详见 [TRADEMARKS.md](TRADEMARKS.md)。本说明不增加 MIT 代码使用限制，也不改变第三方权利。
