# JiMu architecture

JiMu is a downstream Electron host, not a generic UI plugin. It embeds the
official DeepSeek Harness runtime in the main process and continues to use the
Cordis plugin model. The JiMu product layer is split into four boundaries:

1. Electron main owns native dialogs, local configuration, plugin policy,
   knowledge-root validation, and bounded Harness restart/rollback.
2. Preload exposes typed, allowlisted APIs; it never exposes `ipcRenderer`, Node
   filesystem access, or arbitrary path writes.
3. Renderer owns presentation and drafts. It cannot choose an absolute root;
   folder selection and starter creation are performed by native dialogs.
4. Knowledge and factory services operate on the active validated root. Indexing
   is read-only. Factory directories are created only by explicit write actions.

Plugin enablement is governed by `config/plugin-policy.json`. Unlisted entries
default to locked. Toggleable multi-entry features are written atomically to a
JiMu-specific Cordis overlay and take effect after the embedded Harness restarts;
the Electron window remains open.

The public knowledge schema is fixed at eight categories. Both Renderer and
indexer import `shared/knowledge-schema.mjs`; no static card, project, session,
or Skill data is available as a fallback.
