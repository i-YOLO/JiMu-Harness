function contentBlocks(content) {
  return Array.isArray(content)
    ? content.filter((block) => block && typeof block === "object")
    : [];
}

function contentText(content, kinds = ["text"]) {
  const allowed = new Set(kinds);
  return contentBlocks(content)
    .filter((block) => allowed.has(block.type) && typeof block.text === "string")
    .map((block) => block.text)
    .filter(Boolean)
    .join("\n\n");
}

function printable(value) {
  if (value === null || value === undefined || value === "") return "";
  if (typeof value === "string") return value;
  try {
    return JSON.stringify(value, null, 2);
  } catch {
    return String(value);
  }
}

function eventEnvelope(entry) {
  return {
    event: entry?.event ?? entry,
    view: entry?.view ?? entry?.eventView ?? null,
  };
}

function contextDescriptor(source) {
  if (!source || typeof source !== "object") return { label: "内部上下文", meta: "Harness", contextKind: "internal" };
  if (source.kind === "agent-instructions") {
    const paths = Array.isArray(source.changes)
      ? source.changes.map((change) => change?.path).filter((path) => typeof path === "string" && path.length > 0)
      : [];
    return { label: "工作区指令", meta: paths.length > 0 ? paths.join(" · ") : "AGENTS.md", contextKind: "instructions", paths };
  }
  if (source.kind === "skill-catalog") {
    const entries = Array.isArray(source.entries)
      ? source.entries.filter((entry) => entry && typeof entry.name === "string").map((entry) => ({
        name: entry.name,
        description: typeof entry.description === "string" ? entry.description : "",
      }))
      : [];
    return { label: "Skill 目录", meta: `${entries.length} 个可用 Skill`, contextKind: "skills", entries, update: source.update === true };
  }
  if (source.kind === "plugin") {
    return { label: source.form === "snapshot" ? "运行上下文" : "插件上下文", meta: source.plugin || "Harness Plugin", contextKind: "runtime" };
  }
  if (source.kind === "session-reference") return { label: "会话引用", meta: "Harness Session", contextKind: "session" };
  return { label: "内部上下文", meta: typeof source.kind === "string" ? source.kind : "Harness", contextKind: "internal" };
}

function turnFailureText(reason) {
  if (reason?.kind === "aborted") return "本轮已停止";
  if (reason?.kind === "interrupted") return "本轮已中断";
  if (reason?.error?.code === "MISSING_CREDENTIAL") return "DeepSeek API Key 未配置";
  return "本轮已失败";
}

function turnState(reason) {
  if (reason?.kind === "completed") return "complete";
  if (reason?.kind === "aborted" || reason?.kind === "interrupted") return "stopped";
  if (reason?.kind === "error") return "error";
  return "complete";
}

function turnStatusText(reason) {
  if (reason?.kind === "completed") return "本轮执行完成";
  return turnFailureText(reason);
}

function callPresentation(view, data) {
  const presented = view?.for === "call" ? view.view : null;
  const rawArguments = printable(data.arguments ?? data.args ?? "");
  if (!presented || typeof presented !== "object") {
    return { title: data.name ?? "unknown", kind: "other", summary: rawArguments.split("\n")[0] || "等待工具返回", input: rawArguments };
  }
  const input = presented.card === "terminal"
    ? printable({ command: presented.title, cwd: presented.cwd })
    : presented.card === "diff"
      ? printable(presented.diffs)
      : printable(presented.rawInput ?? rawArguments);
  return {
    title: presented.title ?? data.name ?? "unknown",
    kind: presented.card === "terminal" ? "execute" : presented.card === "diff" ? "edit" : presented.kind ?? "other",
    summary: presented.description ?? input.split("\n")[0] ?? "",
    input,
    card: presented.card ?? "generic",
  };
}

