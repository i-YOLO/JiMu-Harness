import assert from "node:assert/strict";
import test from "node:test";

import {
  composerActionState,
  updateProjectSession,
  updateSessionById,
} from "../src/agent-session-state.js";

const projects = [
  {
    id: "project-a",
    sessions: [
      { id: "session-a", running: false, submitting: false, cancelling: false },
      { id: "session-b", running: false, submitting: false, cancelling: false },
    ],
  },
  { id: "project-b", sessions: [{ id: "session-c", running: true, submitting: false, cancelling: false }] },
];

test("session runtime updates stay attached to their session across navigation", () => {
  const running = updateSessionById(projects, "session-b", { running: true, submitting: false });
  assert.equal(running[0].sessions[0].running, false);
  assert.equal(running[0].sessions[1].running, true);
  assert.equal(running[1].sessions[0].running, true);

  const submitted = updateProjectSession(running, "project-a", "session-a", { submitting: true });
  assert.equal(submitted[0].sessions[0].submitting, true);
  assert.equal(submitted[0].sessions[1].submitting, false);
});

test("composer action follows the complete per-session lifecycle", () => {
  assert.deepEqual(composerActionState(null, "task"), {
    mode: "idle", running: false, submitting: false, cancelling: false,
    pending: false, label: "发送消息", disabled: true,
  });
  assert.equal(composerActionState({ running: false, submitting: false, cancelling: false }, "").disabled, true);
  assert.equal(composerActionState({ running: false, submitting: false, cancelling: false }, "task").disabled, false);
  assert.deepEqual(composerActionState({ running: false, submitting: true, cancelling: false }, ""), {
    mode: "submitting", running: false, submitting: true, cancelling: false,
    pending: true, label: "停止生成", disabled: false,
  });
  assert.deepEqual(composerActionState({ running: true, submitting: false, cancelling: false }, ""), {
    mode: "running", running: true, submitting: false, cancelling: false,
    pending: true, label: "停止生成", disabled: false,
  });
  assert.deepEqual(composerActionState({ running: true, submitting: false, cancelling: true }, ""), {
    mode: "cancelling", running: true, submitting: false, cancelling: true,
    pending: true, label: "正在停止", disabled: true,
  });
});
