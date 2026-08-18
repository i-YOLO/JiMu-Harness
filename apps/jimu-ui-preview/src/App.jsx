import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import cytoscape from "cytoscape";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import {
  ArrowLeft,
  ArrowDown,
  ArrowRight,
  ArrowUp,
  ArrowUpRight,
  Archive,
  BookOpenText,
  Brain,
  CaretDown,
  CaretDoubleLeft,
  CaretDoubleRight,
  CaretRight,
  ChartBar,
  ChatCircleDots,
  Check,
  Code,
  ClockCounterClockwise,
  Command,
  Cpu,
  DotsThree,
  DownloadSimple,
  Feather,
  Factory,
  FileText,
  Folder,
  FolderPlus,
  FolderOpen,
  Gear,
  GitFork,
  Heart,
  Lightning,
  LinkSimple,
  LockSimple,
  MagnifyingGlass,
  MagicWand,
  PaperPlaneRight,
  Palette,
  PencilSimple,
  PlayCircle,
  Plus,
  PlugsConnected,
  PuzzlePiece,
  ShieldCheck,
  ShareNetwork,
  SlidersHorizontal,
  Sparkle,
  SquaresFour,
  Star,
  Translate,
  UsersThree,
  X,
} from "@phosphor-icons/react";
import { describeHarnessError, groupSkillCatalog, historyMessages, summarizeUsage } from "./agent-transcript.js";
import { FactoryScreen } from "./factory-screen.jsx";
import { PluginSettingsPanel } from "./plugin-settings.jsx";
import { OnboardingScreen } from "./onboarding-screen.jsx";
import { UsageScreen } from "./usage-screen.jsx";
import { numberReaderOutline } from "./reader-outline.js";
import {
  PANEL_LAYOUT,
  clampPanelSize,
  panelSizeFromPointer,
  readPanelSize,
  writePanelSize,
} from "./panel-layout.js";
import { KNOWLEDGE_CATEGORIES, KNOWLEDGE_AUXILIARY_CATEGORIES, JIMU_KNOWLEDGE_REPOSITORY_URL } from "../shared/knowledge-schema.mjs";

const CATEGORIES = [
  { id: "all", label: "全部", directory: "ALL" },
  ...KNOWLEDGE_CATEGORIES,
];

const CATEGORY_BY_ID = Object.fromEntries([
  ...CATEGORIES,
  ...KNOWLEDGE_AUXILIARY_CATEGORIES,
].map((category) => [category.id, category]));

const GRAPH_LAYOUT_OPTIONS = {
  name: "cose",
  randomize: true,
  nodeDimensionsIncludeLabels: true,
  nodeRepulsion: () => 18000,
  idealEdgeLength: () => 145,
  edgeElasticity: () => 78,
  gravity: 0.2,
  componentSpacing: 135,
  padding: 52,
  nestingFactor: 1.08,
};

async function postKnowledge(path, payload) {
  const response = await fetch(path, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload ?? {}),
  });
  const value = await response.json();
  if (!response.ok) throw new Error(value.error ?? `知识库请求失败（${response.status}）`);
  return value;
}

const knowledgeApi = {
  setup() {
    return globalThis.window.jimu?.knowledge.getSetup()
      ?? Promise.resolve({
        phase: "unconfigured",
        template: { repositoryUrl: JIMU_KNOWLEDGE_REPOSITORY_URL, templateVersion: "1.0.1", bundled: false },
      });
  },
  createStarter(request) {
    if (!globalThis.window.jimu) return Promise.resolve({ canceled: true });
    return globalThis.window.jimu.knowledge.createStarter(request);
  },
  snapshot() {
    return globalThis.window.jimu?.knowledge.getOverview()
      ?? fetch("/_jimu/knowledge-index", { cache: "no-store" }).then(async (response) => {
        const value = await response.json();
        if (!response.ok) throw new Error(value.error ?? `索引请求失败（${response.status}）`);
        return value;
      });
  },
  search(request) {
    return globalThis.window.jimu?.knowledge.search(request) ?? postKnowledge("/_jimu/knowledge-search", request);
  },
  readDocument(request) {
    return globalThis.window.jimu?.knowledge.readDocument(request) ?? postKnowledge("/_jimu/knowledge-read", request);
  },
  resolveLink(request) {
    return (globalThis.window.jimu?.knowledge.resolveLink(request) ?? postKnowledge("/_jimu/knowledge-resolve", request))
      .then((result) => result.kind === "localAsset" && !globalThis.window.jimu
        ? { ...result, assetUrl: result.assetUrl.replace("jimu-asset://local/", "/_jimu/knowledge-asset/") }
        : result);
  },
  graph(filters) {
    return globalThis.window.jimu?.knowledge.getGraph(filters) ?? postKnowledge("/_jimu/knowledge-graph", filters);
  },
};

const harnessApi = {
  available: () => Boolean(globalThis.window.jimu?.harness),
  status: () => globalThis.window.jimu?.harness.status(),
  call: (method, payload = {}) => globalThis.window.jimu?.harness.call(method, payload),
  respond: (message) => globalThis.window.jimu?.harness.respond(message),
  subscribeEvents: (listener) => globalThis.window.jimu?.harness.subscribeEvents(listener) ?? (() => {}),
  subscribeState: (listener) => globalThis.window.jimu?.harness.subscribeState(listener) ?? (() => {}),
};

function prepareWikiLinks(markdown) {
  return markdown.replace(/\[\[([^\]|]+)(?:\|([^\]]+))?\]\]/g, (_match, target, alias) => {
    const label = alias || target;
    return `[${label}](jimu-wiki:${encodeURIComponent(target)})`;
  });
}

 const MODEL_OPTIONS = [
  {
    id: "deepseek-v4-flash",
    name: "DeepSeek V4 Flash",
    wireName: "deepseek-v4-flash",
    description: "默认模型 · 响应更快，适合日常执行与高频迭代",
  },
  {
    id: "deepseek-v4-pro",
    name: "DeepSeek V4 Pro",
    wireName: "deepseek-v4-pro",
    description: "复杂模型 · 适合深度推理、架构分析与高难度实现",
  },
];

const AGENT_PRESETS = [
  {
    id: "standard",
    wireId: "standard",
    label: "Standard",
    name: "标准模式",
    icon: Brain,
    accent: "teal",
    description: "完整 Agent：文件编辑、Shell、检索、Skills、计划、目标、子代理与工作流。",
  },
  {
    id: "code",
    wireId: "code",
    label: "Code",
    name: "PTC 模式",
    icon: Code,
    accent: "cobalt",
    description: "保留 Standard 能力，并允许模型用 TypeScript 程序组合多步工具操作。",
  },
  {
    id: "minimal",
    wireId: "minimal",
    label: "Minimal",
    name: "极简模式",
    icon: Feather,
    accent: "yellow",
    description: "仅保留持久 Bash 与文件编辑器，适合边界清楚的轻量编码任务。",
  },
  {
    id: "creator",
    wireId: "cordis",
    label: "Creator",
    name: "创造模式",
    icon: MagicWand,
    accent: "magenta",
    description: "用于创建自定义 Agent 预设，增加运行时检查、插件实验和预设创作能力。",
  },
];

 const SETTINGS_SECTIONS = [
  { id: "general", label: "通用设置", icon: Gear },
  { id: "models", label: "模型", icon: Cpu },
  { id: "plugins", label: "插件", icon: PuzzlePiece },
  { id: "agent-presets", label: "Agent 预设", icon: Brain },
];

const KNOWLEDGE_SECTIONS = [
  { id: "overview", label: "总览", caption: "复利路线图" },
  { id: "archive", label: "档案", caption: "全部资料" },
  { id: "graph", label: "图谱", caption: "真实精选" },
];

const ROADMAP_STAGES = [
  {
    id: "inspiration",
    number: "01",
    title: "灵感捕捉",
    problem: "把尚未验证但值得追踪的想法留下来。",
    input: "外部资料、临时想法、待验证观察",
    action: "记录来源、时间与为什么值得继续看",
    output: "可回溯的项目灵感",
    entry: "01-Inbox / 项目灵感",
    relation: "为 Agent 讨论提供原始问题，不直接视为正式知识。",
    target: { mode: "archive", category: "inbox" },
  },
  {
    id: "conversation",
    number: "02",
    title: "Agent 讨论",
    problem: "把模糊灵感变成可以判断的问题。",
    input: "项目灵感、知识库上下文、当前约束",
    action: "澄清目标、检查证据、拆解选择",
    output: "讨论记录与候选判断",
    entry: "JiMu Agent 会话",
    relation: "承接灵感，向决策和计划输出可验证假设。",
    target: { mode: "agent" },
  },
  {
    id: "decision",
    number: "03",
    title: "判断与决策",
    problem: "决定什么值得做、什么暂不做。",
    input: "讨论结论、证据、边界与风险",
    action: "比较方案、明确取舍、记录不确定项",
    output: "项目决定与验收边界",
    entry: "02-Projects / 决策文档",
    relation: "把讨论收束为明确选择，并约束后续计划。",
    target: { mode: "archive", category: "projects" },
  },
  {
    id: "plan",
    number: "04",
    title: "制定计划",
    problem: "把决定转成可以执行和验收的步骤。",
    input: "已确认决策、资源与约束",
    action: "拆分阶段、定义交付物和验证方法",
    output: "真实可执行的项目计划",
    entry: "02-Projects / 方案与计划",
    relation: "从决策进入执行，计划不能被写成完成事实。",
    target: { mode: "archive", category: "projects" },
  },
  {
    id: "execution",
    number: "05",
    title: "实际执行",
    problem: "在真实任务中产生可观察结果。",
    input: "项目计划、素材、代码与工具",
    action: "执行、检查、修正并保留关键证据",
    output: "成品、测试与执行记录",
    entry: "02-Projects / Agent 执行现场",
    relation: "计划只有经过执行才会产生可验证反馈。",
    target: { mode: "agent" },
  },
  {
    id: "feedback",
    number: "06",
    title: "结果反馈",
    problem: "确认结果是否真的解决问题。",
    input: "真实成品、测试结果与用户反馈",
    action: "对照验收条件，记录通过与失败",
    output: "事实反馈与修正方向",
    entry: "项目记录 / 验收证据",
    relation: "为复盘提供事实，不用完成计划代替真实结果。",
    target: { mode: "archive", category: "projects" },
  },
  {
    id: "review",
    number: "07",
    title: "复盘总结",
    problem: "解释为什么成功或失败，以及下次怎么做。",
    input: "执行记录、反馈、失败样本与人工判断",
    action: "压缩过程、区分事实与推断、提炼方法",
    output: "Checkpoint、复盘与候选知识",
    entry: "项目复盘 / Checkpoint",
    relation: "把一次性过程压缩成可复用结论的候选。",
    target: { mode: "archive", category: "projects" },
  },
  {
    id: "knowledge",
    number: "08",
    title: "正式知识卡",
    problem: "只保留经过实践验证且长期可复用的内容。",
    input: "复盘结论、证据与适用边界",
    action: "去重、压缩、结构化并建立内链",
    output: "正式知识卡",
    entry: "03-Knowledge / 长期归属分类",
    relation: "过程资料在这里完成晋升，成为后续工作的可靠输入。",
    target: { mode: "archive", category: "knowledge" },
  },
  {
    id: "graph",
    number: "09",
    title: "进入知识图谱",
    problem: "让有效知识和关系可以被整体观察。",
    input: "正式知识卡与真实有效关系",
    action: "映射稳定节点、归属与关联边",
    output: "可筛选的知识关系网络",
    entry: "知识图谱 / 图谱视图",
    relation: "只消费稳定数据对象，不渲染假关系。",
    target: { mode: "graph" },
  },
];

const TYPE_LABELS = {
  Inspiration: "灵感",
  Conversation: "会话",
  Decision: "决策",
  Plan: "计划",
  Project: "项目",
  Execution: "执行",
  Review: "复盘",
  KnowledgeCard: "知识卡",
  Content: "内容",
  Prompt: "提示词",
  Business: "商业",
  BenchmarkMaterial: "对标资料",
  BenchmarkAccount: "博主档案",
  ProjectDirectory: "项目",
  Skill: "Skill",
  SkillDirectory: "Skill 目录",
  FactoryRecord: "工厂记录",
  TopicCandidate: "选题候选",
  ContentProject: "文案项目",
  Publication: "发布档案",
  MetricSnapshot: "数据快照",
  System: "系统",
  Archive: "归档",
  Log: "日志",
  Document: "文档",
};

const CARD_ACCENT_SEQUENCE = ["yellow", "cobalt", "teal", "magenta"];

function useStoredPanelSize(definition) {
  const [size, setSize] = useState(() => readPanelSize(globalThis.localStorage, definition));
  const updateSize = useCallback((nextSize) => {
    setSize((current) => {
      const resolved = typeof nextSize === "function" ? nextSize(current) : nextSize;
      return writePanelSize(globalThis.localStorage, definition, resolved);
    });
  }, [definition]);
  return [size, updateSize];
}

function useElementWidth(elementRef, fallback) {
  const [width, setWidth] = useState(fallback);
  useEffect(() => {
    const element = elementRef.current;
    if (!element) return undefined;
    const measure = () => setWidth(Math.round(element.getBoundingClientRect().width));
    measure();
    if (typeof ResizeObserver === "undefined") {
      globalThis.addEventListener?.("resize", measure);
      return () => globalThis.removeEventListener?.("resize", measure);
    }
    const observer = new ResizeObserver(measure);
    observer.observe(element);
    return () => observer.disconnect();
  }, [elementRef]);
  return width;
}

function PanelResizeHandle({
  className,
  label,
  controls,
  size,
  minimum,
  maximum,
  defaultSize,
  direction = 1,
  onChange,
}) {
  const dragRef = useRef(null);

  const clearResizeState = useCallback(() => {
    dragRef.current = null;
    const root = globalThis.document?.documentElement;
    if (root) delete root.dataset.panelResizing;
  }, []);

  function handlePointerDown(event) {
    if (event.button !== 0) return;
    dragRef.current = { pointerId: event.pointerId, startPosition: event.clientX, startSize: size };
    event.currentTarget.setPointerCapture(event.pointerId);
    const root = globalThis.document?.documentElement;
    if (root) root.dataset.panelResizing = "true";
    event.preventDefault();
  }

  function handlePointerMove(event) {
    const drag = dragRef.current;
    if (!drag || drag.pointerId !== event.pointerId) return;
    onChange(panelSizeFromPointer({
      startSize: drag.startSize,
      startPosition: drag.startPosition,
      currentPosition: event.clientX,
      direction,
      minimum,
      maximum,
    }));
  }

  function handlePointerEnd(event) {
    if (dragRef.current?.pointerId !== event.pointerId) return;
    if (event.currentTarget.hasPointerCapture(event.pointerId)) event.currentTarget.releasePointerCapture(event.pointerId);
    clearResizeState();
  }

  function handleKeyDown(event) {
    const step = event.shiftKey ? 48 : 16;
    if (event.key === "Home") {
      event.preventDefault();
      onChange(defaultSize);
      return;
    }
    if (event.key === "End") {
      event.preventDefault();
      onChange(maximum);
      return;
    }
    if (event.key !== "ArrowLeft" && event.key !== "ArrowRight") return;
    event.preventDefault();
    const coordinateDelta = event.key === "ArrowRight" ? step : -step;
    onChange(clampPanelSize(size + (coordinateDelta * direction), minimum, maximum));
  }

  return (
    <button
      className={`panel-resize-handle ${className}`}
      type="button"
      role="separator"
      aria-label={label}
      aria-controls={controls}
      aria-orientation="vertical"
      aria-valuemin={minimum}
      aria-valuemax={maximum}
      aria-valuenow={size}
      title="拖动调整宽度；双击恢复默认"
      onPointerDown={handlePointerDown}
      onPointerMove={handlePointerMove}
      onPointerUp={handlePointerEnd}
      onPointerCancel={handlePointerEnd}
      onLostPointerCapture={clearResizeState}
      onDoubleClick={() => onChange(defaultSize)}
      onKeyDown={handleKeyDown}
    />
  );
}

function ModeButton({ active, number, icon: Icon, label, caption, onClick, collapsed }) {
  return (
    <button
      className="mode-button"
      data-active={active || undefined}
      data-collapsed={collapsed || undefined}
      type="button"
      onClick={onClick}
      title={collapsed ? label : undefined}
    >
      {!collapsed && <span className="mode-number">{number}</span>}
      <span className="mode-button-icon">
        <Icon size={21} weight={active ? "fill" : "regular"} aria-hidden="true" />
      </span>
      {!collapsed && (
        <span className="mode-copy">
          <strong>{label}</strong>
          <small>{caption}</small>
        </span>
      )}
    </button>
  );
}

function AppSidebar({ mode, setMode, collapsed, onToggleCollapse, resizeHandle, modules }) {
  const status = mode === "agent"
    ? ["多项目模式", "PROJECTS / SESSIONS"]
    : mode === "factory"
      ? ["内容工厂", "CAPTURE / MAKE / LEARN"]
    : mode === "usage"
      ? ["用量监测", "TOKENS / REQUESTS"]
    : mode === "settings"
      ? ["配置中心", "HARNESS SETTINGS"]
      : ["知识模式", "LOCAL / MARKDOWN"];
  return (
    <aside id="jimu-main-navigation" className="app-sidebar" data-collapsed={collapsed || undefined}>
      <button className="brand-lockup" type="button" onClick={() => setMode("knowledge")} aria-label="返回 JiMu 知识库">
        <span className="brand-icon-wrap">
          <img src="/assets/jimu-icon.png" alt="JiMu" />
        </span>
        {!collapsed && (
          <span className="brand-wordmark">
            <strong>JiMu</strong>
            <small>HARNESS</small>
          </span>
        )}
      </button>

      <nav className="mode-nav" aria-label="主导航">
        <ModeButton
          active={mode === "agent"}
          number="01"
          icon={ChatCircleDots}
          label="AGENT"
          caption="执行现场"
          collapsed={collapsed}
          onClick={() => setMode("agent")}
        />
        <ModeButton
          active={mode === "knowledge"}
          number="02"
          icon={BookOpenText}
          label="知识库"
          caption="复利工程"
          collapsed={collapsed}
          onClick={() => setMode("knowledge")}
        />
        {modules.factory && (
          <ModeButton
            active={mode === "factory"}
            number="03"
            icon={Factory}
            label="自媒体工厂"
            caption="内容流水线"
            collapsed={collapsed}
            onClick={() => setMode("factory")}
          />
        )}
        <ModeButton
          active={mode === "usage"}
          number="04"
          icon={ChartBar}
          label="Token 用量"
          caption="用量监测"
          collapsed={collapsed}
          onClick={() => setMode("usage")}
        />
      </nav>

      <div className="sidebar-spacer" />
      {!collapsed && (
        <div className="root-status">
          <span className="root-status-dot" />
          <span>
            <small>{status[0]}</small>
            <strong>{status[1]}</strong>
          </span>
        </div>
      )}
      <ModeButton
        active={mode === "settings"}
        number="05"
        icon={Gear}
        label="设置"
        caption="本地配置"
        collapsed={collapsed}
        onClick={() => setMode("settings")}
      />
      {!collapsed && <p className="build-label">JIMU / {globalThis.window.jimu ? "DESKTOP 0.1" : "PREVIEW 01"}</p>}
      <button
        className="sidebar-collapse"
        type="button"
        onClick={onToggleCollapse}
        aria-expanded={!collapsed}
        title={collapsed ? "展开侧边栏" : "收起侧边栏"}
      >
        {collapsed
          ? <CaretDoubleRight size={15} weight="bold" aria-hidden="true" />
          : (<><CaretDoubleLeft size={15} weight="bold" aria-hidden="true" />收起</>)}
      </button>
      {resizeHandle}
    </aside>
  );
}

function EngineStatus() {
  const [open, setOpen] = useState(false);
  const desktop = Boolean(globalThis.window.jimu);
  return (
    <div className="engine-status-wrap">
      <button className="engine-status" type="button" onClick={() => setOpen((value) => !value)} aria-expanded={open}>
        <span className="engine-light" />
        <span>LOCAL ENGINE · 已连接</span>
        <CaretDown size={13} weight="bold" aria-hidden="true" />
      </button>
      {open && (
        <div className="engine-popover">
          <div><Check size={15} weight="bold" />{desktop ? "桌面引擎运行正常" : "本地界面预览正常"}</div>
          <small>知识库来自本机只读索引，不会向 Markdown 写入数据。</small>
        </div>
      )}
    </div>
  );
}

function AppHeader({ mode }) {
  const labels = {
    agent: ["LOCAL / 01", "Agent 工作台", "AGENT WORKSPACE"],
    knowledge: ["LOCAL / 02", "知识库 · 复利工程", "COMPOUND KNOWLEDGE"],
    factory: ["LOCAL / 03", "自媒体工厂", "CONTENT PIPELINE"],
    usage: ["LOCAL / 04", "Token 用量监测", "TOKEN USAGE MONITOR"],
    settings: ["LOCAL / 05", "JiMu 设置", "LOCAL SETTINGS"],
  };
  const [code, title, english] = labels[mode];
  return (
    <header className="app-header">
      <div className="header-title">
        <span>{code}</span>
        <h1>{title}</h1>
        <small>{english}</small>
      </div>
      <EngineStatus />
    </header>
  );
}

function Card({ document, duplicate, index, onOpen }) {
  const category = CATEGORY_BY_ID[document.category] ?? { label: document.categoryLabel, directory: document.sourcePath.split("/")[0] };
  const cardAccent = CARD_ACCENT_SEQUENCE[index % CARD_ACCENT_SEQUENCE.length];
  const footerLabel = document.stableId
    ? `${category.label} / ${TYPE_LABELS[document.type] ?? document.type}`
    : `${category.label} / ${document.order}`;
  return (
    <button
      className="knowledge-card"
      data-accent={cardAccent}
      type="button"
      onClick={() => onOpen(document.stableId ?? document.id)}
    >
      <span className="card-index" aria-hidden="true">{String(index + 1).padStart(2, "0")}</span>
      <span className="card-eyebrow">{document.eyebrow}</span>
      <strong className="card-title">{document.title}</strong>
      <span className="card-excerpt">{document.excerpt}</span>
      {document.metrics && (
        <span className="card-metrics">
          {document.metrics.map((metric) => (
            <span key={metric.label}><strong>{metric.value}</strong><small>{metric.label}</small></span>
          ))}
        </span>
      )}
      {duplicate && <span className="card-source">{category.directory}</span>}
      <span className="card-footer">
        <span>{footerLabel}</span>
        <span>{document.date} ↗</span>
      </span>
    </button>
  );
}

function formatCount(value) {
  if (value === null || value === undefined) return "—";
  return Number(value).toLocaleString("zh-CN");
}

function BenchmarkAccountCard({ account, index, onOpen }) {
  const benchmark = account.benchmark ?? {};
  const stats = benchmark.stats ?? {};
  const cardAccent = CARD_ACCENT_SEQUENCE[index % CARD_ACCENT_SEQUENCE.length];
  return (
    <button className="benchmark-account-card" data-accent={cardAccent} type="button" onClick={() => onOpen(account.stableId)}>
      <span className="account-card-platform">{benchmark.platform ?? "—"}</span>
      <span className="account-card-number" aria-hidden="true">{String(index + 1).padStart(2, "0")}</span>
      <strong className="account-card-name">{account.title}</strong>
      <span className="account-card-id">{benchmark.authorId ?? "—"}</span>
      <div className="account-card-stats">
        <span><strong>{formatCount(stats.videos)}</strong><small>视频</small></span>
        <span><strong>{formatCount(stats.images)}</strong><small>图文</small></span>
        <span><strong>{formatCount(stats.analyzed)}</strong><small>精拆</small></span>
        <span><strong>{formatCount(stats.localMedia)}</strong><small>本地媒体</small></span>
      </div>
      <div className="account-card-totals">
        <span><Heart size={13} weight="fill" />{formatCount(stats.totalLikes)}</span>
        <span><Star size={13} weight="fill" />{formatCount(stats.totalCollects)}</span>
        <span><ChatCircleDots size={13} weight="fill" />{formatCount(stats.totalComments)}</span>
        <span className="account-card-median">互动中位 {formatCount(stats.medianEngagement)}</span>
      </div>
      <span className="account-card-enter">进入账号 <ArrowRight size={14} weight="bold" /></span>
    </button>
  );
}

function NoteCard({ note, onSelect }) {
  return (
    <button className="note-card" type="button" onClick={() => onSelect(note)}>
      <span className="note-cover">
        {note.cover?.kind === "local"
          ? <img src={note.cover.assetUrl} alt="" loading="lazy" />
          : <span className="note-cover-fallback">{note.cover?.kind === "remote" ? "封面未本地化" : "暂无封面"}</span>}
        <span className="note-type-badge">{note.type === "video" ? "视频" : "图文"}</span>
        {note.analysis === "analyzed" && <span className="note-badge analyzed">已精拆</span>}
        {note.analysis === "tagged" && <span className="note-badge tagged">仅标签</span>}
      </span>
      <strong className="note-title">{note.title}</strong>
      <span className="note-date">{note.publishedAtLocal ? note.publishedAtLocal.slice(0, 10) : (note.publishedAt ? note.publishedAt.slice(0, 10) : "—")}</span>
      <span className="note-metrics">
        <span><Heart size={12} weight="fill" />{formatCount(note.metrics?.like)}</span>
        <span><Star size={12} weight="fill" />{formatCount(note.metrics?.collect)}</span>
        <span><ChatCircleDots size={12} weight="fill" />{formatCount(note.metrics?.comment)}</span>
        <strong>互动 {formatCount(note.engagement)}</strong>
      </span>
    </button>
  );
}

