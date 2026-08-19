import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  ArrowClockwise,
  CaretDown,
  CaretRight,
  Check,
  DownloadSimple,
  FloppyDisk,
  LockSimple,
  MagnifyingGlass,
  PlugsConnected,
  PuzzlePiece,
  SlidersHorizontal,
  Trash,
  WarningCircle,
  X,
} from "@phosphor-icons/react";
import {
  PLUGIN_FILTERS,
  configOps,
  filterPluginEntries,
  previewPluginSnapshot,
  validatePluginConfig,
} from "./plugin-management.js";

const CATEGORY_LABELS = {
  agent: "AGENT",
  tools: "TOOLS",
  knowledge: "KNOWLEDGE",
  workflow: "WORKFLOW",
  system: "SYSTEM",
};

const CONFIG_DEFINITIONS = [
  {
    ns: "shell",
    eyebrow: "SHELL",
    title: "Shell 执行",
    description: "控制每条命令的默认超时和单个输出流在内存中的最大字节数。",
    fields: [
      { name: "timeoutMs", label: "timeoutMs", type: "number", suffix: "ms", placeholder: "120000" },
      { name: "maxOutputBytes", label: "maxOutputBytes", type: "number", suffix: "bytes", placeholder: "64000" },
    ],
  },
  {
    ns: "agent-loop",
    eyebrow: "AGENT LOOP",
    title: "Agent Loop",
    description: "限制一次模型响应中同时运行的工具调用数量。",
    fields: [
      { name: "maxParallelToolCalls", label: "maxParallelToolCalls", type: "number", suffix: "calls", placeholder: "10" },
    ],
  },
  {
    ns: "web-search-deepseek",
    eyebrow: "DEEPSEEK WEB SEARCH",
    title: "DeepSeek 联网搜索",
    description: "设置搜索端点、单次请求使用次数和只写 API Key。",
    fields: [
      { name: "baseURL", label: "baseURL", type: "text", placeholder: "https://api.deepseek.com/anthropic" },
      { name: "maxUses", label: "maxUses", type: "number", suffix: "uses", placeholder: "5" },
    ],
    secret: true,
  },
];

function phaseLabel(entry) {
  if (!entry.enabled) return "DISABLED";
  if (entry.fiberPhase === "failed") return "FAILED";
  return String(entry.fiberPhase ?? "ENABLED").toLocaleUpperCase("en-US");
}

function Toggle({ checked, disabled, label, onChange }) {
  return (
    <button
      type="button"
      className="plugin-toggle"
      role="switch"
      aria-checked={checked}
      aria-label={label}
      disabled={disabled}
      onClick={() => onChange(!checked)}
    >
      <span />
    </button>
  );
}

function OptionalFeatures({ snapshot, pending, setPending }) {
  const groups = snapshot.groups.filter((group) => group.management === "toggleable");
  return (
    <div className="plugin-feature-grid">
      {groups.map((group, index) => {
        const complete = group.presentEntryIds.length === group.entryIds.length;
        const enabled = pending[group.id] ?? group.enabled;
        return (
          <article className="plugin-feature-card" data-enabled={enabled || undefined} data-accent={index % 3} key={group.id}>
            <span className="plugin-card-number">{String(index + 1).padStart(2, "0")}</span>
            <div className="plugin-feature-head">
              <span className="plugin-feature-icon"><PuzzlePiece size={21} weight="duotone" /></span>
              <span className="plugin-category">{CATEGORY_LABELS[group.category] ?? "PLUGIN"}</span>
              <Toggle
                checked={enabled}
                disabled={!complete || snapshot.harnessPhase !== "ready"}
                label={`${enabled ? "关闭" : "开启"}${group.label}`}
                onChange={(value) => setPending((current) => ({ ...current, [group.id]: value }))}
              />
            </div>
            <h3>{group.label}</h3>
            <p>{group.description}</p>
            <div className="plugin-feature-meta">
              <span>{group.entryIds.length} PLUGINS</span>
              <strong data-state={enabled ? "active" : "disabled"}>{enabled ? "● ACTIVE" : "○ DISABLED"}</strong>
            </div>
            {!complete && <small className="plugin-feature-warning"><WarningCircle size={13} />当前版本缺少部分条目，暂不可修改</small>}
          </article>
        );
      })}
    </div>
  );
}

