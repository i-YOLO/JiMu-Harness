import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  ArrowRight,
  ArrowSquareOut,
  ChartLineUp,
  CaretDown,
  Check,
  ChatCircleDots,
  ClockCounterClockwise,
  Factory,
  FileAudio,
  FileImage,
  FileVideo,
  FilmSlate,
  FolderOpen,
  ImageSquare,
  Lightbulb,
  LinkSimple,
  MagnifyingGlass,
  Notebook,
  PaperPlaneRight,
  Plus,
  RocketLaunch,
  Sparkle,
  UploadSimple,
  UserFocus,
  WarningCircle,
  Waveform,
  X,
} from "@phosphor-icons/react";

const SECTIONS = [
  { id: "overview", number: "01", label: "总览", caption: "内容生产地图", icon: Factory },
  { id: "inspiration", number: "02", label: "灵感与调研", caption: "捕捉 · 对标 · 立项", icon: Lightbulb },
  { id: "content", number: "03", label: "文案工厂", caption: "Agent 共创 · 定稿", icon: Notebook },
  { id: "assets", number: "04", label: "素材库", caption: "画面 · 动效 · 音频", icon: ImageSquare },
  { id: "pipeline", number: "05", label: "视频流水线", caption: "全流程规划", icon: FilmSlate },
  { id: "data", number: "06", label: "发布与数据", caption: "归档 · 分析 · 复盘", icon: ChartLineUp },
];

const ASSET_KINDS = [
  ["all", "全部类型"],
  ["image", "图片 / 配图"],
  ["video", "B-roll"],
  ["scene", "完整场景"],
  ["motion", "文字 / 图形动效"],
  ["character", "JiMu 角色"],
  ["cover", "封面"],
  ["audio", "音频"],
  ["raw", "RAW / 原始场景"],
  ["project", "PR / 工程文件"],
];

const ASSET_STATUSES = [
  ["all", "全部状态"],
  ["approved", "已验收"],
  ["candidate", "待确认"],
  ["library", "素材库"],
];

const PLATFORM_OPTIONS = [
  ["小红书", "小红书"],
  ["抖音", "抖音"],
  ["B站", "B站"],
  ["视频号", "视频号"],
  ["YouTube", "YouTube"],
  ["其他", "其他"],
];

const PIPELINE_UI_STAGES = [
  { number: "01", title: "文案交接", detail: "读取人工确认的定稿版本，冻结本轮内容范围。" },
  { number: "02", title: "素材清单", detail: "按段落和镜头列出 B-roll、配图、动效与音频需求。" },
  { number: "03", title: "组装剪辑", detail: "将镜头、字幕、动效和声音放入统一时间线。" },
  { number: "04", title: "预览审核", detail: "生成可检查预览，核对口播、画面、节奏和事实。" },
  { number: "05", title: "修改回合", detail: "记录问题、修改依据和新一轮预览状态。" },
  { number: "06", title: "成片验收", detail: "通过画面、音频、字幕、尺寸和完整解码验收。" },
  { number: "07", title: "发布包", detail: "汇总成片、封面、标题、正文与平台发布资料。" },
];

const EMPTY_SNAPSHOT = {
  counts: { ideas: 0, benchmarkIdeas: 0, topics: 0, content: 0, approvedScripts: 0, assets: 0, approvedAssets: 0, publications: 0, metricSnapshots: 0 },
  ideas: [], topics: [], content: [], publications: [], metricSnapshots: [], analytics: [], pipeline: [],
  assets: { total: 0, recent: [], types: {}, statuses: {}, tree: null },
};

async function postFactory(path, payload) {
  const response = await fetch(path, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload ?? {}),
  });
  const value = await response.json();
  if (!response.ok) throw new Error(value.error ?? `自媒体工厂请求失败（${response.status}）`);
  return value;
}

const factoryApi = {
  snapshot() {
    return globalThis.window.jimu?.factory.getOverview()
      ?? fetch("/_jimu/factory-index", { cache: "no-store" }).then(async (response) => {
        const value = await response.json();
        if (!response.ok) throw new Error(value.error ?? `工厂索引不可用（${response.status}）`);
        return value;
      });
  },
  listAssets(request) {
    return globalThis.window.jimu?.factory.listAssets(request) ?? postFactory("/_jimu/factory-assets", request);
  },
  createInspiration(request) {
    return globalThis.window.jimu?.factory.createInspiration(request) ?? postFactory("/_jimu/factory-create-inspiration", request);
  },
  promoteTopic(request) {
    return globalThis.window.jimu?.factory.promoteTopic(request) ?? postFactory("/_jimu/factory-promote-topic", request);
  },
  saveContentRevision(request) {
    return globalThis.window.jimu?.factory.saveContentRevision(request) ?? postFactory("/_jimu/factory-save-content", request);
  },
  readContent(request) {
    return globalThis.window.jimu?.factory.readContent(request) ?? postFactory("/_jimu/factory-read-content", request);
  },
  approveScript(request) {
    return globalThis.window.jimu?.factory.approveScript(request) ?? postFactory("/_jimu/factory-approve-script", request);
  },
  linkAgentSession(request) {
    return globalThis.window.jimu?.factory.linkAgentSession(request) ?? postFactory("/_jimu/factory-link-agent", request);
  },
  savePublication(request) {
    return globalThis.window.jimu?.factory.savePublication(request) ?? postFactory("/_jimu/factory-save-publication", request);
  },
  addMetricSnapshot(request) {
    return globalThis.window.jimu?.factory.addMetricSnapshot(request) ?? postFactory("/_jimu/factory-add-metrics", request);
  },
  importMetricsCsv(publicationId) {
    if (!globalThis.window.jimu?.factory) throw new Error("CSV 原生导入仅在 JiMu 桌面版可用。");
    return globalThis.window.jimu.factory.importMetricsCsv(publicationId);
  },
  importAssets(kind) {
    if (!globalThis.window.jimu?.factory) throw new Error("素材原生导入仅在 JiMu 桌面版可用。");
    return globalThis.window.jimu.factory.importAssets(kind);
  },
};