function NoteMarkdown({ sourcePath, markdown }) {
  const [assetMap, setAssetMap] = useState(new Map());
  useEffect(() => {
    const hrefs = [...markdown.matchAll(/!\[[^\]]*\]\(([^)\s]+)/g)].map((match) => match[1]);
    Promise.all([...new Set(hrefs)].map(async (href) => {
      try {
        return [href, await knowledgeApi.resolveLink({ fromPath: sourcePath, href })];
      } catch (error) {
        return [href, { kind: "blocked", reason: error instanceof Error ? error.message : String(error) }];
      }
    })).then((rows) => setAssetMap(new Map(rows)));
  }, [sourcePath, markdown]);
  return (
    <ReactMarkdown
      remarkPlugins={[remarkGfm]}
      skipHtml
      components={{
        a: ({ href = "", children }) => (
          <a href={href} onClick={(event) => {
            event.preventDefault();
            if (/^(?:https?:|mailto:)/i.test(href)) {
              if (globalThis.window.jimu) void globalThis.window.jimu.shell.openExternal(href);
              else globalThis.open(href, "_blank", "noopener,noreferrer");
            }
          }}>{children}</a>
        ),
        img: ({ src = "", alt = "" }) => {
          const resolved = assetMap.get(src);
          return resolved?.kind === "localAsset"
            ? <img src={resolved.assetUrl} alt={alt} loading="lazy" />
            : <span className="markdown-image-blocked"><ShieldCheck size={15} />{resolved?.kind === "external" ? "外部图片未自动加载" : `图片不可用：${alt || src}`}</span>;
        },
        input: (props) => <input {...props} disabled />,
      }}
    >{markdown}</ReactMarkdown>
  );
}

function NoteDetailPanel({ note, detail, onBack }) {
  const metrics = note.metrics ?? {};
  const duration = note.video?.durationSeconds;
  return (
    <div className="note-detail">
      <div className="note-detail-head">
        <button className="detail-back" type="button" onClick={onBack}><ArrowLeft size={15} weight="bold" />返回视频列表</button>
        <span className="note-type-badge">{note.type === "video" ? "视频" : "图文"}</span>
        <h3>{note.title}</h3>
        <p className="note-detail-meta">
          <span>{note.publishedAtLocal || note.publishedAt || "发布时间未知"}</span>
          <span>笔记 {note.noteId || "—"}</span>
          {duration !== null && <span>时长 {(duration / 60).toFixed(1)} 分钟</span>}
        </p>
      </div>
      <div className="note-detail-body">
        <div className="note-media">
          {note.video?.kind === "local"
            ? <video controls preload="metadata" src={note.video.assetUrl} />
            : <div className="note-media-fallback"><PlayCircle size={30} weight="duotone" /><strong>本地视频不可用</strong><small>{note.type === "video" ? "该视频尚未完成本地化，或媒体文件缺失。" : "图文笔记无需视频。"}</small></div>}
        </div>
        <div className="note-metrics-panel">
          <span className="section-kicker">INTERACTION SNAPSHOT / 互动快照</span>
          <dl className="engagement-table">
            <div><dt><Heart size={14} weight="fill" />点赞</dt><dd>{formatCount(metrics.like)}</dd></div>
            <div><dt><Star size={14} weight="fill" />收藏</dt><dd>{formatCount(metrics.collect)}</dd></div>
            <div><dt><ChatCircleDots size={14} weight="fill" />评论</dt><dd>{formatCount(metrics.comment)}</dd></div>
            <div><dt><ShareNetwork size={14} weight="fill" />分享</dt><dd>{formatCount(metrics.share)}</dd></div>
            <div className="engagement-total"><dt>互动数</dt><dd>{formatCount(note.engagement)}</dd></div>
            <div className="engagement-note"><dt>快照时间</dt><dd>{metrics.snapshotAt ? metrics.snapshotAt.replace("T", " ").slice(0, 16) : "—"}</dd></div>
          </dl>
          <p className="engagement-caption">互动数口径：点赞 + 评论 + 收藏；任一项缺失时显示“—”，不推算。</p>
        </div>
      </div>
      <div className="note-analysis">
        <span className="section-kicker">
          {detail?.kind === "analysis" ? "CONTENT ANALYSIS / 内容拆解" : detail?.kind === "overview" ? "NOTE OVERVIEW / 笔记概要" : "NOTE CONTENT / 笔记内容"}
        </span>
        {!detail && <div className="reader-loading"><span className="index-loader" />正在读取笔记内容…</div>}
        {detail?.error && <div className="reader-inline-error"><X size={22} weight="bold" /><strong>笔记内容读取失败</strong><p>{detail.error}</p></div>}
        {detail?.markdown && <div className="note-analysis-body markdown-reader"><NoteMarkdown sourcePath={detail.sourcePath} markdown={detail.markdown} /></div>}
      </div>
    </div>
  );
}

function BenchmarkAccountView({ account, onBack, onOpenDocument }) {
  const benchmark = account.benchmark ?? {};
  const stats = benchmark.stats ?? {};
  const [noteFilter, setNoteFilter] = useState("all");
  const [noteSort, setNoteSort] = useState("recent");
  const [selectedNote, setSelectedNote] = useState(null);
  const [detail, setDetail] = useState(null);

  const visibleNotes = useMemo(() => {
    let notes = benchmark.notes ?? [];
    if (noteFilter === "analyzed") notes = notes.filter((note) => note.analysis === "analyzed");
    else if (noteFilter === "tagged") notes = notes.filter((note) => note.analysis === "tagged");
    else if (noteFilter === "image") notes = notes.filter((note) => note.type === "image");
    if (noteSort === "engagement") {
      notes = [...notes].sort((a, b) => (b.engagement ?? -1) - (a.engagement ?? -1));
    } else {
      notes = [...notes].sort((a, b) => (b.publishedAt || "").localeCompare(a.publishedAt || ""));
    }
    return notes;
  }, [benchmark.notes, noteFilter, noteSort]);

  function selectNote(note) {
    setSelectedNote(note);
    setDetail(null);
    const target = note.analysisStableId || note.stableId;
    if (!target) {
      setDetail({ kind: "none" });
      return;
    }
    knowledgeApi.readDocument({ stableId: target }).then((value) => {
      setDetail({ kind: note.analysisStableId ? "analysis" : "overview", sourcePath: value.sourcePath, markdown: value.markdown });
    }).catch((error) => {
      setDetail({ kind: "overview", error: error instanceof Error ? error.message : String(error) });
    });
  }

  return (
    <main className="account-view">
      <header className="account-hero">
        <button className="account-back" type="button" onClick={onBack}><ArrowLeft size={16} weight="bold" />返回对标总览</button>
        <div className="account-hero-copy">
          <span className="section-kicker">{account.eyebrow}</span>
          <h2>{account.title}</h2>
          <p>
            <span>作者 ID <strong>{benchmark.authorId || "—"}</strong></span>
            <span>收录 {formatCount(stats.notes)} 条</span>
            <span>本地媒体 {formatCount(stats.localMedia)}</span>
            <span>已精拆 {formatCount(stats.analyzed)}</span>
          </p>
        </div>
        <div className="account-hero-stats">
          <span><strong>{formatCount(stats.totalLikes)}</strong><small>点赞合计</small></span>
          <span><strong>{formatCount(stats.totalCollects)}</strong><small>收藏合计</small></span>
          <span><strong>{formatCount(stats.totalComments)}</strong><small>评论合计</small></span>
          <span><strong>{formatCount(stats.medianEngagement)}</strong><small>互动中位</small></span>
        </div>
      </header>

      <div className="account-layout">
        <aside className="account-docs">
          <span className="section-kicker">ACCOUNT DOCUMENTS / 账号文档</span>
          <div className="account-doc-list">
            {(benchmark.documents ?? []).map((document) => (
              <button className="account-doc-row" type="button" key={document.stableId} onClick={() => onOpenDocument(document.stableId)}>
                <span><FileText size={15} weight="duotone" /><strong>{document.title}</strong></span>
                <small>{TYPE_LABELS[document.type] ?? document.type}</small>
              </button>
            ))}
            {(benchmark.documents ?? []).length === 0 && <p className="account-docs-empty">该账号暂无独立文档。</p>}
          </div>
          <p className="account-docs-note">账号文档在阅读页打开；关闭阅读后回到本账号视图。笔记的概览与拆解在右侧视频卡片内。</p>
        </aside>

        <section className="account-notes">
          <div className="note-toolbar">
            <div className="note-filters" role="group" aria-label="视频筛选">
              {[
                { id: "all", label: "全部" },
                { id: "analyzed", label: "已精拆" },
                { id: "tagged", label: "仅标签" },
                { id: "image", label: "图文" },
              ].map((item) => (
                <button key={item.id} type="button" data-active={noteFilter === item.id || undefined} onClick={() => setNoteFilter(item.id)}>{item.label}</button>
              ))}
            </div>
            <div className="sort-control" role="group" aria-label="视频排序">
              <button type="button" data-active={noteSort === "recent" || undefined} onClick={() => setNoteSort("recent")}><ClockCounterClockwise size={14} />最近发布</button>
              <button type="button" data-active={noteSort === "engagement" || undefined} onClick={() => setNoteSort("engagement")}><SlidersHorizontal size={14} />互动优先</button>
            </div>
          </div>

          {selectedNote ? (
            <NoteDetailPanel note={selectedNote} detail={detail} onBack={() => setSelectedNote(null)} />
          ) : (
            <>
              <div className="note-wall">
                {visibleNotes.map((note) => <NoteCard key={note.folderName || note.noteId || note.title} note={note} onSelect={selectNote} />)}
              </div>
              {visibleNotes.length === 0 && (
                <div className="empty-category"><div className="empty-icon"><FileText size={28} /></div><h3>没有匹配的笔记</h3><p>换一个筛选条件试试。</p></div>
              )}
            </>
          )}
        </section>
      </div>
    </main>
  );
}

function HScrollSection({ number, kicker, title, caption, children }) {
  const trackRef = useRef(null);
  const scrollBy = (direction) => {
    trackRef.current?.scrollBy({ left: direction * 340, behavior: "smooth" });
  };
  const count = Array.isArray(children) ? children.length : 0;
  return (
    <section className="hscroll-section">
      <div className="hscroll-heading-row">
        <BenchmarkSectionHeading number={number} kicker={kicker} title={title} caption={caption} />
        <div className="hscroll-controls">
          <span className="hscroll-hint">左右滑动 · {count} 项</span>
          <button type="button" className="hscroll-arrow" aria-label="向左滚动" onClick={() => scrollBy(-1)}><ArrowLeft size={15} weight="bold" /></button>
          <button type="button" className="hscroll-arrow" aria-label="向右滚动" onClick={() => scrollBy(1)}><ArrowRight size={15} weight="bold" /></button>
        </div>
      </div>
      <div className="hscroll-track" ref={trackRef}>{children}</div>
    </section>
  );
}

function ProjectDirectoryCard({ project, index, onOpen }) {
  const stats = project.project?.stats ?? {};
  const cardAccent = CARD_ACCENT_SEQUENCE[index % CARD_ACCENT_SEQUENCE.length];
  return (
    <button className="project-directory-card" data-accent={cardAccent} type="button" onClick={() => onOpen(project.stableId)}>
      <span className="project-card-kicker">{project.eyebrow}</span>
      <span className="project-card-number" aria-hidden="true">{String(index + 1).padStart(2, "0")}</span>
      <strong className="project-card-name">{project.title}</strong>
      <span className="project-card-summary">{project.excerpt}</span>
      <div className="project-card-stats">
        <span><strong>{formatCount(stats.documents)}</strong><small>文档</small></span>
        {stats.subdirectories > 0 && <span><strong>{formatCount(stats.subdirectories)}</strong><small>子目录</small></span>}
        <span><strong>{project.date}</strong><small>最近更新</small></span>
      </div>
      <span className="project-card-enter">查看项目文档 <ArrowRight size={14} weight="bold" /></span>
    </button>
  );
}

function ProjectDirectoryView({ project, onBack, onOpenDocument }) {
  const stats = project.project?.stats ?? {};
  const tree = project.project?.directoryTree ?? null;
  return (
    <main className="project-view">
      <header className="project-hero">
        <button className="account-back" type="button" onClick={onBack}><ArrowLeft size={16} weight="bold" />返回档案</button>
        <div className="project-hero-copy">
          <span className="section-kicker">{project.eyebrow}</span>
          <h2>{project.title}</h2>
          <p>
            <span>{formatCount(stats.documents)} 份项目文档</span>
            {stats.subdirectories > 0 && <span>{formatCount(stats.subdirectories)} 个子目录</span>}
            <span>最近更新 {project.date}</span>
          </p>
        </div>
      </header>
      <div className="project-documents">
        <div className="project-documents-heading">
          <span className="section-kicker">PROJECT DOCUMENTS / 项目文档</span>
          <span>按真实目录层级陈列，点击文档直接阅读</span>
        </div>
        {tree ? (
          <SkillDirectoryBrowser tree={tree} onOpen={onOpenDocument} />
        ) : (
          <div className="project-flat-documents">
            {(project.project?.documents ?? []).map((document) => (
              <button className="account-doc-row" type="button" key={document.stableId} onClick={() => onOpenDocument(document.stableId)}>
                <span><FileText size={15} weight="duotone" /><strong>{document.title}</strong></span>
                <small>{TYPE_LABELS[document.type] ?? document.type}</small>
              </button>
            ))}
          </div>
        )}
      </div>
    </main>
  );
}

function BenchmarkSectionHeading({ number, kicker, title, caption }) {
  return (
    <div className="benchmark-section-heading">
      <span className="benchmark-section-number">{number}</span>
      <div className="benchmark-section-copy">
        <span className="section-kicker">{kicker}</span>
        <h3>{title}</h3>
        <p>{caption}</p>
      </div>
    </div>
  );
}

function KnowledgeHome({ indexData, category, setCategory, sort, setSort, onOpen, onOpenAccount, onOpenProject, categories = CATEGORIES }) {
  const documentById = useMemo(
    () => new Map(indexData.documents.map((document) => [document.stableId, document])),
    [indexData],
  );
  const archiveDocuments = useMemo(
    () => indexData.archiveCardIds.map((id) => documentById.get(id)).filter(Boolean),
    [documentById, indexData.archiveCardIds],
  );
  const visibleDocuments = useMemo(() => {
    const filtered = category === "all"
      ? archiveDocuments.filter((document) => document.category !== "benchmarks")
      : archiveDocuments.filter((document) => document.category === category);
    return [...filtered].sort((a, b) => sort === "recent"
      ? (b.updatedAt ?? b.modified) - (a.updatedAt ?? a.modified)
      : a.order.localeCompare(b.order, "zh-CN", { numeric: true }));
  }, [archiveDocuments, category, sort]);
  const accountDocuments = useMemo(
    () => visibleDocuments.filter((document) => document.type === "BenchmarkAccount"),
    [visibleDocuments],
  );
  const otherDocuments = useMemo(
    () => visibleDocuments.filter((document) => document.type !== "BenchmarkAccount" && document.type !== "ProjectDirectory"),
    [visibleDocuments],
  );
  const benchmarkDirectory = useMemo(
    () => otherDocuments.filter((document) => document.benchmarkSection === "directory"),
    [otherDocuments],
  );
  const benchmarkStandards = useMemo(
    () => otherDocuments.filter((document) => document.benchmarkSection === "standards"),
    [otherDocuments],
  );
  const benchmarkInsights = useMemo(
    () => otherDocuments.filter((document) => document.benchmarkSection === "insights"),
    [otherDocuments],
  );
  const projectDocuments = useMemo(
    () => visibleDocuments.filter((document) => document.type === "ProjectDirectory"),
    [visibleDocuments],
  );
  const allBenchmarkAccounts = useMemo(
    () => (category === "all" ? archiveDocuments.filter((document) => document.type === "BenchmarkAccount") : []),
    [archiveDocuments, category],
  );
  const titleCounts = useMemo(() => {
    const counts = new Map();
    for (const document of visibleDocuments) counts.set(document.title, (counts.get(document.title) ?? 0) + 1);
    return counts;
  }, [visibleDocuments]);
  const categoryStats = new Map(indexData.categories.map((item) => [item.id, item]));
  const categoryItems = categories.map((item) => ({
    ...item,
    count: item.id === "all" ? indexData.stats.archiveCards : (categoryStats.get(item.id)?.cardCount ?? 0),
    documentCount: item.id === "all" ? indexData.stats.markdownDocuments : (categoryStats.get(item.id)?.documentCount ?? 0),
  }));
  const activeCategory = categoryItems.find((item) => item.id === category) ?? categoryItems[0];
  const categoryDescription = category === "inbox"
    ? "每条灵感保留来源和收录时间，方便回看当时发现了什么，再决定是否转成正式项目或知识卡。"
    : category === "benchmarks"
      ? "一个博主对应一张账号主卡；规范与横向报告作为辅助卡，继续保留原目录和全部来源回链。"
      : category === "skills"
        ? "每个一级 Skill 目录对应一张卡片；点击后按真实目录层级展开子目录与 Markdown 文档。"
        : "目录只负责分类，子目录不会占用界面层级。点击卡片进入完整 Markdown 阅读页。";

  return (
    <main className="knowledge-home">
      <section className="category-strip" aria-label="知识库分类">
        {categoryItems.map((item) => (
          <button
            key={item.id}
            type="button"
            className="category-button"
            data-active={category === item.id || undefined}
            onClick={() => setCategory(item.id)}
          >
            <span>{item.label}</span>
            <small>{String(item.count).padStart(2, "0")}</small>
          </button>
        ))}
      </section>

      <section className="retro-masthead" aria-labelledby="knowledge-masthead-title">
        <div className="masthead-ribbon">
          <span>JIMU / 02</span>
          <strong>复利工程</strong>
          <small>COMPOUND SYSTEM</small>
        </div>
        <div className="masthead-copy">
          <span className="masthead-overline">WELCOME TO YOUR SECOND BRAIN</span>
          <h2 id="knowledge-masthead-title">知识卡片</h2>
          <em>JIMU KNOWLEDGE</em>
          <p>把长期有价值的项目、方法、内容与判断，沉淀成可继续生长的知识网络。</p>
        </div>
        <div className="masthead-index">
          <span>LOCAL ARCHIVE</span>
          <strong>{indexData.stats.archiveCards}</strong>
          <em>CARDS</em>
          <small>CAPTURE · LINK · COMPOUND</small>
        </div>
      </section>

      <section className="knowledge-intro">
        <div>
          <span className="section-kicker">CARD ARCHIVE / 只读投影</span>
          <h2>{activeCategory.label === "全部" ? "全部卡片" : activeCategory.label}</h2>
          <p>{categoryDescription}</p>
        </div>
        <div className="sort-control" role="group" aria-label="卡片排序">
          <button type="button" data-active={sort === "number" || undefined} onClick={() => setSort("number")}>
            <SquaresFour size={15} />编号优先
          </button>
          <button type="button" data-active={sort === "recent" || undefined} onClick={() => setSort("recent")}>
            <ClockCounterClockwise size={15} />最近修改
          </button>
        </div>
      </section>

      <div className="collection-meta">
        <span>{activeCategory.directory}</span>
        <span>{activeCategory.documentCount} 份 Markdown · 当前展示 {visibleDocuments.length} 张档案卡</span>
      </div>

      {visibleDocuments.length === 0 && allBenchmarkAccounts.length === 0 ? (
        <section className="empty-category">
          <span className="empty-icon"><FolderOpen size={34} weight="duotone" /></span>
          <span className="section-kicker">ARCHIVE / EMPTY</span>
          <h3>这个分类暂时没有可展示内容</h3>
          <p>JiMu 只读取当前知识库中的 Markdown，不会自动复制运行时 Skill 或向知识库写入索引。</p>
        </section>
      ) : category === "all" ? (
        <>
          {projectDocuments.length > 0 && (
            <HScrollSection
              number="01"
              kicker="PROJECTS / 项目"
              title="项目"
              caption="全部项目档案；新增项目会自动出现在这里，左右滑动查看。"
            >
              {projectDocuments.map((document, index) => (
                <ProjectDirectoryCard key={document.stableId} project={document} index={index} onOpen={onOpenProject ?? onOpen} />
              ))}
            </HScrollSection>
          )}
          {allBenchmarkAccounts.length > 0 && (
            <HScrollSection
              number="02"
              kicker="BENCHMARK / 对标博主"
              title="对标博主"
              caption="抓取到的对标博主档案；新增博主会自动出现在这里，左右滑动查看。"
            >
              {allBenchmarkAccounts.map((document, index) => (
                <BenchmarkAccountCard key={document.stableId} account={document} index={index} onOpen={onOpenAccount ?? onOpen} />
              ))}
            </HScrollSection>
          )}
          {otherDocuments.length > 0 && (
            <>
              <BenchmarkSectionHeading
                number="03"
                kicker="CARD ARCHIVE / 知识卡片"
                title="知识卡片"
                caption="知识、内容、灵感与其余档案卡片。"
              />
              <section className="card-grid">
                {otherDocuments.map((document, index) => (
                  <Card
                    key={document.stableId ?? document.id}
                    document={document}
                    index={index}
                    duplicate={(titleCounts.get(document.title) ?? 0) > 1}
                    onOpen={onOpen}
                  />
                ))}
              </section>
            </>
          )}
        </>
      ) : category === "benchmarks" ? (
        <>
          <section className="benchmark-section">
            <BenchmarkSectionHeading
              number="01"
              kicker="BLOG DIRECTORY / 博主目录"
              title="博主目录"
              caption="抓取到的对标博主档案；每个博主一张知识卡，点击进入档案详情。"
            />
            {accountDocuments.length > 0 && (
              <div className="account-grid" aria-label="对标博主账号总览">
                {accountDocuments.map((document, index) => (
                  <BenchmarkAccountCard key={document.stableId} account={document} index={index} onOpen={onOpenAccount ?? onOpen} />
                ))}
              </div>
            )}
            {benchmarkDirectory.length > 0 && (
              <div className="card-grid">
                {benchmarkDirectory.map((document, index) => (
                  <Card key={document.stableId} document={document} index={index} duplicate={false} onOpen={onOpen} />
                ))}
              </div>
            )}
          </section>

          <section className="benchmark-section">
            <BenchmarkSectionHeading
              number="02"
              kicker="COLLECTION STANDARDS / 采集规范"
              title="采集规范"
              caption="采集流程、字段口径、原始响应留存与媒体处理的全库规范。"
            />
            {benchmarkStandards.length > 0 ? (
              <div className="card-grid">
                {benchmarkStandards.map((document, index) => (
                  <Card key={document.stableId} document={document} index={index} duplicate={false} onOpen={onOpen} />
                ))}
              </div>
            ) : (
              <div className="benchmark-section-empty"><p>暂无规范文档。</p></div>
            )}
          </section>

          <section className="benchmark-section">
            <BenchmarkSectionHeading
              number="03"
              kicker="BENCHMARK INSIGHTS / 经验总结沉淀"
              title="经验总结沉淀"
              caption="博主拆解后的高维度经验：可迁移、可复制、可复用的方法结论。"
            />
            {benchmarkInsights.length > 0 ? (
              <div className="card-grid">
                {benchmarkInsights.map((document, index) => (
                  <Card key={document.stableId} document={document} index={index} duplicate={false} onOpen={onOpen} />
                ))}
              </div>
            ) : (
              <div className="benchmark-section-empty">
                <p>暂无经验沉淀。把博主拆解中可复用、可迁移的机制提炼后，归档到「横向对标」目录，就会出现在这里。</p>
              </div>
            )}
          </section>
        </>
      ) : category === "projects" ? (
        <>
          {projectDocuments.length > 0 && (
            <section className="project-grid" aria-label="项目目录">
              {projectDocuments.map((document, index) => (
                <ProjectDirectoryCard key={document.stableId} project={document} index={index} onOpen={onOpenProject ?? onOpen} />
              ))}
            </section>
          )}
          {otherDocuments.length > 0 && (
            <>
              {projectDocuments.length > 0 && (
                <div className="auxiliary-heading">
                  <span className="section-kicker">PROJECT LIBRARY / 项目库说明</span>
                  <span>项目内部文档在项目卡内陈列，不单独占卡</span>
                </div>
              )}
              <section className="card-grid">
                {otherDocuments.map((document, index) => (
                  <Card
                    key={document.stableId ?? document.id}
                    document={document}
                    index={index}
                    duplicate={(titleCounts.get(document.title) ?? 0) > 1}
                    onOpen={onOpen}
                  />
                ))}
              </section>
            </>
          )}
        </>
      ) : (
        <>
          {projectDocuments.length > 0 && (
            <section className="project-grid" aria-label="项目目录">
              {projectDocuments.map((document, index) => (
                <ProjectDirectoryCard key={document.stableId} project={document} index={index} onOpen={onOpenProject ?? onOpen} />
              ))}
            </section>
          )}
          {otherDocuments.length > 0 && (
            <section className="card-grid">
              {otherDocuments.map((document, index) => (
                <Card
                  key={document.stableId ?? document.id}
                  document={document}
                  index={index}
                  duplicate={(titleCounts.get(document.title) ?? 0) > 1}
                  onOpen={onOpen}
                />
              ))}
            </section>
          )}
        </>
      )}
    </main>
  );
}

