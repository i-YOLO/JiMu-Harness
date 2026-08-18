import { createHash } from "node:crypto";
import { existsSync, watch } from "node:fs";
import {
  copyFile,
  lstat,
  mkdir,
  opendir,
  readFile,
  realpath,
  rename,
  stat,
  writeFile,
} from "node:fs/promises";
import path from "node:path";

export const FACTORY_DIRECTORY = "08-自媒体工厂";
export const DEFAULT_FACTORY_KNOWLEDGE_ROOT = process.env.JIMU_KNOWLEDGE_ROOT;

const ASSET_CATEGORY_DIRECTORIES = {
  image: "01-图片与配图",
  video: "02-B-roll",
  broll: "02-B-roll",
  scene: "03-完整场景",
  motion: "04-文字与图形动效",
  character: "05-Jimu角色",
  cover: "06-封面",
  audio: "07-音频",
  raw: "08-PR与RAW场景",
  project: "08-PR与RAW场景",
};

const IMAGE_EXTENSIONS = new Set([".avif", ".gif", ".jpeg", ".jpg", ".png", ".svg", ".webp"]);
const VIDEO_EXTENSIONS = new Set([".m2ts", ".m4v", ".mkv", ".mov", ".mp4", ".mts", ".mxf", ".webm"]);
const AUDIO_EXTENSIONS = new Set([".aac", ".flac", ".m4a", ".mp3", ".ogg", ".wav"]);
const RAW_EXTENSIONS = new Set([".ari", ".braw", ".crm", ".r3d"]);
const PROJECT_EXTENSIONS = new Set([".aep", ".drp", ".mogrt", ".prproj"]);
const ASSET_EXTENSIONS = new Set([...IMAGE_EXTENSIONS, ...VIDEO_EXTENSIONS, ...AUDIO_EXTENSIONS, ...RAW_EXTENSIONS, ...PROJECT_EXTENSIONS]);
const SAFE_ID_PATTERN = /^[A-Za-z0-9._:-]{4,160}$/;

const PIPELINE_STAGES = [
  { id: "capture", number: "01", title: "灵感捕捉", section: "inspiration", input: "个人想法、公开来源", action: "记录来源与值得继续验证的问题", output: "可追溯灵感" },
  { id: "research", number: "02", title: "对标调研", section: "inspiration", input: "博主档案与真实拆解", action: "提取可迁移机制和证据边界", output: "调研结论" },
  { id: "topic", number: "03", title: "选题立项", section: "inspiration", input: "灵感与调研结论", action: "人工确认内容承诺和验证方式", output: "已立项选题" },
  { id: "agent", number: "04", title: "Agent 共创", section: "content", input: "选题、资料与目标受众", action: "使用 Harness 会话多轮讨论", output: "观点与结构" },
  { id: "script", number: "05", title: "人工定稿", section: "content", input: "Agent 草稿与人工反馈", action: "版本化修改并人工审核", output: "已定稿文案" },
  { id: "assets", number: "06", title: "素材准备", section: "assets", input: "定稿文案与镜头需求", action: "检索、预览和确认可用素材", output: "素材清单" },
  { id: "video", number: "07", title: "视频流水线", section: "pipeline", input: "定稿文案与素材清单", action: "流程已展示，执行能力规划中", output: "预览、审核与成片", planned: true },
  { id: "publish", number: "08", title: "发布归档", section: "data", input: "验收成片与发布信息", action: "登记平台、链接和内容资产", output: "发布档案" },
  { id: "metrics", number: "09", title: "数据分析", section: "data", input: "手填或 CSV 数据快照", action: "比较真实历史快照", output: "趋势与变化" },
  { id: "review", number: "10", title: "复盘沉淀", section: "data", input: "内容表现和执行反馈", action: "压缩长期可复用结论", output: "复盘卡片" },
];

function stableId(value) {
  return createHash("sha1").update(value).digest("hex").slice(0, 20);
}

function isInside(root, candidate) {
  const relativePath = path.relative(root, candidate);
  return relativePath === "" || (!relativePath.startsWith(`..${path.sep}`) && relativePath !== ".." && !path.isAbsolute(relativePath));
}

function normalizeRelative(value) {
  return String(value ?? "").split(path.sep).join("/").replace(/^\/+/, "");
}

function safeText(value, field, maximum = 20_000) {
  if (typeof value !== "string") throw new Error(`${field} 必须是文本。`);
  const trimmed = value.trim();
  if (!trimmed) throw new Error(`${field} 不能为空。`);
  if (trimmed.length > maximum) throw new Error(`${field} 过长。`);
  return trimmed;
}

function optionalText(value, maximum = 20_000) {
  if (value === null || value === undefined) return "";
  if (typeof value !== "string") throw new Error("JiMu 收到了无效文本字段。");
  return value.trim().slice(0, maximum);
}

