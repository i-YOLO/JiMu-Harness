import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { lstat, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

import { KNOWLEDGE_TEMPLATE_DIRECTORIES } from "../../jimu-ui-preview/shared/knowledge-schema.mjs";
import {
  ensureKnowledgeTemplateDirectories,
  pruneNodePtyPrebuilds,
  verifyWindowsNodePty,
} from "../scripts/after-pack.mjs";

const desktopRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const repoRoot = path.resolve(desktopRoot, "../..");
const run = promisify(execFile);

test("desktop shell keeps the approved cross-platform Electron security posture", async () => {
  const [html, main, preload, factoryService, manifest, overlay, policy, pluginManager, styles] = await Promise.all([
    readFile(path.join(desktopRoot, "index.html"), "utf8"),
    readFile(path.join(desktopRoot, "src/main/index.ts"), "utf8"),
    readFile(path.join(desktopRoot, "src/preload/index.ts"), "utf8"),
    readFile(path.join(repoRoot, "apps/jimu-ui-preview/scripts/factory-service.mjs"), "utf8"),
    readFile(path.join(desktopRoot, "package.json"), "utf8").then(JSON.parse),
    readFile(path.join(desktopRoot, "config/desktop.cordis.yml"), "utf8"),
    readFile(path.join(desktopRoot, "config/plugin-policy.json"), "utf8"),
    readFile(path.join(desktopRoot, "src/main/plugin-manager.ts"), "utf8"),
    readFile(path.join(repoRoot, "apps/jimu-ui-preview/src/styles.css"), "utf8"),
  ]);
  assert.match(html, /connect-src 'none'/);
  assert.match(html, /object-src 'none'/);
  assert.match(html, /frame-src 'none'/);
  assert.match(main, /contextIsolation: true/);
  assert.match(main, /nodeIntegration: false/);
  assert.match(main, /sandbox: true/);
  assert.match(main, /setWindowOpenHandler\(\(\) => \(\{ action: 'deny' \}\)\)/);
  assert.match(main, /scheme: 'jimu-app'/);
  assert.match(main, /scheme: 'jimu-plugin'/);
  assert.match(main, /scheme: 'jimu-asset'/);
  assert.match(main, /assertTrustedEvent\(event\)/);
  assert.match(main, /jimu:factory:snapshot/);
  assert.match(main, /jimu:factory:import-assets/);
  assert.match(preload, /factory:\s*\{/);
  assert.match(preload, /plugins:\s*\{/);
  assert.match(preload, /onboarding:\s*\{/);
  assert.match(preload, /jimu:onboarding:test-deepseek/);
  assert.match(preload, /jimu:plugins:apply-toggles/);
  assert.match(preload, /process\.platform === 'win32' \? 'Windows' : 'macOS'/);
  assert.doesNotMatch(preload, /require\s*\(|node:fs|from ['"]fs['"]/);
  assert.match(factoryService, /FACTORY_DIRECTORY = "08-自媒体工厂"/);
  assert.match(factoryService, /if \(!normalized\.startsWith\(`\$\{FACTORY_DIRECTORY\}\/`\)\) throw new Error\("只允许访问自媒体工厂目录。"\)/);
  assert.match(factoryService, /if \(!isInside\(this\.factoryRoot, resolved\)\) throw new Error\("工厂路径越过真实目录边界。"\)/);
  assert.match(main, /movable: true/);
  assert.match(main, /resizable: true/);
  assert.match(main, /minimizable: true/);
  assert.match(main, /maximizable: true/);
  assert.match(main, /fullscreenable: true/);
  assert.match(main, /titleBarStyle: 'hiddenInset'/);
  assert.match(main, /trafficLightPosition: \{ x: 18, y: 18 \}/);
  assert.match(main, /titleBarStyle: 'hidden'/);
  assert.match(main, /titleBarOverlay: \{ color: '#0e0d2b', symbolColor: '#fff', height: 48 \}/);
  assert.match(main, /accelerator: 'CmdOrCtrl\+,'/);
  assert.match(main, /accelerator: 'CmdOrCtrl\+K'/);
  assert.match(main, /process\.env\.LOCALAPPDATA/);
  assert.match(main, /icon: applicationIconPath\(\)/);
  assert.match(main, /app\.dock\?\.setIcon\(applicationIconPath\(\)\)/);
  assert.match(main, /if \(!windowCreationReady\) return/);
  assert.match(main, /await initializeKnowledge\(\)\s+windowCreationReady = true\s+if \(mainWindow === null\) mainWindow = createWindow\(\)/s);
  assert.match(styles, /\.app-header\s*\{[^}]*-webkit-app-region: drag/s);
  assert.match(styles, /\.jimu-app\[data-desktop\] \.app-sidebar\s*\{[^}]*-webkit-app-region: drag/s);
  assert.match(styles, /\.app-header button,[^}]*-webkit-app-region: no-drag/s);
  assert.match(styles, /\.factory-module\s*\{[^}]*background-blend-mode: multiply/s);
  assert.doesNotMatch(main, /createServer|\.listen\s*\(/);
  assert.match(overlay, /id: web-startup\s+disabled: true/);
  assert.match(overlay, /id: webserver\s+disabled: true/);
  assert.match(overlay, /id: web-runtime\s+disabled: true/);
  assert.match(main, /patchFiles: \[desktopOverlay, pluginOverlayPath\]/);
  assert.match(main, /embedded: true/);
  assert.match(main, /revision !== current\.revision/);
  assert.match(main, /group\.management === 'toggleable'/);
  assert.match(main, /pluginOperationPending/);
  assert.match(main, /readKnowledgeTemplateLock/);
  assert.match(main, /AbortSignal\.timeout\(30_000\)/);
  assert.match(main, /settingsNs: 'llm-deepseek'/);
  assert.doesNotMatch(main, /credential:\s*\{[^}]*apiKey/s);
  assert.match(pluginManager, /rename\(temporary, path\)/);
  assert.match(pluginManager, /management: 'locked'/);
  assert.doesNotMatch(policy, /ui-settings-plugin-inventory|ui-settings-plugins|web-runtime|webserver/);
  assert.equal(manifest.build.appId, "com.iyolo.jimu");
  assert.deepEqual(manifest.build.mac.target[0].arch, ["arm64"]);
  assert.equal(manifest.build.mac.icon, "build/JiMu.icns");
  assert.deepEqual(manifest.build.win.target[0].arch, ["x64"]);
  assert.equal(manifest.build.win.target[0].target, "nsis");
  assert.equal(manifest.build.win.icon, "build/JiMu.ico");
  assert.equal(manifest.build.nsis.oneClick, true);
  assert.equal(manifest.build.nsis.perMachine, false);
  assert.equal(manifest.build.nsis.allowElevation, false);
  assert.equal(manifest.build.nsis.deleteAppDataOnUninstall, false);
  assert.equal(manifest.build.asar, false);
  assert.ok(manifest.build.files.includes("config/**/*"));
});

test("the approved JiMu icon source remains byte-for-byte unchanged", async () => {
  const source = await readFile(path.join(repoRoot, "apps/jimu-ui-preview/public/assets/jimu-icon.png"));
  assert.equal(createHash("sha256").update(source).digest("hex"), "e73dce26b35b4c8bf2fea5e3dc38fd6a4356ed13958449338277b5f0aba906f1");
  const windowsIcon = await readFile(path.join(desktopRoot, "build/JiMu.ico"));
  assert.equal(windowsIcon.readUInt16LE(0), 0);
  assert.equal(windowsIcon.readUInt16LE(2), 1);
  assert.equal(windowsIcon.readUInt16LE(4), 7);
  const sizes = Array.from({ length: 7 }, (_, index) => windowsIcon[6 + 16 * index] || 256);
  assert.deepEqual(sizes, [16, 24, 32, 48, 64, 128, 256]);
  for (let index = 0; index < 7; index += 1) {
    const imageOffset = windowsIcon.readUInt32LE(6 + 16 * index + 12);
    assert.equal(windowsIcon.subarray(imageOffset, imageOffset + 8).toString("hex"), "89504e470d0a1a0a");
  }
});

test("afterPack restores the complete empty Knowledge protocol and the release audit requires it", async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "jimu-packaged-template-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const templateRoot = path.join(root, "jimu-knowledge-template");
  await mkdir(templateRoot, { recursive: true });
  await writeFile(path.join(templateRoot, "jimu-knowledge.json"), "{}\n");

  await assert.rejects(
    run(process.execPath, [path.join(repoRoot, "scripts/jimu-release-audit.mjs"), "--root", root]),
    error => error?.stdout?.includes("knowledge-template-directory:"),
  );

  await ensureKnowledgeTemplateDirectories(root);
  for (const directory of KNOWLEDGE_TEMPLATE_DIRECTORIES) {
    const info = await lstat(path.join(templateRoot, directory));
    assert.equal(info.isDirectory(), true);
    assert.equal(info.isSymbolicLink(), false);
  }

  const audit = await run(process.execPath, [path.join(repoRoot, "scripts/jimu-release-audit.mjs"), "--root", root]);
  assert.match(audit.stdout, /0 failed rules/);
});

test("afterPack keeps only the requested node-pty prebuild and verifies ConPTY", async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "jimu-node-pty-prebuilds-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const expected = path.join(root, "prebuilds", "win32-x64");
  const discarded = path.join(root, "prebuilds", "darwin-arm64");
  await mkdir(path.join(expected, "conpty"), { recursive: true });
  await mkdir(discarded, { recursive: true });
  for (const file of ["pty.node", "conpty.node", "conpty_console_list.node", path.join("conpty", "conpty.dll"), path.join("conpty", "OpenConsole.exe")]) {
    await writeFile(path.join(expected, file), "native");
  }
  await writeFile(path.join(discarded, "pty.node"), "native");

  await pruneNodePtyPrebuilds(root, "win32-x64");
  await verifyWindowsNodePty(root);
  await assert.rejects(lstat(discarded), error => error?.code === "ENOENT");
});