function HighlightedText({ text, query }) {
  const needle = query?.trim();
  if (!needle) return text;
  const normalizedText = text.toLocaleLowerCase("zh-CN");
  const normalizedNeedle = needle.toLocaleLowerCase("zh-CN");
  const pieces = [];
  let cursor = 0;
  let match = normalizedText.indexOf(normalizedNeedle, cursor);
  while (match >= 0) {
    if (match > cursor) pieces.push(text.slice(cursor, match));
    pieces.push(<mark key={`${match}-${pieces.length}`}>{text.slice(match, match + needle.length)}</mark>);
    cursor = match + needle.length;
    match = normalizedText.indexOf(normalizedNeedle, cursor);
  }
  if (cursor === 0) return text;
  if (cursor < text.length) pieces.push(text.slice(cursor));
  return pieces;
}

const READER_SCROLL_POSITIONS = new Map();

function readerSlug(value, fallback = "section") {
  return value.normalize("NFKC").toLocaleLowerCase("zh-CN")
    .replace(/[^\p{Letter}\p{Number}\u3400-\u9fff]+/gu, "-")
    .replace(/^-+|-+$/g, "") || fallback;
}

function countTreeDocuments(node) {
  return (node?.children ?? []).reduce((total, child) => (
    total + (child.kind === "document" ? 1 : countTreeDocuments(child))
  ), 0);
}

function SkillTreeNode({ node, depth, onOpen }) {
  const [expanded, setExpanded] = useState(depth === 0);
  if (node.kind === "document") {
    return (
      <li className="skill-tree-document" style={{ "--tree-depth": depth }}>
        <button type="button" onClick={() => onOpen(node.stableId)}>
          <FileText size={16} weight="duotone" />
          <span><strong>{node.name}</strong><small>{node.title !== node.name ? node.title : node.filename}</small></span>
          <ArrowUpRight size={14} weight="bold" />
        </button>
      </li>
    );
  }
  const documentCount = countTreeDocuments(node);
  return (
    <li className="skill-tree-directory" style={{ "--tree-depth": depth }} data-expanded={expanded || undefined}>
      <button type="button" className="skill-tree-directory-trigger" onClick={() => setExpanded((value) => !value)} aria-expanded={expanded}>
        {expanded ? <CaretDown size={15} weight="bold" /> : <CaretRight size={15} weight="bold" />}
        {expanded ? <FolderOpen size={17} weight="duotone" /> : <Folder size={17} weight="duotone" />}
        <strong>{node.name}</strong>
        <small>{documentCount} DOCS</small>
      </button>
      {expanded && node.children?.length > 0 && (
        <ul>{node.children.map((child) => <SkillTreeNode key={child.path} node={child} depth={depth + 1} onOpen={onOpen} />)}</ul>
      )}
    </li>
  );
}

function SkillDirectoryBrowser({ tree, onOpen }) {
  if (!tree) return null;
  return (
    <section className="skill-directory-browser" aria-labelledby="skill-directory-title">
      <header>
        <span className="section-number">DIR</span>
        <div><h3 id="skill-directory-title">Skill 目录</h3><p>保留真实目录层级；展开文件夹后可直接阅读对应 Markdown。</p></div>
        <strong>{countTreeDocuments(tree)} DOCS</strong>
      </header>
      <ul className="skill-tree-root"><SkillTreeNode node={tree} depth={0} onOpen={onOpen} /></ul>
    </section>
  );
}