function slugify(value) {
  const slug = String(value)
    .normalize("NFKC")
    .replace(/[\\/:*?"<>|#\[\]]+/g, "-")
    .replace(/\s+/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-|-$/g, "")
    .slice(0, 72);
  return slug || "未命名";
}

function parseScalar(value) {
  const trimmed = value.trim();
  if ((trimmed.startsWith('"') && trimmed.endsWith('"')) || (trimmed.startsWith("'") && trimmed.endsWith("'"))) return trimmed.slice(1, -1);
  if (trimmed === "true") return true;
  if (trimmed === "false") return false;
  if (trimmed === "null") return null;
  if (/^-?\d+(?:\.\d+)?$/.test(trimmed)) return Number(trimmed);
  if (trimmed.startsWith("[") && trimmed.endsWith("]")) {
    return trimmed.slice(1, -1).split(/[,，]/).map((item) => item.trim()).filter(Boolean).map((item) => parseScalar(item));
  }
  return trimmed;
}

function parseFrontmatter(markdown) {
  if (!markdown.startsWith("---\n") && !markdown.startsWith("---\r\n")) return { attributes: {}, body: markdown };
  const lines = markdown.split(/\r?\n/);
  const end = lines.slice(1).findIndex((line) => line.trim() === "---");
  if (end < 0) return { attributes: {}, body: markdown };
  const attributes = {};
  for (const line of lines.slice(1, end + 1)) {
    const match = line.match(/^([A-Za-z0-9_-]+):\s*(.*)$/);
    if (match) attributes[match[1]] = parseScalar(match[2]);
  }
  return { attributes, body: lines.slice(end + 2).join("\n").trim() };
}

function frontmatterValue(value) {
  if (Array.isArray(value)) return `[${value.map((item) => JSON.stringify(String(item))).join(", ")}]`;
  if (value === null) return "null";
  if (typeof value === "number" || typeof value === "boolean") return String(value);
  return JSON.stringify(String(value ?? ""));
}

function stringifyMarkdown(attributes, body) {
  const fields = Object.entries(attributes).filter(([, value]) => value !== undefined && value !== "");
  return `---\n${fields.map(([key, value]) => `${key}: ${frontmatterValue(value)}`).join("\n")}\n---\n\n${body.trim()}\n`;
}

async function atomicWrite(file, content) {
  await mkdir(path.dirname(file), { recursive: true });
  const temporary = `${file}.${process.pid}.${Date.now()}.tmp`;
  await writeFile(temporary, content, { encoding: "utf8", mode: 0o600 });
  await rename(temporary, file);
}

async function listFiles(root, predicate) {
  const files = [];
  async function visit(directory) {
    const handle = await opendir(directory);
    for await (const entry of handle) {
      if (entry.name.startsWith(".") || entry.isSymbolicLink()) continue;
      const absolute = path.join(directory, entry.name);
      if (entry.isDirectory()) await visit(absolute);
      else if (entry.isFile() && predicate(absolute)) files.push(absolute);
    }
  }
  await visit(root);
  return files.sort((left, right) => left.localeCompare(right, "zh-CN", { numeric: true }));
}

async function listDirectories(root) {
  const directories = [root];
  async function visit(directory) {
    const handle = await opendir(directory);
    for await (const entry of handle) {
      if (entry.name.startsWith(".") || entry.isSymbolicLink() || !entry.isDirectory()) continue;
      const absolute = path.join(directory, entry.name);
      directories.push(absolute);
      await visit(absolute);
    }
  }
  await visit(root);
  return directories.sort((left, right) => left.localeCompare(right, "zh-CN", { numeric: true }));
}

function assetUrl(relativePath) {
  return `jimu-asset://local/${Buffer.from(relativePath, "utf8").toString("base64url")}`;
}

function assetKind(relativePath, extension) {
  if (AUDIO_EXTENSIONS.has(extension)) return "audio";
  if (PROJECT_EXTENSIONS.has(extension)) return "project";
  if (RAW_EXTENSIONS.has(extension) || relativePath.includes("08-PR与RAW场景")) return "raw";
  if (/\/(?:ip\/jimu(?:-motion-v1)?|jimu角色)(?:\/|$)/i.test(relativePath)) return "character";
  if (/\/(?:covers?|封面)(?:\/|$)/i.test(relativePath) || /(?:cover|封面)/i.test(path.basename(relativePath))) return "cover";
  if (VIDEO_EXTENSIONS.has(extension)) return relativePath.includes("03-完整场景") ? "scene" : relativePath.includes("04-文字与图形动效") ? "motion" : "video";
  if (relativePath.includes("05-Jimu角色")) return "character";
  if (relativePath.includes("06-封面")) return "cover";
  return "image";
}

function buildAssetDirectoryTree(knowledgeRoot, assetRoot, directories, assets) {
  const rootSourcePath = normalizeRelative(path.relative(knowledgeRoot, assetRoot));
  const nodes = new Map();
  nodes.set(rootSourcePath, {
    stableId: `asset-directory-${stableId(rootSourcePath)}`,
    name: "素材库",
    sourcePath: rootSourcePath,
    directAssets: 0,
    totalAssets: 0,
    kinds: {},
    previewAsset: null,
    children: [],
  });
  for (const absolute of directories) {
    const sourcePath = normalizeRelative(path.relative(knowledgeRoot, absolute));
    if (nodes.has(sourcePath)) continue;
    nodes.set(sourcePath, {
      stableId: `asset-directory-${stableId(sourcePath)}`,
      name: path.basename(sourcePath),
      sourcePath,
      directAssets: 0,
      totalAssets: 0,
      kinds: {},
      previewAsset: null,
      children: [],
    });
  }
  for (const node of nodes.values()) {
    if (node.sourcePath === rootSourcePath) continue;
    const parent = nodes.get(normalizeRelative(path.posix.dirname(node.sourcePath)));
    if (parent) parent.children.push(node);
  }
  for (const asset of assets) {
    const directoryPath = normalizeRelative(path.posix.dirname(asset.sourcePath));
    const node = nodes.get(directoryPath);
    if (node) {
      node.directAssets += 1;
      node.kinds[asset.kind] = (node.kinds[asset.kind] ?? 0) + 1;
      const previewRank = (candidate) => {
        if (!candidate) return Number.POSITIVE_INFINITY;
        const namedPreview = /(?:预览|preview)/i.test(candidate.title) ? -10 : 0;
        return namedPreview + ({ video: 0, image: 1, audio: 2, file: 3 }[candidate.previewType] ?? 4);
      };
      if (previewRank(asset) < previewRank(node.previewAsset)) node.previewAsset = asset;
    }
  }
  function summarize(node) {
    node.children.sort((left, right) => left.name.localeCompare(right.name, "zh-CN", { numeric: true }));
    node.totalAssets = node.directAssets;
    for (const child of node.children) {
      summarize(child);
      node.totalAssets += child.totalAssets;
      for (const [kind, count] of Object.entries(child.kinds)) node.kinds[kind] = (node.kinds[kind] ?? 0) + count;
    }
    return node;
  }
  const root = summarize(nodes.get(rootSourcePath));

  // Keep the provenance-safe disk layout intact while removing migration-only
  // wrappers from the material browser. This is a view transformation: no
  // source asset moves and existing Markdown links keep working.
  function pruneEmptyDescendants(node, keepEmptyChildren = false) {
    for (const child of node.children) pruneEmptyDescendants(child, false);
    if (!keepEmptyChildren) node.children = node.children.filter((child) => child.totalAssets > 0);
    return node;
  }
  pruneEmptyDescendants(root, true);

  const broll = root.children.find((node) => node.sourcePath.endsWith("/02-B-roll"));
  const finalAssets = broll?.children
    .find((node) => node.name === "Jimu-B-roll-素材库")?.children
    .find((node) => node.name === "Jimu B-roll 素材库 V1")?.children
    .find((node) => node.name === "01-最终素材");
  if (broll && finalAssets) {
    broll.children = finalAssets.children.map((node) => {
      if (node.name === "01-无角色素材") {
        return {
          ...node,
          name: "01-无角色素材",
          aggregate: false,
          children: node.children.map((child) => {
            if (child.name === "01-基础试验") return { ...child, name: "01-通用基础元素" };
            if (child.name === "04-中型组合") return { ...child, name: "04-组合场景" };
            return child;
          }),
        };
      }
      if (node.name === "02-Jimu角色") return { ...node, name: "02-有角色素材", aggregate: false };
      return node;
    });
    broll.directAssets = 0;
    broll.totalAssets = broll.children.reduce((total, child) => total + child.totalAssets, 0);
    broll.kinds = {};
    for (const child of broll.children) {
      for (const [kind, count] of Object.entries(child.kinds)) broll.kinds[kind] = (broll.kinds[kind] ?? 0) + count;
    }
  }

  function markMotionGalleries(node) {
    for (const child of node.children) markMotionGalleries(child);
    const isMotionBranch = node.sourcePath.includes("/04-文字与图形动效/");
    const childrenAreMotionUnits = node.children.length > 0 && node.children.every((child) => (
      child.children.length === 0
      && child.previewAsset?.kind === "motion"
      && child.previewAsset.previewType === "video"
    ));
    if (isMotionBranch && childrenAreMotionUnits) node.viewMode = "motion-gallery";
  }
  markMotionGalleries(root);

  root.totalAssets = root.children.reduce((total, child) => total + child.totalAssets, 0);
  return root;
}

function isVisibleAsset(asset) {
  // Historical article illustrations remain on disk for link safety, but stay
  // outside the v1 production-material view until the user decides whether to
  // archive or remove them.
  if (asset.sourcePath.includes("/01-图片与配图/知识库内容素材/")) return false;
  // Contact sheets are navigation aids rather than reusable B-roll clips.
  if (asset.sourcePath.includes("/02-B-roll/") && asset.sourcePath.includes("/02-素材总览/")) return false;
  return true;
}

function assetStatus(relativePath) {
  if (/候选|candidate|draft|待确认/i.test(relativePath)) return "candidate";
  if (/最终|已确认|approved|project-proven|final/i.test(relativePath)) return "approved";
  return "library";
}

function cleanSegment(value) {
  return value.replace(/^\d+[-_.、]?/, "").replace(/[-_]+/g, " ").trim();
}

async function parseAsset(knowledgeRoot, absolutePath) {
  const resolved = await realpath(absolutePath);
  if (!isInside(knowledgeRoot, resolved)) throw new Error("素材路径越过知识库根目录。");
  const info = await stat(resolved);
  const relativePath = normalizeRelative(path.relative(knowledgeRoot, resolved));
  const extension = path.extname(resolved).toLocaleLowerCase("zh-CN");
  const folderTags = relativePath.split("/").slice(2, -1).map(cleanSegment).filter(Boolean);
  return {
    stableId: `asset-${stableId(relativePath)}`,
    title: cleanSegment(path.basename(relativePath, extension)),
    sourcePath: relativePath,
    assetUrl: assetUrl(relativePath),
    kind: assetKind(relativePath, extension),
    previewType: IMAGE_EXTENSIONS.has(extension) ? "image" : VIDEO_EXTENSIONS.has(extension) ? "video" : AUDIO_EXTENSIONS.has(extension) ? "audio" : "file",
    status: assetStatus(relativePath),
    extension: extension.slice(1).toLocaleUpperCase("en-US"),
    size: info.size,
    updatedAt: Math.round(info.mtimeMs),
    tags: [...new Set(folderTags.slice(-4))],
  };
}

async function parseFactoryRecord(knowledgeRoot, absolutePath) {
  const resolved = await realpath(absolutePath);
  if (!isInside(knowledgeRoot, resolved)) throw new Error("工厂文档越过知识库根目录。");
  const [markdown, info] = await Promise.all([readFile(resolved, "utf8"), stat(resolved)]);
  const { attributes, body } = parseFrontmatter(markdown);
  if (typeof attributes.jimuType !== "string") return null;
  const sourcePath = normalizeRelative(path.relative(knowledgeRoot, resolved));
  const requestedId = typeof attributes.stableId === "string" ? attributes.stableId : "";
  return {
    stableId: SAFE_ID_PATTERN.test(requestedId) ? requestedId : `factory-${stableId(sourcePath)}`,
    type: attributes.jimuType,
    title: typeof attributes.title === "string" && attributes.title ? attributes.title : cleanSegment(path.basename(sourcePath, ".md")),
    status: typeof attributes.status === "string" ? attributes.status : "captured",
    sourceType: typeof attributes.sourceType === "string" ? attributes.sourceType : "personal",
    sourcePath,
    referencePath: typeof attributes.referencePath === "string" ? attributes.referencePath : "",
    topicPath: typeof attributes.topicPath === "string" ? attributes.topicPath : "",
    contentId: typeof attributes.contentId === "string" ? attributes.contentId : "",
    publicationId: typeof attributes.publicationId === "string" ? attributes.publicationId : "",
    platform: typeof attributes.platform === "string" ? attributes.platform : "",
    account: typeof attributes.account === "string" ? attributes.account : "",
    url: typeof attributes.url === "string" ? attributes.url : "",
    publishedAt: typeof attributes.publishedAt === "string" ? attributes.publishedAt : "",
    capturedAt: typeof attributes.capturedAt === "string" ? attributes.capturedAt : "",
    agentWorkspaceId: typeof attributes.agentWorkspaceId === "string" ? attributes.agentWorkspaceId : "",
    agentSessionId: typeof attributes.agentSessionId === "string" ? attributes.agentSessionId : "",
    latestRevision: typeof attributes.latestRevision === "string" ? attributes.latestRevision : "",
    approvedRevision: typeof attributes.approvedRevision === "string" ? attributes.approvedRevision : "",
    tags: Array.isArray(attributes.tags) ? attributes.tags.map(String) : [],
    metrics: {
      views: typeof attributes.views === "number" ? attributes.views : null,
      likes: typeof attributes.likes === "number" ? attributes.likes : null,
      favorites: typeof attributes.favorites === "number" ? attributes.favorites : null,
      comments: typeof attributes.comments === "number" ? attributes.comments : null,
      shares: typeof attributes.shares === "number" ? attributes.shares : null,
      follows: typeof attributes.follows === "number" ? attributes.follows : null,
    },
    body,
    excerpt: body.replace(/^#+\s+/gm, "").replace(/\s+/g, " ").trim().slice(0, 220),
    updatedAt: Math.round(info.mtimeMs),
  };
}

async function nextNumber(directory) {
  let maximum = 0;
  const handle = await opendir(directory);
  for await (const entry of handle) {
    const match = entry.name.match(/^(\d{2})-/);
    if (match) maximum = Math.max(maximum, Number(match[1]));
  }
  return String(maximum + 1).padStart(2, "0");
}

function normalizedMetric(value) {
  if (value === "" || value === null || value === undefined) return null;
  const number = Number(String(value).replaceAll(",", "").trim());
  if (!Number.isFinite(number) || number < 0) throw new Error(`无效数据值：${value}`);
  return Math.round(number);
}

function parseCsv(text) {
  const rows = [];
  let row = [];
  let value = "";
  let quoted = false;
  for (let index = 0; index < text.length; index += 1) {
    const character = text[index];
    if (character === '"') {
      if (quoted && text[index + 1] === '"') {
        value += '"';
        index += 1;
      } else quoted = !quoted;
    } else if (character === "," && !quoted) {
      row.push(value.trim());
      value = "";
    } else if ((character === "\n" || character === "\r") && !quoted) {
      if (character === "\r" && text[index + 1] === "\n") index += 1;
      row.push(value.trim());
      value = "";
      if (row.some(Boolean)) rows.push(row);
      row = [];
    } else value += character;
  }
  row.push(value.trim());
  if (row.some(Boolean)) rows.push(row);
  if (rows.length < 2) return [];
  const headers = rows[0].map((item) => item.toLocaleLowerCase("zh-CN").replace(/\s+/g, ""));
  return rows.slice(1).map((cells) => Object.fromEntries(headers.map((header, index) => [header, cells[index] ?? ""])));
}

function csvValue(row, aliases) {
  for (const alias of aliases) {
    const key = alias.toLocaleLowerCase("zh-CN").replace(/\s+/g, "");
    if (row[key] !== undefined) return row[key];
  }
  return "";
}

function metricDelta(latest, previous) {
  const delta = {};
  for (const key of ["views", "likes", "favorites", "comments", "shares", "follows"]) {
    delta[key] = latest?.metrics[key] === null || previous?.metrics[key] === null || !previous
      ? null
      : latest.metrics[key] - previous.metrics[key];
  }
  return delta;
}

function buildPipeline(records) {
  const ideas = records.filter((item) => item.type === "Inspiration");
  const topics = records.filter((item) => item.type === "TopicCandidate");
  const content = records.filter((item) => item.type === "ContentProject");
  const publications = records.filter((item) => item.type === "Publication");
  const counts = {
    capture: ideas.length,
    research: ideas.filter((item) => item.sourceType === "benchmark").length,
    topic: topics.length,
    agent: content.filter((item) => item.agentSessionId).length,
    script: content.filter((item) => item.status === "script-approved").length,
    assets: content.filter((item) => item.status === "asset-ready").length,
    video: content.filter((item) => ["script-approved", "asset-ready"].includes(item.status)).length,
    publish: publications.length,
    metrics: records.filter((item) => item.type === "MetricSnapshot").length,
    review: records.filter((item) => item.type === "Review").length,
  };
  return PIPELINE_STAGES.map((stage) => ({ ...stage, count: counts[stage.id] ?? 0 }));
}

function buildAnalytics(publications, snapshots) {
  const byPublication = new Map();
  for (const snapshot of snapshots) {
    const group = byPublication.get(snapshot.publicationId) ?? [];
    group.push(snapshot);
    byPublication.set(snapshot.publicationId, group);
  }
  return publications.map((publication) => {
    const history = (byPublication.get(publication.stableId) ?? []).sort((left, right) => left.capturedAt.localeCompare(right.capturedAt));
    const latest = history.at(-1) ?? null;
    const previous = history.at(-2) ?? null;
    return {
      publicationId: publication.stableId,
      title: publication.title,
      platform: publication.platform,
      snapshots: history.length,
      latest,
      delta: metricDelta(latest, previous),
    };
  });
}

export class FactoryService {
  constructor({ root = DEFAULT_FACTORY_KNOWLEDGE_ROOT } = {}) {
    this.requestedRoot = root;
    this.root = null;
    this.factoryRoot = null;
    this.snapshot = null;
    this.assets = [];
    this.records = [];
    this.listeners = new Set();
    this.watcher = null;
    this.refreshTimer = null;
    this.refreshQueue = Promise.resolve();
  }

  async initialize() {
    if (typeof this.requestedRoot !== "string" || !this.requestedRoot) throw new Error("Knowledge root is not configured.");
    this.root = await realpath(this.requestedRoot);
    this.factoryRoot = path.join(this.root, FACTORY_DIRECTORY);
    await this.refresh();
    return this.getSnapshot();
  }

  async refresh() {
    if (!this.root || !this.factoryRoot) throw new Error("自媒体工厂尚未初始化。");
    const assetRoot = path.join(this.factoryRoot, "03-素材库");
    const factoryExists = existsSync(this.factoryRoot);
    const assetRootExists = existsSync(assetRoot);
    const [recordFiles, assetFiles, assetDirectories] = await Promise.all([
      factoryExists ? listFiles(this.factoryRoot, (file) => path.extname(file).toLocaleLowerCase("zh-CN") === ".md") : [],
      assetRootExists ? listFiles(assetRoot, (file) => ASSET_EXTENSIONS.has(path.extname(file).toLocaleLowerCase("zh-CN"))) : [],
      assetRootExists ? listDirectories(assetRoot) : [],
    ]);
    const [records, assets] = await Promise.all([
      Promise.all(recordFiles.map((file) => parseFactoryRecord(this.root, file))),
      Promise.all(assetFiles.map((file) => parseAsset(this.root, file))),
    ]);
    this.records = records.filter(Boolean);
    this.assets = assets
      .filter(isVisibleAsset)
      .sort((left, right) => right.updatedAt - left.updatedAt || left.sourcePath.localeCompare(right.sourcePath, "zh-CN", { numeric: true }));
    this.assetTree = buildAssetDirectoryTree(this.root, assetRoot, assetDirectories, this.assets);
    this.assetDirectoryPaths = new Set(assetDirectories.map((directory) => normalizeRelative(path.relative(this.root, directory))));
    const ideas = this.records.filter((item) => item.type === "Inspiration").sort((left, right) => right.updatedAt - left.updatedAt);
    const topics = this.records.filter((item) => item.type === "TopicCandidate").sort((left, right) => right.updatedAt - left.updatedAt);
    const content = this.records.filter((item) => item.type === "ContentProject").sort((left, right) => right.updatedAt - left.updatedAt);
    const publications = this.records.filter((item) => item.type === "Publication").sort((left, right) => right.updatedAt - left.updatedAt);
    const metricSnapshots = this.records.filter((item) => item.type === "MetricSnapshot").sort((left, right) => right.capturedAt.localeCompare(left.capturedAt));
    this.snapshot = {
      schemaVersion: 1,
      root: this.root,
      factoryRoot: this.factoryRoot,
      generatedAt: Date.now(),
      counts: {
        ideas: ideas.length,
        benchmarkIdeas: ideas.filter((item) => item.sourceType === "benchmark").length,
        topics: topics.length,
        content: content.length,
        approvedScripts: content.filter((item) => item.status === "script-approved").length,
        assets: this.assets.length,
        approvedAssets: this.assets.filter((item) => item.status === "approved").length,
        publications: publications.length,
        metricSnapshots: metricSnapshots.length,
      },
      ideas,
      topics,
      content,
      publications,
      metricSnapshots,
      analytics: buildAnalytics(publications, metricSnapshots),
      pipeline: buildPipeline(this.records),
      assets: {
        total: this.assets.length,
        tree: this.assetTree,
        recent: this.assets.slice(0, 8),
        types: Object.fromEntries([...new Set(this.assets.map((item) => item.kind))].map((kind) => [kind, this.assets.filter((item) => item.kind === kind).length])),
        statuses: Object.fromEntries([...new Set(this.assets.map((item) => item.status))].map((status) => [status, this.assets.filter((item) => item.status === status).length])),
      },
    };
    for (const listener of this.listeners) listener(this.snapshot);
    return this.snapshot;
  }

  getSnapshot() {
    if (!this.snapshot) throw new Error("自媒体工厂数据不可用。");
    return this.snapshot;
  }

  listAssets(value = {}) {
    const request = value && typeof value === "object" && !Array.isArray(value) ? value : {};
    const query = typeof request.query === "string" ? request.query.trim().toLocaleLowerCase("zh-CN") : "";
    const kind = typeof request.kind === "string" ? request.kind : "all";
    const status = typeof request.status === "string" ? request.status : "all";
    const sort = request.sort === "name" ? "name" : "recent";
    const directory = typeof request.directory === "string" ? normalizeRelative(request.directory) : "";
    const recursive = request.recursive === true;
    if (directory && !this.assetDirectoryPaths?.has(directory)) throw new Error("找不到对应的素材目录。");
    const offset = Number.isInteger(request.offset) ? Math.max(0, request.offset) : 0;
    const limit = Number.isInteger(request.limit) ? Math.max(1, Math.min(120, request.limit)) : 48;
    const items = this.assets
      .filter((item) => kind === "all" || item.kind === kind)
      .filter((item) => status === "all" || item.status === status)
      .filter((item) => !directory || (recursive
        ? item.sourcePath.startsWith(`${directory}/`)
        : normalizeRelative(path.posix.dirname(item.sourcePath)) === directory))
      .filter((item) => !query || `${item.title} ${item.sourcePath} ${item.tags.join(" ")}`.toLocaleLowerCase("zh-CN").includes(query))
      .sort((left, right) => sort === "name"
        ? left.title.localeCompare(right.title, "zh-CN", { numeric: true })
        : right.updatedAt - left.updatedAt || left.sourcePath.localeCompare(right.sourcePath, "zh-CN", { numeric: true }));
    return { total: items.length, offset, limit, items: items.slice(offset, offset + limit) };
  }

  recordById(stableIdValue, expectedType) {
    const record = this.records.find((item) => item.stableId === stableIdValue);
    if (!record || (expectedType && record.type !== expectedType)) throw new Error("找不到对应的工厂记录。");
    return record;
  }

  async safeFactoryFile(sourcePath) {
    if (!this.root || !this.factoryRoot) throw new Error("自媒体工厂尚未初始化。");
    const normalized = normalizeRelative(sourcePath);
    if (!normalized.startsWith(`${FACTORY_DIRECTORY}/`)) throw new Error("只允许访问自媒体工厂目录。");
    const absolute = path.resolve(this.root, normalized);
    if (!isInside(this.factoryRoot, absolute)) throw new Error("工厂路径越界。");
    const resolved = await realpath(absolute);
    if (!isInside(this.factoryRoot, resolved)) throw new Error("工厂路径越过真实目录边界。");
    return resolved;
  }

  async writeRecord(relativeDirectory, title, attributes, body) {
    if (!this.root || !this.factoryRoot) throw new Error("自媒体工厂尚未初始化。");
    const directory = path.join(this.factoryRoot, relativeDirectory);
    await mkdir(directory, { recursive: true });
    const number = await nextNumber(directory);
    const file = path.join(directory, `${number}-${slugify(title)}.md`);
    const sourcePath = normalizeRelative(path.relative(this.root, file));
    const stable = attributes.stableId ?? `factory-${stableId(sourcePath)}`;
    await atomicWrite(file, stringifyMarkdown({ ...attributes, stableId: stable, title }, body));
    await this.refresh();
    return this.recordById(stable);
  }

  async updateRecord(record, patch, body = record.body) {
    const file = await this.safeFactoryFile(record.sourcePath);
    const current = parseFrontmatter(await readFile(file, "utf8"));
    await atomicWrite(file, stringifyMarkdown({ ...current.attributes, ...patch, updatedAt: new Date().toISOString() }, body));
    await this.refresh();
    return this.recordById(record.stableId);
  }

  async createInspiration(value = {}) {
    const title = safeText(value.title, "灵感标题", 160);
    const body = safeText(value.body, "灵感内容");
    const sourceType = value.sourceType === "benchmark" ? "benchmark" : "personal";
    const referencePath = optionalText(value.referencePath, 500);
    const directory = sourceType === "benchmark" ? "01-灵感与调研/02-对标拆解" : "01-灵感与调研/01-灵感箱";
    return await this.writeRecord(directory, title, {
      jimuType: "Inspiration",
      status: "captured",
      sourceType,
      referencePath,
      tags: Array.isArray(value.tags) ? value.tags.map(String).slice(0, 20) : [],
      createdAt: new Date().toISOString(),
    }, `# ${title}\n\n${body}${referencePath ? `\n\n## 来源\n\n[[${referencePath}]]` : ""}`);
  }

  async promoteTopic(value = {}) {
    const source = this.recordById(safeText(value.stableId, "灵感 ID", 180), "Inspiration");
    if (this.records.some((item) => item.type === "TopicCandidate" && item.referencePath === source.sourcePath)) throw new Error("这条灵感已经进入选题候选。");
    return await this.writeRecord("01-灵感与调研/03-选题候选", source.title, {
      jimuType: "TopicCandidate",
      status: "candidate",
      sourceType: source.sourceType,
      referencePath: source.sourcePath,
      tags: source.tags,
      createdAt: new Date().toISOString(),
    }, `# ${source.title}\n\n## 选题来源\n\n[[${source.sourcePath}]]\n\n## 待确认\n\n- 目标受众：\n- 核心问题：\n- 内容承诺：\n- 可见证据：\n- 验收边界：`);
  }

  async saveContentRevision(value = {}) {
    const title = safeText(value.title, "内容标题", 160);
    const body = safeText(value.body, "文案正文", 100_000);
    let record = null;
    let projectDirectory;
    if (typeof value.stableId === "string" && value.stableId) {
      record = this.recordById(value.stableId, "ContentProject");
      projectDirectory = path.dirname(await this.safeFactoryFile(record.sourcePath));
    } else {
      if (!this.factoryRoot || !this.root) throw new Error("自媒体工厂尚未初始化。");
      const contentRoot = path.join(this.factoryRoot, "02-文案与内容/内容项目");
      await mkdir(contentRoot, { recursive: true });
      const number = await nextNumber(contentRoot);
      projectDirectory = path.join(contentRoot, `${number}-${slugify(title)}`);
      await mkdir(path.join(projectDirectory, "修订"), { recursive: true });
      const sourcePath = normalizeRelative(path.relative(this.root, path.join(projectDirectory, "README.md")));
      const contentId = `content-${stableId(sourcePath)}`;
      await atomicWrite(path.join(projectDirectory, "README.md"), stringifyMarkdown({
        jimuType: "ContentProject",
        stableId: contentId,
        title,
        status: "drafting",
        topicPath: optionalText(value.topicPath, 500),
        createdAt: new Date().toISOString(),
      }, `# ${title}\n\n内容项目以修订文件保存文案，不覆盖历史版本。`));
      await this.refresh();
      record = this.recordById(contentId, "ContentProject");
    }
    const revisionRoot = path.join(projectDirectory, "修订");
    await mkdir(revisionRoot, { recursive: true });
    const number = await nextNumber(revisionRoot);
    const revisionFile = path.join(revisionRoot, `${number}-文案修订.md`);
    await atomicWrite(revisionFile, stringifyMarkdown({
      revisionOf: record.stableId,
      revision: Number(number),
      createdAt: new Date().toISOString(),
    }, `# ${title}\n\n${body}`));
    const revisionPath = normalizeRelative(path.relative(this.root, revisionFile));
    return await this.updateRecord(record, { title, status: record.status === "script-approved" ? "drafting" : record.status, latestRevision: revisionPath });
  }

  async readContent(value = {}) {
    const record = this.recordById(safeText(value.stableId, "内容 ID", 180), "ContentProject");
    let text = "";
    if (record.latestRevision) {
      const file = await this.safeFactoryFile(record.latestRevision);
      text = parseFrontmatter(await readFile(file, "utf8")).body.replace(/^#\s+[^\n]+\n+/, "");
    }
    return { ...record, text };
  }

  async approveScript(value = {}) {
    const record = this.recordById(safeText(value.stableId, "内容 ID", 180), "ContentProject");
    if (!record.latestRevision) throw new Error("请先保存至少一个文案版本。");
    return await this.updateRecord(record, { status: "script-approved", approvedRevision: record.latestRevision });
  }

  async linkAgentSession(value = {}) {
    const record = this.recordById(safeText(value.stableId, "内容 ID", 180), "ContentProject");
    return await this.updateRecord(record, {
      agentWorkspaceId: safeText(value.workspaceId, "项目 ID", 180),
      agentSessionId: safeText(value.sessionId, "会话 ID", 180),
    });
  }

  async savePublication(value = {}) {
    const title = safeText(value.title, "发布标题", 160);
    const contentId = optionalText(value.contentId, 180);
    if (contentId) this.recordById(contentId, "ContentProject");
    return await this.writeRecord("05-发布与数据/01-内容档案", title, {
      jimuType: "Publication",
      status: "published",
      contentId,
      platform: safeText(value.platform, "发布平台", 80),
      account: optionalText(value.account, 160),
      url: optionalText(value.url, 1000),
      publishedAt: safeText(value.publishedAt, "发布时间", 80),
      createdAt: new Date().toISOString(),
    }, `# ${title}\n\n## 发布信息\n\n- 平台：${value.platform}\n- 账号：${optionalText(value.account, 160) || "未填写"}\n- 发布时间：${value.publishedAt}\n- 发布链接：${optionalText(value.url, 1000) || "未填写"}${contentId ? `\n- 内容项目：${contentId}` : ""}`);
  }

  async addMetricSnapshot(value = {}) {
    const publication = this.recordById(safeText(value.publicationId, "发布档案 ID", 180), "Publication");
    const capturedAt = safeText(value.capturedAt, "快照时间", 80);
    const metrics = Object.fromEntries(["views", "likes", "favorites", "comments", "shares", "follows"].map((key) => [key, normalizedMetric(value[key])]));
    const title = `${publication.title}-${capturedAt.replace(/[:/\s]+/g, "-")}`;
    return await this.writeRecord("05-发布与数据/03-数据快照", title, {
      jimuType: "MetricSnapshot",
      status: "recorded",
      publicationId: publication.stableId,
      platform: publication.platform,
      capturedAt,
      ...metrics,
    }, `# ${publication.title}｜数据快照\n\n- 记录时间：${capturedAt}\n- 浏览：${metrics.views ?? "未知"}\n- 点赞：${metrics.likes ?? "未知"}\n- 收藏：${metrics.favorites ?? "未知"}\n- 评论：${metrics.comments ?? "未知"}\n- 分享：${metrics.shares ?? "未知"}\n- 涨粉：${metrics.follows ?? "未知"}`);
  }

  async importMetricsCsv(value = {}) {
    const publicationId = safeText(value.publicationId, "发布档案 ID", 180);
    this.recordById(publicationId, "Publication");
    const text = safeText(value.csv, "CSV 内容", 5_000_000);
    const rows = parseCsv(text);
    if (rows.length === 0) throw new Error("CSV 至少需要标题行和一行数据。");
    const results = [];
    for (const row of rows) {
      results.push(await this.addMetricSnapshot({
        publicationId,
        capturedAt: csvValue(row, ["capturedAt", "captured_at", "日期", "时间", "快照时间"]) || new Date().toISOString(),
        views: csvValue(row, ["views", "view", "浏览", "播放", "播放量"]),
        likes: csvValue(row, ["likes", "like", "点赞", "点赞量"]),
        favorites: csvValue(row, ["favorites", "collects", "收藏", "收藏量"]),
        comments: csvValue(row, ["comments", "comment", "评论", "评论量"]),
        shares: csvValue(row, ["shares", "share", "分享", "转发"]),
        follows: csvValue(row, ["follows", "followers", "涨粉", "新增粉丝"]),
      }));
    }
    if (this.factoryRoot) {
      const importRoot = path.join(this.factoryRoot, "05-发布与数据/02-数据导入");
      await mkdir(importRoot, { recursive: true });
      const number = await nextNumber(importRoot);
      await atomicWrite(path.join(importRoot, `${number}-数据导入.csv`), `${text.trim()}\n`);
    }
    await this.refresh();
    return { imported: results.length };
  }

  async importMetricsCsvFile(filePath, publicationId) {
    const real = await realpath(filePath);
    const info = await lstat(real);
    if (!info.isFile() || info.isSymbolicLink() || path.extname(real).toLocaleLowerCase("zh-CN") !== ".csv") throw new Error("请选择真实 CSV 文件。");
    return await this.importMetricsCsv({ publicationId, csv: await readFile(real, "utf8") });
  }

  async importAssets(filePaths, kind = "image") {
    if (!this.factoryRoot) throw new Error("自媒体工厂尚未初始化。");
    const category = ASSET_CATEGORY_DIRECTORIES[kind] ?? ASSET_CATEGORY_DIRECTORIES.image;
    const targetRoot = path.join(this.factoryRoot, "03-素材库", category);
    await mkdir(targetRoot, { recursive: true });
    const imported = [];
    for (const source of filePaths) {
      const real = await realpath(source);
      const info = await lstat(real);
      const extension = path.extname(real).toLocaleLowerCase("zh-CN");
      if (!info.isFile() || info.isSymbolicLink() || !ASSET_EXTENSIONS.has(extension)) continue;
      const stem = slugify(path.basename(real, extension));
      let target = path.join(targetRoot, `${stem}${extension}`);
      let suffix = 2;
      while (true) {
        try {
          await lstat(target);
          target = path.join(targetRoot, `${stem}-${suffix}${extension}`);
          suffix += 1;
        } catch (error) {
          if (error && typeof error === "object" && error.code === "ENOENT") break;
          throw error;
        }
      }
      await copyFile(real, target);
      imported.push(normalizeRelative(path.relative(this.root, target)));
    }
    await this.refresh();
    return { imported };
  }

  startWatching() {
    if (!this.factoryRoot || this.watcher || !existsSync(this.factoryRoot)) return;
    this.watcher = watch(this.factoryRoot, { recursive: true }, () => {
      clearTimeout(this.refreshTimer);
      this.refreshTimer = setTimeout(() => {
        this.refreshQueue = this.refreshQueue.then(() => this.refresh()).catch((error) => {
          console.error("JiMu factory refresh failed:", error instanceof Error && error.name ? error.name : "UnknownError");
        });
      }, 180);
    });
  }

  subscribe(listener) {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  close() {
    clearTimeout(this.refreshTimer);
    this.watcher?.close();
    this.watcher = null;
    this.listeners.clear();
  }
}
