import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { _electron as electron } from "playwright";

import { waitForHarnessReady } from "./electron-ready.mjs";
import { createKnowledgeFixture } from "./knowledge-fixture.mjs";
import { createPluginRegistryFixture, FIXTURE_PLUGIN_NAME } from "./plugin-registry-fixture.mjs";

const desktopRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

async function startStalledLlm(t) {
  let requests = 0;
  let markStarted;
  let markClosed;
  const started = new Promise((resolve) => { markStarted = resolve; });
  const closed = new Promise((resolve) => { markClosed = resolve; });
  const server = createServer((request, response) => {
    if (!request.url?.endsWith("/chat/completions")) {
      response.writeHead(404).end();
      return;
    }
    requests += 1;
    response.writeHead(200, {
      "Content-Type": "text/event-stream; charset=utf-8",
      "Cache-Control": "no-cache",
      Connection: "keep-alive",
    });
    if (requests > 1) {
      response.end(`data: ${JSON.stringify({
        id: "jimu-stop-recovered",
        object: "chat.completion.chunk",
        created: 2,
        model: "deepseek-v4-flash",
        choices: [{ index: 0, delta: { role: "assistant", content: "RECOVERED_AFTER_STOP" }, finish_reason: "stop" }],
      })}\n\ndata: [DONE]\n\n`);
      return;
    }
    response.write(`data: ${JSON.stringify({
      id: "jimu-stop-e2e",
      object: "chat.completion.chunk",
      created: 1,
      model: "deepseek-v4-flash",
      choices: [{ index: 0, delta: { role: "assistant", content: "PARTIAL_STOP_OUTPUT" }, finish_reason: null }],
    })}\n\n`);
    markStarted();
    response.once("close", () => { markClosed(); });
  });
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  if (address === null || typeof address === "string") throw new Error("stalled LLM did not bind a TCP port");
  t.after(async () => {
    server.closeAllConnections();
    await new Promise((resolve) => { server.close(resolve); });
  });
  return { url: `http://127.0.0.1:${address.port}`, started, closed };
}

async function startPluginProposalLlm(t) {
  let agentRequests = 0;
  const server = createServer(async (request, response) => {
    if (!request.url?.endsWith("/chat/completions")) {
      response.writeHead(404).end();
      return;
    }
    const chunks = [];
    for await (const chunk of request) chunks.push(chunk);
    const body = JSON.parse(Buffer.concat(chunks).toString("utf8"));
    const agentRequest = Array.isArray(body.tools) && body.tools.some((tool) => tool?.function?.name === "jimu_plugin_prepare_install");
    response.writeHead(200, { "Content-Type": "text/event-stream; charset=utf-8", "Cache-Control": "no-cache" });
    const send = (payload) => response.write(`data: ${JSON.stringify(payload)}\n\n`);
    if (!agentRequest) {
      send({ choices: [{ delta: { role: "assistant", content: "安装插件" } }] });
      send({ choices: [{ delta: {}, finish_reason: "stop" }] });
    } else if (++agentRequests === 1) {
      send({ choices: [{ delta: { role: "assistant", tool_calls: [{ index: 0, id: "plugin-proposal", type: "function", function: { name: "jimu_plugin_prepare_install", arguments: '{"source":"jimu-fixture-plugin"}' } }] } }] });
      send({ choices: [{ delta: {}, finish_reason: "tool_calls" }] });
    } else {
      send({ choices: [{ delta: { role: "assistant", content: "插件安装提案已经准备好，请在卡片中确认。" } }] });
      send({ choices: [{ delta: {}, finish_reason: "stop" }] });
    }
    response.end("data: [DONE]\n\n");
  });
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  if (address === null || typeof address === "string") throw new Error("plugin proposal LLM did not bind");
  t.after(async () => {
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
  });
  return { url: `http://127.0.0.1:${address.port}`, requests: () => agentRequests };
}

async function startPluginRegistry(t) {
  const fixture = await createPluginRegistryFixture();
  t.after(() => fixture.close());
  return fixture;
}

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
  await waitForHarnessReady(page);
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