function Reader({ document, documentById, searchQuery, initialAnchor, onClose, onOpen, canBack, canForward, onBack, onForward }) {
  const category = CATEGORY_BY_ID[document.category] ?? { label: document.categoryLabel, directory: document.sourcePath.split("/")[0] };
  const relationIds = document.relatedIds ?? document.related ?? [];
  const related = relationIds.map((id) => documentById.get(id)).filter(Boolean).slice(0, 12);
  const articleRef = useRef(null);
  const matchesRef = useRef([]);
  const [loaded, setLoaded] = useState(null);
  const [loadError, setLoadError] = useState(null);
  const [linkError, setLinkError] = useState(null);
  const [assetPreview, setAssetPreview] = useState(null);
  const [assetMap, setAssetMap] = useState(new Map());
  const [toc, setToc] = useState([]);
  const [matchIndex, setMatchIndex] = useState(0);
  const [matchCount, setMatchCount] = useState(0);

  useEffect(() => {
    let active = true;
    setLoaded(null);
    setLoadError(null);
    setLinkError(null);
    setAssetPreview(null);
    void knowledgeApi.readDocument({ sourcePath: document.sourcePath, stableId: document.stableId }).then(async (value) => {
      if (!active) return;
      setLoaded(value);
      const imageHrefs = [...value.markdown.matchAll(/!\[[^\]]*\]\(([^)\s]+)(?:\s+["'][^"']*["'])?\)/g)].map((match) => match[1]);
      const resolved = await Promise.all([...new Set(imageHrefs)].map(async (href) => {
        try {
          return [href, await knowledgeApi.resolveLink({ fromPath: value.sourcePath, href })];
        } catch (error) {
          return [href, { kind: "blocked", reason: error instanceof Error ? error.message : String(error) }];
        }
      }));
      if (active) setAssetMap(new Map(resolved));
    }).catch((error) => {
      if (active) setLoadError(error instanceof Error ? error.message : String(error));
    });
    return () => { active = false; };
  }, [document.sourcePath, document.stableId]);

  useEffect(() => {
    const scroller = globalThis.document.querySelector(".knowledge-module-body");
    if (!scroller) return undefined;
    const saved = READER_SCROLL_POSITIONS.get(document.stableId) ?? 0;
    requestAnimationFrame(() => { scroller.scrollTop = initialAnchor ? 0 : saved; });
    return () => READER_SCROLL_POSITIONS.set(document.stableId, scroller.scrollTop);
  }, [document.stableId, initialAnchor]);

  useEffect(() => {
    const root = articleRef.current;
    if (!root || !loaded) return;
    for (const mark of root.querySelectorAll("mark[data-jimu-search]")) mark.replaceWith(globalThis.document.createTextNode(mark.textContent ?? ""));
    root.normalize();

    const used = new Set();
    const nextToc = [...root.querySelectorAll("h1, h2, h3")].map((heading, index) => {
      const base = readerSlug(heading.textContent ?? "", `section-${index + 1}`);
      let id = base;
      let suffix = 2;
      while (used.has(id)) id = `${base}-${suffix++}`;
      used.add(id);
      heading.id = id;
      return { id, title: heading.textContent ?? "", level: Number(heading.tagName.slice(1)) };
    });
    setToc(numberReaderOutline(nextToc));

    const query = searchQuery?.trim();
    const marks = [];
    if (query) {
      const escaped = query.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
      const expression = new RegExp(escaped, "giu");
      const walker = globalThis.document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
      const textNodes = [];
      while (walker.nextNode()) {
        const node = walker.currentNode;
        if (node.parentElement?.closest("pre, code, mark, button, a")) continue;
        if (expression.test(node.nodeValue ?? "")) textNodes.push(node);
        expression.lastIndex = 0;
      }
      for (const node of textNodes) {
        const text = node.nodeValue ?? "";
        const fragment = globalThis.document.createDocumentFragment();
        let cursor = 0;
        for (const match of text.matchAll(expression)) {
          if (match.index > cursor) fragment.append(text.slice(cursor, match.index));
          const mark = globalThis.document.createElement("mark");
          mark.dataset.jimuSearch = "true";
          mark.textContent = match[0];
          fragment.append(mark);
          marks.push(mark);
          cursor = match.index + match[0].length;
        }
        if (cursor < text.length) fragment.append(text.slice(cursor));
        node.replaceWith(fragment);
      }
    }
    matchesRef.current = marks;
    setMatchCount(marks.length);
    setMatchIndex(0);
    requestAnimationFrame(() => {
      const target = initialAnchor ? root.querySelector(`#${CSS.escape(initialAnchor)}`) : marks[0];
      target?.scrollIntoView({ behavior: "smooth", block: "center" });
    });
  }, [initialAnchor, loaded, searchQuery]);

  useEffect(() => {
    matchesRef.current[matchIndex]?.scrollIntoView({ behavior: "smooth", block: "center" });
  }, [matchIndex]);

  async function handleLink(event, href) {
    event.preventDefault();
    setLinkError(null);
    try {
      const result = await knowledgeApi.resolveLink({ fromPath: loaded.sourcePath, href });
      if (result.kind === "external") {
        if (globalThis.window.jimu) await globalThis.window.jimu.shell.openExternal(result.href);
        else globalThis.open(result.href, "_blank", "noopener,noreferrer");
        return;
      }
      if (result.kind === "document" || result.kind === "anchor") {
        onOpen(result.stableId, "", result.anchor ?? "");
        return;
      }
      if (result.kind === "localAsset") {
        setAssetPreview(result);
        return;
      }
      const messages = {
        missing: result.reason === "anchor-not-found" ? "目标标题锚点不存在。" : "内链目标文件不存在或索引已经失效。",
        blocked: result.reason === "absolute-path-outside-root"
          ? "该链接指向知识库外的本地文件。JiMu 只预览知识库根目录内的附件；请把图片放入知识库 assets 后改用相对链接。"
          : `JiMu 已阻止不安全链接：${result.reason ?? "路径越界"}`,
        localFile: "该本地文件不是可在知识阅读器中打开的 Markdown 或图片。",
      };
      setLinkError(messages[result.kind] ?? "无法打开这个链接。");
    } catch (error) {
      setLinkError(error instanceof Error ? error.message : String(error));
    }
  }

  const markdown = loaded ? prepareWikiLinks(loaded.markdown.replace(/^#\s+.+?(?:\r?\n|$)/, "")) : "";

  return (
    <main className="reader-shell">
      <div className="reader-toolbar">
        <div className="reader-history">
          <button type="button" onClick={onBack} disabled={!canBack} aria-label="后退"><ArrowLeft size={17} weight="bold" /></button>
          <button type="button" onClick={onForward} disabled={!canForward} aria-label="前进"><ArrowRight size={17} weight="bold" /></button>
        </div>
        <button className="back-to-cards" type="button" onClick={onClose}><SquaresFour size={16} weight="bold" />返回卡片</button>
        <div className="reader-breadcrumb"><span>知识库</span><i>/</i><span>{category.label}</span><i>/</i><strong>{document.title}</strong></div>
        {searchQuery && (
          <div className="reader-search-location">
            <span>“{searchQuery}”</span>
            <button type="button" disabled={matchCount === 0} onClick={() => setMatchIndex((index) => (index - 1 + matchCount) % matchCount)} aria-label="上一个命中">↑</button>
            <strong>{matchCount === 0 ? "0 / 0" : `${matchIndex + 1} / ${matchCount}`}</strong>
            <button type="button" disabled={matchCount === 0} onClick={() => setMatchIndex((index) => (index + 1) % matchCount)} aria-label="下一个命中">↓</button>
          </div>
        )}
        <span className="readonly-badge">READ ONLY</span>
      </div>

      {linkError && <div className="reader-link-notice"><ShieldCheck size={17} weight="fill" /><span>{linkError}</span><button type="button" onClick={() => setLinkError(null)}>关闭</button></div>}

      <div className="reader-layout">
        <article className="document-paper" data-accent={document.accent}>
          <header className="document-header">
            <span className="document-index">{TYPE_LABELS[document.type] ?? document.type ?? document.order}</span>
            <span className="document-kicker">{document.eyebrow}</span>
            <h2>{document.title}</h2>
            <div className="document-meta">
              <span>{document.sourcePath ?? category.directory}</span><span>UPDATED / {document.date}</span><span>{document.virtual ? "GENERATED PROFILE" : "MARKDOWN"}</span>
            </div>
          </header>
          <div className="document-body markdown-reader" ref={articleRef}>
            {!loaded && !loadError && <div className="reader-loading"><span className="index-loader" />正在读取 Markdown…</div>}
            {loadError && <div className="reader-inline-error"><X size={22} weight="bold" /><strong>文档读取失败</strong><p>{loadError}</p></div>}
            {loaded && (
              <ReactMarkdown
                remarkPlugins={[remarkGfm]}
                skipHtml
                urlTransform={(url) => url}
                components={{
                  a: ({ href = "", children }) => <a href={href} onClick={(event) => void handleLink(event, href)}>{children}</a>,
                  img: ({ src = "", alt = "" }) => {
                    const resolved = assetMap.get(src);
                    return resolved?.kind === "localAsset"
                      ? <img src={resolved.assetUrl} alt={alt} loading="lazy" />
                      : <span className="markdown-image-blocked"><ShieldCheck size={16} />{resolved?.kind === "external" ? "外部图片未自动加载" : `图片不可用：${alt || src}`}</span>;
                  },
                  input: (props) => <input {...props} disabled />,
                }}
              >{markdown}</ReactMarkdown>
            )}

            {document.type === "SkillDirectory" && loaded && <SkillDirectoryBrowser tree={document.directoryTree} onOpen={onOpen} />}

            {document.type !== "SkillDirectory" && related.length > 0 && (
              <section id="related" className="related-section">
                <span className="section-number">LINKS</span><h3>已解析关联卡片</h3>
                <p>这些关联来自 Markdown 中真实存在且能解析的内链。</p>
                <div className="related-links">
                  {related.map((item) => (
                    <button type="button" key={item.stableId ?? item.id} onClick={() => onOpen(item.stableId ?? item.id)}>
                      <LinkSimple size={16} weight="bold" /><span>{item.title}</span><ArrowUpRight size={15} weight="bold" />
                    </button>
                  ))}
                </div>
              </section>
            )}
          </div>
        </article>

        <aside className="document-toc">
          <span className="section-kicker">ON THIS CARD</span>
          {toc.map((section) => (
            <a key={section.id} href={`#${section.id}`} data-level={section.level} data-depth={section.depth} onClick={(event) => {
              event.preventDefault();
              articleRef.current?.querySelector(`#${CSS.escape(section.id)}`)?.scrollIntoView({ behavior: "smooth", block: "start" });
            }}><span className="toc-entry"><span className="toc-index">{section.displayIndex}</span><span className="toc-title">{section.title}</span></span></a>
          ))}
          {document.type !== "SkillDirectory" && related.length > 0 && <a href="#related"><span className="toc-entry"><span className="toc-index">→</span><span className="toc-title">关联卡片</span></span></a>}
          <div className="toc-note"><BookOpenText size={20} weight="duotone" /><p>完整 Markdown 只读渲染；外部图片不会自动请求。</p></div>
        </aside>
      </div>

      {assetPreview && (
        <div className="asset-preview" role="dialog" aria-modal="true" aria-label="本地图片预览" onClick={() => setAssetPreview(null)}>
          <div onClick={(event) => event.stopPropagation()}>
            <header><span>LOCAL ASSET</span><strong>{assetPreview.sourcePath}</strong><button type="button" onClick={() => setAssetPreview(null)} aria-label="关闭图片预览"><X size={18} weight="bold" /></button></header>
            <img src={assetPreview.assetUrl} alt={assetPreview.sourcePath} />
          </div>
        </div>
      )}
    </main>
  );
}

function KnowledgeSectionNav({ section, setSection, onSearch }) {
  return (
    <div className="knowledge-section-nav">
      <nav aria-label="知识库一级导航">
        {KNOWLEDGE_SECTIONS.map((item, index) => (
          <button type="button" key={item.id} data-active={section === item.id || undefined} onClick={() => setSection(item.id)}>
            <span>{String(index + 1).padStart(2, "0")}</span>
            <strong>{item.label}</strong>
            <small>{item.caption}</small>
          </button>
        ))}
      </nav>
      <button className="global-search-trigger" type="button" onClick={onSearch}>
        <MagnifyingGlass size={16} weight="bold" />
        <span>搜索全部档案</span>
        <kbd>⌘ K</kbd>
      </button>
    </div>
  );
}

function OverviewStat({ value, label, caption, accent }) {
  return (
    <div className="overview-stat" data-accent={accent}>
      <strong>{value}</strong><span>{label}</span><small>{caption}</small>
    </div>
  );
}

function KnowledgeOverview({ indexData, onNavigate, modules }) {
  const [activeStage, setActiveStage] = useState("inspiration");
  const stage = ROADMAP_STAGES.find((item) => item.id === activeStage) ?? ROADMAP_STAGES[0];
  return (
    <main className="knowledge-overview">
      <section className="overview-hero">
        <div className="overview-title-block">
          <span className="section-kicker">COMPOUND ENGINEERING / 使用路线图</span>
          <h2>知识不是收集出来的，<br /><em>是验证后沉淀出来的。</em></h2>
          <p>灵感、讨论、计划、执行日志和反馈都是过程资料；只有经过实践验证、复盘压缩并具备长期复用价值的内容，才成为正式知识卡。</p>
        </div>
        <div className="overview-stats" aria-label="实时知识库统计">
          <OverviewStat value={indexData.stats.inspirations} label="项目灵感" caption="01-INBOX" accent="yellow" />
          <OverviewStat value={indexData.stats.projects} label="项目文档" caption="02-PROJECTS" accent="teal" />
          <OverviewStat value={indexData.stats.knowledgeCards} label="正式知识" caption="03-KNOWLEDGE" accent="cobalt" />
          {modules.benchmarks && <OverviewStat value={indexData.stats.benchmarkProfiles} label="博主档案" caption="REAL PROFILES" accent="magenta" />}
        </div>
      </section>

      <section className="roadmap-panel">
        <div className="roadmap-head">
          <span><strong>复利工程</strong><small>从原始灵感到长期知识</small></span>
          <em>{indexData.stats.markdownDocuments} 份 Markdown · {indexData.stats.internalLinks} 条已解析内链 · {new Date(indexData.indexedAt).toLocaleTimeString("zh-CN", { hour: "2-digit", minute: "2-digit" })} 更新</em>
        </div>
        <div className="roadmap-track" role="list" aria-label="复利工程路线图">
          {ROADMAP_STAGES.map((item, index) => (
            <button
              type="button"
              role="listitem"
              key={item.id}
              data-active={activeStage === item.id || undefined}
              onClick={() => setActiveStage(item.id)}
            >
              <span>{item.number}</span><strong>{item.title}</strong><small>{item.output}</small>
              {index < ROADMAP_STAGES.length - 1 && <i aria-hidden="true"><ArrowRight size={13} weight="bold" /></i>}
            </button>
          ))}
        </div>
        <div className="roadmap-detail" key={stage.id}>
          <div className="roadmap-detail-title"><span>{stage.number}</span><div><small>ACTIVE STAGE</small><h3>{stage.title}</h3></div></div>
          <dl>
            <div><dt>解决的问题</dt><dd>{stage.problem}</dd></div>
            <div><dt>输入</dt><dd>{stage.input}</dd></div>
            <div><dt>主要动作</dt><dd>{stage.action}</dd></div>
            <div><dt>输出</dt><dd>{stage.output}</dd></div>
            <div><dt>前后关系</dt><dd>{stage.relation}</dd></div>
          </dl>
          <button type="button" onClick={() => onNavigate(stage.target)}>{stage.entry}<ArrowUpRight size={15} weight="bold" /></button>
        </div>
      </section>

      <section className="overview-quick-actions" aria-label="快捷入口">
        <span>QUICK ENTRY</span>
        <button type="button" onClick={() => onNavigate({ mode: "archive", category: "inbox" })}><Lightning size={16} weight="fill" />查看项目灵感</button>
        <button type="button" onClick={() => onNavigate({ mode: "agent" })}><ChatCircleDots size={16} weight="fill" />进入 Agent 讨论</button>
        <button type="button" onClick={() => onNavigate({ mode: "archive", category: "projects" })}><FolderOpen size={16} weight="fill" />查看进行中的项目</button>
        <button type="button" onClick={() => onNavigate({ mode: "archive", category: "knowledge" })}><BookOpenText size={16} weight="fill" />浏览正式知识卡</button>
      </section>
    </main>
  );
}

function KnowledgeGraph({ onOpen, categories = CATEGORIES, modules }) {
  const containerRef = useRef(null);
  const graphRef = useRef(null);
  const [graph, setGraph] = useState(null);
  const [phase, setPhase] = useState("loading");
  const [error, setError] = useState(null);
  const [query, setQuery] = useState("");
  const [category, setCategory] = useState("all");
  const [type, setType] = useState("all");
  const [source, setSource] = useState("key");
  const [hideIsolated, setHideIsolated] = useState(true);
  const [selected, setSelected] = useState(null);

  const fitGraph = useCallback((padding = 30) => {
    const instance = graphRef.current;
    if (!instance) return;
    instance.fit(undefined, padding);
    if (instance.zoom() < 0.62) {
      instance.zoom(0.62);
      instance.center();
    }
  }, []);

  const relayoutGraph = useCallback(() => {
    const instance = graphRef.current;
    if (!instance) return;
    instance.one("layoutstop", () => fitGraph(30));
    instance.layout({ ...GRAPH_LAYOUT_OPTIONS, animate: true, animationDuration: 420 }).run();
  }, [fitGraph]);

  const graphLabel = useCallback((node) => {
    const limit = node.type === "Category" ? 10 : node.type === "Group" ? 18 : 28;
    const characters = Array.from(node.title ?? "未命名节点");
    return characters.length > limit ? `${characters.slice(0, limit).join("")}…` : characters.join("");
  }, []);

  useEffect(() => {
    let active = true;
    const timer = setTimeout(() => {
      setPhase("loading");
      void knowledgeApi.graph({
        query,
        categories: category === "all" ? [] : [category],
        types: type === "all" ? [] : [type],
        sources: source === "all" || source === "key" ? [] : [source],
        focus: source === "key" ? "key" : "all",
        maxDocuments: source === "key" ? 10 : 40,
        hideIsolated,
      }).then((value) => {
        if (!active) return;
        setGraph(value);
        setPhase("ready");
        setError(null);
      }).catch((cause) => {
        if (!active) return;
        setPhase("error");
        setError(cause instanceof Error ? cause.message : String(cause));
      });
    }, 120);
    return () => { active = false; clearTimeout(timer); };
  }, [category, hideIsolated, query, source, type]);

  useEffect(() => {
    if (!containerRef.current || !graph) return undefined;
    graphRef.current?.destroy();
    const linkDegree = new Map();
    for (const edge of graph.edges.filter((item) => item.type === "links_to")) {
      linkDegree.set(edge.source, (linkDegree.get(edge.source) ?? 0) + 1);
      linkDegree.set(edge.target, (linkDegree.get(edge.target) ?? 0) + 1);
    }
    const visibleDocuments = new Set(graph.nodes
      .filter((node) => node.type !== "Category" && node.type !== "Group")
      .filter((node) => !hideIsolated || (linkDegree.get(node.stableId) ?? 0) > 0)
      .map((node) => node.stableId));
    const belongs = new Map(graph.edges.filter((edge) => edge.type === "belongs_to").map((edge) => [edge.source, edge.target]));
    const visibleParents = new Set();
    for (const id of visibleDocuments) {
      let parent = belongs.get(id);
      while (parent) {
        visibleParents.add(parent);
        parent = belongs.get(parent);
      }
    }
    const nodes = graph.nodes.filter((node) => visibleDocuments.has(node.stableId) || visibleParents.has(node.stableId));
    const nodeIds = new Set(nodes.map((node) => node.stableId));
    const elements = [
      ...nodes.map((node) => ({
        data: {
          id: node.stableId,
          label: graphLabel(node),
          type: node.type,
          source: node.selectionSource,
          payload: node,
        },
      })),
      ...graph.edges.filter((edge) => nodeIds.has(edge.source) && nodeIds.has(edge.target)).map((edge) => ({
        data: { id: edge.stableId, source: edge.source, target: edge.target, type: edge.type },
      })),
    ];
    const instance = cytoscape({
      container: containerRef.current,
      elements,
      minZoom: 0.18,
      maxZoom: 3.2,
      wheelSensitivity: 0.18,
      style: [
        { selector: "node", style: { "background-color": "#00a69c", color: "#fff8dd", label: "data(label)", "font-family": "IBM Plex Mono", "font-size": 9.5, "font-weight": 700, "line-height": 1.22, "text-wrap": "wrap", "text-max-width": 132, "text-halign": "center", "text-valign": "bottom", "text-justification": "center", "text-margin-y": 15, "text-background-color": "#080629", "text-background-opacity": 0.94, "text-background-padding": 4, "text-background-shape": "roundrectangle", "text-outline-color": "#080629", "text-outline-width": 1, width: 52, height: 52, shape: "ellipse", "border-width": 3, "border-color": "#fff0c7", "shadow-color": "#080629", "shadow-opacity": 0.58, "shadow-blur": 0, "shadow-offset-x": 6, "shadow-offset-y": 6 } },
        { selector: "node[source = 'hot']", style: { "background-color": "#f62669", "border-color": "#fff0c7", width: 62, height: 62 } },
        { selector: "node[source = 'memory']", style: { "background-color": "#2364df", "border-color": "#00d3c8", width: 58, height: 58 } },
        { selector: "node[source = 'benchmark']", style: { "background-color": "#ffd116", "border-color": "#f62669", width: 64, height: 64 } },
        { selector: "node[type = 'Inspiration']", style: { shape: "star", width: 70, height: 70 } },
        { selector: "node[type = 'Conversation']", style: { shape: "round-rectangle", width: 68, height: 52 } },
        { selector: "node[type = 'Decision']", style: { shape: "round-diamond", width: 64, height: 64 } },
        { selector: "node[type = 'Plan']", style: { shape: "round-triangle", width: 68, height: 66 } },
        { selector: "node[type = 'Project']", style: { shape: "round-hexagon", width: 70, height: 64 } },
        { selector: "node[type = 'Execution']", style: { shape: "cut-rectangle", width: 66, height: 58 } },
        { selector: "node[type = 'Review']", style: { shape: "round-pentagon", width: 66, height: 66 } },
        { selector: "node[type = 'KnowledgeCard']", style: { shape: "ellipse", width: 62, height: 62 } },
        { selector: "node[type = 'BenchmarkAccount']", style: { shape: "round-pentagon", width: 70, height: 70 } },
        { selector: "node[type = 'BenchmarkMaterial']", style: { shape: "hexagon", width: 62, height: 58 } },
        { selector: "node[type = 'Content']", style: { shape: "barrel", width: 68, height: 58 } },
        { selector: "node[type = 'Business']", style: { shape: "round-tag", width: 70, height: 54 } },
        { selector: "node[type = 'Category']", style: { "background-color": "#ffd116", "border-color": "#f62669", "border-width": 4, color: "#fff0c7", "font-size": 10.5, "font-weight": 850, width: 66, height: 54, shape: "rectangle", "shadow-color": "#00d3c8", "shadow-opacity": 1, "shadow-offset-x": 6, "shadow-offset-y": 6 } },
        { selector: "node[type = 'Group']", style: { "background-color": "#00a69c", "border-color": "#080629", "border-width": 3, color: "#00d3c8", "font-size": 8.5, width: 50, height: 50, shape: "diamond", "shadow-color": "#f62669", "shadow-opacity": 0.66, "shadow-offset-x": 4, "shadow-offset-y": 4 } },
        { selector: "edge[type = 'links_to']", style: { width: 3, "line-color": "#777fdd", "target-arrow-color": "#ffd116", "target-arrow-shape": "triangle", "arrow-scale": 0.82, "curve-style": "bezier", opacity: 0.82 } },
        { selector: "edge[type = 'belongs_to']", style: { width: 1.5, "line-color": "#00a69c", "line-style": "solid", "target-arrow-shape": "none", "curve-style": "bezier", opacity: 0.5 } },
        { selector: ".neighbor", style: { "border-color": "#ffd116", "border-width": 4, "line-color": "#ffd116", "target-arrow-color": "#ffd116", opacity: 1, "z-index": 20 } },
        { selector: ".hovered", style: { "overlay-color": "#fff0c7", "overlay-opacity": 0.13, "overlay-padding": 10, "shadow-color": "#f62669", "shadow-opacity": 0.8, "shadow-blur": 16 } },
        { selector: ":selected", style: { "overlay-color": "#f62669", "overlay-opacity": 0.16, "border-color": "#fff0c7", "border-width": 4 } },
      ],
      layout: { ...GRAPH_LAYOUT_OPTIONS, animate: false },
    });
    instance.on("mouseover", "node", (event) => {
      const node = event.target;
      instance.elements().removeClass("neighbor hovered");
      node.closedNeighborhood().addClass("neighbor");
      node.addClass("hovered");
    });
    instance.on("mouseout", "node", () => instance.elements().removeClass("neighbor hovered"));
    instance.on("tap", "node", (event) => {
      const node = event.target.data("payload");
      if (node?.sourcePath && node.type !== "Category" && node.type !== "Group") {
        onOpen(node.stableId);
        return;
      }
      setSelected(node ?? null);
    });
    graphRef.current = instance;
    requestAnimationFrame(() => fitGraph(30));
    return () => {
      instance.destroy();
      if (graphRef.current === instance) graphRef.current = null;
    };
  }, [fitGraph, graph, graphLabel, hideIsolated, onOpen]);

  const graphTypes = [...new Set((graph?.nodes ?? []).filter((node) => node.type !== "Category" && node.type !== "Group").map((node) => node.type))].sort();

  return (
    <main className="knowledge-graph-live">
      <header className="graph-live-head">
        <div><span className="section-kicker">CURATED KNOWLEDGE GRAPH / 真实精选</span><h2>只画得出依据的关系</h2><p>节点来自 Hot Index、Memory Index 与真实博主档案；边只表示目录归属和 Markdown 内链。</p></div>
        <div className="graph-live-stats"><strong>{graph?.stats.selectedDocuments ?? 0}</strong><span>精选档案</span><strong>{graph?.stats.links ?? 0}</strong><span>真实内链</span></div>
      </header>
      <section className="graph-controls">
        <label><MagnifyingGlass size={15} weight="bold" /><input value={query} onChange={(event) => setQuery(event.target.value)} placeholder="搜索图谱节点" /></label>
        <select value={category} onChange={(event) => setCategory(event.target.value)}><option value="all">全部分类</option>{categories.filter((item) => item.id !== "all").map((item) => <option value={item.id} key={item.id}>{item.label}</option>)}</select>
        <select value={type} onChange={(event) => setType(event.target.value)}><option value="all">全部类型</option>{graphTypes.map((item) => <option value={item} key={item}>{TYPE_LABELS[item] ?? item}</option>)}</select>
        <select value={source} onChange={(event) => setSource(event.target.value)}><option value="key">关键节点（推荐）</option><option value="hot">Hot Index</option><option value="memory">Memory Index</option>{modules.benchmarks && <option value="benchmark">博主档案</option>}<option value="linked">关联节点</option><option value="all">全部精选来源</option></select>
        <label className="graph-isolate-toggle"><input type="checkbox" checked={hideIsolated} onChange={(event) => setHideIsolated(event.target.checked)} />隐藏无内链节点</label>
        <button type="button" onClick={() => fitGraph(30)}>适配视口</button>
        <button type="button" onClick={relayoutGraph}>重置布局</button>
      </section>
      <section className="graph-workbench">
        <div className="graph-canvas" ref={containerRef} aria-label="真实精选知识图谱" />
        {phase === "loading" && <div className="graph-overlay"><span className="index-loader" />正在生成真实关系图…</div>}
        {phase === "error" && <div className="graph-overlay error"><X size={27} weight="bold" /><strong>图谱生成失败</strong><p>{error}</p></div>}
        <aside className="graph-inspector" data-empty={!selected || undefined}>
          {!selected ? <><Brain size={26} weight="duotone" /><strong>选择一个节点</strong><p>点击档案节点直接进入知识卡；分类与目录节点用于查看归属结构。</p></> : <>
            <span className="graph-source-badge">{selected.selectionSource.toLocaleUpperCase()}</span>
            <h3>{selected.title}</h3><p>{selected.sourcePath ?? selected.type}</p>
            <dl><div><dt>类型</dt><dd>{TYPE_LABELS[selected.type] ?? selected.type}</dd></div><div><dt>阶段</dt><dd>{selected.stage ?? "—"}</dd></div><div><dt>标签</dt><dd>{selected.tags.join(" · ") || "—"}</dd></div><div><dt>出链 / 入链</dt><dd>{selected.outboundLinks.length} / {selected.inboundLinks.length}</dd></div></dl>
            {selected.sourcePath && selected.type !== "Category" && selected.type !== "Group" && <button type="button" onClick={() => onOpen(selected.stableId)}><BookOpenText size={16} weight="bold" />阅读原文</button>}
          </>}
        </aside>
      </section>
      <footer className="graph-proof-note">
        <span><ShieldCheck size={15} weight="fill" />没有相似度边、AI 推断边或装饰关系；索引更新后图谱同步刷新。</span>
        <span>形状＝内容类型 · 颜色＝精选来源 · 实线＝可验证关系</span>
      </footer>
    </main>
  );
}

function normalizeSearch(value) {
  return value.normalize("NFKC").toLocaleLowerCase("zh-CN").replace(/\s+/g, " ").trim();
}

function fuzzySimilarity(text, query) {
  if (!query || !text) return 0;
  if (text.includes(query)) return 1;
  let cursor = 0;
  for (const character of query) {
    cursor = text.indexOf(character, cursor);
    if (cursor < 0) return 0;
    cursor += 1;
  }
  return Math.max(0.25, query.length / Math.max(text.length, query.length));
}

function scoreDocument(document, query) {
  const normalizedQuery = normalizeSearch(query);
  if (!normalizedQuery) return { score: 1, field: "recent" };
  const tokens = normalizedQuery.split(/\s+/).filter(Boolean);
  const fields = [
    ["title", normalizeSearch(document.title), 150],
    ["heading", normalizeSearch(document.headings.join(" ")), 95],
    ["tag", normalizeSearch([...document.tags, ...document.aliases].join(" ")), 78],
    ["link", normalizeSearch(document.outboundLinks.map((link) => link.text).join(" ")), 55],
    ["body", normalizeSearch(document.content), 30],
    ["path", normalizeSearch(`${document.categoryLabel} ${document.sourcePath}`), 18],
  ];
  let score = 0;
  let field = "body";
  let bestFieldScore = 0;
  for (const [name, value, weight] of fields) {
    let fieldScore = 0;
    if (value === normalizedQuery) fieldScore += weight * 2.3;
    else if (value.includes(normalizedQuery)) fieldScore += weight * 1.5;
    for (const token of tokens) fieldScore += fuzzySimilarity(value, token) * weight;
    if (fieldScore > bestFieldScore) {
      bestFieldScore = fieldScore;
      field = name;
    }
    score += fieldScore;
  }
  return { score, field };
}

function searchSnippet(document, query) {
  const content = document.content || document.excerpt;
  const normalized = normalizeSearch(content);
  const tokens = normalizeSearch(query).split(/\s+/).filter(Boolean);
  let index = normalized.indexOf(normalizeSearch(query));
  if (index < 0) index = tokens.map((token) => normalized.indexOf(token)).find((value) => value >= 0) ?? -1;
  if (index < 0) return document.excerpt.slice(0, 190);
  const start = Math.max(0, index - 58);
  const end = Math.min(content.length, index + Math.max(query.length, 24) + 118);
  return `${start > 0 ? "…" : ""}${content.slice(start, end)}${end < content.length ? "…" : ""}`;
}

function SearchHighlightedText({ text, query }) {
  const tokens = [...new Set(normalizeSearch(query).split(/\s+/).filter(Boolean))];
  if (tokens.length === 0) return text;
  const escaped = tokens.map((token) => token.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).sort((a, b) => b.length - a.length);
  const expression = new RegExp(`(${escaped.join("|")})`, "giu");
  return text.split(expression).map((piece, index) => tokens.includes(normalizeSearch(piece))
    ? <mark key={`${piece}-${index}`}>{piece}</mark>
    : piece);
}

function SearchOverlay({ indexData, onClose, onOpen }) {
  const [query, setQuery] = useState("");
  const [category, setCategory] = useState("all");
  const [type, setType] = useState("all");
  const [tag, setTag] = useState("all");
  const [modified, setModified] = useState("all");
  const [sort, setSort] = useState("relevance");
  const [includeArchive, setIncludeArchive] = useState(false);
  const [includeLogs, setIncludeLogs] = useState(false);
  const [selected, setSelected] = useState(0);
  const [results, setResults] = useState([]);
  const [searchState, setSearchState] = useState({ phase: "loading", error: null, total: 0 });
  const inputRef = useRef(null);
  const resultRefs = useRef([]);

  useEffect(() => {
    let active = true;
    const timer = setTimeout(() => {
      setSearchState((state) => ({ ...state, phase: "loading", error: null }));
      void knowledgeApi.search({ query, category, type, tag, modified, sort, includeArchive, includeLogs, limit: 120 })
        .then((response) => {
          if (!active) return;
          setResults(response.hits);
          setSearchState({ phase: "ready", error: null, total: response.total });
        })
        .catch((error) => {
          if (!active) return;
          setResults([]);
          setSearchState({ phase: "error", error: error instanceof Error ? error.message : String(error), total: 0 });
        });
    }, 120);
    return () => {
      active = false;
      clearTimeout(timer);
    };
  }, [category, includeArchive, includeLogs, modified, query, sort, tag, type]);

  useEffect(() => {
    inputRef.current?.focus();
  }, []);

  useEffect(() => {
    setSelected(0);
  }, [query, category, type, tag, modified, sort, includeArchive, includeLogs]);

  useEffect(() => {
    resultRefs.current[selected]?.scrollIntoView({ block: "nearest" });
  }, [selected]);

  useEffect(() => {
    const onKeyDown = (event) => {
      if (event.key === "Escape") {
        event.preventDefault();
        onClose();
      } else if (event.key === "ArrowDown" && results.length > 0) {
        event.preventDefault();
        setSelected((index) => Math.min(results.length - 1, index + 1));
      } else if (event.key === "ArrowUp" && results.length > 0) {
        event.preventDefault();
        setSelected((index) => Math.max(0, index - 1));
      } else if (event.key === "Enter" && results[selected]) {
        event.preventDefault();
        onOpen(results[selected].document, query.trim());
      }
    };
    globalThis.document.addEventListener("keydown", onKeyDown);
    return () => globalThis.document.removeEventListener("keydown", onKeyDown);
  }, [onClose, onOpen, query, results, selected]);

  return (
    <div className="search-overlay" role="presentation" onMouseDown={onClose}>
      <section className="search-command" role="dialog" aria-modal="true" aria-label="全库档案检索" onMouseDown={(event) => event.stopPropagation()}>
        <header className="search-command-head">
          <MagnifyingGlass size={22} weight="bold" />
          <input ref={inputRef} value={query} onChange={(event) => setQuery(event.target.value)} placeholder="搜索标题、正文、标签、路径或内链文字…" />
          <kbd>⌘ K</kbd><button type="button" onClick={onClose} aria-label="关闭搜索"><X size={18} weight="bold" /></button>
        </header>
        <div className="search-filters">
          <select value={category} onChange={(event) => setCategory(event.target.value)} aria-label="分类筛选">
            <option value="all">全部分类</option>
            {[...indexData.categories, { id: "system", label: "系统" }, { id: "archive", label: "归档" }, { id: "logs", label: "日志" }].map((item) => <option value={item.id} key={item.id}>{item.label}</option>)}
          </select>
          <select value={type} onChange={(event) => setType(event.target.value)} aria-label="内容类型筛选">
            <option value="all">全部类型</option>
            {indexData.typeOptions.map((item) => <option value={item} key={item}>{TYPE_LABELS[item] ?? item}</option>)}
          </select>
          <select value={tag} onChange={(event) => setTag(event.target.value)} aria-label="标签筛选">
            <option value="all">全部标签</option>
            {indexData.tagOptions.slice(0, 48).map((item) => <option value={item.name} key={item.name}>#{item.name} · {item.count}</option>)}
          </select>
          <select value={modified} onChange={(event) => setModified(event.target.value)} aria-label="修改时间筛选">
            <option value="all">全部时间</option><option value="7d">最近 7 天</option><option value="30d">最近 30 天</option><option value="365d">最近一年</option>
          </select>
          <div className="search-sort" role="group" aria-label="搜索排序">
            <button type="button" data-active={sort === "relevance" || undefined} onClick={() => setSort("relevance")}>相关度</button>
            <button type="button" data-active={sort === "recent" || undefined} onClick={() => setSort("recent")}>最近修改</button>
          </div>
          <label><input type="checkbox" checked={includeArchive} onChange={(event) => setIncludeArchive(event.target.checked)} />90-Archive</label>
          <label><input type="checkbox" checked={includeLogs} onChange={(event) => setIncludeLogs(event.target.checked)} />99-Logs</label>
        </div>
        <div className="search-result-meta">
          <span>{query ? `“${query}”` : "最近更新"}</span><strong>{searchState.phase === "loading" ? "正在检索…" : `${searchState.total} 个结果`}</strong><em>↑↓ 选择 · Enter 打开 · Esc 关闭</em>
        </div>
        <div className="search-results" role="listbox" aria-label="搜索结果">
          {results.map((result, index) => (
            <button
              type="button"
              role="option"
              aria-selected={selected === index}
              className="search-result"
              data-active={selected === index || undefined}
              key={result.document.stableId}
              ref={(element) => { resultRefs.current[index] = element; }}
              onMouseEnter={() => setSelected(index)}
              onClick={() => onOpen(result.document, query.trim())}
            >
              <span className="search-result-type">{TYPE_LABELS[result.document.type] ?? result.document.type}</span>
              <span className="search-result-main">
                <strong><SearchHighlightedText text={result.document.title} query={query} /></strong>
                <p><SearchHighlightedText text={result.snippet} query={query} /></p>
                <small>{result.document.categoryLabel} · {result.document.sourcePath}</small>
              </span>
              <span className="search-result-side">
                {(result.document.archiveMarked || result.document.logMarked) && <em>{result.document.archiveMarked ? "ARCHIVE" : "LOG"}</em>}
                <strong>{new Date(result.document.updatedAt).toLocaleDateString("zh-CN", { month: "2-digit", day: "2-digit" })}</strong>
                <small>{result.field === "recent" ? "最近修改" : `${result.field.toLocaleUpperCase()} 命中`}</small>
              </span>
            </button>
          ))}
          {searchState.phase === "loading" && results.length === 0 && (
            <div className="search-empty-state"><span className="index-loader" /><strong>正在读取本地全文索引</strong><p>检索不会重新扫描知识库，也不会上传正文。</p></div>
          )}
          {searchState.phase === "error" && (
            <div className="search-empty-state error"><X size={30} weight="bold" /><strong>档案检索失败</strong><p>{searchState.error}</p></div>
          )}
          {searchState.phase === "ready" && results.length === 0 && (
            <div className="search-empty-state">
              <MagnifyingGlass size={30} weight="duotone" /><strong>没有找到匹配档案</strong>
              <p>可以减少关键词、清除筛选，或开启 90-Archive / 99-Logs。</p>
            </div>
          )}
        </div>
        <footer className="search-command-foot">
          <span><ShieldCheck size={14} weight="fill" />全文只在本机索引，不上传知识库正文</span>
          <small>{indexData.databasePath ?? indexData.indexPath}</small>
        </footer>
      </section>
    </div>
  );
}

function KnowledgeSetupPanel({ setup, onReady, onSkip, context = "knowledge" }) {
  const desktop = Boolean(globalThis.window.jimu);
  const [folderName, setFolderName] = useState("JiMu-Knowledge");
  const [busy, setBusy] = useState("");
  const [error, setError] = useState("");
  const phase = setup?.phase ?? "unconfigured";
  const unavailable = phase === "missing" || phase === "incompatible" || phase === "error";

  async function createStarter() {
    if (!desktop || busy) return;
    setBusy("create");
    setError("");
    try {
      const result = await knowledgeApi.createStarter({ folderName });
      if (!result.canceled) await onReady();
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : String(caught));
    } finally {
      setBusy("");
    }
  }

  async function chooseRoot() {
    if (!desktop || busy) return;
    setBusy("choose");
    setError("");
    try {
      const result = await globalThis.window.jimu.knowledge.chooseRoot();
      if (!result.canceled && result.accepted !== false) await onReady();
      else if (result.accepted === false) setError(result.setup?.error ?? "所选目录不是兼容的 JiMu 知识库。");
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : String(caught));
    } finally {
      setBusy("");
    }
  }

  function openRepository() {
    if (globalThis.window.jimu) void globalThis.window.jimu.shell.openExternal(JIMU_KNOWLEDGE_REPOSITORY_URL);
    else globalThis.open(JIMU_KNOWLEDGE_REPOSITORY_URL, "_blank", "noopener,noreferrer");
  }

  return (
    <main className="knowledge-setup-state" data-context={context}>
      <span className="section-kicker">LOCAL KNOWLEDGE / SETUP</span>
      <h2>{context === "factory" ? "先连接一个知识库，再使用自媒体工厂" : "建立你的空白知识库"}</h2>
      <p>JiMu 不会扫描用户主目录，也不会加载演示内容。你可以创建空白 Schema 1 知识库，或选择现有 Markdown 目录。</p>
      {phase === "initializing" && <div className="knowledge-setup-notice"><span className="index-loader" /><strong>正在验证并建立本地索引…</strong></div>}
      {unavailable && (
        <div className="knowledge-setup-notice error">
          <X size={18} weight="bold" />
          <span><strong>当前知识库不可用</strong><small>{setup?.error ?? "请重新选择兼容目录。"}</small></span>
        </div>
      )}
      {setup?.root && <code className="knowledge-setup-root">{setup.root}</code>}
      <label className="knowledge-starter-name">
        <span>新目录名称</span>
        <input value={folderName} onChange={(event) => setFolderName(event.target.value)} disabled={!desktop || Boolean(busy)} aria-label="空白知识库目录名称" />
      </label>
      <div className="knowledge-setup-actions">
        <button className="primary-action" type="button" onClick={() => { void createStarter(); }} disabled={!desktop || !folderName.trim() || Boolean(busy) || !setup?.template?.bundled}>
          <Plus size={16} weight="bold" />{busy === "create" ? "正在创建…" : "创建空白知识库"}
        </button>
        <button className="secondary-action" type="button" onClick={() => { void chooseRoot(); }} disabled={!desktop || Boolean(busy)}>
          <FolderOpen size={16} weight="duotone" />{busy === "choose" ? "正在验证…" : "选择已有知识库"}
        </button>
        <button className="secondary-action" type="button" onClick={openRepository}><ArrowUpRight size={16} weight="bold" />打开 JiMu-Knowledge 仓库</button>
        <button className="text-action" type="button" onClick={onSkip}>暂时跳过</button>
      </div>
      {!desktop && <small className="knowledge-setup-footnote">浏览器预览未连接本地数据源，只展示空态；创建和选择目录仅在 JiMu 桌面版可用。</small>}
      {desktop && !setup?.template?.bundled && <small className="knowledge-setup-footnote">当前构建未包含空白模板；仍可选择已有知识库或打开公开仓库。</small>}
      {error && <p className="settings-error-banner">{error}</p>}
    </main>
  );
}

function KnowledgeScreen({ indexState, section, setSection, openRequest, onGoAgent, onSearch, onReload, modules }) {
  const [category, setCategory] = useState("all");
  const [sort, setSort] = useState("number");
  const [history, setHistory] = useState([null]);
  const [historyIndex, setHistoryIndex] = useState(0);
  const [readerError, setReaderError] = useState(null);
  const [accountId, setAccountId] = useState(null);
  const [projectId, setProjectId] = useState(null);
  const categories = useMemo(
    () => CATEGORIES.filter((item) => item.id !== "benchmarks" || modules.benchmarks),
    [modules.benchmarks],
  );
  const indexData = indexState.data;
  const documentById = useMemo(
    () => new Map((indexData?.documents ?? []).map((document) => [document.stableId, document])),
    [indexData],
  );
  const currentEntry = history[historyIndex];
  const currentDocument = currentEntry === null ? null : documentById.get(currentEntry.id);
  const currentAccount = accountId === null ? null : documentById.get(accountId);
  const currentProject = projectId === null ? null : documentById.get(projectId);

  useEffect(() => {
    if (!modules.benchmarks && category === "benchmarks") setCategory("all");
  }, [category, modules.benchmarks]);

  const navigate = useCallback((target, searchQuery = "", anchor = "") => {
    const entry = target === null ? null : { id: target, searchQuery, anchor };
    const nextHistory = history.slice(0, historyIndex + 1);
    nextHistory.push(entry);
    setHistory(nextHistory);
    setHistoryIndex(nextHistory.length - 1);
    setReaderError(target !== null && !documentById.has(target) ? "文件已失效或索引正在刷新，请返回档案后重试。" : null);
  }, [documentById, history, historyIndex]);

  function changeSection(nextSection) {
    setHistory([null]);
    setHistoryIndex(0);
    setReaderError(null);
    setAccountId(null);
    setProjectId(null);
    setSection(nextSection);
  }

  useEffect(() => {
    if (!openRequest || !indexData) return;
    setSection("archive");
    navigate(openRequest.id, openRequest.query);
  }, [openRequest]);

  function handleOverviewTarget(target) {
    if (target.mode === "agent") {
      onGoAgent();
      return;
    }
    if (target.mode === "graph") {
      changeSection("graph");
      return;
    }
    setCategory(target.category ?? "all");
    changeSection("archive");
  }

  return (
    <section className="knowledge-module">
      <KnowledgeSectionNav section={section} setSection={changeSection} onSearch={onSearch} />
      <div className="knowledge-module-body">
        {indexState.phase === "setup" && (
          <KnowledgeSetupPanel setup={indexState.setup} onReady={onReload} onSkip={onGoAgent} />
        )}
        {indexState.phase === "loading" && (
          <main className="knowledge-index-state"><span className="index-loader" /><h2>正在建立本地知识索引</h2><p>首次启动只扫描一次 Markdown；后续搜索直接读取索引。</p></main>
        )}
        {indexState.phase === "error" && (
          <main className="knowledge-index-state error"><X size={34} weight="bold" /><h2>知识索引不可用</h2><p>{indexState.error}</p><small>请确认知识库目录存在，并从 JiMu macOS 桌面环境重新加载。</small></main>
        )}
        {indexState.phase === "ready" && indexData && readerError && (
          <main className="knowledge-index-state error"><FileText size={34} weight="duotone" /><h2>无法打开文档</h2><p>{readerError}</p><button type="button" onClick={() => navigate(null)}>返回档案</button></main>
        )}
        {indexState.phase === "ready" && indexData && !readerError && currentDocument && (
          <Reader
            document={currentDocument}
            documentById={documentById}
            searchQuery={currentEntry?.searchQuery}
            initialAnchor={currentEntry?.anchor}
            onOpen={(id, query, anchor) => navigate(id, query, anchor)}
            onClose={() => navigate(null)}
            canBack={historyIndex > 0}
            canForward={historyIndex < history.length - 1}
            onBack={() => setHistoryIndex((index) => Math.max(0, index - 1))}
            onForward={() => setHistoryIndex((index) => Math.min(history.length - 1, index + 1))}
          />
        )}
        {indexState.phase === "ready" && indexData && !readerError && !currentDocument && currentAccount && (
          <BenchmarkAccountView
            account={currentAccount}
            onBack={() => setAccountId(null)}
            onOpenDocument={(id) => navigate(id)}
          />
        )}
        {indexState.phase === "ready" && indexData && !readerError && !currentDocument && !currentAccount && currentProject && (
          <ProjectDirectoryView
            project={currentProject}
            onBack={() => setProjectId(null)}
            onOpenDocument={(id) => navigate(id)}
          />
        )}
        {indexState.phase === "ready" && indexData && !readerError && !currentDocument && !currentAccount && !currentProject && section === "overview" && (
          <KnowledgeOverview indexData={indexData} onNavigate={handleOverviewTarget} modules={modules} />
        )}
        {indexState.phase === "ready" && indexData && !readerError && !currentDocument && !currentAccount && !currentProject && section === "archive" && (
          <KnowledgeHome indexData={indexData} category={category} setCategory={setCategory} sort={sort} setSort={setSort} onOpen={(id) => navigate(id)} onOpenAccount={(id) => setAccountId(id)} onOpenProject={(id) => setProjectId(id)} categories={categories} />
        )}
        {indexState.phase === "ready" && indexData && !readerError && !currentDocument && !currentAccount && !currentProject && section === "graph" && <KnowledgeGraph onOpen={(id) => navigate(id)} categories={categories} modules={modules} />}
      </div>
    </section>
  );
}

function ImportProjectModal({ open, path, setPath, onClose, onImport }) {
  if (!open) return null;
  const recent = [];
  return (
    <div className="prototype-modal-backdrop" role="presentation" onMouseDown={onClose}>
      <section
        className="prototype-modal"
        role="dialog"
        aria-modal="true"
        aria-labelledby="import-project-title"
        onMouseDown={(event) => event.stopPropagation()}
      >
        <div className="prototype-modal-head">
          <div>
            <span className="section-kicker">WORKSPACE / ADD</span>
            <h2 id="import-project-title">导入项目</h2>
          </div>
          <button type="button" onClick={onClose} aria-label="关闭"><X size={17} weight="bold" /></button>
        </div>
        <p>桌面版会打开 macOS 原生目录选择器。浏览器预览不会读取本机目录。</p>
        <label className="path-field">
          <span>项目目录</span>
          <div><FolderOpen size={17} /><input value={path} onChange={(event) => setPath(event.target.value)} /></div>
        </label>
        <div className="recent-projects">
          <span>最近目录</span>
          {recent.map((item) => (
            <button type="button" key={item} data-active={item === path || undefined} onClick={() => setPath(item)}>
              <Folder size={16} weight="duotone" />{item}
            </button>
          ))}
        </div>
        <div className="prototype-modal-actions">
          <button type="button" className="secondary-action" onClick={onClose}>取消</button>
          <button type="button" className="primary-action" disabled={!path.trim()} onClick={onImport}>
            <FolderPlus size={16} weight="bold" />导入项目
          </button>
        </div>
      </section>
    </div>
  );
}

function RenameModal({ target, value, setValue, onClose, onSave }) {
  if (!target) return null;
  return (
    <div className="prototype-modal-backdrop" role="presentation" onMouseDown={onClose}>
      <section
        className="prototype-modal rename-modal"
        role="dialog"
        aria-modal="true"
        aria-labelledby="rename-title"
        onMouseDown={(event) => event.stopPropagation()}
      >
        <div className="prototype-modal-head">
          <div>
            <span className="section-kicker">HARNESS / RENAME</span>
            <h2 id="rename-title">重命名{target.type === "project" ? "项目" : "会话"}</h2>
          </div>
          <button type="button" onClick={onClose} aria-label="关闭"><X size={17} weight="bold" /></button>
        </div>
        <p>只修改 Harness 中的显示名称，不移动项目目录，也不改动知识库文件。</p>
        <label className="path-field">
          <span>显示名称</span>
          <div><PencilSimple size={17} /><input autoFocus value={value} onChange={(event) => setValue(event.target.value)} onKeyDown={(event) => {
            if (event.key === "Enter") { event.preventDefault(); void onSave(); }
          }} /></div>
        </label>
        <div className="prototype-modal-actions">
          <button type="button" className="secondary-action" onClick={onClose}>取消</button>
          <button type="button" className="primary-action" disabled={!value.trim()} onClick={() => { void onSave(); }}>
            <Check size={16} weight="bold" />保存名称
          </button>
        </div>
      </section>
    </div>
  );
}

function formatSessionTime(timestamp) {
  const delta = Date.now() - timestamp;
  if (delta < 60_000) return "刚刚";
  if (delta < 3_600_000) return `${Math.floor(delta / 60_000)} 分钟前`;
  if (delta < 86_400_000) return `${Math.floor(delta / 3_600_000)} 小时前`;
  return new Date(timestamp).toLocaleDateString("zh-CN", { month: "2-digit", day: "2-digit" });
}

const PIPELINE_STATE_LABELS = {
  running: "执行中",
  complete: "已完成",
  error: "失败",
  stopped: "已停止",
  warning: "重试中",
};

function extLabel(name) {
  const dot = name.lastIndexOf(".");
  return dot > 0 ? name.slice(dot + 1).toUpperCase() : "FILE";
}

function fileDate(mtimeMs) {
  const date = new Date(mtimeMs);
  return `${String(date.getMonth() + 1).padStart(2, "0")}.${String(date.getDate()).padStart(2, "0")}`;
}

function buildFileCandidates(files, query, dir) {
  const plain = files.filter((file) => !file.directory);
  const dirs = files.filter((file) => file.directory);
  const normalized = query.trim().toLocaleLowerCase("zh-CN");
  if (normalized) {
    const terms = normalized.split(/\s+/).filter(Boolean);
    const scored = [];
    for (const file of plain) {
      const name = file.name.toLocaleLowerCase("zh-CN");
      const rel = file.relativePath.toLocaleLowerCase("zh-CN");
      let score = 0;
      if (name.startsWith(normalized)) score = 100;
      else if (name.includes(normalized)) score = 80;
      else if (rel.includes(normalized)) score = 60;
      else if (terms.every((term) => name.includes(term) || rel.includes(term))) score = 40;
      if (score > 0) scored.push({ kind: "file", name: file.name, meta: `${extLabel(file.name)} · ${file.relativePath}`, date: fileDate(file.mtimeMs), ref: `@${file.relativePath}`, relativePath: file.relativePath, score });
    }
    for (const directory of dirs) {
      const name = directory.name.toLocaleLowerCase("zh-CN");
      const rel = directory.relativePath.toLocaleLowerCase("zh-CN");
      let score = 0;
      if (name.startsWith(normalized)) score = 90;
      else if (name.includes(normalized)) score = 70;
      else if (rel.includes(normalized)) score = 50;
      else if (terms.every((term) => name.includes(term) || rel.includes(term))) score = 35;
      if (score > 0) scored.push({ kind: "directory", name: directory.name, meta: `目录 · ${directory.relativePath}`, date: "", ref: null, relativePath: directory.relativePath, score });
    }
    return scored.sort((a, b) => b.score - a.score || b.date.localeCompare(a.date)).slice(0, 30);
  }
  if (dir) {
    // Full subtree of the opened directory: every level of subdirectories
    // and files participates, indented by depth for readability.
    const prefix = `${dir}/`;
    const depthOf = (relativePath) => relativePath.slice(prefix.length).split("/").length - 1;
    const subtree = [
      ...dirs
        .filter((d) => d.relativePath.startsWith(prefix))
        .map((d) => ({ kind: "directory", name: d.name, meta: `目录 · ${d.relativePath}`, date: "", ref: null, relativePath: d.relativePath, depth: depthOf(d.relativePath) })),
      ...plain
        .filter((f) => f.relativePath.startsWith(prefix))
        .map((f) => ({ kind: "file", name: f.name, meta: `${extLabel(f.name)} · ${f.relativePath}`, date: fileDate(f.mtimeMs), ref: `@${f.relativePath}`, relativePath: f.relativePath, depth: depthOf(f.relativePath) })),
    ];
    return subtree.sort((a, b) => {
      if (a.kind !== b.kind) return a.kind === "directory" ? -1 : 1;
      return b.date.localeCompare(a.date);
    }).slice(0, 60);
  }
  const topDirs = dirs
    .filter((d) => !d.relativePath.includes("/"))
    .sort((a, b) => a.name.localeCompare(b.name, "zh-CN", { numeric: true }))
    .slice(0, 12)
    .map((d) => ({ kind: "directory", name: d.name, meta: "目录", date: "", ref: null, relativePath: d.relativePath, depth: 0 }));
  // Recent files come from the whole tree, any nesting level included.
  const recent = plain.slice(0, 30).map((f) => ({
    kind: "file",
    name: f.name,
    meta: `${extLabel(f.name)} · ${f.relativePath}`,
    date: fileDate(f.mtimeMs),
    ref: `@${f.relativePath}`,
    relativePath: f.relativePath,
    depth: f.relativePath.split("/").length - 1,
  }));
  return [...topDirs, ...recent];
}

function buildSkillCandidates(skills, query) {
  const groups = groupSkillCatalog(skills);
  const rows = groups.flatMap((group) => group.skills.map((skill) => ({
    kind: "skill",
    name: skill.name,
    meta: skill.description || "可调用 Skill",
    date: "",
    ref: `$${skill.name}`,
    group: group.label,
    score: 60,
  })));
  const normalized = query.trim().toLocaleLowerCase("zh-CN");
  if (!normalized) return rows.slice(0, 30);
  const terms = normalized.split(/\s+/).filter(Boolean);
  return rows
    .filter((row) => terms.every((term) => row.name.toLocaleLowerCase("zh-CN").includes(term) || row.meta.toLocaleLowerCase("zh-CN").includes(term) || row.group.toLocaleLowerCase("zh-CN").includes(term)))
    .slice(0, 30);
}

function MentionPanel({ kind, query, setQuery, candidates, dir, selectedIndex, onNavigateDir, onKeyDown, onClose, onPick }) {
  const listRef = useRef(null);
  useEffect(() => {
    listRef.current?.querySelector("[data-selected]")?.scrollIntoView({ block: "nearest" });
  }, [selectedIndex, candidates]);
  const crumbs = dir ? dir.split("/") : [];
  return (
    <div className="composer-mention-panel" role="dialog" aria-label={kind === "file" ? "@ 引用文件" : "$ 调用 Skill"}>
      <div className="mention-panel-head">
        <span className="section-kicker">{kind === "file" ? "REFERENCE FILE / @ 引用文件" : "INVOKE SKILL / $ 调用 Skill"}</span>
        <button type="button" onClick={onClose} aria-label="关闭"><X size={14} weight="bold" /></button>
      </div>
      <input
        className="mention-search"
        autoFocus
        value={query}
        onChange={(event) => setQuery(event.target.value)}
        onKeyDown={onKeyDown}
        placeholder={kind === "file" ? "输入文件名称，实时模糊匹配…" : "输入 Skill 名称，实时模糊匹配…"}
      />
      {kind === "file" && (
        <div className="mention-breadcrumb">
          <button type="button" data-active={!dir || undefined} onClick={() => onNavigateDir("")}>全部文件</button>
          {crumbs.map((part, index) => (
            <span key={`${part}-${index}`}>
              <i>/</i>
              <button type="button" data-active={index === crumbs.length - 1 || undefined} onClick={() => onNavigateDir(crumbs.slice(0, index + 1).join("/"))}>{part}</button>
            </span>
          ))}
        </div>
      )}
      <div className="mention-list" ref={listRef} key={kind === "file" ? `file:${dir}:${query}` : `skill:${query}`}>
        {candidates.length > 0 ? candidates.map((item, index) => (
          <button
            type="button"
            className={`mention-row ${item.kind === "directory" ? "directory" : ""}`}
            data-selected={index === selectedIndex || undefined}
            style={typeof item.depth === "number" && item.depth > 0 ? { paddingLeft: `${10 + Math.min(item.depth, 5) * 14}px` } : undefined}
            key={item.kind === "file" || item.kind === "directory" ? item.relativePath : item.name}
            onMouseEnter={() => setSelectedIndex?.(index)}
            onClick={() => onPick(item)}
          >
            {item.kind === "directory" ? <FolderOpen size={15} weight="duotone" /> : item.kind === "skill" ? <PuzzlePiece size={15} weight="duotone" /> : <FileText size={15} weight="duotone" />}
            <span className="mention-row-copy">
              <strong>{item.name}</strong>
              <small>{item.meta}</small>
            </span>
            {item.kind === "file" && <em>{item.date}</em>}
            {item.kind === "directory" && <em>进入</em>}
          </button>
        )) : (
          <p className="mention-empty">没有匹配的候选项；继续输入或按 Esc 关闭。</p>
        )}
      </div>
    </div>
  );
}

function AgentPipelineRow({ message, sessionId, index }) {
  const key = `${sessionId}-${message.role}-${message.seq ?? message.callId ?? index}`;
  if (message.role === "reasoning") {
    return (
      <details className="pipeline-row reasoning-row" data-state={message.state ?? "complete"} key={key}>
        <summary>
          <span className="pipeline-node"><Brain size={15} weight="duotone" /></span>
          <span><strong>{message.streaming ? "模型正在分析" : "分析过程"}</strong><small>REASONING · STEP {message.step ?? "—"}</small></span>
          {message.streaming && <span className="pipeline-running-dot" />}
          <CaretRight size={13} weight="bold" />
        </summary>
        <pre>{message.details}</pre>
      </details>
    );
  }
  if (message.role === "tool") {
    const state = message.state ?? "complete";
    return (
      <details className="pipeline-row tool-row" data-state={state} key={key}>
        <summary>
          <span className="pipeline-node"><PlugsConnected size={15} weight="duotone" /></span>
          <span><strong>{message.title ?? message.name}</strong><small>{message.summary || message.name} · STEP {message.step ?? "—"}</small></span>
          <em>{PIPELINE_STATE_LABELS[state] ?? state}</em>
          <CaretRight size={13} weight="bold" />
        </summary>
        <div className="tool-row-details">
          {message.input && <section><span>INPUT</span><pre>{message.input}</pre></section>}
          {message.output && <section><span>OUTPUT{Number.isInteger(message.exitCode) ? ` · EXIT ${message.exitCode}` : ""}</span><pre>{message.output}</pre></section>}
        </div>
      </details>
    );
  }
  if (message.role === "plan") {
    return (
      <details className="pipeline-row plan-row" data-state={message.state ?? "complete"} open key={key}>
        <summary>
          <span className="pipeline-node"><SquaresFour size={15} weight="duotone" /></span>
          <span><strong>{message.title ?? "执行计划"}</strong><small>HARNESS PLAN · 持续更新</small></span>
          <em>{PIPELINE_STATE_LABELS[message.state] ?? "已更新"}</em>
          <CaretRight size={13} weight="bold" />
        </summary>
        <pre>{message.text}</pre>
      </details>
    );
  }
  if (message.role === "status" || message.role === "turn") {
    return (
      <div className={`pipeline-status ${message.role}`} data-state={message.state ?? "complete"} key={key}>
        <span className="pipeline-node">{message.state === "complete" ? <Check size={13} weight="bold" /> : <ClockCounterClockwise size={13} weight="bold" />}</span>
        <span><strong>{message.title}</strong><small>{message.text}{message.turn ? ` · TURN ${String(message.turn).padStart(2, "0")}` : ""}</small></span>
      </div>
    );
  }
  return (
    <div className={`message ${message.role}${message.streaming ? " pending" : ""}`} data-streaming={message.streaming || undefined} key={key}>
      <span>{message.role === "assistant" ? "JiMu" : message.role === "error" ? "ERROR" : "YOU"}</span>
      {message.role === "assistant" ? (
        <div className="agent-response-markdown">
          {message.streaming && <span className="stream-caret" />}
          <ReactMarkdown
            remarkPlugins={[remarkGfm]}
            skipHtml
            components={{
              a({ href, children }) {
                return <a href={href} onClick={(event) => {
                  event.preventDefault();
                  if (!/^https?:\/\//i.test(href ?? "")) return;
                  if (globalThis.window.jimu) void globalThis.window.jimu.shell.openExternal(href);
                  else globalThis.open(href, "_blank", "noopener,noreferrer");
                }}>{children}</a>;
              },
            }}
          >{message.text}</ReactMarkdown>
        </div>
      ) : <p>{message.text}</p>}
    </div>
  );
}

function AgentContextSidebar({ project, session, preset, model, messages, onClose }) {
  const latestContexts = new Map();
  for (const message of messages.filter((item) => item.role === "context")) latestContexts.set(message.contextKind ?? message.label, message);
  const catalogContext = latestContexts.get("skills");
  const skills = session?.skills?.length ? session.skills : catalogContext?.entries ?? [];
  const skillGroups = groupSkillCatalog(skills);
  const environmentContexts = [...latestContexts.values()].filter((item) => item.contextKind !== "skills");
  return (
    <aside id="agent-context-pane" className="agent-context-sidebar" aria-label="Agent 执行环境">
      <header>
        <span><small>SESSION ENVIRONMENT</small><strong>执行环境</strong></span>
        <button type="button" onClick={onClose} aria-label="收起执行环境"><X size={14} weight="bold" /></button>
      </header>
      <section className="runtime-summary-card">
        <span><Folder size={16} weight="duotone" /></span>
        <div><small>ACTIVE PROJECT</small><strong>{project?.title ?? "未选择项目"}</strong><code>{project?.path ?? "—"}</code></div>
      </section>
      <dl className="runtime-facts">
        <div><dt>MODEL</dt><dd>{model?.name ?? "—"}</dd></div>
        <div><dt>MODE</dt><dd>{preset?.label ?? "—"}</dd></div>
        <div><dt>SESSION</dt><dd>{session?.title ?? "—"}</dd></div>
      </dl>
      <section className="context-sidebar-section">
        <div className="context-section-title"><PlugsConnected size={15} weight="duotone" /><span><strong>上下文</strong><small>{environmentContexts.length} 项</small></span></div>
        {environmentContexts.length === 0 && <p className="context-empty">当前会话还没有注入工作区上下文。</p>}
        {environmentContexts.map((item, index) => (
          <details className="context-sidebar-item" key={`${item.contextKind}-${item.seq ?? index}`}>
            <summary><span><strong>{item.label}</strong><small>{item.meta}</small></span><CaretRight size={12} weight="bold" /></summary>
            <pre>{item.details}</pre>
          </details>
        ))}
      </section>
      <section className="context-sidebar-section skill-directory-section">
        <div className="context-section-title"><PuzzlePiece size={15} weight="duotone" /><span><strong>Skill 目录</strong><small>{skills.length} 个能力</small></span></div>
        <p className="skill-directory-note">按能力来源组织。路径标为“逻辑目录”时，Harness 只公开目录层级，不暴露本地文件位置。</p>
        <div className="skill-directory-tree">
          {skillGroups.map((group, groupIndex) => (
            <details key={group.id} open={groupIndex === 0}>
              <summary><Folder size={14} weight="fill" /><span><strong>{group.label}</strong><small>{group.logicalPath}</small></span><em>{group.skills.length}</em><CaretRight size={12} weight="bold" /></summary>
              <ul>
                {group.skills.map((skill) => (
                  <li key={skill.name} title={skill.description}>
                    <span className="skill-tree-branch" aria-hidden />
                    <span>
                      <strong>{skill.name}</strong>
                      <code>{skill.path}</code>
                      {skill.description && <p>{skill.description}</p>}
                      <small>{skill.pathKind === "filesystem" ? "本地目录" : "逻辑目录"} · {skill.modelInvocable ? "Agent 可调用" : "仅供查看"}</small>
                    </span>
                  </li>
                ))}
              </ul>
            </details>
          ))}
          {skillGroups.length === 0 && <p className="context-empty">该会话尚未发布可用 Skill。</p>}
        </div>
      </section>
    </aside>
  );
}

function AgentScreen({ onOpenSettings, openSessionRequest, defaultProjectPath }) {
  const desktop = harnessApi.available();
  const [projects, setProjects] = useState([]);
  const projectsRef = useRef(projects);
  const [activeProjectId, setActiveProjectId] = useState("");
  const [activeSessionId, setActiveSessionId] = useState("");
  const [draft, setDraft] = useState("");
  const [query, setQuery] = useState("");
  const [sessionMatches, setSessionMatches] = useState(null);
  const [modelOpen, setModelOpen] = useState(false);
  const [composerModelOpen, setComposerModelOpen] = useState(false);
  const [composerPresetOpen, setComposerPresetOpen] = useState(false);
  const [importOpen, setImportOpen] = useState(false);
  const [importPath, setImportPath] = useState("");
  const [harnessPhase, setHarnessPhase] = useState(desktop ? "booting" : "preview");
  const [harnessError, setHarnessError] = useState(null);
  const [sending, setSending] = useState(false);
  const [projectMenuId, setProjectMenuId] = useState("");
  const [sessionMenuId, setSessionMenuId] = useState("");
  const [renameTarget, setRenameTarget] = useState(null);
  const [renameValue, setRenameValue] = useState("");
  const [pendingInteractions, setPendingInteractions] = useState([]);
  const [questionDrafts, setQuestionDrafts] = useState({});
  const [contextOpen, setContextOpen] = useState(true);
  const [projectBrowserPreference, setProjectBrowserPreference] = useStoredPanelSize(PANEL_LAYOUT.projectBrowser);
  const [contextSidebarPreference, setContextSidebarPreference] = useStoredPanelSize(PANEL_LAYOUT.contextSidebar);
  const workspaceRef = useRef(null);
  const workspaceWidth = useElementWidth(workspaceRef, 1170);
  const [permissionPreset, setPermissionPreset] = useState("workspace-write");
  const permissionInitRef = useRef(null);
  const [compactionState, setCompactionState] = useState({ phase: "idle", count: null });
  const handledOpenRequestRef = useRef(null);
  const [cacheStats, setCacheStats] = useState({ requests: 0, inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, reasoningTokens: 0, cacheRate: null, lastCacheRate: null });
  const [mentionOpen, setMentionOpen] = useState(null);
  const [mentionQuery, setMentionQuery] = useState("");
  const [mentionIndex, setMentionIndex] = useState(0);
  const [mentionDir, setMentionDir] = useState("");
  const [projectFiles, setProjectFiles] = useState([]);
  const [dirFiles, setDirFiles] = useState([]);
  const activeSessionRef = useRef(activeSessionId);
  const messageStreamRef = useRef(null);
  const stickToBottomRef = useRef(true);

  useEffect(() => { projectsRef.current = projects; }, [projects]);
  useEffect(() => { activeSessionRef.current = activeSessionId; }, [activeSessionId]);

  const activeProject = projects.find((project) => project.id === activeProjectId) ?? projects[0];
  const activeSession = activeProject?.sessions.find((session) => session.id === activeSessionId)
    ?? activeProject?.sessions[0];
  const activePreset = AGENT_PRESETS.find((preset) => preset.id === activeSession?.preset) ?? AGENT_PRESETS[0];
  const ActivePresetIcon = activePreset.icon;
  const activeModel = MODEL_OPTIONS.find((model) => model.id === activeSession?.model) ?? MODEL_OPTIONS[0];

  // Stick to the newest message while streaming: auto-scroll only when the
  // user is already near the bottom; scrolling up pauses the follow.
  useEffect(() => {
    const el = messageStreamRef.current;
    if (el && stickToBottomRef.current) el.scrollTop = el.scrollHeight;
  }, [activeSession?.messages, sending]);

  const fileRefs = useMemo(
    () => [...draft.matchAll(/@([^\s@$]+)/g)].map((match) => ({ raw: match[0], text: match[1] })),
    [draft],
  );
  const skillRefs = useMemo(
    () => [...draft.matchAll(/\$([a-zA-Z0-9][a-zA-Z0-9-_:.]*)/g)].map((match) => ({ raw: match[0], text: match[1] })),
    [draft],
  );
  const harnessErrorDisplay = describeHarnessError(harnessError);
  const managedProjectIds = projects.filter((project) => !project.id.startsWith("ungrouped:")).map((project) => project.id);

  const visibleProjects = useMemo(() => {
    const normalized = query.trim().toLocaleLowerCase("zh-CN");
    if (!normalized) return projects;
    return projects
      .map((project) => {
        const projectMatches = `${project.title} ${project.path}`.toLocaleLowerCase("zh-CN").includes(normalized);
        const sessions = projectMatches
          ? project.sessions
          : project.sessions.filter((session) => session.title.toLocaleLowerCase("zh-CN").includes(normalized) || sessionMatches?.has(session.id));
        return { ...project, sessions };
      })
      .filter((project) => project.sessions.length > 0);
  }, [projects, query, sessionMatches]);

  const patchSession = useCallback((projectId, sessionId, patch) => {
    setProjects((items) => items.map((project) => project.id !== projectId
      ? project
      : { ...project, sessions: project.sessions.map((session) => session.id === sessionId ? { ...session, ...patch } : session) }));
  }, []);

  const refreshHarness = useCallback(async (preferredSessionId) => {
    const [workspaceState, sessionState] = await Promise.all([
      harnessApi.call("workspace.list", {}),
      harnessApi.call("session.list", {}),
    ]);
    const oldSessions = new Map(projectsRef.current.flatMap((project) => project.sessions.map((session) => [session.id, session])));
    const summaries = new Map(sessionState.items.filter((summary) => summary.origin !== "subagent").map((summary) => [summary.sessionId, summary]));
    const archived = new Set(workspaceState.archivedSessionIds);
    const accounted = new Set(workspaceState.items.flatMap((workspace) => workspace.sessionIds));
    const toSession = (summary) => {
      const previous = oldSessions.get(summary.sessionId);
      const title = summary.blank ? "新会话" : summary.projections?.values?.title || previous?.title || summary.sessionId.slice(0, 8);
      const wirePreset = summary.agentPreset ?? "standard";
      return {
        id: summary.sessionId,
        title,
        time: formatSessionTime(summary.updatedAt),
        preset: wirePreset === "cordis" ? "creator" : wirePreset,
        model: previous?.model ?? "deepseek-v4-flash",
        messages: previous?.messages ?? [],
        skills: previous?.skills ?? [],
        blank: summary.blank,
        running: summary.running,
      };
    };
    const nextProjects = workspaceState.items.map((workspace) => ({
      id: workspace.workspaceId,
      title: workspace.title,
      path: workspace.path,
      expanded: projectsRef.current.find((project) => project.id === workspace.workspaceId)?.expanded ?? true,
      sessions: workspace.sessionIds.map((id) => summaries.get(id)).filter(Boolean).filter((summary) => !archived.has(summary.sessionId)).map(toSession),
    }));
    const ungrouped = [...summaries.values()].filter((summary) => !accounted.has(summary.sessionId) && !archived.has(summary.sessionId));
    const byCwd = new Map();
    for (const summary of ungrouped) {
      const cwd = summary.cwd ?? "未归档会话";
      const group = byCwd.get(cwd) ?? [];
      group.push(summary);
      byCwd.set(cwd, group);
    }
    for (const [cwd, summariesForCwd] of byCwd) {
      nextProjects.push({ id: `ungrouped:${cwd}`, title: cwd.split("/").filter(Boolean).at(-1) ?? "未归档", path: cwd, expanded: true, sessions: summariesForCwd.map(toSession) });
    }
    setProjects(nextProjects);
    const selected = nextProjects.flatMap((project) => project.sessions.map((session) => ({ project, session })))
      .find(({ session }) => session.id === (preferredSessionId || activeSessionRef.current));
    if (selected) {
      setActiveProjectId(selected.project.id);
      setActiveSessionId(selected.session.id);
    } else {
      const defaultProject = nextProjects.find((project) => project.path === defaultProjectPath) ?? nextProjects[0];
      if (defaultProject) {
        setActiveProjectId(defaultProject.id);
        setActiveSessionId(defaultProject.sessions[0]?.id ?? "");
      }
    }
    return nextProjects;
  }, [defaultProjectPath]);

  const loadSession = useCallback(async (projectId, sessionId) => {
    if (!desktop || !sessionId) return;
    try {
      const [history, models, catalog] = await Promise.all([
        harnessApi.call("session.history", { sessionId, maxMessages: 300 }),
        harnessApi.call("session.models", { sessionId }),
        harnessApi.call("skill.list", { sessionId }).catch(() => ({ skills: [] })),
      ]);
      patchSession(projectId, sessionId, { messages: historyMessages(history.events), model: models.current.model, skills: catalog.skills ?? [] });
      // Fold durable permission knobs only when this session is first opened;
      // later refreshes must not override a switch the user just made before
      // the queued command's event lands in the log.
      if (permissionInitRef.current !== sessionId) {
        permissionInitRef.current = sessionId;
        let preset = null;
        let policy = null;
        for (const entry of history.events ?? []) {
          const event = entry?.event ?? entry;
          if (event?.type === "permission/preset" && typeof event.data?.preset === "string") preset = event.data.preset;
          if (event?.type === "approval/policy" && typeof event.data?.policy === "string") policy = event.data.policy;
        }
        const presetSet = new Set(["workspace-write", "danger-full-access"]);
        if (preset !== null && presetSet.has(preset)) setPermissionPreset(preset);
        else if (policy === "never") setPermissionPreset("danger-full-access");
        else if (policy === "ask") setPermissionPreset("workspace-write");
      }
      setCacheStats(summarizeUsage(history.events));
    } catch (error) {
      setHarnessError(error instanceof Error ? error.message : String(error));
    }
  }, [desktop, patchSession]);

  useEffect(() => {
    if (!desktop) return undefined;
    let active = true;
    let timer;
    const boot = async () => {
      try {
        const status = await harnessApi.status();
        if (!active) return;
        if (status.phase === "ready") {
          setHarnessPhase("ready");
          setHarnessError(null);
          await refreshHarness();
          return;
        }
        if (status.phase === "error") {
          setHarnessPhase("error");
          setHarnessError(status.error);
          return;
        }
        timer = setTimeout(boot, 350);
      } catch (error) {
        if (active) {
          setHarnessPhase("error");
          setHarnessError(error instanceof Error ? error.message : String(error));
        }
      }
    };
    void boot();
    return () => { active = false; clearTimeout(timer); };
  }, [desktop, refreshHarness]);

  useEffect(() => {
    if (!desktop) return undefined;
    let active = true;
    return harnessApi.subscribeState((status) => {
      if (!active || !status?.phase) return;
      setHarnessPhase(status.phase);
      if (status.phase === "ready") {
        setHarnessError(status.notice ?? null);
        void refreshHarness(activeSessionRef.current);
      } else if (status.phase === "error") {
        setHarnessError(status.error ?? "Harness 启动失败");
      } else if (status.phase === "restarting") {
        setHarnessError(null);
        setSending(false);
      }
    });
  }, [desktop, refreshHarness]);

  useEffect(() => {
    if (desktop && activeProject && activeSessionId) void loadSession(activeProject.id, activeSessionId);
  }, [activeProject?.id, activeSessionId, desktop, loadSession]);

  useEffect(() => {
    if (!desktop || !query.trim()) {
      setSessionMatches(null);
      return undefined;
    }
    let active = true;
    const timer = setTimeout(() => {
      void harnessApi.call("session.search", { query: query.trim() }).then((result) => {
        if (active) setSessionMatches(new Set(result.items.map((item) => item.sessionId)));
      }).catch(() => { if (active) setSessionMatches(new Set()); });
    }, 150);
    return () => { active = false; clearTimeout(timer); };
  }, [desktop, query]);

  useEffect(() => {
    if (!desktop || harnessPhase !== "ready") return undefined;
    let refreshTimer;
    const refreshFromEvent = (sessionId) => {
      clearTimeout(refreshTimer);
      refreshTimer = setTimeout(() => {
        const selectedId = sessionId || activeSessionRef.current;
        void refreshHarness(selectedId).then(() => {
          const project = projectsRef.current.find((item) => item.sessions.some((session) => session.id === selectedId));
          if (project && selectedId) void loadSession(project.id, selectedId);
        });
      }, 120);
    };
    const unsubscribe = harnessApi.subscribeEvents((update) => {
      const envelope = update?.frame;
      const payload = envelope?.payload ?? envelope;
      if (!payload || typeof payload !== "object") return;
      if (payload.type === "stream/error") {
        setHarnessError(payload.error?.message ?? "Harness 事件流中断");
        return;
      }
      if (payload.type === "approval/requested" || payload.type === "question/requested") {
        const key = payload.type === "approval/requested" ? `a:${payload.approvalId}` : `q:${envelope.rpcId}`;
        setPendingInteractions((current) => current.some((item) => item.key === key)
          ? current
          : [...current, { key, rpcId: envelope.rpcId, ...payload }]);
      } else if (payload.type === "approval/resolved") {
        setPendingInteractions((current) => current.filter((item) => item.approvalId !== payload.approvalId));
      } else if (payload.type === "question/resolved") {
        setPendingInteractions((current) => current.filter((item) => item.rpcId !== payload.questionRpcId));
      }
      if (payload.type === "host/agent-error") setHarnessError(payload.message);
      if (payload.type === "host/session-status" && payload.sessionId === activeSessionRef.current && payload.running === false) setSending(false);
      if (payload.type === "session/event" && payload.sessionId === activeSessionRef.current) {
        const event = payload.event;
        const data = event?.data ?? {};
        if (event?.type === "compaction/start") setCompactionState({ phase: "running", count: null });
        else if (event?.type === "compaction/summary") setCompactionState({ phase: "done", count: Array.isArray(data.shadowedSeqs) ? data.shadowedSeqs.length : null });
        else if (event?.type === "compaction/end") setCompactionState((current) => ({ ...current, phase: current.phase === "done" ? "done" : "idle" }));
        else if (event?.type === "assistant/message" && data.usage && typeof data.usage === "object") {
          setCacheStats((current) => {
            const input = typeof data.usage.inputTokens === "number" ? data.usage.inputTokens : 0;
            const cacheRead = typeof data.usage.cacheReadTokens === "number" ? data.usage.cacheReadTokens : 0;
            const next = {
              requests: current.requests + 1,
              inputTokens: current.inputTokens + input,
              outputTokens: current.outputTokens + (typeof data.usage.outputTokens === "number" ? data.usage.outputTokens : 0),
              cacheReadTokens: current.cacheReadTokens + cacheRead,
              cacheWriteTokens: current.cacheWriteTokens + (typeof data.usage.cacheWriteTokens === "number" ? data.usage.cacheWriteTokens : 0),
              reasoningTokens: current.reasoningTokens + (typeof data.usage.reasoningTokens === "number" ? data.usage.reasoningTokens : 0),
              last: data.usage,
            };
            const totalInput = next.inputTokens + next.cacheReadTokens;
            const lastInput = input + cacheRead;
            return {
              ...next,
              cacheRate: totalInput > 0 ? next.cacheReadTokens / totalInput : null,
              lastCacheRate: lastInput > 0 ? cacheRead / lastInput : null,
            };
          });
        } else if (event?.type === "permission/preset" && typeof data.preset === "string" && new Set(["workspace-write", "danger-full-access"]).has(data.preset)) {
          setPermissionPreset(data.preset);
        }
      }
      if (payload.sessionId || payload.type?.startsWith("host/workspace") || payload.type === "host/archived-sessions-changed") {
        refreshFromEvent(payload.sessionId);
      }
    });
    return () => { clearTimeout(refreshTimer); unsubscribe(); };
  }, [desktop, harnessPhase, loadSession, refreshHarness]);

  function updateSession(patch) {
    if (!activeProject || !activeSession) return;
    patchSession(activeProject.id, activeSession.id, patch);
  }

  function selectSession(projectId, sessionId) {
    setActiveProjectId(projectId);
    setActiveSessionId(sessionId);
    setModelOpen(false);
    setComposerModelOpen(false);
    setComposerPresetOpen(false);
    setProjectMenuId("");
    setSessionMenuId("");
  }

  useEffect(() => {
    if (!openSessionRequest?.sessionId || handledOpenRequestRef.current === openSessionRequest.nonce) return;
    const matchedProject = projects.find((project) => project.sessions.some((session) => session.id === openSessionRequest.sessionId));
    if (!matchedProject) return;
    handledOpenRequestRef.current = openSessionRequest.nonce;
    setProjects((items) => items.map((project) => project.id === matchedProject.id ? { ...project, expanded: true } : project));
    selectSession(matchedProject.id, openSessionRequest.sessionId);
  }, [openSessionRequest, projects]);

  function toggleProject(projectId) {
    setProjects((items) => items.map((project) => project.id === projectId
      ? { ...project, expanded: !project.expanded }
      : project));
  }

  async function addSession(projectId = activeProjectId) {
    if (desktop) {
      const project = projects.find((item) => item.id === projectId);
      if (!project || project.id.startsWith("ungrouped:")) return;
      try {
        const created = await harnessApi.call("session.create", { workspaceId: project.id, agentPreset: "standard" });
        await refreshHarness(created.sessionId);
        setActiveProjectId(project.id);
        setActiveSessionId(created.sessionId);
      } catch (error) {
        setHarnessError(error instanceof Error ? error.message : String(error));
      }
      return;
    }
    const sequence = projects.reduce((total, project) => total + project.sessions.length, 0) + 1;
    const sessionId = `preview-session-${sequence}`;
    setProjects((items) => items.map((project) => project.id === projectId
      ? {
          ...project,
          expanded: true,
          sessions: [{
            id: sessionId,
            title: "新会话",
            time: "刚刚",
            preset: "standard",
            model: "deepseek-v4-flash",
            messages: [{ role: "assistant", text: `新会话已归入 ${project.title}。你可以选择模型和 Agent 预设后开始任务。` }],
          }, ...project.sessions],
        }
      : project));
    setActiveProjectId(projectId);
    setActiveSessionId(sessionId);
  }

  async function startImport() {
    if (!desktop) {
      setImportOpen(true);
      return;
    }
    try {
      const selection = await globalThis.window.jimu.harness.chooseProject();
      if (selection.canceled) return;
      const result = await harnessApi.call("workspace.create", { path: selection.path });
      await refreshHarness();
      setActiveProjectId(result.workspace.workspaceId);
      setActiveSessionId(result.workspace.sessionIds[0] ?? "");
    } catch (error) {
      setHarnessError(error instanceof Error ? error.message : String(error));
    }
  }

  function importProject() {
    const normalized = importPath.trim();
    if (!normalized) return;
    const existing = projects.find((project) => project.path === normalized);
    if (existing) {
      setActiveProjectId(existing.id);
      setActiveSessionId(existing.sessions[0]?.id ?? "");
      setProjects((items) => items.map((project) => project.id === existing.id ? { ...project, expanded: true } : project));
      setImportOpen(false);
      return;
    }
    const title = normalized.split("/").filter(Boolean).at(-1) ?? "新项目";
    const id = `project-${projects.length + 1}`;
    const sessionId = `${id}-session-1`;
    setProjects((items) => [...items, {
      id,
      title,
      path: normalized,
      expanded: true,
      sessions: [{
        id: sessionId,
        title: "项目初始会话",
        time: "刚刚",
        preset: "standard",
        model: "deepseek-v4-flash",
        messages: [{ role: "assistant", text: `${title} 已作为独立项目导入。后续会话都会保留在这个项目下面。` }],
      }],
    }]);
    setActiveProjectId(id);
    setActiveSessionId(sessionId);
    setImportOpen(false);
  }

  function beginRename(target) {
    setRenameTarget(target);
    setRenameValue(target.title);
    setProjectMenuId("");
    setSessionMenuId("");
  }

  async function saveRename() {
    const title = renameValue.trim();
    if (!title || !renameTarget) return;
    try {
      if (desktop && renameTarget.type === "project") {
        await harnessApi.call("workspace.rename", { workspaceId: renameTarget.id, title });
        await refreshHarness(activeSessionId);
      } else if (desktop) {
        await harnessApi.call("session.rename", { sessionId: renameTarget.id, title });
        await refreshHarness(renameTarget.id);
      } else if (renameTarget.type === "project") {
        setProjects((items) => items.map((project) => project.id === renameTarget.id ? { ...project, title } : project));
      } else {
        patchSession(renameTarget.projectId, renameTarget.id, { title });
      }
      setRenameTarget(null);
      setRenameValue("");
    } catch (error) {
      setHarnessError(error instanceof Error ? error.message : String(error));
    }
  }

  async function moveProject(projectId, direction) {
    const managed = projects.filter((project) => !project.id.startsWith("ungrouped:"));
    const index = managed.findIndex((project) => project.id === projectId);
    if (index < 0 || (direction === "up" && index === 0) || (direction === "down" && index === managed.length - 1)) return;
    if (desktop) {
      const beforeWorkspaceId = direction === "up" ? managed[index - 1]?.id : managed[index + 2]?.id;
      try {
        await harnessApi.call("workspace.insertBefore", {
          workspaceId: projectId,
          ...(beforeWorkspaceId ? { beforeWorkspaceId } : {}),
        });
        await refreshHarness(activeSessionId);
      } catch (error) {
        setHarnessError(error instanceof Error ? error.message : String(error));
      }
    } else {
      const target = direction === "up" ? index - 1 : index + 1;
      setProjects((items) => {
        const copy = [...items];
        const from = copy.findIndex((project) => project.id === projectId);
        const targetId = managed[target]?.id;
        const to = copy.findIndex((project) => project.id === targetId);
        if (from < 0 || to < 0) return items;
        const [moved] = copy.splice(from, 1);
        copy.splice(to, 0, moved);
        return copy;
      });
    }
    setProjectMenuId("");
  }

  async function choosePreset(presetId) {
    if (!activeSession || !activeProject) return;
    if (desktop && !activeSession.blank) {
      setHarnessError("Agent 模式在首条消息发送后锁定；请新建空白会话后选择另一模式。");
      return;
    }
    const preset = AGENT_PRESETS.find((item) => item.id === presetId) ?? AGENT_PRESETS[0];
    updateSession({ preset: preset.id });
    if (desktop) {
      try {
        await harnessApi.call("agentPreset.select", { sessionId: activeSession.id, agentPreset: preset.wireId });
      } catch (error) {
        setHarnessError(error instanceof Error ? error.message : String(error));
      }
    }
  }

  async function chooseModel(modelId) {
    if (!activeSession) return;
    updateSession({ model: modelId });
    if (desktop) {
      try {
        await harnessApi.call("session.selectModel", { sessionId: activeSession.id, provider: "deepseek-official", model: modelId });
      } catch (error) {
        setHarnessError(error instanceof Error ? error.message : String(error));
      }
    }
  }

  async function archiveSession(session = activeSession) {
    if (!desktop || !session) return;
    try {
      await harnessApi.call("workspace.archiveSession", { sessionId: session.id });
      await refreshHarness();
    } catch (error) {
      setHarnessError(error instanceof Error ? error.message : String(error));
    }
  }

  async function forkSession(session = activeSession) {
    if (!desktop || !session) return;
    try {
      const forked = await harnessApi.call("session.fork", { sessionId: session.id });
      await refreshHarness(forked.sessionId);
    } catch (error) {
      setHarnessError(error instanceof Error ? error.message : String(error));
    }
  }

  async function exportSession() {
    if (!desktop || !activeSession) return;
    try {
      await globalThis.window.jimu.harness.exportSession(activeSession.id);
    } catch (error) {
      setHarnessError(error instanceof Error ? error.message : String(error));
    }
  }

  async function cancelRun() {
    if (!desktop || !activeSession) return;
    try {
      await harnessApi.call("session.cancel", { sessionId: activeSession.id });
    } catch (error) {
      setHarnessError(error instanceof Error ? error.message : String(error));
    }
  }

  async function answerApproval(interaction, outcome) {
    try {
      await harnessApi.respond({
        type: "client-response",
        rpcId: interaction.rpcId,
        result: { ok: true, value: { sessionId: interaction.sessionId, approvalId: interaction.approvalId, outcome } },
      });
    } catch (error) {
      setHarnessError(error instanceof Error ? error.message : String(error));
    }
  }

  function updateQuestionDraft(interaction, question, value, selected = []) {
    const key = `${interaction.rpcId}:${question.id}`;
    setQuestionDrafts((current) => ({ ...current, [key]: { custom: value, selected } }));
  }

  async function answerQuestions(interaction, cancelled = false) {
    try {
      const result = cancelled
        ? { ok: false, error: { code: "cancelled", message: "the user closed this question request", details: {} } }
        : {
            ok: true,
            value: {
              sessionId: interaction.sessionId,
              answer: {
                answers: interaction.questions.map((question) => {
                  const draft = questionDrafts[`${interaction.rpcId}:${question.id}`] ?? { custom: "", selected: [] };
                  return { id: question.id, selected: draft.selected, ...(draft.custom.trim() ? { custom: draft.custom.trim() } : {}) };
                }),
              },
            },
          };
      await harnessApi.respond({ type: "client-response", rpcId: interaction.rpcId, result });
    } catch (error) {
      setHarnessError(error instanceof Error ? error.message : String(error));
    }
  }

  async function applyPermission(preset) {
    if (preset === permissionPreset) return;
    if (!activeSession || sending) return;
    if (desktop) {
      try {
        if (activeProject && !activeProject.id.startsWith("ungrouped:")) {
          await harnessApi.call("session.create", { sessionId: activeSession.id, workspaceId: activeProject.id });
        }
        await harnessApi.call("session.prompt", {
          sessionId: activeSession.id,
          mode: "queue",
          content: [{ type: "text", text: `/permission ${preset}` }],
        });
        setPermissionPreset(preset);
      } catch (error) {
        setHarnessError(error instanceof Error ? error.message : String(error));
      }
    } else {
      setPermissionPreset(preset);
    }
  }

  async function loadProjectFiles(dir = "") {
    if (!activeProject?.path) return;
    const setter = dir === "" ? setProjectFiles : setDirFiles;
    try {
      const result = desktop
        ? await globalThis.window.jimu.project.listFiles(activeProject.path, dir || undefined)
        : await fetch("/_jimu/project-files", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ projectPath: activeProject.path, ...(dir ? { dir } : {}) }),
          }).then(async (response) => {
            const value = await response.json();
            if (!response.ok) throw new Error(value.error ?? `项目文件请求失败（${response.status}）`);
            return value;
          });
      setter(result.files ?? []);
    } catch (error) {
      setter([]);
      setHarnessError(error instanceof Error ? error.message : String(error));
    }
  }

  function openMention(kind) {
    setMentionOpen(kind);
    setMentionQuery("");
    setMentionIndex(0);
    setMentionDir("");
    setDirFiles([]);
    if (kind === "file") void loadProjectFiles();
  }

  function insertMention(text) {
    setDraft((current) => {
      const at = current.lastIndexOf("@");
      const dollar = current.lastIndexOf("$");
      const idx = Math.max(at, dollar);
      if (idx < 0) return `${current}${text} `;
      return current.slice(0, idx) + text + " ";
    });
    setMentionOpen(null);
    setMentionQuery("");
    setMentionIndex(0);
    setMentionDir("");
    setDirFiles([]);
  }

  function updateMentionQuery(value) {
    setMentionQuery(value);
    setMentionIndex(0);
    // 弹层输入同步写回主输入框的触发符之后，保证草稿即引用。
    setDraft((current) => {
      const at = current.lastIndexOf("@");
      const dollar = current.lastIndexOf("$");
      const idx = Math.max(at, dollar);
      if (idx < 0) return current;
      return current.slice(0, idx + 1) + value;
    });
  }

  function removeMentionRef(kind, raw) {
    setDraft((current) => {
      const index = current.indexOf(raw);
      if (index < 0) return current;
      return current.slice(0, index) + current.slice(index + raw.length).replace(/^\s+/, "");
    });
  }

  // Computed during render (no memo): the mention list must always agree
  // with the DOM of the same render pass, including panel-type switches.
  const mentionCandidates = mentionOpen === "file"
    ? buildFileCandidates(mentionDir ? dirFiles : projectFiles, mentionQuery, mentionDir)
    : mentionOpen === "skill" ? buildSkillCandidates(activeSession?.skills ?? [], mentionQuery)
      : [];

  function navigateMentionDir(dir) {
    setMentionDir(dir);
    setMentionIndex(0);
    if (dir === "") setDirFiles([]);
    else void loadProjectFiles(dir);
  }

  function handleMentionPick(item) {
    if (!item) return;
    if (item.kind === "directory") {
      navigateMentionDir(item.relativePath);
      return;
    }
    insertMention(item.ref);
  }

  function confirmMention() {
    handleMentionPick(mentionCandidates[mentionIndex]);
  }

  function handleMentionKey(event) {
    if (!mentionOpen) return false;
    if (event.key === "ArrowDown") {
      event.preventDefault();
      setMentionIndex((index) => Math.min(index + 1, mentionCandidates.length - 1));
      return true;
    }
    if (event.key === "ArrowUp") {
      event.preventDefault();
      setMentionIndex((index) => Math.max(0, index - 1));
      return true;
    }
    if (event.key === "Enter") {
      event.preventDefault();
      confirmMention();
      return true;
    }
    if (event.key === "Escape") {
      setMentionOpen(null);
      setMentionQuery("");
      setMentionIndex(0);
      setMentionDir("");
      setDirFiles([]);
      return true;
    }
    return false;
  }

  function handleDraftChange(value) {
    setDraft(value);
    const trigger = value.match(/(?:^|\s)([@$])([^\s@$]*)$/);
    if (trigger !== null) {
      const kind = trigger[1] === "@" ? "file" : "skill";
      if (mentionOpen !== kind) openMention(kind);
      setMentionQuery(trigger[2]);
      setMentionIndex(0);
      // 保留 mentionDir：在目录内继续输入查询时，候选只在该目录子树内匹配。
    } else if (mentionOpen) {
      setMentionOpen(null);
      setMentionQuery("");
      setMentionIndex(0);
      setMentionDir("");
      setDirFiles([]);
    }
  }

  async function sendMessage() {
    const text = draft.trim();
    if (!text || !activeSession || sending) return;
    // Sending a message is an explicit intent to watch the newest output:
    // resume the bottom-follow so the reply scrolls into view.
    stickToBottomRef.current = true;
    if (desktop) {
      setSending(true);
      setHarnessError(null);
      updateSession({ time: "刚刚", messages: [...activeSession.messages, { role: "user", text }], blank: false, running: true });
      setDraft("");
      try {
        if (activeProject && !activeProject.id.startsWith("ungrouped:")) {
          await harnessApi.call("session.create", { sessionId: activeSession.id, workspaceId: activeProject.id });
        }
        await harnessApi.call("session.prompt", {
          sessionId: activeSession.id,
          mode: "queue",
          content: [{ type: "text", text }],
          clientTimeZone: Intl.DateTimeFormat().resolvedOptions().timeZone,
        });
        await refreshHarness(activeSession.id);
      } catch (error) {
        setHarnessError(error instanceof Error ? error.message : String(error));
        setSending(false);
      }
      return;
    }
    updateSession({
      time: "刚刚",
      messages: [
        ...activeSession.messages,
        { role: "user", text },
        {
          role: "assistant",
          text: `UI 预览已收到。正式版本会由 ${activeModel.name} 在 ${activePreset.label} 模式中执行，并继续使用 Harness 的工具、权限和会话系统。`,
        },
      ],
    });
    setDraft("");
  }

  const conversationMinimum = clampPanelSize(workspaceWidth * 0.32, 300, 520);
  const projectBrowserCandidate = clampPanelSize(
    projectBrowserPreference,
    PANEL_LAYOUT.projectBrowser.min,
    PANEL_LAYOUT.projectBrowser.max,
  );
  const contextSidebarMaximum = contextOpen
    ? Math.max(
        PANEL_LAYOUT.contextSidebar.min,
        Math.min(
          PANEL_LAYOUT.contextSidebar.max,
          workspaceWidth - projectBrowserCandidate - conversationMinimum,
        ),
      )
    : PANEL_LAYOUT.contextSidebar.max;
  const contextSidebarWidth = clampPanelSize(
    contextSidebarPreference,
    PANEL_LAYOUT.contextSidebar.min,
    contextSidebarMaximum,
  );
  const projectBrowserMaximum = Math.max(
    PANEL_LAYOUT.projectBrowser.min,
    Math.min(
      PANEL_LAYOUT.projectBrowser.max,
      workspaceWidth - (contextOpen ? contextSidebarWidth : 46) - conversationMinimum,
    ),
  );
  const projectBrowserWidth = clampPanelSize(
    projectBrowserPreference,
    PANEL_LAYOUT.projectBrowser.min,
    projectBrowserMaximum,
  );

  return (
    <main
      ref={workspaceRef}
      className="agent-workspace"
      style={{
        "--agent-project-browser-width": `${projectBrowserWidth}px`,
        "--agent-context-sidebar-width": `${contextSidebarWidth}px`,
      }}
    >
      <aside id="agent-projects-pane" className="workspace-browser">
        <div className="workspace-browser-head">
          <div>
            <span className="section-kicker">PROJECTS / SESSIONS</span>
            <strong>项目与会话</strong>
          </div>
          <div className="workspace-head-actions">
            <button type="button" aria-label="新建会话" onClick={() => { void addSession(); }} disabled={!activeProject}><Sparkle size={16} weight="bold" /></button>
            <button type="button" aria-label="导入项目" onClick={() => { void startImport(); }}><FolderPlus size={17} weight="bold" /></button>
          </div>
        </div>
        <label className="workspace-search">
          <MagnifyingGlass size={15} weight="bold" />
          <input value={query} onChange={(event) => setQuery(event.target.value)} placeholder="搜索项目或会话" />
          {query && <button type="button" onClick={() => setQuery("")} aria-label="清空搜索"><X size={13} weight="bold" /></button>}
        </label>
        <div className="project-tree">
          {visibleProjects.map((project) => {
            const expanded = query ? true : project.expanded;
            const projectActive = project.id === activeProjectId;
            return (
              <section className="project-group" data-active={projectActive || undefined} key={project.id}>
                <div className="project-row">
                  <button type="button" className="project-main" onClick={() => {
                    setActiveProjectId(project.id);
                    if (!project.sessions.some((session) => session.id === activeSessionId)) setActiveSessionId(project.sessions[0]?.id ?? "");
                    toggleProject(project.id);
                  }}>
                    <CaretRight className="project-caret" data-open={expanded || undefined} size={13} weight="bold" />
                    <Folder size={17} weight={projectActive ? "fill" : "duotone"} />
                    <span><strong>{project.title}</strong><small>{project.path}</small></span>
                    <em>{project.sessions.length}</em>
                  </button>
                  <div className="project-row-actions">
                    <button type="button" className="project-add-session" onClick={() => { void addSession(project.id); }} aria-label={`在 ${project.title} 新建会话`} disabled={project.id.startsWith("ungrouped:")}>
                      <Plus size={14} weight="bold" />
                    </button>
                    {!project.id.startsWith("ungrouped:") && (
                      <button type="button" className="project-manage" aria-label={`管理项目 ${project.title}`} aria-expanded={projectMenuId === project.id} onClick={() => {
                        setProjectMenuId((current) => current === project.id ? "" : project.id);
                        setSessionMenuId("");
                      }}><DotsThree size={16} weight="bold" /></button>
                    )}
                    {projectMenuId === project.id && (
                      <div className="tree-action-menu project-action-menu" role="menu">
                        <button type="button" onClick={() => beginRename({ type: "project", id: project.id, title: project.title })}><PencilSimple size={14} />重命名</button>
                        <button type="button" disabled={managedProjectIds[0] === project.id} onClick={() => { void moveProject(project.id, "up"); }}><ArrowUp size={14} />上移项目</button>
                        <button type="button" disabled={managedProjectIds.at(-1) === project.id} onClick={() => { void moveProject(project.id, "down"); }}><ArrowDown size={14} />下移项目</button>
                      </div>
                    )}
                  </div>
                </div>
                {expanded && (
                  <div className="project-sessions">
                    {project.sessions.map((session) => {
                      const sessionActive = project.id === activeProjectId && session.id === activeSessionId;
                      return (
                        <div className="session-tree-row" key={session.id}>
                          <button
                            className="session-item"
                            data-active={sessionActive || undefined}
                            type="button"
                            onClick={() => selectSession(project.id, session.id)}
                          >
                            <ChatCircleDots size={16} weight={sessionActive ? "fill" : "regular"} />
                            <span><strong>{session.title}</strong><small>{session.time} · {AGENT_PRESETS.find((item) => item.id === session.preset)?.label}</small></span>
                          </button>
                          <button type="button" className="session-manage" aria-label={`管理会话 ${session.title}`} aria-expanded={sessionMenuId === session.id} onClick={() => {
                            setActiveProjectId(project.id);
                            setActiveSessionId(session.id);
                            setProjectMenuId("");
                            setSessionMenuId((current) => current === session.id ? "" : session.id);
                          }}><DotsThree size={16} weight="bold" /></button>
                          {sessionMenuId === session.id && (
                            <div className="tree-action-menu session-action-menu" role="menu">
                              <button type="button" onClick={() => beginRename({ type: "session", id: session.id, projectId: project.id, title: session.title })}><PencilSimple size={14} />重命名</button>
                              {desktop && <button type="button" onClick={() => { setSessionMenuId(""); void forkSession(session); }}><GitFork size={14} />派生会话</button>}
                              {desktop && <button type="button" onClick={() => { setSessionMenuId(""); void archiveSession(session); }}><Archive size={14} />归档会话</button>}
                            </div>
                          )}
                        </div>
                      );
                    })}
                  </div>
                )}
              </section>
            );
          })}
          {visibleProjects.length === 0 && <p className="workspace-empty">没有匹配的项目或会话。</p>}
        </div>
        <div className="workspace-browser-foot">
          <span><FolderOpen size={15} />{projects.length} 个项目</span>
          <button type="button" onClick={() => { void startImport(); }}>导入项目</button>
        </div>
      </aside>

      <PanelResizeHandle
        className="agent-projects-resizer"
        label="调整项目与会话面板宽度"
        controls="agent-projects-pane agent-conversation-pane"
        size={projectBrowserWidth}
        minimum={PANEL_LAYOUT.projectBrowser.min}
        maximum={projectBrowserMaximum}
        defaultSize={PANEL_LAYOUT.projectBrowser.defaultSize}
        onChange={setProjectBrowserPreference}
      />

      <section id="agent-conversation-pane" className="conversation-preview" data-runtime-banner={desktop && (harnessPhase !== "ready" || harnessError) || undefined}>
        {desktop && harnessPhase !== "ready" && (
          <div className={`harness-runtime-state ${harnessPhase}`}>
            {harnessPhase === "error" ? <X size={15} weight="bold" /> : <span className="index-loader" />}
            <span><strong>{harnessPhase === "booting" ? "Harness 正在启动" : harnessPhase === "restarting" ? "Harness 正在重新加载" : "Harness 启动失败"}</strong><small>{harnessError ?? (harnessPhase === "restarting" ? "插件变更已保存，正在恢复会话与事件订阅…" : "正在加载项目、会话、模型与插件…")}</small></span>
          </div>
        )}
        {desktop && harnessPhase === "ready" && harnessErrorDisplay && (
          <div className="harness-runtime-state warning">
            <X size={15} weight="bold" />
            <span><strong>{harnessErrorDisplay.title}</strong><small>{harnessErrorDisplay.message}</small></span>
            {harnessErrorDisplay.action === "settings" && <button type="button" className="runtime-primary-action" onClick={onOpenSettings}>前往设置</button>}
            <button type="button" onClick={() => setHarnessError(null)}>关闭</button>
          </div>
        )}
        <div className="conversation-head">
          <div className="active-session-title">
            <span className="section-kicker">ACTIVE SESSION / {activeProject?.title}</span>
            <h2>{activeSession?.title ?? "选择一个会话"}</h2>
            <p><Folder size={14} weight="duotone" />{activeProject?.path}</p>
          </div>
          <div className="session-controls">
            <button className="environment-toggle" type="button" data-active={contextOpen || undefined} onClick={() => setContextOpen((value) => !value)} aria-expanded={contextOpen}>
              <PlugsConnected size={15} weight="bold" /><span>执行环境</span>
            </button>
            {desktop && activeSession && (
              <div className="session-utility-actions" aria-label="会话操作">
                <button type="button" onClick={() => { void forkSession(); }} title="派生会话"><GitFork size={15} weight="bold" /></button>
                <button type="button" onClick={() => { void exportSession(); }} title="导出会话 ZIP"><DownloadSimple size={15} weight="bold" /></button>
                <button type="button" onClick={() => { void archiveSession(); }} title="归档会话"><Archive size={15} weight="bold" /></button>
              </div>
            )}
            <button className="new-session-button" type="button" onClick={() => { void addSession(); }} disabled={!activeProject}>
              <Plus size={15} weight="bold" />新会话
            </button>
            <div className="model-picker">
              <button type="button" className="model-picker-trigger" onClick={() => {
                setModelOpen((value) => !value);
                setComposerModelOpen(false);
                setComposerPresetOpen(false);
              }} aria-expanded={modelOpen}>
                <Lightning size={15} weight="fill" />
                <span><small>MODEL</small><strong>{activeModel.name}</strong></span>
                <CaretDown size={13} weight="bold" />
              </button>
              {modelOpen && (
                <div className="model-menu" role="menu">
                  <span>DEEPSEEK OFFICIAL</span>
                  {MODEL_OPTIONS.map((model) => (
                    <button
                      type="button"
                      key={model.id}
                      data-active={model.id === activeModel.id || undefined}
                      onClick={() => {
                        void chooseModel(model.id);
                        setModelOpen(false);
                      }}
                    >
                      <Cpu size={17} weight={model.id === activeModel.id ? "fill" : "duotone"} />
                      <span><strong>{model.name}</strong><small>{model.description}</small></span>
                      {model.id === activeModel.id && <Check size={15} weight="bold" />}
                    </button>
                  ))}
                </div>
              )}
            </div>
          </div>
        </div>

        <div className="session-preset-strip">
          <span>AGENT PRESET</span>
          <div className="preset-switcher">
            {AGENT_PRESETS.map((preset) => {
              const PresetIcon = preset.icon;
              return (
                <button
                  key={preset.id}
                  type="button"
                  data-active={activePreset.id === preset.id || undefined}
                  data-accent={preset.accent}
                  disabled={desktop && !activeSession?.blank}
                  onClick={() => { void choosePreset(preset.id); }}
                  title={preset.description}
                >
                  <PresetIcon size={14} weight={activePreset.id === preset.id ? "fill" : "regular"} />{preset.label}
                </button>
              );
            })}
          </div>
          <small>{activePreset.name} · {activePreset.description}{desktop && !activeSession?.blank ? " · 首条消息发送后已锁定" : ""}</small>
        </div>

        <div className="conversation-stage" data-context-open={contextOpen || undefined}>
          <div className="conversation-flow">
        <div className="message-stream" ref={messageStreamRef} onScroll={() => {
          const el = messageStreamRef.current;
          if (!el) return;
          stickToBottomRef.current = el.scrollHeight - el.scrollTop - el.clientHeight < 48;
        }}>
          {desktop && harnessPhase === "ready" && !activeSession && (
            <div className="agent-empty-state"><ChatCircleDots size={34} weight="duotone" /><strong>选择或新建一个会话</strong><p>会话会保存在当前项目下，并继续使用 Harness 的工具、权限和插件。</p></div>
          )}
          {activeSession && (activeSession.messages ?? []).length === 0 && (
            <div className="agent-empty-state"><Sparkle size={34} weight="duotone" /><strong>这是一个空白会话</strong><p>先选择 Agent 模式与 DeepSeek V4 模型，再发送第一条任务。</p></div>
          )}
          {(activeSession?.messages ?? []).filter((message) => message.role !== "context").map((message, index) => (
            <AgentPipelineRow message={message} sessionId={activeSession?.id} index={index} key={`${activeSession?.id}-${message.role}-${message.seq ?? message.callId ?? index}`} />
          ))}
          {sending && <div className="message assistant pending"><span>JiMu</span><p><span className="index-loader" />Harness 正在执行任务…</p></div>}
        </div>
        {pendingInteractions.filter((item) => item.sessionId === activeSession?.id).map((interaction) => (
          <section className="agent-interaction" key={interaction.key}>
            {interaction.type === "approval/requested" ? (
              <>
                <div><ShieldCheck size={21} weight="duotone" /><span><strong>Harness 需要权限确认</strong><small>{interaction.reason ?? `工具 ${interaction.toolName} 请求执行`}</small></span></div>
                <div className="agent-interaction-actions">
                  <button type="button" onClick={() => { void answerApproval(interaction, "rejected"); }}>拒绝</button>
                  <button type="button" className="primary" onClick={() => { void answerApproval(interaction, "allowed-once"); }}>允许一次</button>
                </div>
              </>
            ) : (
              <>
                <div><ChatCircleDots size={21} weight="duotone" /><span><strong>Harness 正在等待你的回答</strong><small>完成问题后继续当前 Agent 任务</small></span></div>
                <div className="agent-question-list">
                  {interaction.questions.map((question) => {
                    const draft = questionDrafts[`${interaction.rpcId}:${question.id}`] ?? { custom: "", selected: [] };
                    return (
                      <label key={question.id}>
                        <strong>{question.header ?? question.question}</strong>
                        {question.header && <small>{question.question}</small>}
                        {(question.options ?? []).length > 0 && <span className="agent-question-options">{question.options.map((option) => (
                          <button type="button" data-active={draft.selected.includes(option.label) || undefined} key={option.label} onClick={() => {
                            const selected = question.multiSelect
                              ? (draft.selected.includes(option.label) ? draft.selected.filter((item) => item !== option.label) : [...draft.selected, option.label])
                              : [option.label];
                            updateQuestionDraft(interaction, question, question.multiSelect ? draft.custom : "", selected);
                          }}>{option.label}</button>
                        ))}</span>}
                        <input value={draft.custom} placeholder="补充回答（可选）" onChange={(event) => updateQuestionDraft(interaction, question, event.target.value, draft.selected)} />
                      </label>
                    );
                  })}
                </div>
                <div className="agent-interaction-actions">
                  <button type="button" onClick={() => { void answerQuestions(interaction, true); }}>取消</button>
                  <button type="button" className="primary" onClick={() => { void answerQuestions(interaction); }}>提交回答</button>
                </div>
              </>
            )}
          </section>
        ))}
        <div className="composer">
          {mentionOpen && (
            <MentionPanel
              kind={mentionOpen}
              query={mentionQuery}
              setQuery={updateMentionQuery}
              candidates={mentionCandidates}
              dir={mentionDir}
              selectedIndex={mentionIndex}
              setSelectedIndex={setMentionIndex}
              onNavigateDir={navigateMentionDir}
              onKeyDown={handleMentionKey}
              onClose={() => { setMentionOpen(null); setMentionQuery(""); setMentionIndex(0); setMentionDir(""); }}
              onPick={handleMentionPick}
            />
          )}
          {(fileRefs.length > 0 || skillRefs.length > 0) && (
            <div className="composer-ref-chips">
              {fileRefs.map((ref) => (
                <span className="ref-chip" key={ref.raw}><Folder size={12} weight="duotone" /><strong>@</strong>{ref.text}<button type="button" onClick={() => removeMentionRef("file", ref.raw)} aria-label="移除文件引用"><X size={11} weight="bold" /></button></span>
              ))}
              {skillRefs.map((ref) => (
                <span className="ref-chip skill" key={ref.raw}><PuzzlePiece size={12} weight="duotone" /><strong>$</strong>{ref.text}<button type="button" onClick={() => removeMentionRef("skill", ref.raw)} aria-label="移除 Skill 引用"><X size={11} weight="bold" /></button></span>
              ))}
            </div>
          )}
          <textarea
            value={draft}
            onChange={(event) => handleDraftChange(event.target.value)}
            onKeyDown={(event) => {
              if (handleMentionKey(event)) return;
              if (event.key === "Enter" && event.metaKey) { event.preventDefault(); void sendMessage(); }
            }}
            placeholder={`在 ${activeProject?.title ?? "当前项目"} 中给 JiMu 一个任务…（输入 @ 引用文件，输入 $ 调用 Skill）`}
            rows={3}
            disabled={!activeSession || harnessPhase !== "ready"}
          />
          <div className="composer-status-bar">
            <div className="permission-switch" role="group" aria-label="沙箱授权">
              <span>沙箱授权</span>
              <button type="button" data-active={permissionPreset === "workspace-write" || undefined} onClick={() => void applyPermission("workspace-write")}><ShieldCheck size={13} weight="fill" />需要审批</button>
              <button type="button" data-active={permissionPreset === "danger-full-access" || undefined} onClick={() => void applyPermission("danger-full-access")}><LockSimple size={13} weight="fill" />完全授权</button>
            </div>
            <div className="composer-context-meters">
              {compactionState.phase !== "idle" && (
                <span className="compaction-meter" data-state={compactionState.phase}>
                  <i aria-hidden="true" />
                  <small>{compactionState.phase === "running" ? "正在整理上下文…" : compactionState.count !== null ? `已压缩 ${compactionState.count} 条消息` : "上下文压缩完成"}</small>
                </span>
              )}
              {cacheStats.requests > 0 && (
                <span className="cache-meter" title="缓存命中率 = 缓存读取 tokens ÷ 总输入 tokens">
                  <Lightning size={12} weight="fill" />
                  <small>缓存命中 {cacheStats.lastCacheRate !== null ? `${Math.round(cacheStats.lastCacheRate * 100)}%` : "—"} · 累计 {cacheStats.cacheRate !== null ? `${Math.round(cacheStats.cacheRate * 100)}%` : "—"}</small>
                </span>
              )}
            </div>
          </div>
          <div className="composer-footer">
            <div className="composer-control-row">
              <div className="composer-selector">
                <button
                  type="button"
                  className="composer-selector-trigger"
                  aria-label={`选择 Agent 模式，当前 ${activePreset.label}`}
                  aria-expanded={composerPresetOpen}
                  disabled={desktop && !activeSession?.blank}
                  onClick={() => {
                    setComposerPresetOpen((value) => !value);
                    setComposerModelOpen(false);
                    setModelOpen(false);
                  }}
                >
                  <ActivePresetIcon size={14} weight="fill" />
                  <span><small>MODE</small><strong>{activePreset.label}</strong></span>
                  <CaretDown size={12} weight="bold" />
                </button>
                {composerPresetOpen && (
                  <div className="composer-selector-menu composer-preset-menu" role="menu" aria-label="Agent 模式">
                    <span>BUILT-IN AGENT MODES</span>
                    {AGENT_PRESETS.map((preset) => {
                      const PresetIcon = preset.icon;
                      return (
                        <button
                          type="button"
                          role="menuitemradio"
                          aria-checked={preset.id === activePreset.id}
                          data-active={preset.id === activePreset.id || undefined}
                          key={preset.id}
                          onClick={() => {
                            void choosePreset(preset.id);
                            setComposerPresetOpen(false);
                          }}
                        >
                          <PresetIcon size={16} weight={preset.id === activePreset.id ? "fill" : "duotone"} />
                          <span><strong>{preset.label}</strong><small>{preset.name}</small></span>
                          {preset.id === activePreset.id && <Check size={14} weight="bold" />}
                        </button>
                      );
                    })}
                  </div>
                )}
              </div>

              <div className="composer-selector">
                <button
                  type="button"
                  className="composer-selector-trigger model"
                  aria-label={`选择模型，当前 ${activeModel.name}`}
                  aria-expanded={composerModelOpen}
                  onClick={() => {
                    setComposerModelOpen((value) => !value);
                    setComposerPresetOpen(false);
                    setModelOpen(false);
                  }}
                >
                  <Lightning size={14} weight="fill" />
                  <span><small>MODEL</small><strong>{activeModel.name}</strong></span>
                  <CaretDown size={12} weight="bold" />
                </button>
                {composerModelOpen && (
                  <div className="composer-selector-menu composer-model-menu" role="menu" aria-label="DeepSeek 模型">
                    <span>DEEPSEEK V4</span>
                    {MODEL_OPTIONS.map((model) => (
                      <button
                        type="button"
                        role="menuitemradio"
                        aria-checked={model.id === activeModel.id}
                        data-active={model.id === activeModel.id || undefined}
                        key={model.id}
                        onClick={() => {
                          void chooseModel(model.id);
                          setComposerModelOpen(false);
                        }}
                      >
                        <Cpu size={16} weight={model.id === activeModel.id ? "fill" : "duotone"} />
                        <span><strong>{model.name}</strong><small>{model.description}</small></span>
                        {model.id === activeModel.id && <Check size={14} weight="bold" />}
                      </button>
                    ))}
                  </div>
                )}
              </div>

              <span className="composer-project-context"><Folder size={14} weight="duotone" />{activeProject?.title}</span>
            </div>
            <button className="composer-send" data-cancel={sending || undefined} type="button" onClick={() => { sending ? void cancelRun() : void sendMessage(); }} disabled={!activeSession || (!sending && !draft.trim())}>
              {sending ? "停止" : "发送"} {sending ? <X size={16} weight="bold" /> : <PaperPlaneRight size={16} weight="fill" />}
            </button>
          </div>
        </div>
        </div>
        </div>
      </section>

      {contextOpen ? (
        <>
          <PanelResizeHandle
            className="agent-context-resizer"
            label="调整执行环境面板宽度"
            controls="agent-conversation-pane agent-context-pane"
            size={contextSidebarWidth}
            minimum={PANEL_LAYOUT.contextSidebar.min}
            maximum={contextSidebarMaximum}
            defaultSize={PANEL_LAYOUT.contextSidebar.defaultSize}
            direction={-1}
            onChange={setContextSidebarPreference}
          />
          <AgentContextSidebar
            project={activeProject}
            session={activeSession}
            preset={activePreset}
            model={activeModel}
            messages={activeSession?.messages ?? []}
            onClose={() => setContextOpen(false)}
          />
        </>
      ) : (
        <button className="context-sidebar-reopen" type="button" onClick={() => setContextOpen(true)}><PlugsConnected size={16} weight="bold" /><span>执行环境</span></button>
      )}

      {!desktop && (
        <ImportProjectModal
          open={importOpen}
          path={importPath}
          setPath={setImportPath}
          onClose={() => setImportOpen(false)}
          onImport={importProject}
        />
      )}
      <RenameModal
        target={renameTarget}
        value={renameValue}
        setValue={setRenameValue}
        onClose={() => { setRenameTarget(null); setRenameValue(""); }}
        onSave={saveRename}
      />
    </main>
  );
}

