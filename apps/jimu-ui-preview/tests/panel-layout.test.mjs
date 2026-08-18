import assert from "node:assert/strict";
import test from "node:test";
import {
  PANEL_LAYOUT,
  clampPanelSize,
  panelSizeFromPointer,
  readPanelSize,
  writePanelSize,
} from "../src/panel-layout.js";

function createStorage(initial = {}) {
  const values = new Map(Object.entries(initial));
  return {
    getItem(key) {
      return values.has(key) ? values.get(key) : null;
    },
    setItem(key, value) {
      values.set(key, value);
    },
    value(key) {
      return values.get(key);
    },
  };
}

test("panel sizes are rounded and clamped to their usable range", () => {
  assert.equal(clampPanelSize(340.6, 260, 520), 341);
  assert.equal(clampPanelSize(120, 260, 520), 260);
  assert.equal(clampPanelSize(900, 260, 520), 520);
  assert.equal(clampPanelSize(320, 360, 300), 360);
});

test("stored panel sizes use defaults for missing or invalid data", () => {
  const definition = PANEL_LAYOUT.projectBrowser;
  assert.equal(readPanelSize(createStorage(), definition), definition.defaultSize);
  assert.equal(readPanelSize(createStorage({ [definition.key]: "not-a-number" }), definition), definition.defaultSize);
  assert.equal(readPanelSize(createStorage({ [definition.key]: "999" }), definition), definition.max);
});

test("panel writes persist only a clamped numeric width", () => {
  const storage = createStorage();
  const definition = PANEL_LAYOUT.contextSidebar;
  assert.equal(writePanelSize(storage, definition, 720), definition.max);
  assert.equal(storage.value(definition.key), String(definition.max));
});

test("pointer movement respects the visual edge direction", () => {
  assert.equal(panelSizeFromPointer({
    startSize: 334,
    startPosition: 500,
    currentPosition: 548,
    direction: 1,
    minimum: 260,
    maximum: 560,
  }), 382);
  assert.equal(panelSizeFromPointer({
    startSize: 344,
    startPosition: 1100,
    currentPosition: 1052,
    direction: -1,
    minimum: 280,
    maximum: 640,
  }), 392);
});
