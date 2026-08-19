import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { inspectKnowledgeRoot } from "../scripts/knowledge-index-service.mjs";
import {
  JIMU_KNOWLEDGE_REPOSITORY_URL,
  JIMU_KNOWLEDGE_TEMPLATE_VERSION,
  KNOWLEDGE_CATEGORIES,
  KNOWLEDGE_CATEGORY_IDS,
  KNOWLEDGE_FACTORY_LEAF_DIRECTORIES,
  KNOWLEDGE_OPTIONAL_MODULES,
  KNOWLEDGE_STANDARD_DIRECTORIES,
  KNOWLEDGE_TEMPLATE_DIRECTORIES,
} from "../shared/knowledge-schema.mjs";

async function fixture(t) {
  const container = await mkdtemp(path.join(os.tmpdir(), "jimu-schema-fixture-"));
  const root = path.join(container, "fixture-knowledge-001");
  await Promise.all(KNOWLEDGE_STANDARD_DIRECTORIES.map((directory) => mkdir(path.join(root, directory), { recursive: true })));
  t.after(() => rm(container, { recursive: true, force: true }));
  return root;
}

function manifest(schemaVersion = 1) {
  return {
    schemaVersion,
    templateVersion: JIMU_KNOWLEDGE_TEMPLATE_VERSION,
    name: "Fixture Knowledge",
    minimumHarnessVersion: "0.1.0",
    repositoryUrl: JIMU_KNOWLEDGE_REPOSITORY_URL,
    categories: KNOWLEDGE_CATEGORY_IDS,
    optionalModules: KNOWLEDGE_OPTIONAL_MODULES,
  };
}

test("the shared schema is the fixed eight-category source", () => {
  assert.deepEqual(KNOWLEDGE_CATEGORY_IDS, [
    "inbox", "projects", "knowledge", "content", "prompts", "business", "benchmarks", "skills",
  ]);
  assert.equal(KNOWLEDGE_CATEGORIES.length, 8);
  assert.equal(new Set(KNOWLEDGE_CATEGORIES.map((category) => category.directory)).size, 8);
  assert.equal(KNOWLEDGE_FACTORY_LEAF_DIRECTORIES.length, 17);
  assert.deepEqual(
    KNOWLEDGE_TEMPLATE_DIRECTORIES,
    [...KNOWLEDGE_STANDARD_DIRECTORIES, ...KNOWLEDGE_FACTORY_LEAF_DIRECTORIES],
  );
});

test("root inspection distinguishes unconfigured, Schema 1 and legacy roots without writing", async (t) => {
  assert.equal((await inspectKnowledgeRoot()).phase, "unconfigured");
  const root = await fixture(t);
  const before = await Promise.all(KNOWLEDGE_STANDARD_DIRECTORIES.map((directory) => readFile(path.join(root, directory, ".gitkeep"), "utf8").catch(() => null)));
  assert.equal((await inspectKnowledgeRoot(root)).compatibility, "legacy-schema-1");
  await writeFile(path.join(root, "jimu-knowledge.json"), JSON.stringify(manifest()));
  assert.equal((await inspectKnowledgeRoot(root)).compatibility, "schema-1");
  const after = await Promise.all(KNOWLEDGE_STANDARD_DIRECTORIES.map((directory) => readFile(path.join(root, directory, ".gitkeep"), "utf8").catch(() => null)));
  assert.deepEqual(after, before);
});

test("root inspection rejects malformed, future and incomplete knowledge roots", async (t) => {
  const malformed = await fixture(t);
  await writeFile(path.join(malformed, "jimu-knowledge.json"), "{");
  assert.equal((await inspectKnowledgeRoot(malformed)).phase, "incompatible");

  const future = await fixture(t);
  await writeFile(path.join(future, "jimu-knowledge.json"), JSON.stringify(manifest(2)));
  assert.equal((await inspectKnowledgeRoot(future)).phase, "incompatible");

  const futureHarness = await fixture(t);
  await writeFile(path.join(futureHarness, "jimu-knowledge.json"), JSON.stringify({ ...manifest(), minimumHarnessVersion: "9.0.0" }));
  assert.equal((await inspectKnowledgeRoot(futureHarness)).phase, "incompatible");

  const unexpectedRepository = await fixture(t);
  await writeFile(path.join(unexpectedRepository, "jimu-knowledge.json"), JSON.stringify({ ...manifest(), repositoryUrl: "https://example.invalid/knowledge" }));
  assert.equal((await inspectKnowledgeRoot(unexpectedRepository)).phase, "incompatible");

  const incomplete = await mkdtemp(path.join(os.tmpdir(), "jimu-incomplete-fixture-"));
  t.after(() => rm(incomplete, { recursive: true, force: true }));
  assert.equal((await inspectKnowledgeRoot(incomplete)).phase, "incompatible");
});

