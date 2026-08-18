# Agent Note: JiMu dual-platform desktop distribution

Status: implemented

English | [中文](2026-08-18-jimu-dual-platform-desktop.zh.md)

## Problem

JiMu's Electron host and release workflow assumed macOS even though the embedded Harness already supplies a Windows PowerShell and ACL-sandbox composition. Building a Windows artifact on macOS cannot validate the native `node-pty` ABI, NSIS lifecycle, Windows filesystem policy, or Authenticode signature.

## Decision

JiMu ships one desktop source for macOS Apple Silicon and Windows x64. Preload exposes `macOS | Windows` as a presentation fact; Electron main owns the corresponding title bar, menu, shortcuts, and user-data default without moving existing macOS data. The Renderer uses that fact only for operating-system presentation.

The Windows distribution is a one-click, per-user NSIS installer under `%LOCALAPPDATA%\Programs\JiMu`. Application data and Knowledge remain outside the installation directory and survive upgrade and uninstall. The packaged Harness selects its existing confined PowerShell stack on Windows and Bash stack on macOS.

Native builds stay on their target operating systems. Pull requests build an unsigned installer and exercise its installation lifecycle on the standard Windows x64 runner. Formal releases sign the Windows executable and installer through a protected Azure Trusted Signing environment, build the macOS DMG independently, and publish both only after every job succeeds for the same commit.

## Alternatives considered

**Cross-build Windows on macOS.** `node-pty` rejects the required native rebuild across operating systems, and a produced file would not prove ConPTY, ACL, NSIS, or Authenticode behavior.

**Use Windows on Arm as the release authority.** Windows 11 Arm can emulate x64 applications and remains useful for manual previews, but it does not replace native x64 build and installer evidence.

**Maintain separate macOS and Windows application forks.** Duplicate product code would let menus and packaging drift and would weaken the requirement that both release assets correspond to one reviewed commit.

## Consequences

Every desktop change preserves two platform paths and keeps native CI mandatory. Windows release publication depends on an externally provisioned Azure signing account. The shared source retains macOS behavior while adding a repeatable x64 installer, platform-native shell validation, upgrade preservation, uninstall preservation, and one atomic dual-platform GitHub Release.
