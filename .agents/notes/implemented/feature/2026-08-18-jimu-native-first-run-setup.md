# Agent Note: JiMu native first-run setup

Status: implemented

English | [中文](2026-08-18-jimu-native-first-run-setup.zh.md)

## Problem

JiMu exposed the knowledge, factory, and Agent workspaces before a new installation had selected a Knowledge layout or configured a usable DeepSeek credential. The blank-template action also required the user to choose a parent directory and assumed every published directory was mandatory, even when the benchmark library or media factory was irrelevant to that user. A configured but invalid key failed only after the first prompt, which made local setup look complete before the Agent could run.

## Decision

The Electron product owns one native, revisioned first-run state and withholds the main workspace until three conditions hold: optional modules are selected, a validated local Knowledge root is active, and the DeepSeek credential passes authenticated model discovery. Completion is a durable first-run fact rather than a projection of transient service health. Once complete, Knowledge initialization, module changes, Harness restarts, and credential availability remain in the main workspace; only an explicit reset can reopen first-run setup. Benchmark and factory modules default on but remain independent. Their enabled flags live in the mode-`0600` desktop settings file rather than the Knowledge repository; disabled directories are neither required nor indexed, and a disabled factory has no running service. Disabling never deletes content. Re-enabling a missing module requires confirmation before JiMu atomically copies its empty skeleton from the packaged template.

Default Knowledge installation uses the fixed GitHub Release URL and SHA-256 from `knowledge-template-lock.json`. It downloads into a bounded private temporary directory, accepts the deterministic stored-ZIP encoding, rejects traversal and oversized input, filters disabled module subtrees, validates the result, and atomically renames it into place. A failed download or Release check uses the packaged same-version template and reports that source. Existing targets are never overwritten; a compatible default target is connected as an existing root.

Credential verification belongs to the DeepSeek adapter's `llm-deepseek` model-discovery registration. It calls the resolved endpoint's authenticated `GET /models`, rejects redirects, bounds the response and timeout, and returns model ids only. A draft key crosses the existing write-only discovery request and reaches `credentials.set` only after discovery succeeds. An environment or managed-store key can be resolved inside the adapter for verification without returning it to Electron or Renderer state.

## Alternatives considered

**Keep the old knowledge setup card and let Agent prompts fail on demand.** Rejected because three separate recovery paths make a fresh installation appear usable while its required services are incomplete, and credential failure arrives after the user has already entered a task.

**Store module choices in `jimu-knowledge.json`.** Rejected because opening one repository on another device would dirty the worktree and incorrectly make a device preference part of the portable content protocol.

**Publish one Knowledge archive for each module combination.** Rejected because four assets create avoidable release and checksum drift. One reviewed full archive can be safely filtered while extracting into a temporary directory.

**Test the key with a chat completion.** Rejected because connection setup must not submit conversation content or consume generation tokens. The authenticated model-list endpoint proves the credential and endpoint without a model request.

## Consequences

A new user receives a single three-step JiMu flow and can accept the complete default with one choice. Source runs place the default Knowledge root beside the Harness repository; packaged runs use `~/JiMu-Knowledge`. Interrupted setup resumes from persisted module and root state, while a credential is considered complete only after a successful test. Runtime module changes keep the Settings screen mounted and expose their progress through the affected control instead of replacing the application with first-run setup.

The public Schema 1 category vocabulary remains eight entries, while required directories are resolved from core directories plus locally enabled modules. Official JiMu-Knowledge releases still carry the complete empty tree. Tests cover optional-root validation, disabled-directory indexing, bounded installation and fallback, module skeleton creation, credential authentication and error redaction, and the Electron first-run gate.
