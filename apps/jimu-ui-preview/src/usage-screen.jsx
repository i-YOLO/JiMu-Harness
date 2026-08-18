import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  ArrowClockwise,
  CalendarBlank,
  CaretLeft,
  CaretRight,
  ChartBar,
  ChartLine,
  ChartPieSlice,
} from "@phosphor-icons/react";

/**
 * Token 用量监测 Tab。
 *
 * 数据全部来自会话持久日志（session.history 中的 assistant/message.usage），
 * 只读、零持久化：页面状态只存在内存里，按 sessionId + updatedAt 缓存折叠结果，
 * 会话有变化（updatedAt 变更或收到实时 usage 事件）才重新拉取该会话历史。
 *
 * 指标口径：
 *  - 输入未命中  = usage.inputTokens（重新送进模型的输入）
 *  - 缓存命中    = usage.cacheReadTokens（命中缓存的输入，便宜部分）
 *  - 缓存写入    = usage.cacheWriteTokens（累积写进缓存的新内容）
 *  - 输出        = usage.outputTokens
 *  - 推理        = usage.reasoningTokens（输出中的思考链部分）
 *  - 总消耗      = 输入未命中 + 缓存命中 + 输出（与计费口径一致，不含缓存写入）
 *  - 命中率      = 缓存命中 / (输入未命中 + 缓存命中)，与 DeepSeek 输入口径一致
 *
 * 防闪烁约定：内容区域只依赖 rows 是否存在来挂载；"refreshing" 只是工具栏上的
 * 细微状态，任何刷新都不会让整页卸载重挂（否则滚动位置会重置、页面会闪）。
 */

const ACCENT_SEQUENCE = ["magenta", "teal", "cobalt", "yellow"];
const DAY_MS = 86_400_000;
/** 固定中国时区（UTC+8）：所有显示与按天分桶都使用北京时间，不随系统时区变化。 */
const CN_OFFSET_MS = 8 * 60 * 60 * 1000;

function num(value) {
  return typeof value === "number" && Number.isFinite(value) ? value : 0;
}

function fmt(value) {
  if (value === null || value === undefined || !Number.isFinite(value)) return "—";
  return Math.round(value).toLocaleString("zh-CN");
}

function compact(value) {
  if (!Number.isFinite(value)) return "—";
  if (value >= 100_000_000) return `${(value / 100_000_000).toFixed(1)}亿`;
  if (value >= 10_000) return `${(value / 10_000).toFixed(1)}万`;
  return fmt(value);
}

function pct(value) {
  if (value === null || value === undefined || !Number.isFinite(value)) return "—";
  return `${(value * 100).toFixed(1)}%`;
}

const pad2 = (n) => String(n).padStart(2, "0");

function dayKey(timestamp) {
  const d = new Date(timestamp + CN_OFFSET_MS);
  return `${d.getUTCFullYear()}-${pad2(d.getUTCMonth() + 1)}-${pad2(d.getUTCDate())}`;
}

function dayLabel(timestamp) {
  const d = new Date(timestamp + CN_OFFSET_MS);
  return `${pad2(d.getUTCMonth() + 1)}-${pad2(d.getUTCDate())}`;
}

function startOfDay(timestamp) {
  const shifted = new Date(timestamp + CN_OFFSET_MS);
  shifted.setUTCHours(0, 0, 0, 0);
  return shifted.getTime() - CN_OFFSET_MS;
}

function endOfDay(timestamp) {
  return startOfDay(timestamp) + DAY_MS - 1;
}

function formatUpdated(timestamp) {
  const d = new Date(timestamp + CN_OFFSET_MS);
  const now = new Date(Date.now() + CN_OFFSET_MS);
  const sameDay = d.toISOString().slice(0, 10) === now.toISOString().slice(0, 10);
  const time = `${pad2(d.getUTCHours())}:${pad2(d.getUTCMinutes())}`;
  return sameDay ? time : `${dayLabel(timestamp)} ${time}`;
}

/** 外部 Harness home（如 Web GUI 的 ~/.dsh）的展示名。 */
function externalHomeLabel(home) {
  if (typeof home !== "string" || home.length === 0) return "外部 Harness";
  if (home.endsWith("/.dsh") || home.endsWith("\\.dsh")) return "Web GUI (~/.dsh)";
  return home.split("/").filter(Boolean).at(-1) ?? home;
}

/** 外部会话无标题投影时的兜底名称（用创建时间，中国时区）。 */
function externalSessionLabel(createdAt) {
  if (typeof createdAt !== "number" || !Number.isFinite(createdAt)) return "外部会话";
  const d = new Date(createdAt + CN_OFFSET_MS);
  return `外部会话 · ${pad2(d.getUTCMonth() + 1)}-${pad2(d.getUTCDate())} ${pad2(d.getUTCHours())}:${pad2(d.getUTCMinutes())}`;
}

/** Fold one request record into a session row (shared by history fold + live events). */
function addRequest(row, time, usage) {
  const input = num(usage.inputTokens);
  const cacheRead = num(usage.cacheReadTokens);
  const cacheWrite = num(usage.cacheWriteTokens);
  const output = num(usage.outputTokens);
  const reasoning = num(usage.reasoningTokens);
  const totalInput = row.inputTokens + row.cacheReadTokens + input + cacheRead;
  const totalOutput = row.outputTokens + output;
  const totalTokens = totalInput + totalOutput;
  const key = time === null ? "today" : dayKey(time);
  const label = time === null ? "今日" : dayLabel(time);
  const previousDay = row.days.get(key);
  const day = previousDay
    ? { ...previousDay }
    : { key, label, input: 0, cacheRead: 0, output: 0, reasoning: 0, requests: 0 };
  day.input += input;
  day.cacheRead += cacheRead;
  day.output += output;
  day.reasoning += reasoning;
  day.requests += 1;
  const days = new Map(row.days);
  days.set(key, day);
  return {
    ...row,
    requests: row.requests + 1,
    inputTokens: row.inputTokens + input,
    cacheReadTokens: row.cacheReadTokens + cacheRead,
    cacheWriteTokens: row.cacheWriteTokens + cacheWrite,
    outputTokens: row.outputTokens + output,
    reasoningTokens: row.reasoningTokens + reasoning,
    textTokens: Math.max(0, row.textTokens + output - reasoning),
    reasoningRatio: totalOutput > 0 ? (row.reasoningTokens + reasoning) / totalOutput : null,
    hitRate: totalInput > 0 ? (row.cacheReadTokens + cacheRead) / totalInput : null,
    lastHitRate: input + cacheRead > 0 ? cacheRead / (input + cacheRead) : null,
    totalTokens,
    avgTokens: row.requests + 1 > 0 ? totalTokens / (row.requests + 1) : 0,
    peakTokens: Math.max(row.peakTokens, input + cacheRead + output),
    firstAt: row.firstAt === null || (time !== null && time < row.firstAt) ? time : row.firstAt,
    lastAt: time === null ? row.lastAt : Math.max(row.lastAt ?? 0, time),
    days,
  };
}

