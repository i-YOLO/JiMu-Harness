# JiMu architecture

JiMu is a downstream macOS and Windows Electron host, not a generic UI plugin. It embeds the official DeepSeek Harness runtime in the main process and continues to use the Cordis plugin model. The JiMu product layer is split into four boundaries:

1. Electron main owns native dialogs, platform menus and windows, revisioned local configuration, locked Knowledge installation, plugin policy, knowledge-root validation, and bounded Harness restart/rollback.
2. Preload exposes typed, allowlisted APIs; it never exposes `ipcRenderer`, Node filesystem access, or arbitrary path writes.
3. Renderer owns presentation and drafts. It cannot choose an absolute root; folder selection and starter creation are performed by native dialogs.
4. Knowledge and factory services operate on the active validated root. Indexing is read-only. The benchmark library and factory are local optional modules; disabled top-level directories are not scanned, and the factory service is not started when its module is disabled.

Plugin enablement is governed by `config/plugin-policy.json`. Unlisted entries default to locked. Toggleable multi-entry features are written atomically to a JiMu-specific Cordis overlay and take effect after the embedded Harness restarts; the Electron window remains open.

The public knowledge schema defines eight supported categories plus two optional modules. Both Renderer and indexer import `shared/knowledge-schema.mjs`; the module selection stays in mode-`0600` desktop settings rather than the Knowledge repository, and no static card, project, session, or Skill data is available as a fallback.

The native first-run flow blocks the main workspace until the user selects modules, activates a validated Knowledge root, and verifies DeepSeek credentials through the adapter's authenticated `GET /models` discovery. Release installation accepts only the URL and SHA-256 in `knowledge-template-lock.json`, extracts to a bounded temporary directory, and atomically activates it after validation; a packaged template supplies the same protocol when the download fails.

The preload platform field is the renderer's only operating-system presentation input. macOS keeps the inset title bar, application menu, Bash composition, and existing user-data directory. Windows uses the native title-bar overlay, standard Windows menus, the confined PowerShell composition, `%LOCALAPPDATA%\JiMu` user data, and `%USERPROFILE%\JiMu-Knowledge` as the packaged default. Both distributions are built from one commit, while native modules and installer behavior are validated on their target operating system.
