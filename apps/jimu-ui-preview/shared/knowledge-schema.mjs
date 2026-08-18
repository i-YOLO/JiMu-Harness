export const JIMU_KNOWLEDGE_SCHEMA_VERSION = 1;
export const JIMU_KNOWLEDGE_TEMPLATE_VERSION = "1.0.1";
export const JIMU_MINIMUM_HARNESS_VERSION = "0.1.0";
export const JIMU_KNOWLEDGE_REPOSITORY_URL = "https://github.com/i-YOLO/JiMu-Knowledge";

export const KNOWLEDGE_CATEGORIES = Object.freeze([
  { id: "inbox", label: "项目灵感", directory: "01-Inbox", behavior: "card", type: "Inspiration", stage: "inspiration", accent: "yellow", eyebrow: "INSPIRATION / INBOX" },
  { id: "projects", label: "项目", directory: "02-Projects", behavior: "project-directory", type: "Project", stage: "execution", accent: "teal", eyebrow: "PROJECT / WORKSPACE" },
  { id: "knowledge", label: "知识", directory: "03-Knowledge", behavior: "card", type: "KnowledgeCard", stage: "knowledge", accent: "cobalt", eyebrow: "KNOWLEDGE / CARD" },
  { id: "content", label: "内容", directory: "04-Content", behavior: "card", type: "Content", stage: "output", accent: "magenta", eyebrow: "CONTENT / ASSET" },
  { id: "prompts", label: "提示词", directory: "05-Prompts", behavior: "card", type: "Prompt", stage: "method", accent: "cobalt", eyebrow: "PROMPT / REUSABLE" },
  { id: "business", label: "商业", directory: "06-Business", behavior: "card", type: "Business", stage: "decision", accent: "yellow", eyebrow: "BUSINESS / DECISION" },
  { id: "benchmarks", label: "对标博主", directory: "07-对标博主库", behavior: "benchmark-profile", type: "BenchmarkMaterial", stage: "research", accent: "magenta", eyebrow: "BENCHMARK / MATERIAL" },
  { id: "skills", label: "Skills", directory: "98-Skills", behavior: "skill-directory", type: "Skill", stage: "method", accent: "teal", eyebrow: "SKILL / RUNTIME" },
]);

export const KNOWLEDGE_CATEGORY_IDS = Object.freeze(KNOWLEDGE_CATEGORIES.map((category) => category.id));

export const KNOWLEDGE_OPTIONAL_MODULES = Object.freeze({
  benchmarks: Object.freeze({
    directory: "07-对标博主库",
    category: "benchmarks",
    defaultEnabled: true,
  }),
  factory: Object.freeze({
    directory: "08-自媒体工厂",
    defaultEnabled: true,
  }),
});

export const KNOWLEDGE_MODULE_IDS = Object.freeze(Object.keys(KNOWLEDGE_OPTIONAL_MODULES));

export const KNOWLEDGE_AUXILIARY_CATEGORIES = Object.freeze([
  { id: "factory", label: "自媒体工厂", directory: "08-自媒体工厂", type: "FactoryRecord", stage: "production", accent: "magenta", eyebrow: "SELF-MEDIA / FACTORY" },
  { id: "system", label: "系统", directory: "00-System", type: "System", stage: "system", accent: "cobalt", eyebrow: "SYSTEM / CONTROL" },
  { id: "archive", label: "归档", directory: "90-Archive", type: "Archive", stage: "archive", accent: "yellow", eyebrow: "ARCHIVE / HISTORICAL" },
  { id: "logs", label: "日志", directory: "99-Logs", type: "Log", stage: "execution", accent: "teal", eyebrow: "LOG / TRACE" },
  { id: "other", label: "其他", directory: "ROOT", type: "Document", stage: "reference", accent: "cobalt", eyebrow: "DOCUMENT / REFERENCE" },
]);

export const KNOWLEDGE_CORE_DIRECTORIES = Object.freeze([
  "00-System",
  ...KNOWLEDGE_CATEGORIES
    .filter((category) => category.id !== "benchmarks")
    .map((category) => category.directory),
  "90-Archive",
  "99-Logs",
  "assets",
]);

