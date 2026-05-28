// filters.js — 非破坏调色 filter chain。
//
// 数据：obj.filters = { brightness?, contrast?, saturation?, hue?, ... }
//   undefined 或全 0 = identity（不变）
//   值为浮点：brightness/contrast/saturation 用 -100 ~ +100 百分比，hue 用 -180 ~ +180 度
//
// 实时预览：浏览器 CSS filter 原生（GPU 合成，零成本）。覆盖：
//   - brightness / contrast / saturation / hue / grayscale / sepia / invert / blur
//   未来 curves / levels / color balance 需要 canvas pixel op，到时另写。
//
// Bake（Rasterize 时）：canvas2d ctx.filter 接受同一个 CSS filter 字符串 → drawImage 一把烤进新 blob。
//
// 顺序（CSS 标准）：filter list left-to-right，brightness 先 multiply，contrast 拉伸，saturate / hue 再调色。
// 我们的 order = brightness → contrast → saturate → hue，符合 CSS 默认 + 直觉。

const ZERO_THRESHOLD = 0.001;

function _approxZero(v) { return Math.abs(v || 0) < ZERO_THRESHOLD; }

/** 检查 filters 是否实质为空（全 identity）。返回 true = 不需要应用 */
export function isFiltersIdentity(filters) {
  if (!filters) return true;
  const keys = ["brightness", "contrast", "saturation", "hue"];
  return keys.every((k) => _approxZero(filters[k]));
}

/**
 * 把 filters 对象 → CSS filter 字符串。可直接赋给 `img.style.filter` 或 `ctx.filter`。
 * 全 identity 时返回 "" 或 "none"。
 * @param {Object} f - { brightness, contrast, saturation, hue } 各项可缺
 * @returns {string}
 */
export function filtersToCssString(f) {
  if (!f) return "";
  const parts = [];
  if (!_approxZero(f.brightness)) parts.push(`brightness(${1 + f.brightness / 100})`);
  if (!_approxZero(f.contrast))   parts.push(`contrast(${1 + f.contrast / 100})`);
  if (!_approxZero(f.saturation)) parts.push(`saturate(${1 + f.saturation / 100})`);
  if (!_approxZero(f.hue))        parts.push(`hue-rotate(${f.hue}deg)`);
  return parts.join(" ");
}

/** 默认 filters 出厂值（全 0 = identity） */
export function defaultFilters() {
  return { brightness: 0, contrast: 0, saturation: 0, hue: 0 };
}
