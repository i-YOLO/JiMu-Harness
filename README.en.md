# JiMu Harness

[中文](README.md) | English

JiMu Harness is a local-first macOS desktop workspace built on the official [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) and Cordis plugin runtime. It adds a native Electron shell, a JiMu renderer, managed plugin controls, an embedded Harness lifecycle, and an optional Markdown knowledge protocol.

This repository preserves the complete upstream Git history and tags. DeepSeek Harness remains an upstream project authored by DeepSeek AI; JiMu-specific work is maintained as a downstream product layer.

## Privacy boundary

The repository contains no user knowledge, projects, sessions, credentials, analytics, screenshots, or demo records. A first launch has no configured knowledge root and shows a setup state. JiMu does not scan the home directory.

The empty companion template lives in [i-YOLO/JiMu-Knowledge](https://github.com/i-YOLO/JiMu-Knowledge). Git synchronization is intentionally delegated to the user's normal Git tooling; the app does not store repository credentials.

## Architecture

- `apps/jimu-desktop`: Electron main process, preload boundary, plugin policy, Harness lifecycle, native folder selection, and packaging.
- `apps/jimu-ui-preview`: JiMu renderer, read-only knowledge index, and write-on-action media factory.
- `apps/jimu-ui-preview/shared/knowledge-schema.mjs`: the single fixed source for the eight public knowledge categories.
- `packages`, `apps/cli`, `vendor`, and `examples`: upstream DeepSeek Harness. Official examples remain source-only and are excluded from JiMu.app/DMG.

See [JiMu architecture](docs/jimu/architecture.md), [privacy and release boundaries](docs/jimu/privacy.md), and [upstream synchronization](docs/jimu/upstream-sync.md).

<a id="run"></a><a id="run-from-source"></a>

## Development

Requirements: Node.js 22.19+ and pnpm 11.7.

```sh
pnpm install --frozen-lockfile
pnpm run build:lib
JIMU_KNOWLEDGE_TEMPLATE_DIR=/path/to/JiMu-Knowledge \
  pnpm --filter @i-yolo/jimu-desktop prepare:knowledge-template
pnpm --filter @i-yolo/jimu-desktop build
```

Run the browser renderer without local data:

```sh
pnpm --filter @i-yolo/jimu-ui-preview dev
```

Official release builds never accept an unlocked local template. They download the release named in `apps/jimu-desktop/config/knowledge-template-lock.json`, verify SHA-256 and the empty Schema 1 structure, then package it as an `extraResource`.

## Compatibility

| JiMu Harness | Knowledge schema | Knowledge template |
| --- | --- | --- |
| 0.1.x | 1 | 1.0.x |

Roots without a manifest but containing every standard directory are opened as read-only-compatible `legacy-schema-1`. Invalid or future manifests are rejected without replacing the active root.

## Upstream DeepSeek Harness

To use the original DeepSeek Harness Web UI or CLI, consult the [upstream documentation](https://github.com/deepseek-ai/deepseek-harness). JiMu keeps `upstream` fetch-only and does not replace upstream authorship, notices, or the MIT license.

## License and marks

Code is licensed under [MIT](LICENSE), with upstream copyright retained. JiMu names, logos, and character artwork are excluded from the MIT trademark grant; see [TRADEMARKS.md](TRADEMARKS.md). Third-party notices are in [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md).