export const KNOWLEDGE_STANDARD_DIRECTORIES = Object.freeze([
  ...KNOWLEDGE_CORE_DIRECTORIES,
  ...KNOWLEDGE_MODULE_IDS.map((id) => KNOWLEDGE_OPTIONAL_MODULES[id].directory),
]);

export const KNOWLEDGE_FACTORY_LEAF_DIRECTORIES = Object.freeze([
  "08-自媒体工厂/01-灵感与调研/01-灵感箱",
  "08-自媒体工厂/01-灵感与调研/02-对标拆解",
  "08-自媒体工厂/01-灵感与调研/03-选题候选",
  "08-自媒体工厂/02-文案与内容/内容项目",
  "08-自媒体工厂/03-素材库/01-图片与配图",
  "08-自媒体工厂/03-素材库/02-B-roll",
  "08-自媒体工厂/03-素材库/03-完整场景",
  "08-自媒体工厂/03-素材库/04-文字与图形动效",
  "08-自媒体工厂/03-素材库/05-Jimu角色",
  "08-自媒体工厂/03-素材库/06-封面",
  "08-自媒体工厂/03-素材库/07-音频",
  "08-自媒体工厂/03-素材库/08-PR与RAW场景",
  "08-自媒体工厂/04-视频流水线",
  "08-自媒体工厂/05-发布与数据/01-内容档案",
  "08-自媒体工厂/05-发布与数据/02-数据导入",
  "08-自媒体工厂/05-发布与数据/03-数据快照",
  "08-自媒体工厂/05-发布与数据/04-复盘沉淀",
]);

export const KNOWLEDGE_TEMPLATE_DIRECTORIES = Object.freeze([
  ...KNOWLEDGE_STANDARD_DIRECTORIES,
  ...KNOWLEDGE_FACTORY_LEAF_DIRECTORIES,
]);

function parseVersion(value) {
  if (typeof value !== "string") return null;
  const match = /^(\d+)\.(\d+)\.(\d+)$/.exec(value);
  return match ? match.slice(1).map(Number) : null;
}

function compareVersion(left, right) {
  for (let index = 0; index < 3; index += 1) {
    if (left[index] !== right[index]) return left[index] - right[index];
  }
  return 0;
}

export function validateKnowledgeManifest(value) {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return { ok: false, error: "知识库 Manifest 不是对象。" };
  if (!Number.isInteger(value.schemaVersion)) return { ok: false, error: "知识库 Manifest 缺少 schemaVersion。" };
  if (value.schemaVersion > JIMU_KNOWLEDGE_SCHEMA_VERSION) return { ok: false, error: "知识库版本高于当前 JiMu 支持范围。", futureSchema: true };
  if (value.schemaVersion !== JIMU_KNOWLEDGE_SCHEMA_VERSION) return { ok: false, error: "知识库 schemaVersion 不受支持。" };
  if (!parseVersion(value.templateVersion)) return { ok: false, error: "知识库 Manifest 的 templateVersion 无效。" };
  if (typeof value.name !== "string" || !value.name.trim()) return { ok: false, error: "知识库 Manifest 缺少名称。" };
  const minimumHarnessVersion = parseVersion(value.minimumHarnessVersion);
  const currentHarnessVersion = parseVersion(JIMU_MINIMUM_HARNESS_VERSION);
  if (!minimumHarnessVersion || !currentHarnessVersion) return { ok: false, error: "知识库 Manifest 的 minimumHarnessVersion 无效。" };
  if (compareVersion(minimumHarnessVersion, currentHarnessVersion) > 0) return { ok: false, error: "知识库需要更高版本的 JiMu Harness。", futureHarness: true };
  if (value.repositoryUrl !== JIMU_KNOWLEDGE_REPOSITORY_URL) return { ok: false, error: "知识库 Manifest 的仓库地址不受支持。" };
  if (JSON.stringify(value.categories) !== JSON.stringify(KNOWLEDGE_CATEGORY_IDS)) return { ok: false, error: "知识库分类与 Schema 1 不一致。" };
  if (JSON.stringify(value.optionalModules) !== JSON.stringify(KNOWLEDGE_OPTIONAL_MODULES)) return { ok: false, error: "知识库按需模块与 Schema 1 不一致。" };
  return { ok: true, manifest: value };
}
