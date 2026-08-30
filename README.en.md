# JiMu Harness

[中文](README.md) | English

A local-first desktop workspace built on [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) and the Cordis plugin runtime, with Agent conversations, plugin management, and Markdown knowledge integration for macOS and Windows.

**Author and maintainer: JiMu** · [Official repository](https://github.com/i-YOLO/JiMu-Harness) · [Downloads](https://github.com/i-YOLO/JiMu-Harness/releases) · [Issues](https://github.com/i-YOLO/JiMu-Harness/issues) · [MIT License](LICENSE)

## Overview

JiMu Harness provides a native Electron host, a JiMu interface, policy-controlled plugins, and lifecycle management for the embedded Harness. The companion [JiMu Knowledge](https://github.com/i-YOLO/JiMu-Knowledge) is a separately maintained blank Markdown template with knowledge indexing, a benchmark library, and media workflow directories.

JiMu independently maintains this downstream distribution of DeepSeek Harness. It is not an official DeepSeek product. The repository preserves upstream Git history, tags, and copyright notices; JiMu-specific features and upstream code are maintained separately.

## Quick start

1. Visit [Releases](https://github.com/i-YOLO/JiMu-Harness/releases/latest) and download the installer for your platform.
2. Install and open JiMu, then choose whether to enable the benchmark library and self-media factory during first-run setup.
3. Initialize a knowledge base with the default setup, choose a parent folder in which to create `JiMu-Knowledge`, or select an existing knowledge base.
4. Configure and verify your own DeepSeek API key in the app before use.

| Platform | Installer |
| --- | --- |
| macOS Apple Silicon (arm64) | `.dmg` |
| Windows x64 | `-Setup.exe` |

Installers do not require Node.js or pnpm. Model requests and online template downloads require network access; local-first does not mean fully offline.

## Privacy and knowledge storage

The repository and installers contain no user-authored knowledge, project records, sessions, credentials, or demo data. The app does not scan the home directory. Users choose their knowledge location and manage Git synchronization with their own Git tools; the app does not store Git repository credentials.

Default setup installs the complete blank template from a locked GitHub Release and uses the same-version bundled copy when offline. When a parent folder is selected, JiMu atomically creates `JiMu-Knowledge` inside it. Each optional module can be disabled independently; disabling a module does not create, scan, or delete its directory.

See [privacy and release boundaries](docs/jimu/privacy.md).

## Repository structure

| Path | Responsibility |
| --- | --- |
| [apps/jimu-desktop/](apps/jimu-desktop/) | Electron main process, preload security boundary, plugin policy, Harness lifecycle, native folder selection, and packaging |
| [apps/jimu-ui-preview/](apps/jimu-ui-preview/) | JiMu interface, read-only knowledge index, and a media factory that creates directories only on explicit write operations |
| [knowledge-schema.mjs](apps/jimu-ui-preview/shared/knowledge-schema.mjs) | Shared configuration for the eight public knowledge categories |
| [packages/](packages/), [apps/cli/](apps/cli/), [vendor/](vendor/), [examples/](examples/) | Upstream DeepSeek Harness implementation and dependencies; official examples are excluded from JiMu desktop installers |

See [JiMu architecture](docs/jimu/architecture.md) for details.

<a id="run"></a><a id="run-from-source"></a>

## Development

Requires Git, Node.js `^22.19.0 || >=24.0.0`, and pnpm `11.7.0` as pinned in [package.json](package.json). Use a native environment for the target desktop platform.

```sh
git clone https://github.com/i-YOLO/JiMu-Harness.git
cd JiMu-Harness
pnpm install --frozen-lockfile
pnpm run build:lib
pnpm --filter @i-yolo/jimu-desktop dev:isolated
```

`dev:isolated` prepares the locked knowledge template, builds the desktop app, and launches an isolated development instance. It uses temporary app settings and a test knowledge base, removes them on exit, and must not be used to store personal content. Initial template preparation requires access to GitHub Releases.

To preview only the browser interface:

```sh
pnpm --filter @i-yolo/jimu-ui-preview dev
```

Without a local data source, the browser preview shows empty states. It does not replace verification of Electron desktop features.

### Packaging

Run the corresponding command on macOS Apple Silicon or native Windows x64:

```sh
# macOS Apple Silicon
pnpm --filter @i-yolo/jimu-desktop dist:mac

# Windows x64
pnpm --filter @i-yolo/jimu-desktop dist:win
```

Release builds download the release specified in [knowledge-template-lock.json](apps/jimu-desktop/config/knowledge-template-lock.json), verify its SHA-256, manifest, and empty directory structure, and bundle it with the app. They reject unlocked local templates. Changes to the companion repository's README do not automatically replace a pinned release archive.

## Compatibility

| JiMu Harness | Knowledge schema | Knowledge template |
| --- | --- | --- |
| 0.1.x–0.2.x | 1 | 1.0.x |

Knowledge roots without a manifest but containing the core directories load in `legacy-schema-1` compatibility mode and are not modified merely by being opened. Enabled optional modules must still be present. Invalid or future manifests are rejected without replacing the active knowledge root.

Content-category paths must be real directories. `assets` may be a symlink if it resolves to a directory inside the knowledge root; external, dangling, or non-directory targets are rejected.

## Support and upstream

Report JiMu installation, interface, and knowledge integration problems in [this repository's Issues](https://github.com/i-YOLO/JiMu-Harness/issues). Include the operating system, app version, reproduction steps, and sanitized logs. Do not upload API keys, private conversations, or personal knowledge bases.

For the original DeepSeek Harness Web UI or CLI, see the [upstream documentation](https://github.com/deepseek-ai/deepseek-harness). The maintainer's two-remote setup is documented in [upstream synchronization](docs/jimu/upstream-sync.md); a normal clone does not automatically create or disable an `upstream` remote. Upstream contribution policy is retained in [CONTRIBUTING.md](CONTRIBUTING.md).

## License and brand

Project code is licensed under the [MIT License](LICENSE). JiMu maintains the JiMu-specific portions; DeepSeek's upstream copyright and other third-party notices are retained. Third-party components retain their respective licenses; see [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md).

The MIT License does not grant rights to use the JiMu name, logo, or character artwork as a trademark, product identity, or endorsement; see [TRADEMARKS.md](TRADEMARKS.md). This notice adds no restrictions to MIT-licensed code and does not alter third-party rights.
