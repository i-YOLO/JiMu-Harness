import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { _electron as electron } from "playwright";

const appRoot = path.resolve(fileURLToPath(new URL("..", import.meta.url)));
const requestedTarget = process.argv[2] === undefined ? undefined : path.resolve(process.argv[2]);
const executable = process.platform === "win32"
  ? (requestedTarget ?? path.join(appRoot, "release", "win-unpacked", "JiMu.exe"))
  : path.join(requestedTarget ?? path.join(appRoot, "release", "mac-arm64", "JiMu.app"), "Contents", "MacOS", "JiMu");
const userData = await mkdtemp(path.join(os.tmpdir(), "jimu-packaged-smoke-"));

let electronApp;
try {
  electronApp = await electron.launch({
    executablePath: executable,
    env: {
      ...process.env,
      JIMU_USER_DATA_DIR: userData,
      JIMU_KNOWLEDGE_ROOT: "",
      DSH_TELEMETRY_DISABLED: "1",
    },
  });
  const page = await electronApp.firstWindow();
  await page.waitForFunction(async () => (await window.jimu.harness.status()).phase === "ready", null, { timeout: 60_000 });
  await page.waitForFunction(async () => (await window.jimu.plugins.snapshot()).entries.length > 0, null, { timeout: 30_000 });
  const result = await page.evaluate(async () => ({
    platform: window.jimu.platform,
    harness: await window.jimu.harness.status(),
    setup: await window.jimu.knowledge.getSetup(),
    plugins: await window.jimu.plugins.snapshot(),
  }));
  if (result.setup.phase !== "unconfigured") throw new Error(`Expected unconfigured Knowledge, received ${result.setup.phase}`);
  if (!Array.isArray(result.plugins.entries) || result.plugins.entries.length === 0) {
    throw new Error(`Packaged Harness plugin inventory is empty (phase ${String(result.plugins.harnessPhase)}, groups ${String(result.plugins.groups?.length ?? 0)}): ${String(result.harness.error ?? "no diagnostic")}`);
  }
  const expectedPlatform = process.platform === "win32" ? "Windows" : "macOS";
  if (result.platform !== expectedPlatform) throw new Error(`Expected ${expectedPlatform}, received ${String(result.platform)}`);
  const entryByLeafId = id => result.plugins.entries.find(entry => entry.entryId.split(":").at(-1) === id);
  // The web profile owns its model-facing tool rows inside per-session agent
  // presets. The host inventory therefore proves the platform switch at the
  // executor boundary, where exactly one sandboxed shell must be active.
  const enabledShell = process.platform === "win32" ? "pwsh-sandbox" : "bash-sandbox";
  const disabledShell = process.platform === "win32" ? "bash-sandbox" : "pwsh-sandbox";
  const shellDiagnostic = result.plugins.entries
    .filter(entry => entry.entryId.includes("bash") || entry.entryId.includes("pwsh"))
    .map(entry => `${entry.entryId}=${String(entry.enabled)}:${String(entry.fiberPhase)}`)
    .join(", ");
  if (entryByLeafId(enabledShell)?.enabled !== true || entryByLeafId(enabledShell)?.fiberPhase !== "active") {
    throw new Error(`Expected ${enabledShell} to be enabled; shell inventory: ${shellDiagnostic || "empty"}`);
  }
  if (entryByLeafId(disabledShell)?.enabled !== false) {
    throw new Error(`Expected ${disabledShell} to be disabled; shell inventory: ${shellDiagnostic || "empty"}`);
  }
  console.log(`Packaged JiMu ${result.platform} smoke test passed with ${result.plugins.entries.length} plugin entries.`);
} finally {
  await electronApp?.close().catch(() => {});
  await rm(userData, { recursive: true, force: true });
}
