import { createHash } from "node:crypto";
import { watch } from "node:fs";
import {
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
import { DatabaseSync } from "node:sqlite";
import { pathToFileURL } from "node:url";
import { Worker } from "node:worker_threads";
import {
  KNOWLEDGE_AUXILIARY_CATEGORIES,
  KNOWLEDGE_CATEGORIES,
  KNOWLEDGE_STANDARD_DIRECTORIES,
  validateKnowledgeManifest,
} from "../shared/knowledge-schema.mjs";

const ARCHIVE_CATEGORY_META = KNOWLEDGE_CATEGORIES;
const AUXILIARY_CATEGORY_META = KNOWLEDGE_AUXILIARY_CATEGORIES;

const ALL_CATEGORY_META = [...ARCHIVE_CATEGORY_META, ...AUXILIARY_CATEGORY_META];
const CATEGORY_BY_DIRECTORY = new Map(ALL_CATEGORY_META.map((category) => [category.directory, category]));
const CATEGORY_BY_ID = new Map(ALL_CATEGORY_META.map((category) => [category.id, category]));
const IGNORED_DIRECTORIES = new Set(["node_modules", "dist", "build", "coverage", "Caches", "cache"]);
const HEADING_PATTERN = /^(#{1,3})\s+(.+?)\s*#*$/;
const MARKDOWN_LINK_PATTERN = /(?<!!)\[([^\]]+)\]\(([^)]+)\)/g;
const WIKI_LINK_PATTERN = /\[\[([^\]|]+)(?:\|([^\]]+))?\]\]/g;
const IMAGE_EXTENSIONS = new Set([".avif", ".gif", ".jpeg", ".jpg", ".png", ".svg", ".webp"]);
const VIDEO_EXTENSIONS = new Set([".mp4", ".m4v", ".mov", ".webm"]);
const AUDIO_EXTENSIONS = new Set([".aac", ".flac", ".m4a", ".mp3", ".ogg", ".wav"]);
const ASSET_EXTENSIONS = new Set([...IMAGE_EXTENSIONS, ...VIDEO_EXTENSIONS, ...AUDIO_EXTENSIONS]);
const SAFE_STABLE_ID_PATTERN = /^[A-Za-z0-9._:-]{4,160}$/;
const FACTORY_STAGE_BY_TYPE = {
  Inspiration: "inspiration",
  TopicCandidate: "research",
  ContentProject: "production",
  Publication: "published",
  MetricSnapshot: "review",
};

function diagnosticKind(error) {
  return error instanceof Error && error.name ? error.name : "UnknownError";
}

export const DEFAULT_KNOWLEDGE_ROOT = process.env.JIMU_KNOWLEDGE_ROOT;
export const DEFAULT_INDEX_PATH = process.env.JIMU_INDEX_PATH;
export const DEFAULT_DATABASE_PATH = process.env.JIMU_SEARCH_DATABASE_PATH;

function stableId(value) {
  return createHash("sha1").update(value).digest("hex").slice(0, 20);
}

function isInside(root, candidate) {
  const relative = path.relative(root, candidate);
  return relative === "" || (!relative.startsWith(`..${path.sep}`) && relative !== ".." && !path.isAbsolute(relative));
}

function isHiddenOrIgnored(name) {
  return name.startsWith(".") || IGNORED_DIRECTORIES.has(name);
}

function isMissingFile(error) {
  return error && typeof error === "object" && error.code === "ENOENT";
}

export async function inspectKnowledgeRoot(requestedRoot) {
  if (typeof requestedRoot !== "string" || !requestedRoot.trim()) {
    return { phase: "unconfigured", compatibility: undefined, manifest: undefined };
  }
  let root;
  try {
    root = await realpath(requestedRoot);
  } catch (error) {
    if (isMissingFile(error)) return { phase: "missing", root: requestedRoot, error: "知识库目录不存在。" };
    return { phase: "error", root: requestedRoot, error: error instanceof Error ? error.message : String(error) };
  }

  for (const directory of KNOWLEDGE_STANDARD_DIRECTORIES) {
    try {
      const info = await lstat(path.join(root, directory));
      if (!info.isDirectory() || info.isSymbolicLink()) return { phase: "incompatible", root, error: `知识库缺少标准目录：${directory}` };
    } catch (error) {
      if (isMissingFile(error)) return { phase: "incompatible", root, error: `知识库缺少标准目录：${directory}` };
      return { phase: "error", root, error: error instanceof Error ? error.message : String(error) };
    }
  }

  let manifestText;
  try {
    manifestText = await readFile(path.join(root, "jimu-knowledge.json"), "utf8");
  } catch (error) {
    if (isMissingFile(error)) return { phase: "ready", root, compatibility: "legacy-schema-1" };
    return { phase: "error", root, error: error instanceof Error ? error.message : String(error) };
  }

  let manifest;
  try {
    manifest = JSON.parse(manifestText);
  } catch {
    return { phase: "incompatible", root, error: "知识库 Manifest 不是有效 JSON。" };
  }
  const validation = validateKnowledgeManifest(manifest);
  if (!validation.ok) return { phase: "incompatible", root, error: validation.error };
  return { phase: "ready", root, compatibility: "schema-1", manifest: validation.manifest };
}

async function listMarkdownFiles(root) {
  const files = [];
  async function visit(directory) {
    const handle = await opendir(directory);
    for await (const entry of handle) {
      if (isHiddenOrIgnored(entry.name) || entry.isSymbolicLink()) continue;
      const absolute = path.join(directory, entry.name);
      if (entry.isDirectory()) {
        await visit(absolute);
        continue;
      }
      if (!entry.isFile() || path.extname(entry.name).toLocaleLowerCase() !== ".md") continue;
      const resolved = await realpath(absolute);
      if (isInside(root, resolved)) files.push(resolved);
    }
  }
  await visit(root);
  return files.sort((a, b) => a.localeCompare(b, "zh-CN", { numeric: true }));
}

function unquote(value) {
  const trimmed = value.trim();
  if ((trimmed.startsWith('"') && trimmed.endsWith('"')) || (trimmed.startsWith("'") && trimmed.endsWith("'"))) {
    return trimmed.slice(1, -1);
  }
  return trimmed;
}

function parseFrontmatter(markdown) {
  if (!markdown.startsWith("---\n") && !markdown.startsWith("---\r\n")) return { attributes: {}, body: markdown };
  const lines = markdown.split(/\r?\n/);
  let end = -1;
  for (let index = 1; index < lines.length; index += 1) {
    if (lines[index].trim() === "---") {
      end = index;
      break;
    }
  }
  if (end < 0) return { attributes: {}, body: markdown };
  const attributes = {};
  let activeList = null;
  for (const line of lines.slice(1, end)) {
    const listItem = line.match(/^\s*-\s+(.+)$/);
    if (listItem && activeList) {
      attributes[activeList] ??= [];
      attributes[activeList].push(unquote(listItem[1]));
      continue;
    }
    const field = line.match(/^([A-Za-z0-9_-]+):\s*(.*)$/);
    if (!field) continue;
    const [, key, raw] = field;
    if (raw.trim() === "") {
      activeList = key;
      attributes[key] = [];
      continue;
    }
    activeList = null;
    const value = raw.trim();
    if (value.startsWith("[") && value.endsWith("]")) {
      attributes[key] = value.slice(1, -1).split(",").map((item) => unquote(item)).filter(Boolean);
    } else {
      attributes[key] = unquote(value);
    }
  }
  return { attributes, body: lines.slice(end + 1).join("\n") };
}

function stripMarkdown(value) {
  return value
    .replace(/<!--([\s\S]*?)-->/g, " ")
    .replace(/!\[([^\]]*)\]\([^)]+\)/g, "$1")
    .replace(MARKDOWN_LINK_PATTERN, "$1")
    .replace(WIKI_LINK_PATTERN, (_, target, alias) => alias || target)
    .replace(/<[^>]+>/g, " ")
    .replace(/`{1,3}([^`]+)`{1,3}/g, "$1")
    .replace(/^\s{0,3}>\s?/gm, "")
    .replace(/^\s*[-*+]\s+\[[ xX]\]\s+/gm, "")
    .replace(/^\s*[-*+]\s+/gm, "")
    .replace(/^\s*\d+[.)]\s+/gm, "")
    .replace(/[*_~]+/g, "")
    .replace(/\|/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function slugify(value, fallback) {
  const slug = value
    .normalize("NFKC")
    .toLocaleLowerCase("zh-CN")
    .replace(/[^\p{Letter}\p{Number}\u3400-\u9fff]+/gu, "-")
    .replace(/^-+|-+$/g, "");
  return slug || fallback;
}

function parseSections(body, title) {
  const sections = [];
  let current = { id: "overview", title: "正文", level: 2, paragraphs: [], bullets: [] };
  let paragraph = [];
  let inFence = false;
  let fence = [];
  const usedIds = new Set();

  const flushParagraph = () => {
    const text = stripMarkdown(paragraph.join(" "));
    if (text) current.paragraphs.push(text);
    paragraph = [];
  };
  const flushFence = () => {
    const text = fence.join("\n").trim();
    if (text) current.paragraphs.push(text);
    fence = [];
  };
  const pushCurrent = () => {
    flushParagraph();
    flushFence();
    if (current.paragraphs.length > 0 || current.bullets.length > 0 || current.title !== "正文") sections.push(current);
  };
  const uniqueId = (heading) => {
    const base = slugify(heading, `section-${sections.length + 1}`);
    let candidate = base;
    let suffix = 2;
    while (usedIds.has(candidate)) {
      candidate = `${base}-${suffix}`;
      suffix += 1;
    }
    usedIds.add(candidate);
    return candidate;
  };

  for (const rawLine of body.split(/\r?\n/)) {
    const line = rawLine.trimEnd();
    if (/^\s*```/.test(line)) {
      if (inFence) flushFence();
      else flushParagraph();
      inFence = !inFence;
      continue;
    }
    if (inFence) {
      fence.push(rawLine);
      continue;
    }
    const heading = line.match(HEADING_PATTERN);
    if (heading) {
      const headingTitle = stripMarkdown(heading[2]);
      if (heading[1].length === 1 && headingTitle === title && sections.length === 0
        && current.paragraphs.length === 0 && current.bullets.length === 0) continue;
      pushCurrent();
      current = {
        id: uniqueId(headingTitle),
        title: headingTitle,
        level: heading[1].length,
        paragraphs: [],
        bullets: [],
      };
      continue;
    }
    const bullet = line.match(/^\s*(?:[-*+]\s+(?:\[[ xX]\]\s*)?|\d+[.)]\s+)(.+)$/);
    if (bullet) {
      flushParagraph();
      const text = stripMarkdown(bullet[1]);
      if (text) current.bullets.push(text);
      continue;
    }
    if (line.trim() === "") {
      flushParagraph();
      continue;
    }
    if (/^\s*!\[[^\]]*\]\([^)]+\)\s*$/.test(line)) continue;
    paragraph.push(line);
  }
  pushCurrent();
  return sections.length > 0 ? sections : [{ id: "overview", title: "正文", level: 2, paragraphs: ["该文档暂无可显示的正文。"], bullets: [] }];
}

