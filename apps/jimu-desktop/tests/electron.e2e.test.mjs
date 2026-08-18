import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { _electron as electron } from "playwright";

import { createKnowledgeFixture } from "./knowledge-fixture.mjs";

const desktopRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

async function launch(t, environment = {}) {
  const userData = await mkdtemp(path.join(os.tmpdir(), "jimu-electron-state-"));
  const electronApp = await electron.launch({
    args: [desktopRoot],
    cwd: desktopRoot,
    env: {
      ...process.env,
      JIMU_USER_DATA_DIR: userData,
      DSH_TELEMETRY_DISABLED: "1",
      ...environment,
    },
  });
  t.after(async () => {
    await electronApp.close().catch(() => {});
    await rm(userData, { recursive: true, force: true });
  });
  const page = await electronApp.firstWindow();
  await page.waitForLoadState("domcontentloaded");
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.waitForFunction(async () => (await window.jimu.harness.status()).phase === "ready", null, { timeout: 60_000 });
  return { electronApp, page };
}

test("first launch keeps Harness available and shows setup without scanning a fallback directory", { timeout: 120_000 }, async (t) => {
  const { page } = await launch(t, { JIMU_KNOWLEDGE_ROOT: "" });
  const setup = await page.evaluate(() => window.jimu.knowledge.getSetup());
  assert.equal(setup.phase, "unconfigured");
  assert.equal("root" in setup, false);

  await page.getByRole("button", { name: /02 知识库/ }).click();
  await page.getByRole("heading", { name: "建立你的空白知识库" }).waitFor();
  await page.getByRole("button", { name: "打开 JiMu-Knowledge 仓库" }).waitFor();
  await page.getByText("JiMu 不会扫描用户主目录，也不会加载演示内容。").waitFor();

  await page.getByRole("button", { name: /05 设置/ }).click();
  await page.locator(".settings-nav-head h2").getByText("设置", { exact: true }).waitFor();
  await page.getByRole("button", { name: "插件" }).click();
  const plugins = await page.evaluate(() => window.jimu.plugins.snapshot());
  assert.ok(plugins.entries.length > 0);
  await page.locator(".plugin-manager").waitFor();
  await page.getByRole("tab", { name: "可选功能" }).waitFor();
});

test("an anonymous empty Schema 1 knowledge root indexes all public categories as zero", { timeout: 120_000 }, async (t) => {
  const fixture = await createKnowledgeFixture();
  t.after(() => rm(fixture.container, { recursive: true, force: true }));
  const { page } = await launch(t, { JIMU_KNOWLEDGE_ROOT: fixture.root });

  const setup = await page.evaluate(() => window.jimu.knowledge.getSetup());
  assert.equal(setup.phase, "ready");
  assert.equal(setup.compatibility, "schema-1");
  const snapshot = await page.evaluate(() => window.jimu.knowledge.getOverview());
  assert.equal(snapshot.categories.length, 8);
  assert.ok(snapshot.categories.every((category) => category.documentCount === 0 && category.cardCount === 0));

  await page.getByRole("button", { name: /02 知识库/ }).click();
  await page.getByRole("button", { name: /02 档案/ }).click();
  await page.getByText("知识卡片", { exact: true }).waitFor();
  await page.getByRole("heading", { name: "这个分类暂时没有可展示内容" }).waitFor();
});