test("the native plugin market searches catalog entries instead of only loaded entries", { timeout: 120_000 }, async (t) => {
  const fixture = await createKnowledgeFixture("jimu-plugin-market-e2e-");
  const registry = await startPluginRegistry(t);
  t.after(() => rm(fixture.container, { recursive: true, force: true }));
  const { page } = await launch(t, {
    JIMU_KNOWLEDGE_ROOT: fixture.root,
    DEEPSEEK_API_KEY: "fixture-key",
    JIMU_PLUGIN_CATALOG_URL: registry.unavailableCatalogUrl,
  }, {
    onboardingVersion: 1,
    knowledgeRoot: fixture.root,
    knowledgeModules: { benchmarks: true, factory: true },
    knowledgeSource: "existing",
    deepSeekTested: true,
  });

  await page.getByRole("button", { name: /05 设置/ }).click();
  await page.getByRole("button", { name: /03.*插件/ }).click();
  await page.getByRole("tab", { name: "插件市场" }).click();
  const search = page.getByPlaceholder("搜索插件名称、作者或能力");
  await search.fill("dshmarket");
  await page.getByText("dshmarket", { exact: true }).waitFor();
  await page.getByText("离线快照", { exact: true }).waitFor();
  await page.locator(".plugin-market-compatibility").filter({ hasText: "官方 Web UI 专用" }).waitFor();
  assert.equal(await page.getByRole("button", { name: "不兼容" }).isDisabled(), true);

  await search.fill("dsh-vision-router");
  await page.getByText("dsh-vision-router", { exact: true }).waitFor();
  await page.getByRole("button", { name: "检查并安装" }).waitFor();
});

test("the native plugin market installs, restarts, lists and uninstalls an isolated Bundle", { timeout: 180_000 }, async (t) => {
  const fixture = await createKnowledgeFixture("jimu-plugin-install-e2e-");
  const registry = await startPluginRegistry(t);
  t.after(() => rm(fixture.container, { recursive: true, force: true }));
  const { page } = await launch(t, {
    JIMU_KNOWLEDGE_ROOT: fixture.root,
    DEEPSEEK_API_KEY: "fixture-key",
    JIMU_PLUGIN_CATALOG_URL: registry.catalogUrl,
    JIMU_PLUGIN_REGISTRY_URL: registry.registryUrl,
  }, {
    onboardingVersion: 1,
    knowledgeRoot: fixture.root,
    knowledgeModules: { benchmarks: true, factory: true },
    knowledgeSource: "existing",
    deepSeekTested: true,
  });

  await page.getByRole("button", { name: /05 设置/ }).click();
  await page.getByRole("button", { name: /03.*插件/ }).click();
  await page.getByRole("tab", { name: "插件市场" }).click();
  await page.getByPlaceholder("搜索插件名称、作者或能力").fill(FIXTURE_PLUGIN_NAME);
  await page.getByText(FIXTURE_PLUGIN_NAME, { exact: true }).waitFor();
  await page.getByRole("button", { name: "检查并安装" }).click();
  await page.getByText(`确认安装 ${FIXTURE_PLUGIN_NAME}`, { exact: true }).waitFor();
  await page.getByRole("button", { name: "确认安装" }).click();
  await page.locator(".plugin-market-modal").waitFor({ state: "hidden", timeout: 60_000 });
  await page.getByRole("tab", { name: "已安装插件" }).click();
  await page.getByText(FIXTURE_PLUGIN_NAME, { exact: true }).waitFor({ timeout: 60_000 });

  await page.getByRole("button", { name: `卸载 ${FIXTURE_PLUGIN_NAME}` }).waitFor();
  const removalSnapshot = await page.evaluate((packageName) => window.jimu.plugins.uninstall({ packageName }), FIXTURE_PLUGIN_NAME);
  assert.equal(removalSnapshot.installedPackages.some((plugin) => plugin.packageName === FIXTURE_PLUGIN_NAME), false);
  await page.reload();
  await waitForHarnessReady(page);
  await page.getByRole("button", { name: /05 设置/ }).click();
  await page.getByRole("button", { name: /03.*插件/ }).click();
  await page.getByRole("tab", { name: "已安装插件" }).click();
  await page.getByText("尚未安装外部插件", { exact: true }).waitFor({ timeout: 60_000 });
});

