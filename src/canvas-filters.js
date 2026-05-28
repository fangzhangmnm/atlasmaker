// canvas-filters.js — 像素级调色（Levels / Curves / Color Balance）。
//
// 跟 filters.js（CSS filter for brightness/contrast/saturation/hue）不同：
// 这些 op 需要逐像素跑，CSS filter 没办法。所以走 canvas + putImageData。
//
// 实现模式：
//   - 纯函数 applyXxx(imageData, params) 原地改 imageData.data，可单测
//   - bakeImageWithCanvasFilter(blob, applyFn) 顶层 helper：解码 → 跑 fn → 输出新 PNG blob
//   - 都是**破坏性**（Apply 完直接替换 obj.blob）。Live preview 在 modal 里的小预览 canvas 跑，
//     用户 OK 后整张图 bake。Undo 走 scene.act snapshot 保留旧 blob 引用 → Ctrl+Z 回去。
//
// 未来 V2：每个 filter 加 per-channel（R/G/B）+ 实际 board live preview（需要重做渲染管线
// 用 canvas 替换 img，或 WebGL shader）。MVP 先 master channel + modal preview。

// ===== Levels =====
// 单 channel LUT 生成 helper
function _buildLevelsLut({ inBlack = 0, inWhite = 255, gamma = 1, outBlack = 0, outWhite = 255 } = {}) {
  const lut = new Uint8ClampedArray(256);
  const inRange = Math.max(1, inWhite - inBlack);
  const outRange = outWhite - outBlack;
  const invGamma = 1 / Math.max(0.01, gamma);
  for (let i = 0; i < 256; i++) {
    let v = (i - inBlack) / inRange;
    if (v < 0) v = 0; else if (v > 1) v = 1;
    v = Math.pow(v, invGamma);
    lut[i] = Math.max(0, Math.min(255, Math.round(outBlack + v * outRange)));
  }
  return lut;
}
const _idLut = (() => { const a = new Uint8ClampedArray(256); for (let i = 0; i < 256; i++) a[i] = i; return a; })();

// 0.10.7 旧签名（向后兼容）：master only
export function applyLevels(imageData, params) {
  // 检测 V1 (扁平) 还是 V2 (per-channel)
  const isV2 = params && (params.master || params.r || params.g || params.b);
  const m = isV2 ? params.master : params;
  const masterLut = m ? _buildLevelsLut(m) : _idLut;
  const rLut = isV2 && params.r ? _buildLevelsLut(params.r) : _idLut;
  const gLut = isV2 && params.g ? _buildLevelsLut(params.g) : _idLut;
  const bLut = isV2 && params.b ? _buildLevelsLut(params.b) : _idLut;
  const d = imageData.data;
  for (let i = 0; i < d.length; i += 4) {
    // 先 master，再 per-channel
    d[i]     = rLut[masterLut[d[i]]];
    d[i + 1] = gLut[masterLut[d[i + 1]]];
    d[i + 2] = bLut[masterLut[d[i + 2]]];
  }
  return imageData;
}

// ===== Curves =====
//   master curve：5 个控制点 + 端点 (0,0) (255,255)，线性插值生成 256-entry LUT。
//   控制点的 X 固定（32 / 64 / 128 / 192 / 224），Y 是用户调的输出值 (0..255)。
//   MVP 只 master；V2 加 R/G/B per-channel。
const CURVE_X = [0, 32, 64, 128, 192, 224, 255];

export function buildCurveLut(yValues) {
  // yValues = [y_at_32, y_at_64, y_at_128, y_at_192, y_at_224]（5 个）
  const ys = [0, ...yValues, 255];
  const lut = new Uint8ClampedArray(256);
  for (let i = 0; i < 256; i++) {
    // 找包含 i 的两点
    let seg = 0;
    while (seg < CURVE_X.length - 1 && i > CURVE_X[seg + 1]) seg++;
    const x0 = CURVE_X[seg], x1 = CURVE_X[seg + 1];
    const y0 = ys[seg], y1 = ys[seg + 1];
    const t = x1 === x0 ? 0 : (i - x0) / (x1 - x0);
    lut[i] = Math.max(0, Math.min(255, Math.round(y0 + t * (y1 - y0))));
  }
  return lut;
}

// 0.10.7 旧签名：yValues = 数组（master）。V2：yValues = { master: [...], r: [...], g: [...], b: [...] }
export function applyCurves(imageData, yValues) {
  const isV2 = yValues && !Array.isArray(yValues);
  const m = isV2 ? yValues.master : yValues;
  const masterLut = m ? buildCurveLut(m) : _idLut;
  const rLut = isV2 && yValues.r ? buildCurveLut(yValues.r) : _idLut;
  const gLut = isV2 && yValues.g ? buildCurveLut(yValues.g) : _idLut;
  const bLut = isV2 && yValues.b ? buildCurveLut(yValues.b) : _idLut;
  const d = imageData.data;
  for (let i = 0; i < d.length; i += 4) {
    d[i]     = rLut[masterLut[d[i]]];
    d[i + 1] = gLut[masterLut[d[i + 1]]];
    d[i + 2] = bLut[masterLut[d[i + 2]]];
  }
  return imageData;
}