function AllPlugins({ snapshot }) {
  const [query, setQuery] = useState("");
  const [filter, setFilter] = useState("all");
  const [expanded, setExpanded] = useState(new Set());
  const visible = useMemo(() => filterPluginEntries(snapshot.entries, query, filter), [filter, query, snapshot.entries]);
  return (
    <div className="plugin-inventory">
      <div className="plugin-inventory-tools">
        <label className="plugin-search">
          <MagnifyingGlass size={16} weight="bold" />
          <span className="sr-only">搜索当前运行清单</span>
          <input value={query} onChange={(event) => setQuery(event.target.value)} placeholder="搜索当前已加载的 Loader" />
          {query && <button type="button" aria-label="清空搜索" onClick={() => setQuery("")}><X size={13} /></button>}
        </label>
        <label className="plugin-filter">
          <SlidersHorizontal size={15} weight="bold" />
          <span className="sr-only">筛选插件</span>
          <select value={filter} onChange={(event) => setFilter(event.target.value)}>
            {PLUGIN_FILTERS.map((item) => <option value={item.id} key={item.id}>{item.label}</option>)}
          </select>
        </label>
      </div>
      <div className="plugin-inventory-summary">
        <span>{visible.length} / {snapshot.entries.length} ENTRIES</span>
        <small>数据来自当前 Harness pluginInventory/list</small>
      </div>
      <div className="plugin-inventory-grid">
        {visible.map((entry) => {
          const open = expanded.has(entry.entryId);
          const state = phaseLabel(entry);
          return (
            <article className="plugin-inventory-card" data-state={state.toLocaleLowerCase("en-US")} key={entry.entryId}>
              <button
                type="button"
                className="plugin-inventory-card-main"
                aria-expanded={open}
                onClick={() => setExpanded((current) => {
                  const next = new Set(current);
                  if (next.has(entry.entryId)) next.delete(entry.entryId); else next.add(entry.entryId);
                  return next;
                })}
              >
                {open ? <CaretDown size={15} weight="bold" /> : <CaretRight size={15} weight="bold" />}
                <PuzzlePiece size={20} weight="duotone" />
                <span><strong>{entry.moduleName}</strong><small>{entry.entryId}</small></span>
                <em>{state}</em>
                {entry.management !== "toggleable" ? <LockSimple size={16} weight="fill" aria-label="停用操作已锁定" /> : <SlidersHorizontal size={16} weight="bold" aria-label="策略可管理" />}
              </button>
              {open && (
                <dl className="plugin-inventory-detail">
                  <div><dt>MODULE</dt><dd>{entry.moduleName}</dd></div>
                  <div><dt>LOADER ID</dt><dd>{entry.entryId}</dd></div>
                  <div><dt>ENABLED</dt><dd>{entry.enabled ? "true" : "false"}</dd></div>
                  <div><dt>FIBER</dt><dd>{entry.fiberPhase ?? "—"}</dd></div>
                  <div><dt>POLICY</dt><dd>{entry.management}</dd></div>
                  {entry.lockedReason && <div className="plugin-lock-reason"><dt><LockSimple size={12} /> LOCKED</dt><dd>{entry.lockedReason}</dd></div>}
                </dl>
              )}
            </article>
          );
        })}
        {visible.length === 0 && <div className="plugin-empty"><MagnifyingGlass size={27} weight="duotone" /><strong>当前运行实例未加载该插件</strong><span>调整筛选条件，或前往“插件市场”搜索并安装。</span></div>}
      </div>
    </div>
  );
}

function valueDraft(definition, descriptor) {
  const value = descriptor?.value ?? {};
  return Object.fromEntries(definition.fields.map((field) => [field.name, value[field.name] === undefined ? "" : String(value[field.name])]));
}

