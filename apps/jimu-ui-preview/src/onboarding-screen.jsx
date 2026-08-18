import { useEffect, useState } from "react";
import {
  ArrowLeft,
  ArrowUpRight,
  BookOpenText,
  Check,
  CursorClick,
  DownloadSimple,
  Factory,
  FolderOpen,
  Key,
  LockSimple,
  ShieldCheck,
  UsersThree,
  X,
} from "@phosphor-icons/react";

const MODULE_COPY = {
  benchmarks: {
    title: "对标博主库",
    directory: "07-对标博主库",
    description: "整理公开账号、笔记数据和可追溯拆解。关闭后不创建、不扫描，也不会显示知识库分类。",
    icon: UsersThree,
  },
  factory: {
    title: "自媒体工厂",
    directory: "08-自媒体工厂",
    description: "启用灵感、选题、内容、素材、视频流水线与发布数据。关闭后不启动工厂服务。",
    icon: Factory,
  },
};

const PHASE_STEPS = [
  { id: "features", number: "01", label: "选择能力" },
  { id: "knowledge", number: "02", label: "安装知识库" },
  { id: "credential", number: "03", label: "连接 DeepSeek" },
];

function activeStep(phase) {
  if (phase === "testing") return "credential";
  if (phase === "complete") return "credential";
  return phase;
}

