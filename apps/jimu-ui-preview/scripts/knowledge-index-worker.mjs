import { parentPort, workerData } from "node:worker_threads";
import { scanKnowledgeRoot } from "./knowledge-index-service.mjs";

if (!parentPort) throw new Error("JiMu knowledge worker requires a parent port.");

try {
  const documents = await scanKnowledgeRoot(workerData.root);
  parentPort.postMessage({ ok: true, documents });
} catch (error) {
  parentPort.postMessage({ ok: false, error: error instanceof Error ? error.message : String(error) });
}