function emptyRow({ sessionId, projectId, projectTitle, sessionTitle }) {
  return {
    sessionId,
    projectId,
    projectTitle,
    sessionTitle,
    requests: 0,
    inputTokens: 0,
    cacheReadTokens: 0,
    cacheWriteTokens: 0,
    outputTokens: 0,
    reasoningTokens: 0,
    textTokens: 0,
    reasoningRatio: null,
    hitRate: null,
    lastHitRate: null,
    totalTokens: 0,
    avgTokens: 0,
    peakTokens: 0,
    firstAt: null,
    lastAt: null,
    days: new Map(),
  };
}

/** Build a row from a list of {time, usage} request records. */
function buildRow(meta, requests) {
  let row = emptyRow(meta);
  for (const request of [...requests].sort((a, b) => (a.time ?? 0) - (b.time ?? 0))) {
    row = addRequest(row, request.time, request.usage);
  }
  return row;
}

/** Fold durable history entries into per-request records, deduped by seq. */
function foldRequests(entries) {
  const requests = [];
  const seen = new Set();
  for (const entry of entries ?? []) {
    const event = entry?.event ?? entry;
    if (event?.seq !== undefined) {
      if (seen.has(event.seq)) continue;
      seen.add(event.seq);
    }
    if (event?.type !== "assistant/message") continue;
    const usage = event.data?.usage;
    if (usage === null || typeof usage !== "object") continue;
    requests.push({ time: typeof event.time === "number" ? event.time : null, usage });
  }
  return requests;
}

/** Aggregate all session rows into the overview totals (stat band + trend strip inputs). */
function computeTotals(rows) {
  const totals = {
    requests: 0,
    input: 0,
    cacheRead: 0,
    cacheWrite: 0,
    output: 0,
    reasoning: 0,
    peak: 0,
    sessions: rows.length,
    activeSessions: 0,
    today: 0,
    week: 0,
    latest: null,
    topShare: null,
  };
  let latestRow = null;
  let topTokens = 0;
  for (const row of rows) {
    totals.requests += row.requests;
    totals.input += row.inputTokens;
    totals.cacheRead += row.cacheReadTokens;
    totals.cacheWrite += row.cacheWriteTokens;
    totals.output += row.outputTokens;
    totals.reasoning += row.reasoningTokens;
    totals.peak = Math.max(totals.peak, row.peakTokens);
    if (row.requests > 0) totals.activeSessions += 1;
    topTokens = Math.max(topTokens, row.totalTokens);
    if (row.lastAt !== null && (latestRow === null || row.lastAt > latestRow.lastAt)) latestRow = row;
    const todayKey = dayKey(Date.now());
    const todayBucket = row.days.get(todayKey);
    if (todayBucket) totals.today += todayBucket.input + todayBucket.cacheRead + todayBucket.output;
    const now = Date.now();
    for (const [key, bucket] of row.days) {
      const time = Date.parse(`${key}T12:00:00+08:00`);
      if (now - time <= 7 * DAY_MS) totals.week += bucket.input + bucket.cacheRead + bucket.output;
    }
  }
  const totalTokens = totals.input + totals.cacheRead + totals.output;
  if (totalTokens > 0 && rows.length > 0) totals.topShare = topTokens / totalTokens;
  totals.totalTokens = totalTokens;
  totals.totalInput = totals.input + totals.cacheRead;
  totals.hitRate = totals.totalInput > 0 ? totals.cacheRead / totals.totalInput : null;
  totals.reasoningRatio = totals.output > 0 ? totals.reasoning / totals.output : null;
  totals.avgPerRequest = totals.requests > 0 ? totalTokens / totals.requests : null;
  totals.avgInput = totals.requests > 0 ? totals.totalInput / totals.requests : null;
  totals.lastHitRate = latestRow?.lastHitRate ?? null;
  return totals;
}

function StatBlock({ accent, value, label, sub }) {
  return (
    <article className="usage-stat-block" data-accent={accent}>
      <strong>{value}</strong>
      <span>{label}</span>
      <small>{sub}</small>
    </article>
  );
}

/** 三键图表切换组（柱状 / 扇形 / 折线）。 */
const CHART_OPTIONS = [
  { id: "bar", label: "柱状", icon: ChartBar },
  { id: "donut", label: "扇形", icon: ChartPieSlice },
  { id: "line", label: "折线", icon: ChartLine },
];

/** 时间范围切换（近 7 / 14 / 30 天 / 自定义）。 */
const RANGE_OPTIONS = [
  { id: "7", label: "近 7 天" },
  { id: "14", label: "近 14 天" },
  { id: "30", label: "近 30 天" },
  { id: "custom", label: "自定义", icon: CalendarBlank },
];

function SegToggle({ options, value, onChange }) {
  return (
    <div className="usage-seg" role="tablist">
      {options.map((option) => {
        const Icon = option.icon;
        const active = value === option.id;
        return (
          <button
            key={option.id}
            type="button"
            className="usage-seg-button"
            data-active={active || undefined}
            role="tab"
            aria-selected={active}
            onClick={() => onChange(option.id)}
          >
            {Icon && <Icon size={13} weight={active ? "fill" : "regular"} aria-hidden="true" />}
            <span>{option.label}</span>
          </button>
        );
      })}
    </div>
  );
}

