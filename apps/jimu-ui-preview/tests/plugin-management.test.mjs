import assert from "node:assert/strict";
import test from "node:test";
import {
  configOps,
  filterPluginEntries,
  validatePluginConfig,
} from "../src/plugin-management.js";

const entries = [
  { entryId: "tool-web", moduleName: "@deepseek-ai/dsh-tool-web", enabled: true, fiberPhase: "active", management: "toggleable" },
  { entryId: "agent-loop", moduleName: "@deepseek-ai/dsh-agent-loop", enabled: true, fiberPhase: "failed", management: "locked" },
  { entryId: "tool-jobs", moduleName: "@deepseek-ai/dsh-tool-jobs", enabled: false, fiberPhase: null, management: "toggleable" },
];

test("plugin inventory search and filters use module name, Loader ID and state", () => {
  assert.deepEqual(filterPluginEntries(entries, "tool-web", "all").map((entry) => entry.entryId), ["tool-web"]);
  assert.deepEqual(filterPluginEntries(entries, "agent", "failed").map((entry) => entry.entryId), ["agent-loop"]);
  assert.deepEqual(filterPluginEntries(entries, "", "disabled").map((entry) => entry.entryId), ["tool-jobs"]);
  assert.deepEqual(filterPluginEntries(entries, "", "locked").map((entry) => entry.entryId), ["agent-loop"]);
});

test("plugin configuration validates numeric fields and endpoint protocols", () => {
  assert.deepEqual(validatePluginConfig("shell", { timeoutMs: "0", maxOutputBytes: "abc" }), {
    timeoutMs: "超时时间必须是正整数",
    maxOutputBytes: "输出上限必须是正整数",
  });
  assert.deepEqual(validatePluginConfig("agent-loop", { maxParallelToolCalls: "2.5" }), {
    maxParallelToolCalls: "并行工具数必须是正整数",
  });
  assert.deepEqual(validatePluginConfig("web-search-deepseek", { baseURL: "file:///tmp/key", maxUses: "2" }), {
    baseURL: "仅支持 HTTP 或 HTTPS 地址",
  });
});

test("blank configuration drafts become scoped unsets without touching secrets", () => {
  assert.deepEqual(configOps([
    { name: "baseURL", type: "text" },
    { name: "maxUses", type: "number" },
  ], { baseURL: "", maxUses: "4" }), [
    { op: "unset", path: ["baseURL"] },
    { op: "set", path: ["maxUses"], value: 4 },
  ]);
});