function formatDate(value) {
  if (!value) return "—";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return String(value);
  return new Intl.DateTimeFormat("zh-CN", { month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit" }).format(date);
}

function formatNumber(value) {
  if (value === null || value === undefined || value === "") return "—";
  return Number(value).toLocaleString("zh-CN");
}

function formatBytes(value) {
  const number = Number(value) || 0;
  if (number < 1024) return `${number} B`;
  if (number < 1024 ** 2) return `${(number / 1024).toFixed(1)} KB`;
  return `${(number / 1024 ** 2).toFixed(1)} MB`;
}

function assetSource(asset) {
  if (globalThis.window.jimu) return asset.assetUrl;
  return asset.assetUrl.replace("jimu-asset://local/", "/_jimu/knowledge-asset/");
}

function imagePreviewSource(url) {
  if (globalThis.window.jimu && url.startsWith("jimu-asset://local/")) return url.replace("jimu-asset://local/", "jimu-app://app/_asset/");
  return url;
}

function FactoryNotice({ notice, onClose }) {
  if (!notice) return null;
  return (
    <div className="factory-notice" data-tone={notice.tone ?? "info"} role="status">
      {notice.tone === "error" ? <WarningCircle size={18} weight="fill" /> : <Check size={18} weight="bold" />}
      <span>{notice.text}</span>
      <button type="button" onClick={onClose} aria-label="关闭提示"><X size={15} weight="bold" /></button>
    </div>
  );
}

function FactorySectionNav({ active, onChange }) {
  return (
    <nav className="factory-section-nav" aria-label="自媒体工厂页面">
      {SECTIONS.map((section) => {
        const Icon = section.icon;
        return (
          <button type="button" data-active={active === section.id || undefined} key={section.id} onClick={() => onChange(section.id)}>
            <span>{section.number}</span>
            <Icon size={19} weight={active === section.id ? "fill" : "regular"} aria-hidden="true" />
            <strong>{section.label}</strong>
            <small>{section.caption}</small>
          </button>
        );
      })}
    </nav>
  );
}

function FactoryEmpty({ icon: Icon = Sparkle, title, copy, action }) {
  return (
    <div className="factory-empty">
      <Icon size={30} weight="duotone" />
      <strong>{title}</strong>
      <p>{copy}</p>
      {action}
    </div>
  );
}

function useDismissable(open, rootRef, onClose) {
  useEffect(() => {
    if (!open) return undefined;
    const closeOnOutside = (event) => {
      if (!rootRef.current?.contains(event.target)) onClose();
    };
    const closeOnEscape = (event) => {
      if (event.key === "Escape") onClose();
    };
    document.addEventListener("mousedown", closeOnOutside);
    document.addEventListener("keydown", closeOnEscape);
    return () => {
      document.removeEventListener("mousedown", closeOnOutside);
      document.removeEventListener("keydown", closeOnEscape);
    };
  }, [open, onClose, rootRef]);
}

function FactorySelect({ value, onChange, options, placeholder, ariaLabel, compact = false }) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const rootRef = useRef(null);
  const panelRef = useRef(null);
  const close = useCallback(() => setOpen(false), []);
  useDismissable(open, rootRef, close);
  const selected = options.find(([optionValue]) => optionValue === value);
  const normalizedQuery = query.trim().toLocaleLowerCase("zh-CN");
  const filtered = options.filter(([, label, meta]) => !normalizedQuery || `${label} ${meta ?? ""}`.toLocaleLowerCase("zh-CN").includes(normalizedQuery));
  const handleKeyDown = (event) => {
    if (!["ArrowDown", "ArrowUp"].includes(event.key)) return;
    event.preventDefault();
    if (!open) {
      setOpen(true);
      requestAnimationFrame(() => panelRef.current?.querySelector('[role="option"][aria-selected="true"], [role="option"]')?.focus());
      return;
    }
    const choices = [...(panelRef.current?.querySelectorAll('[role="option"]') ?? [])];
    if (!choices.length) return;
    const current = choices.indexOf(document.activeElement);
    const offset = event.key === "ArrowDown" ? 1 : -1;
    choices[(current + offset + choices.length) % choices.length]?.focus();
  };
  return (
    <div className="factory-select" data-compact={compact || undefined} ref={rootRef} onKeyDown={handleKeyDown}>
      <button className="factory-select-trigger" type="button" aria-label={ariaLabel} aria-expanded={open} aria-haspopup="listbox" onClick={() => setOpen((current) => !current)}>
        <span><strong>{selected?.[1] ?? placeholder}</strong>{selected?.[2] && <small>{selected[2]}</small>}</span>
        <CaretDown className="factory-select-caret" size={15} weight="bold" />
      </button>
      {open && <div className="factory-select-panel" ref={panelRef}>
        {options.length > 8 && <label><MagnifyingGlass size={16} /><input autoFocus value={query} onChange={(event) => setQuery(event.target.value)} placeholder="搜索选项" /></label>}
        <div role="listbox" aria-label={ariaLabel}>
          {filtered.map(([optionValue, label, meta]) => <button type="button" role="option" aria-selected={optionValue === value} data-active={optionValue === value || undefined} key={optionValue || "__empty"} onClick={() => { onChange(optionValue); setOpen(false); setQuery(""); }}><span><strong>{label}</strong>{meta && <small>{meta}</small>}</span>{optionValue === value && <Check size={15} weight="bold" />}</button>)}
        </div>
        {filtered.length === 0 && <p>没有匹配选项</p>}
      </div>}
    </div>
  );
}

function localDateTimeValue(date) {
  const pad = (value) => String(value).padStart(2, "0");
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}T${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

function parsedLocalDateTime(value) {
  const parsed = new Date(value || Date.now());
  return Number.isNaN(parsed.getTime()) ? new Date() : parsed;
}

function FactoryDateTimePicker({ value, onChange, ariaLabel }) {
  const [open, setOpen] = useState(false);
  const [draft, setDraft] = useState(() => parsedLocalDateTime(value));
  const [month, setMonth] = useState(() => { const date = parsedLocalDateTime(value); return new Date(date.getFullYear(), date.getMonth(), 1); });
  const rootRef = useRef(null);
  const close = useCallback(() => setOpen(false), []);
  useDismissable(open, rootRef, close);
  useEffect(() => { if (!open) setDraft(parsedLocalDateTime(value)); }, [open, value]);
  const start = new Date(month.getFullYear(), month.getMonth(), 1 - ((month.getDay() + 6) % 7));
  const days = Array.from({ length: 42 }, (_, index) => new Date(start.getFullYear(), start.getMonth(), start.getDate() + index));
  const sameDay = (left, right) => left.getFullYear() === right.getFullYear() && left.getMonth() === right.getMonth() && left.getDate() === right.getDate();
  const display = new Intl.DateTimeFormat("zh-CN", { year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", hour12: false }).format(parsedLocalDateTime(value));
  return (
    <div className="factory-datetime" ref={rootRef}>
      <button className="factory-datetime-trigger" type="button" aria-label={ariaLabel} aria-expanded={open} onClick={() => { const next = parsedLocalDateTime(value); setDraft(next); setMonth(new Date(next.getFullYear(), next.getMonth(), 1)); setOpen((current) => !current); }}><ClockCounterClockwise size={18} /><span>{display}</span><CaretDown className="factory-datetime-caret" size={15} weight="bold" /></button>
      {open && <div className="factory-datetime-panel" role="dialog" aria-label={ariaLabel}>
        <header><button type="button" aria-label="上个月" onClick={() => setMonth(new Date(month.getFullYear(), month.getMonth() - 1, 1))}>←</button><strong>{month.getFullYear()} 年 {String(month.getMonth() + 1).padStart(2, "0")} 月</strong><button type="button" aria-label="下个月" onClick={() => setMonth(new Date(month.getFullYear(), month.getMonth() + 1, 1))}>→</button></header>
        <div className="factory-calendar-week">{["一", "二", "三", "四", "五", "六", "日"].map((day) => <span key={day}>{day}</span>)}</div>
        <div className="factory-calendar-grid">{days.map((day) => <button type="button" data-outside={day.getMonth() !== month.getMonth() || undefined} data-active={sameDay(day, draft) || undefined} key={day.toISOString()} onClick={() => { const next = new Date(day); next.setHours(draft.getHours(), draft.getMinutes(), 0, 0); setDraft(next); }}>{day.getDate()}</button>)}</div>
        <div className="factory-time-row"><span>时间</span><label><input inputMode="numeric" value={String(draft.getHours()).padStart(2, "0")} onChange={(event) => { const next = new Date(draft); next.setHours(Math.max(0, Math.min(23, Number(event.target.value) || 0))); setDraft(next); }} aria-label="小时" />时</label><label><input inputMode="numeric" value={String(draft.getMinutes()).padStart(2, "0")} onChange={(event) => { const next = new Date(draft); next.setMinutes(Math.max(0, Math.min(59, Number(event.target.value) || 0))); setDraft(next); }} aria-label="分钟" />分</label></div>
        <footer><button type="button" onClick={() => { const now = new Date(); setDraft(now); setMonth(new Date(now.getFullYear(), now.getMonth(), 1)); }}>现在</button><button type="button" onClick={() => { onChange(localDateTimeValue(draft)); setOpen(false); }}>确认时间</button></footer>
      </div>}
    </div>
  );
}

function FactoryModal({ title, kicker, onClose, children }) {
  return <div className="factory-action-dialog" role="dialog" aria-modal="true" aria-label={title} onMouseDown={(event) => { if (event.target === event.currentTarget) onClose(); }}><article><header><div><span>{kicker}</span><h3>{title}</h3></div><button type="button" onClick={onClose} aria-label="关闭"><X size={18} weight="bold" /></button></header>{children}</article></div>;
}

function benchmarkSourceKind(document) {
  if (document.type === "BenchmarkAccount") return "profile";
  if (document.sourcePath.includes("/notes/") || document.sourcePath.includes("/analysis/")) return "note";
  return "guide";
}

const BENCHMARK_SOURCE_FILTERS = [
  ["all", "全部"],
  ["profile", "博主档案"],
  ["note", "笔记与拆解"],
  ["guide", "辅助资料"],
];

const BENCHMARK_SOURCE_LABELS = {
  profile: "博主档案",
  note: "笔记 / 内容拆解",
  guide: "规范 / 辅助资料",
};

function BenchmarkSourcePicker({ documents, value, onChange }) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [filter, setFilter] = useState("all");
  const rootRef = useRef(null);
  const selected = documents.find((document) => document.sourcePath === value) ?? null;
  const normalizedQuery = query.trim().toLocaleLowerCase("zh-CN");
  const results = documents.filter((document) => {
    const kind = benchmarkSourceKind(document);
    if (filter !== "all" && filter !== kind) return false;
    return !normalizedQuery || `${document.title} ${document.sourcePath}`.toLocaleLowerCase("zh-CN").includes(normalizedQuery);
  });

  const close = useCallback(() => setOpen(false), []);
  useDismissable(open, rootRef, close);

  return (
    <div className="factory-source-picker" ref={rootRef}>
      <button
        className="factory-source-picker-trigger"
        type="button"
        aria-expanded={open}
        aria-haspopup="listbox"
        onClick={() => setOpen((current) => !current)}
      >
        <UserFocus size={20} weight={selected ? "fill" : "duotone"} />
        <span>
          <strong>{selected?.title ?? "选择真实博主档案或辅助资料"}</strong>
          <small>{selected ? `${BENCHMARK_SOURCE_LABELS[benchmarkSourceKind(selected)]} · ${selected.sourcePath}` : `${documents.length} 份真实资料，可搜索和分类筛选`}</small>
        </span>
        <CaretDown className="factory-source-picker-caret" size={17} weight="bold" />
      </button>
      {open && (
        <div className="factory-source-picker-panel" role="dialog" aria-label="选择对标来源">
          <header>
            <label><MagnifyingGlass size={18} /><input autoFocus value={query} onChange={(event) => setQuery(event.target.value)} placeholder="搜索博主、笔记标题或相对路径" /></label>
            <button type="button" onClick={() => setOpen(false)} aria-label="关闭来源选择器"><X size={17} weight="bold" /></button>
          </header>
          <div className="factory-source-picker-filters" aria-label="来源类型">
            {BENCHMARK_SOURCE_FILTERS.map(([id, label]) => <button type="button" data-active={filter === id || undefined} key={id} onClick={() => setFilter(id)}>{label}</button>)}
          </div>
          <div className="factory-source-picker-results" role="listbox">
            {results.length === 0 ? <p>没有匹配的真实资料，换一个关键词或分类。</p> : results.map((document) => {
              const kind = benchmarkSourceKind(document);
              const active = document.sourcePath === value;
              return (
                <button type="button" role="option" aria-selected={active} data-active={active || undefined} key={document.stableId} onClick={() => { onChange(document.sourcePath); setOpen(false); }}>
                  <span>{kind === "profile" ? <UserFocus size={19} weight="fill" /> : kind === "note" ? <Notebook size={19} weight="fill" /> : <LinkSimple size={19} weight="bold" />}</span>
                  <span><strong>{document.title}</strong><small>{document.sourcePath}</small></span>
                  <em>{BENCHMARK_SOURCE_LABELS[kind]}</em>
                  {active && <Check size={17} weight="bold" />}
                </button>
              );
            })}
          </div>
          <footer><span>{results.length} RESULTS</span><small>仅展示当前知识库中的真实博主档案、笔记拆解与辅助资料</small></footer>
        </div>
      )}
    </div>
  );
}

function OverviewPage({ snapshot, onSection, onGoAgent }) {
  const stats = [
    [snapshot.counts.ideas, "灵感记录", "个人想法与对标拆解", "yellow"],
    [snapshot.counts.topics, "选题候选", "已经人工推进立项", "teal"],
    [snapshot.counts.approvedScripts, "定稿文案", "已通过人工审核", "cobalt"],
    [snapshot.counts.publications, "发布档案", "已有真实发布记录", "magenta"],
  ];
  return (
    <div className="factory-page factory-overview-page">
      <section className="factory-overview-hero">
        <div>
          <span className="factory-kicker">JIMU CONTENT OPERATING SYSTEM</span>
          <h2>把灵感变成可复盘的<br /><em>内容生产流水线。</em></h2>
          <p>这里管理“从哪里来、如何定稿、用了什么素材、发布后发生了什么”。Agent 负责共创和执行现场，人工继续保留立项、定稿与验收决定。</p>
        </div>
        <div className="factory-hero-stamp" aria-label="本地内容工厂">
          <Factory size={42} weight="fill" />
          <strong>LOCAL<br />FACTORY</strong>
          <small>CAPTURE · MAKE · LEARN</small>
        </div>
      </section>

      <section className="factory-stat-grid" aria-label="实时统计">
        {stats.map(([value, label, copy, accent]) => (
          <article data-accent={accent} key={label}>
            <strong>{formatNumber(value)}</strong>
            <span>{label}</span>
            <small>{copy}</small>
          </article>
        ))}
      </section>

      <section className="factory-flow-board">
        <header>
          <div><span>CONTENT PIPELINE / 真实流程</span><h3>十步内容流水线</h3></div>
          <p>节点数量来自本地工厂记录；流程说明是固定产品规范。</p>
        </header>
        <div className="factory-flow-grid">
          {snapshot.pipeline.map((stage, index) => (
            <button type="button" data-planned={stage.planned || undefined} data-accent={["yellow", "magenta", "teal", "cobalt"][index % 4]} key={stage.id} onClick={() => onSection(stage.section)}>
              <span className="factory-flow-number">{stage.number}</span>
              <span className="factory-flow-status">{stage.planned ? "规划中" : `${stage.count} 条记录`}</span>
              <strong>{stage.title}</strong>
              <small>{stage.action}</small>
              <ArrowRight size={17} weight="bold" />
            </button>
          ))}
        </div>
      </section>

      <section className="factory-quick-actions">
        <span>QUICK ENTRY</span>
        <button type="button" onClick={() => onSection("inspiration")}><Lightbulb size={18} weight="fill" />记录一个灵感</button>
        <button type="button" onClick={onGoAgent}><ChatCircleDots size={18} weight="fill" />进入 Agent 共创</button>
        <button type="button" onClick={() => onSection("assets")}><FolderOpen size={18} weight="fill" />浏览真实素材</button>
        <button type="button" onClick={() => onSection("data")}><ChartLineUp size={18} weight="fill" />查看发布数据</button>
      </section>
    </div>
  );
}

function InspirationPage({ snapshot, benchmarkDocuments, onRefresh, setNotice }) {
  const [sourceType, setSourceType] = useState("personal");
  const [title, setTitle] = useState("");
  const [body, setBody] = useState("");
  const [referencePath, setReferencePath] = useState("");
  const [busy, setBusy] = useState(false);

  async function submit(event) {
    event.preventDefault();
    if (sourceType === "benchmark" && !referencePath) {
      setNotice({ tone: "error", text: "请先选择一份真实博主档案或辅助资料。" });
      return;
    }
    setBusy(true);
    try {
      await factoryApi.createInspiration({ title, body, sourceType, referencePath });
      setTitle(""); setBody(""); setReferencePath("");
      await onRefresh();
      setNotice({ text: "灵感已写入 08-自媒体工厂，并进入可追溯记录。" });
    } catch (error) {
      setNotice({ tone: "error", text: error instanceof Error ? error.message : String(error) });
    } finally { setBusy(false); }
  }

  async function promote(stableId) {
    try {
      await factoryApi.promoteTopic({ stableId });
      await onRefresh();
      setNotice({ text: "已创建选题候选。后续仍需人工确认目标受众、承诺和证据边界。" });
    } catch (error) { setNotice({ tone: "error", text: error instanceof Error ? error.message : String(error) }); }
  }

  const promotedPaths = new Set(snapshot.topics.map((item) => item.referencePath));
  return (
    <div className="factory-page factory-inspiration-page">
      <section className="factory-page-heading">
        <div><span>CAPTURE / RESEARCH / TOPIC</span><h2>灵感与调研</h2><p>个人想法可以直接记录；对标结论必须保留来源，并由你人工确认后才能进入选题候选。</p></div>
        <div className="factory-heading-count"><strong>{snapshot.counts.ideas}</strong><span>IDEAS</span></div>
      </section>
      <div className="factory-two-column">
        <form className="factory-form-card" onSubmit={submit}>
          <header><span>NEW CAPTURE</span><h3>记录一个值得继续验证的问题</h3></header>
          <div className="factory-source-switch">
            <button type="button" data-active={sourceType === "personal" || undefined} onClick={() => { setSourceType("personal"); setReferencePath(""); }}><Sparkle size={17} />个人想法</button>
            <button type="button" data-active={sourceType === "benchmark" || undefined} onClick={() => setSourceType("benchmark")}><UserFocus size={17} />对标拆解</button>
          </div>
          <label><span>灵感标题</span><input value={title} onChange={(event) => setTitle(event.target.value)} placeholder="一句话说清想验证什么" required /></label>
          {sourceType === "benchmark" && (
            <label><span>对标博主 / 资料来源</span><BenchmarkSourcePicker documents={benchmarkDocuments} value={referencePath} onChange={setReferencePath} /></label>
          )}
          <label><span>记录内容</span><textarea value={body} onChange={(event) => setBody(event.target.value)} placeholder="来源、观察、为什么值得继续看、还缺什么证据……" required /></label>
          <button className="factory-primary-action" type="submit" disabled={busy}><Plus size={18} weight="bold" />{busy ? "正在保存…" : "保存灵感"}</button>
        </form>

        <section className="factory-process-rule">
          <span>HUMAN GATE</span>
          <h3>对标拆解不会自动变成选题</h3>
          <p>先确认它是否适合你的账号、受众与资源，再进入选题库。高互动只能作为观察证据，不能自动证明内容机制有效。</p>
          <ol><li><strong>01</strong> 保留真实来源</li><li><strong>02</strong> 提炼可复用机制</li><li><strong>03</strong> 人工判断适配性</li><li><strong>04</strong> 明确选题承诺与验收边界</li></ol>
        </section>
      </div>

      <section className="factory-record-board">
        <header><div><span>CAPTURED RECORDS</span><h3>灵感箱</h3></div><em>{snapshot.ideas.length} 条</em></header>
        {snapshot.ideas.length === 0 ? <FactoryEmpty icon={Lightbulb} title="灵感箱还是空的" copy="从个人想法或对标拆解开始建立第一条可追溯记录。" /> : (
          <div className="factory-record-grid">
            {snapshot.ideas.map((idea, index) => (
              <article data-accent={["yellow", "teal", "magenta", "cobalt"][index % 4]} key={idea.stableId}>
                <span className="factory-record-index">{String(index + 1).padStart(2, "0")}</span>
                <span className="factory-record-type">{idea.sourceType === "benchmark" ? "BENCHMARK / RESEARCH" : "PERSONAL / IDEA"}</span>
                <h4>{idea.title}</h4><p>{idea.excerpt}</p>
                {idea.referencePath && <small><LinkSimple size={13} />{idea.referencePath}</small>}
                <footer><time>{formatDate(idea.updatedAt)}</time><button type="button" disabled={promotedPaths.has(idea.sourcePath)} onClick={() => promote(idea.stableId)}>{promotedPaths.has(idea.sourcePath) ? <><Check size={14} />已进入选题</> : <>推进为选题<ArrowRight size={14} /></>}</button></footer>
              </article>
            ))}
          </div>
        )}
      </section>
    </div>
  );
}

function ContentPage({ snapshot, harnessApi, onRefresh, setNotice, onGoAgent }) {
  const [selectedId, setSelectedId] = useState("");
  const [title, setTitle] = useState("");
  const [body, setBody] = useState("");
  const [topicPath, setTopicPath] = useState("");
  const [sessions, setSessions] = useState([]);
  const [sessionKey, setSessionKey] = useState("");
  const [busy, setBusy] = useState(false);
  const selected = snapshot.content.find((item) => item.stableId === selectedId) ?? null;

  useEffect(() => {
    if (!globalThis.window.jimu || !harnessApi?.available()) return;
    let active = true;
    Promise.all([harnessApi.call("workspace.list", {}), harnessApi.call("session.list", {})]).then(([workspaces, sessionState]) => {
      if (!active) return;
      const summaries = new Map(sessionState.items.filter((item) => item.origin !== "subagent").map((item) => [item.sessionId, item]));
      setSessions(workspaces.items.flatMap((workspace) => workspace.sessionIds.map((id) => ({ workspaceId: workspace.workspaceId, workspaceTitle: workspace.title, sessionId: id, sessionTitle: summaries.get(id)?.projections?.values?.title || summaries.get(id)?.sessionId?.slice(0, 8) || id.slice(0, 8) }))));
    }).catch(() => setSessions([]));
    return () => { active = false; };
  }, [harnessApi]);

  useEffect(() => {
    if (!selectedId) { setTitle(""); setBody(""); return; }
    let active = true;
    factoryApi.readContent({ stableId: selectedId }).then((record) => {
      if (!active) return;
      setTitle(record.title); setBody(record.text ?? "");
      setSessionKey(record.agentWorkspaceId && record.agentSessionId ? `${record.agentWorkspaceId}::${record.agentSessionId}` : "");
    }).catch((error) => setNotice({ tone: "error", text: error instanceof Error ? error.message : String(error) }));
    return () => { active = false; };
  }, [selectedId, setNotice]);

  async function save(event) {
    event.preventDefault(); setBusy(true);
    try {
      const record = await factoryApi.saveContentRevision({ stableId: selectedId || undefined, title, body, topicPath });
      setSelectedId(record.stableId); await onRefresh();
      setNotice({ text: "文案已保存为新修订，旧版本仍然保留。" });
    } catch (error) { setNotice({ tone: "error", text: error instanceof Error ? error.message : String(error) }); }
    finally { setBusy(false); }
  }

  async function approve() {
    try { await factoryApi.approveScript({ stableId: selectedId }); await onRefresh(); setNotice({ text: "当前文案版本已人工确认，可进入素材准备。" }); }
    catch (error) { setNotice({ tone: "error", text: error instanceof Error ? error.message : String(error) }); }
  }

  async function linkSession() {
    const [workspaceId, sessionId] = sessionKey.split("::");
    if (!workspaceId || !sessionId) return;
    try { await factoryApi.linkAgentSession({ stableId: selectedId, workspaceId, sessionId }); await onRefresh(); setNotice({ text: "已关联真实 Harness 会话。" }); }
    catch (error) { setNotice({ tone: "error", text: error instanceof Error ? error.message : String(error) }); }
  }

  function startNew() { setSelectedId(""); setTitle(""); setBody(""); setTopicPath(""); setSessionKey(""); }
  return (
    <div className="factory-page factory-content-page">
      <section className="factory-page-heading"><div><span>AGENT CO-CREATION / HUMAN FINAL</span><h2>文案与内容制作工厂</h2><p>Agent 负责多轮共创与执行过程；每次人工修改保存为新修订，只有人工确认后才进入素材与视频阶段。</p></div><button className="factory-heading-action" type="button" onClick={startNew}><Plus size={17} weight="bold" />新建文案</button></section>
      <div className="factory-content-layout">
        <aside className="factory-content-list">
          <header><span>CONTENT PROJECTS</span><strong>{snapshot.content.length}</strong></header>
          {snapshot.content.length === 0 ? <FactoryEmpty icon={Notebook} title="还没有文案项目" copy="选择一个选题，或直接创建第一份版本化文案。" /> : snapshot.content.map((item, index) => (
            <button type="button" data-active={selectedId === item.stableId || undefined} key={item.stableId} onClick={() => setSelectedId(item.stableId)}>
              <span>{String(index + 1).padStart(2, "0")}</span><strong>{item.title}</strong><small>{item.status === "script-approved" ? "已定稿" : "修改中"} · {formatDate(item.updatedAt)}</small>
            </button>
          ))}
        </aside>
        <form className="factory-script-editor" onSubmit={save}>
          <header><div><span>{selected ? "EDIT REVISION" : "NEW CONTENT"}</span><h3>{selected ? selected.title : "建立文案项目"}</h3></div>{selected?.status === "script-approved" && <em><Check size={14} />已人工定稿</em>}</header>
          <label><span>文案标题</span><input value={title} onChange={(event) => setTitle(event.target.value)} placeholder="内容项目标题" required /></label>
          {!selected && <div className="factory-field"><span>关联选题（可选）</span><FactorySelect ariaLabel="关联选题" value={topicPath} onChange={setTopicPath} placeholder="暂不关联" options={[["", "暂不关联"], ...snapshot.topics.map((topic) => [topic.sourcePath, topic.title, topic.sourcePath])]} /></div>}
          <label className="factory-script-body"><span>当前修订</span><textarea value={body} onChange={(event) => setBody(event.target.value)} placeholder="在这里结合 Agent 讨论与人工修改形成当前版本……" required /></label>
          <div className="factory-editor-actions"><button className="factory-primary-action" type="submit" disabled={busy}><Notebook size={17} />{busy ? "保存中…" : "保存新修订"}</button>{selected && <button type="button" onClick={approve} disabled={selected.status === "script-approved"}><Check size={17} />{selected.status === "script-approved" ? "已确认定稿" : "人工确认定稿"}</button>}</div>
          {selected && <section className="factory-agent-link"><div><ChatCircleDots size={22} weight="duotone" /><span><strong>Harness 共创会话</strong><small>继续使用原始流式输出、工具调用和执行流水线。</small></span></div>{sessions.length ? <><FactorySelect ariaLabel="选择 Harness 项目和会话" value={sessionKey} onChange={setSessionKey} placeholder="选择项目 / 会话" options={[["", "选择项目 / 会话"], ...sessions.map((session) => [`${session.workspaceId}::${session.sessionId}`, session.sessionTitle, session.workspaceTitle])]} /><button type="button" onClick={linkSession} disabled={!sessionKey}><LinkSimple size={16} />保存关联</button>{selected.agentSessionId && <button type="button" onClick={() => onGoAgent({ workspaceId: selected.agentWorkspaceId, sessionId: selected.agentSessionId })}><ArrowSquareOut size={16} />打开会话</button>}</> : <button type="button" onClick={() => onGoAgent()}><ArrowSquareOut size={16} />进入 Agent 工作台</button>}</section>}
        </form>
      </div>
    </div>
  );
}

function AudioPreview({ asset }) {
  const canvasRef = useRef(null);
  const url = assetSource(asset);
  useEffect(() => {
    let active = true;
    const controller = new AbortController();
    async function draw() {
      try {
        const response = await fetch(url, { signal: controller.signal });
        const buffer = await response.arrayBuffer();
        const Context = globalThis.AudioContext || globalThis.webkitAudioContext;
        if (!Context || !active) return;
        const context = new Context();
        const audio = await context.decodeAudioData(buffer.slice(0));
        const values = audio.getChannelData(0);
        const canvas = canvasRef.current;
        if (!canvas || !active) { await context.close(); return; }
        const width = canvas.width = Math.max(320, canvas.clientWidth * (globalThis.devicePixelRatio || 1));
        const height = canvas.height = Math.max(90, canvas.clientHeight * (globalThis.devicePixelRatio || 1));
        const drawing = canvas.getContext("2d");
        drawing.clearRect(0, 0, width, height); drawing.fillStyle = "#ff296d";
        const bars = 72; const step = Math.max(1, Math.floor(values.length / bars));
        for (let index = 0; index < bars; index += 1) {
          let maximum = 0;
          for (let cursor = index * step; cursor < Math.min(values.length, (index + 1) * step); cursor += Math.max(1, Math.floor(step / 48))) maximum = Math.max(maximum, Math.abs(values[cursor]));
          const barHeight = Math.max(3, maximum * height * 0.86);
          drawing.fillRect(index * (width / bars), (height - barHeight) / 2, Math.max(2, width / bars - 3), barHeight);
        }
        await context.close();
      } catch { /* The audio control remains usable if waveform decoding is unavailable. */ }
    }
    void draw();
    return () => { active = false; controller.abort(); };
  }, [url]);
  return <div className="factory-audio-preview"><Waveform size={34} weight="duotone" /><canvas ref={canvasRef} /><audio src={url} controls preload="metadata" /></div>;
}

function AutoCenteredImage({ src, alt }) {
  const hostRef = useRef(null);
  const canvasRef = useRef(null);
  const imageRef = useRef(null);
  const draw = useCallback(() => {
    const host = hostRef.current;
    const canvas = canvasRef.current;
    const image = imageRef.current;
    if (!host || !canvas || !image?.complete || image.naturalWidth === 0 || image.naturalHeight === 0) return;
    const bounds = host.getBoundingClientRect();
    if (bounds.width < 2 || bounds.height < 2) return;

    let sourceX = 0;
    let sourceY = 0;
    let sourceWidth = image.naturalWidth;
    let sourceHeight = image.naturalHeight;
    const analysisScale = Math.min(1, 320 / Math.max(image.naturalWidth, image.naturalHeight));
    const analysisWidth = Math.max(1, Math.round(image.naturalWidth * analysisScale));
    const analysisHeight = Math.max(1, Math.round(image.naturalHeight * analysisScale));
    const analysis = document.createElement("canvas");
    analysis.width = analysisWidth;
    analysis.height = analysisHeight;
    const analysisContext = analysis.getContext("2d", { willReadFrequently: true });
    try {
      analysisContext.drawImage(image, 0, 0, analysisWidth, analysisHeight);
      const pixels = analysisContext.getImageData(0, 0, analysisWidth, analysisHeight).data;
      let left = analysisWidth;
      let top = analysisHeight;
      let right = -1;
      let bottom = -1;
      for (let y = 0; y < analysisHeight; y += 1) {
        for (let x = 0; x < analysisWidth; x += 1) {
          if (pixels[(y * analysisWidth + x) * 4 + 3] < 10) continue;
          left = Math.min(left, x);
          top = Math.min(top, y);
          right = Math.max(right, x);
          bottom = Math.max(bottom, y);
        }
      }
      if (right >= left && bottom >= top) {
        const visibleWidth = right - left + 1;
        const visibleHeight = bottom - top + 1;
        const marginX = Math.max(2, Math.round(visibleWidth * 0.06));
        const marginY = Math.max(2, Math.round(visibleHeight * 0.06));
        const boundedLeft = Math.max(0, left - marginX);
        const boundedTop = Math.max(0, top - marginY);
        const boundedRight = Math.min(analysisWidth, right + marginX + 1);
        const boundedBottom = Math.min(analysisHeight, bottom + marginY + 1);
        sourceX = boundedLeft / analysisScale;
        sourceY = boundedTop / analysisScale;
        sourceWidth = (boundedRight - boundedLeft) / analysisScale;
        sourceHeight = (boundedBottom - boundedTop) / analysisScale;
      }
    } catch {
      // If a browser rejects pixel inspection, retain a safe full-image
      // contain preview instead of failing the asset card.
    }

    const pixelRatio = Math.min(2, globalThis.devicePixelRatio || 1);
    const targetWidth = Math.max(1, Math.round(bounds.width * pixelRatio));
    const targetHeight = Math.max(1, Math.round(bounds.height * pixelRatio));
    canvas.width = targetWidth;
    canvas.height = targetHeight;
    const context = canvas.getContext("2d");
    context.clearRect(0, 0, targetWidth, targetHeight);
    context.imageSmoothingEnabled = true;
    context.imageSmoothingQuality = "high";
    const inset = Math.max(12 * pixelRatio, Math.min(targetWidth, targetHeight) * 0.055);
    const availableWidth = Math.max(1, targetWidth - inset * 2);
    const availableHeight = Math.max(1, targetHeight - inset * 2);
    const scale = Math.min(availableWidth / sourceWidth, availableHeight / sourceHeight);
    const drawWidth = sourceWidth * scale;
    const drawHeight = sourceHeight * scale;
    context.drawImage(image, sourceX, sourceY, sourceWidth, sourceHeight, (targetWidth - drawWidth) / 2, (targetHeight - drawHeight) / 2, drawWidth, drawHeight);
    host.dataset.ready = "true";
  }, []);

  useEffect(() => {
    const host = hostRef.current;
    if (!host) return undefined;
    const observer = new ResizeObserver(() => requestAnimationFrame(draw));
    observer.observe(host);
    return () => observer.disconnect();
  }, [draw]);

  return <span className="factory-auto-centered-image" ref={hostRef} role="img" aria-label={alt}><canvas ref={canvasRef} /><img ref={imageRef} crossOrigin="anonymous" src={src} alt="" decoding="async" onLoad={draw} /></span>;
}

function FactoryVideoPreview({ asset, autoPlay }) {
  const [metadata, setMetadata] = useState("");
  const url = assetSource(asset);
  const videoRef = useRef(null);
  const syncPlayback = useCallback((video) => {
    if (!autoPlay || video.dataset.autoplayVisible !== "true") {
      video.pause();
      return;
    }
    void video.play().catch(() => { /* The media element retries when it next becomes playable or visible. */ });
  }, [autoPlay]);

  useEffect(() => {
    const video = videoRef.current;
    if (!video) return undefined;
    video.dataset.autoplayVisible = "false";
    if (!autoPlay) {
      video.pause();
      return undefined;
    }
    const observer = new IntersectionObserver(([entry]) => {
      video.dataset.autoplayVisible = entry.isIntersecting && entry.intersectionRatio >= 0.12 ? "true" : "false";
      syncPlayback(video);
    }, { rootMargin: "60px 0px", threshold: [0, 0.12, 0.5] });
    observer.observe(video);
    return () => {
      observer.disconnect();
      video.pause();
    };
  }, [autoPlay, syncPlayback, url]);

  return <div className="factory-video-preview"><video ref={videoRef} src={url} muted playsInline preload="metadata" controls autoPlay={autoPlay} loop={autoPlay} data-autoplay-preview={autoPlay ? "true" : undefined} data-autoplay-scope={autoPlay ? "factory-assets" : undefined} onCanPlay={(event) => syncPlayback(event.currentTarget)} onLoadedMetadata={(event) => { const video = event.currentTarget; setMetadata(`${video.videoWidth}×${video.videoHeight} · ${Math.round(video.duration)}s`); if (!autoPlay && video.duration > 1 && video.currentTime < 0.05) video.currentTime = Math.min(0.7, video.duration * 0.1); }} />{metadata && <span>{metadata}</span>}</div>;
}

function AssetPreview({ asset, autoPlay = false }) {
  const url = assetSource(asset);
  if (asset.previewType === "audio" || asset.kind === "audio") return <AudioPreview asset={asset} />;
  if (asset.previewType === "video" || (["video", "scene", "motion", "raw"].includes(asset.kind) && ["MP4", "MOV", "M4V", "WEBM", "MKV"].includes(asset.extension))) return <FactoryVideoPreview asset={asset} autoPlay={autoPlay} />;
  if (asset.previewType === "file" || ["project", "raw"].includes(asset.kind)) return <div className="factory-file-preview"><FileVideo size={54} weight="duotone" /><strong>{asset.extension}</strong><small>{asset.sourcePath.split("/").at(-1)}</small></div>;
  if (asset.extension === "GIF") return <img src={url} alt={asset.title} loading="lazy" />;
  return <AutoCenteredImage src={imagePreviewSource(url)} alt={asset.title} />;
}

function AssetKindIcon({ kind }) {
  if (kind === "audio") return <FileAudio size={16} weight="fill" />;
  if (["video", "scene", "motion", "raw", "project"].includes(kind)) return <FileVideo size={16} weight="fill" />;
  return <FileImage size={16} weight="fill" />;
}

function AssetCardVisual({ asset, onOpen, autoPlay = false }) {
  const hasInlineControls = ["video", "audio"].includes(asset.previewType);
  if (hasInlineControls) {
    return <div className="factory-asset-visual" data-interactive-media><AssetPreview asset={asset} autoPlay={autoPlay} /><em>{asset.extension}</em></div>;
  }
  return <button className="factory-asset-visual" type="button" onClick={onOpen} aria-label={`预览 ${asset.title}`}><AssetPreview asset={asset} /><em>{asset.extension}</em></button>;
}

function MotionFolderCard({ folder, index, onOpen, autoPlay }) {
  const asset = {
    ...folder.previewAsset,
    title: folder.name,
    tags: ["动效文件夹", ...(folder.previewAsset.tags ?? [])],
  };
  return (
    <article className="factory-asset-card factory-motion-folder-card" data-accent={["yellow", "magenta", "teal", "cobalt"][index % 4]}>
      <AssetCardVisual asset={asset} onOpen={() => onOpen(asset)} autoPlay={autoPlay} />
      <button className="factory-asset-info" type="button" onClick={() => onOpen(asset)}>
        <span><FileVideo size={16} weight="fill" />动效文件夹 / 自动播放</span>
        <strong>{folder.name}</strong>
        <small>{folder.previewAsset.title}</small>
        <footer><span>1 个动效预览</span><time>{formatDate(folder.previewAsset.updatedAt)}</time></footer>
      </button>
    </article>
  );
}

function findAssetDirectory(node, sourcePath, chain = []) {
  if (!node) return null;
  const nextChain = [...chain, node];
  if (node.sourcePath === sourcePath) return { node, chain: nextChain };
  for (const child of node.children ?? []) {
    const found = findAssetDirectory(child, sourcePath, nextChain);
    if (found) return found;
  }
  return null;
}

function AssetsPage({ snapshot, setNotice, onRefresh }) {
  const [query, setQuery] = useState("");
  const [kind, setKind] = useState("all");
  const [status, setStatus] = useState("all");
  const [sort, setSort] = useState("recent");
  const [state, setState] = useState({ phase: "loading", total: 0, items: [] });
  const [selected, setSelected] = useState(null);
  const [importOpen, setImportOpen] = useState(false);
  const [importKind, setImportKind] = useState("image");
  const [directoryPath, setDirectoryPath] = useState("");
  const [showDirectAssets, setShowDirectAssets] = useState(false);
  const tree = snapshot.assets.tree;
  const directoryState = findAssetDirectory(tree, directoryPath || tree?.sourcePath);
  const directory = directoryState?.node ?? tree;
  const breadcrumbs = directoryState?.chain ?? (tree ? [tree] : []);
  const isMotionGallery = directory?.viewMode === "motion-gallery";
  const isLeafDirectory = Boolean(directory && ((directory.children?.length ?? 0) === 0 || showDirectAssets));
  useEffect(() => {
    if (tree && !directoryPath) setDirectoryPath(tree.sourcePath);
  }, [directoryPath, tree]);
  const load = useCallback(async () => {
    setState((value) => ({ ...value, phase: "loading" }));
    try { const result = await factoryApi.listAssets({ query, kind, status, sort, directory: directory?.sourcePath, recursive: directory?.aggregate === true, limit: 120 }); setState({ phase: "ready", ...result }); }
    catch (error) { setState({ phase: "error", total: 0, items: [], error: error instanceof Error ? error.message : String(error) }); }
  }, [directory?.aggregate, directory?.sourcePath, query, kind, status, sort]);
  useEffect(() => {
    if (!isLeafDirectory || isMotionGallery) { setState({ phase: "ready", total: directory?.totalAssets ?? 0, items: [] }); return undefined; }
    const timer = setTimeout(() => { void load(); }, 120);
    return () => clearTimeout(timer);
  }, [directory?.totalAssets, isLeafDirectory, isMotionGallery, load, snapshot.generatedAt]);

  async function importFiles() {
    try {
      const result = await factoryApi.importAssets(importKind);
      if (result.canceled) return;
      await onRefresh(); await load();
      setImportOpen(false);
      setNotice({ text: `已导入 ${result.imported?.length ?? 0} 个真实素材。` });
    } catch (error) { setNotice({ tone: "error", text: error instanceof Error ? error.message : String(error) }); }
  }

  return (
    <div className="factory-page factory-assets-page">
      <section className="factory-page-heading"><div><span>LOCAL ASSET LIBRARY / 16:9 PREVIEW</span><h2>真实素材库</h2><p>素材留在本地知识库中。卡片统一比例，图片等比展示，素材视频进入视野后静音循环播放，音频从文件生成波形。</p></div><button className="factory-heading-action" type="button" onClick={() => { setImportKind(kind === "all" ? "image" : kind); setImportOpen(true); }}><UploadSimple size={18} weight="bold" />导入素材</button></section>
      {tree && <nav className="factory-asset-breadcrumb" aria-label="素材目录路径"><button type="button" disabled={breadcrumbs.length <= 1 && !showDirectAssets} onClick={() => { if (showDirectAssets) { setShowDirectAssets(false); return; } const parent = breadcrumbs.at(-2); if (parent) { setDirectoryPath(parent.sourcePath); setShowDirectAssets(false); setQuery(""); } }}>← 上一级</button>{breadcrumbs.map((item, index) => <button type="button" data-active={index === breadcrumbs.length - 1 && !showDirectAssets || undefined} key={item.stableId} onClick={() => { setDirectoryPath(item.sourcePath); setShowDirectAssets(false); setQuery(""); }}>{item.name}</button>)}{showDirectAssets && <span>本层素材</span>}<em>{directory?.totalAssets ?? 0} ITEMS</em></nav>}
      {isMotionGallery ? <section className="factory-folder-browser factory-motion-folder-browser"><header><div><span>MOTION COLLECTION / {String(breadcrumbs.length).padStart(2, "0")}</span><h3>{directory.name}</h3></div><p>每个文件夹就是一个完整动效。进入目录即静音循环播放，可随时暂停、拖动并比较预览。</p></header><div className="factory-asset-grid factory-motion-folder-grid">{directory.children.map((child, index) => <MotionFolderCard folder={child} index={index} key={child.stableId} onOpen={setSelected} autoPlay={!selected} />)}</div></section> : !isLeafDirectory && directory ? <section className="factory-folder-browser"><header><div><span>DIRECTORY LEVEL / {String(breadcrumbs.length).padStart(2, "0")}</span><h3>{directory.name}</h3></div><p>继续进入子目录；只有到达最内层后，才加载真实素材预览。</p></header><div className="factory-folder-grid">{directory.directAssets > 0 && <button type="button" data-accent="yellow" onClick={() => { setShowDirectAssets(true); setQuery(""); }}><FolderOpen size={29} weight="fill" /><span><strong>本层素材</strong><small>当前目录直接包含的文件</small></span><em>{directory.directAssets}</em><ArrowRight size={18} weight="bold" /></button>}{directory.children.map((child, index) => <button type="button" data-accent={["magenta", "teal", "cobalt", "yellow"][index % 4]} key={child.stableId} onClick={() => { setDirectoryPath(child.sourcePath); setShowDirectAssets(false); setQuery(""); }}><FolderOpen size={29} weight="fill" /><span><strong>{child.name}</strong><small>{child.children.length ? `${child.children.length} 个子目录` : "叶子目录 · 可预览"}</small></span><em>{child.totalAssets}</em><ArrowRight size={18} weight="bold" /></button>)}</div></section> : <>
      <section className="factory-asset-toolbar">
        <label><MagnifyingGlass size={18} /><input value={query} onChange={(event) => setQuery(event.target.value)} placeholder="搜索当前目录的素材名称、路径或标签" /></label>
        <FactorySelect compact ariaLabel="素材类型" value={kind} onChange={setKind} placeholder="全部类型" options={ASSET_KINDS} />
        <FactorySelect compact ariaLabel="素材状态" value={status} onChange={setStatus} placeholder="全部状态" options={ASSET_STATUSES} />
        <FactorySelect compact ariaLabel="素材排序" value={sort} onChange={setSort} placeholder="最近修改" options={[["recent", "最近修改"], ["name", "名称排序"]]} />
        <span>{state.total} ITEMS</span>
      </section>
      {state.phase === "error" ? <FactoryEmpty icon={WarningCircle} title="素材读取失败" copy={state.error} /> : state.phase === "ready" && state.items.length === 0 ? <FactoryEmpty icon={ImageSquare} title="这个叶子目录还没有匹配素材" copy={directory?.sourcePath.endsWith("/01-图片与配图") ? "历史知识库配图已从生产素材视图中排除，源文件暂时保留，等待后续确认是否归档或清理。" : snapshot.counts.assets === 0 ? "素材目录已建立。导入或完成安全迁移后，真实预览会出现在这里。" : "调整关键词、类型或验收状态筛选，或返回上一级选择其他目录。"} /> : (
        <div className="factory-asset-grid">
          {state.items.map((asset, index) => (
            <article className="factory-asset-card" data-accent={["yellow", "magenta", "teal", "cobalt"][index % 4]} key={asset.stableId}>
              <AssetCardVisual asset={asset} onOpen={() => setSelected(asset)} autoPlay={!selected} />
              <button className="factory-asset-info" type="button" onClick={() => setSelected(asset)}><span><AssetKindIcon kind={asset.kind} />{ASSET_KINDS.find(([value]) => value === asset.kind)?.[1] ?? asset.kind}</span><strong>{asset.title}</strong><small>{asset.tags.join(" · ") || asset.sourcePath.split("/").at(-2)}</small><footer><span>{formatBytes(asset.size)}</span><time>{formatDate(asset.updatedAt)}</time></footer></button>
            </article>
          ))}
        </div>
      )}</>}
      {importOpen && <FactoryModal kicker="LOCAL ASSET IMPORT" title="先确认素材归属，再选择本地文件" onClose={() => setImportOpen(false)}><div className="factory-import-kind-grid">{ASSET_KINDS.filter(([value]) => value !== "all").map(([value, label]) => <button type="button" data-active={importKind === value || undefined} key={value} onClick={() => setImportKind(value)}><AssetKindIcon kind={value} /><strong>{label}</strong><small>写入 08-自媒体工厂 / 03-素材库</small>{importKind === value && <Check size={16} weight="bold" />}</button>)}</div><div className="factory-import-dialog-footer"><p>下一步会打开 macOS 原生文件选择器。文件只会复制到所选素材目录，不改动原文件。</p><button className="factory-primary-action" type="button" onClick={importFiles}><UploadSimple size={18} weight="bold" />选择本地文件</button></div></FactoryModal>}
      {selected && <div className="factory-asset-dialog" role="dialog" aria-modal="true" aria-label={selected.title} onMouseDown={(event) => { if (event.target === event.currentTarget) setSelected(null); }}><article><button type="button" className="factory-dialog-close" onClick={() => setSelected(null)} aria-label="关闭"><X size={18} weight="bold" /></button><div className="factory-asset-dialog-preview"><AssetPreview asset={selected} autoPlay /></div><div className="factory-asset-dialog-copy"><span>LOCAL ASSET / {selected.extension}</span><h3>{selected.title}</h3><p>{selected.sourcePath}</p><dl><div><dt>类型</dt><dd>{ASSET_KINDS.find(([value]) => value === selected.kind)?.[1] ?? selected.kind}</dd></div><div><dt>状态</dt><dd>{ASSET_STATUSES.find(([value]) => value === selected.status)?.[1] ?? selected.status}</dd></div><div><dt>大小</dt><dd>{formatBytes(selected.size)}</dd></div><div><dt>修改</dt><dd>{formatDate(selected.updatedAt)}</dd></div></dl></div></article></div>}
    </div>
  );
}

function PipelinePage({ snapshot, onSection }) {
  const ready = snapshot.counts.approvedScripts;
  return (
    <div className="factory-page factory-pipeline-page">
      <section className="factory-page-heading"><div><span>VIDEO PRODUCTION / UI BLUEPRINT</span><h2>视频制作流水线</h2><p>流程结构完整保留，方便你讲解和验收未来能力。本阶段不执行剪辑、渲染或自动发布。</p></div><span className="factory-planned-badge">PLANNING / 规划中</span></section>
      <section className="factory-pipeline-ready"><div><strong>{ready}</strong><span>份定稿文案</span><small>可以进入未来的视频制作队列</small></div><ArrowRight size={28} weight="bold" /><div><strong>{snapshot.counts.approvedAssets}</strong><span>个已验收素材</span><small>来自本地真实素材库</small></div><button type="button" onClick={() => onSection("assets")}><FolderOpen size={17} />检查素材库</button></section>
      <div className="factory-production-track">
        {PIPELINE_UI_STAGES.map((stage, index) => (
          <article data-accent={["yellow", "teal", "cobalt", "magenta"][index % 4]} key={stage.number}>
            <span>{stage.number}</span><div><em>PLANNED STAGE</em><h3>{stage.title}</h3><p>{stage.detail}</p></div>{index < PIPELINE_UI_STAGES.length - 1 && <ArrowRight size={19} weight="bold" />}
          </article>
        ))}
      </div>
      <section className="factory-boundary-card"><WarningCircle size={25} weight="duotone" /><div><strong>这里不是一个假剪辑器</strong><p>当前 UI 只展示真实生产阶段和未来接口边界。待文案、素材与验收规则稳定后，再接入可验证的剪辑流水线。</p></div></section>
    </div>
  );
}

function DataPage({ snapshot, onRefresh, setNotice }) {
  const [publication, setPublication] = useState({ title: "", contentId: "", platform: "", account: "", url: "", publishedAt: new Date().toISOString().slice(0, 16) });
  const [publicationId, setPublicationId] = useState("");
  const [metrics, setMetrics] = useState({ capturedAt: new Date().toISOString().slice(0, 16), views: "", likes: "", favorites: "", comments: "", shares: "", follows: "" });
  const [csvOpen, setCsvOpen] = useState(false);
  async function savePublication(event) {
    event.preventDefault();
    try { const result = await factoryApi.savePublication(publication); setPublicationId(result.stableId); await onRefresh(); setNotice({ text: "发布档案已保存到本地工厂。" }); }
    catch (error) { setNotice({ tone: "error", text: error instanceof Error ? error.message : String(error) }); }
  }
  async function saveMetrics(event) {
    event.preventDefault();
    try { await factoryApi.addMetricSnapshot({ publicationId, ...metrics }); await onRefresh(); setNotice({ text: "数据快照已保存，可与上一条真实快照比较。" }); }
    catch (error) { setNotice({ tone: "error", text: error instanceof Error ? error.message : String(error) }); }
  }
  async function importCsv() {
    try { const result = await factoryApi.importMetricsCsv(publicationId); if (result.canceled) return; await onRefresh(); setCsvOpen(false); setNotice({ text: `已从 CSV 导入 ${result.imported ?? 0} 条数据快照。` }); }
    catch (error) { setNotice({ tone: "error", text: error instanceof Error ? error.message : String(error) }); }
  }
  return (
    <div className="factory-page factory-data-page">
      <section className="factory-page-heading"><div><span>PUBLISH / MEASURE / COMPOUND</span><h2>发布与数据</h2><p>v1 只接收人工填写和本地 CSV，不登录平台账号、不自动抓取。每次数据都是有时间点的真实快照。</p></div><div className="factory-heading-count"><strong>{snapshot.counts.metricSnapshots}</strong><span>SNAPSHOTS</span></div></section>
      <div className="factory-data-forms">
        <form className="factory-form-card" onSubmit={savePublication}><header><span>PUBLISH ARCHIVE</span><h3>建立发布档案</h3></header><label><span>内容标题</span><input required value={publication.title} onChange={(event) => setPublication({ ...publication, title: event.target.value })} /></label><div className="factory-field"><span>关联文案</span><FactorySelect ariaLabel="关联文案" value={publication.contentId} onChange={(contentId) => setPublication({ ...publication, contentId })} placeholder="暂不关联" options={[["", "暂不关联"], ...snapshot.content.map((item) => [item.stableId, item.title, item.status === "script-approved" ? "已人工定稿" : "修改中"])]} /></div><div className="factory-form-row"><div className="factory-field"><span>平台</span><FactorySelect ariaLabel="发布平台" value={publication.platform} onChange={(platform) => setPublication({ ...publication, platform })} placeholder="选择发布平台" options={PLATFORM_OPTIONS} /></div><label><span>账号</span><input value={publication.account} onChange={(event) => setPublication({ ...publication, account: event.target.value })} /></label></div><div className="factory-field"><span>发布时间</span><FactoryDateTimePicker ariaLabel="选择发布时间" value={publication.publishedAt} onChange={(publishedAt) => setPublication({ ...publication, publishedAt })} /></div><label><span>发布链接（可选）</span><input value={publication.url} onChange={(event) => setPublication({ ...publication, url: event.target.value })} /></label><button className="factory-primary-action" type="submit" disabled={!publication.platform}><RocketLaunch size={17} />保存发布档案</button></form>
        <form className="factory-form-card" onSubmit={saveMetrics}><header><span>METRIC SNAPSHOT</span><h3>记录数据快照</h3></header><div className="factory-field"><span>发布档案</span><FactorySelect ariaLabel="选择发布档案" value={publicationId} onChange={setPublicationId} placeholder="选择已发布内容" options={snapshot.publications.map((item) => [item.stableId, item.title, `${item.platform}${item.account ? ` · ${item.account}` : ""}`])} /></div><div className="factory-field"><span>记录时间</span><FactoryDateTimePicker ariaLabel="选择数据记录时间" value={metrics.capturedAt} onChange={(capturedAt) => setMetrics({ ...metrics, capturedAt })} /></div><div className="factory-metric-grid">{[["views", "播放"], ["likes", "点赞"], ["favorites", "收藏"], ["comments", "评论"], ["shares", "分享"], ["follows", "涨粉"]].map(([key, label]) => <label key={key}><span>{label}</span><input type="number" min="0" value={metrics[key]} onChange={(event) => setMetrics({ ...metrics, [key]: event.target.value })} /></label>)}</div><div className="factory-editor-actions"><button className="factory-primary-action" type="submit" disabled={!publicationId}><Plus size={17} />保存快照</button><button type="button" onClick={() => setCsvOpen(true)} disabled={!publicationId}><UploadSimple size={17} />CSV 导入</button></div></form>
      </div>
      {csvOpen && <FactoryModal kicker="LOCAL CSV IMPORT" title="确认数据格式，再选择 CSV 文件" onClose={() => setCsvOpen(false)}><div className="factory-csv-guide"><p>CSV 第一行使用字段名；支持中文或英文列名。数据只保存在本地工厂，不连接平台账号。</p><div><span>快照时间</span><span>播放</span><span>点赞</span><span>收藏</span><span>评论</span><span>分享</span><span>涨粉</span></div><small>当前目标：{snapshot.publications.find((item) => item.stableId === publicationId)?.title ?? "未选择发布档案"}</small></div><div className="factory-import-dialog-footer"><p>下一步会打开 macOS 文件选择器，仅接受真实 .csv 文件。</p><button className="factory-primary-action" type="button" onClick={importCsv}><UploadSimple size={18} weight="bold" />选择 CSV 文件</button></div></FactoryModal>}
      <section className="factory-analytics-board"><header><div><span>REAL PERFORMANCE</span><h3>内容表现概览</h3></div><em>{snapshot.analytics.length} 个发布档案</em></header>{snapshot.analytics.length === 0 ? <FactoryEmpty icon={ChartLineUp} title="暂无可分析数据" copy="先建立发布档案，再手动记录或从 CSV 导入至少一个数据快照。" /> : <div className="factory-analytics-grid">{snapshot.analytics.map((item) => <article key={item.publicationId}><span>{item.platform || "未填写平台"}</span><h4>{item.title}</h4><dl>{[["views", "播放"], ["likes", "点赞"], ["favorites", "收藏"], ["comments", "评论"], ["follows", "涨粉"]].map(([key, label]) => <div key={key}><dt>{label}</dt><dd>{formatNumber(item.latest?.metrics?.[key])}</dd><small>{item.delta?.[key] === null ? "—" : `${item.delta[key] >= 0 ? "+" : ""}${formatNumber(item.delta[key])}`}</small></div>)}</dl><footer>{item.snapshots} 次快照 · {formatDate(item.latest?.capturedAt)}</footer></article>)}</div>}</section>
    </div>
  );
}

export function FactoryScreen({ indexData, harnessApi, onGoAgent }) {
  const [section, setSection] = useState("overview");
  const [state, setState] = useState({ phase: "loading", data: EMPTY_SNAPSHOT, error: "" });
  const [notice, setNotice] = useState(null);
  const refresh = useCallback(async () => {
    try { const value = await factoryApi.snapshot(); setState({ phase: "ready", data: value, error: "" }); return value; }
    catch (error) { const message = error instanceof Error ? error.message : String(error); setState({ phase: "error", data: EMPTY_SNAPSHOT, error: message }); return null; }
  }, []);
  useEffect(() => {
    let active = true;
    factoryApi.snapshot().then((value) => { if (active) setState({ phase: "ready", data: value, error: "" }); }).catch((error) => { if (active) setState({ phase: "error", data: EMPTY_SNAPSHOT, error: error instanceof Error ? error.message : String(error) }); });
    const unsubscribe = globalThis.window.jimu?.factory.subscribeChanges(() => { void refresh(); }) ?? (() => { const events = new EventSource("/_jimu/factory-events"); events.addEventListener("message", () => { void refresh(); }); return () => events.close(); })();
    return () => { active = false; unsubscribe(); };
  }, [refresh]);
  const benchmarkDocuments = useMemo(() => (indexData?.documents ?? []).filter((document) => document.category === "benchmarks" && ["BenchmarkAccount", "BenchmarkMaterial"].includes(document.type)).sort((left, right) => left.title.localeCompare(right.title, "zh-CN")), [indexData]);
  const snapshot = state.data;
  return (
    <main className="factory-module">
      <FactorySectionNav active={section} onChange={setSection} />
      <div className="factory-scroll-region">
        <FactoryNotice notice={notice} onClose={() => setNotice(null)} />
        {state.phase === "loading" && <FactoryEmpty icon={Factory} title="正在打开本地内容工厂" copy="读取 08-自媒体工厂中的真实记录与素材。" />}
        {state.phase === "error" && <FactoryEmpty icon={WarningCircle} title="自媒体工厂暂不可用" copy={state.error} action={<button type="button" onClick={() => { void refresh(); }}>重新读取</button>} />}
        {state.phase === "ready" && section === "overview" && <OverviewPage snapshot={snapshot} onSection={setSection} onGoAgent={() => onGoAgent()} />}
        {state.phase === "ready" && section === "inspiration" && <InspirationPage snapshot={snapshot} benchmarkDocuments={benchmarkDocuments} onRefresh={refresh} setNotice={setNotice} />}
        {state.phase === "ready" && section === "content" && <ContentPage snapshot={snapshot} harnessApi={harnessApi} onRefresh={refresh} setNotice={setNotice} onGoAgent={onGoAgent} />}
        {state.phase === "ready" && section === "assets" && <AssetsPage snapshot={snapshot} onRefresh={refresh} setNotice={setNotice} />}
        {state.phase === "ready" && section === "pipeline" && <PipelinePage snapshot={snapshot} onSection={setSection} />}
        {state.phase === "ready" && section === "data" && <DataPage snapshot={snapshot} onRefresh={refresh} setNotice={setNotice} />}
      </div>
    </main>
  );
}