function SettingsRow({ icon: Icon, title, description, children }) {
  return (
    <div className="settings-row">
      <span className="settings-row-icon"><Icon size={19} weight="duotone" /></span>
      <span className="settings-row-copy"><strong>{title}</strong><small>{description}</small></span>
      <div className="settings-row-control">{children}</div>
    </div>
  );
}

function SettingsScreen({ onboarding, onOnboardingChange }) {
  const desktop = harnessApi.available();
  const [section, setSection] = useState("general");
  const [root, setRoot] = useState("");
  const [defaultPreset, setDefaultPreset] = useState("standard");
  const [defaultModel, setDefaultModel] = useState("deepseek-v4-flash");
  const [permission, setPermission] = useState("workspace-write");
  const [busyEnter, setBusyEnter] = useState("queue");
  const [configOpened, setConfigOpened] = useState(false);
  const [settingsPhase, setSettingsPhase] = useState(desktop ? "loading" : "preview");
  const [settingsError, setSettingsError] = useState(null);
  const [credential, setCredential] = useState({ configured: false, writable: desktop, source: desktop ? undefined : "preview" });
  const [credentialOpen, setCredentialOpen] = useState(false);
  const [credentialDraft, setCredentialDraft] = useState("");
  const [savingCredential, setSavingCredential] = useState(false);
  const [moduleBusy, setModuleBusy] = useState("");
  const [moduleConfirmation, setModuleConfirmation] = useState(null);
  const [rootConfirmation, setRootConfirmation] = useState(null);
  const currentSection = SETTINGS_SECTIONS.find((item) => item.id === section) ?? SETTINGS_SECTIONS[0];

  const loadSettings = useCallback(async () => {
    if (!desktop) return;
    try {
      const status = await harnessApi.status();
      if (status.phase === "booting") {
        setSettingsPhase("loading");
        return false;
      }
      if (status.phase === "error") throw new Error(status.error ?? "Harness 启动失败");
      const [described, roster, credentials, setup] = await Promise.all([
        harnessApi.call("settings.describe", {}),
        harnessApi.call("agentPreset.list", {}),
        harnessApi.call("credentials.describe", { refs: ["DEEPSEEK_API_KEY"] }),
        knowledgeApi.setup(),
      ]);
      const namespaces = new Map(described.namespaces.map((item) => [item.ns, item]));
      const preset = roster.presets.find((item) => item.isDefault)?.id;
      const modelValue = namespaces.get("agent-default-model")?.value;
      const permissionValue = namespaces.get("permission")?.value;
      const conversationValue = namespaces.get("ui-conversation")?.value;
      if (preset) setDefaultPreset(preset === "cordis" ? "creator" : preset);
      if (modelValue && typeof modelValue.model === "string") setDefaultModel(modelValue.model);
      if (permissionValue && typeof permissionValue.defaultPreset === "string") setPermission(permissionValue.defaultPreset);
      if (conversationValue && typeof conversationValue.busyEnter === "string") setBusyEnter(conversationValue.busyEnter);
      setCredential(credentials.credentials.DEEPSEEK_API_KEY ?? { configured: false, writable: false });
      setRoot(setup.root ?? "");
      setSettingsPhase("ready");
      setSettingsError(null);
      return true;
    } catch (error) {
      setSettingsPhase("error");
      setSettingsError(error instanceof Error ? error.message : String(error));
      return true;
    }
  }, [desktop]);

  useEffect(() => {
    if (!desktop) return undefined;
    let active = true;
    let timer;
    const poll = async () => {
      const done = await loadSettings();
      if (active && !done) timer = setTimeout(poll, 350);
    };
    void poll();
    return () => { active = false; clearTimeout(timer); };
  }, [desktop, loadSettings]);

  async function updateSetting(ns, patch, applyLocal) {
    applyLocal();
    if (!desktop) return;
    try {
      setSettingsError(null);
      await harnessApi.call("settings.update", { ns, patch });
      await loadSettings();
    } catch (error) {
      setSettingsError(error instanceof Error ? error.message : String(error));
      await loadSettings();
    }
  }

  async function chooseKnowledgeRoot() {
    if (!desktop) return;
    try {
      const result = await globalThis.window.jimu.onboarding.previewExisting({ revision: onboarding.revision });
      if (result.canceled) return;
      if (result.accepted === false) {
        setSettingsError(result.setup?.error ?? "所选目录不兼容。");
        return;
      }
      if (result.requiresConfirmation) {
        setRootConfirmation(result);
        return;
      }
      const next = await globalThis.window.jimu.onboarding.applyExisting({
        revision: onboarding.revision,
        token: result.token,
        confirmCreate: false,
      });
      setRoot(result.root);
      onOnboardingChange(next);
    } catch (error) {
      setSettingsError(error instanceof Error ? error.message : String(error));
    }
  }

  async function confirmKnowledgeRoot() {
    if (!rootConfirmation) return;
    try {
      const next = await globalThis.window.jimu.onboarding.applyExisting({
        revision: onboarding.revision,
        token: rootConfirmation.token,
        confirmCreate: true,
      });
      setRoot(rootConfirmation.root);
      setRootConfirmation(null);
      onOnboardingChange(next);
    } catch (error) {
      setSettingsError(error instanceof Error ? error.message : String(error));
    }
  }

  async function openSettingsDocument() {
    if (!desktop) {
      setConfigOpened(true);
      return;
    }
    try {
      await harnessApi.call("settings.openDocument", {});
      setConfigOpened(true);
    } catch (error) {
      setSettingsError(error instanceof Error ? error.message : String(error));
    }
  }

  async function saveCredential() {
    if (!desktop || !credentialDraft.trim() || savingCredential) return;
    setSavingCredential(true);
    try {
      const next = await globalThis.window.jimu.onboarding.testAndSaveDeepSeek({
        revision: onboarding.revision,
        apiKey: credentialDraft.trim(),
      });
      setCredentialDraft("");
      setCredentialOpen(false);
      onOnboardingChange(next);
      await loadSettings();
    } catch (error) {
      setSettingsError(error instanceof Error ? error.message : String(error));
    } finally {
      setSavingCredential(false);
    }
  }

  async function unsetCredential() {
    if (!desktop || !credential.writable) return;
    try {
      await harnessApi.call("credentials.unset", { ref: "DEEPSEEK_API_KEY" });
      setCredentialOpen(false);
      onOnboardingChange(await globalThis.window.jimu.onboarding.snapshot());
      await loadSettings();
    } catch (error) {
      setSettingsError(error instanceof Error ? error.message : String(error));
    }
  }

  async function updateModule(id, enabled, confirmCreate = false) {
    if (!desktop || moduleBusy) return;
    setModuleBusy(id);
    setSettingsError(null);
    try {
      const modules = {
        benchmarks: id === "benchmarks" ? enabled : onboarding.modules.benchmarks.enabled,
        factory: id === "factory" ? enabled : onboarding.modules.factory.enabled,
      };
      const next = await globalThis.window.jimu.onboarding.updateModules({
        revision: onboarding.revision,
        modules,
        confirmCreate,
      });
      if (next.requiresConfirmation) {
        setModuleConfirmation({ id, enabled, directories: next.missingModules });
      } else {
        setModuleConfirmation(null);
        onOnboardingChange(next);
      }
    } catch (error) {
      setSettingsError(error instanceof Error ? error.message : String(error));
    } finally {
      setModuleBusy("");
    }
  }

  return (
    <main className="settings-page harness-settings-page">
      <div className="settings-shell">
        <aside className="settings-nav">
          <div className="settings-nav-head">
            <span>JIMU / SETTINGS</span>
            <h2>设置</h2>
            <p>沿用 DeepSeek Harness 设置分区；知识库目录由用户主动选择，不扫描主目录。</p>
          </div>
          <nav aria-label="设置分区">
            {SETTINGS_SECTIONS.map((item, index) => {
              const ItemIcon = item.icon;
              return (
                <button type="button" key={item.id} data-active={section === item.id || undefined} onClick={() => setSection(item.id)}>
                  <span>{String(index + 1).padStart(2, "0")}</span><ItemIcon size={18} weight={section === item.id ? "fill" : "regular"} />{item.label}
                </button>
              );
            })}
          </nav>
          <button className="open-config-button" type="button" onClick={() => { void openSettingsDocument(); }}>
            <FileText size={17} />打开配置文件
          </button>
          {configOpened && <p className="config-notice"><Check size={13} weight="bold" />已在 macOS 中打开 Harness 配置</p>}
        </aside>

        <section className="settings-content" data-error={settingsError || undefined}>
          <header className="settings-content-head">
            <div>
              <span className="section-kicker">HARNESS CONFIGURATION</span>
              <h2>{currentSection.label}</h2>
            </div>
            <span className="settings-local-badge"><Check size={14} weight="bold" />{settingsPhase === "loading" ? "正在连接" : settingsPhase === "error" ? "配置异常" : "本地配置"}</span>
          </header>

          {settingsError && <div className="settings-error"><X size={14} weight="bold" /><span>{settingsError}</span><button type="button" onClick={() => setSettingsError(null)}>关闭</button></div>}

          {section === "general" && (
            <div className="settings-section-body">
              <p className="settings-section-intro">新设置只影响之后创建的会话；正在运行的会话继续保留启动时的 Agent 预设。</p>
              <div className="settings-row-group">
                <SettingsRow icon={ShieldCheck} title="权限" description="选择新会话的默认权限模式">
                  <select value={permission} onChange={(event) => { const value = event.target.value; void updateSetting("permission", { defaultPreset: value }, () => setPermission(value)); }}>
                    <option value="workspace-write">Workspace write</option>
                    <option value="danger-full-access">Full access</option>
                  </select>
                </SettingsRow>
                <SettingsRow icon={Translate} title="语言" description="JiMu 默认界面语言">
                  <select defaultValue="zh-CN"><option value="zh-CN">简体中文</option><option value="en">English</option></select>
                </SettingsRow>
                <SettingsRow icon={Palette} title="外观" description="v1 固定使用当前皮肤，不显示换肤入口">
                  <span className="fixed-value"><Check size={14} weight="bold" />JiMu Retro</span>
                </SettingsRow>
                <SettingsRow icon={Brain} title="Agent 预设" description="用于之后新建的会话">
                  <select value={defaultPreset} onChange={(event) => { const value = event.target.value; const wireId = value === "creator" ? "cordis" : value; void updateSetting("agent-presets", { default: wireId }, () => setDefaultPreset(value)); }}>
                    {AGENT_PRESETS.map((preset) => <option value={preset.id} key={preset.id}>{preset.label}</option>)}
                  </select>
                </SettingsRow>
                <SettingsRow icon={Command} title="繁忙时 Enter 键行为" description="Command + Enter 使用另一行为">
                  <select value={busyEnter} onChange={(event) => { const value = event.target.value; void updateSetting("ui-conversation", { busyEnter: value }, () => setBusyEnter(value)); }}>
                    <option value="queue">排队发送</option>
                    <option value="steer">插话发送</option>
                  </select>
                </SettingsRow>
                <SettingsRow icon={FolderOpen} title="知识库目录" description="JiMu 专属；正式桌面版使用原生目录选择器">
                  <button type="button" className="root-selector" onClick={() => { void chooseKnowledgeRoot(); }} title={root}>
                    <span>{root || "未配置"}</span><CaretDown size={13} weight="bold" />
                  </button>
                </SettingsRow>
                <SettingsRow icon={DownloadSimple} title="知识库来源" description="最近一次成功激活的本地来源">
                  <span className="fixed-value"><Check size={14} weight="bold" />{onboarding.knowledge.source === "github-release" ? "GitHub Release" : onboarding.knowledge.source === "bundled-fallback" ? "安装包内置副本" : onboarding.knowledge.source === "existing" ? "已有知识库" : "本地配置"}</span>
                </SettingsRow>
                <SettingsRow icon={UsersThree} title="对标博主库" description="按需扫描 07-对标博主库；关闭不会删除内容">
                  <button
                    type="button"
                    className="settings-module-switch"
                    role="switch"
                    aria-label="启用或关闭对标博主库"
                    aria-checked={onboarding.modules.benchmarks.enabled}
                    aria-busy={moduleBusy === "benchmarks"}
                    data-enabled={onboarding.modules.benchmarks.enabled || undefined}
                    disabled={Boolean(moduleBusy)}
                    onClick={() => { void updateModule("benchmarks", !onboarding.modules.benchmarks.enabled); }}
                  >{moduleBusy === "benchmarks" ? (onboarding.modules.benchmarks.enabled ? "正在关闭…" : "正在启用…") : onboarding.modules.benchmarks.enabled ? "已启用" : "已关闭"}</button>
                </SettingsRow>
                <SettingsRow icon={Factory} title="自媒体工厂" description="按需启动 08-自媒体工厂；关闭不会删除内容">
                  <button
                    type="button"
                    className="settings-module-switch"
                    role="switch"
                    aria-label="启用或关闭自媒体工厂"
                    aria-checked={onboarding.modules.factory.enabled}
                    aria-busy={moduleBusy === "factory"}
                    data-enabled={onboarding.modules.factory.enabled || undefined}
                    disabled={Boolean(moduleBusy)}
                    onClick={() => { void updateModule("factory", !onboarding.modules.factory.enabled); }}
                  >{moduleBusy === "factory" ? (onboarding.modules.factory.enabled ? "正在关闭…" : "正在启用…") : onboarding.modules.factory.enabled ? "已启用" : "已关闭"}</button>
                </SettingsRow>
              </div>
              {moduleConfirmation && (
                <div className="settings-module-confirm">
                  <ShieldCheck size={18} weight="duotone" />
                  <span><strong>创建模块所需的空目录？</strong><small>{moduleConfirmation.directories.map((id) => id === "benchmarks" ? "07-对标博主库" : "08-自媒体工厂").join("、")}</small></span>
                  <button type="button" onClick={() => setModuleConfirmation(null)}>取消</button>
                  <button type="button" onClick={() => { void updateModule(moduleConfirmation.id, moduleConfirmation.enabled, true); }}>确认创建</button>
                </div>
              )}
              {rootConfirmation && (
                <div className="settings-module-confirm">
                  <ShieldCheck size={18} weight="duotone" />
                  <span><strong>所选知识库缺少已启用模块</strong><small>{rootConfirmation.missingModules.map((id) => id === "benchmarks" ? "07-对标博主库" : "08-自媒体工厂").join("、")}</small></span>
                  <button type="button" onClick={() => setRootConfirmation(null)}>取消</button>
                  <button type="button" onClick={() => { void confirmKnowledgeRoot(); }}>创建空目录并连接</button>
                </div>
              )}
            </div>
          )}

          {section === "models" && (
            <div className="settings-section-body">
              <p className="settings-section-intro">DeepSeek 官方提供方沿用 Harness 的模型目录；当前界面只保留 V4 Flash 与 V4 Pro。</p>
              <section className="provider-card">
                <div className="provider-card-head">
                  <span className="provider-mark"><Cpu size={22} weight="fill" /></span>
                  <span><small>PROVIDER</small><strong>DeepSeek Official</strong><em>deepseek-official</em></span>
                  <span className="provider-status" data-configured={credential.configured || undefined}><span />{credential.configured ? `API Key 已配置${credential.source ? ` · ${credential.source}` : ""}` : "API Key 未配置"}</span>
                  <button type="button" disabled={!credential.writable} onClick={() => setCredentialOpen((value) => !value)}>{credentialOpen ? "取消" : "编辑"}</button>
                </div>
                {credentialOpen && (
                  <div className="credential-editor">
                    <LockSimple size={18} weight="duotone" />
                    <label><span>DEEPSEEK_API_KEY</span><input type="password" autoComplete="off" value={credentialDraft} onChange={(event) => setCredentialDraft(event.target.value)} placeholder="输入新 Key；现有值不会显示" /></label>
                    <button type="button" disabled={!credentialDraft.trim() || savingCredential} onClick={() => { void saveCredential(); }}>{savingCredential ? "保存中" : "保存"}</button>
                    {credential.configured && <button type="button" className="credential-unset" onClick={() => { void unsetCredential(); }}>移除</button>}
                  </div>
                )}
                <div className="model-directory">
                  <div className="model-directory-head"><span>模型目录</span><small>DEFAULT FOR NEW SESSIONS</small></div>
                  {MODEL_OPTIONS.map((model, index) => (
                    <button type="button" className="model-setting-row" data-active={model.id === defaultModel || undefined} key={model.id} onClick={() => { void updateSetting("agent-default-model", { provider: "deepseek-official", model: model.id }, () => setDefaultModel(model.id)); }}>
                      <span className="model-number">0{index + 1}</span>
                      <span><strong>{model.name}</strong><small>{model.wireName}</small></span>
                      <span className="model-capacity"><strong>1M</strong><small>CONTEXT</small></span>
                      <span className="radio-mark">{model.id === defaultModel && <Check size={13} weight="bold" />}</span>
                    </button>
                  ))}
                </div>
              </section>
            </div>
          )}

          {section === "plugins" && (
            <div className="settings-section-body">
              <PluginSettingsPanel desktop={desktop} />
            </div>
          )}

          {section === "agent-presets" && (
            <div className="settings-section-body">
              <p className="settings-section-intro">四个内置预设完整保留。设为默认只影响之后的新会话，已有会话继续使用启动时的预设。</p>
              <div className="preset-settings-grid">
                {AGENT_PRESETS.map((preset, index) => {
                  const PresetIcon = preset.icon;
                  const selected = preset.id === defaultPreset;
                  return (
                    <article className="preset-setting-card" data-accent={preset.accent} data-active={selected || undefined} key={preset.id}>
                      <span className="preset-setting-index">0{index + 1}</span>
                      <span className="preset-setting-icon"><PresetIcon size={23} weight="duotone" /></span>
                      <span className="preset-built-in">BUILT-IN</span>
                      <h3>{preset.label}</h3>
                      <h4>{preset.name}</h4>
                      <p>{preset.description}</p>
                      <div>
                        <button type="button" onClick={() => { void updateSetting("agent-presets", { default: preset.wireId }, () => setDefaultPreset(preset.id)); }} disabled={selected}>
                          {selected ? <><Check size={14} weight="bold" />当前默认</> : "设为默认"}
                        </button>
                        <button type="button" className="preset-view-button">查看</button>
                      </div>
                    </article>
                  );
                })}
              </div>
            </div>
          )}
        </section>
      </div>
    </main>
  );
}

