// chromakey.js — 背景色 / 关键色 去除（chroma key）。
//
// 输入图 + 一个关键色 → 把和关键色「足够接近」的像素 alpha 设为 0（或渐变 alpha 做 soft edge）。
// 一次性 bake，输出新 PNG blob（带 alpha）。
//
// 距离：Euclidean RGB distance √(Δr² + Δg² + Δb²)，上限 = √(255²·3) ≈ 441.67。
// tolerance 0..100 = 把这个上限的百分比当阈值。10% 大约 = 44 距离单位，软覆盖深背景一般够；
// 复杂背景（光照变化）需要 30-50%。
//
// soft：feather 软边宽度，单位同 tolerance（百分比）。
// 距离 < tolerance → 全透。
// 距离 ∈ [tolerance, tolerance+soft] → alpha 线性渐变 0→1。
// 距离 > tolerance+soft → 保留原 alpha。
//
// 不做更复杂的 (despill / 边缘除色)；那些是绿幕合成范畴。AtlasMaker 主要场景 = 去白底 / 去单色背景。

const MAX_DIST = Math.sqrt(255 * 255 * 3);

/** 内部纯函数：处理 ImageData (in place)。可单测。 */
export function applyChromaToImageData(imageData, keyColor, tolerance, soft = 0) {
  const d = imageData.data;
  const tolAbs = (tolerance / 100) * MAX_DIST;
  const softAbs = (soft / 100) * MAX_DIST;
  const kr = keyColor.r | 0, kg = keyColor.g | 0, kb = keyColor.b | 0;
  for (let i = 0; i < d.length; i += 4) {
    const dr = d[i] - kr;
    const dg = d[i + 1] - kg;
    const db = d[i + 2] - kb;
    const dist = Math.sqrt(dr * dr + dg * dg + db * db);
    if (dist <= tolAbs) {
      d[i + 3] = 0;
    } else if (softAbs > 0 && dist < tolAbs + softAbs) {
      const t = (dist - tolAbs) / softAbs;
      d[i + 3] = Math.round(d[i + 3] * t);
    }
    // 距离更远：保留原 alpha
  }
  return imageData;
}

/**
 * 对 image blob 应用 chroma key，返回新 PNG blob（带 alpha）。
 * @param {Blob} blob
 * @param {{r,g,b}} keyColor — 0..255
 * @param {number} tolerance — 0..100
 * @param {number} soft — 0..100，默认 0（硬边）
 * @returns {Promise<Blob>}
 */
export async function applyChromaKey(blob, keyColor, tolerance, soft = 0) {
  const bitmap = await createImageBitmap(blob);
  try {
    const canvas = document.createElement("canvas");
    canvas.width = bitmap.width;
    canvas.height = bitmap.height;
    const ctx = canvas.getContext("2d");
    ctx.drawImage(bitmap, 0, 0);
    const imageData = ctx.getImageData(0, 0, canvas.width, canvas.height);
    applyChromaToImageData(imageData, keyColor, tolerance, soft);
    ctx.putImageData(imageData, 0, 0);
    return await new Promise((res, rej) =>
      canvas.toBlob((b) => (b ? res(b) : rej(new Error("toBlob returned null"))), "image/png"),
    );
  } finally {
    bitmap.close();
  }
}

/** 取 image 第 (0,0) 像素颜色，给 chroma dialog 默认值用（大多背景在左上角） */
export async function sampleTopLeftPixel(blob) {
  const bitmap = await createImageBitmap(blob);
  try {
    const canvas = document.createElement("canvas");
    canvas.width = 1;
    canvas.height = 1;
    const ctx = canvas.getContext("2d");
    ctx.drawImage(bitmap, 0, 0, 1, 1, 0, 0, 1, 1);
    const d = ctx.getImageData(0, 0, 1, 1).data;
    return { r: d[0], g: d[1], b: d[2] };
  } finally {
    bitmap.close();
  }
}
