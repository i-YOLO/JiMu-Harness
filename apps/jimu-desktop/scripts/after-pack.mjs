import { access } from "node:fs/promises";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import path from "node:path";

const run = promisify(execFile);

async function stripIfPresent(file) {
  try {
    await access(file);
  } catch {
    return;
  }
  await run("/usr/bin/strip", ["-S", file]);
}

export default async function afterPack(context) {
  if (context.electronPlatformName !== "darwin") return;
  const appRoot = path.join(context.appOutDir, `${context.packager.appInfo.productFilename}.app`, "Contents", "Resources", "app");
  const nativeRoot = path.join(appRoot, "node_modules", "node-pty", "build", "Release");
  await Promise.all([
    stripIfPresent(path.join(nativeRoot, "pty.node")),
    stripIfPresent(path.join(nativeRoot, "spawn-helper")),
  ]);
}