function ConfigCard({ definition, descriptor, writable, credential, draft, baseline, apiKey, setDraft, setApiKey, onSave, onReload, saving }) {
  const errors = validatePluginConfig(definition.ns, draft);
  const dirty = JSON.stringify(draft) !== JSON.stringify(baseline) || Boolean(apiKey);
  const disabled = !writable || !descriptor;
  return (
    <article className="plugin-config-card" data-disabled={disabled || undefined}>
      <div className="plugin-config-head">
        <span><small>{definition.eyebrow}</small><strong>{definition.title}</strong></span>
        <em>{descriptor?.applies === "live" ? "LIVE + RESTART" : "RESTART REQUIRED"}</em>
      </div>
      <p>{definition.description}</p>
      {!descriptor && <div className="plugin-config-readonly"><LockSimple size={14} />当前 Harness 未注册此配置 namespace。</div>}
      {descriptor && !writable && <div className="plugin-config-readonly"><LockSimple size={14} />当前设置提供方只读，无法从 JiMu 修改。</div>}
      <div className="plugin-config-fields">
        {definition.fields.map((field) => (
          <label key={field.name}>
            <span>{field.label}</span>
            <span className="plugin-config-input">
              <input
                type={field.type}
                min={field.type === "number" ? 1 : undefined}
                value={draft[field.name] ?? ""}
                placeholder={field.placeholder}
                disabled={disabled || saving}
                aria-invalid={Boolean(errors[field.name])}
                onChange={(event) => setDraft((current) => ({ ...current, [field.name]: event.target.value }))}
              />
              {field.suffix && <em>{field.suffix}</em>}
            </span>
            {errors[field.name] && <small className="plugin-field-error">{errors[field.name]}</small>}
          </label>
        ))}
        {definition.secret && (
          <label>
            <span>API Key</span>
            <span className="plugin-config-input plugin-key-input">
              <LockSimple size={14} weight="fill" />
              <input
                type="password"
                autoComplete="off"
                value={apiKey}
                placeholder={credential.configured ? "已配置 · 输入新 Key 可替换" : "未配置 · 输入 DEEPSEEK_API_KEY"}
                disabled={disabled || !credential.writable || saving}
                onChange={(event) => setApiKey(event.target.value)}
              />
              <em>{credential.configured ? "CONFIGURED" : "EMPTY"}</em>
            </span>
            {!credential.writable && <small className="plugin-field-error">该凭据由环境变量提供，JiMu 不会覆盖。</small>}
          </label>
        )}
      </div>
      <div className="plugin-config-actions">
        <button type="button" disabled={disabled || saving} onClick={() => {
          setDraft(Object.fromEntries(definition.fields.map((field) => [field.name, ""])));
          setApiKey("");
        }}>重置默认</button>
        <button type="button" disabled={!dirty || saving} onClick={onReload}>放弃</button>
        <button type="button" className="plugin-config-save" disabled={disabled || !dirty || Object.keys(errors).length > 0 || saving} onClick={onSave}>
          <FloppyDisk size={14} weight="bold" />{saving ? "保存中" : "保存并重启"}
        </button>
      </div>
    </article>
  );
}