export function OnboardingScreen({ snapshot, onChange }) {
  const [modules, setModules] = useState({ benchmarks: true, factory: true });
  const [busy, setBusy] = useState("");
  const [error, setError] = useState("");
  const [apiKey, setApiKey] = useState("");
  const [existing, setExisting] = useState(null);
  const [moduleConfirmation, setModuleConfirmation] = useState(null);
  const [visibleStep, setVisibleStep] = useState(null);

  useEffect(() => {
    if (!snapshot?.modules) return;
    setModules({
      benchmarks: snapshot.modules.benchmarks.enabled,
      factory: snapshot.modules.factory.enabled,
    });
  }, [snapshot?.modules?.benchmarks?.enabled, snapshot?.modules?.factory?.enabled]);

  async function run(name, operation, onSuccess) {
    if (busy) return;
    setBusy(name);
    setError("");
    try {
      const next = await operation();
      if (next) {
        onSuccess?.(next);
        onChange(next);
      }
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : String(caught));
    } finally {
      setBusy("");
    }
  }

  function saveModules(selection) {
    void run("modules", async () => {
      if (snapshot.knowledge.phase === "ready") {
        const next = await globalThis.window.jimu.onboarding.updateModules({
          revision: snapshot.revision,
          modules: selection,
          confirmCreate: false,
        });
        if (next.requiresConfirmation) {
          setModuleConfirmation({ selection, missingModules: next.missingModules ?? [] });
          return null;
        }
        return next;
      }
      return globalThis.window.jimu.onboarding.setModules({
        revision: snapshot.revision,
        modules: selection,
      });
    }, () => {
      setModuleConfirmation(null);
      setVisibleStep(null);
    });
  }

  function confirmModules() {
    if (!moduleConfirmation) return;
    void run("modules-confirm", () => globalThis.window.jimu.onboarding.updateModules({
      revision: snapshot.revision,
      modules: moduleConfirmation.selection,
      confirmCreate: true,
    }), () => {
      setModuleConfirmation(null);
      setVisibleStep(null);
    });
  }

  function installDefault() {
    void run("install", () => globalThis.window.jimu.onboarding.installDefault({ revision: snapshot.revision }));
  }

  function chooseExisting() {
    void run("existing", async () => {
      const result = await globalThis.window.jimu.onboarding.previewExisting({ revision: snapshot.revision });
      if (result.canceled) return null;
      if (result.accepted === false) throw new Error(result.setup?.error ?? "所选目录不是兼容的 JiMu 知识库。");
      setExisting(result);
      if (result.requiresConfirmation) return null;
      return await globalThis.window.jimu.onboarding.applyExisting({
        revision: snapshot.revision,
        token: result.token,
        confirmCreate: false,
      });
    });
  }

  function confirmExisting() {
    void run("existing-confirm", async () => {
      const next = await globalThis.window.jimu.onboarding.applyExisting({
        revision: snapshot.revision,
        token: existing.token,
        confirmCreate: true,
      });
      setExisting(null);
      return next;
    });
  }

  function testCredential() {
    void run("credential", async () => {
      const next = await globalThis.window.jimu.onboarding.testAndSaveDeepSeek({
        revision: snapshot.revision,
        ...(apiKey.trim() ? { apiKey: apiKey.trim() } : {}),
      });
      setApiKey("");
      return next;
    });
  }

  function openRepository() {
    void globalThis.window.jimu.shell.openExternal("https://github.com/i-YOLO/JiMu-Knowledge");
  }

  function openKeyPage() {
    void globalThis.window.jimu.shell.openExternal("https://platform.deepseek.com/api_keys");
  }

  const phase = snapshot?.phase ?? "features";
  const serverStep = activeStep(phase);
  const current = visibleStep ?? serverStep;
  const knowledgeReady = snapshot?.knowledge?.phase === "ready";
  const operationError = error || snapshot?.knowledge?.error || snapshot?.credential?.error;
  const sourceLabel = snapshot?.knowledge?.source === "github-release"
    ? "GitHub Release"
    : snapshot?.knowledge?.source === "bundled-fallback"
      ? "安装包内置副本"
      : snapshot?.knowledge?.source === "existing"
        ? "已有知识库"
        : "尚未安装";

  return (
    <main className="onboarding-page">
      <header className="onboarding-brand">
        <span className="onboarding-logo"><img src="/assets/jimu-icon.png" alt="JiMu" /></span>
        <span><strong>JiMu</strong><small>HARNESS / FIRST RUN</small></span>
      </header>

      <nav className="onboarding-progress" aria-label="首次配置进度">
        {PHASE_STEPS.map((step, index) => {
          const activeIndex = PHASE_STEPS.findIndex((item) => item.id === current);
          const completed = index < activeIndex;
          return (
            <span key={step.id} data-active={step.id === current || undefined} data-complete={completed || undefined}>
              <em>{completed ? <Check size={15} weight="bold" /> : step.number}</em>
              <strong>{step.label}</strong>
            </span>
          );
        })}
      </nav>

      <section className="onboarding-card" data-phase={current} aria-live="polite">
        {current !== "features" && (
          <button
            className="onboarding-back"
            type="button"
            disabled={Boolean(busy) || phase === "testing"}
            onClick={() => {
              setError("");
              setExisting(null);
              setModuleConfirmation(null);
              setVisibleStep(current === "credential" ? "knowledge" : "features");
            }}
          >
            <ArrowLeft size={17} weight="bold" />返回上一步
          </button>
        )}
        {current === "features" && (
          <>
            <div className="onboarding-heading">
              <span>01 / OPTIONAL MODULES</span>
              <h1>你需要哪些 JiMu 能力？</h1>
              <p>完整配置已经为你选好。你也可以关闭暂时用不到的模块，以后随时从设置中恢复。</p>
            </div>
            <div className="onboarding-choice-hint">
              <CursorClick size={19} weight="duotone" />
              <span><strong>点击下方能力卡片即可选择</strong><small>每张卡片都可以单独启用或关闭，右下角会显示当前状态。</small></span>
            </div>
            <div className="onboarding-modules">
              {Object.entries(MODULE_COPY).map(([id, item]) => {
                const Icon = item.icon;
                const enabled = modules[id];
                return (
                  <button
                    type="button"
                    key={id}
                    className="onboarding-module-card"
                    data-enabled={enabled || undefined}
                    role="switch"
                    aria-checked={enabled}
                    onClick={() => setModules((value) => ({ ...value, [id]: !value[id] }))}
                  >
                    <span className="onboarding-module-icon"><Icon size={26} weight="duotone" /></span>
                    <span><small>{item.directory}</small><strong>{item.title}</strong><p>{item.description}</p></span>
                    <i>{enabled ? "已启用" : "按需关闭"}</i>
                  </button>
                );
              })}
            </div>
            {moduleConfirmation && (
              <div className="onboarding-confirm">
                <ShieldCheck size={20} weight="duotone" />
                <span><strong>创建新启用模块的空目录？</strong><p>{moduleConfirmation.missingModules.map((id) => MODULE_COPY[id].directory).join("、")}</p></span>
                <button type="button" onClick={() => setModuleConfirmation(null)}>取消</button>
                <button type="button" onClick={confirmModules}>确认并继续</button>
              </div>
            )}
            <div className="onboarding-actions">
              <button className="primary-action" type="button" disabled={Boolean(busy)} onClick={() => saveModules({ benchmarks: true, factory: true })}>
                <Check size={17} weight="bold" />使用完整默认配置
              </button>
              <button className="secondary-action" type="button" disabled={Boolean(busy)} onClick={() => saveModules(modules)}>
                按当前选择继续
              </button>
            </div>
          </>
        )}

        {current === "knowledge" && (
          <>
            <div className="onboarding-heading">
              <span>02 / LOCAL KNOWLEDGE</span>
              <h1>安装你的本地知识库</h1>
              <p>一键下载经过锁定和校验的 JiMu-Knowledge。GitHub 不可用时会自动改用应用内置副本。</p>
            </div>
            <div className="onboarding-install-summary">
              <BookOpenText size={30} weight="duotone" />
              <span><small>目标目录</small><strong>{snapshot.knowledge.root ?? "JiMu-Knowledge（默认位置）"}</strong><em>来源：{sourceLabel}</em></span>
              <span className="onboarding-module-pills">
                {snapshot.modules.benchmarks.enabled && <i>对标博主库</i>}
                {snapshot.modules.factory.enabled && <i>自媒体工厂</i>}
                {!snapshot.modules.benchmarks.enabled && !snapshot.modules.factory.enabled && <i>核心知识库</i>}
              </span>
            </div>
            {["downloading", "verifying", "installing", "indexing"].includes(snapshot.knowledge.phase) && (
              <div className="onboarding-install-progress">
                <span style={{ width: `${snapshot.knowledge.progress ?? 10}%` }} />
                <strong>{snapshot.knowledge.phase === "downloading" ? "正在下载" : snapshot.knowledge.phase === "verifying" ? "正在校验" : snapshot.knowledge.phase === "installing" ? "正在创建目录" : "正在建立索引"}</strong>
              </div>
            )}
            {existing?.requiresConfirmation && (
              <div className="onboarding-confirm">
                <ShieldCheck size={20} weight="duotone" />
                <span><strong>补齐所选模块的空目录？</strong><p>{existing.missingModules.map((id) => MODULE_COPY[id].directory).join("、")}</p></span>
                <button type="button" onClick={() => setExisting(null)}>取消</button>
                <button type="button" onClick={confirmExisting}>确认并连接</button>
              </div>
            )}
            <div className="onboarding-actions">
              <button
                className="primary-action"
                type="button"
                disabled={Boolean(busy)}
                onClick={knowledgeReady ? () => setVisibleStep(null) : installDefault}
              >
                {knowledgeReady ? <Check size={18} weight="bold" /> : <DownloadSimple size={18} weight="bold" />}
                {knowledgeReady ? "知识库已就绪，继续连接 DeepSeek" : busy === "install" ? "正在准备…" : "一键安装默认知识库"}
              </button>
              <button className="secondary-action" type="button" disabled={Boolean(busy)} onClick={chooseExisting}>
                <FolderOpen size={18} weight="duotone" />{busy === "existing" ? "正在检查…" : "选择已有知识库"}
              </button>
              <button className="text-action" type="button" onClick={openRepository}>查看仓库<ArrowUpRight size={14} weight="bold" /></button>
            </div>
            {snapshot.knowledge.source === "bundled-fallback" && <p className="onboarding-fallback"><ShieldCheck size={15} weight="fill" />GitHub 暂不可用，已自动切换到安装包内置 v1.0.1。</p>}
          </>
        )}

        {current === "credential" && (
          <>
            <div className="onboarding-heading">
              <span>03 / DEEPSEEK CONNECTION</span>
              <h1>连接 DeepSeek，开始使用 JiMu</h1>
              <p>Agent 需要有效的 DeepSeek API Key。JiMu 会先验证连接，成功后才写入 Harness 凭据存储。</p>
            </div>
            <div className="onboarding-credential-card">
              <span className="credential-lock"><LockSimple size={28} weight="duotone" /></span>
              <label>
                <span>DEEPSEEK_API_KEY</span>
                <input
                  type="password"
                  autoComplete="off"
                  value={apiKey}
                  disabled={!snapshot.credential.writable || phase === "testing"}
                  onChange={(event) => setApiKey(event.target.value)}
                  placeholder={snapshot.credential.configured ? "已配置 · 直接测试连接" : "输入你的 DeepSeek API Key"}
                />
              </label>
              <span className="credential-state" data-configured={snapshot.credential.configured || undefined}>
                {snapshot.credential.configured ? `已配置${snapshot.credential.source ? ` · ${snapshot.credential.source}` : ""}` : "尚未配置"}
              </span>
            </div>
            <div className="onboarding-security-note">
              <ShieldCheck size={19} weight="fill" />
              <span><strong>验证不会发送聊天内容，也不会消耗生成 Token</strong><small>只调用 DeepSeek 的模型列表接口；Key 不回显、不进入日志和知识库。</small></span>
            </div>
            <div className="onboarding-actions">
              <button className="primary-action" type="button" disabled={Boolean(busy) || phase === "testing" || (!apiKey.trim() && !snapshot.credential.configured)} onClick={testCredential}>
                <Key size={18} weight="fill" />{phase === "testing" || busy === "credential" ? "正在测试连接…" : "测试并进入 JiMu"}
              </button>
              <button className="secondary-action" type="button" onClick={openKeyPage}>获取 DeepSeek API Key<ArrowUpRight size={14} weight="bold" /></button>
            </div>
          </>
        )}

        {operationError && <div className="onboarding-error"><X size={18} weight="bold" /><span>{operationError}</span></div>}
      </section>

      <footer className="onboarding-footer">
        <span><ShieldCheck size={14} weight="fill" />本地优先 · 无演示数据 · 不扫描用户主目录</span>
        <small>JIMU / DESKTOP 0.1</small>
      </footer>
    </main>
  );
}
