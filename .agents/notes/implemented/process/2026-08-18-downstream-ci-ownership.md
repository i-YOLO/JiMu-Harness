# Agent Note: JiMu owns downstream CI and release governance

Status: implemented

English | [中文](2026-08-18-downstream-ci-ownership.zh.md)

## Problem

JiMu preserves the complete DeepSeek Harness source history, including workflows that assume the upstream organization, GitHub App credentials, package namespace, release registries, and enterprise runner policy. Running those workflows unchanged in the downstream repository produces failures unrelated to JiMu behavior and makes a release commit indistinguishable from an unverified local upload.

Synthetic credential fixtures create a second ambiguity. Secret scanners correctly recognize their production-like syntax, but a downstream release needs to distinguish a reviewed redaction fixture from a credential introduced by JiMu code without weakening the scan of new changes.

## Decision

`JiMu downstream gates` is the only automatic product workflow owned by the downstream repository. It exposes three stable jobs: a source and history security scan, a bounded Node 24 upstream-compatibility run, and a macOS JiMu Desktop build and test run. The workflow is reusable, so the manual macOS release repeats the same jobs before building, mounting, auditing, checksumming, and publishing a DMG from the exact `main` commit. JiMu-owned remote actions use reviewed full commit SHAs and current Node 24-compatible action runtimes.

Electron Builder resolves the distribution for the manifest's locked Electron version. The packaging configuration must not point `electronDist` at a workspace-local `node_modules` path because pnpm's CI layout does not guarantee that path exists.

The desktop package declares its public repository metadata and invokes Electron Builder with `--publish never`. The workflow does not expose `GH_TOKEN` to build, smoke, or audit steps; the token is scoped only to release existence checks and the final `gh release create` command. This prevents Electron Builder from inferring an implicit publisher while keeping the explicit GitHub Release operation authorized.

Gitleaks runs before dependency installation, loads `.gitleaks.toml` explicitly, and scans both the source tree and `upstream/master..HEAD`. The allowlist names reviewed upstream fixture paths; it does not suppress a rule or an arbitrary credential value. Generated dependency, build, coverage, and release directories are excluded from the source scan and are handled by the release audit instead. A temporary high-entropy negative control proves on every run that a newly introduced credential still fails the job.

Every independent job in an upstream-only workflow checks that `github.repository` is `deepseek-harness/deepseek-harness`. The JiMu repository also disables those workflows after the guard lands. The source remains available for upstream synchronization, while JiMu pull requests spend runner time only on the downstream jobs and CodeQL.

Real DeepSeek API tests have manual and scheduled triggers only. A repository variable enables the scheduled run, and the test reads a limited repository secret that is unrelated to application credentials. The real-API job is not a required merge check.

`main` requires a pull request, the three JiMu jobs, current-base validation, resolved review threads, linear history, and protection from deletion or non-fast-forward updates. The repository owner retains an audited emergency bypass. CodeQL and dependency vulnerability alerts add evidence without becoming initial release blockers.

## Alternatives considered

**Recreate the upstream organization infrastructure.** Rejected because JiMu neither owns nor needs DeepSeek's issue-management App, npm release families, enterprise runners, or organization secrets. A partial imitation would create privileged infrastructure whose only purpose is to satisfy checks for a different repository.

**Run only JiMu package tests.** Rejected because the desktop embeds upstream libraries. A bounded build, typecheck, lint, and unit-test lane catches integration drift without inheriting the complete platform and publication matrix.

**Run the real API suite on every main push.** Rejected because external availability, account balance, and model behavior would turn a merge check into a variable-cost service probe. Manual and explicitly enabled nightly runs preserve the signal without exposing secrets to pull requests.

**Rewrite upstream history to remove synthetic credentials.** Rejected because the fixture is public test data and the complete upstream history is intentional. The alert is resolved as test usage, while downstream scans continue to reject new credentials.

## Consequences

- JiMu owns stable required-check names and can protect `main` without depending on upstream organization state.
- An upstream workflow update must retain the repository guard or the downstream workflow test fails.
- Releases take longer because they repeat the three required jobs before packaging, but each asset is tied to independently recorded CI evidence.
- A scheduled real-API run remains inactive until both the opt-in variable and dedicated secret are configured.
- Upstream workflow files remain in the repository and still require conflict resolution during synchronization, even though they do not execute for JiMu.
- Two pre-existing DeepSeek model-discovery assertions were rewritten to inspect typed mock calls directly so the compatibility lint lane starts from a clean downstream baseline; test behavior is unchanged.
