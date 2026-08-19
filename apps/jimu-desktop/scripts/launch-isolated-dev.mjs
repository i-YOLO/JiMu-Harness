import { spawn } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";

import { createKnowledgeFixture } from "../tests/knowledge-fixture.mjs";

const require = createRequire(import.meta.url);
const desktopRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const userData = await mkdtemp(path.join(tmpdir(), "jimu-isolated-dev-"));
const knowledge = await createKnowledgeFixture("jimu-isolated-knowledge-");

await writeFile(path.join(userData, "settings.json"), `${JSON.stringify({
  onboardingVersion: 1,
  knowledgeRoot: knowledge.root,
  knowledgeModules: { benchmarks: true, factory: true },
  knowledgeSource: "existing",
  deepSeekTested: true,
}, null, 2)}\n`, { mode: 0o600 });

process.stdout.write(`JiMu isolated user data: ${userData}\nJiMu isolated Knowledge: ${knowledge.root}\n`);
const child = spawn(require("electron"), [desktopRoot], {
  cwd: desktopRoot,
  env: {
    ...process.env,
    JIMU_USER_DATA_DIR: userData,
    JIMU_KNOWLEDGE_ROOT: knowledge.root,
    DSH_TELEMETRY_DISABLED: "1",
  },
  stdio: "inherit",
});

const exitCode = await new Promise((resolve, reject) => {
  child.once("error", reject);
  child.once("close", resolve);
});
await rm(userData, { recursive: true, force: true });
await rm(knowledge.container, { recursive: true, force: true });
process.exitCode = exitCode ?? 1;
