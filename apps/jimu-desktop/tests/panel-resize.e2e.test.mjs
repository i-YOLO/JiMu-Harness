import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { _electron as electron } from "playwright";
import { waitForHarnessReady } from "./electron-ready.mjs";
import { createKnowledgeFixture } from "./knowledge-fixture.mjs";

const desktopRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const screenshotRoot = path.join(desktopRoot, "artifacts", "screenshots");
async function dragHorizontally(page, locator, delta, expectedSizeDelta = delta) {
  const initial = Number(await locator.getAttribute("aria-valuenow"));
  for (let attempt = 0; attempt < 3; attempt += 1) {
    const box = await locator.boundingBox();
    assert.ok(box, "Resize separator must be visible");
    const x = box.x + (box.width / 2);
    const y = box.y + Math.min(420, box.height / 2);
    await page.mouse.move(x, y);
    await page.mouse.down();
    await page.mouse.move(x + delta, y, { steps: 8 });
    await page.mouse.up();
    await page.evaluate(() => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve))));
    const change = Number(await locator.getAttribute("aria-valuenow")) - initial;
    if (Math.sign(change) === Math.sign(expectedSizeDelta) && Math.abs(change) >= Math.abs(expectedSizeDelta) - 2) return;
  }
  throw new Error(`Resize separator did not move ${expectedSizeDelta}px after three pointer drags`);
}

async function panelWidths(page) {
  return page.evaluate(() => ({
    appSidebar: Math.round(document.querySelector(".app-sidebar").getBoundingClientRect().width),
    projectBrowser: Math.round(document.querySelector(".workspace-browser").getBoundingClientRect().width),
    conversation: Math.round(document.querySelector(".conversation-preview").getBoundingClientRect().width),
    contextSidebar: Math.round(document.querySelector(".agent-context-sidebar").getBoundingClientRect().width),
  }));
}

