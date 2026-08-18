# Agent Note: JiMu 双平台桌面发行

Status: implemented

[English](2026-08-18-jimu-dual-platform-desktop.md) | 中文

## 问题

JiMu 的 Electron 宿主与发行工作流假设系统为 macOS，尽管内嵌 Harness 已经提供 Windows PowerShell 与 ACL 沙箱组合。在 macOS 上构建 Windows 产物无法验证原生 `node-pty` ABI、NSIS 生命周期、Windows 文件系统策略或 Authenticode 签名。

## 决策

JiMu 使用同一份桌面源码发行 macOS Apple Silicon 与 Windows x64。Preload 将 `macOS | Windows` 作为展示信息公开；Electron 主进程负责相应的标题栏、菜单、快捷键和用户数据默认位置，同时不移动现有 macOS 数据。Renderer 只用该信息处理操作系统展示差异。

Windows 发行物是安装到 `%LOCALAPPDATA%\Programs\JiMu` 的当前用户一键 NSIS 安装包。应用数据和 Knowledge 位于安装目录外，并在升级和卸载后保留。打包后的 Harness 在 Windows 选择现有受约束的 PowerShell 栈，在 macOS 选择 Bash 栈。

原生构建保留在目标操作系统。Pull Request 在标准 Windows x64 runner 上构建未签名安装包并执行安装生命周期。正式发行通过受保护的 Azure Trusted Signing 环境签署 Windows 可执行文件和安装包，独立构建 macOS DMG，并且只在同一 commit 的全部任务成功后发布两端产物。

## 考虑过的替代方案

**在 macOS 上交叉构建 Windows。**`node-pty` 会拒绝跨操作系统的必要原生重建，而且即使生成文件，也不能证明 ConPTY、ACL、NSIS 或 Authenticode 行为。

**以 Windows on Arm 作为发行依据。**Windows 11 Arm 可以模拟 x64 应用，适合人工预览，但不能取代原生 x64 构建与安装器证据。

**分别维护 macOS 与 Windows 应用分支。**重复产品代码会让菜单和打包行为逐渐漂移，也会削弱两个发行产物必须对应同一个已评审 commit 的要求。

## 结果

每项桌面改动都要维护两条平台路径，并保留强制原生 CI。Windows 正式发布依赖外部配置的 Azure 签名账号。共享源码在保持 macOS 行为的同时，提供可重复生成的 x64 安装包、平台原生 Shell 验证、升级数据保留、卸载数据保留，以及一次原子的双平台 GitHub Release。
