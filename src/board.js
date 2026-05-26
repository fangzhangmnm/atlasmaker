// Board = 视口（pan/zoom）。
// 屏幕坐标 ↔ 世界坐标：world = (screen - t) / scale, screen = world * scale + t.
// pan/zoom 通过给 #world 设 transform 实现，对象本身用世界 px 写 left/top/width/height。

const MIN_SCALE = 0.05;
const MAX_SCALE = 16;
const GRID_WORLD = 32; // 一格 32 世界 px

export class Board {
  constructor(boardEl, worldEl) {
    this.boardEl = boardEl;
    this.worldEl = worldEl;
    this.viewport = { tx: 0, ty: 0, scale: 1 };
    this._listeners = new Set();
    window.addEventListener("resize", () => this._applyTransform());
  }

  onChange(fn) {
    this._listeners.add(fn);
    return () => this._listeners.delete(fn);
  }

  _emit() {
    for (const fn of this._listeners) fn(this.viewport);
  }

  screenToWorld(sx, sy) {
    const r = this.boardEl.getBoundingClientRect();
    const x = sx - r.left;
    const y = sy - r.top;
    const { tx, ty, scale } = this.viewport;
    return { x: (x - tx) / scale, y: (y - ty) / scale };
  }

  worldToScreen(wx, wy) {
    const { tx, ty, scale } = this.viewport;
    const r = this.boardEl.getBoundingClientRect();
    return { x: wx * scale + tx + r.left, y: wy * scale + ty + r.top };
  }

  pan(dx, dy) {
    this.viewport.tx += dx;
    this.viewport.ty += dy;
    this._applyTransform();
  }

  // anchor 用 board 内坐标（已减去 boardEl.left/top）
  zoomAt(anchorX, anchorY, factor) {
    const old = this.viewport.scale;
    const ns = Math.max(MIN_SCALE, Math.min(MAX_SCALE, old * factor));
    if (ns === old) return;
    const k = ns / old;
    this.viewport.tx = anchorX - (anchorX - this.viewport.tx) * k;
    this.viewport.ty = anchorY - (anchorY - this.viewport.ty) * k;
    this.viewport.scale = ns;
    this._applyTransform();
  }

  setViewport(tx, ty, scale) {
    this.viewport.tx = tx;
    this.viewport.ty = ty;
    this.viewport.scale = Math.max(MIN_SCALE, Math.min(MAX_SCALE, scale));
    this._applyTransform();
  }

  // 让所有给定的 bbox（世界单位 [x0,y0,x1,y1]）适应屏幕；空数组就回到原点
  fitTo(bboxes, padding = 64) {
    const r = this.boardEl.getBoundingClientRect();
    if (!bboxes.length) {
      this.setViewport(r.width / 2, r.height / 2, 1);
      return;
    }
    let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
    for (const b of bboxes) {
      if (b[0] < x0) x0 = b[0];
      if (b[1] < y0) y0 = b[1];
      if (b[2] > x1) x1 = b[2];
      if (b[3] > y1) y1 = b[3];
    }
    const w = x1 - x0, h = y1 - y0;
    if (w <= 0 || h <= 0) return;
    const sx = (r.width - padding * 2) / w;
    const sy = (r.height - padding * 2) / h;
    const s = Math.max(MIN_SCALE, Math.min(MAX_SCALE, Math.min(sx, sy)));
    const cx = (x0 + x1) / 2, cy = (y0 + y1) / 2;
    this.setViewport(r.width / 2 - cx * s, r.height / 2 - cy * s, s);
  }

  _applyTransform() {
    const { tx, ty, scale } = this.viewport;
    this.worldEl.style.transform = `translate(${tx}px, ${ty}px) scale(${scale})`;
    // 网格背景：基于屏幕 px，跟随 pan，但 size 跟 scale
    const sz = GRID_WORLD * scale;
    this.boardEl.style.setProperty("--bg-size", `${sz}px`);
    this.boardEl.style.setProperty("--bg-x", `${tx}px`);
    this.boardEl.style.setProperty("--bg-y", `${ty}px`);
    this._emit();
  }
}
