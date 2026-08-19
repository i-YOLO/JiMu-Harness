import { createHash } from "node:crypto";
import { mkdir, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  JIMU_KNOWLEDGE_SCHEMA_VERSION,
  KNOWLEDGE_CATEGORIES,
  KNOWLEDGE_STANDARD_DIRECTORIES,
  validateKnowledgeManifest,
} from "../../jimu-ui-preview/shared/knowledge-schema.mjs";

const appRoot = path.resolve(fileURLToPath(new URL("..", import.meta.url)));
const lock = JSON.parse(await readFile(path.join(appRoot, "config", "knowledge-template-lock.json"), "utf8"));
const outputRoot = path.join(appRoot, "build-cache", "jimu-knowledge-template");
const argumentsSet = new Set(process.argv.slice(2));
for (const argument of argumentsSet) if (argument !== "--release") throw new Error(`Unknown argument: ${argument}`);
const releaseMode = argumentsSet.has("--release");

function sha256(buffer) {
  return createHash("sha256").update(buffer).digest("hex");
}

function crc32(buffer) {
  let crc = 0xffffffff;
  for (const value of buffer) {
    crc ^= value;
    for (let bit = 0; bit < 8; bit += 1) crc = (crc >>> 1) ^ (0xedb88320 & -(crc & 1));
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function safeArchiveName(name) {
  const normalized = name.replaceAll("\\", "/");
  if (!normalized || normalized.startsWith("/") || normalized.split("/").includes("..")) throw new Error("Knowledge archive contains an unsafe path");
  return normalized;
}

async function extractStoredZip(archive, destination) {
  let offset = 0;
  while (offset + 4 <= archive.length && archive.readUInt32LE(offset) === 0x04034b50) {
    if (offset + 30 > archive.length) throw new Error("Knowledge archive has a truncated header");
    const flags = archive.readUInt16LE(offset + 6);
    const method = archive.readUInt16LE(offset + 8);
    const checksum = archive.readUInt32LE(offset + 14);
    const compressedSize = archive.readUInt32LE(offset + 18);
    const uncompressedSize = archive.readUInt32LE(offset + 22);
    const nameLength = archive.readUInt16LE(offset + 26);
    const extraLength = archive.readUInt16LE(offset + 28);
    if ((flags & 0x0008) !== 0 || method !== 0 || compressedSize !== uncompressedSize) throw new Error("Knowledge archive uses an unsupported ZIP encoding");
    const nameStart = offset + 30;
    const dataStart = nameStart + nameLength + extraLength;
    const dataEnd = dataStart + compressedSize;
    if (dataEnd > archive.length) throw new Error("Knowledge archive has truncated file data");
    const name = safeArchiveName(archive.subarray(nameStart, nameStart + nameLength).toString("utf8"));
    const data = archive.subarray(dataStart, dataEnd);
    if (crc32(data) !== checksum) throw new Error(`Knowledge archive CRC check failed for ${name}`);
    const target = path.join(destination, ...name.split("/"));
    if (name.endsWith("/")) await mkdir(target, { recursive: true });
    else {
      await mkdir(path.dirname(target), { recursive: true });
      await writeFile(target, data, { mode: 0o644 });
    }
    offset = dataEnd;
  }
  if (offset === 0) throw new Error("Knowledge archive contains no files");
}

async function validateExtractedTemplate(root) {
  const manifest = JSON.parse(await readFile(path.join(root, "jimu-knowledge.json"), "utf8"));
  const validation = validateKnowledgeManifest(manifest);
  if (!validation.ok || manifest.schemaVersion !== lock.schemaVersion || manifest.templateVersion !== lock.templateVersion) {
    throw new Error(validation.error ?? "Knowledge archive does not match the lock file");
  }
  if (manifest.schemaVersion !== JIMU_KNOWLEDGE_SCHEMA_VERSION) throw new Error("Knowledge schema version is unsupported");
  for (const directory of KNOWLEDGE_STANDARD_DIRECTORIES) {
    const info = await stat(path.join(root, directory));
    if (!info.isDirectory()) throw new Error(`Knowledge archive is missing ${directory}`);
  }
  for (const category of KNOWLEDGE_CATEGORIES) {
    const entries = await import("node:fs/promises").then(({ readdir }) => readdir(path.join(root, category.directory), { recursive: true }));
    if (entries.some((entry) => String(entry).toLocaleLowerCase("en-US").endsWith(".md"))) throw new Error(`Knowledge category ${category.id} is not empty`);
  }
}

async function loadArchive() {
  const localRoot = process.env.JIMU_KNOWLEDGE_TEMPLATE_DIR;
  if (localRoot && !releaseMode) {
    return await readFile(path.join(path.resolve(localRoot), "dist", `jimu-knowledge-${lock.templateVersion}.zip`));
  }
  const response = await fetch(lock.assetUrl, { redirect: "follow" });
  if (!response.ok) throw new Error(`Unable to download locked Knowledge release (${response.status})`);
  return Buffer.from(await response.arrayBuffer());
}

if (lock.repositoryUrl !== "https://github.com/i-YOLO/JiMu-Knowledge" || lock.schemaVersion !== 1) throw new Error("Knowledge lock file is invalid");
const archive = await loadArchive();
const digest = sha256(archive);
if (digest !== lock.sha256) throw new Error("Knowledge release SHA-256 does not match the lock file");

const temporary = path.join(appRoot, "build-cache", `.jimu-knowledge-template-${process.pid}`);
await rm(temporary, { recursive: true, force: true });
await mkdir(temporary, { recursive: true });
try {
  await extractStoredZip(archive, temporary);
  await validateExtractedTemplate(temporary);
  await rm(outputRoot, { recursive: true, force: true });
  await rename(temporary, outputRoot);
} catch (error) {
  await rm(temporary, { recursive: true, force: true });
  throw error;
}

console.log(`Prepared JiMu Knowledge ${lock.templateVersion} (${digest})`);