test("optional modules are required only when enabled locally", async (t) => {
  const root = await fixture(t);
  await writeFile(path.join(root, "jimu-knowledge.json"), JSON.stringify(manifest()));
  await rm(path.join(root, "07-对标博主库"), { recursive: true });
  await rm(path.join(root, "08-自媒体工厂"), { recursive: true });
  assert.equal((await inspectKnowledgeRoot(root)).phase, "ready");
  assert.match(
    (await inspectKnowledgeRoot(root, { requiredModules: ["benchmarks"] })).error,
    /07-对标博主库/,
  );
  assert.match(
    (await inspectKnowledgeRoot(root, { requiredModules: ["factory"] })).error,
    /08-自媒体工厂/,
  );
});

test("root inspection accepts an assets link contained inside the knowledge root", async (t) => {
  const root = await fixture(t);
  const target = path.join(root, "08-自媒体工厂", "03-素材库", "01-图片与配图", "知识库内容素材");
  await mkdir(target, { recursive: true });
  await rm(path.join(root, "assets"), { recursive: true });
  await symlink(path.relative(root, target), path.join(root, "assets"));

  const inspection = await inspectKnowledgeRoot(root);
  assert.equal(inspection.phase, "ready");
  assert.equal(inspection.compatibility, "legacy-schema-1");
});

test("root inspection rejects escaping, dangling and non-directory standard-directory links", async (t) => {
  const escapingRoot = await fixture(t);
  const external = await mkdtemp(path.join(os.tmpdir(), "jimu-schema-external-"));
  t.after(() => rm(external, { recursive: true, force: true }));
  await rm(path.join(escapingRoot, "assets"), { recursive: true });
  await symlink(external, path.join(escapingRoot, "assets"));
  assert.match((await inspectKnowledgeRoot(escapingRoot)).error, /不能指向知识库外部：assets/);

  const danglingRoot = await fixture(t);
  await rm(path.join(danglingRoot, "assets"), { recursive: true });
  await symlink("missing-assets", path.join(danglingRoot, "assets"));
  assert.match((await inspectKnowledgeRoot(danglingRoot)).error, /链接已失效：assets/);

  const fileRoot = await fixture(t);
  await writeFile(path.join(fileRoot, "asset-file"), "fixture");
  await rm(path.join(fileRoot, "assets"), { recursive: true });
  await symlink("asset-file", path.join(fileRoot, "assets"));
  assert.match((await inspectKnowledgeRoot(fileRoot)).error, /链接目标不是目录：assets/);

  const contentRoot = await fixture(t);
  const contentTarget = path.join(contentRoot, "03-Knowledge", "linked-inbox");
  await mkdir(contentTarget, { recursive: true });
  await rm(path.join(contentRoot, "01-Inbox"), { recursive: true });
  await symlink(path.relative(contentRoot, contentTarget), path.join(contentRoot, "01-Inbox"));
  assert.match((await inspectKnowledgeRoot(contentRoot)).error, /内容标准目录不允许使用符号链接：01-Inbox/);
});

test("production renderer sources contain no static user-data fallbacks", async () => {
  const source = await readFile(new URL("../src/App.jsx", import.meta.url), "utf8");
  const onboarding = await readFile(new URL("../src/onboarding-screen.jsx", import.meta.url), "utf8");
  const usage = await readFile(new URL("../src/usage-screen.jsx", import.meta.url), "utf8");
  for (const text of [source, onboarding, usage]) {
    assert.doesNotMatch(text, /INITIAL_PROJECTS|PREVIEW_SKILLS|DOC_BY_ID|const\s+DOCUMENTS\b/);
    assert.doesNotMatch(text, /\/Users\//);
  }
  assert.match(onboarding, /使用完整默认配置/);
  assert.match(onboarding, /返回上一步/);
  assert.match(onboarding, /点击下方能力卡片即可选择/);
  assert.match(onboarding, /选择初始化位置/);
  assert.match(onboarding, /初始化并安装知识库/);
  assert.match(onboarding, /连接已有知识库/);
  assert.match(onboarding, /测试并进入 JiMu/);
  assert.doesNotMatch(onboarding, /暂时跳过|跳过配置/);
});
