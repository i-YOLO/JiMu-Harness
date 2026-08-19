import { spawnSync } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { _electron as electron } from "playwright";
import { waitForHarnessReady, waitForPluginInventory } from "../tests/electron-ready.mjs";
import { createPluginRegistryFixture, FIXTURE_PLUGIN_NAME } from "../tests/plugin-registry-fixture.mjs";

const appRoot = path.resolve(fileURLToPath(new URL("..", import.meta.url)));
const requestedTargetArgument = process.argv[2] === "--" ? process.argv[3] : process.argv[2];
const requestedTarget = requestedTargetArgument === undefined ? undefined : path.resolve(requestedTargetArgument);
const executable = process.platform === "win32"
  ? (requestedTarget ?? path.join(appRoot, "release", "win-unpacked", "JiMu.exe"))
  : path.join(requestedTarget ?? path.join(appRoot, "release", "mac-arm64", "JiMu.app"), "Contents", "MacOS", "JiMu");
const resourcesRoot = process.platform === "win32"
  ? path.join(path.dirname(executable), "resources")
  : path.resolve(executable, "..", "..", "Resources");
const packagedPnpm = path.join(resourcesRoot, "app", "node_modules", "pnpm", "bin", "pnpm.mjs");
const userData = await mkdtemp(path.join(os.tmpdir(), "jimu-packaged-smoke-"));
const systemPath = process.platform === "win32"
  ? [
      process.env.SystemRoot,
      process.env.SystemRoot && path.join(process.env.SystemRoot, "System32"),
      process.env.SystemRoot && path.join(process.env.SystemRoot, "System32", "Wbem"),
      process.env.SystemRoot && path.join(process.env.SystemRoot, "System32", "WindowsPowerShell", "v1.0"),
    ].filter(Boolean).join(path.delimiter)
  : "/usr/bin:/bin:/usr/sbin:/sbin";
const baseEnvironment = {
  ...process.env,
  PATH: systemPath,
  JIMU_USER_DATA_DIR: userData,
  JIMU_KNOWLEDGE_ROOT: "",
  DSH_TELEMETRY_DISABLED: "1",
};

let electronApp;
let registry;
let packagedPnpmVersion = "";
try {
  const pnpmResult = spawnSync(executable, [packagedPnpm, "--version"], {
    encoding: "utf8",
    env: { ...baseEnvironment, ELECTRON_RUN_AS_NODE: "1" },
    windowsHide: true,
  });
  if (pnpmResult.error) throw pnpmResult.error;
  if (pnpmResult.status !== 0 || pnpmResult.stdout.trim() !== "11.7.0") {
    throw new Error(`Packaged pnpm self-check failed (${String(pnpmResult.status)}): ${pnpmResult.stdout}${pnpmResult.stderr}`);
  }
  packagedPnpmVersion = pnpmResult.stdout.trim();
  registry = await createPluginRegistryFixture();
  const isolatedEnvironment = {
    ...baseEnvironment,
    JIMU_PLUGIN_CATALOG_URL: registry.catalogUrl,
    JIMU_PLUGIN_REGISTRY_URL: registry.registryUrl,
  };
  electronApp = await electron.launch({
    executablePath: executable,
    env: isolatedEnvironment,
  });
  const page = await electronApp.firstWindow();
  await waitForHarnessReady(page);
  await waitForPluginInventory(page);
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

  const catalog = await page.evaluate(() => window.jimu.plugins.searchCatalog({ query: "jimu-fixture-plugin", refresh: true }));
  if (catalog.source !== "online" || catalog.items?.[0]?.name !== FIXTURE_PLUGIN_NAME) {
    throw new Error(`Packaged plugin catalog did not return the local fixture: ${JSON.stringify(catalog)}`);
  }
  const proposal = await page.evaluate((source) => window.jimu.plugins.inspect({ source }), FIXTURE_PLUGIN_NAME);
  let lifecycle = await page.evaluate((proposalId) => window.jimu.plugins.install({ proposalId, allowedBuildPackages: [] }), proposal.proposalId);
  let installed = lifecycle.installedPackages?.find(plugin => plugin.packageName === FIXTURE_PLUGIN_NAME);
  if (installed?.enabled !== true) throw new Error(`Packaged plugin install did not enable ${FIXTURE_PLUGIN_NAME}`);

  lifecycle = await page.evaluate((packageName) => window.jimu.plugins.setEnabled({ packageName, enabled: false }), FIXTURE_PLUGIN_NAME);
  installed = lifecycle.installedPackages?.find(plugin => plugin.packageName === FIXTURE_PLUGIN_NAME);
  if (installed?.enabled !== false) throw new Error(`Packaged plugin disable did not persist for ${FIXTURE_PLUGIN_NAME}`);

  lifecycle = await page.evaluate((packageName) => window.jimu.plugins.setEnabled({ packageName, enabled: true }), FIXTURE_PLUGIN_NAME);
  installed = lifecycle.installedPackages?.find(plugin => plugin.packageName === FIXTURE_PLUGIN_NAME);
  if (installed?.enabled !== true) throw new Error(`Packaged plugin re-enable did not persist for ${FIXTURE_PLUGIN_NAME}`);

  lifecycle = await page.evaluate((packageName) => window.jimu.plugins.uninstall({ packageName }), FIXTURE_PLUGIN_NAME);
  if (lifecycle.installedPackages?.some(plugin => plugin.packageName === FIXTURE_PLUGIN_NAME)) {
    throw new Error(`Packaged plugin uninstall left ${FIXTURE_PLUGIN_NAME} installed`);
  }
  console.log(`Packaged JiMu ${result.platform} smoke test passed with ${result.plugins.entries.length} plugin entries and pnpm ${packagedPnpmVersion}.`);
} finally {
  await electronApp?.close().catch(() => {});
  await registry?.close();
  await rm(userData, { recursive: true, force: true });
}