function PluginConfiguration({ desktop, runtimePhase, onRuntimePhase }) {
  const [phase, setPhase] = useState(desktop ? "loading" : "preview");
  const [descriptors, setDescriptors] = useState({});
  const [writable, setWritable] = useState(true);
  const [credential, setCredential] = useState({ configured: !desktop, writable: true, source: desktop ? undefined : "preview" });
  const [drafts, setDrafts] = useState({});
  const [baselines, setBaselines] = useState({});
  const [apiKey, setApiKey] = useState("");
  const [saving, setSaving] = useState("");
  const [message, setMessage] = useState(null);

  const load = useCallback(async (keepDrafts = false) => {
    if (!desktop) {
      const fake = Object.fromEntries(CONFIG_DEFINITIONS.map((definition) => [definition.ns, { ns: definition.ns, value: {}, revision: 0, applies: "restart" }]));
      const nextDrafts = Object.fromEntries(CONFIG_DEFINITIONS.map((definition) => [definition.ns, valueDraft(definition, fake[definition.ns])]));
      setDescriptors(fake); setDrafts(nextDrafts); setBaselines(nextDrafts); setPhase("preview");
      return;
    }
    try {
      const [described, credentials] = await Promise.all([
        globalThis.window.jimu.harness.call("settings.describe", {}),
        globalThis.window.jimu.harness.call("credentials.describe", { refs: ["DEEPSEEK_API_KEY"] }),
      ]);
      const nextDescriptors = Object.fromEntries(described.namespaces.map((item) => [item.ns, item]));
      const nextBaselines = Object.fromEntries(CONFIG_DEFINITIONS.map((definition) => [definition.ns, valueDraft(definition, nextDescriptors[definition.ns])]));
      setDescriptors(nextDescriptors);
      setWritable(described.writable !== false);
      setCredential(credentials.credentials.DEEPSEEK_API_KEY ?? { configured: false, writable: true });
      setBaselines(nextBaselines);
      if (!keepDrafts) { setDrafts(nextBaselines); setApiKey(""); }
      setPhase("ready");
    } catch (error) {
      setPhase("error");
      setMessage({ type: "error", text: error instanceof Error ? error.message : String(error) });
    }
  }, [desktop]);

  useEffect(() => { void load(false); }, [load]);

  async function save(definition) {
    const draft = drafts[definition.ns] ?? {};
    if (Object.keys(validatePluginConfig(definition.ns, draft)).length > 0) return;
    setSaving(definition.ns);
    setMessage(null);
    try {
      const descriptor = descriptors[definition.ns];
      await globalThis.window.jimu.harness.call("settings.mutate", {
        ns: definition.ns,
        ops: configOps(definition.fields, draft),
        expectedRevision: descriptor.revision,
      });
      if (definition.secret && apiKey.trim()) {
        if (!credential.writable) throw new Error("API Key 由环境变量提供，当前不可写。 ");
        await globalThis.window.jimu.harness.call("credentials.set", { ref: "DEEPSEEK_API_KEY", value: apiKey.trim() });
      }
      onRuntimePhase("restarting");
      await globalThis.window.jimu.plugins.restart();
      onRuntimePhase("ready");
      await load(false);
      setMessage({ type: "success", text: `${definition.title}已保存，Harness 已重新启动。` });
    } catch (error) {
      onRuntimePhase(runtimePhase === "restarting" ? "ready" : runtimePhase);
      const text = error instanceof Error ? error.message : String(error);
      setMessage({ type: "error", text: text.includes("settings-conflict") ? "配置已被其他页面修改。已读取最新 revision，请确认草稿后再次保存。" : text });
      await load(true);
    } finally {
      setSaving("");
    }
  }

  return (
    <div className="plugin-configuration">
      {message && <div className="plugin-inline-message" data-type={message.type}><span>{message.type === "success" ? <Check size={14} weight="bold" /> : <WarningCircle size={14} weight="bold" />}{message.text}</span><button type="button" aria-label="关闭提示" onClick={() => setMessage(null)}><X size={13} /></button></div>}
      {phase === "loading" && <div className="plugin-loading"><span className="index-loader" />正在读取插件配置…</div>}
      <div className="plugin-config-grid">
        {CONFIG_DEFINITIONS.map((definition) => (
          <ConfigCard
            key={definition.ns}
            definition={definition}
            descriptor={descriptors[definition.ns]}
            writable={writable}
            credential={credential}
            draft={drafts[definition.ns] ?? {}}
            baseline={baselines[definition.ns] ?? {}}
            apiKey={definition.secret ? apiKey : ""}
            setDraft={(next) => setDrafts((current) => ({ ...current, [definition.ns]: typeof next === "function" ? next(current[definition.ns] ?? {}) : next }))}
            setApiKey={definition.secret ? setApiKey : () => {}}
            onReload={() => { setDrafts((current) => ({ ...current, [definition.ns]: baselines[definition.ns] ?? {} })); if (definition.secret) setApiKey(""); }}
            onSave={() => { void save(definition); }}
            saving={saving === definition.ns}
          />
        ))}
      </div>
    </div>
  );
}

const COMPATIBILITY_LABELS = {
  full: "完全兼容 JiMu",
  "host-only": "宿主能力可用 · 官方 Web 配置页不可用",
  "official-web-only": "官方 Web UI 专用",
  "terminal-only": "终端 / TUI 专用",
  incompatible: "与当前 JiMu 不兼容",
};