function resultPresentation(view, data) {
  const presented = view?.for === "result" ? view.view : null;
  const resultBlocks = contentBlocks(data.message?.content ?? data.content).flatMap((block) => block.type === "tool-result" ? contentBlocks(block.content) : [block]);
  const raw = contentText(resultBlocks, ["text", "reasoning"])
    || printable(data.result ?? data.output ?? data.error ?? "");
  if (!presented || typeof presented !== "object") return { output: raw, title: null, exitCode: null };
  const output = presented.card === "terminal"
    ? presented.output ?? raw
    : presented.card === "diff"
      ? printable(presented.diffs)
      : contentText(presented.content, ["text", "reasoning"]) || raw;
  return { output, title: presented.title ?? null, exitCode: presented.exitCode ?? null, signal: presented.signal ?? null };
}

function partialKey(data) {
  return `${data.turn ?? "?"}:${data.step ?? "?"}`;
}

function ensurePartial(partials, data) {
  const key = partialKey(data);
  const existing = partials.get(key) ?? { key, turn: data.turn, step: data.step, blocks: new Map(), rowIndexes: {} };
  partials.set(key, existing);
  return existing;
}

function partialText(partial, kind) {
  return [...partial.blocks.entries()]
    .sort(([left], [right]) => left - right)
    .map(([, block]) => block?.kind === kind ? block.text : "")
    .filter(Boolean)
    .join("");
}

function pushPartialRow(messages, partial, role, text) {
  const index = partial.rowIndexes[role];
  const row = role === "reasoning"
    ? { role, details: text, text: "模型正在分析任务与下一步动作", streaming: true, state: "running", turn: partial.turn, step: partial.step, seq: `partial:${partial.key}:reasoning` }
    : { role, text, streaming: true, state: "running", turn: partial.turn, step: partial.step, seq: `partial:${partial.key}:text` };
  if (index === undefined) {
    partial.rowIndexes[role] = messages.length;
    messages.push(row);
  } else {
    messages[index] = row;
  }
}

/**
 * Group the Harness skill catalog into a readable capability tree. The wire
 * catalog intentionally does not expose provider filesystem paths, so a row
 * uses an actual resource path when supplied and otherwise labels its stable
 * logical catalog location instead of inventing a local path.
 * @param {Array<object>} skills Skill catalog rows.
 * @returns {Array<object>} Directory-like groups.
 */
export function groupSkillCatalog(skills) {
  const rows = (skills ?? []).filter((skill) => skill && typeof skill.name === "string");
  const prefixCounts = new Map();
  for (const skill of rows) {
    const prefix = skill.name.includes(":") ? skill.name.split(":", 1)[0] : skill.name.split("-", 1)[0];
    prefixCounts.set(prefix, (prefixCounts.get(prefix) ?? 0) + 1);
  }
  const groups = new Map();
  for (const skill of rows) {
    const explicit = skill.name.includes(":");
    const prefix = explicit ? skill.name.split(":", 1)[0] : skill.name.split("-", 1)[0];
    const groupId = explicit || (prefixCounts.get(prefix) ?? 0) > 1 ? prefix : "other";
    const group = groups.get(groupId) ?? {
      id: groupId,
      label: groupId === "other" ? "其他能力" : groupId,
      logicalPath: `Skills/${groupId === "other" ? "other" : groupId}`,
      skills: [],
    };
    const resourcePath = skill.path ?? (skill.resourceBase?.kind === "directory" ? skill.resourceBase.path : null);
    group.skills.push({
      name: skill.name,
      description: typeof skill.description === "string" && skill.description.trim()
        ? skill.description.trim()
        : typeof skill.whenToUse === "string" ? skill.whenToUse.trim() : "",
      path: resourcePath ?? `${group.logicalPath}/${skill.name}`,
      pathKind: resourcePath ? "filesystem" : "logical",
      modelInvocable: skill.modelInvocable !== false,
    });
    groups.set(groupId, group);
  }
  return [...groups.values()]
    .map((group) => ({ ...group, skills: group.skills.sort((left, right) => left.name.localeCompare(right.name, "en")) }))
    .sort((left, right) => left.id === "other" ? 1 : right.id === "other" ? -1 : left.label.localeCompare(right.label, "en"));
}

