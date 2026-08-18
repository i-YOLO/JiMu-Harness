# JiMu Harness

中文 | [English](README.en.md)

JiMu Harness 是基于官方 [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) 与 Cordis 插件运行时构建的本地优先 macOS 与 Windows 桌面工作台。项目新增原生 Electron 宿主、JiMu 界面、受策略约束的插件管理、内置 Harness 生命周期，以及可选的 Markdown 知识库协议。

本仓库保留 DeepSeek Harness 的完整上游历史和 Tags。DeepSeek Harness 仍是 DeepSeek AI 开发的上游项目；JiMu 代码作为下游产品层独立维护。

## 隐私边界

仓库不包含任何用户知识、项目、会话、凭据、统计、截图或演示记录。首次启动会依次选择按需模块、安装本地知识库并验证 DeepSeek API Key；JiMu 不扫描用户主目录。

空白配套模板位于 [i-YOLO/JiMu-Knowledge](https://github.com/i-YOLO/JiMu-Knowledge)。Git 同步交给用户现有的 Git 工具，应用不保存仓库凭据。

默认配置从锁定的 GitHub Release 安装完整 JiMu-Knowledge，断网时自动使用安装包内置的同版本副本。`07-对标博主库` 与 `08-自媒体工厂` 可以在首次配置或设置页分别关闭；关闭不会创建、扫描或删除对应目录。

## 代码结构

- `apps/jimu-desktop`：Electron 主进程、preload 安全边界、插件策略、Harness 生命周期、原生目录选择与打包。
- `apps/jimu-ui-preview`：JiMu Renderer、只读知识索引和仅在真实写入操作发生时创建目录的自媒体工厂。
- `apps/jimu-ui-preview/shared/knowledge-schema.mjs`：八个公开分类的唯一配置源。
- `packages`、`apps/cli`、`vendor`、`examples`：DeepSeek Harness 上游源码。官方 examples 只保留在源码中，不进入 JiMu 桌面安装包。

进一步阅读：[架构](docs/jimu/architecture.md)、[隐私与发布边界](docs/jimu/privacy.md)、[上游同步](docs/jimu/upstream-sync.md)。

<a id="run"></a><a id="run-from-source"></a>

## 本地开发

需要 Node.js 22.19+ 与 pnpm 11.7。

```sh
pnpm install --frozen-lockfile
pnpm run build:lib
JIMU_KNOWLEDGE_TEMPLATE_DIR=/path/to/JiMu-Knowledge \
  pnpm --filter @i-yolo/jimu-desktop prepare:knowledge-template
pnpm --filter @i-yolo/jimu-desktop build
```

浏览器开发预览在没有数据源时只显示空态：

```sh
pnpm --filter @i-yolo/jimu-ui-preview dev
```

正式发布构建不会接受未锁定的本地目录。构建器会下载 `apps/jimu-desktop/config/knowledge-template-lock.json` 指定的 Release，校验 SHA-256、Manifest 和空目录结构，再作为 `extraResource` 打入应用。

macOS Apple Silicon 在 macOS 主机上打包，Windows x64 在原生 Windows 主机上打包：

```sh
pnpm --filter @i-yolo/jimu-desktop dist:mac
pnpm --filter @i-yolo/jimu-desktop dist:win
```

## 兼容矩阵

| JiMu Harness | Knowledge Schema | Knowledge Template |
| --- | --- | --- |
| 0.1.x–0.2.x | 1 | 1.0.x |

没有 Manifest 但具备核心标准目录的知识库会以 `legacy-schema-1` 兼容模式加载且不被写入；已启用的按需模块仍须存在。`assets` 可以是解析后仍位于知识库根目录内的目录符号链接；指向外部、已经失效或指向文件的链接会被拒绝，内容分类目录仍须为真实目录。损坏或版本过高的 Manifest 会被拒绝，并保留当前可用知识库。

## DeepSeek Harness 上游

如需使用原版 DeepSeek Harness Web UI 或 CLI，请参阅[上游文档](https://github.com/deepseek-ai/deepseek-harness)。JiMu 将 `upstream` 设为仅抓取，不替换上游作者信息、声明或 MIT License。

## 开源许可与品牌

代码使用 [MIT](LICENSE)，并保留上游版权。JiMu 名称、Logo 和角色形象不包含在 MIT 的商标授权中，详见 [TRADEMARKS.md](TRADEMARKS.md)。第三方声明见 [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md)。