/** 堆叠柱状图：输入未命中 / 缓存命中 / 正文输出 / 推理。 */
function BarStrip({ buckets, dayMax }) {
  return (
    <div className="usage-day-strip">
      {buckets.map((bucket) => {
        const total = bucket.input + bucket.cacheRead + bucket.output;
        const segments = [
          { kind: "reasoning", height: bucket.reasoning > 0 ? (bucket.reasoning / dayMax) * 100 : 0 },
          { kind: "output", height: bucket.output - bucket.reasoning > 0 ? ((bucket.output - bucket.reasoning) / dayMax) * 100 : 0 },
          { kind: "cache", height: bucket.cacheRead > 0 ? (bucket.cacheRead / dayMax) * 100 : 0 },
          { kind: "input", height: bucket.input > 0 ? (bucket.input / dayMax) * 100 : 0 },
        ];
        return (
          <div
            className="usage-day-column"
            key={bucket.key}
            title={`${bucket.label} · ${bucket.requests} 次请求\n输入 ${fmt(bucket.input)} · 缓存命中 ${fmt(bucket.cacheRead)}\n输出 ${fmt(bucket.output)} · 推理 ${fmt(bucket.reasoning)}\n合计 ${fmt(total)}`}
          >
            <div className="usage-day-bar" data-empty={total === 0 || undefined}>
              {segments.filter((segment) => segment.height > 0).map((segment) => (
                <i key={segment.kind} data-seg={segment.kind} style={{ height: `${Math.min(100, segment.height)}%` }} />
              ))}
            </div>
            <small>{bucket.label}</small>
          </div>
        );
      })}
    </div>
  );
}

/** 扇形（环形）图：区间 Token 构成，中心显示合计。 */
function DonutChart({ totals }) {
  const { input, cacheRead, text, reasoning, total } = totals;
  const radius = 70;
  const circumference = 2 * Math.PI * radius;
  const slices = [
    { key: "input", label: "输入未命中", value: input, color: "var(--cobalt)" },
    { key: "cache", label: "缓存命中", value: cacheRead, color: "var(--teal)" },
    { key: "output", label: "正文输出", value: text, color: "var(--magenta)" },
    { key: "reasoning", label: "推理", value: reasoning, color: "var(--yellow)" },
  ].filter((slice) => slice.value > 0);
  let accumulated = 0;
  return (
    <div className="usage-chart-donut">
      <div className="usage-donut-svg">
        <svg viewBox="0 0 190 190" role="img" aria-label="区间 Token 构成扇形图">
          {total > 0 ? slices.map((slice) => {
            const length = (slice.value / total) * circumference;
            const element = (
              <circle
                key={slice.key}
                cx="95"
                cy="95"
                r={radius}
                fill="none"
                style={{ stroke: slice.color }}
                strokeWidth="26"
                strokeDasharray={`${length} ${circumference - length}`}
                strokeDashoffset={-accumulated}
                transform="rotate(-90 95 95)"
                className="usage-donut-slice"
              >
                <title>{`${slice.label} ${fmt(slice.value)} Token · ${pct(slice.value / total)}`}</title>
              </circle>
            );
            accumulated += length;
            return element;
          }) : (
            <circle cx="95" cy="95" r={radius} fill="none" stroke="rgb(255 243 210 / 20%)" strokeWidth="26" />
          )}
          <text x="95" y="90" textAnchor="middle" className="usage-donut-total">{fmt(total)}</text>
          <text x="95" y="108" textAnchor="middle" className="usage-donut-caption">总 Token</text>
        </svg>
      </div>
      <div className="usage-chart-legend">
        {slices.length === 0 ? (
          <span className="usage-legend-empty">区间内暂无用量数据</span>
        ) : slices.map((slice) => (
          <span className="usage-legend-row" key={slice.key}>
            <i style={{ background: slice.color }} />
            <em>{slice.label}</em>
            <strong>{fmt(slice.value)}</strong>
            <small>{pct(slice.value / total)}</small>
          </span>
        ))}
      </div>
    </div>
  );
}

function niceCeil(value) {
  if (value <= 0) return 1;
  const magnitude = 10 ** Math.floor(Math.log10(value));
  const norm = value / magnitude;
  const nice = norm <= 1 ? 1 : norm <= 2 ? 2 : norm <= 5 ? 5 : 10;
  return nice * magnitude;
}