// ===== Color Balance（V2：shadows + midtones + highlights） =====
// V1（旧签名）：{ cr, mg, yb } → 当 midtones 用
// V2：{ shadows: {cr,mg,yb}, midtones: {cr,mg,yb}, highlights: {cr,mg,yb} }
export function applyColorBalance(imageData, params) {
  const isV2 = params && (params.shadows || params.midtones || params.highlights);
  const sh = isV2 ? (params.shadows || { cr:0, mg:0, yb:0 }) : { cr:0, mg:0, yb:0 };
  const md = isV2 ? (params.midtones || { cr:0, mg:0, yb:0 }) : (params || { cr:0, mg:0, yb:0 });
  const hi = isV2 ? (params.highlights || { cr:0, mg:0, yb:0 }) : { cr:0, mg:0, yb:0 };
  // 3 个权重 LUT：shadows 峰在 0、midtones 峰在 128、highlights 峰在 255。
  const wS = new Float32Array(256);
  const wM = new Float32Array(256);
  const wH = new Float32Array(256);
  for (let i = 0; i < 256; i++) {
    wS[i] = Math.exp(-Math.pow(i / 64, 2));
    wM[i] = Math.exp(-Math.pow((i - 128) / 64, 2));
    wH[i] = Math.exp(-Math.pow((i - 255) / 64, 2));
  }
  const d = imageData.data;
  const k = 0.6;
  for (let i = 0; i < d.length; i += 4) {
    const r = d[i], g = d[i + 1], b = d[i + 2];
    const lum = (r * 0.299 + g * 0.587 + b * 0.114) | 0;
    const s = wS[lum], m = wM[lum], h = wH[lum];
    const dr = (sh.cr * s + md.cr * m + hi.cr * h) * k;
    const dg = (sh.mg * s + md.mg * m + hi.mg * h) * k;
    const db = (sh.yb * s + md.yb * m + hi.yb * h) * k;
    d[i]     = Math.max(0, Math.min(255, r + dr));
    d[i + 1] = Math.max(0, Math.min(255, g + dg));
    d[i + 2] = Math.max(0, Math.min(255, b + db));
  }
  return imageData;
}

/**
 * 通用 bake：source blob → 全分辨率 canvas → 跑 applyFn → 新 PNG blob。
 * applyFn 签名 (imageData) => imageData（原地改也行）。
 */
export async function bakeImageWithCanvasFilter(blob, applyFn) {
  const bitmap = await createImageBitmap(blob);
  try {
    const canvas = document.createElement("canvas");
    canvas.width = bitmap.width;
    canvas.height = bitmap.height;
    const ctx = canvas.getContext("2d");
    ctx.drawImage(bitmap, 0, 0);
    const imageData = ctx.getImageData(0, 0, canvas.width, canvas.height);
    applyFn(imageData);
    ctx.putImageData(imageData, 0, 0);
    return await new Promise((res, rej) =>
      canvas.toBlob((b) => (b ? res(b) : rej(new Error("toBlob returned null"))), "image/png"),
    );
  } finally {
    bitmap.close();
  }
}

/**
 * 解码 + 缩到 preview 尺寸（≤ maxSide），返回 ImageData。
 * crop = { x, y, w, h }（natural px）时只取那块；否则整图。
 * 加 crop 支持是为了让 modal preview 跟 board 上 cropped 显示一致（0.11.1 bug fix）。
 */
export async function buildPreviewSource(blob, maxSide = 240, crop = null) {
  const bitmap = await createImageBitmap(blob);
  try {
    const cx = crop ? crop.x : 0;
    const cy = crop ? crop.y : 0;
    const cw = crop ? crop.w : bitmap.width;
    const ch = crop ? crop.h : bitmap.height;
    const ratio = Math.min(maxSide / cw, maxSide / ch, 1);
    const pw = Math.max(1, Math.round(cw * ratio));
    const ph = Math.max(1, Math.round(ch * ratio));
    const canvas = document.createElement("canvas");
    canvas.width = pw;
    canvas.height = ph;
    const ctx = canvas.getContext("2d");
    ctx.drawImage(bitmap, cx, cy, cw, ch, 0, 0, pw, ph);
    const imageData = ctx.getImageData(0, 0, pw, ph);
    return { imageData, w: pw, h: ph };
  } finally {
    bitmap.close();
  }
}
