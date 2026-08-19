# Agent Note: JiMu 原生插件安装与权威取消状态

Status: implemented

[English](2026-08-19-jimu-native-plugin-market-and-cancellation.md) | 中文

## Problem

JiMu 嵌入 Harness 宿主时关闭了官方 HTTP Server、Web Runtime、客户端模块加载器和设置界面，因此社区 Web 插件市场不能直接渲染在 Electron 应用中。原插件页面只投影实时 Loader 清单，搜索未安装包时看起来像插件市场搜索失败。

桌面输入框还维护了 Renderer 本地的发送状态。重连和切换会话后，该状态可能与已挂载 Agent 不一致；通过 `AbortSignal.reason` 共享的取消原因也可能在关闭回合将其复制进持久 `turn/end` 之前发生变化。

## Decision

JiMu 在现有 Electron Renderer 中拥有唯一的原生插件市场。主进程读取公开社区目录并提供内置回退快照，把 npm 或公开 GitHub 来源解析为不可变提案，并且只公开结构化的检查、安装、启用、停用、更新、卸载和取消操作 IPC。

安装操作使用 JiMu 随包提供的 pnpm Runtime 修改 Web Profile 副本。主进程在停止嵌入式 Harness 并原子激活暂存 Profile 之前，校验已批准的完整性摘要或 commit、安装后的名称与版本，以及位于包目录内的 `dsh.bundle.patch`。新 Profile 启动失败时，操作先恢复旧 Profile，再报告失败。

对话模型可以搜索目录并准备提案，但只有 Renderer 中的人工操作可以执行安装。目录描述始终是不可信文本，生命周期脚本需要精确到包的单独授权，依赖官方 Web UI 或只面向终端的包不能安装到 JiMu Profile。

输入框操作由各 Session 的权威运行状态与 Renderer 本地的提交、取消过渡共同派生。`Agent.cancel` 在传播取消之前快照类型化原因；运行时消费者仍接收原始原因，`turn/end` 只接收分离后的 JSON 值。

## Alternatives considered

**在 Electron 中启用官方 DSH Web UI。** 这能直接渲染 Web 市场插件，但会重新引入 HTTP Server、第二套浏览器 Runtime 和与 JiMu 竞争的设置应用，而 JiMu 明确移除了这些组件。

**让模型通过 Shell 运行 `dsh plugin`。** 该命令无法提供稳定的人工确认、完整性固定、Profile 回滚或自重启约定，而且默认工作区沙箱不拥有机器级 Profile。

**直接修改实时 Profile。** 这种实现更小，但失败的包脚本、无效 Patch 或启动错误会破坏唯一可用 Profile。暂存机制让实时 Profile 在验证成功前保持不变。

## Consequences

开发版和安装包使用相同的插件 API 与 pnpm 可执行入口，平台适配器只负责进程树终止和文件系统替换。插件状态保存在用户级 Harness Home 中，并在应用升级后继续存在。

JiMu 需要携带目录快照和包管理 Runtime，应用体积及目录兼容维护成本会上升。依赖官方 Web Slot 的社区插件可能只有宿主工具可用、原设置页不可用；市场会在安装前标注这一限制。

聚焦单元测试固定目录归一化、不可变提案、暂存启停和回滚。Electron 测试通过隔离用户目录固定在线目录搜索、包安装与卸载、Harness 重启和模型回合取消，不触碰用户的 Knowledge 或 Profile。
