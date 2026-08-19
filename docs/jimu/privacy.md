# Privacy and release boundary

JiMu Harness ships code and a verified empty knowledge template only. It does not ship user content, demo records, QA captures, local indexes, logs, credentials, build caches, or developer paths.

Runtime knowledge-root and optional-module settings are stored under Electron user data with mode `0600` on POSIX and the current user's inherited ACL on Windows. The selected path may be shown locally in Settings but is redacted from public diagnostics and is never added to telemetry. API keys are tested through authenticated model discovery and are written only after success; Harness credential views return configured/source/writable metadata without returning the value.

Every public release must pass:

- filename-only private-term and local-path audit;
- Gitleaks scan of JiMu changes and history;
- source and anonymous-fixture tests;
- empty Knowledge ZIP verification;
- macOS app/DMG and Windows unpacked-resource allowlist, native-platform, and string scans.

Release builds are required to fetch the exact Knowledge Release specified in the lock file. A local template override is development-only and cannot satisfy the release gate.

GitHub pull requests and `main` pushes run the JiMu security, upstream-compatibility, macOS packaged-application, and native Windows installer-lifecycle jobs. Pull-request Windows installers are unsigned. The protected release environment supplies Azure Trusted Signing credentials only to the formal Windows release job, and publishing waits for both platform artifacts. Upstream organization, release, and enterprise CI workflows keep an explicit `deepseek-harness/deepseek-harness` repository guard and are disabled in the JiMu repository. Real DeepSeek API tests run only by manual request or by an explicitly enabled nightly schedule, using a limited repository secret that is separate from every user's local credential.