function MainApp({ onboarding, onOnboardingChange }) {
  const [mode, setMode] = useState("knowledge");
  const [appSidebarPreference, setAppSidebarPreference] = useStoredPanelSize(PANEL_LAYOUT.appSidebar);
  const appRef = useRef(null);
  const viewportWidth = useElementWidth(appRef, globalThis.innerWidth || 1512);
  const [sidebarCollapsed, setSidebarCollapsed] = useState(() => {
    try {
      return globalThis.localStorage?.getItem("jimu.sidebarCollapsed") === "1";
    } catch {
      return false;
    }
  });
  const [knowledgeSection, setKnowledgeSection] = useState("overview");
  const [searchOpen, setSearchOpen] = useState(false);
  const [openRequest, setOpenRequest] = useState(null);
  const [agentOpenRequest, setAgentOpenRequest] = useState(null);
  const [indexState, setIndexState] = useState({ phase: "loading", data: null, error: null });
  const modules = {
    benchmarks: onboarding.modules.benchmarks.enabled,
    factory: onboarding.modules.factory.enabled,
  };

  const loadKnowledge = useCallback(async () => {
    try {
      const setup = await knowledgeApi.setup();
      if (setup.phase !== "ready") {
        setIndexState({ phase: "setup", setup, data: null, error: null });
        return;
      }
      const payload = await knowledgeApi.snapshot();
      setIndexState({ phase: "ready", setup, data: payload, error: null });
    } catch (error) {
      setIndexState({ phase: "error", data: null, error: error instanceof Error ? error.message : String(error) });
    }
  }, []);

  useEffect(() => {
    let active = true;
    const refresh = async () => { if (active) await loadKnowledge(); };
    void refresh();
    const unsubscribe = globalThis.window.jimu
      ? globalThis.window.jimu.knowledge.subscribeChanges(() => { void refresh(); })
      : (() => {});
    return () => {
      active = false;
      unsubscribe();
    };
  }, [loadKnowledge]);

  useEffect(() => {
    const onKeyDown = (event) => {
      if (event.metaKey && event.key.toLocaleLowerCase("en-US") === "k") {
        event.preventDefault();
        setSearchOpen(true);
      }
    };
    globalThis.document.addEventListener("keydown", onKeyDown);
    const unsubscribeSearch = globalThis.window.jimu?.commands.onSearch(() => setSearchOpen(true));
    const unsubscribeSettings = globalThis.window.jimu?.commands.onSettings?.(() => setMode("settings"));
    return () => {
      globalThis.document.removeEventListener("keydown", onKeyDown);
      unsubscribeSearch?.();
      unsubscribeSettings?.();
    };
  }, []);

  useEffect(() => {
    if (!modules.factory && mode === "factory") setMode("knowledge");
  }, [mode, modules.factory]);

  function openSearchResult(document, query) {
    setMode("knowledge");
    setKnowledgeSection("archive");
    setOpenRequest({ id: document.stableId, query, nonce: Date.now() });
    setSearchOpen(false);
  }

  function openAgent(request = null) {
    setMode("agent");
    if (request?.sessionId) setAgentOpenRequest({ ...request, nonce: Date.now() });
  }

  function toggleSidebar() {
    setSidebarCollapsed((current) => {
      const next = !current;
      try {
        globalThis.localStorage?.setItem("jimu.sidebarCollapsed", next ? "1" : "0");
      } catch {
        // Storage unavailable: the collapse still applies for this session.
      }
      return next;
    });
  }

  const appSidebarMaximum = Math.max(
    PANEL_LAYOUT.appSidebar.min,
    Math.min(PANEL_LAYOUT.appSidebar.max, viewportWidth - 840),
  );
  const appSidebarWidth = clampPanelSize(
    appSidebarPreference,
    PANEL_LAYOUT.appSidebar.min,
    appSidebarMaximum,
  );

  return (
    <div
      ref={appRef}
      className="jimu-app"
      data-desktop={Boolean(globalThis.window.jimu) || undefined}
      data-collapsed={sidebarCollapsed || undefined}
      style={{ "--app-sidebar-width": `${appSidebarWidth}px` }}
    >
      <AppSidebar
        mode={mode}
        setMode={setMode}
        collapsed={sidebarCollapsed}
        onToggleCollapse={toggleSidebar}
        modules={modules}
        resizeHandle={!sidebarCollapsed ? (
          <PanelResizeHandle
            className="app-sidebar-resizer"
            label="调整主导航宽度"
            controls="jimu-main-navigation jimu-main-content"
            size={appSidebarWidth}
            minimum={PANEL_LAYOUT.appSidebar.min}
            maximum={appSidebarMaximum}
            defaultSize={PANEL_LAYOUT.appSidebar.defaultSize}
            onChange={setAppSidebarPreference}
          />
        ) : null}
      />
      <section id="jimu-main-content" className="app-main">
        <AppHeader mode={mode} />
        <div className="app-content">
          {mode === "knowledge" && (
            <KnowledgeScreen
              indexState={indexState}
              section={knowledgeSection}
              setSection={setKnowledgeSection}
              openRequest={openRequest}
              onGoAgent={() => openAgent()}
              onSearch={() => setSearchOpen(true)}
              onReload={loadKnowledge}
              modules={modules}
            />
          )}
          {mode === "factory" && indexState.phase !== "ready" && (
            <KnowledgeSetupPanel setup={indexState.setup} onReady={loadKnowledge} onSkip={() => openAgent()} context="factory" />
          )}
          {mode === "factory" && indexState.phase === "ready" && (
            <FactoryScreen
              indexData={indexState.data}
              harnessApi={harnessApi}
              onGoAgent={openAgent}
            />
          )}
          {mode === "agent" && <AgentScreen onOpenSettings={() => setMode("settings")} openSessionRequest={agentOpenRequest} defaultProjectPath={onboarding.knowledge.root} />}
          {mode === "usage" && <UsageScreen harnessApi={harnessApi} onOpenSession={openAgent} />}
          {mode === "settings" && <SettingsScreen onboarding={onboarding} onOnboardingChange={onOnboardingChange} />}
        </div>
      </section>
      {searchOpen && indexState.phase === "ready" && indexState.data && (
        <SearchOverlay indexData={indexState.data} onClose={() => setSearchOpen(false)} onOpen={openSearchResult} />
      )}
    </div>
  );
}

