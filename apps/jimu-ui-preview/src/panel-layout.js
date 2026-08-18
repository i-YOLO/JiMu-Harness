export const PANEL_LAYOUT = Object.freeze({
  appSidebar: Object.freeze({
    key: "jimu.panel.appSidebarWidth",
    defaultSize: 341,
    min: 260,
    max: 520,
  }),
  projectBrowser: Object.freeze({
    key: "jimu.panel.projectBrowserWidth",
    defaultSize: 334,
    min: 260,
    max: 560,
  }),
  contextSidebar: Object.freeze({
    key: "jimu.panel.contextSidebarWidth",
    defaultSize: 344,
    min: 280,
    max: 640,
  }),
});

export function clampPanelSize(value, minimum, maximum) {
  const safeMaximum = Math.max(minimum, maximum);
  const numeric = Number(value);
  if (!Number.isFinite(numeric)) return minimum;
  return Math.min(safeMaximum, Math.max(minimum, Math.round(numeric)));
}

export function readPanelSize(storage, definition) {
  try {
    const stored = storage?.getItem(definition.key);
    if (stored === null || stored === undefined || stored === "") return definition.defaultSize;
    if (!Number.isFinite(Number(stored))) return definition.defaultSize;
    return clampPanelSize(stored, definition.min, definition.max);
  } catch {
    return definition.defaultSize;
  }
}

export function writePanelSize(storage, definition, value) {
  const size = clampPanelSize(value, definition.min, definition.max);
  try {
    storage?.setItem(definition.key, String(size));
  } catch {
    // Storage can be unavailable in hardened or transient renderer contexts.
  }
  return size;
}

export function panelSizeFromPointer({
  startSize,
  startPosition,
  currentPosition,
  direction = 1,
  minimum,
  maximum,
}) {
  return clampPanelSize(
    startSize + ((currentPosition - startPosition) * direction),
    minimum,
    maximum,
  );
}
