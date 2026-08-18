import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { inspectKnowledgeRoot } from "../scripts/knowledge-index-service.mjs";
import {
  JIMU_KNOWLEDGE_REPOSITORY_URL,
  JIMU_KNOWLEDGE_TEMPLATE_VERSION,
  KNOWLEDGE_CATEGORIES,
  KNOWLEDGE_CATEGORY_IDS,
  KNOWLEDGE_STANDARD_DIRECTORIES,
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
  };
}

test("the shared schema is the fixed eight-category source", () => {
  assert.deepEqual(KNOWLEDGE_CATEGORY_IDS, [
    "inbox", "projects", "knowledge", "content", "prompts", "business", "benchmarks", "skills",
  ]);
  assert.equal(KNOWLEDGE_CATEGORIES.length, 8);
  assert.equal(new Set(KNOWLEDGE_CATEGORIES.map((category) => category.directory)).size, 8);
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

test("production renderer sources contain no static user-data fallbacks", async () => {
  const source = await readFile(new URL("../src/App.jsx", import.meta.url), "utf8");
  const usage = await readFile(new URL("../src/usage-screen.jsx", import.meta.url), "utf8");
  for (const text of [source, usage]) {
    assert.doesNotMatch(text, /INITIAL_PROJECTS|PREVIEW_SKILLS|DOC_BY_ID|const\s+DOCUMENTS\b/);
    assert.doesNotMatch(text, /\/Users\//);
  }
});
