import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import {
  JIMU_KNOWLEDGE_REPOSITORY_URL,
  JIMU_KNOWLEDGE_TEMPLATE_VERSION,
  KNOWLEDGE_CATEGORIES,
  KNOWLEDGE_STANDARD_DIRECTORIES,
} from "../../jimu-ui-preview/shared/knowledge-schema.mjs";

export async function createKnowledgeFixture(prefix = "jimu-knowledge-fixture-") {
  const container = await mkdtemp(path.join(os.tmpdir(), prefix));
  const root = path.join(container, "fixture-knowledge-001");
  await Promise.all(KNOWLEDGE_STANDARD_DIRECTORIES.map((directory) => mkdir(path.join(root, directory), { recursive: true })));
  await writeFile(path.join(root, "jimu-knowledge.json"), `${JSON.stringify({
    schemaVersion: 1,
    templateVersion: JIMU_KNOWLEDGE_TEMPLATE_VERSION,
    name: "Fixture Knowledge",
    minimumHarnessVersion: "0.1.0",
    repositoryUrl: JIMU_KNOWLEDGE_REPOSITORY_URL,
    categories: KNOWLEDGE_CATEGORIES.map((category) => category.id),
  }, null, 2)}\n`, { mode: 0o600 });
  return { container, root };
}