test("Agent conversation prepares a plugin proposal but waits for human installation", { timeout: 120_000 }, async (t) => {
  const fixture = await createKnowledgeFixture("jimu-plugin-agent-e2e-");
  const registry = await startPluginRegistry(t);
  const llm = await startPluginProposalLlm(t);
  t.after(() => rm(fixture.container, { recursive: true, force: true }));
  const { page } = await launch(t, {
    JIMU_KNOWLEDGE_ROOT: fixture.root,
    DEEPSEEK_API_KEY: "fixture-key",
    DEEPSEEK_BASE_URL: llm.url,
    JIMU_PLUGIN_CATALOG_URL: registry.catalogUrl,
    JIMU_PLUGIN_REGISTRY_URL: registry.registryUrl,
  }, {
    onboardingVersion: 1,
    knowledgeRoot: fixture.root,
    knowledgeModules: { benchmarks: true, factory: true },
    knowledgeSource: "existing",
    deepSeekTested: true,
  });

  const sessionId = await page.evaluate(async () => {
    const workspaces = await window.jimu.harness.call("workspace.list", {});
    const session = await window.jimu.harness.call("session.create", { workspaceId: workspaces.items[0].workspaceId });
    return session.sessionId;
  });
  await page.reload();
  await waitForHarnessReady(page);
  await page.getByRole("button", { name: /01 AGENT/ }).click();
  await page.locator(".composer textarea").fill("帮我安装 jimu-fixture-plugin");
  await page.getByRole("button", { name: "发送消息" }).click();
  await page.getByText("插件安装提案 · jimu-fixture-plugin", { exact: true }).waitFor({ timeout: 30_000 });
  await page.getByRole("button", { name: "确认安装" }).waitFor();
  assert.ok(llm.requests() >= 2);
  const snapshot = await page.evaluate(() => window.jimu.plugins.snapshot());
  assert.equal(snapshot.installedPackages.some((plugin) => plugin.packageName === FIXTURE_PLUGIN_NAME), false);
  const history = await page.evaluate((id) => window.jimu.harness.call("session.history", { sessionId: id, maxMessages: 100 }), sessionId);
  assert.ok(history.events.some((entry) => (entry.event ?? entry).type === "tool/result"));
});

test("a running Agent turn exposes Stop until cancellation settles", { timeout: 120_000 }, async (t) => {
  const fixture = await createKnowledgeFixture("jimu-stop-action-e2e-");
  const llm = await startStalledLlm(t);
  t.after(() => rm(fixture.container, { recursive: true, force: true }));
  const { page } = await launch(t, {
    JIMU_KNOWLEDGE_ROOT: fixture.root,
    DEEPSEEK_API_KEY: "fixture-key-for-stop-action",
    DEEPSEEK_BASE_URL: llm.url,
  }, {
    onboardingVersion: 1,
    knowledgeRoot: fixture.root,
    knowledgeModules: { benchmarks: true, factory: true },
    knowledgeSource: "existing",
    deepSeekTested: true,
  });

  const sessionId = await page.evaluate(async () => {
    const workspaces = await window.jimu.harness.call("workspace.list", {});
    const workspace = workspaces.items[0];
    if (workspace === undefined) throw new Error("JiMu did not register the knowledge workspace");
    const session = await window.jimu.harness.call("session.create", { workspaceId: workspace.workspaceId });
    return session.sessionId;
  });
  await page.reload();
  await waitForHarnessReady(page);
  await page.getByRole("button", { name: /01 AGENT/ }).click();
  await page.locator(".composer textarea").fill("Keep this turn open until I stop it.");
  await page.getByRole("button", { name: "发送消息" }).click();
  await llm.started;

  const stop = page.getByRole("button", { name: "停止生成" });
  await stop.waitFor();
  await stop.click();
  await llm.closed;
  await page.getByRole("button", { name: "发送消息" }).waitFor();
  await page.getByText("PARTIAL_STOP_OUTPUT", { exact: false }).waitFor();
  await page.waitForFunction(async (id) => {
    const history = await window.jimu.harness.call("session.history", { sessionId: id, maxMessages: 50 });
    return history.events.some((entry) => {
      const event = entry.event ?? entry;
      return event.type === "turn/end" && event.data?.reason?.kind === "aborted" && event.data?.reason?.reason?.kind === "user";
    });
  }, sessionId, { timeout: 30_000 });
  await page.locator(".composer textarea").fill("Continue after the stopped turn.");
  await page.getByRole("button", { name: "发送消息" }).click();
  await page.locator(".message.assistant").filter({ hasText: "RECOVERED_AFTER_STOP" }).waitFor({ timeout: 30_000 });
  await page.getByRole("button", { name: "发送消息" }).waitFor({ timeout: 30_000 });
  const turnReasons = await page.evaluate(async (id) => {
    const history = await window.jimu.harness.call("session.history", { sessionId: id, maxMessages: 100 });
    return history.events
      .map((entry) => entry.event ?? entry)
      .filter((event) => event.type === "turn/end")
      .map((event) => event.data?.reason);
  }, sessionId);
  assert.equal(turnReasons.filter((reason) => reason?.kind === "aborted" && reason.reason?.kind === "user").length, 1);
  assert.ok(turnReasons.some((reason) => reason?.kind === "completed"));
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