function PluginProposalDialog({ proposal, installing, onClose, onInstall }) {
  const [allowed, setAllowed] = useState([]);
  if (!proposal) return null;
  return (
    <div className="plugin-market-modal-backdrop" role="presentation">
      <section className="plugin-market-modal" role="dialog" aria-modal="true" aria-labelledby="plugin-proposal-title">
        <header>
          <span><small>PLUGIN INSTALL PROPOSAL</small><strong id="plugin-proposal-title">确认安装 {proposal.packageName}</strong></span>
          <button type="button" aria-label="关闭安装确认" onClick={onClose} disabled={installing}><X size={15} /></button>
        </header>
        <dl>
          <div><dt>版本</dt><dd>{proposal.version}</dd></div>
          <div><dt>来源</dt><dd>{proposal.resolvedSource}</dd></div>
          <div><dt>完整性</dt><dd>{proposal.integrityOrCommit}</dd></div>
          <div><dt>兼容性</dt><dd>{COMPATIBILITY_LABELS[proposal.compatibility] ?? proposal.compatibility}</dd></div>
          <div><dt>许可证</dt><dd>{proposal.license ?? "未声明"}</dd></div>
        </dl>
        {proposal.buildPackages.length > 0 && (
          <div className="plugin-build-approval">
            <strong>该插件请求执行安装脚本</strong>
            <p>插件代码将在 Agent 沙箱之外运行。只勾选你已审核源码的包。</p>
            {proposal.buildPackages.map((name) => (
              <label key={name}>
                <input type="checkbox" checked={allowed.includes(name)} onChange={(event) => setAllowed((current) => event.target.checked ? [...current, name] : current.filter((item) => item !== name))} />
                {name}
              </label>
            ))}
          </div>
        )}
        <footer>
          <button type="button" onClick={onClose} disabled={installing}>取消</button>
          <button
            type="button"
            className="plugin-market-install-primary"
            disabled={installing || allowed.length !== proposal.buildPackages.length}
            onClick={() => onInstall(allowed)}
          ><DownloadSimple size={14} weight="bold" />{installing ? "安装中…" : "确认安装"}</button>
        </footer>
      </section>
    </div>
  );
}

function PluginMarketplace({ desktop, installed, onSnapshot, operation }) {
  const [query, setQuery] = useState("");
  const [items, setItems] = useState([]);
  const [catalog, setCatalog] = useState({ source: "bundled", updated: null, total: 0 });
  const [loading, setLoading] = useState(desktop);
  const [error, setError] = useState(null);
  const [proposal, setProposal] = useState(null);
  const [installing, setInstalling] = useState(false);
  const installedNames = useMemo(() => new Set(installed.map((item) => item.packageName)), [installed]);

  useEffect(() => {
    if (!desktop) return undefined;
    let active = true;
    const timer = setTimeout(() => {
      setLoading(true);
      setError(null);
      void globalThis.window.jimu.plugins.searchCatalog({ query, category: "all" }).then((result) => {
        if (!active) return;
        setItems(result.items ?? []);
        setCatalog({ source: result.source, updated: result.updated ?? null, total: result.total ?? 0 });
      }).catch((cause) => {
        if (active) setError(cause instanceof Error ? cause.message : String(cause));
      }).finally(() => { if (active) setLoading(false); });
    }, 180);
    return () => { active = false; clearTimeout(timer); };
  }, [desktop, query]);

  async function inspect(source) {
    setError(null);
    try {
      setProposal(await globalThis.window.jimu.plugins.inspect({ source }));
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    }
  }

  async function install(allowedBuildPackages, stopRunning = false) {
    if (!proposal || installing) return;
    setInstalling(true);
    setError(null);
    try {
      const next = await globalThis.window.jimu.plugins.install({ proposalId: proposal.proposalId, allowedBuildPackages, stopRunning });
      setProposal(null);
      onSnapshot(next);
    } catch (cause) {
      const text = cause instanceof Error ? cause.message : String(cause);
      if (!stopRunning && text.includes("Agent 任务正在运行") && globalThis.confirm("有 Agent 任务正在运行。停止所有任务并继续安装吗？")) {
        setInstalling(false);
        await install(allowedBuildPackages, true);
        return;
      }
      setError(text);
    } finally {
      setInstalling(false);
    }
  }

  return (
    <div className="plugin-marketplace">
      <div className="plugin-inventory-tools">
        <label className="plugin-search">
          <MagnifyingGlass size={16} weight="bold" />
          <span className="sr-only">搜索插件市场</span>
          <input value={query} onChange={(event) => setQuery(event.target.value)} placeholder="搜索插件名称、作者或能力" />
          {query && <button type="button" aria-label="清空搜索" onClick={() => setQuery("")}><X size={13} /></button>}
        </label>
        <div className="plugin-catalog-source"><strong>{catalog.source === "online" ? "在线目录" : "离线快照"}</strong><small>{catalog.updated ? `更新于 ${catalog.updated}` : `${catalog.total} 个结果`}</small></div>
      </div>
      {error && <div className="plugin-inline-message" data-type="error"><span><WarningCircle size={14} />{error}</span></div>}
      {operation && !["completed", "error", "cancelled"].includes(operation.phase) && (
        <div className="plugin-operation-progress"><span style={{ width: `${operation.progress}%` }} /><strong>{operation.message}</strong></div>
      )}
      <div className="plugin-market-grid">
        {loading && <div className="plugin-loading"><span className="index-loader" />正在搜索插件目录…</div>}
        {!loading && items.map((entry) => {
          const alreadyInstalled = installedNames.has(entry.npm ?? entry.name);
          const blocked = entry.compatibility === "official-web-only" || entry.compatibility === "terminal-only" || entry.compatibility === "incompatible";
          return (
            <article className="plugin-market-card" data-compatibility={entry.compatibility} key={`${entry.owner}/${entry.name}`}>
              <header><PuzzlePiece size={21} weight="duotone" /><span><strong>{entry.name}</strong><small>{entry.owner} · {entry.category}</small></span><em>★ {entry.stars}</em></header>
              <p>{entry.description}</p>
              <div className="plugin-market-compatibility">{COMPATIBILITY_LABELS[entry.compatibility] ?? entry.compatibility}</div>
              <footer><a href={entry.repository} onClick={(event) => { event.preventDefault(); void globalThis.window.jimu.shell.openExternal(entry.repository); }}>查看源码</a><button type="button" disabled={blocked || alreadyInstalled || installing} onClick={() => { void inspect(entry.source); }}>{alreadyInstalled ? "已安装" : blocked ? "不兼容" : "检查并安装"}</button></footer>
            </article>
          );
        })}
        {!loading && items.length === 0 && <div className="plugin-empty"><MagnifyingGlass size={27} /><strong>没有找到插件</strong><span>换一个名称或能力关键词后再试。</span></div>}
      </div>
      <PluginProposalDialog proposal={proposal} installing={installing} onClose={() => setProposal(null)} onInstall={(allowed) => { void install(allowed); }} />
    </div>
  );
}