function collectLinks(markdown) {
  const links = [];
  for (const match of markdown.matchAll(MARKDOWN_LINK_PATTERN)) {
    links.push({ kind: "markdown", text: stripMarkdown(match[1]), href: match[2].trim() });
  }
  for (const match of markdown.matchAll(WIKI_LINK_PATTERN)) {
    links.push({ kind: "wiki", text: stripMarkdown(match[2] || match[1]), href: match[1].trim() });
  }
  return links;
}

function listAttribute(attributes, key) {
  const value = attributes[key];
  if (Array.isArray(value)) return value.map(String).map((item) => item.trim()).filter(Boolean);
  if (typeof value === "string" && value.trim()) return value.split(/[,，]/).map((item) => item.trim()).filter(Boolean);
  return [];
}

function classify(relativePath) {
  const [top] = relativePath.split("/");
  const meta = CATEGORY_BY_DIRECTORY.get(top) ?? CATEGORY_BY_ID.get("other");
  let type = meta.type;
  let stage = meta.stage;
  if (/checkpoint|复盘|回顾/i.test(relativePath)) {
    type = "Review";
    stage = "review";
  } else if (/decision|决策/i.test(relativePath)) {
    type = "Decision";
    stage = "decision";
  } else if (/plan|计划|方案/i.test(relativePath) && meta.id === "projects") {
    type = "Plan";
    stage = "plan";
  } else if (/log|记录|执行/i.test(relativePath) && meta.id === "projects") {
    type = "Execution";
    stage = "execution";
  }
  return { ...meta, type, stage };
}

function displayDate(timestamp) {
  const date = new Date(timestamp);
  return `${String(date.getMonth() + 1).padStart(2, "0")}.${String(date.getDate()).padStart(2, "0")}`;
}

function firstUsefulParagraph(sections) {
  for (const section of sections) {
    const paragraph = section.paragraphs.find((item) => item.length >= 12);
    if (paragraph) return paragraph.slice(0, 220);
    const bullet = section.bullets.find((item) => item.length >= 12);
    if (bullet) return bullet.slice(0, 220);
  }
  return "该文档暂无可用摘要。";
}

