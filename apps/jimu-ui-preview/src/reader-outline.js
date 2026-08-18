function twoDigits(value) {
  return String(value).padStart(2, "0");
}

export function numberReaderOutline(sections) {
  if (!Array.isArray(sections) || sections.length === 0) return [];
  const levels = sections.map((section) => Number(section.level)).filter((level) => Number.isFinite(level));
  const baseLevel = Math.min(...levels);
  const counters = [0, 0, 0];

  return sections.map((section) => {
    const depth = Math.max(0, Math.min(2, Number(section.level) - baseLevel));
    for (let index = 0; index < depth; index += 1) {
      if (counters[index] === 0) counters[index] = 1;
    }
    counters[depth] += 1;
    for (let index = depth + 1; index < counters.length; index += 1) counters[index] = 0;
    return {
      ...section,
      depth,
      displayIndex: counters.slice(0, depth + 1).map(twoDigits).join("."),
    };
  });
}
