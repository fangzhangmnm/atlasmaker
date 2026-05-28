// perspective.js — 4-point 透视修正（perspective fix）。
//
// 用户在图上标 4 个角（应该是一个真实矩形的 4 个角，比如砖墙照片倾斜拍的）。
// 算 homography 把那个 quad 映射到正交矩形，逐像素 inverse-warp 写到新 blob。
// 破坏式：bake 完替换 obj.blob，走 scene.act 让 Ctrl+Z 回原。
//
// 简化前提（MVP）：
//   - obj 必须 rotation=0、无 flip、无 crop
//     （有的话先 rasterize 烤掉再 perspective；省一堆坐标变换 + edge case）
//   - 只 master channel
//   - 双线性采样 + 边界 = 透明（不在 source 范围的目标像素 alpha=0）

// ===== 8x9 Gauss-Jordan，解 8x8 线性系统 =====
function solve8(A) {
  // A 是 8×9（8 个未知数 + 1 列 RHS），原地化简。
  const n = 8;
  for (let i = 0; i < n; i++) {
    // partial pivot
    let maxRow = i, maxAbs = Math.abs(A[i][i]);
    for (let k = i + 1; k < n; k++) {
      const v = Math.abs(A[k][i]);
      if (v > maxAbs) { maxAbs = v; maxRow = k; }
    }
    if (maxAbs < 1e-12) return null; // 奇异：4 点共线或重合
    if (maxRow !== i) { const t = A[i]; A[i] = A[maxRow]; A[maxRow] = t; }
    const piv = A[i][i];
    for (let j = i; j <= n; j++) A[i][j] /= piv;
    for (let k = 0; k < n; k++) {
      if (k === i) continue;
      const f = A[k][i];
      if (f === 0) continue;
      for (let j = i; j <= n; j++) A[k][j] -= f * A[i][j];
    }
  }
  return A.map((row) => row[n]);
}

/**
 * 计算 dst → src 的 homography 矩阵（用于 inverse warp：每个 dst 像素回查 src 位置）。
 * @param {Array<{x,y}>} srcQuad - 4 源点（按 NW, NE, SE, SW 顺序）
 * @param {Array<{x,y}>} dstQuad - 4 目标点（同顺序）
 * @returns {number[]|null} [a,b,c,d,e,f,g,h]（i=1 implicit），或 null（奇异）
 */
export function computeHomographyDstToSrc(srcQuad, dstQuad) {
  // 解 dst → src 的 H：对每对点 (Dx, Dy) → (Sx, Sy) 有
  //   Sx = (a*Dx + b*Dy + c) / (g*Dx + h*Dy + 1)
  //   Sy = (d*Dx + e*Dy + f) / (g*Dx + h*Dy + 1)
  // 整理成 8 个线性方程，8 个未知数。
  const A = [];
  for (let i = 0; i < 4; i++) {
    const dx = dstQuad[i].x, dy = dstQuad[i].y;
    const sx = srcQuad[i].x, sy = srcQuad[i].y;
    A.push([dx, dy, 1, 0, 0, 0, -dx * sx, -dy * sx, sx]);
    A.push([0, 0, 0, dx, dy, 1, -dx * sy, -dy * sy, sy]);
  }
  return solve8(A);
}

/**
 * Inverse warp：把 src ImageData warp 进 dst ImageData，用 dst→src 的 homography。
 * 双线性采样；source 外的 dst 像素 alpha = 0。
 */
