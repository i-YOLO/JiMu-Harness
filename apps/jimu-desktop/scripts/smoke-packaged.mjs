import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { _electron as electron } from "playwright";

const appRoot = path.resolve(fileURLToPath(new URL("..", import.meta.url)));
const bundle = path.resolve(process.argv[2] ?? path.join(appRoot, "release", "mac-arm64", "JiMu.app"));
const executable = path.join(bundle, "Contents", "MacOS", "JiMu");
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
    harness: await window.jimu.harness.status(),
    setup: await window.jimu.knowledge.getSetup(),
    plugins: await window.jimu.plugins.snapshot(),
  }));
  if (result.setup.phase !== "unconfigured") throw new Error(`Expected unconfigured Knowledge, received ${result.setup.phase}`);
  if (!Array.isArray(result.plugins.entries) || result.plugins.entries.length === 0) {
    throw new Error(`Packaged Harness plugin inventory is empty (phase ${String(result.plugins.harnessPhase)}, groups ${String(result.plugins.groups?.length ?? 0)}): ${String(result.harness.error ?? "no diagnostic")}`);
  }
  console.log(`Packaged JiMu smoke test passed with ${result.plugins.entries.length} plugin entries.`);
} finally {
  await electronApp?.close().catch(() => {});
  await rm(userData, { recursive: true, force: true });
}
