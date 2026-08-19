import { access, lstat, mkdir, readdir, rm } from "node:fs/promises";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import path from "node:path";
import { KNOWLEDGE_TEMPLATE_DIRECTORIES } from "../../jimu-ui-preview/shared/knowledge-schema.mjs";

const run = promisify(execFile);

async function stripIfPresent(file) {
  try {
    await access(file);
  } catch {
    return;
  }
  await run("/usr/bin/strip", ["-S", file]);
}

export async function pruneNodePtyPrebuilds(nodePtyRoot, expectedDirectory) {
  const prebuildsRoot = path.join(nodePtyRoot, "prebuilds");
  const directories = await readdir(prebuildsRoot, { withFileTypes: true });
  await Promise.all(directories
    .filter(entry => entry.isDirectory() && entry.name !== expectedDirectory)
    .map(entry => rm(path.join(prebuildsRoot, entry.name), { recursive: true, force: true })));
  await access(path.join(prebuildsRoot, expectedDirectory, "pty.node"));
}

export async function verifyWindowsNodePty(nodePtyRoot) {
  const nativeRoot = path.join(nodePtyRoot, "prebuilds", "win32-x64");
  await Promise.all([
    "pty.node",
    "conpty.node",
    "conpty_console_list.node",
    path.join("conpty", "conpty.dll"),
    path.join("conpty", "OpenConsole.exe"),
  ].map(file => access(path.join(nativeRoot, file))));
}

export async function ensureKnowledgeTemplateDirectories(resourcesRoot) {
  const templateRoot = path.join(resourcesRoot, "jimu-knowledge-template");
  await access(path.join(templateRoot, "jimu-knowledge.json"));
  await Promise.all(KNOWLEDGE_TEMPLATE_DIRECTORIES.map(async (directory) => {
    const target = path.join(templateRoot, directory);
    await mkdir(target, { recursive: true });
    const info = await lstat(target);
    if (!info.isDirectory() || info.isSymbolicLink()) throw new Error(`Packaged Knowledge template has an invalid directory: ${directory}`);
  }));
}

export default async function afterPack(context) {
  if (context.electronPlatformName !== "darwin" && context.electronPlatformName !== "win32") return;
  const resourcesRoot = context.electronPlatformName === "darwin"
    ? path.join(context.appOutDir, `${context.packager.appInfo.productFilename}.app`, "Contents", "Resources")
    : path.join(context.appOutDir, "resources");
  await ensureKnowledgeTemplateDirectories(resourcesRoot);
  const appRoot = path.join(resourcesRoot, "app");
  const nodePtyRoot = path.join(appRoot, "node_modules", "node-pty");
  const expectedPrebuild = context.electronPlatformName === "darwin" ? "darwin-arm64" : "win32-x64";
  await pruneNodePtyPrebuilds(nodePtyRoot, expectedPrebuild);
  if (context.electronPlatformName === "win32") {
    await verifyWindowsNodePty(nodePtyRoot);
    return;
  }
  const nativeRoot = path.join(nodePtyRoot, "build", "Release");
  await Promise.all([
    stripIfPresent(path.join(nativeRoot, "pty.node")),
    stripIfPresent(path.join(nativeRoot, "spawn-helper")),
  ]);
}
