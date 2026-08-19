import assert from "node:assert/strict";
import test from "node:test";
import { describeHarnessError, groupSkillCatalog, historyMessages } from "../src/agent-transcript.js";

test("session history distinguishes direct prompts from injected Harness context", () => {
  const messages = historyMessages([
    {
      type: "user/message",
      seq: 9,
      data: { role: "user", source: { kind: "user" }, content: [{ type: "text", text: "hello" }] },
    },
    {
      type: "user/message",
      seq: 10,
      data: {
        role: "user",
        source: { kind: "agent-instructions", changes: [{ action: "set", path: "AGENTS.md" }] },
        content: [{ type: "text", text: "<system-reminder>private model context</system-reminder>" }],
      },
    },
    {
      type: "user/message",
      seq: 11,
      data: {
        role: "user",
        source: { kind: "skill-catalog", entries: [{ name: "a" }, { name: "b" }] },
        content: [{ type: "text", text: "<system-reminder>skill catalog</system-reminder>" }],
      },
    },
  ]);

  assert.deepEqual(messages.map(({ role, label, meta }) => ({ role, label, meta })), [
    { role: "user", label: undefined, meta: undefined },
    { role: "context", label: "工作区指令", meta: "AGENTS.md" },
    { role: "context", label: "Skill 目录", meta: "2 个可用 Skill" },
  ]);
  assert.equal(messages[0].text, "hello");
  assert.match(messages[1].details, /system-reminder/);
});

test("missing DeepSeek credentials produce a local recovery action", () => {
  assert.deepEqual(describeHarnessError('llm-deepseek: no API key for provider route "deepseek-official" (MISSING_CREDENTIAL)'), {
    title: "DeepSeek API Key 未配置",
    message: "JiMu 使用独立凭据存储。请在“设置 → 模型”中保存 DEEPSEEK_API_KEY 后重试。",
    action: "settings",
  });

  const transcript = historyMessages([{
    type: "turn/end",
    seq: 19,
    data: { reason: { kind: "error", error: { code: "MISSING_CREDENTIAL" } } },
  }]);
  assert.deepEqual(transcript, [{ role: "turn", title: "DeepSeek API Key 未配置", text: "1 个步骤", state: "error", turn: undefined, seq: 19 }]);
});

test("streaming, reasoning and tool calls retain Harness event boundaries", () => {
  const streaming = historyMessages([
    { type: "turn/start", seq: 1, time: 1_000, data: { turn: 1 } },
    { type: "step/start", seq: 2, time: 1_100, data: { turn: 1, step: 1 } },
    { type: "assistant/chunk", seq: 3, data: { turn: 1, step: 1, chunk: { type: "block-start", index: 0, blockType: "reasoning" } } },
    { type: "assistant/chunk", seq: 4, data: { turn: 1, step: 1, chunk: { type: "reasoning-delta", index: 0, text: "核对架构" } } },
    { type: "assistant/chunk", seq: 5, data: { turn: 1, step: 1, chunk: { type: "block-start", index: 1, blockType: "text" } } },
    { type: "assistant/chunk", seq: 6, data: { turn: 1, step: 1, chunk: { type: "text-delta", index: 1, text: "正在处理" } } },
  ]);
  assert.deepEqual(streaming.map((row) => [row.role, row.streaming]), [["reasoning", true], ["assistant", true]]);
  assert.equal(streaming[0].details, "核对架构");
  assert.equal(streaming[1].text, "正在处理");

  const completed = historyMessages([
    { type: "turn/start", seq: 1, time: 1_000, data: { turn: 2 } },
    { type: "step/start", seq: 2, time: 1_100, data: { turn: 2, step: 1 } },
    {
      event: { type: "tool/call", seq: 3, data: { turn: 2, step: 1, callId: "read-1", name: "read", arguments: "{\"path\":\"App.jsx\"}" } },
      view: { for: "call", view: { card: "generic", title: "读取 App.jsx", kind: "read", rawInput: "App.jsx" } },
    },
    {
      event: { type: "tool/result", seq: 4, data: { turn: 2, step: 1, message: { source: { kind: "tool", callId: "read-1" }, content: [{ type: "tool-result", toolCallId: "read-1", content: [{ type: "text", text: "读取完成" }] }] } } },
      view: { for: "result", view: { card: "generic", title: "已读取 App.jsx", content: [{ type: "text", text: "280 行" }] } },
    },
    { type: "assistant/message", seq: 5, data: { turn: 2, step: 1, content: [{ type: "reasoning", text: "先保留事件语义" }, { type: "text", text: "处理完成" }] } },
    { type: "turn/end", seq: 6, time: 2_500, data: { turn: 2, reason: { kind: "completed" } } },
  ]);
  assert.deepEqual(completed.map((row) => row.role), ["tool", "reasoning", "assistant", "turn"]);
  assert.deepEqual(completed[0], {
    role: "tool",
    callId: "read-1",
    name: "read",
    title: "已读取 App.jsx",
    kind: "read",
    summary: "App.jsx",
    input: "App.jsx",
    card: "generic",
    state: "complete",
    turn: 2,
    step: 1,
    seq: 3,
    output: "280 行",
    exitCode: null,
    signal: null,
    completedSeq: 4,
  });
  assert.equal(completed[1].details, "先保留事件语义");
  assert.equal(completed[2].text, "处理完成");
  assert.match(completed[3].text, /1 个步骤 · 1.5s/);
});

test("skill catalog groups names into explicit directory levels without fabricating filesystem paths", () => {
  const groups = groupSkillCatalog([
    { name: "product-design:audit", description: "audit" },
    { name: "product-design:image-to-code", description: "build" },
    { name: "dbs-knowledge", description: "knowledge" },
    { name: "dbs-benchmark", description: "benchmark", path: "/skills/dbs-benchmark/SKILL.md" },
    { name: "media-use", description: "media" },
  ]);
  assert.deepEqual(groups.map((group) => [group.id, group.skills.length]), [["dbs", 2], ["product-design", 2], ["other", 1]]);
  assert.equal(groups[0].skills.find((skill) => skill.name === "dbs-benchmark").pathKind, "filesystem");
  assert.equal(groups[1].skills[0].pathKind, "logical");
  assert.match(groups[1].skills[0].path, /^Skills\/product-design\//);
});