/** 折线图：总输入 / 输出 / 推理 三条逐日曲线（纯 SVG + HTML 轴标签）。 */
function LineChart({ buckets }) {
  const count = buckets.length;
  const width = 1000;
  const height = 220;
  const padLeft = 12;
  const padRight = 12;
  const padTop = 14;
  const padBottom = 18;
  const maxValue = Math.max(1, ...buckets.map((bucket) => bucket.input + bucket.cacheRead + bucket.output));
  const niceMax = niceCeil(maxValue);
  const x = (index) => count <= 1
    ? (padLeft + width - padRight) / 2
    : padLeft + (index * (width - padLeft - padRight)) / (count - 1);
  const y = (value) => height - padBottom - (value / niceMax) * (height - padTop - padBottom);
  const gridlines = [0, 0.25, 0.5, 0.75, 1].map((fraction) => ({
    value: niceMax * fraction,
    y: y(niceMax * fraction),
  }));
  const series = [
    { key: "input", label: "总输入（含命中）", color: "var(--cobalt)", value: (bucket) => bucket.input + bucket.cacheRead },
    { key: "output", label: "输出", color: "var(--magenta)", value: (bucket) => bucket.output },
    { key: "reasoning", label: "推理", color: "var(--yellow)", value: (bucket) => bucket.reasoning },
  ];
  const labelStep = Math.max(1, Math.ceil(count / 12));
  return (
    <div className="usage-chart-line">
      <div className="usage-line-plot">
        <svg viewBox={`0 0 ${width} ${height}`} preserveAspectRatio="none" className="usage-line-svg" role="img" aria-label="逐日用量折线图">
          {gridlines.map((line) => (
            <line key={line.value} x1={padLeft} x2={width - padRight} y1={line.y} y2={line.y} className="usage-line-grid" />
          ))}
          {series.map((item) => (
            <g key={item.key}>
              <polyline
                className="usage-line-series"
                data-series={item.key}
                points={buckets.map((bucket, index) => `${x(index)},${y(item.value(bucket))}`).join(" ")}
              />
              {buckets.map((bucket, index) => (
                <rect
                  key={bucket.key}
                  x={x(index) - 2}
                  y={y(item.value(bucket)) - 2}
                  width="4"
                  height="4"
                  className="usage-line-dot"
                  data-series={item.key}
                >
                  <title>{`${bucket.label} · ${item.label} ${fmt(item.value(bucket))}`}</title>
                </rect>
              ))}
            </g>
          ))}
        </svg>
        <div className="usage-line-ylabels">
          {gridlines.map((line) => (
            <span key={line.value} style={{ bottom: `${(line.y / height) * 100}%` }}>{compact(line.value)}</span>
          ))}
        </div>
      </div>
      <div className="usage-line-xlabels">
        {buckets.map((bucket, index) => (index % labelStep === 0 || index === count - 1
          ? <span key={bucket.key} style={{ left: `${(index / Math.max(1, count - 1)) * 100}%` }}>{bucket.label}</span>
          : null))}
      </div>
      <div className="usage-chart-legend usage-chart-legend-line">
        {series.map((item) => (
          <span className="usage-legend-row" key={item.key}>
            <i style={{ background: item.color }} />
            <em>{item.label}</em>
            <strong>{fmt(buckets.reduce((sum, bucket) => sum + item.value(bucket), 0))}</strong>
            <small>区间合计</small>
          </span>
        ))}
      </div>
    </div>
  );
}

/** 自绘日历（区间选择）：不依赖原生 <input type="date">，全套 Retro 样式。 */
const WEEKDAY_LABELS = ["一", "二", "三", "四", "五", "六", "日"];

function buildMonthCells(viewMonth, todayStart) {
  // viewMonth 表示「中国时区的某月 1 日」：内部用 UTC 方法解释，单元格毫秒再换算回真实时间戳。
  const year = viewMonth.getUTCFullYear();
  const month = viewMonth.getUTCMonth();
  const offset = (new Date(Date.UTC(year, month, 1)).getUTCDay() + 6) % 7;
  const daysInMonth = new Date(Date.UTC(year, month + 1, 0)).getUTCDate();
  const cells = [];
  for (let index = 0; index < 42; index += 1) {
    const day = index - offset + 1;
    if (day < 1 || day > daysInMonth) {
      cells.push(null);
      continue;
    }
    const ms = new Date(Date.UTC(year, month, day)).getTime() - CN_OFFSET_MS;
    cells.push({ ms, day, disabled: ms > todayStart });
  }
  return cells;
}

function DateRangePopover({ initialStart, initialEnd, onApply, onClose }) {
  const todayStart = startOfDay(Date.now());
  const [viewMonth, setViewMonth] = useState(() => {
    const base = new Date((initialEnd ?? Date.now()) + CN_OFFSET_MS);
    return new Date(Date.UTC(base.getUTCFullYear(), base.getUTCMonth(), 1));
  });
  const [start, setStart] = useState(initialStart);
  const [end, setEnd] = useState(initialEnd);
  const cells = useMemo(() => buildMonthCells(viewMonth, todayStart), [viewMonth, todayStart]);
  const canApply = start !== null && end !== null;
  const nowCn = new Date(Date.now() + CN_OFFSET_MS);
  const canNext = viewMonth.getUTCFullYear() < nowCn.getUTCFullYear()
    || (viewMonth.getUTCFullYear() === nowCn.getUTCFullYear() && viewMonth.getUTCMonth() < nowCn.getUTCMonth());

  function pick(ms) {
    if (start === null) setStart(ms);
    else if (end === null) {
      if (ms < start) setStart(ms);
      else setEnd(ms);
    } else {
      setStart(ms);
      setEnd(null);
    }
  }

  function apply() {
    if (!canApply) return;
    const dayStart = Math.min(start, end);
    let dayEnd = Math.max(start, end);
    if (dayEnd - dayStart > 365 * DAY_MS) dayEnd = dayStart + 365 * DAY_MS;
    onApply(dayStart, dayEnd);
  }

  function shiftMonth(delta) {
    setViewMonth((current) => new Date(Date.UTC(current.getUTCFullYear(), current.getUTCMonth() + delta, 1)));
  }

  return (
    <>
      <button className="usage-calendar-backdrop" type="button" aria-label="关闭日历" onClick={onClose} />
      <div className="usage-calendar" role="dialog" aria-label="选择自定义日期区间">
        <header className="usage-calendar-head">
          <button type="button" className="usage-calendar-nav" aria-label="上个月" onClick={() => shiftMonth(-1)}>
            <CaretLeft size={14} weight="bold" aria-hidden="true" />
          </button>
          <strong>{viewMonth.getUTCFullYear()} 年 {viewMonth.getUTCMonth() + 1} 月</strong>
          <button
            type="button"
            className="usage-calendar-nav"
            aria-label="下个月"
            disabled={!canNext}
            onClick={() => shiftMonth(1)}
          >
            <CaretRight size={14} weight="bold" aria-hidden="true" />
          </button>
        </header>
        <div className="usage-calendar-weekdays">
          {WEEKDAY_LABELS.map((label) => <span key={label}>{label}</span>)}
        </div>
        <div className="usage-calendar-grid">
          {cells.map((cell, index) => {
            if (cell === null) return <span className="usage-cal-day usage-cal-day-blank" key={index} />;
            const isStart = start !== null && cell.ms === start;
            const isEnd = end !== null && cell.ms === end;
            const inRange = start !== null && end !== null && cell.ms > Math.min(start, end) && cell.ms < Math.max(start, end);
            const isToday = cell.ms === todayStart;
            return (
              <button
                type="button"
                key={cell.ms}
                className="usage-cal-day"
                data-start={isStart || undefined}
                data-end={isEnd || undefined}
                data-range={inRange || undefined}
                data-today={isToday || undefined}
                disabled={cell.disabled}
                onClick={() => pick(cell.ms)}
              >
                {cell.day}
              </button>
            );
          })}
        </div>
        <div className="usage-calendar-selection">
          {start === null
            ? "点击选择开始日期"
            : end === null
              ? `开始 ${dayLabel(start)} · 再点击选择结束日期`
              : `${dayLabel(Math.min(start, end))} → ${dayLabel(Math.max(start, end))} · ${Math.round((Math.max(start, end) - Math.min(start, end)) / DAY_MS) + 1} 天`}
        </div>
        <footer className="usage-calendar-footer">
          <button type="button" className="usage-calendar-btn" onClick={onClose}>取消</button>
          <button type="button" className="usage-calendar-btn usage-calendar-btn-primary" disabled={!canApply} onClick={apply}>应用</button>
        </footer>
      </div>
    </>
  );
}

