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
//   input range [inBlack..inWhite] 拉伸到 [outBlack..outWhite]，中间走 gamma 曲线。
//   - inBlack < inWhite, 0..255
//   - gamma > 0；< 1 = 暗调下沉；> 1 = 暗调拉亮
//   - outBlack < outWhite, 0..255
// 等价 Photoshop Image > Adjustments > Levels（不分 channel 的 MVP）。
export function applyLevels(imageData, { inBlack = 0, inWhite = 255, gamma = 1, outBlack = 0, outWhite = 255 }) {
  // 预先 LUT 化，每像素就 3 次查表
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
  const d = imageData.data;
  for (let i = 0; i < d.length; i += 4) {
    d[i]     = lut[d[i]];
    d[i + 1] = lut[d[i + 1]];
    d[i + 2] = lut[d[i + 2]];
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

export function applyCurves(imageData, yValues) {
  const lut = buildCurveLut(yValues);
  const d = imageData.data;
  for (let i = 0; i < d.length; i += 4) {
    d[i]     = lut[d[i]];
    d[i + 1] = lut[d[i + 1]];
    d[i + 2] = lut[d[i + 2]];
  }
  return imageData;
}

// ===== Color Balance（midtones MVP）=====
//   3 个滑块 cr / mg / yb（-100..+100）。midtone 加权：高斯峰在 128，端点 0。
//   等价 Photoshop Color Balance 的 Midtones tonal range（不分 Shadows/Highlights 的 MVP）。
export function applyColorBalance(imageData, { cr = 0, mg = 0, yb = 0 }) {
  // strength 0..1 per pixel based on midtone-ness (peak at 128)
  // weight 用 Gaussian-ish：exp(-((v-128)/64)^2)
  const weight = new Float32Array(256);
  for (let i = 0; i < 256; i++) {
    const t = (i - 128) / 64;
    weight[i] = Math.exp(-t * t);
  }
  const d = imageData.data;
  const k = 0.6; // 强度系数（滑块 100 → 60 单位）
  for (let i = 0; i < d.length; i += 4) {
    const r = d[i], g = d[i + 1], b = d[i + 2];
    // 用 luminance 的权重，比单 channel 稳
    const lum = (r * 0.299 + g * 0.587 + b * 0.114) | 0;
    const w = weight[lum];
    d[i]     = Math.max(0, Math.min(255, r + cr * w * k));
    d[i + 1] = Math.max(0, Math.min(255, g + mg * w * k));
    d[i + 2] = Math.max(0, Math.min(255, b + yb * w * k));
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

/** 解码 + 缩到 preview 尺寸（≤ maxSide），返回 ImageData + ctx ready to draw。 */
export async function buildPreviewSource(blob, maxSide = 240) {
  const bitmap = await createImageBitmap(blob);
  try {
    const ratio = Math.min(maxSide / bitmap.width, maxSide / bitmap.height, 1);
    const pw = Math.max(1, Math.round(bitmap.width * ratio));
    const ph = Math.max(1, Math.round(bitmap.height * ratio));
    const canvas = document.createElement("canvas");
    canvas.width = pw;
    canvas.height = ph;
    const ctx = canvas.getContext("2d");
    ctx.drawImage(bitmap, 0, 0, pw, ph);
    const imageData = ctx.getImageData(0, 0, pw, ph);
    return { imageData, w: pw, h: ph };
  } finally {
    bitmap.close();
  }
}
