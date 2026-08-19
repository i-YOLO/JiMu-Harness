import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { _electron as electron } from "playwright";

import { createKnowledgeFixture } from "./knowledge-fixture.mjs";

const desktopRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

async function launch(t, environment = {}, settings = null) {
  const userData = await mkdtemp(path.join(os.tmpdir(), "jimu-electron-state-"));
  if (settings) await writeFile(path.join(userData, "settings.json"), `${JSON.stringify(settings, null, 2)}\n`, { mode: 0o600 });
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

test("first launch keeps Harness available and gates the workspace behind native setup", { timeout: 120_000 }, async (t) => {
  const { page } = await launch(t, { JIMU_KNOWLEDGE_ROOT: "" });
  const setup = await page.evaluate(() => window.jimu.knowledge.getSetup());
  assert.equal(setup.phase, "unconfigured");
  assert.equal("root" in setup, false);

  const onboarding = await page.evaluate(() => window.jimu.onboarding.snapshot());
  assert.equal(onboarding.completed, false);
  assert.equal(onboarding.phase, "features");
  await page.getByRole("heading", { name: "你需要哪些 JiMu 能力？" }).waitFor();
  await page.getByRole("switch", { name: /对标博主库/ }).waitFor();
  await page.getByRole("switch", { name: /自媒体工厂/ }).waitFor();
  assert.equal(await page.locator(".app-sidebar").count(), 0);
  await page.getByRole("button", { name: /使用完整默认配置/ }).click();
  await page.getByRole("heading", { name: "安装你的本地知识库" }).waitFor();
  await page.getByRole("button", { name: /选择初始化位置/ }).waitFor();
  await page.getByRole("button", { name: /连接已有知识库/ }).waitFor();
  await page.getByRole("button", { name: "返回上一步" }).click();
  await page.getByRole("heading", { name: "你需要哪些 JiMu 能力？" }).waitFor();
  assert.equal(await page.getByRole("button", { name: "返回上一步" }).count(), 0);
  await page.getByText("点击下方能力卡片即可选择", { exact: true }).waitFor();
  await page.getByRole("button", { name: /按当前选择继续/ }).click();
  await page.getByRole("heading", { name: "安装你的本地知识库" }).waitFor();
  const plugins = await page.evaluate(() => window.jimu.plugins.snapshot());
  assert.ok(plugins.entries.length > 0);
});

test("credential setup can return to review the ready knowledge step", { timeout: 120_000 }, async (t) => {
  const fixture = await createKnowledgeFixture("jimu-onboarding-back-e2e-");
  t.after(() => rm(fixture.container, { recursive: true, force: true }));
  const { page } = await launch(t, { JIMU_KNOWLEDGE_ROOT: fixture.root }, {
    knowledgeRoot: fixture.root,
    knowledgeModules: { benchmarks: true, factory: true },
    knowledgeSource: "existing",
    deepSeekTested: false,
  });

  await page.getByRole("heading", { name: "连接 DeepSeek，开始使用 JiMu" }).waitFor();
  await page.getByRole("button", { name: "返回上一步" }).click();
  await page.getByRole("heading", { name: "安装你的本地知识库" }).waitFor();
  await page.getByRole("button", { name: /知识库已就绪，继续连接 DeepSeek/ }).click();
  await page.getByRole("heading", { name: "连接 DeepSeek，开始使用 JiMu" }).waitFor();
});

test("an anonymous empty Schema 1 knowledge root indexes all public categories as zero", { timeout: 120_000 }, async (t) => {
  const fixture = await createKnowledgeFixture();
  t.after(() => rm(fixture.container, { recursive: true, force: true }));
  const { page } = await launch(t, {
    JIMU_KNOWLEDGE_ROOT: fixture.root,
    DEEPSEEK_API_KEY: "fixture-key-for-configured-state",
  }, {
    onboardingVersion: 1,
    knowledgeRoot: fixture.root,
    knowledgeModules: { benchmarks: true, factory: true },
    knowledgeSource: "existing",
    deepSeekTested: true,
  });

  const setup = await page.evaluate(() => window.jimu.knowledge.getSetup());
  assert.equal(setup.phase, "ready");
  assert.equal(setup.compatibility, "schema-1");
  const workspaces = await page.evaluate(() => window.jimu.harness.call("workspace.list", {}));
  assert.ok(workspaces.items.some((workspace) => workspace.path === setup.root));
  const snapshot = await page.evaluate(() => window.jimu.knowledge.getOverview());
  assert.equal(snapshot.categories.length, 8);
  assert.ok(snapshot.categories.every((category) => category.documentCount === 0 && category.cardCount === 0));

  await page.getByRole("button", { name: /02 知识库/ }).click();
  await page.getByRole("button", { name: /02 档案/ }).click();
  await page.getByText("知识卡片", { exact: true }).waitFor();
  await page.getByRole("heading", { name: "这个分类暂时没有可展示内容" }).waitFor();
});

test("disabled optional modules hide their UI and stop the factory service", { timeout: 120_000 }, async (t) => {
  const fixture = await createKnowledgeFixture("jimu-disabled-module-e2e-");
  t.after(() => rm(fixture.container, { recursive: true, force: true }));
  const { page } = await launch(t, {
    JIMU_KNOWLEDGE_ROOT: fixture.root,
    DEEPSEEK_API_KEY: "fixture-key-for-disabled-modules",
  }, {
    onboardingVersion: 1,
    knowledgeRoot: fixture.root,
    knowledgeModules: { benchmarks: false, factory: false },
    knowledgeSource: "existing",
    deepSeekTested: true,
  });

  assert.equal(await page.getByRole("button", { name: /自媒体工厂/ }).count(), 0);
  await page.getByRole("button", { name: /02 知识库/ }).click();
  await page.getByRole("button", { name: /02 档案/ }).click();
  assert.equal(await page.getByRole("button", { name: /对标博主/ }).count(), 0);
  const factoryError = await page.evaluate(async () => {
    try {
      await window.jimu.factory.getOverview();
      return "";
    } catch (error) {
      return error instanceof Error ? error.message : String(error);
    }
  });
  assert.match(factoryError, /module-disabled/);

  await page.getByRole("button", { name: /05 设置/ }).click();
  await page.evaluate(() => {
    window.__jimuOnboardingTransitions = [];
    window.__stopJimuOnboardingCapture = window.jimu.onboarding.subscribe((snapshot) => {
      window.__jimuOnboardingTransitions.push({ completed: snapshot.completed, phase: snapshot.phase });
    });
  });
  await page.getByRole("switch", { name: "启用或关闭自媒体工厂" }).click();
  await page.getByRole("button", { name: /自媒体工厂/ }).waitFor();
  await page.getByRole("heading", { name: "通用设置" }).waitFor();
  const transitions = await page.evaluate(() => {
    window.__stopJimuOnboardingCapture?.();
    return window.__jimuOnboardingTransitions;
  });
  assert.ok(transitions.length > 0);
  assert.ok(transitions.every((snapshot) => snapshot.completed === true && snapshot.phase === "complete"));
  assert.equal(await page.getByText("HARNESS / FIRST RUN", { exact: true }).count(), 0);
  const restored = await page.evaluate(() => window.jimu.factory.getOverview());
  assert.ok(restored && typeof restored === "object");
});
