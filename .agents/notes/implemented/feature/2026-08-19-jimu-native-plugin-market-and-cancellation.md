# Agent Note: JiMu native plugin installation and authoritative cancellation

Status: implemented

English | [中文](2026-08-19-jimu-native-plugin-market-and-cancellation.zh.md)

## Problem

JiMu embeds the Harness host without the official HTTP server, Web runtime, client-module loader, or Settings UI, so a community Web marketplace cannot render inside the Electron application. The existing plugin page projected only the live Loader inventory, which made searching for an uninstalled package look like a failed marketplace search.

The desktop composer also kept a renderer-local sending flag. Reconnection and session navigation could disagree with the attached Agent, and a cancellation reason shared through `AbortSignal.reason` could be changed before the closing `turn/end` event copied it into durable data.

## Decision

JiMu owns one native marketplace in its existing Electron renderer. The main process reads the public community catalog with a bundled fallback, resolves npm or public GitHub sources to immutable proposals, and exposes only structured inspect, install, enable, disable, update, uninstall, and operation-cancellation IPC methods.

An installation mutates a copied Web profile with JiMu's packaged pnpm runtime. The main process verifies the approved integrity or commit, the installed name and version, and the contained `dsh.bundle.patch` before stopping the embedded Harness and atomically activating the staged profile. Startup failure restores the previous profile before the operation reports failure.

The conversation model may search the catalog and prepare a proposal, but only a human action in the renderer can install it. Catalog descriptions remain untrusted text, lifecycle scripts require an exact per-package approval, and official-Web-only or terminal-only packages are rejected for the JiMu profile.

The composer derives its action from each Session's authoritative running state plus renderer-local submission and cancellation transitions. `Agent.cancel` snapshots the typed cause before abort propagation; runtime consumers still receive the original reason, while `turn/end` receives the detached JSON value.

## Alternatives considered

**Enable the official DSH Web UI inside Electron.** This would let Web marketplace plugins render unchanged, but would restore an HTTP server, a second browser runtime, and a competing settings application that JiMu deliberately removes.

**Let the model run `dsh plugin` through Shell.** The command cannot provide a stable human approval, integrity pin, profile rollback, or self-restart contract, and the default workspace sandbox does not own the machine-level profile.

**Write packages directly into the live profile.** This is smaller, but a failed package script, invalid patch, or boot error can leave the only profile unusable. Staging keeps the live profile unchanged until validation succeeds.

## Consequences

Development and packaged builds use the same plugin APIs and pnpm executable, while platform adapters only own process-tree termination and filesystem replacement behavior. Plugin state stays in the per-user Harness home and survives application upgrades.

JiMu carries a catalog snapshot and a package-manager runtime, increasing the application size and the maintenance cost of catalog compatibility. Community plugins that depend on official Web slots may expose working host tools without their original settings page; the marketplace labels that limitation before installation.

Focused unit tests pin catalog normalization, immutable proposals, staged enablement, and rollback. Electron tests use isolated user data to pin live catalog search, package installation and removal, Harness restart, and model-turn cancellation without touching a user's Knowledge or profile.
