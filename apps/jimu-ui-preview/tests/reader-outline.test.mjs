import assert from "node:assert/strict";
import test from "node:test";

import { numberReaderOutline } from "../src/reader-outline.js";

test("numbers H2 sections and H3 children with matching hierarchy", () => {
  const outline = numberReaderOutline([
    { id: "summary", title: "一句话结论", level: 2 },
    { id: "assets", title: "素材状态", level: 2 },
    { id: "current", title: "当前使用", level: 3 },
    { id: "retained", title: "已废弃但保留", level: 3 },
    { id: "method", title: "可复用方法", level: 2 },
  ]);

  assert.deepEqual(outline.map(({ displayIndex, depth }) => ({ displayIndex, depth })), [
    { displayIndex: "01", depth: 0 },
    { displayIndex: "02", depth: 0 },
    { displayIndex: "02.01", depth: 1 },
    { displayIndex: "02.02", depth: 1 },
    { displayIndex: "03", depth: 0 },
  ]);
});