test("JiMu Agent panel separators resize, persist, reset and protect the conversation", { timeout: 120_000 }, async (t) => {
  const testState = await mkdtemp(path.join(os.tmpdir(), "jimu-panel-resize-e2e-"));
  const fixture = await createKnowledgeFixture("jimu-panel-knowledge-");
  await mkdir(screenshotRoot, { recursive: true });
  await writeFile(path.join(testState, "settings.json"), `${JSON.stringify({
    onboardingVersion: 1,
    knowledgeModules: { benchmarks: true, factory: true },
    knowledgeSource: "existing",
    deepSeekTested: true,
  }, null, 2)}\n`, { mode: 0o600 });
  const electronApp = await electron.launch({
    args: [desktopRoot],
    cwd: desktopRoot,
    env: {
      ...process.env,
      JIMU_USER_DATA_DIR: testState,
      JIMU_KNOWLEDGE_ROOT: fixture.root,
      DEEPSEEK_API_KEY: "fixture-key-for-configured-state",
      DSH_TELEMETRY_DISABLED: "1",
    },
  });
  t.after(async () => {
    await electronApp.close().catch(() => {});
    await rm(testState, { recursive: true, force: true });
    await rm(fixture.container, { recursive: true, force: true });
  });

  const page = await electronApp.firstWindow();
  await page.waitForLoadState("domcontentloaded");
  await page.setViewportSize({ width: 1512, height: 982 });
  await waitForHarnessReady(page);
  await page.getByRole("button", { name: /01 AGENT 执行现场/ }).click();
  await page.getByText("项目与会话", { exact: true }).waitFor();
  await Promise.all([
    ".agent-workspace",
    ".conversation-preview",
    ".agent-empty-state",
    ".message-stream",
    ".conversation-flow",
    ".conversation-stage",
  ].map((selector) => page.locator(selector).waitFor({ state: "visible" })));

  const appSeparator = page.getByRole("separator", { name: "调整主导航宽度" });
  const projectSeparator = page.getByRole("separator", { name: "调整项目与会话面板宽度" });
  const contextSeparator = page.getByRole("separator", { name: "调整执行环境面板宽度" });
  const initial = await panelWidths(page);
  const emptyStateContainment = await page.evaluate(() => {
    const conversation = document.querySelector(".conversation-preview").getBoundingClientRect();
    const emptyStateElement = document.querySelector(".agent-empty-state");
    const emptyState = emptyStateElement.getBoundingClientRect();
    const messageStream = document.querySelector(".message-stream").getBoundingClientRect();
    const conversationFlow = document.querySelector(".conversation-flow").getBoundingClientRect();
    const conversationStage = document.querySelector(".conversation-stage").getBoundingClientRect();
    return {
      contained: emptyState.left >= conversation.left && emptyState.right <= conversation.right,
      conversation: conversation.toJSON(),
      emptyState: emptyState.toJSON(),
      messageStream: messageStream.toJSON(),
      conversationFlow: conversationFlow.toJSON(),
      conversationStage: conversationStage.toJSON(),
      emptyStateStyle: {
        width: getComputedStyle(emptyStateElement).width,
        maxWidth: getComputedStyle(emptyStateElement).maxWidth,
      },
    };
  });
  assert.equal(emptyStateContainment.contained, true, JSON.stringify(emptyStateContainment));
  await page.waitForTimeout(300);
  await page.screenshot({ path: path.join(screenshotRoot, "agent-resizable-default.png"), fullPage: false });

  await dragHorizontally(page, appSeparator, 48);
  await dragHorizontally(page, projectSeparator, 40);
  await dragHorizontally(page, contextSeparator, -32, 32);
  const resized = await panelWidths(page);
  assert.ok(resized.appSidebar >= initial.appSidebar + 46);
  assert.ok(resized.projectBrowser >= initial.projectBrowser + 38);
  assert.ok(resized.contextSidebar >= initial.contextSidebar + 30);
  assert.ok(resized.conversation >= 300);
  assert.equal(await page.locator("html").getAttribute("data-panel-resizing"), null);
  assert.deepEqual(await page.evaluate(() => ({
    appSidebar: localStorage.getItem("jimu.panel.appSidebarWidth"),
    projectBrowser: localStorage.getItem("jimu.panel.projectBrowserWidth"),
    contextSidebar: localStorage.getItem("jimu.panel.contextSidebarWidth"),
  })), {
    appSidebar: String(resized.appSidebar),
    projectBrowser: String(resized.projectBrowser),
    contextSidebar: String(resized.contextSidebar),
  });
  await page.screenshot({ path: path.join(screenshotRoot, "agent-resizable-panels.png"), fullPage: false });

  await page.reload();
  await page.getByRole("button", { name: /01 AGENT 执行现场/ }).click();
  await page.getByText("项目与会话", { exact: true }).waitFor();
  assert.deepEqual(await panelWidths(page), resized);

  await projectSeparator.focus();
  const beforeKeyboard = await panelWidths(page);
  await page.keyboard.press("ArrowLeft");
  const afterKeyboard = await panelWidths(page);
  assert.equal(afterKeyboard.projectBrowser, beforeKeyboard.projectBrowser - 16);

  await page.setViewportSize({ width: 1120, height: 760 });
  await page.evaluate(() => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve))));
  await page.waitForTimeout(300);
  const compact = await panelWidths(page);
  const compactDiagnostics = await page.evaluate(() => ({
    innerWidth,
    appWidth: Math.round(document.querySelector(".jimu-app").getBoundingClientRect().width),
    workspaceWidth: Math.round(document.querySelector(".agent-workspace").getBoundingClientRect().width),
    appVariable: getComputedStyle(document.querySelector(".jimu-app")).getPropertyValue("--app-sidebar-width"),
    projectVariable: getComputedStyle(document.querySelector(".agent-workspace")).getPropertyValue("--agent-project-browser-width"),
    contextVariable: getComputedStyle(document.querySelector(".agent-workspace")).getPropertyValue("--agent-context-sidebar-width"),
  }));
  assert.ok(compact.conversation >= 298, `Conversation narrowed to ${compact.conversation}px: ${JSON.stringify({ compact, compactDiagnostics })}`);
  assert.ok(await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth) <= 1);

  await page.setViewportSize({ width: 1512, height: 982 });
  for (const separator of [appSeparator, projectSeparator, contextSeparator]) {
    await separator.focus();
    await page.keyboard.press("Home");
  }
  assert.deepEqual(await page.evaluate(() => ({
    appSidebar: localStorage.getItem("jimu.panel.appSidebarWidth"),
    projectBrowser: localStorage.getItem("jimu.panel.projectBrowserWidth"),
    contextSidebar: localStorage.getItem("jimu.panel.contextSidebarWidth"),
  })), {
    appSidebar: "341",
    projectBrowser: "334",
    contextSidebar: "344",
  });
});