function UsageScreen({ harnessApi, onOpenSession }) {
  const desktop = harnessApi.available();
  const [rows, setRows] = useState([]);
  const [phase, setPhase] = useState(desktop ? "loading" : "ready");
  const [error, setError] = useState(null);
  const [refreshError, setRefreshError] = useState(null);
  const [lastRefreshed, setLastRefreshed] = useState(null);
  const [externalHomes, setExternalHomes] = useState([]);
  const [chartKind, setChartKind] = useState("bar");
  const [rangeKind, setRangeKind] = useState("14");
  const [customRange, setCustomRange] = useState({ start: null, end: null });
  const [rangeOpen, setRangeOpen] = useState(false);
  const rowsRef = useRef(rows);
  const phaseRef = useRef(phase);
  const cacheRef = useRef(new Map());
  const dirtyRef = useRef(new Map());
  const externalCacheRef = useRef({ at: 0, data: [] });
  const collectingRef = useRef(false);
  const rerunRef = useRef(false);
  const collectTimerRef = useRef(null);
  const safetyTimerRef = useRef(null);
  const attemptsRef = useRef(0);

  useEffect(() => { rowsRef.current = rows; }, [rows]);
  useEffect(() => { phaseRef.current = phase; }, [phase]);

  /** 其他 Harness home（如 Web GUI 的 ~/.dsh）的会话用量，5 秒内复用扫描结果。 */
  async function fetchExternalSessions() {
    const scan = globalThis.window.jimu?.usage?.scanExternal;
    if (typeof scan !== "function") return [];
    const cached = externalCacheRef.current;
    if (cached.data.length > 0 && Date.now() - cached.at < 5000) return cached.data;
    const data = await scan();
    const normalized = Array.isArray(data) ? data : [];
    externalCacheRef.current = { at: Date.now(), data: normalized };
    return normalized;
  }

  const collect = useCallback(async () => {
    if (!desktop) {
      setRows([]);
      setPhase("ready");
      return;
    }
    if (collectingRef.current) {
      rerunRef.current = true;
      return;
    }
    collectingRef.current = true;
    // 关键防闪烁点：已有数据时只进入 "refreshing"（内容不卸载），首次才 "loading"。
    setPhase((current) => (rowsRef.current.length > 0 ? "refreshing" : "loading"));
    try {
      const [workspaceState, sessionState, externalSessions] = await Promise.all([
        harnessApi.call("workspace.list", {}),
        harnessApi.call("session.list", {}),
        fetchExternalSessions().catch(() => []),
      ]);
      const summaries = new Map(
        (sessionState?.items ?? [])
          .filter((summary) => summary?.origin !== "subagent")
          .map((summary) => [summary.sessionId, summary]),
      );
      const archived = new Set(workspaceState?.archivedSessionIds ?? []);
      const accounted = new Set((workspaceState?.items ?? []).flatMap((workspace) => workspace.sessionIds));
      const candidates = [];
      for (const workspace of workspaceState?.items ?? []) {
        for (const sessionId of workspace.sessionIds ?? []) {
          const summary = summaries.get(sessionId);
          if (!summary || archived.has(sessionId)) continue;
          candidates.push({
            sessionId,
            projectId: workspace.workspaceId,
            projectTitle: workspace.title,
            sessionTitle: sessionTitleOf(summary),
            blank: summary.blank === true,
            updatedAt: num(summary.updatedAt),
          });
        }
      }
      for (const summary of summaries.values()) {
        if (accounted.has(summary.sessionId) || archived.has(summary.sessionId)) continue;
        candidates.push({
          sessionId: summary.sessionId,
          projectId: "ungrouped",
          projectTitle: "未归档会话",
          sessionTitle: sessionTitleOf(summary),
          blank: summary.blank === true,
          updatedAt: num(summary.updatedAt),
        });
      }
      const nextRows = [];
      for (const candidate of candidates) {
        if (candidate.blank) continue;
        const cached = cacheRef.current.get(candidate.sessionId);
        const dirtyTime = dirtyRef.current.get(candidate.sessionId);
        const mustRefetch = dirtyTime !== undefined || cached?.updatedAt !== candidate.updatedAt;
        let row = cached?.row;
        if (mustRefetch) {
          const requests = await fetchSessionRequests(harnessApi, candidate.sessionId);
          row = buildRow(candidate, requests);
          cacheRef.current.set(candidate.sessionId, { updatedAt: candidate.updatedAt, row });
          if (dirtyTime !== undefined && row.lastAt !== null && row.lastAt >= dirtyTime - 1000) {
            dirtyRef.current.delete(candidate.sessionId);
          }
        }
        if (row) nextRows.push(row);
      }
      // 合并其他 Harness home（如 Web GUI）的会话用量：只读扫描，来源标注在项目/会话名上。
      const homeSet = new Set();
      for (const ext of externalSessions ?? []) {
        if (ext === null || typeof ext !== "object") continue;
        if (typeof ext.sessionId !== "string" || typeof ext.home !== "string") continue;
        if (!Array.isArray(ext.requests) || ext.requests.length === 0) continue;
        if (nextRows.some((row) => row.sessionId === ext.sessionId)) continue;
        homeSet.add(ext.home);
        nextRows.push(buildRow({
          sessionId: ext.sessionId,
          projectId: `external:${ext.home}`,
          projectTitle: externalHomeLabel(ext.home),
          sessionTitle: typeof ext.title === "string" && ext.title.length > 0 ? ext.title : externalSessionLabel(ext.createdAt),
        }, ext.requests));
      }
      setExternalHomes([...homeSet]);
      setRows(nextRows);
      setPhase("ready");
      setRefreshError(null);
      setError(null);
      setLastRefreshed(Date.now());
      attemptsRef.current = 0;
    } catch (caught) {
      const message = caught instanceof Error ? caught.message : String(caught);
      if (rowsRef.current.length > 0) {
        // 已有数据时刷新失败：保留旧数据，只在工具栏提示。
        setPhase("ready");
        setRefreshError(message);
      } else {
        setPhase("error");
        setError(message);
      }
    } finally {
      collectingRef.current = false;
      if (rerunRef.current) {
        rerunRef.current = false;
        void collect();
      }
    }
  }, [desktop, harnessApi]);

  const scheduleCollect = useCallback((withSafety = false) => {
    clearTimeout(collectTimerRef.current);
    collectTimerRef.current = setTimeout(() => { void collect(); }, 350);
    // 实时 usage 事件落盘存在竞争：事件已送达但历史尚未持久化时，
    // 3 秒后的兜底重扫保证最终数字与持久日志一致（只在真收到 usage 事件时调度）。
    if (withSafety) {
      clearTimeout(safetyTimerRef.current);
      safetyTimerRef.current = setTimeout(() => { void collect(); }, 3000);
    }
  }, [collect]);

  // 首次加载：预览模式直接构建演示数据；桌面模式在 harness 尚在启动时每 800ms 重试。
  useEffect(() => {
    if (!desktop) {
      void collect();
      return undefined;
    }
    let active = true;
    let timer;
    const tick = async () => {
      if (!active) return;
      await collect();
      if (!active || phaseRef.current === "ready") return;
      attemptsRef.current += 1;
      if (attemptsRef.current < 40) timer = setTimeout(tick, 800);
    };
    void tick();
    return () => {
      active = false;
      clearTimeout(timer);
      clearTimeout(collectTimerRef.current);
      clearTimeout(safetyTimerRef.current);
    };
  }, [desktop, collect]);

  // 实时事件：任意会话的 usage 落地即时累加；结构变化触发重枚举。
  useEffect(() => {
    if (!desktop) return undefined;
    const unsubscribe = harnessApi.subscribeEvents((update) => {
      const envelope = update?.frame;
      const payload = envelope?.payload ?? envelope;
      if (!payload || typeof payload !== "object") return;
      if (payload.type === "session/event") {
        const event = payload.event;
        const data = event?.data ?? {};
        if (event?.type === "assistant/message" && data.usage && typeof data.usage === "object") {
          const exists = rowsRef.current.some((row) => row.sessionId === payload.sessionId);
          if (exists) {
            setRows((current) => current.map((row) => row.sessionId !== payload.sessionId
              ? row
              : addRequest(row, typeof event.time === "number" ? event.time : null, data.usage)));
          } else {
            dirtyRef.current.set(payload.sessionId, typeof event.time === "number" ? event.time : Date.now());
          }
          scheduleCollect(true);
        }
      }
      if (payload.sessionId || payload.type?.startsWith("host/workspace") || payload.type === "host/archived-sessions-changed") {
        scheduleCollect(false);
      }
    });
    return () => { unsubscribe?.(); };
  }, [desktop, harnessApi, scheduleCollect]);

  const totals = useMemo(() => computeTotals(rows), [rows]);

  // 时间范围（近 7/14/30 天或自定义区间），产出 [start, end] 毫秒边界。
  const range = useMemo(() => {
    if (rangeKind === "custom" && customRange.start !== null && customRange.end !== null) {
      return {
        start: Math.min(customRange.start, customRange.end),
        end: endOfDay(Math.max(customRange.start, customRange.end)),
      };
    }
    const end = endOfDay(Date.now());
    const days = rangeKind === "7" ? 7 : rangeKind === "30" ? 30 : 14;
    const start = startOfDay(end) - (days - 1) * DAY_MS;
    return { start, end };
  }, [rangeKind, customRange]);

  const dayBuckets = useMemo(() => {
    const buckets = [];
    const count = Math.min(366, Math.floor((range.end - range.start) / DAY_MS) + 1);
    for (let index = 0; index < count; index += 1) {
      const time = range.start + index * DAY_MS;
      const key = dayKey(time);
      let input = 0;
      let cacheRead = 0;
      let output = 0;
      let reasoning = 0;
      let requests = 0;
      for (const row of rows) {
        const bucket = row.days.get(key);
        if (!bucket) continue;
        input += bucket.input;
        cacheRead += bucket.cacheRead;
        output += bucket.output;
        reasoning += bucket.reasoning;
        requests += bucket.requests;
      }
      buckets.push({ key, label: dayLabel(time), input, cacheRead, output, reasoning, requests });
    }
    return buckets;
  }, [rows, range]);

  const dayMax = useMemo(
    () => Math.max(1, ...dayBuckets.map((bucket) => bucket.input + bucket.cacheRead + bucket.output)),
    [dayBuckets],
  );

  const rangeTotals = useMemo(() => {
    let input = 0;
    let cacheRead = 0;
    let output = 0;
    let reasoning = 0;
    let requests = 0;
    for (const bucket of dayBuckets) {
      input += bucket.input;
      cacheRead += bucket.cacheRead;
      output += bucket.output;
      reasoning += bucket.reasoning;
      requests += bucket.requests;
    }
    const total = input + cacheRead + output;
    return { input, cacheRead, output, reasoning, text: Math.max(0, output - reasoning), requests, total };
  }, [dayBuckets]);

  const rangeLabel = `${dayLabel(range.start)} → ${dayLabel(range.end)} · ${dayBuckets.length} 天`;

  const projectCards = useMemo(() => {
    const byProject = new Map();
    for (const row of rows) {
      if (row.requests === 0) continue;
      const card = byProject.get(row.projectId) ?? {
        projectId: row.projectId,
        projectTitle: row.projectTitle,
        sessionCount: 0,
        requests: 0,
        input: 0,
        cacheRead: 0,
        output: 0,
        reasoning: 0,
        totalTokens: 0,
      };
      card.sessionCount += 1;
      card.requests += row.requests;
      card.input += row.inputTokens;
      card.cacheRead += row.cacheReadTokens;
      card.output += row.outputTokens;
      card.reasoning += row.reasoningTokens;
      card.totalTokens += row.totalTokens;
      byProject.set(row.projectId, card);
    }
    const cards = [...byProject.values()].sort((a, b) => b.totalTokens - a.totalTokens);
    return cards.map((card, index) => {
      const totalInput = card.input + card.cacheRead;
      return {
        ...card,
        accent: ACCENT_SEQUENCE[index % ACCENT_SEQUENCE.length],
        hitRate: totalInput > 0 ? card.cacheRead / totalInput : null,
        share: totals.totalTokens > 0 ? card.totalTokens / totals.totalTokens : null,
      };
    });
  }, [rows, totals.totalTokens]);

  const sessionRows = useMemo(() => rows
    .filter((row) => row.requests > 0)
    .sort((a, b) => b.totalTokens - a.totalTokens || (b.lastAt ?? 0) - (a.lastAt ?? 0)), [rows]);

  const statBlocks = [
    { accent: "magenta", value: fmt(totals.totalTokens), label: "总消耗 Token", sub: "输入未命中 + 缓存命中 + 输出" },
    { accent: "teal", value: fmt(totals.cacheRead), label: "缓存命中 Token", sub: `占输入 ${pct(totals.hitRate)}` },
    { accent: "cobalt", value: fmt(totals.input), label: "缓存未命中 Token", sub: `平均 ${fmt(totals.avgInput)} / 次` },
    { accent: "yellow", value: fmt(totals.cacheWrite), label: "缓存写入 Token", sub: "累积写入缓存的新内容" },
    { accent: "cobalt", value: fmt(totals.output), label: "输出 Token", sub: `推理占 ${pct(totals.reasoningRatio)}` },
    { accent: "yellow", value: fmt(totals.reasoning), label: "推理 Token", sub: "思考链部分（含于输出）" },
    { accent: "magenta", value: fmt(totals.requests), label: "请求次数", sub: `平均 ${fmt(totals.avgPerRequest)} Token / 次` },
    { accent: "teal", value: pct(totals.hitRate), label: "累计命中率", sub: `最近一次 ${pct(totals.lastHitRate)}` },
    { accent: "yellow", value: fmt(totals.today), label: "今日用量", sub: `近 7 天 ${fmt(totals.week)}` },
    { accent: "magenta", value: fmt(totals.peak), label: "单次峰值", sub: `Top1 会话占 ${pct(totals.topShare)}` },
  ];

  const chartHints = {
    bar: "堆叠：输入未命中 / 缓存命中 / 正文输出 / 推理",
    donut: "区间构成 · 悬停查看明细",
    line: "总输入 / 输出 / 推理 逐日走势",
  };

  function handleRangeChange(nextKind) {
    if (nextKind === "custom") {
      setRangeOpen(true);
      return;
    }
    setRangeKind(nextKind);
  }

  return (
    <div className="usage-screen">
      <div className="usage-toolbar">
        <span className="usage-toolbar-note">
          <ChartBar size={15} weight="bold" aria-hidden="true" />
          {desktop
            ? `共 ${totals.sessions} 个会话 · ${totals.activeSessions} 个产生用量${externalHomes.length > 0 ? ` · 含 ${externalHomes.length} 个外部数据源` : ""}${lastRefreshed === null ? "" : ` · 更新于 ${formatUpdated(lastRefreshed)}`}`
            : "预览模式 · 演示数据"}
          {refreshError && <em className="usage-refresh-error">· 刷新失败：{refreshError}</em>}
        </span>
        <button className="usage-refresh" type="button" onClick={() => { void collect(); }}>
          {phase === "refreshing" ? (
            <>
              <span className="usage-refresh-dot" aria-hidden="true" />
              刷新中…
            </>
          ) : (
            <>
              <ArrowClockwise size={14} weight="bold" aria-hidden="true" />
              刷新
            </>
          )}
        </button>
      </div>

      {rows.length > 0 && (
        <>
          <section className="usage-stats-band" aria-label="Token 用量总览">
            {statBlocks.map((block) => <StatBlock key={block.label} {...block} />)}
          </section>

          <section className="usage-board">
            <header className="usage-board-head usage-board-head-trend">
              <div className="usage-trend-titles">
                <h3>用量趋势</h3>
                <small>{rangeLabel} · {chartHints[chartKind]}</small>
              </div>
              <div className="usage-board-controls">
                <SegToggle options={CHART_OPTIONS} value={chartKind} onChange={setChartKind} />
                <SegToggle options={RANGE_OPTIONS} value={rangeKind} onChange={handleRangeChange} />
              </div>
            </header>
            {chartKind === "bar" && <BarStrip buckets={dayBuckets} dayMax={dayMax} />}
            {chartKind === "donut" && <DonutChart totals={rangeTotals} />}
            {chartKind === "line" && <LineChart buckets={dayBuckets} />}
            {chartKind === "bar" && (
              <div className="usage-legend">
                <span><i data-seg="input" />输入未命中</span>
                <span><i data-seg="cache" />缓存命中</span>
                <span><i data-seg="output" />正文输出</span>
                <span><i data-seg="reasoning" />推理</span>
              </div>
            )}
            {rangeOpen && (
              <DateRangePopover
                initialStart={customRange.start ?? startOfDay(range.start)}
                initialEnd={customRange.end ?? endOfDay(range.end)}
                onApply={(start, end) => {
                  setCustomRange({ start, end });
                  setRangeKind("custom");
                  setRangeOpen(false);
                }}
                onClose={() => setRangeOpen(false)}
              />
            )}
          </section>

          <section className="usage-board">
            <header className="usage-board-head">
              <h3>按项目汇总</h3>
              <small>{projectCards.length} 个项目 · 点击卡片跳转到对应项目会话</small>
            </header>
            <div className="usage-project-grid">
              {projectCards.map((card) => (
                <button
                  className="usage-project-card"
                  data-accent={card.accent}
                  type="button"
                  key={card.projectId}
                  onClick={() => onOpenSession({ sessionId: firstSessionIdFor(rows, card.projectId) })}
                >
                  <span className="usage-project-eyebrow">PROJECT / {card.sessionCount} 会话</span>
                  <strong className="usage-project-title">{card.projectTitle}</strong>
                  <span className="usage-project-total">{fmt(card.totalTokens)}</span>
                  <small>总 Token · 请求 {fmt(card.requests)} · 命中率 {pct(card.hitRate)}</small>
                  <span className="usage-project-share">
                    <i style={{ width: `${Math.round((card.share ?? 0) * 100)}%` }} />
                  </span>
                </button>
              ))}
            </div>
          </section>

          <section className="usage-board">
            <header className="usage-board-head">
              <h3>按会话排行</h3>
              <small>{sessionRows.length} 个会话按总消耗降序 · 点击行跳转到 Agent 工作台</small>
            </header>
            <div className="usage-table-scroll">
              <table className="usage-session-table">
                <thead>
                  <tr>
                    <th className="usage-th-session">会话</th>
                    <th>请求</th>
                    <th>输入未命中</th>
                    <th>缓存命中</th>
                    <th>缓存写入</th>
                    <th>输出</th>
                    <th>推理</th>
                    <th className="usage-th-hit">命中率</th>
                    <th>总 Token</th>
                    <th>最近更新</th>
                  </tr>
                </thead>
                <tbody>
                  {sessionRows.map((row) => (
                    <tr
                      key={row.sessionId}
                      className="usage-session-row"
                      onClick={() => onOpenSession({ sessionId: row.sessionId })}
                      title="跳转到该会话"
                    >
                      <td className="usage-th-session">
                        <strong>{row.sessionTitle}</strong>
                        <small>{row.projectTitle}</small>
                      </td>
                      <td>{fmt(row.requests)}</td>
                      <td>{fmt(row.inputTokens)}</td>
                      <td>{fmt(row.cacheReadTokens)}</td>
                      <td>{fmt(row.cacheWriteTokens)}</td>
                      <td>{fmt(row.outputTokens)}</td>
                      <td>{fmt(row.reasoningTokens)}</td>
                      <td className="usage-th-hit">
                        <span className="usage-hit-track">
                          <i style={{ width: `${Math.round((row.hitRate ?? 0) * 100)}%` }} />
                        </span>
                        <em>{pct(row.hitRate)}</em>
                      </td>
                      <td className="usage-cell-total">{fmt(row.totalTokens)}</td>
                      <td>{row.lastAt === null ? "—" : formatUpdated(row.lastAt)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </section>
        </>
      )}

      {rows.length === 0 && phase === "loading" && (
        <div className="usage-loading">
          {[0, 1, 2, 3, 4].map((index) => <span key={index} />)}
          <p>正在读取会话用量…</p>
        </div>
      )}

      {rows.length === 0 && phase === "error" && (
        <div className="usage-empty">
          <strong>用量读取失败</strong>
          <span>{error}</span>
          <button type="button" onClick={() => { attemptsRef.current = 0; void collect(); }}>重试</button>
        </div>
      )}

      {rows.length === 0 && phase !== "loading" && phase !== "error" && (
        <div className="usage-empty">
          <strong>暂无用量数据</strong>
          <span>在 Agent 工作台发起对话后，这里会按会话累计每次请求的 Token 明细（输入、缓存命中、缓存写入、输出、推理）。</span>
        </div>
      )}
    </div>
  );
}

function sessionTitleOf(summary) {
  if (summary.blank === true) return "新会话";
  const title = summary.projections?.values?.title;
  return typeof title === "string" && title.length > 0 ? title : summary.sessionId.slice(0, 8);
}

function firstSessionIdFor(rows, projectId) {
  const row = rows.find((item) => item.projectId === projectId && item.requests > 0);
  return row?.sessionId ?? rows.find((item) => item.projectId === projectId)?.sessionId ?? null;
}

async function fetchSessionRequests(harnessApi, sessionId) {
  const requests = [];
  const seen = new Set();
  let beforeSeq;
  let pages = 0;
  while (pages < 25) {
    const payload = beforeSeq === undefined ? { sessionId } : { sessionId, beforeSeq };
    const result = await harnessApi.call("session.history", { ...payload, maxMessages: 300 });
    const entries = result?.events ?? [];
    let minSeq = null;
    let sawNew = false;
    for (const entry of entries) {
      const event = entry?.event ?? entry;
      if (event?.seq !== undefined) {
        if (seen.has(event.seq)) continue;
        seen.add(event.seq);
        sawNew = true;
        if (minSeq === null || event.seq < minSeq) minSeq = event.seq;
      }
      if (event?.type === "assistant/message" && event.data?.usage && typeof event.data.usage === "object") {
        requests.push({ time: typeof event.time === "number" ? event.time : null, usage: event.data.usage });
      }
    }
    pages += 1;
    if (!result?.hasMore || entries.length === 0 || !sawNew || minSeq === null || requests.length > 8000) break;
    beforeSeq = minSeq;
  }
  return requests;
}

export { UsageScreen };