/**
 * Project durable Harness events into JiMu transcript rows. The projection
 * keeps the original event boundaries: streamed assistant chunks stay live,
 * reasoning is a collapsible row, tool call/result pairs share one card, and
 * injected model context remains separate from human-authored chat.
 * @param {Array<unknown>} entries Durable session history entries.
 * @returns {Array<object>} JiMu transcript and environment rows.
 */
export function historyMessages(entries) {
  const messages = [];
  const tools = new Map();
  const partials = new Map();
  const turns = new Map();
  let planIndex = -1;
  const finalizedSteps = new Set((entries ?? []).map(eventEnvelope)
    .filter(({ event }) => event?.type === "assistant/message")
    .map(({ event }) => partialKey(event.data ?? {})));

  for (const entry of entries ?? []) {
    const { event, view } = eventEnvelope(entry);
    const data = event?.data ?? {};
    if (event?.type === "turn/start") {
      turns.set(data.turn, { startedAt: event.time ?? null, steps: 0 });
      continue;
    }
    if (event?.type === "step/start") {
      const turn = turns.get(data.turn) ?? { startedAt: null, steps: 0 };
      turn.steps = Math.max(turn.steps, Number(data.step) || turn.steps + 1);
      turns.set(data.turn, turn);
      continue;
    }
    if (event?.type === "user/message") {
      const text = contentText(data.content ?? data.message?.content, ["text"]);
      if (!text) continue;
      const source = data.source ?? data.message?.source;
      if (source?.kind && source.kind !== "user") {
        const descriptor = contextDescriptor(source);
        messages.push({ role: "context", ...descriptor, details: text, seq: event.seq });
      } else {
        messages.push({ role: "user", text, turn: data.turn, seq: event.seq });
      }
      continue;
    }
    if (event?.type === "assistant/chunk") {
      if (finalizedSteps.has(partialKey(data))) continue;
      const partial = ensurePartial(partials, data);
      const chunk = data.chunk ?? {};
      const current = partial.blocks.get(chunk.index);
      if (chunk.type === "block-start") partial.blocks.set(chunk.index, { kind: chunk.blockType, text: "" });
      if (chunk.type === "text-delta") partial.blocks.set(chunk.index, { kind: "text", text: `${current?.kind === "text" ? current.text : ""}${chunk.text ?? ""}` });
      if (chunk.type === "reasoning-delta") partial.blocks.set(chunk.index, { kind: "reasoning", text: `${current?.kind === "reasoning" ? current.text : ""}${chunk.text ?? ""}` });
      if (chunk.type === "block-end") {
        const block = chunk.block ?? {};
        if (block.type === "text" || block.type === "reasoning") partial.blocks.set(chunk.index, { kind: block.type, text: block.text ?? "" });
      }
      const reasoning = partialText(partial, "reasoning");
      const text = partialText(partial, "text");
      if (reasoning) pushPartialRow(messages, partial, "reasoning", reasoning);
      if (text) pushPartialRow(messages, partial, "assistant", text);
      continue;
    }
    if (event?.type === "assistant/message") {
      const blocks = contentBlocks(data.message?.content ?? data.content);
      const reasoning = contentText(blocks, ["reasoning"]);
      const text = contentText(blocks, ["text"]);
      if (reasoning) messages.push({ role: "reasoning", text: "查看模型分析过程", details: reasoning, state: "complete", turn: data.turn, step: data.step, seq: `${event.seq}:reasoning` });
      if (text) messages.push({ role: "assistant", text, state: "complete", turn: data.turn, step: data.step, seq: event.seq });
      continue;
    }
    if (event?.type === "tool/call") {
      const presentation = callPresentation(view, data);
      const row = {
        role: "tool",
        callId: data.callId,
        name: data.name ?? "unknown",
        ...presentation,
        state: "running",
        turn: data.turn,
        step: data.step,
        seq: event.seq,
      };
      tools.set(String(data.callId), messages.length);
      messages.push(row);
      continue;
    }
    if (event?.type === "tool/result") {
      const failed = Boolean(data.isError || data.error);
      const result = resultPresentation(view, data);
      const callId = String(data.callId ?? data.message?.source?.callId ?? "");
      const index = tools.get(callId);
      if (index !== undefined) {
        messages[index] = {
          ...messages[index],
          ...(result.title ? { title: result.title } : {}),
          output: result.output,
          exitCode: result.exitCode,
          signal: result.signal,
          state: failed ? "error" : "complete",
          completedSeq: event.seq,
        };
      } else {
        messages.push({
          role: "tool",
          callId,
          name: (data.name ?? callId) || "unknown",
          title: data.name ?? `工具 ${callId || "结果"}`,
          summary: failed ? "工具执行失败" : "工具执行完成",
          input: "",
          output: result.output,
          state: failed ? "error" : "complete",
          turn: data.turn,
          step: data.step,
          seq: event.seq,
        });
      }
      continue;
    }
    if (event?.type === "todo/write") {
      const todos = Array.isArray(data.todos) ? data.todos : [];
      const text = todos.length === 0 ? "计划已清空" : todos.map((todo) => `${todo.status === "completed" ? "✓" : todo.status === "in_progress" ? "→" : "○"} ${todo.content}`).join("\n");
      const next = { role: "plan", title: "执行计划", text, todos, state: todos.some((todo) => todo.status === "in_progress") ? "running" : "complete", turn: data.turn, step: data.step, seq: event.seq };
      if (planIndex >= 0) messages[planIndex] = next;
      else {
        planIndex = messages.length;
        messages.push(next);
      }
      continue;
    }
    if (event?.type === "llm/retry" || event?.type === "llm/retry-started") {
      messages.push({ role: "status", title: "模型请求重试", text: printable(data.reason ?? data.error ?? "Harness 正在重新连接模型"), state: "warning", turn: data.turn, step: data.step, seq: event.seq });
      continue;
    }
    if (event?.type === "compaction/start" || event?.type === "compaction/end") {
      messages.push({ role: "status", title: "上下文压缩", text: event.type.endsWith("start") ? "正在整理较早的会话上下文" : "上下文压缩完成", state: event.type.endsWith("start") ? "running" : "complete", turn: data.turn, step: data.step, seq: event.seq });
      continue;
    }
    if (event?.type === "compaction/summary") {
      const count = Array.isArray(data.shadowedSeqs) ? data.shadowedSeqs.length : 0;
      messages.push({ role: "status", title: "上下文压缩", text: count > 0 ? `已压缩 ${count} 条较早消息` : "上下文压缩完成", state: "complete", turn: data.turn, step: data.step, seq: event.seq });
      continue;
    }
    if (event?.type === "permission/preset" || event?.type === "sandbox/mode" || event?.type === "approval/policy") {
      const label = event.type === "permission/preset" ? "权限预设" : event.type === "sandbox/mode" ? "沙箱模式" : "审批策略";
      const value = typeof data.preset === "string" ? data.preset
        : typeof data.mode === "string" ? data.mode
          : typeof data.policy === "string" ? data.policy : "";
      if (value) messages.push({ role: "context", label, meta: value, details: `${label}已切换为 ${value}`, contextKind: "runtime", seq: event.seq });
      continue;
    }
    if (event?.type === "turn/end") {
      const state = turnState(data.reason);
      for (const [callId, index] of tools) {
        if (messages[index]?.turn === data.turn && messages[index]?.state === "running") {
          messages[index] = { ...messages[index], state: "stopped", output: messages[index].output || turnFailureText(data.reason) };
          tools.delete(callId);
        }
      }
      const turn = turns.get(data.turn) ?? { startedAt: null, steps: 0 };
      const duration = Number.isFinite(event.time) && Number.isFinite(turn.startedAt) ? Math.max(0, event.time - turn.startedAt) : null;
      messages.push({
        role: "turn",
        title: turnStatusText(data.reason),
        text: `${turn.steps || data.step || 1} 个步骤${duration === null ? "" : ` · ${(duration / 1000).toFixed(1)}s`}`,
        state,
        turn: data.turn,
        seq: event.seq,
      });
    }
  }
  return messages;
}

