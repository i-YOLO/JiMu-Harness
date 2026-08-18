import { access, lstat, mkdir } from "node:fs/promises";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import path from "node:path";
import { KNOWLEDGE_STANDARD_DIRECTORIES } from "../../jimu-ui-preview/shared/knowledge-schema.mjs";

const run = promisify(execFile);

async function stripIfPresent(file) {
  try {
    await access(file);
  } catch {
    return;
  }
  await run("/usr/bin/strip", ["-S", file]);
}

export async function ensureKnowledgeTemplateDirectories(resourcesRoot) {
  const templateRoot = path.join(resourcesRoot, "jimu-knowledge-template");
  await access(path.join(templateRoot, "jimu-knowledge.json"));
  await Promise.all(KNOWLEDGE_STANDARD_DIRECTORIES.map(async (directory) => {
    const target = path.join(templateRoot, directory);
    await mkdir(target, { recursive: true });
    const info = await lstat(target);
    if (!info.isDirectory() || info.isSymbolicLink()) throw new Error(`Packaged Knowledge template has an invalid directory: ${directory}`);
  }));
}

export default async function afterPack(context) {
  if (context.electronPlatformName !== "darwin") return;
  const resourcesRoot = path.join(context.appOutDir, `${context.packager.appInfo.productFilename}.app`, "Contents", "Resources");
  await ensureKnowledgeTemplateDirectories(resourcesRoot);
  const appRoot = path.join(resourcesRoot, "app");
  const nativeRoot = path.join(appRoot, "node_modules", "node-pty", "build", "Release");
  await Promise.all([
    stripIfPresent(path.join(nativeRoot, "pty.node")),
    stripIfPresent(path.join(nativeRoot, "spawn-helper")),
  ]);
}