export function warpImageData(srcImageData, dstImageData, h) {
  const [a, b, c, d, e, f, g_, h_] = h;
  const sw = srcImageData.width, sh = srcImageData.height;
  const dw = dstImageData.width, dh = dstImageData.height;
  const sd = srcImageData.data, dd = dstImageData.data;
  for (let y = 0; y < dh; y++) {
    for (let x = 0; x < dw; x++) {
      const denom = g_ * x + h_ * y + 1;
      const sx = (a * x + b * y + c) / denom;
      const sy = (d * x + e * y + f) / denom;
      const di = (y * dw + x) * 4;
      if (sx < 0 || sx >= sw - 1 || sy < 0 || sy >= sh - 1) {
        dd[di] = 0; dd[di + 1] = 0; dd[di + 2] = 0; dd[di + 3] = 0;
        continue;
      }
      const ix = Math.floor(sx), iy = Math.floor(sy);
      const fx = sx - ix, fy = sy - iy;
      const i00 = (iy * sw + ix) * 4;
      const i01 = i00 + 4;
      const i10 = ((iy + 1) * sw + ix) * 4;
      const i11 = i10 + 4;
      const w00 = (1 - fx) * (1 - fy);
      const w01 = fx * (1 - fy);
      const w10 = (1 - fx) * fy;
      const w11 = fx * fy;
      dd[di]     = (w00 * sd[i00]     + w01 * sd[i01]     + w10 * sd[i10]     + w11 * sd[i11])     | 0;
      dd[di + 1] = (w00 * sd[i00 + 1] + w01 * sd[i01 + 1] + w10 * sd[i10 + 1] + w11 * sd[i11 + 1]) | 0;
      dd[di + 2] = (w00 * sd[i00 + 2] + w01 * sd[i01 + 2] + w10 * sd[i10 + 2] + w11 * sd[i11 + 2]) | 0;
      dd[di + 3] = (w00 * sd[i00 + 3] + w01 * sd[i01 + 3] + w10 * sd[i10 + 3] + w11 * sd[i11 + 3]) | 0;
    }
  }
  return dstImageData;
}

/**
 * 高层 bake：source blob + 4 个源 quad 点（natural px） → 输出 outW × outH 的 PNG blob。
 * 目标矩形固定为 (0,0)(W,0)(W,H)(0,H)。
 */
export async function bakePerspective(blob, srcQuad, outW, outH) {
  if (outW < 1 || outH < 1) throw new Error("Invalid output dimensions");
  const dstQuad = [
    { x: 0,    y: 0    },
    { x: outW, y: 0    },
    { x: outW, y: outH },
    { x: 0,    y: outH },
  ];
  const H = computeHomographyDstToSrc(srcQuad, dstQuad);
  if (!H) throw new Error("Degenerate quad (collinear / overlapping points)");
  const bitmap = await createImageBitmap(blob);
  try {
    // decode source 到 canvas，拿 ImageData
    const srcCanvas = document.createElement("canvas");
    srcCanvas.width = bitmap.width;
    srcCanvas.height = bitmap.height;
    const srcCtx = srcCanvas.getContext("2d");
    srcCtx.drawImage(bitmap, 0, 0);
    const srcImageData = srcCtx.getImageData(0, 0, bitmap.width, bitmap.height);
    // dst canvas
    const dstCanvas = document.createElement("canvas");
    dstCanvas.width = outW;
    dstCanvas.height = outH;
    const dstCtx = dstCanvas.getContext("2d");
    const dstImageData = dstCtx.createImageData(outW, outH);
    warpImageData(srcImageData, dstImageData, H);
    dstCtx.putImageData(dstImageData, 0, 0);
    return await new Promise((res, rej) =>
      dstCanvas.toBlob((b) => (b ? res(b) : rej(new Error("toBlob returned null"))), "image/png"),
    );
  } finally {
    bitmap.close();
  }
}

/**
 * 估算 quad 的输出尺寸（取两组对边的平均长度）。
 * 让默认输出尺寸贴合 quad 的「应该是的矩形」。
 */
export function estimateOutputSize(srcQuad) {
  const dist = (a, b) => Math.hypot(b.x - a.x, b.y - a.y);
  const topW = dist(srcQuad[0], srcQuad[1]);
  const botW = dist(srcQuad[3], srcQuad[2]);
  const leftH = dist(srcQuad[0], srcQuad[3]);
  const rightH = dist(srcQuad[1], srcQuad[2]);
  return {
    w: Math.max(1, Math.round((topW + botW) / 2)),
    h: Math.max(1, Math.round((leftH + rightH) / 2)),
  };
}