function InstalledPlugins({ desktop, snapshot, onSnapshot }) {
  const [busy, setBusy] = useState("");
  const [error, setError] = useState(null);
  const [proposal, setProposal] = useState(null);
  const installed = snapshot.installedPackages ?? [];

  async function setEnabled(plugin, enabled, stopRunning = false) {
    setBusy(plugin.packageName); setError(null);
    try {
      onSnapshot(await globalThis.window.jimu.plugins.setEnabled({ packageName: plugin.packageName, enabled, stopRunning }));
    } catch (cause) {
      const text = cause instanceof Error ? cause.message : String(cause);
      if (!stopRunning && text.includes("Agent 任务正在运行") && globalThis.confirm("有 Agent 任务正在运行。停止所有任务并继续吗？")) {
        setBusy(""); await setEnabled(plugin, enabled, true); return;
      }
      setError(text);
    } finally { setBusy(""); }
  }

  async function uninstall(plugin, stopRunning = false) {
    if (!stopRunning && !globalThis.confirm(`卸载 ${plugin.packageName}？插件创建的业务数据不会自动删除。`)) return;
    setBusy(plugin.packageName); setError(null);
    try {
      onSnapshot(await globalThis.window.jimu.plugins.uninstall({ packageName: plugin.packageName, stopRunning }));
    } catch (cause) {
      const text = cause instanceof Error ? cause.message : String(cause);
      if (!stopRunning && text.includes("Agent 任务正在运行") && globalThis.confirm("有 Agent 任务正在运行。停止所有任务并继续卸载吗？")) {
        setBusy(""); await uninstall(plugin, true); return;
      }
      setError(text);
    } finally { setBusy(""); }
  }

  async function prepareUpdate(plugin) {
    setBusy(plugin.packageName); setError(null);
    try { setProposal(await globalThis.window.jimu.plugins.inspect({ source: plugin.packageName })); }
    catch (cause) { setError(cause instanceof Error ? cause.message : String(cause)); }
    finally { setBusy(""); }
  }

  async function applyUpdate(allowedBuildPackages, stopRunning = false) {
    if (!proposal) return;
    setBusy(proposal.packageName); setError(null);
    try {
      onSnapshot(await globalThis.window.jimu.plugins.install({ proposalId: proposal.proposalId, allowedBuildPackages, stopRunning }));
      setProposal(null);
    } catch (cause) {
      const text = cause instanceof Error ? cause.message : String(cause);
      if (!stopRunning && text.includes("Agent 任务正在运行") && globalThis.confirm("停止所有任务并继续更新吗？")) {
        setBusy(""); await applyUpdate(allowedBuildPackages, true); return;
      }
      setError(text);
    } finally { setBusy(""); }
  }

  if (!desktop || installed.length === 0) return <div className="plugin-empty"><PuzzlePiece size={27} /><strong>尚未安装外部插件</strong><span>前往“插件市场”搜索并安装 DSH Bundle。</span></div>;
  return (
    <div className="plugin-installed-list">
      {error && <div className="plugin-inline-message" data-type="error"><span><WarningCircle size={14} />{error}</span></div>}
      {installed.map((plugin) => (
        <article key={plugin.packageName}>
          <PuzzlePiece size={20} weight="duotone" />
          <span><strong>{plugin.packageName}</strong><small>{plugin.version} · {COMPATIBILITY_LABELS[plugin.compatibility] ?? plugin.compatibility}</small></span>
          <Toggle checked={plugin.enabled} disabled={busy === plugin.packageName} label={`${plugin.enabled ? "停用" : "启用"}${plugin.packageName}`} onChange={(enabled) => { void setEnabled(plugin, enabled); }} />
          <button type="button" className="plugin-update" disabled={busy === plugin.packageName} onClick={() => { void prepareUpdate(plugin); }} aria-label={`更新 ${plugin.packageName}`}><ArrowClockwise size={14} /></button>
          <button type="button" className="plugin-remove" disabled={busy === plugin.packageName} onClick={() => { void uninstall(plugin); }} aria-label={`卸载 ${plugin.packageName}`}><Trash size={14} /></button>
        </article>
      ))}
      <PluginProposalDialog proposal={proposal} installing={Boolean(busy)} onClose={() => setProposal(null)} onInstall={(allowed) => { void applyUpdate(allowed); }} />
    </div>
  );
}

