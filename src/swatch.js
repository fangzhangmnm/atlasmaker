// swatch.js — 颜色取色 + 纯色矩形（swatch）相关的纯函数。
//
// **纯色矩形 = 一张 64×64 的 PNG**，跟普通 image obj 完全一样。
// 选 64×64 的理由：
//   - PNG 编码后约 80 字节（PNG 压缩对单色巨好）
//   - 在画板默认 1 世界 px = 1 自然 px 显示约 1cm 色块（chip 大小），符合 swatch 视觉
//   - 不会跟参考图 thumb 混淆（参考图通常 1024+）
//   - 想做更大的可以 Rasterize 一下，或者直接拖 handle 放大（同色 nearest / adaptive 都 OK）
//   - 想裁切局部也能（64×64 切 32×32 仍然有意义）

const SWATCH_SIZE = 64;

/**
 * 生成纯色 swatch 的 PNG Blob。
 * @param {{r:number,g:number,b:number,a?:number}} c — 0-255 RGBA
 * @param {number} [size=64] — 边长（px）
 * @returns {Promise<Blob>}
 */
export async function makeSwatchBlob(c, size = SWATCH_SIZE) {
  const canvas = document.createElement("canvas");
  canvas.width = size;
  canvas.height = size;
  const ctx = canvas.getContext("2d");
  const a = (c.a == null ? 255 : c.a) / 255;
  ctx.fillStyle = `rgba(${c.r}, ${c.g}, ${c.b}, ${a})`;
  ctx.fillRect(0, 0, size, size);
  return await new Promise((res, rej) =>
    canvas.toBlob((b) => (b ? res(b) : rej(new Error("toBlob returned null"))), "image/png"),
  );
}

/**
 * 从 image blob 在 (naturalX, naturalY) 处采 1 像素颜色。
 * @returns {Promise<{r:number,g:number,b:number,a:number}>}
 */
export async function samplePixel(blob, naturalX, naturalY) {
  const bitmap = await createImageBitmap(blob);
  try {
    const canvas = document.createElement("canvas");
    canvas.width = 1;
    canvas.height = 1;
    const ctx = canvas.getContext("2d");
    // 在 source 上从 (x,y) 取 1×1，画到 (0,0) 1×1
    const sx = Math.max(0, Math.min(bitmap.width - 1, Math.floor(naturalX)));
    const sy = Math.max(0, Math.min(bitmap.height - 1, Math.floor(naturalY)));
    ctx.drawImage(bitmap, sx, sy, 1, 1, 0, 0, 1, 1);
    const d = ctx.getImageData(0, 0, 1, 1).data;
    return { r: d[0], g: d[1], b: d[2], a: d[3] };
  } finally {
    bitmap.close();
  }
}

/**
 * 把世界坐标 (wx, wy) 折算到 image obj 的 natural pixel 坐标。
 * 考虑 obj.rotation + obj.crop + obj.flipH/V。
 */
export function worldToNaturalPx(obj, wx, wy) {
  const cx = obj.x + obj.w / 2;
  const cy = obj.y + obj.h / 2;
  let dx = wx - cx;
  let dy = wy - cy;
  // 反旋转回 image-local（CSS transform: rotate(R) scale(s) right-to-left → 先去 rotate）
  if (obj.rotation) {
    const rad = -obj.rotation * Math.PI / 180;
    const cs = Math.cos(rad), sn = Math.sin(rad);
    const dxr = dx * cs - dy * sn;
    const dyr = dx * sn + dy * cs;
    dx = dxr; dy = dyr;
  }
  // image-local top-left 起点
  let localX = dx + obj.w / 2;
  let localY = dy + obj.h / 2;
  // 反 flip（image-local 镜像 → 抵消）
  if (obj.flipH) localX = obj.w - localX;
  if (obj.flipV) localY = obj.h - localY;
  // 当前显示的"可见区域" = obj.crop || 全图
  const crop = obj.crop || { x: 0, y: 0, w: obj.naturalW, h: obj.naturalH };
  const wpnX = obj.w / crop.w; // world per natural
  const wpnY = obj.h / crop.h;
  const naturalX = crop.x + localX / wpnX;
  const naturalY = crop.y + localY / wpnY;
  return { x: naturalX, y: naturalY };
}

/** 6 位十六进制（用于 toast / log） */
export function colorToHex(c) {
  const h = (n) => Math.max(0, Math.min(255, Math.round(n))).toString(16).padStart(2, "0");
  return `#${h(c.r)}${h(c.g)}${h(c.b)}`;
}

/** "#RRGGBB" → { r, g, b, a:255 } */
export function hexToColor(hex) {
  const m = /^#?([0-9a-f]{6})$/i.exec(hex);
  if (!m) return { r: 128, g: 128, b: 128, a: 255 };
  const n = parseInt(m[1], 16);
  return { r: (n >> 16) & 0xff, g: (n >> 8) & 0xff, b: n & 0xff, a: 255 };
}
