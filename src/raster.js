// 光栅化（rasterize / bake）模块。
//
// 单一职责：把 image obj 的「非破坏字段」（crop / filters / 等）烤进新 blob。
// 不碰 scene，不碰 UI。纯函数 in：source blob + 烤参数；out：新 blob。
//
// 后续要接：
//   - crop：4-gizmo 模式产生 obj.crop = { x, y, w, h }（natural px 坐标）
//   - filters：调色 filter chain（Brightness / Contrast / Levels / Curves...）
//   - 透视修正：4-point homography（destructive 烤，不存 nondestructive 字段）
//   - 未来 AI 放大：mode === "ai-upscale" 走 worker / WebGPU / 外部服务
//
// resample mode：
//   - "adaptive"：浏览器内建插值（Lanczos-ish for downscale，bilinear for upscale）。
//     适合照片 / 反射图。imageSmoothingQuality="high" 让浏览器尽量好。
//   - "nearest"：禁插值，像素硬复制。适合 pixel art / 已 quantize 的素材。
//     上采样不会模糊，下采样会有锯齿。

/**
 * 把 image blob 按指定参数烤成新 blob。
 *
 * @param {Object} p
 * @param {Blob} p.blob — 源图（PNG/JPEG）
 * @param {number} p.naturalW — 源 natural 宽
 * @param {number} p.naturalH — 源 natural 高
 * @param {?{x:number,y:number,w:number,h:number}} p.crop — 可选裁切（natural px），空 = 整图
 * @param {number} p.targetW — 目标输出宽（px）
 * @param {number} p.targetH — 目标输出高（px）
 * @param {"adaptive"|"nearest"} p.mode — 重采样模式
 * @returns {Promise<Blob>} 输出 PNG blob
 */
export async function rasterizeImage({ blob, naturalW, naturalH, crop, targetW, targetH, mode }) {
  if (!blob) throw new Error("rasterizeImage: no source blob");
  if (!targetW || !targetH || targetW < 1 || targetH < 1) {
    throw new Error(`rasterizeImage: invalid target ${targetW}×${targetH}`);
  }
  const sx = clampInt(crop?.x ?? 0, 0, naturalW);
  const sy = clampInt(crop?.y ?? 0, 0, naturalH);
  const sw = clampInt(crop?.w ?? naturalW, 1, naturalW - sx);
  const sh = clampInt(crop?.h ?? naturalH, 1, naturalH - sy);

  const bitmap = await createImageBitmap(blob);
  try {
    const canvas = document.createElement("canvas");
    canvas.width = Math.round(targetW);
    canvas.height = Math.round(targetH);
    const ctx = canvas.getContext("2d");
    if (mode === "nearest") {
      ctx.imageSmoothingEnabled = false;
    } else {
      ctx.imageSmoothingEnabled = true;
      ctx.imageSmoothingQuality = "high";
    }
    ctx.drawImage(bitmap, sx, sy, sw, sh, 0, 0, canvas.width, canvas.height);
    return await new Promise((res, rej) =>
      canvas.toBlob((b) => (b ? res(b) : rej(new Error("toBlob returned null"))), "image/png"),
    );
  } finally {
    bitmap.close();
  }
}

function clampInt(v, lo, hi) {
  const n = Math.round(Number(v) || 0);
  return Math.max(lo, Math.min(hi, n));
}
