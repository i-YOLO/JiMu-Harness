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
import { ensureKnowledgeTemplateDirectories } from "../scripts/after-pack.mjs";

const desktopRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const repoRoot = path.resolve(desktopRoot, "../..");
const run = promisify(execFile);

test("desktop shell keeps the approved macOS and Electron security posture", async () => {
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
  assert.equal(manifest.build.asar, false);
  assert.ok(manifest.build.files.includes("config/**/*"));
});

test("the approved JiMu icon source remains byte-for-byte unchanged", async () => {
  const source = await readFile(path.join(repoRoot, "apps/jimu-ui-preview/public/assets/jimu-icon.png"));
  assert.equal(createHash("sha256").update(source).digest("hex"), "e73dce26b35b4c8bf2fea5e3dc38fd6a4356ed13958449338277b5f0aba906f1");
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
