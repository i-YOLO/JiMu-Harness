# Privacy and release boundary

JiMu Harness ships code and a verified empty knowledge template only. It does not ship user content, demo records, QA captures, local indexes, logs, credentials, build caches, or developer paths.

Runtime knowledge-root settings are stored under Electron user data with mode `0600`. The selected path may be shown locally in Settings but is redacted from public diagnostics and is never added to telemetry. API keys are handled by the Harness credentials interface and are never returned in plugin snapshots.

Every public release must pass:

- filename-only private-term and local-path audit;
- Gitleaks scan of JiMu changes and history;
- source and anonymous-fixture tests;
- empty Knowledge ZIP verification;
- JiMu.app/DMG resource allowlist and string scan.

Release builds are required to fetch the exact Knowledge Release specified in the lock file. A local template override is development-only and cannot satisfy the release gate.