/**
 * Convert a Harness failure into user-facing copy and an optional recovery
 * destination while keeping provider diagnostics out of the main UI.
 * @param {unknown} error Harness error value.
 * @returns {{title: string, message: string, action: "settings" | null} | null} Display description.
 */
export function describeHarnessError(error) {
  if (error === null || error === undefined || error === "") return null;
  const message = error instanceof Error ? error.message : String(error);
  if (/MISSING_CREDENTIAL|no API key for provider route/i.test(message)) {
    return {
      title: "DeepSeek API Key 未配置",
      message: "JiMu 使用独立凭据存储。请在“设置 → 模型”中保存 DEEPSEEK_API_KEY 后重试。",
      action: "settings",
    };
  }
  return { title: "操作未完成", message, action: null };
}

/**
 * Fold token accounting from durable `assistant/message` events into one
 * cache-hit summary. The cache rate is `cacheRead / (input + cacheRead)`,
 * matching DeepSeek's disjoint wire accounting; null when no usage exists.
 * @param {Array<unknown>} entries Durable session history entries.
 * @returns {{requests: number, inputTokens: number, outputTokens: number, cacheReadTokens: number, cacheWriteTokens: number, reasoningTokens: number, cacheRate: number | null, lastCacheRate: number | null}}
 */
