# Agent Note: JiMu 自主管理下游 CI 与发布治理

Status: implemented

[English](2026-08-18-downstream-ci-ownership.md) | 中文

## Problem

JiMu 保留 DeepSeek Harness 的完整源码历史，其中包含依赖上游组织、GitHub App 凭据、包命名空间、发布仓库与企业 Runner 策略的工作流。这些工作流在下游仓库中原样运行时会产生与 JiMu 行为无关的失败，也会让发布提交与未经远端验证的本地上传无法区分。

合成凭据 Fixture 还会产生另一种歧义。安全扫描器会正确识别它们接近生产凭据的语法，但下游发布必须在不削弱新增改动扫描能力的前提下，区分已经审查的脱敏测试数据与 JiMu 代码引入的凭据。

## Decision

`JiMu downstream gates` 是下游仓库唯一自动运行的产品工作流。它提供三个稳定 Job：源码与历史安全扫描、受控的 Node 24 上游兼容检查，以及 macOS JiMu Desktop 构建与测试。该工作流可以复用，因此手动 macOS 发布会先重复三个 Job，再从准确的 `main` 提交构建、挂载、审计、生成校验和并发布 DMG。JiMu 主动使用的远程 Action 均采用审核过的完整 Commit SHA，并使用当前兼容 Node 24 的 Action 运行时。

Electron Builder 根据 Manifest 中锁定的 Electron 版本解析发行文件。打包配置不得将 `electronDist` 指向工作区本地 `node_modules` 路径，因为 pnpm 的 CI 布局不保证该路径存在。

桌面子包声明公开仓库元数据，并通过 `--publish never` 调用 Electron Builder。工作流不会向构建、冒烟或审计步骤暴露 `GH_TOKEN`；Token 只用于检查 Release 是否存在，以及最终的 `gh release create` 命令。这样既阻止 Electron Builder 推断隐式发布目标，也保留显式 GitHub Release 操作所需的授权。

Gitleaks 在安装依赖前运行，显式读取 `.gitleaks.toml`，并同时扫描源码树和 `upstream/master..HEAD`。白名单只列出经过审查的上游 Fixture 路径，不会全局关闭规则，也不会按任意凭据值放行。依赖、构建、覆盖率和发布生成目录不进入源码扫描，改由发布审计处理。每次运行还会创建临时高熵负向样例，证明新引入的凭据仍会让 Job 失败。

每个上游专用工作流的独立 Job 都会校验 `github.repository` 是否为 `deepseek-harness/deepseek-harness`。守卫合入后，JiMu 仓库还会停用这些工作流。源码继续保留以便同步上游，而 JiMu Pull Request 只为下游 Job 与 CodeQL 消耗 Runner。

真实 DeepSeek API 测试只接受手动和定时触发。仓库变量控制定时任务是否启用，测试读取的限额仓库 Secret 与应用凭据无关。真实 API Job 不作为合并必需检查。

`main` 要求通过 Pull Request、三个 JiMu Job、最新基线校验、Review 对话解决和线性历史，并禁止删除或非快进更新。仓库所有者保留带审计记录的紧急绕过。CodeQL 与依赖漏洞告警补充安全证据，但不作为首个修复版本的阻塞检查。

## Alternatives considered

**复刻上游组织基础设施。** 不采用，因为 JiMu 不拥有也不需要 DeepSeek 的 Issue 管理 App、npm 发布族、企业 Runner 或组织 Secret。部分复刻会引入一套高权限基础设施，而它的唯一作用只是满足另一个仓库的检查。

**只运行 JiMu 包测试。** 不采用，因为桌面应用嵌入了上游库。受控的构建、类型检查、Lint 和单元测试能够发现集成漂移，又不会继承完整的平台与发布矩阵。

**每次 main Push 都运行真实 API 测试。** 不采用，因为外部服务可用性、账户余额和模型行为会把合并检查变成成本不稳定的服务探针。手动和明确启用的夜间任务可以保留信号，同时不向 Pull Request 暴露 Secret。

**重写上游历史以删除合成凭据。** 不采用，因为该 Fixture 是公开测试数据，而保留完整上游历史是有意设计。告警按测试用途关闭，下游扫描仍会拒绝新增凭据。

## Consequences

- JiMu 拥有稳定的必需检查名称，可以在不依赖上游组织状态的情况下保护 `main`。
- 上游工作流更新必须保留仓库守卫，否则下游工作流测试会失败。
- 发布耗时增加，因为打包前会重复三个必需 Job，但每个资产都能对应独立记录的 CI 证据。
- 夜间真实 API 测试只有在同时配置启用变量和专用 Secret 后才会运行。
- 上游工作流文件继续保留在仓库中；它们不会为 JiMu 执行，但同步上游时仍可能需要解决冲突。
- 两处既有 DeepSeek 模型发现测试断言改为直接检查带类型的 Mock 调用，使兼容 Lint 从干净的下游基线开始；测试行为没有变化。