export function PluginSettingsPanel({ desktop }) {
  const [tab, setTab] = useState("optional");
  const [snapshot, setSnapshot] = useState(() => desktop ? null : previewPluginSnapshot());
  const [pending, setPending] = useState({});
  const [runtimePhase, setRuntimePhase] = useState(desktop ? "booting" : "ready");
  const [error, setError] = useState(null);
  const [notice, setNotice] = useState(null);
  const [applying, setApplying] = useState(false);
  const [operation, setOperation] = useState(null);
  const dirtyRef = useRef(false);
  const dirtyCount = Object.keys(pending).filter((id) => snapshot?.groups.some((group) => group.id === id && group.enabled !== pending[id])).length;
  dirtyRef.current = dirtyCount > 0;

  const loadSnapshot = useCallback(async (preservePending = false) => {
    if (!desktop) return;
    try {
      const next = await globalThis.window.jimu.plugins.snapshot();
      setSnapshot(next);
      setRuntimePhase(next.harnessPhase);
      if (next.harnessPhase === "error") {
        const status = await globalThis.window.jimu.harness.status();
        setError(status.error ?? "Harness 处于错误状态");
      }
      if (!preservePending) setPending({});
      if (next.harnessPhase !== "error") setError(null);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    }
  }, [desktop]);

  useEffect(() => {
    if (!desktop) return undefined;
    void loadSnapshot(false);
    const unsubscribeState = globalThis.window.jimu.plugins.subscribe((update) => {
      if (update?.phase) setRuntimePhase(update.phase);
      if (update?.phase === "ready") void loadSnapshot(dirtyRef.current);
    });
    const unsubscribeOperation = globalThis.window.jimu.plugins.subscribeOperation((update) => {
      setOperation(update);
      if (update?.phase === "completed") void loadSnapshot(false);
    });
    return () => { unsubscribeState(); unsubscribeOperation(); };
  }, [desktop, loadSnapshot]);

  async function applyChanges() {
    if (!snapshot || dirtyCount === 0 || applying) return;
    setApplying(true);
    setError(null);
    setNotice(null);
    try {
      const groups = Object.entries(pending)
        .filter(([id, enabled]) => snapshot.groups.some((group) => group.id === id && group.enabled !== enabled))
        .map(([id, enabled]) => ({ id, enabled }));
      const result = await globalThis.window.jimu.plugins.applyToggles({ revision: snapshot.revision, groups });
      setSnapshot(result.snapshot);
      setPending({});
      setRuntimePhase(result.snapshot.harnessPhase);
      setNotice("插件能力已应用，Harness 已重新启动，JiMu 窗口与本地服务保持运行。");
    } catch (cause) {
      const text = cause instanceof Error ? cause.message : String(cause);
      setError(text);
      await loadSnapshot(true);
    } finally {
      setApplying(false);
    }
  }

  async function retryHarness() {
    if (applying) return;
    setApplying(true);
    setError(null);
    try {
      await globalThis.window.jimu.plugins.restart();
      await loadSnapshot(false);
      setNotice("Harness 已重新启动。");
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
      await loadSnapshot(true);
    } finally {
      setApplying(false);
    }
  }

  if (!snapshot) return <div className="plugin-loading"><span className="index-loader" />正在读取 Harness 插件清单…</div>;

  return (
    <div className="plugin-manager">
      <p className="settings-section-intro">浏览当前 Harness 的真实 Loader 清单；只有经过 JiMu 策略审核的功能组可以启停，核心插件始终锁定。</p>
      <div className="plugin-runtime-summary">
        <PlugsConnected size={19} weight="duotone" />
        <span><strong>{snapshot.entries.length} 个 Loader 条目 · {snapshot.entries.filter((entry) => entry.enabled).length} 个启用</strong><small>{desktop ? "来自当前内置 Harness 实例" : "浏览器预览数据"}</small></span>
        <em data-phase={runtimePhase}>{runtimePhase.toLocaleUpperCase("en-US")}</em>
        {desktop && runtimePhase === "error" && <button type="button" className="plugin-retry" disabled={applying} onClick={() => { void retryHarness(); }}><ArrowClockwise size={13} weight="bold" />重试启动</button>}
      </div>
      {(error || notice) && <div className="plugin-inline-message" data-type={error ? "error" : "success"}><span>{error ? <WarningCircle size={14} weight="bold" /> : <Check size={14} weight="bold" />}{error ?? notice}</span><button type="button" aria-label="关闭提示" onClick={() => { setError(null); setNotice(null); }}><X size={13} /></button></div>}
      {runtimePhase === "error" && error && <details className="plugin-diagnostics"><summary>打开诊断信息</summary><pre>{error}</pre></details>}
      <div className="plugin-tabs" role="tablist" aria-label="插件管理视图">
        {[
          ["optional", "可选功能"],
          ["market", "插件市场"],
          ["installed", "已安装插件"],
          ["config", "插件配置"],
          ["all", "运行清单"],
        ].map(([id, label]) => <button type="button" role="tab" aria-selected={tab === id} data-active={tab === id || undefined} onClick={() => setTab(id)} key={id}>{label}</button>)}
      </div>
      <section className="plugin-tab-panel" role="tabpanel">
        {tab === "optional" && <OptionalFeatures snapshot={{ ...snapshot, harnessPhase: runtimePhase }} pending={pending} setPending={setPending} />}
        {tab === "market" && <PluginMarketplace desktop={desktop} installed={snapshot.installedPackages ?? []} operation={operation} onSnapshot={(next) => { setSnapshot(next); setRuntimePhase(next.harnessPhase); }} />}
        {tab === "installed" && <InstalledPlugins desktop={desktop} snapshot={snapshot} onSnapshot={(next) => { setSnapshot(next); setRuntimePhase(next.harnessPhase); }} />}
        {tab === "config" && <PluginConfiguration desktop={desktop} runtimePhase={runtimePhase} onRuntimePhase={setRuntimePhase} />}
        {tab === "all" && <AllPlugins snapshot={snapshot} />}
      </section>
      {dirtyCount > 0 && (
        <div className="plugin-apply-bar">
          <span><strong>已修改 {dirtyCount} 项插件能力</strong><small>应用时只重启内置 Harness，JiMu 窗口不会退出。</small></span>
          <button type="button" onClick={() => setPending({})}>放弃修改</button>
          <button type="button" className="plugin-apply-primary" disabled={runtimePhase !== "ready" || applying} onClick={() => { void applyChanges(); }}><ArrowClockwise size={15} weight="bold" />应用并重启 Harness</button>
        </div>
      )}
      {(runtimePhase === "restarting" || applying) && (
        <div className="plugin-restart-overlay" role="status" aria-live="polite">
          <div>
            <span className="plugin-restart-mark"><ArrowClockwise size={29} weight="bold" /></span>
            <small>JIMU / RUNTIME</small>
            <h3>正在重启 Harness</h3>
            <p>保存插件配置 <b>→</b> 停止旧实例 <b>→</b> 加载插件 <b>→</b> 恢复会话</p>
          </div>
        </div>
      )}
    </div>
  );
}