export function summarizeUsage(entries) {
  const totals = {
    requests: 0,
    inputTokens: 0,
    outputTokens: 0,
    cacheReadTokens: 0,
    cacheWriteTokens: 0,
    reasoningTokens: 0,
    last: null,
  };
  for (const entry of entries ?? []) {
    const { event } = eventEnvelope(entry);
    if (event?.type !== "assistant/message") continue;
    const usage = event.data?.usage;
    if (usage === null || typeof usage !== "object") continue;
    totals.requests += 1;
    totals.inputTokens += typeof usage.inputTokens === "number" ? usage.inputTokens : 0;
    totals.outputTokens += typeof usage.outputTokens === "number" ? usage.outputTokens : 0;
    totals.cacheReadTokens += typeof usage.cacheReadTokens === "number" ? usage.cacheReadTokens : 0;
    totals.cacheWriteTokens += typeof usage.cacheWriteTokens === "number" ? usage.cacheWriteTokens : 0;
    totals.reasoningTokens += typeof usage.reasoningTokens === "number" ? usage.reasoningTokens : 0;
    totals.last = usage;
  }
  const totalInput = totals.inputTokens + totals.cacheReadTokens;
  const lastInput = (totals.last?.inputTokens ?? 0) + (totals.last?.cacheReadTokens ?? 0);
  return {
    requests: totals.requests,
    inputTokens: totals.inputTokens,
    outputTokens: totals.outputTokens,
    cacheReadTokens: totals.cacheReadTokens,
    cacheWriteTokens: totals.cacheWriteTokens,
    reasoningTokens: totals.reasoningTokens,
    cacheRate: totals.requests > 0 && totalInput > 0 ? totals.cacheReadTokens / totalInput : null,
    lastCacheRate: totals.requests > 0 && lastInput > 0 ? (totals.last?.cacheReadTokens ?? 0) / lastInput : null,
  };
}