export function App() {
  const desktop = Boolean(globalThis.window.jimu?.onboarding);
  const [onboarding, setOnboarding] = useState(null);
  const [error, setError] = useState("");

  useEffect(() => {
    if (!desktop) return undefined;
    let active = true;
    void globalThis.window.jimu.onboarding.snapshot().then((snapshot) => {
      if (active) setOnboarding(snapshot);
    }).catch((caught) => {
      if (active) setError(caught instanceof Error ? caught.message : String(caught));
    });
    const unsubscribe = globalThis.window.jimu.onboarding.subscribe((snapshot) => {
      if (active) setOnboarding(snapshot);
    });
    return () => {
      active = false;
      unsubscribe();
    };
  }, [desktop]);

  if (!desktop) {
    const preview = {
      revision: "preview",
      completed: true,
      phase: "complete",
      modules: {
        benchmarks: { enabled: true, installed: false },
        factory: { enabled: true, installed: false },
      },
      knowledge: { phase: "unconfigured" },
      credential: { configured: false, writable: false, tested: false },
    };
    return <MainApp onboarding={preview} onOnboardingChange={() => {}} />;
  }
  if (!onboarding) {
    return (
      <main className="onboarding-page onboarding-loading">
        <span className="index-loader" />
        <h1>正在启动 JiMu</h1>
        <p>{error || "正在连接本地 Harness 与知识库服务…"}</p>
      </main>
    );
  }
  if (!onboarding.completed) return <OnboardingScreen snapshot={onboarding} onChange={setOnboarding} />;
  return <MainApp onboarding={onboarding} onOnboardingChange={setOnboarding} />;
}
