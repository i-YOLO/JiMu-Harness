# Agent Note: Preserve Knowledge standard-directory integrity

Status: implemented

English | [中文](2026-08-18-knowledge-standard-directory-integrity.zh.md)

## Problem

JiMu accepts an existing Markdown root only when every Schema 1 core directory and every locally enabled optional-module directory exists. The inspection treated every final-component symlink as a missing directory, including a common local layout where `assets` points to a canonical media directory elsewhere inside the same Knowledge root. Selecting that valid legacy root therefore failed with `Knowledge root is missing standard directory: assets`, even though the target existed and stayed within the root.

The bundled empty template had a separate violation of the same invariant. Its empty protocol directories were represented by `.gitkeep` files, but Electron Builder filters those placeholders while copying `extraResources`. The prepared build cache was complete, while the packaged application silently lacked the directories that contained no other files. Source-level archive validation and content scanning did not observe directory entries, so the release audit passed the incomplete application.

## Decision

Existing-root inspection accepts a real required directory and gives `assets` one bounded alias form: a symlink whose real target is a directory contained by the real Knowledge root. It resolves the root first, resolves the linked asset path, applies path-aware containment, and then verifies the target type. Content-category directories remain real directories so their logical category path cannot diverge from the physical path used by indexing. A missing required path, dangling asset link, non-directory asset target, or asset link escaping the root remains incompatible and receives a distinct diagnostic. This compatibility rule only reads an existing root and does not add a manifest or alter the user's layout. The optional-module selection is owned by [JiMu native first-run setup](../feature/2026-08-18-jimu-native-first-run-setup.md).

The packaged full template remains stricter and contains only real directories. The macOS `afterPack` hook first requires the copied template manifest, recreates every directory in that complete template that Electron Builder omitted, and verifies that each result is a real directory rather than a symlink. The release audit locates the packaged template manifest and inspects directory entries directly; a missing manifest, missing directory, or linked directory fails the release gate.

## Alternatives considered

**Reject every standard-directory symlink.** Rejected because it blocks valid local Knowledge roots that deduplicate media through a contained `assets` link. For this non-content alias, the actual safety boundary is whether the resolved directory remains inside the selected root, not whether the final path component is a link.

**Follow every standard-directory symlink.** Rejected because an untrusted or accidentally changed root could redirect indexing and asset access outside the directory the user selected. Even a contained content-category alias would make its logical category path disagree with its physical index path. Only `assets` receives the bounded exception; content categories stay real directories, and escaping, dangling, and non-directory asset targets remain incompatible.

**Replace the user's link or copy its data.** Rejected because choosing an existing root is read-only validation. JiMu must not rewrite a legacy repository, duplicate potentially large media, or make its Git worktree dirty merely by opening it.

**Commit visible placeholder files instead of repairing the package.** Rejected because the companion Knowledge protocol intentionally leaves business directories empty. Packaging owns preservation of empty directory structure, and the release audit now verifies the delivered artifact rather than changing the source protocol to accommodate a packager filter.

## Consequences

An existing root may keep an internal `assets` alias, including a relative link into its media factory, and is still recognized as `legacy-schema-1` when no manifest exists. Links outside the selected root do not broaden JiMu's read authority. The user's root remains unchanged.

JiMu.app carries every directory in the complete empty template even when `.gitkeep` files are filtered. A future packaging regression fails both the focused security test and the artifact audit. Tests cover contained links, escaping links, dangling links, file targets, after-pack directory restoration, and release-audit enforcement.