async function parseDocument(root, absolutePath) {
  const resolved = await realpath(absolutePath);
  if (!isInside(root, resolved)) throw new Error(`Refusing to index a path outside the knowledge root: ${absolutePath}`);
  const fileStats = await stat(resolved);
  const markdown = await readFile(resolved, "utf8");
  const relativePath = path.relative(root, resolved).split(path.sep).join("/");
  const { attributes, body } = parseFrontmatter(markdown);
  const h1 = body.split(/\r?\n/).map((line) => line.match(/^#\s+(.+?)\s*#*$/)?.[1]).find(Boolean);
  const title = typeof attributes.title === "string" && attributes.title.trim()
    ? attributes.title.trim()
    : h1 ? stripMarkdown(h1) : path.basename(relativePath, path.extname(relativePath));
  const sections = parseSections(body, title);
  const headings = [];
  for (const match of body.matchAll(/^#{1,3}\s+(.+?)\s*#*$/gm)) headings.push(stripMarkdown(match[1]));
  const category = classify(relativePath);
  const factoryType = category.id === "factory" && typeof attributes.jimuType === "string"
    ? attributes.jimuType.trim()
    : "";
  const links = collectLinks(body);
  const tags = [...new Set([...listAttribute(attributes, "tags"), ...listAttribute(attributes, "tag")])];
  const aliases = [...new Set([...listAttribute(attributes, "aliases"), ...listAttribute(attributes, "alias")])];
  const content = stripMarkdown(body);
  const requestedStableId = typeof attributes.stableId === "string" ? attributes.stableId.trim() : "";
  return {
    stableId: SAFE_STABLE_ID_PATTERN.test(requestedStableId) ? requestedStableId : stableId(`document:${relativePath}`),
    virtual: false,
    type: factoryType || category.type,
    title,
    category: category.id,
    categoryLabel: category.label,
    sourcePath: relativePath,
    tags,
    aliases,
    description: typeof attributes.description === "string" ? attributes.description.trim() : "",
    stage: FACTORY_STAGE_BY_TYPE[factoryType] ?? category.stage,
    relatedIds: [],
    outboundLinks: links,
    inboundLinks: [],
    updatedAt: Math.round(fileStats.mtimeMs),
    size: fileStats.size,
    headings,
    content,
    sections,
    excerpt: firstUsefulParagraph(sections),
    order: relativePath,
    date: displayDate(fileStats.mtimeMs),
    accent: category.accent,
    eyebrow: category.eyebrow,
    archiveMarked: category.id === "archive",
    logMarked: category.id === "logs",
  };
}

function normalizeTarget(value) {
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
}

function withoutMarkdownExtension(value) {
  return value.toLocaleLowerCase("zh-CN").replace(/\.md$/i, "");
}

function resolveRelations(documents) {
  const byPath = new Map();
  const byStem = new Map();
  for (const document of documents.filter((item) => !item.virtual)) {
    const normalized = document.sourcePath.toLocaleLowerCase("zh-CN");
    byPath.set(normalized, document);
    byPath.set(withoutMarkdownExtension(normalized), document);
    const stem = withoutMarkdownExtension(path.posix.basename(normalized));
    const matches = byStem.get(stem) ?? [];
    matches.push(document);
    byStem.set(stem, matches);
    document.relatedIds = [];
    document.inboundLinks = [];
  }

  for (const document of documents.filter((item) => !item.virtual)) {
    const related = [];
    for (const link of document.outboundLinks) {
      if (/^(?:[a-z]+:|#)/i.test(link.href)) continue;
      const rawTarget = normalizeTarget(link.href.split("#")[0].split("?")[0]).trim();
      if (!rawTarget) continue;
      let target;
      if (link.kind === "wiki") {
        const direct = withoutMarkdownExtension(rawTarget.toLocaleLowerCase("zh-CN"));
        target = byPath.get(direct);
        if (!target) {
          const matches = byStem.get(withoutMarkdownExtension(path.posix.basename(direct))) ?? [];
          if (matches.length === 1) target = matches[0];
        }
      } else {
        const joined = rawTarget.startsWith("/")
          ? path.posix.normalize(rawTarget.slice(1))
          : path.posix.normalize(path.posix.join(path.posix.dirname(document.sourcePath), rawTarget));
        if (joined === ".." || joined.startsWith("../") || path.posix.isAbsolute(joined)) continue;
        const candidate = joined.toLocaleLowerCase("zh-CN");
        target = byPath.get(candidate) ?? byPath.get(`${candidate}.md`);
      }
      if (!target || target.stableId === document.stableId) continue;
      if (!related.includes(target.stableId)) related.push(target.stableId);
      if (!target.inboundLinks.includes(document.stableId)) target.inboundLinks.push(document.stableId);
    }
    document.relatedIds = related;
  }
}

function benchmarkAccountBase(relativePath) {
  const parts = relativePath.split("/");
  if (parts[0] !== "07-对标博主库" || parts.length < 4 || !parts[2].includes("--")) return null;
  return parts.slice(0, 3).join("/");
}

async function readJsonFile(absolutePath) {
  try {
    const value = JSON.parse(await readFile(absolutePath, "utf8"));
    return value && typeof value === "object" && !Array.isArray(value) ? value : null;
  } catch {
    return null;
  }
}

async function pathExists(absolutePath) {
  try {
    const info = await lstat(absolutePath);
    return info.isFile();
  } catch {
    return false;
  }
}

async function listFileNames(directory) {
  try {
    const names = [];
    const handle = await opendir(directory);
    for await (const entry of handle) {
      if (entry.isFile()) names.push(entry.name);
    }
    return names;
  } catch {
    return [];
  }
}

function noteTitleFromFolder(folderName) {
  const stripped = folderName.replace(/^\d{4}-\d{2}-\d{2}--/, "");
  return stripped.replaceAll("-", " ").trim() || folderName;
}

function assetUrlFor(relativePath) {
  return `jimu-asset://local/${Buffer.from(relativePath, "utf8").toString("base64url")}`;
}

async function resolveNoteCover(noteRelativeDir, noteAbsoluteDir, record) {
  const recordedPath = typeof record?.media?.cover?.local_path === "string" && record.media.cover.local_path.trim()
    ? record.media.cover.local_path.trim()
    : "";
  if (recordedPath) {
    const absolute = path.join(noteAbsoluteDir, recordedPath);
    if (await pathExists(absolute)) {
      const relativePath = `${noteRelativeDir}/${recordedPath}`;
      return { kind: "local", relativePath, assetUrl: assetUrlFor(relativePath) };
    }
  }
  const assetNames = await listFileNames(path.join(noteAbsoluteDir, "assets"));
  const imageName = assetNames.find((name) => /cover/i.test(name) && IMAGE_EXTENSIONS.has(path.extname(name).toLocaleLowerCase("zh-CN")))
    ?? assetNames.find((name) => IMAGE_EXTENSIONS.has(path.extname(name).toLocaleLowerCase("zh-CN")) && !/source/i.test(name));
  if (imageName) {
    const relativePath = `${noteRelativeDir}/assets/${imageName}`;
    return { kind: "local", relativePath, assetUrl: assetUrlFor(relativePath) };
  }
  const remoteUrl = typeof record?.media?.cover?.remote_url === "string" && record.media.cover.remote_url.trim()
    ? record.media.cover.remote_url.trim()
    : "";
  return remoteUrl ? { kind: "remote", url: remoteUrl } : { kind: "none" };
}

async function resolveNoteVideo(noteRelativeDir, noteAbsoluteDir, record) {
  const localPath = typeof record?.media?.video?.local_path === "string" && record.media.video.local_path.trim()
    ? record.media.video.local_path.trim()
    : "";
  if (!localPath) return null;
  const absolute = path.join(noteAbsoluteDir, localPath);
  if (!(await pathExists(absolute))) return null;
  const relativePath = `${noteRelativeDir}/${localPath}`;
  const durationSeconds = typeof record?.media?.video?.duration_seconds === "number"
    ? record.media.video.duration_seconds
    : null;
  return { kind: "local", relativePath, assetUrl: assetUrlFor(relativePath), durationSeconds };
}

async function scanBenchmarkNotes(accountRoot, base, noteDocuments) {
  const byPath = new Map(noteDocuments.map((document) => [document.sourcePath, document]));
  const notesDirectory = path.join(accountRoot, "notes");
  let folderNames = [];
  try {
    const handle = await opendir(notesDirectory);
    for await (const entry of handle) {
      if (entry.isDirectory()) folderNames.push(entry.name);
    }
  } catch {
    return [];
  }
  folderNames.sort((a, b) => a.localeCompare(b, "zh-CN", { numeric: true }));
  const notes = [];
  for (const folderName of folderNames) {
    const noteRelativeDir = `${base}/notes/${folderName}`;
    const noteAbsoluteDir = path.join(accountRoot, "notes", folderName);
    const record = await readJsonFile(path.join(noteAbsoluteDir, "record.json"));
    const noteId = typeof record?.note_id === "string" ? record.note_id : "";
    const title = typeof record?.title === "string" && record.title.trim()
      ? record.title.trim()
      : noteTitleFromFolder(folderName);
    const type = record === null ? "video" : record?.type === "video" ? "video" : "image";
    const metricsRaw = record?.metrics;
    const metrics = {
      like: typeof metricsRaw?.like_count === "number" ? metricsRaw.like_count : null,
      collect: typeof metricsRaw?.collect_count === "number" ? metricsRaw.collect_count : null,
      comment: typeof metricsRaw?.comment_count === "number" ? metricsRaw.comment_count : null,
      share: typeof metricsRaw?.share_count === "number" ? metricsRaw.share_count : null,
      snapshotAt: typeof metricsRaw?.snapshot_at === "string" ? metricsRaw.snapshot_at : "",
    };
    const engagement = metrics.like !== null && metrics.collect !== null && metrics.comment !== null
      ? metrics.like + metrics.collect + metrics.comment
      : null;
    const overviewPath = `${noteRelativeDir}/01-笔记概览.md`;
    const overview = byPath.get(overviewPath) ?? null;
    const analysisPath = `${noteRelativeDir}/analysis/01-内容拆解.md`;
    const analysis = byPath.get(analysisPath) ?? null;
    const cover = await resolveNoteCover(noteRelativeDir, noteAbsoluteDir, record);
    const video = await resolveNoteVideo(noteRelativeDir, noteAbsoluteDir, record);
    notes.push({
      noteId,
      title,
      type,
      publishedAt: typeof record?.content?.published_at === "string" ? record.content.published_at : "",
      publishedAtLocal: typeof record?.content?.published_at_local === "string" ? record.content.published_at_local : "",
      snapshotAt: metrics.snapshotAt,
      metrics,
      engagement,
      cover,
      video,
      analysis: analysis ? "analyzed" : type === "image" ? "image" : "tagged",
      stableId: overview?.stableId ?? null,
      analysisStableId: analysis?.stableId ?? null,
      sourcePath: overviewPath,
      folderName,
    });
  }
  return notes.sort((a, b) => {
    if (!a.publishedAt && !b.publishedAt) return b.folderName.localeCompare(a.folderName, "zh-CN", { numeric: true });
    if (!a.publishedAt) return 1;
    if (!b.publishedAt) return -1;
    return b.publishedAt.localeCompare(a.publishedAt);
  });
}

function summarizeEngagement(notes) {
  const values = notes.map((note) => note.engagement).filter((value) => value !== null).sort((a, b) => a - b);
  if (values.length === 0) return null;
  const middle = Math.floor(values.length / 2);
  return values.length % 2 === 1 ? values[middle] : Math.round((values[middle - 1] + values[middle]) / 2);
}

async function buildBenchmarkAccounts(actualDocuments, root) {
  const groups = new Map();
  for (const document of actualDocuments) {
    const base = benchmarkAccountBase(document.sourcePath);
    if (!base) continue;
    const group = groups.get(base) ?? [];
    group.push(document);
    groups.set(base, group);
  }
  const accounts = [];
  for (const [base, documents] of groups) {
    const [, platform, accountDirectory] = base.split("/");
    const accountName = accountDirectory.split("--")[0];
    const accountRoot = path.join(root, ...base.split("/"));
    const noteDocuments = documents.filter((document) => document.sourcePath.includes("/notes/"));
    const accountDocuments = documents.filter((document) => !document.sourcePath.includes("/notes/"));
    const notes = await scanBenchmarkNotes(accountRoot, base, noteDocuments);
    const total = (key) => notes.reduce((sum, note) => sum + (note.metrics[key] ?? 0), 0);
    const hasTagMatrix = accountDocuments.some((document) => /03-内容标签矩阵\.md$/i.test(document.sourcePath));
    const stats = {
      notes: notes.length,
      videos: notes.filter((note) => note.type === "video").length,
      images: notes.filter((note) => note.type === "image").length,
      localMedia: notes.filter((note) => note.video?.kind === "local").length,
      analyzed: notes.filter((note) => note.analysis === "analyzed").length,
      tagged: hasTagMatrix ? notes.filter((note) => note.analysis === "tagged").length : 0,
      totalLikes: total("like"),
      totalCollects: total("collect"),
      totalComments: total("comment"),
      totalShares: total("share"),
      medianEngagement: summarizeEngagement(notes),
    };
    const source = accountDocuments.find((document) => document.sourcePath === `${base}/README.md`)
      ?? accountDocuments.find((document) => /采集报告\.md$/.test(document.sourcePath))
      ?? documents[0];
    const updatedAt = Math.max(...documents.map((document) => document.updatedAt));
    const id = stableId(`benchmark-account:${base}`);
    const relatedIds = documents
      .filter((document) => document.stableId !== source?.stableId)
      .sort((a, b) => b.updatedAt - a.updatedAt)
      .slice(0, 48)
      .map((document) => document.stableId);
    const engagementLine = stats.medianEngagement === null
      ? "暂无互动快照"
      : `互动数中位 ${stats.medianEngagement.toLocaleString("zh-CN")}`;
    const sections = [
      {
        id: "account-overview",
        title: "账号概览",
        level: 2,
        paragraphs: [`该档案由 ${platform} 平台下的真实账号目录聚合生成：${stats.videos} 条视频、${stats.images} 条图文，本地媒体 ${stats.localMedia} 条；已精拆 ${stats.analyzed} 条，${engagementLine}。原始 Markdown、采集状态、笔记数据和拆解资料仍保留在各自来源路径。`],
        bullets: [
          `收录笔记 ${stats.notes} · 视频 ${stats.videos} · 图文 ${stats.images} · 本地媒体 ${stats.localMedia}`,
          `点赞合计 ${stats.totalLikes.toLocaleString("zh-CN")} · 收藏合计 ${stats.totalCollects.toLocaleString("zh-CN")} · 评论合计 ${stats.totalComments.toLocaleString("zh-CN")} · 分享合计 ${stats.totalShares.toLocaleString("zh-CN")}`,
          `已精拆 ${stats.analyzed} · 仅标签 ${stats.tagged} · ${engagementLine}`,
        ],
      },
      {
        id: "account-notes",
        title: "笔记清单",
        level: 2,
        paragraphs: [],
        bullets: notes.map((note) => {
          const interaction = note.engagement === null ? "互动 —" : `互动 ${note.engagement.toLocaleString("zh-CN")}`;
          const badge = note.analysis === "analyzed" ? "已精拆" : note.analysis === "image" ? "图文" : "仅标签";
          return `${note.title}（${note.publishedAtLocal || note.publishedAt || "时间未知"}；${interaction}；${badge}）`;
        }),
      },
      {
        id: "account-documents",
        title: "账号文档",
        level: 2,
        paragraphs: [],
        bullets: accountDocuments.map((document) => document.title),
      },
    ];
    const metrics = [
      { value: String(stats.videos), label: "视频" },
      { value: String(stats.analyzed), label: "精拆" },
    ];
    accounts.push({
      stableId: id,
      virtual: true,
      type: "BenchmarkAccount",
      title: accountName,
      category: "benchmarks",
      categoryLabel: "对标博主",
      sourcePath: source?.sourcePath ?? `${base}/README.md`,
      tags: [platform, "对标博主", "账号档案"],
      aliases: [],
      stage: "research",
      relatedIds,
      outboundLinks: [],
      inboundLinks: [],
      updatedAt,
      size: documents.reduce((sum, document) => sum + document.size, 0),
      headings: sections.map((section) => section.title),
      content: [
        accountName,
        platform,
        stats.notes,
        ...notes.flatMap((note) => [note.title, note.metrics.like ?? "", note.metrics.collect ?? ""]),
      ].join(" "),
      sections,
      excerpt: `账号主卡聚合 ${stats.notes} 个笔记目录与 ${documents.length} 份关联文档；视频 ${stats.videos}、精拆 ${stats.analyzed}、${engagementLine}。`,
      order: `07-对标博主库/${String(accounts.length + 1).padStart(2, "0")}-${accountName}`,
      date: displayDate(updatedAt),
      accent: accounts.length % 2 === 0 ? "magenta" : "teal",
      eyebrow: `BENCHMARK PROFILE / ${platform.toLocaleUpperCase("zh-CN")}`,
      metrics,
      archiveMarked: false,
      logMarked: false,
      benchmark: {
        platform,
        authorId: accountDirectory.split("--")[1] ?? "",
        accountBase: base,
        stats,
        notes,
        documents: accountDocuments
          .sort((a, b) => a.sourcePath.localeCompare(b.sourcePath, "zh-CN", { numeric: true }))
          .map((document) => ({
            stableId: document.stableId,
            title: document.title,
            sourcePath: document.sourcePath,
            type: document.type,
            date: document.date,
          })),
      },
    });
  }
  return accounts;
}

function skillDirectoryBase(relativePath) {
  const parts = relativePath.split("/");
  if (parts[0] !== "98-Skills" || parts.length < 3) return null;
  return parts.slice(0, 2).join("/");
}

function hasChineseDescription(value) {
  const text = String(value ?? "").replace(/\s+/g, "");
  const chineseCharacters = text.match(/[\u3400-\u9fff]/gu)?.length ?? 0;
  return chineseCharacters >= 8 && chineseCharacters / Math.max(text.length, 1) >= 0.18;
}

function skillDescription(source, documents) {
  const sourceText = [
    source?.description,
    ...(source?.sections ?? []).flatMap((section) => [...section.paragraphs, ...section.bullets]),
    source?.excerpt,
  ];
  const otherText = documents
    .filter((document) => document.stableId !== source?.stableId)
    .sort((a, b) => {
      const aReadme = /\/README\.md$/i.test(a.sourcePath) ? 0 : 1;
      const bReadme = /\/README\.md$/i.test(b.sourcePath) ? 0 : 1;
      return aReadme - bReadme || a.sourcePath.localeCompare(b.sourcePath, "zh-CN", { numeric: true });
    })
    .flatMap((document) => [
      document.description,
      ...document.sections.flatMap((section) => [...section.paragraphs, ...section.bullets]),
      document.excerpt,
    ]);
  const sourceCandidates = sourceText
    .map((value) => String(value ?? "").replace(/\s+/g, " ").trim())
    .filter((value) => value.length >= 12);
  const otherCandidates = otherText
    .map((value) => String(value ?? "").replace(/\s+/g, " ").trim())
    .filter((value) => value.length >= 12);
  const preferred = sourceCandidates.find(hasChineseDescription)
    ?? otherCandidates.find(hasChineseDescription)
    ?? sourceCandidates[0]
    ?? otherCandidates[0]
    ?? "该 Skill 暂无可用简介。";
  return preferred.slice(0, 240);
}

function buildSkillDirectoryTree(base, documents) {
  const root = {
    kind: "directory",
    name: path.posix.basename(base),
    path: base,
    children: [],
  };
  for (const document of documents) {
    const relative = document.sourcePath.slice(base.length + 1);
    const segments = relative.split("/").filter(Boolean);
    if (segments.length === 0) continue;
    let cursor = root;
    let currentPath = base;
    for (const [index, segment] of segments.entries()) {
      currentPath = `${currentPath}/${segment}`;
      const isDocument = index === segments.length - 1;
      if (isDocument) {
        cursor.children.push({
          kind: "document",
          name: path.posix.basename(segment, path.posix.extname(segment)),
          filename: segment,
          title: document.title,
          path: currentPath,
          sourcePath: document.sourcePath,
          stableId: document.stableId,
          updatedAt: document.updatedAt,
        });
        continue;
      }
      let directory = cursor.children.find((child) => child.kind === "directory" && child.name === segment);
      if (!directory) {
        directory = { kind: "directory", name: segment, path: currentPath, children: [] };
        cursor.children.push(directory);
      }
      cursor = directory;
    }
  }
  const sortTree = (node) => {
    node.children?.sort((a, b) => {
      if (a.kind !== b.kind) return a.kind === "directory" ? -1 : 1;
      return a.name.localeCompare(b.name, "zh-CN", { numeric: true });
    });
    for (const child of node.children ?? []) if (child.kind === "directory") sortTree(child);
    return node;
  };
  return sortTree(root);
}

function countSkillDirectories(node) {
  return (node.children ?? []).reduce((count, child) => (
    child.kind === "directory" ? count + 1 + countSkillDirectories(child) : count
  ), 0);
}

function buildSkillDirectories(actualDocuments) {
  const groups = new Map();
  for (const document of actualDocuments) {
    const base = skillDirectoryBase(document.sourcePath);
    if (!base) continue;
    const group = groups.get(base) ?? [];
    group.push(document);
    groups.set(base, group);
  }
  return [...groups.entries()]
    .sort(([a], [b]) => a.localeCompare(b, "zh-CN", { numeric: true }))
    .map(([base, documents], index) => {
      const source = documents.find((document) => document.sourcePath === `${base}/SKILL.md`)
        ?? documents.find((document) => document.sourcePath === `${base}/README.md`)
        ?? documents[0];
      const tree = buildSkillDirectoryTree(base, documents);
      const description = skillDescription(source, documents);
      const skillName = path.posix.basename(base);
      const updatedAt = Math.max(...documents.map((document) => document.updatedAt));
      const directoryCount = countSkillDirectories(tree);
      const sections = [
        {
          id: "skill-introduction",
          title: "Skill 简介",
          level: 2,
          paragraphs: [description],
          bullets: [],
        },
        {
          id: "skill-directory-guide",
          title: "目录说明",
          level: 2,
          paragraphs: ["下面按知识库中的真实目录层级展示该 Skill 的 Markdown 文档。目录默认折叠，展开后可直接进入对应文档阅读。"],
          bullets: [],
        },
      ];
      return {
        stableId: stableId(`skill-directory:${base}`),
        virtual: true,
        type: "SkillDirectory",
        title: skillName,
        category: "skills",
        categoryLabel: "Skills",
        sourcePath: source.sourcePath,
        tags: [...new Set([skillName, "Skill", ...source.tags])],
        aliases: source.aliases,
        stage: "method",
        relatedIds: documents.map((document) => document.stableId),
        outboundLinks: [],
        inboundLinks: [],
        updatedAt,
        size: documents.reduce((sum, document) => sum + document.size, 0),
        headings: sections.map((section) => section.title),
        content: `${skillName} ${description} ${documents.map((document) => document.title).join(" ")}`,
        sections,
        excerpt: description,
        order: `${base}/${String(index + 1).padStart(2, "0")}`,
        date: displayDate(updatedAt),
        accent: ["yellow", "cobalt", "teal", "magenta"][index % 4],
        eyebrow: "SKILL / DIRECTORY",
        directoryTree: tree,
        metrics: [
          { value: String(documents.length), label: "文档" },
          { value: String(directoryCount), label: "子目录" },
        ],
        archiveMarked: false,
        logMarked: false,
      };
    });
}

/**
 * A project is one first-level entry under 02-Projects: either a directory
 * (all of its documents, recursively) or a root-level Markdown file. The
 * archive shows one card per project instead of every project document; the
 * project view then lays out the real directory tree for direct reading.
 */
function projectBase(relativePath) {
  const parts = relativePath.split("/");
  if (parts[0] !== "02-Projects" || parts.length < 2) return null;
  if (parts.length === 2) return parts[1] === "README.md" ? null : `02-Projects/${parts[1]}`;
  return `02-Projects/${parts[1]}`;
}

function projectDisplayName(base) {
  const leaf = base.split("/").at(-1);
  return leaf.replace(/^\d+-\s*/, "").replace(/\.md$/i, "").trim() || leaf;
}

function buildProjectDirectories(actualDocuments) {
  const groups = new Map();
  for (const document of actualDocuments) {
    const base = projectBase(document.sourcePath);
    if (base === null) continue;
    const group = groups.get(base) ?? [];
    group.push(document);
    groups.set(base, group);
  }
  return [...groups.entries()]
    .sort(([a], [b]) => a.localeCompare(b, "zh-CN", { numeric: true }))
    .map(([base, documents], index) => {
      const isFileProject = base.endsWith(".md");
      const title = projectDisplayName(base);
      const sorted = [...documents].sort((a, b) => a.sourcePath.localeCompare(b.sourcePath, "zh-CN", { numeric: true }));
      const source = sorted.find((document) => document.sourcePath === `${base}/README.md`)
        ?? sorted[0];
      const updatedAt = Math.max(...documents.map((document) => document.updatedAt));
      const tree = isFileProject ? null : buildSkillDirectoryTree(base, sorted);
      const directoryCount = tree === null ? 0 : countSkillDirectories(tree);
      const summary = (source?.excerpt ?? source?.description ?? "").trim();
      const sections = [
        {
          id: "project-overview",
          title: "项目概览",
          level: 2,
          paragraphs: [summary || `${title} 项目共 ${documents.length} 份文档。`],
          bullets: [
            `${documents.length} 份文档${directoryCount > 0 ? ` · ${directoryCount} 个子目录` : ""} · 最近更新 ${displayDate(updatedAt)}`,
          ],
        },
        {
          id: "project-documents",
          title: "项目文档",
          level: 2,
          paragraphs: [],
          bullets: sorted.map((document) => document.title),
        },
      ];
      return {
        stableId: stableId(`project-directory:${base}`),
        virtual: true,
        type: "ProjectDirectory",
        title,
        category: "projects",
        categoryLabel: "项目",
        sourcePath: source?.sourcePath ?? `${base}/README.md`,
        tags: ["项目"],
        aliases: [],
        stage: "execution",
        relatedIds: sorted.slice(0, 60).map((document) => document.stableId),
        outboundLinks: [],
        inboundLinks: [],
        updatedAt,
        size: documents.reduce((sum, document) => sum + document.size, 0),
        headings: sections.map((section) => section.title),
        content: [title, ...sorted.map((document) => document.title)].join(" "),
        sections,
        excerpt: `${title}：${documents.length} 份项目文档${directoryCount > 0 ? `、${directoryCount} 个子目录` : ""}。${summary}`,
        order: `02-Projects/${String(index + 1).padStart(2, "0")}-${title}`,
        date: displayDate(updatedAt),
        accent: ["yellow", "cobalt", "teal", "magenta"][index % 4],
        eyebrow: "PROJECT / DIRECTORY",
        metrics: [
          { value: String(documents.length), label: "文档" },
          ...(directoryCount > 0 ? [{ value: String(directoryCount), label: "子目录" }] : []),
        ],
        archiveMarked: false,
        logMarked: false,
        project: {
          base,
          stats: { documents: documents.length, subdirectories: directoryCount, updatedAt },
          documents: sorted.map((document) => ({
            stableId: document.stableId,
            title: document.title,
            sourcePath: document.sourcePath,
            type: document.type,
            date: document.date,
          })),
          directoryTree: tree,
        },
      };
    });
}

function isFunctionalDocument(document) {
  const basename = path.posix.basename(document.sourcePath);
  return basename.startsWith("_") || (document.category === "skills" && basename.toLocaleLowerCase() === "readme.md");
}

function isBenchmarkAuxiliary(document) {
  if (document.category !== "benchmarks" || benchmarkAccountBase(document.sourcePath)) return false;
  const parts = document.sourcePath.split("/");
  if (parts.includes("_tools") || parts.includes("模板")) return false;
  return !path.posix.basename(document.sourcePath).startsWith("_");
}

/**
 * Benchmarks are organized into three archive layers. Account cards and the
 * account index belong to the directory layer, collection/field/media rules
 * belong to the standards layer, and cross-account reusable insights live
 * under 横向对标/. Documents inside an account directory stay with the
 * account and carry no layer.
 */
function benchmarkSectionFor(document) {
  if (document.type === "BenchmarkAccount") return "directory";
  if (document.category !== "benchmarks" || benchmarkAccountBase(document.sourcePath)) return null;
  const normalized = document.sourcePath.split("/").join("/");
  if (normalized === "07-对标博主库/01-博主目录.md") return "directory";
  if (normalized.startsWith("07-对标博主库/横向对标/")) return "insights";
  return "standards";
}

async function buildProjection(actualByPath, root, indexPath) {
  const actualDocuments = [...actualByPath.values()].sort((a, b) => a.sourcePath.localeCompare(b.sourcePath, "zh-CN", { numeric: true }));
  resolveRelations(actualDocuments);
  for (const document of actualDocuments) {
    const section = benchmarkSectionFor(document);
    if (section !== null) document.benchmarkSection = section;
  }
  const skillDirectories = buildSkillDirectories(actualDocuments);
  const documents = [...actualDocuments, ...skillDirectories];
  const benchmarkAccounts = await buildBenchmarkAccounts(actualDocuments, root);
  for (const account of benchmarkAccounts) account.benchmarkSection = "directory";
  documents.push(...benchmarkAccounts);
  const projectDirectories = buildProjectDirectories(actualDocuments);
  documents.push(...projectDirectories);
  const archiveCardIds = [
    ...actualDocuments
      .filter((document) => ["inbox", "knowledge", "content", "prompts", "business"].includes(document.category))
      .filter((document) => !isFunctionalDocument(document))
      .map((document) => document.stableId),
    ...projectDirectories.map((directory) => directory.stableId),
    ...actualDocuments
      .filter((document) => document.category === "projects" && document.sourcePath === "02-Projects/README.md")
      .map((document) => document.stableId),
    ...benchmarkAccounts.map((account) => account.stableId),
    ...skillDirectories.map((directory) => directory.stableId),
    ...actualDocuments.filter(isBenchmarkAuxiliary).map((document) => document.stableId),
  ];
  const archiveSet = new Set(archiveCardIds);
  const categoryStats = ARCHIVE_CATEGORY_META.map((category) => ({
    ...category,
    documentCount: actualDocuments.filter((document) => document.category === category.id).length,
    cardCount: documents.filter((document) => archiveSet.has(document.stableId) && document.category === category.id).length,
  }));
  const tags = new Map();
  for (const document of actualDocuments) {
    for (const tag of document.tags) tags.set(tag, (tags.get(tag) ?? 0) + 1);
  }
  const tagOptions = [...tags.entries()]
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0], "zh-CN"))
    .slice(0, 120)
    .map(([name, count]) => ({ name, count }));
  const statsSnapshot = {
    markdownDocuments: actualDocuments.length,
    archiveCards: archiveCardIds.length,
    inspirations: actualDocuments.filter((document) => document.category === "inbox" && !isFunctionalDocument(document)).length,
    projects: projectDirectories.length,
    knowledgeCards: actualDocuments.filter((document) => document.category === "knowledge").length,
    benchmarkProfiles: benchmarkAccounts.length,
    skillDirectories: skillDirectories.length,
    internalLinks: actualDocuments.reduce((sum, document) => sum + document.relatedIds.length, 0),
    archiveDocuments: actualDocuments.filter((document) => document.archiveMarked).length,
    logDocuments: actualDocuments.filter((document) => document.logMarked).length,
  };
  return {
    schemaVersion: 9,
    platform: "macOS",
    root,
    indexPath,
    indexedAt: Date.now(),
    categories: categoryStats,
    typeOptions: [...new Set(documents.map((document) => document.type))].sort(),
    tagOptions,
    stats: statsSnapshot,
    archiveCardIds,
    documents,
  };
}

function normalizedSearchText(value) {
  return String(value ?? "").normalize("NFKC").toLocaleLowerCase("zh-CN").replace(/\s+/g, " ").trim();
}

function cjkAndLatinTokens(value) {
  const normalized = normalizedSearchText(value);
  const tokens = new Set(normalized.match(/[a-z0-9]+/g) ?? []);
  for (const run of normalized.match(/[\u3400-\u9fff]+/g) ?? []) {
    for (const character of run) tokens.add(character);
    for (let index = 0; index < run.length - 1; index += 1) tokens.add(run.slice(index, index + 2));
  }
  return [...tokens];
}

function documentSearchHash(document) {
  return createHash("sha256").update(JSON.stringify([
    document.title,
    document.headings,
    document.tags,
    document.aliases,
    document.outboundLinks,
    document.content,
    document.categoryLabel,
    document.sourcePath,
    document.updatedAt,
  ])).digest("hex");
}

function documentSearchTokens(document) {
  return cjkAndLatinTokens([
    document.title,
    ...document.headings,
    ...document.tags,
    ...document.aliases,
    ...document.outboundLinks.map((link) => link.text),
    document.content,
    document.categoryLabel,
    document.sourcePath,
  ].join(" ")).join(" ");
}

function openSearchDatabase(databasePath) {
  const database = new DatabaseSync(databasePath);
  database.exec(`
    PRAGMA journal_mode = WAL;
    PRAGMA synchronous = NORMAL;
    CREATE TABLE IF NOT EXISTS knowledge_search_meta (
      stable_id TEXT PRIMARY KEY,
      content_hash TEXT NOT NULL
    );
    CREATE VIRTUAL TABLE IF NOT EXISTS knowledge_search USING fts5(
      stable_id UNINDEXED,
      title,
      headings,
      tags,
      aliases,
      link_text,
      body,
      category,
      source_path,
      tokens,
      tokenize = 'unicode61 remove_diacritics 2'
    );
  `);
  return database;
}

function syncSearchDatabase(database, documents) {
  const existing = new Map(database.prepare("SELECT stable_id, content_hash FROM knowledge_search_meta").all()
    .map((row) => [row.stable_id, row.content_hash]));
  const incoming = new Map(documents.map((document) => [document.stableId, documentSearchHash(document)]));
  const removeFts = database.prepare("DELETE FROM knowledge_search WHERE stable_id = ?");
  const removeMeta = database.prepare("DELETE FROM knowledge_search_meta WHERE stable_id = ?");
  const insertFts = database.prepare(`
    INSERT INTO knowledge_search (
      stable_id, title, headings, tags, aliases, link_text, body, category, source_path, tokens
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);
  const insertMeta = database.prepare("INSERT INTO knowledge_search_meta (stable_id, content_hash) VALUES (?, ?)");
  database.exec("BEGIN IMMEDIATE");
  try {
    for (const [id] of existing) {
      if (incoming.has(id)) continue;
      removeFts.run(id);
      removeMeta.run(id);
    }
    for (const document of documents) {
      const hash = incoming.get(document.stableId);
      if (existing.get(document.stableId) === hash) continue;
      removeFts.run(document.stableId);
      removeMeta.run(document.stableId);
      insertFts.run(
        document.stableId,
        document.title,
        document.headings.join(" "),
        document.tags.join(" "),
        document.aliases.join(" "),
        document.outboundLinks.map((link) => link.text).join(" "),
        document.content,
        document.categoryLabel,
        document.sourcePath,
        documentSearchTokens(document),
      );
      insertMeta.run(document.stableId, hash);
    }
    database.exec("COMMIT");
  } catch (error) {
    database.exec("ROLLBACK");
    throw error;
  }
}

function toClientDocument(document) {
  const { content: _content, sections, outboundLinks, ...summary } = document;
  return {
    ...summary,
    outboundLinkCount: outboundLinks.length,
    ...(document.virtual ? { sections } : {}),
  };
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
  return Math.max(0.22, query.length / Math.max(text.length, query.length));
}

function scoreDocument(document, query) {
  const normalizedQuery = normalizedSearchText(query);
  if (!normalizedQuery) return { score: 1, field: "recent" };
  const tokens = cjkAndLatinTokens(normalizedQuery).filter((token) => token.length > 1 || normalizedQuery.length === 1);
  const fields = [
    ["title", normalizedSearchText(document.title), 150],
    ["heading", normalizedSearchText(document.headings.join(" ")), 95],
    ["tag", normalizedSearchText([...document.tags, ...document.aliases].join(" ")), 78],
    ["link", normalizedSearchText(document.outboundLinks.map((link) => link.text).join(" ")), 55],
    ["body", normalizedSearchText(document.content), 30],
    ["path", normalizedSearchText(`${document.categoryLabel} ${document.sourcePath}`), 18],
  ];
  let score = 0;
  let field = "body";
  let best = 0;
  for (const [name, value, weight] of fields) {
    let fieldScore = value === normalizedQuery ? weight * 3 : value.includes(normalizedQuery) ? weight * 2.5 : 0;
    if (fieldScore === 0) {
      // Short CJK tokens are weak signals on their own; a full-phrase hit in
      // one field must not be outranked by unrelated titles sharing a token.
      for (const token of tokens) {
        const boost = token.length >= 3 ? 1 : token.length === 2 ? 0.45 : 0.18;
        fieldScore += fuzzySimilarity(value, token) * weight * boost;
      }
    }
    if (fieldScore > best) {
      best = fieldScore;
      field = name;
    }
    // The strongest evidence field decides the document score; weak token
    // matches across many fields must not outrank one real phrase hit.
    score = Math.max(score, fieldScore);
  }
  return { score, field };
}

function searchSnippet(document, query) {
  const content = document.content || document.excerpt;
  const normalized = normalizedSearchText(content);
  const tokens = cjkAndLatinTokens(query).sort((a, b) => b.length - a.length);
  let index = normalized.indexOf(normalizedSearchText(query));
  if (index < 0) index = tokens.map((token) => normalized.indexOf(token)).find((value) => value >= 0) ?? -1;
  if (index < 0) return document.excerpt.slice(0, 220);
  const start = Math.max(0, index - 72);
  const end = Math.min(content.length, index + Math.max(String(query).length, 32) + 140);
  return `${start > 0 ? "…" : ""}${content.slice(start, end)}${end < content.length ? "…" : ""}`;
}

function ftsCandidates(database, query) {
  const tokens = cjkAndLatinTokens(query).filter((token) => token.length > 1 || String(query).trim().length === 1);
  if (tokens.length === 0) return [];
  const expression = tokens.slice(0, 20).map((token) => `"${token.replaceAll('"', '""')}"`).join(" OR ");
  try {
    return database.prepare("SELECT stable_id FROM knowledge_search WHERE knowledge_search MATCH ? LIMIT 400")
      .all(expression).map((row) => row.stable_id);
  } catch {
    return [];
  }
}

function matchesSearchFilters(document, request) {
  if (!request.includeArchive && document.archiveMarked) return false;
  if (!request.includeLogs && document.logMarked) return false;
  if (request.category && request.category !== "all" && document.category !== request.category) return false;
  if (request.type && request.type !== "all" && document.type !== request.type) return false;
  if (request.tag && request.tag !== "all" && !document.tags.includes(request.tag)) return false;
  const days = request.modified === "7d" ? 7 : request.modified === "30d" ? 30 : request.modified === "365d" ? 365 : null;
  return days === null || Date.now() - document.updatedAt <= days * 86_400_000;
}

function normalizeSearchRequest(value) {
  const request = value && typeof value === "object" && !Array.isArray(value) ? value : {};
  return {
    query: typeof request.query === "string" ? request.query.trim() : "",
    category: typeof request.category === "string" ? request.category : "all",
    type: typeof request.type === "string" ? request.type : "all",
    tag: typeof request.tag === "string" ? request.tag : "all",
    modified: typeof request.modified === "string" ? request.modified : "all",
    sort: request.sort === "recent" ? "recent" : "relevance",
    includeArchive: request.includeArchive === true,
    includeLogs: request.includeLogs === true,
    limit: Number.isInteger(request.limit) ? Math.max(1, Math.min(200, request.limit)) : 120,
  };
}

function categoryNode(categoryId) {
  const category = CATEGORY_BY_ID.get(categoryId) ?? CATEGORY_BY_ID.get("other");
  return {
    stableId: `category:${category.id}`,
    type: "Category",
    title: category.label,
    category: category.id,
    sourcePath: category.directory === "ROOT" ? null : category.directory,
    tags: [],
    stage: null,
    relatedIds: [],
    outboundLinks: [],
    inboundLinks: [],
    updatedAt: new Date(0).toISOString(),
    selectionSource: "linked",
  };
}

function graphSnapshot(snapshot) {
  const byId = new Map(snapshot.documents.map((document) => [document.stableId, document]));
  const selection = new Map();
  const addSelected = (id, source) => {
    if (!byId.has(id)) return;
    const priority = { linked: 0, benchmark: 1, memory: 2, hot: 3 };
    if (priority[source] > priority[selection.get(id) ?? "linked"]) selection.set(id, source);
    else if (!selection.has(id)) selection.set(id, source);
  };
  const hot = snapshot.documents.find((document) => document.sourcePath === "00-System/Hot-Index.md");
  const memory = snapshot.documents.find((document) => document.sourcePath === "00-System/Memory-Index.md");
  for (const id of hot?.relatedIds ?? []) addSelected(id, "hot");
  for (const id of memory?.relatedIds ?? []) addSelected(id, "memory");
  for (const document of snapshot.documents.filter((item) => item.type === "BenchmarkAccount")) addSelected(document.stableId, "benchmark");
  for (const id of [...selection.keys()]) {
    const document = byId.get(id);
    if (document?.virtual) continue;
    for (const relatedId of document?.relatedIds ?? []) addSelected(relatedId, "linked");
  }

  const nodes = new Map();
  const edges = new Map();
  const addEdge = (source, target, type) => {
    const stableEdgeId = `${type}:${source}:${target}`;
    edges.set(stableEdgeId, { stableId: stableEdgeId, source, target, type });
  };
  for (const [id, selectionSource] of selection) {
    const document = byId.get(id);
    const category = categoryNode(document.category);
    nodes.set(category.stableId, category);
    const sourceParts = document.sourcePath?.split("/") ?? [];
    const groupPath = sourceParts.length > 2 ? sourceParts.slice(0, 2).join("/") : null;
    let parentId = category.stableId;
    if (groupPath) {
      const groupId = `group:${stableId(groupPath)}`;
      nodes.set(groupId, {
        stableId: groupId,
        type: "Group",
        title: sourceParts[1],
        category: document.category,
        sourcePath: groupPath,
        tags: [],
        stage: null,
        relatedIds: [],
        outboundLinks: [],
        inboundLinks: [],
        updatedAt: new Date(document.updatedAt).toISOString(),
        selectionSource: "linked",
      });
      addEdge(groupId, category.stableId, "belongs_to");
      parentId = groupId;
    }
    nodes.set(document.stableId, {
      stableId: document.stableId,
      type: document.type,
      title: document.title,
      category: document.category,
      sourcePath: document.sourcePath,
      tags: document.tags,
      stage: document.stage,
      relatedIds: document.relatedIds,
      outboundLinks: document.relatedIds,
      inboundLinks: document.inboundLinks,
      updatedAt: new Date(document.updatedAt).toISOString(),
      selectionSource,
    });
    addEdge(document.stableId, parentId, "belongs_to");
  }
  for (const [id] of selection) {
    const document = byId.get(id);
    if (document.virtual) continue;
    for (const target of document.relatedIds) {
      if (selection.has(target)) addEdge(document.stableId, target, "links_to");
    }
  }
  return {
    generatedAt: Date.now(),
    nodes: [...nodes.values()],
    edges: [...edges.values()],
    stats: {
      selectedDocuments: selection.size,
      nodes: nodes.size,
      links: [...edges.values()].filter((edge) => edge.type === "links_to").length,
    },
  };
}

const GRAPH_SOURCE_PRIORITY = { hot: 420, memory: 340, benchmark: 390, linked: 80 };
const GRAPH_TYPE_PRIORITY = {
  BenchmarkAccount: 180,
  Project: 150,
  KnowledgeCard: 140,
  Decision: 130,
  Plan: 115,
  Review: 100,
  Inspiration: 90,
  Business: 75,
  BenchmarkMaterial: 60,
  Content: 45,
  Document: 20,
};

function graphDocumentScore(node, degree) {
  return (GRAPH_SOURCE_PRIORITY[node.selectionSource] ?? 0)
    + (GRAPH_TYPE_PRIORITY[node.type] ?? 30)
    + Math.min(12, degree.get(node.stableId) ?? 0) * 42
    + Math.min(40, node.tags?.length ?? 0) * 2;
}

function selectKeyGraphDocuments(documents, graph, limit) {
  if (documents.length <= limit) return new Set(documents.map((node) => node.stableId));
  const degree = new Map();
  for (const edge of graph.edges.filter((item) => item.type === "links_to")) {
    degree.set(edge.source, (degree.get(edge.source) ?? 0) + 1);
    degree.set(edge.target, (degree.get(edge.target) ?? 0) + 1);
  }
  const ordered = [...documents].sort((left, right) => {
    const score = graphDocumentScore(right, degree) - graphDocumentScore(left, degree);
    if (score !== 0) return score;
    const updated = Date.parse(right.updatedAt) - Date.parse(left.updatedAt);
    if (updated !== 0) return updated;
    return left.sourcePath?.localeCompare(right.sourcePath ?? "", "zh-CN", { numeric: true }) ?? -1;
  });
  const selected = [];
  const selectedIds = new Set();
  const add = (node) => {
    if (selectedIds.has(node.stableId) || selected.length >= limit) return;
    selected.push(node);
    selectedIds.add(node.stableId);
  };
  // Preserve the explicit evidence sources before filling by score. The
  // recommended graph is a critical-path view, not a decorative survey of
  // every folder, so categories without a high-value node are not forced in.
  for (const source of ["hot", "memory", "benchmark"]) {
    const candidate = ordered.find((node) => node.selectionSource === source);
    if (candidate) add(candidate);
  }
  const perCategory = new Map();
  for (const node of selected) perCategory.set(node.category, (perCategory.get(node.category) ?? 0) + 1);
  for (const node of ordered) {
    if ((perCategory.get(node.category) ?? 0) >= 5) continue;
    const before = selected.length;
    add(node);
    if (selected.length > before) perCategory.set(node.category, (perCategory.get(node.category) ?? 0) + 1);
  }
  for (const node of ordered) add(node);
  return new Set(selected.map((node) => node.stableId));
}

function applyGraphFilters(graph, filters) {
  if (!filters || typeof filters !== "object" || Array.isArray(filters)) return graph;
  const categories = new Set(Array.isArray(filters.categories) ? filters.categories : []);
  const types = new Set(Array.isArray(filters.types) ? filters.types : []);
  const stages = new Set(Array.isArray(filters.stages) ? filters.stages : []);
  const sources = new Set(Array.isArray(filters.sources) ? filters.sources : []);
  const query = normalizedSearchText(filters.query);
  const linkedDocuments = new Set(graph.edges
    .filter((edge) => edge.type === "links_to")
    .flatMap((edge) => [edge.source, edge.target]));
  let documents = graph.nodes.filter((node) => node.type !== "Category" && node.type !== "Group")
    .filter((node) => categories.size === 0 || categories.has(node.category))
    .filter((node) => types.size === 0 || types.has(node.type))
    .filter((node) => stages.size === 0 || stages.has(node.stage))
    .filter((node) => sources.size === 0 || sources.has(node.selectionSource))
    .filter((node) => filters.focus !== "key" || node.selectionSource !== "linked")
    .filter((node) => filters.hideIsolated !== true || linkedDocuments.has(node.stableId))
    .filter((node) => !query || normalizedSearchText(`${node.title} ${node.tags.join(" ")} ${node.sourcePath ?? ""}`).includes(query));
  const requestedLimit = Number.isInteger(filters.maxDocuments)
    ? Math.max(8, Math.min(80, filters.maxDocuments))
    : filters.focus === "key" ? 24 : null;
  const keptDocuments = requestedLimit === null
    ? new Set(documents.map((node) => node.stableId))
    : selectKeyGraphDocuments(documents, graph, requestedLimit);
  documents = documents.filter((node) => keptDocuments.has(node.stableId));
  const belongsByChild = new Map(graph.edges.filter((edge) => edge.type === "belongs_to").map((edge) => [edge.source, edge]));
  const keptBelongs = new Map();
  const parentIds = new Set();
  for (const documentId of keptDocuments) {
    let childId = documentId;
    while (belongsByChild.has(childId)) {
      const edge = belongsByChild.get(childId);
      keptBelongs.set(edge.stableId, edge);
      parentIds.add(edge.target);
      childId = edge.target;
    }
  }
  const keptLinks = graph.edges.filter((edge) => edge.type === "links_to" && keptDocuments.has(edge.source) && keptDocuments.has(edge.target));
  const keptEdges = [...keptBelongs.values(), ...keptLinks];
  const keptNodes = graph.nodes.filter((node) => keptDocuments.has(node.stableId) || parentIds.has(node.stableId));
  return {
    ...graph,
    nodes: keptNodes,
    edges: keptEdges,
    stats: {
      selectedDocuments: documents.length,
      nodes: keptNodes.length,
      links: keptEdges.filter((edge) => edge.type === "links_to").length,
    },
  };
}

async function scanWithWorker(root) {
  return await new Promise((resolveScan, rejectScan) => {
    const worker = new Worker(new URL("./knowledge-index-worker.mjs", import.meta.url), { workerData: { root } });
    worker.once("message", (message) => {
      if (message?.ok) resolveScan(message.documents);
      else rejectScan(new Error(message?.error ?? "Knowledge index worker failed"));
    });
    worker.once("error", rejectScan);
    worker.once("exit", (code) => {
      if (code !== 0) rejectScan(new Error(`Knowledge index worker exited with code ${code}`));
    });
  });
}

export async function scanKnowledgeRoot(root) {
  const resolvedRoot = await realpath(root);
  const files = await listMarkdownFiles(resolvedRoot);
  return await Promise.all(files.map((file) => parseDocument(resolvedRoot, file)));
}

async function persistSnapshot(indexPath, snapshot) {
  await mkdir(path.dirname(indexPath), { recursive: true });
  const temporary = `${indexPath}.${process.pid}.tmp`;
  await writeFile(temporary, JSON.stringify(snapshot), "utf8");
  await rename(temporary, indexPath);
}

export class KnowledgeIndexService {
  constructor({
    root = DEFAULT_KNOWLEDGE_ROOT,
    indexPath = DEFAULT_INDEX_PATH,
    databasePath = DEFAULT_DATABASE_PATH,
    useWorker = false,
  } = {}) {
    this.requestedRoot = root;
    this.indexPath = indexPath;
    this.databasePath = databasePath;
    this.useWorker = useWorker;
    this.root = null;
    this.actualByPath = new Map();
    this.snapshot = null;
    this.graph = null;
    this.database = null;
    this.watcher = null;
    this.refreshTimer = null;
    this.pendingRefreshPaths = new Set();
    this.needsFullReconcile = false;
    this.listeners = new Set();
    this.refreshQueue = Promise.resolve();
    this.calibrationPromise = Promise.resolve();
  }

  async loadCachedProjection() {
    try {
      const cached = JSON.parse(await readFile(this.indexPath, "utf8"));
      if (cached?.schemaVersion !== 9 || cached.root !== this.root || !Array.isArray(cached.documents)) return false;
      const actual = cached.documents.filter((document) => document && document.virtual === false && typeof document.sourcePath === "string");
      this.actualByPath = new Map(actual.map((document) => [document.sourcePath, document]));
      this.snapshot = cached;
      this.graph = graphSnapshot(cached);
      if (this.database) syncSearchDatabase(this.database, cached.documents);
      return true;
    } catch (error) {
      if (error && typeof error === "object" && error.code === "ENOENT") return false;
      return false;
    }
  }

  async reconcileAll() {
    if (!this.root) throw new Error("Knowledge root is unavailable.");
    const parsed = this.useWorker ? await scanWithWorker(this.root) : await scanKnowledgeRoot(this.root);
    this.actualByPath = new Map(parsed.map((document) => [document.sourcePath, document]));
    await this.rebuildProjection();
    return this.snapshot;
  }

  async initialize({ backgroundCalibration = false } = {}) {
    if (typeof this.requestedRoot !== "string" || !this.requestedRoot) throw new Error("Knowledge root is not configured.");
    if (typeof this.indexPath !== "string" || typeof this.databasePath !== "string") throw new Error("Knowledge index paths are not configured.");
    this.root = await realpath(this.requestedRoot);
    await mkdir(path.dirname(this.databasePath), { recursive: true });
    this.database?.close();
    this.database = openSearchDatabase(this.databasePath);
    const restored = await this.loadCachedProjection();
    if (!restored || !backgroundCalibration) {
      await this.reconcileAll();
    } else {
      this.calibrationPromise = this.reconcileAll().catch((error) => {
        console.error("JiMu background knowledge calibration failed:", diagnosticKind(error));
      });
    }
    return this.snapshot;
  }

  async whenIdle() {
    await this.calibrationPromise;
    await this.refreshQueue;
  }

  async rebuildProjection() {
    this.snapshot = await buildProjection(this.actualByPath, this.root, this.indexPath);
    this.graph = graphSnapshot(this.snapshot);
    if (this.database) syncSearchDatabase(this.database, this.snapshot.documents);
    await persistSnapshot(this.indexPath, this.snapshot);
    for (const listener of this.listeners) listener(this.snapshot);
  }

  getClientSnapshot() {
    if (!this.snapshot) throw new Error("Knowledge index is unavailable.");
    return {
      ...this.snapshot,
      databasePath: this.databasePath,
      documents: this.snapshot.documents.map(toClientDocument),
    };
  }

  listCards(value = {}) {
    if (!this.snapshot) throw new Error("Knowledge index is unavailable.");
    const request = value && typeof value === "object" && !Array.isArray(value) ? value : {};
    const category = typeof request.category === "string" ? request.category : "all";
    const sort = request.sort === "recent" ? "recent" : "number";
    const byId = new Map(this.snapshot.documents.map((document) => [document.stableId, document]));
    return this.snapshot.archiveCardIds
      .map((id) => byId.get(id))
      .filter(Boolean)
      .filter((document) => category === "all" || document.category === category)
      .sort((a, b) => sort === "recent"
        ? b.updatedAt - a.updatedAt
        : a.order.localeCompare(b.order, "zh-CN", { numeric: true }))
      .map(toClientDocument);
  }

  search(value = {}) {
    if (!this.snapshot || !this.database) throw new Error("Knowledge search index is unavailable.");
    const request = normalizeSearchRequest(value);
    const byId = new Map(this.snapshot.documents.map((document) => [document.stableId, document]));
    const candidates = request.query ? ftsCandidates(this.database, request.query) : [...byId.keys()];
    const candidateSet = new Set(candidates);
    if (request.query && candidateSet.size < 80) {
      for (const document of this.snapshot.documents) candidateSet.add(document.stableId);
    }
    const hits = [...candidateSet]
      .map((id) => byId.get(id))
      .filter(Boolean)
      .filter((document) => matchesSearchFilters(document, request))
      .map((document) => ({
        document: toClientDocument(document),
        ...scoreDocument(document, request.query),
        snippet: searchSnippet(document, request.query),
      }))
      .filter((hit) => !request.query || hit.score >= 8)
      .sort((a, b) => request.sort === "recent"
        ? b.document.updatedAt - a.document.updatedAt
        : b.score - a.score || b.document.updatedAt - a.document.updatedAt);
    return {
      status: "ready",
      query: request.query,
      total: hits.length,
      hits: hits.slice(0, request.limit),
      indexedAt: this.snapshot.indexedAt,
    };
  }

  documentBySourcePath(sourcePath) {
    return this.snapshot?.documents.find((document) => document.sourcePath === sourcePath) ?? null;
  }

  async safeExistingPath(relativePath) {
    if (!this.root) throw new Error("Knowledge root is unavailable.");
    const rawPath = relativePath.replaceAll("\\", "/");
    if (rawPath.startsWith("/") || path.isAbsolute(relativePath)) throw new Error("Knowledge path escapes the active root.");
    const normalized = path.posix.normalize(rawPath);
    if (!normalized || normalized === ".." || normalized.startsWith("../") || path.posix.isAbsolute(normalized)) {
      throw new Error("Knowledge path escapes the active root.");
    }
    const candidate = path.resolve(this.root, ...normalized.split("/"));
    if (!isInside(this.root, candidate)) throw new Error("Knowledge path escapes the active root.");
    const info = await lstat(candidate);
    if (info.isSymbolicLink()) throw new Error("Symbolic links are not readable through JiMu.");
    const resolved = await realpath(candidate);
    if (!isInside(this.root, resolved)) throw new Error("Knowledge path resolves outside the active root.");
    return { absolutePath: resolved, relativePath: path.relative(this.root, resolved).split(path.sep).join("/"), info };
  }

  async readDocument(value) {
    if (!this.snapshot) throw new Error("Knowledge index is unavailable.");
    const request = value && typeof value === "object" && !Array.isArray(value) ? value : {};
    const sourcePath = typeof request.sourcePath === "string" ? request.sourcePath : "";
    const stableDocument = typeof request.stableId === "string"
      ? this.snapshot.documents.find((item) => item.stableId === request.stableId)
      : null;
    const document = stableDocument ?? this.documentBySourcePath(sourcePath);
    if (!document) throw new Error("The requested Markdown document is not indexed.");
    if (document.virtual) {
      const markdown = [
        `# ${document.title}`,
        "",
        document.excerpt,
        "",
        ...document.sections.flatMap((section) => [
          `${"#".repeat(Math.max(2, section.level ?? 2))} ${section.title}`,
          "",
          ...section.paragraphs.flatMap((paragraph) => [paragraph, ""]),
          ...section.bullets.map((bullet) => `- ${bullet}`),
          "",
        ]),
      ].join("\n");
      return { ...toClientDocument(document), markdown };
    }
    const resolved = await this.safeExistingPath(document.sourcePath);
    if (path.extname(resolved.relativePath).toLocaleLowerCase() !== ".md") throw new Error("The requested file is not Markdown.");
    return { ...toClientDocument(document), markdown: await readFile(resolved.absolutePath, "utf8") };
  }

  findWikiTarget(rawTarget) {
    if (!this.snapshot) return null;
    const target = withoutMarkdownExtension(normalizeTarget(rawTarget).replace(/^\/+/, "").toLocaleLowerCase("zh-CN"));
    const actual = this.snapshot.documents.filter((document) => !document.virtual);
    const direct = actual.find((document) => withoutMarkdownExtension(document.sourcePath.toLocaleLowerCase("zh-CN")) === target);
    if (direct) return direct;
    const stem = withoutMarkdownExtension(path.posix.basename(target));
    const matches = actual.filter((document) => withoutMarkdownExtension(path.posix.basename(document.sourcePath.toLocaleLowerCase("zh-CN"))) === stem);
    return matches.length === 1 ? matches[0] : null;
  }

  async resolveLink(value) {
    if (!this.root || !this.snapshot) throw new Error("Knowledge index is unavailable.");
    const request = value && typeof value === "object" && !Array.isArray(value) ? value : {};
    const fromPath = typeof request.fromPath === "string" ? request.fromPath : "";
    const href = typeof request.href === "string" ? request.href.trim() : "";
    if (!this.documentBySourcePath(fromPath) || !href) return { kind: "missing", href, reason: "invalid-request" };
    if (/^(?:https?:|mailto:)/i.test(href)) return { kind: "external", href };
    if (/^(?:javascript:|data:|vbscript:|file:|jimu-app:|jimu-asset:)/i.test(href)) return { kind: "blocked", href, reason: "unsupported-protocol" };
    const wiki = href.startsWith("jimu-wiki:");
    const decodedHref = wiki ? normalizeTarget(href.slice("jimu-wiki:".length)) : normalizeTarget(href);
    const hashIndex = decodedHref.indexOf("#");
    const rawPath = (hashIndex >= 0 ? decodedHref.slice(0, hashIndex) : decodedHref).split("?")[0];
    const anchor = hashIndex >= 0 ? normalizeTarget(decodedHref.slice(hashIndex + 1)) : "";
    if (!rawPath) {
      const current = this.documentBySourcePath(fromPath);
      const valid = !anchor || current.sections.some((section) => section.id === slugify(anchor, anchor));
      return valid
        ? { kind: "anchor", href, sourcePath: fromPath, stableId: current.stableId, anchor: slugify(anchor, anchor) }
        : { kind: "missing", href, sourcePath: fromPath, reason: "anchor-not-found", anchor };
    }
    if (!wiki && /^\/(?:Users|Volumes|private|tmp|Applications|System|Library|opt|etc|var|usr|bin|sbin|dev)(?:\/|$)/i.test(rawPath)) {
      return { kind: "blocked", href, reason: "absolute-path-outside-root" };
    }
    let relativeTarget;
    if (wiki) {
      const document = this.findWikiTarget(rawPath);
      if (!document) return { kind: "missing", href, reason: "document-not-found" };
      relativeTarget = document.sourcePath;
    } else {
      relativeTarget = rawPath.startsWith("/")
        ? path.posix.normalize(rawPath.slice(1))
        : path.posix.normalize(path.posix.join(path.posix.dirname(fromPath), rawPath));
      if (relativeTarget === ".." || relativeTarget.startsWith("../") || path.posix.isAbsolute(relativeTarget)) {
        return { kind: "blocked", href, reason: "path-escape" };
      }
    }
    const candidates = [relativeTarget];
    if (!path.posix.extname(relativeTarget)) candidates.push(`${relativeTarget}.md`, `${relativeTarget}/README.md`);
    let resolved = null;
    for (const candidate of candidates) {
      try {
        resolved = await this.safeExistingPath(candidate);
        if (resolved.info.isDirectory()) continue;
        break;
      } catch (error) {
        if (error && typeof error === "object" && error.code === "ENOENT") continue;
        return { kind: "blocked", href, reason: error instanceof Error ? error.message : String(error) };
      }
    }
    if (!resolved || resolved.info.isDirectory()) return { kind: "missing", href, reason: "document-not-found" };
    const extension = path.extname(resolved.relativePath).toLocaleLowerCase();
    if (extension === ".md") {
      const target = this.documentBySourcePath(resolved.relativePath);
      if (!target) return { kind: "missing", href, reason: "index-stale", sourcePath: resolved.relativePath };
      const targetAnchor = anchor ? slugify(anchor, anchor) : "";
      if (targetAnchor && !target.sections.some((section) => section.id === targetAnchor)) {
        return { kind: "missing", href, reason: "anchor-not-found", sourcePath: target.sourcePath, stableId: target.stableId, anchor: targetAnchor };
      }
      return { kind: anchor ? "anchor" : "document", href, sourcePath: target.sourcePath, stableId: target.stableId, anchor: targetAnchor || null };
    }
    if (ASSET_EXTENSIONS.has(extension)) {
      const token = Buffer.from(resolved.relativePath, "utf8").toString("base64url");
      return { kind: "localAsset", href, sourcePath: resolved.relativePath, assetUrl: `jimu-asset://local/${token}` };
    }
    return { kind: "localFile", href, sourcePath: resolved.relativePath };
  }

  async resolveAssetToken(token) {
    let relativePath;
    try {
      relativePath = Buffer.from(token, "base64url").toString("utf8");
    } catch {
      throw new Error("Invalid JiMu asset token.");
    }
    const resolved = await this.safeExistingPath(relativePath);
    if (!ASSET_EXTENSIONS.has(path.extname(resolved.relativePath).toLocaleLowerCase())) throw new Error("JiMu asset type is not allowed.");
    return resolved.absolutePath;
  }

  getGraph(filters) {
    if (!this.graph) throw new Error("Knowledge graph is unavailable.");
    return applyGraphFilters(this.graph, filters);
  }

  async refreshRelative(relativeName, { rebuild = true } = {}) {
    if (!this.root || !relativeName) return;
    const relativePath = relativeName.split(path.sep).join("/");
    if (relativePath.split("/").some(isHiddenOrIgnored)) return;
    const absolute = path.resolve(this.root, relativeName);
    if (!isInside(this.root, absolute)) return;
    if (path.extname(relativePath).toLocaleLowerCase() !== ".md") return;
    try {
      const info = await lstat(absolute);
      if (info.isSymbolicLink() || !info.isFile()) {
        this.actualByPath.delete(relativePath);
      } else {
        const document = await parseDocument(this.root, absolute);
        this.actualByPath.set(document.sourcePath, document);
      }
    } catch (error) {
      if (error && typeof error === "object" && error.code === "ENOENT") this.actualByPath.delete(relativePath);
      else throw error;
    }
    if (rebuild) await this.rebuildProjection();
  }

  startWatching() {
    if (!this.root || this.watcher) return;
    this.watcher = watch(this.root, { recursive: true }, (_eventType, filename) => {
      if (!filename) this.needsFullReconcile = true;
      else this.pendingRefreshPaths.add(filename);
      clearTimeout(this.refreshTimer);
      this.refreshTimer = setTimeout(() => {
        this.refreshQueue = this.refreshQueue
          .then(async () => {
            const full = this.needsFullReconcile;
            const paths = [...this.pendingRefreshPaths];
            this.needsFullReconcile = false;
            this.pendingRefreshPaths.clear();
            if (full) {
              await this.reconcileAll();
              return;
            }
            for (const relativeName of paths) await this.refreshRelative(relativeName, { rebuild: false });
            if (paths.length > 0) await this.rebuildProjection();
          })
          .catch((error) => console.error("JiMu incremental index refresh failed:", diagnosticKind(error)));
      }, 180);
    });
  }

  subscribe(listener) {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  close() {
    clearTimeout(this.refreshTimer);
    this.pendingRefreshPaths.clear();
    this.watcher?.close();
    this.watcher = null;
    this.database?.close();
    this.database = null;
  }
}

async function runCli() {
  const service = new KnowledgeIndexService();
  const snapshot = await service.initialize();
  console.log(JSON.stringify({
    stats: snapshot.stats,
  }, null, 2));
  service.close();
}

if (process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url) {
  runCli().catch((error) => {
    console.error(`JiMu knowledge indexing failed: ${diagnosticKind(error)}`);
    process.exitCode = 1;
  });
}
