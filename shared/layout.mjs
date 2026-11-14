export const layoutTargets = {
  card: "歌曲卡片",
  cover: "封面",
  title: "歌名",
  artist: "歌手",
  lyrics: "歌词组",
  original: "原文",
  roman: "音译",
  translation: "翻译",
};

export const layoutFields = {
  scale: { min: 25, max: 300, initial: 100 },
  x: { min: -100, max: 100, initial: 0 },
  y: { min: -100, max: 100, initial: 0 },
};

const record = (value) => value !== null && typeof value === "object" && !Array.isArray(value);

export function normalizeLayout(value) {
  if (!record(value) || Object.keys(value).some((target) => !Object.hasOwn(layoutTargets, target))) return null;
  const result = {};
  for (const target of Object.keys(layoutTargets)) {
    const entry = Object.hasOwn(value, target) ? value[target] : {};
    if (!record(entry) || Object.keys(entry).some((field) => !Object.hasOwn(layoutFields, field))) return null;
    result[target] = {};
    for (const [field, { min, max, initial }] of Object.entries(layoutFields)) {
      const number = Object.hasOwn(entry, field) ? entry[field] : initial;
      if (!Number.isInteger(number) || number < min || number > max) return null;
      result[target][field] = number;
    }
  }
  return result;
}

export function applyLayout(element, layout) {
  for (const target of Object.keys(layoutTargets)) {
    for (const field of Object.keys(layoutFields)) {
      const property = `--${target}-${field}`;
      if (!layout) {
        element.style.removeProperty(property);
        continue;
      }
      const value = layout[target][field];
      const css = field === "scale" ? String(value / 100) : `${value}${field === "x" ? "vw" : "vh"}`;
      element.style.setProperty(property, css);
    }
  }
}
