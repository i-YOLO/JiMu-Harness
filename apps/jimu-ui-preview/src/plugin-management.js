const FILTER_PREDICATES = {
  all: () => true,
  enabled: (entry) => entry.enabled,
  disabled: (entry) => !entry.enabled,
  failed: (entry) => entry.fiberPhase === "failed",
  manageable: (entry) => entry.management !== "locked",
  locked: (entry) => entry.management === "locked",
};

export const PLUGIN_FILTERS = [
  { id: "all", label: "全部" },
  { id: "enabled", label: "已启用" },
  { id: "disabled", label: "已停用" },
  { id: "failed", label: "失败" },
  { id: "manageable", label: "可管理" },
  { id: "locked", label: "系统锁定" },
];

export function filterPluginEntries(entries, query, filter) {
  const normalized = query.trim().toLocaleLowerCase("zh-CN");
  const predicate = FILTER_PREDICATES[filter] ?? FILTER_PREDICATES.all;
  return entries
    .filter(predicate)
    .filter((entry) => !normalized || `${entry.moduleName} ${entry.entryId}`.toLocaleLowerCase("zh-CN").includes(normalized))
    .sort((left, right) => left.moduleName.localeCompare(right.moduleName, "zh-CN"));
}

export function validatePluginConfig(namespace, draft) {
  const errors = {};
  const positiveInteger = (field, label) => {
    const text = String(draft[field] ?? "").trim();
    if (!text) return;
    const value = Number(text);
    if (!Number.isSafeInteger(value) || value < 1) errors[field] = `${label}必须是正整数`;
  };
  if (namespace === "shell") {
    positiveInteger("timeoutMs", "超时时间");
    positiveInteger("maxOutputBytes", "输出上限");
  } else if (namespace === "agent-loop") {
    positiveInteger("maxParallelToolCalls", "并行工具数");
  } else if (namespace === "web-search-deepseek") {
    positiveInteger("maxUses", "单次搜索次数");
    const baseURL = String(draft.baseURL ?? "").trim();
    if (baseURL) {
      try {
        const parsed = new URL(baseURL);
        if (!new Set(["http:", "https:"]).has(parsed.protocol)) errors.baseURL = "仅支持 HTTP 或 HTTPS 地址";
      } catch {
        errors.baseURL = "请输入完整的 HTTP 或 HTTPS 地址";
      }
    }
  }
  return errors;
}

export function configOps(fields, draft) {
  return fields.map(({ name, type }) => {
    const text = String(draft[name] ?? "").trim();
    if (!text) return { op: "unset", path: [name] };
    return { op: "set", path: [name], value: type === "number" ? Number(text) : text };
  });
}

export function previewPluginSnapshot() {
  const groups = [
    ["session-title", "自动会话标题", "使用模型为新会话生成简短标题。", "agent", ["session-title-llm"]],
    ["web-search", "DeepSeek 联网搜索", "让 Agent 使用 DeepSeek 搜索提供方查询网络信息。", "tools", ["web-search-deepseek", "tool-web"]],
    ["skills", "Skill 能力", "发现本地 Skill，并向 Agent 提供目录与加载工具。", "knowledge", ["skill-filesystem", "skill-badge", "tool-skill"]],
    ["background-jobs", "后台任务工具", "管理长时间运行的后台任务。", "tools", ["tool-jobs"]],
    ["subagents", "子 Agent", "创建、控制和汇总进程内子 Agent。", "agent", ["subagent-spawn-in-process", "tool-subagent"]],
    ["workflow", "Workflow", "运行 Worker Thread 承载的结构化工作流。", "workflow", ["workflow-worker-thread", "tool-workflow"]],
    ["task-helpers", "任务与目标辅助", "提供 Todo、Goal 与持续执行辅助工具。", "workflow", ["tool-todo", "tool-goal", "tool-ralph"]],
  ].map(([id, label, description, category, entryIds]) => ({
    id, label, description, category, entryIds, presentEntryIds: entryIds,
    enabled: true, mixed: false, management: "toggleable", restartRequired: true,
  }));
  const entries = groups.flatMap((group) => group.entryIds.map((entryId) => ({
    entryId,
    moduleName: `@deepseek-ai/dsh-${entryId}`,
    enabled: true,
    fiberPhase: "active",
    policyGroupId: group.id,
    management: "toggleable",
  })));
  entries.push({
    entryId: "agent-loop",
    moduleName: "@deepseek-ai/dsh-agent-loop",
    enabled: true,
    fiberPhase: "active",
    policyGroupId: "agent-loop-settings",
    management: "configurable",
    lockedReason: "Agent Loop 是所有会话的核心运行循环，不能停用。",
  });
  entries.push({
    entryId: "jimu-electron-bridge",
    moduleName: "@deepseek-ai/dsh-jimu-electron-bridge",
    enabled: true,
    fiberPhase: "active",
    management: "locked",
    lockedReason: "JiMu 桌面桥接属于系统核心插件。",
  });
  return { revision: "preview", harnessPhase: "ready", groups, entries };
}
