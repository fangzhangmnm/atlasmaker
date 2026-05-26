// Scene = 对象集合。每个对象有：id, type, x, y, w, h（世界单位），加上类型特定字段。
// 渲染：DOM 节点。世界 px 直接写 left/top/width/height；外层 #world 的 scale 负责放大缩小。
//
// 两层结构：images layer 在下，viewports layer 在上。viewport 永远在最上面。
// z-order 在各层内部由 DOM 顺序决定，用户手动控制（raiseOne / raiseToTop / lowerOne / lowerToBottom）。
//
// 命中：input.js 用 ev.target 走 DOM，不用 hitTest（保留代码以备多选 marquee 等）。
// viewport 的 .obj 设 pointer-events: none，只有 4 条 .vp-edge 边带接 click → 实现「边框选择」。

let _idSeq = 0;
const nextId = () => `o${++_idSeq}`;

export class Scene {
  constructor(worldEl) {
    this.worldEl = worldEl;
    this.objects = new Map(); // id -> obj
    this.nodes = new Map();   // id -> DOM 节点
    this.selection = new Set();
    this._listeners = new Set();
    // 双层渲染：images 在下，viewports 在上
    this.imagesLayer = document.createElement("div");
    this.imagesLayer.className = "layer images";
    this.viewportsLayer = document.createElement("div");
    this.viewportsLayer.className = "layer viewports";
    worldEl.appendChild(this.imagesLayer);
    worldEl.appendChild(this.viewportsLayer);
  }

  _layerFor(obj) {
    return obj.type === "viewport" ? this.viewportsLayer : this.imagesLayer;
  }

  onChange(fn) {
    this._listeners.add(fn);
    return () => this._listeners.delete(fn);
  }

  _emit() {
    for (const fn of this._listeners) fn(this);
  }

  list() { return Array.from(this.objects.values()); }
  count() { return this.objects.size; }
  get(id) { return this.objects.get(id); }
  getNode(id) { return this.nodes.get(id); }
  // 按 DOM 顺序遍历 —— 底层在前，paint 顺序正好。
  listImages() {
    return Array.from(this.imagesLayer.children)
      .map((el) => this.objects.get(el.dataset.id))
      .filter(Boolean);
  }
  listViewports() {
    return Array.from(this.viewportsLayer.children)
      .map((el) => this.objects.get(el.dataset.id))
      .filter(Boolean);
  }

  add(obj) {
    if (!obj.id) obj.id = nextId();
    this.objects.set(obj.id, obj);
    const node = this._renderNode(obj);
    this.nodes.set(obj.id, node);
    this._layerFor(obj).appendChild(node);
    this._emit();
    return obj;
  }

  remove(id) {
    const node = this.nodes.get(id);
    if (node) node.remove();
    this.nodes.delete(id);
    const obj = this.objects.get(id);
    this.objects.delete(id);
    this.selection.delete(id);
    // 每个 image 对象拥有自己的 _displayUrl —— Blob 在 obj.blob 里（不可变，共享安全）
    if (obj && obj.type === "image" && obj._displayUrl) {
      try { URL.revokeObjectURL(obj._displayUrl); } catch (_) {}
      obj._displayUrl = null;
    }
    this._emit();
  }

  update(id, patch) {
    const obj = this.objects.get(id);
    if (!obj) return;
    Object.assign(obj, patch);
    this._applyTransform(obj);
    this._emit();
  }

  // ----- z-order：在自己所在层内移动。viewport 永远在 images 上 -----
  raiseOne(id) {
    const node = this.nodes.get(id);
    if (!node) return;
    const next = node.nextElementSibling;
    if (next) node.parentElement.insertBefore(next, node);
    this._emit();
  }
  lowerOne(id) {
    const node = this.nodes.get(id);
    if (!node) return;
    const prev = node.previousElementSibling;
    if (prev) node.parentElement.insertBefore(node, prev);
    this._emit();
  }
  raiseToTop(id) {
    const node = this.nodes.get(id);
    if (!node) return;
    node.parentElement.appendChild(node);
    this._emit();
  }
  lowerToBottom(id) {
    const node = this.nodes.get(id);
    if (!node) return;
    const parent = node.parentElement;
    if (parent.firstElementChild !== node) parent.insertBefore(node, parent.firstElementChild);
    this._emit();
  }

  select(id, additive = false) {
    if (!additive) {
      for (const sid of this.selection) {
        const n = this.nodes.get(sid);
        if (n) n.classList.remove("selected");
      }
      this.selection.clear();
    }
    if (id != null) {
      this.selection.add(id);
      const n = this.nodes.get(id);
      if (n) n.classList.add("selected");
    }
    this._emit();
  }

  clearSelection() { this.select(null, false); }

  // 单选当前 id（若已选则保持）
  ensureSelected(id) {
    if (!this.selection.has(id)) this.select(id, false);
  }

  firstSelected() {
    const it = this.selection.values().next();
    return it.done ? null : this.objects.get(it.value);
  }

  // 命中测试：屏幕坐标（board 内）→ 最上层对象。
  // 简单实现：遍历 DOM 反向（最上层在最后）。
  hitTest(worldX, worldY) {
    const arr = Array.from(this.objects.values());
    // DOM 顺序 = 添加顺序；反向找最上层
    for (let i = arr.length - 1; i >= 0; i--) {
      const o = arr[i];
      if (worldX >= o.x && worldX <= o.x + o.w &&
          worldY >= o.y && worldY <= o.y + o.h) {
        return o;
      }
    }
    return null;
  }

  bboxes() {
    return this.list().map((o) => [o.x, o.y, o.x + o.w, o.y + o.h]);
  }

  // 渲染（创建 DOM）
  _renderNode(obj) {
    const el = document.createElement("div");
    el.className = `obj ${obj.type}`;
    el.dataset.id = obj.id;
    if (obj.type === "image") {
      // 懒生成 URL：每个 obj 拥有自己的 URL。Blob 不可变可以多 obj 共享（duplicate）。
      if (!obj._displayUrl && obj.blob) {
        obj._displayUrl = URL.createObjectURL(obj.blob);
      }
      const img = document.createElement("img");
      img.src = obj._displayUrl || "";
      img.draggable = false;
      el.appendChild(img);
    } else if (obj.type === "viewport") {
      // 4 条边带：pointer-events: auto，「边框选择」实现
      for (const side of ["top", "right", "bottom", "left"]) {
        const edge = document.createElement("div");
        edge.className = `vp-edge ${side}`;
        el.appendChild(edge);
      }
      const label = document.createElement("span");
      label.className = "vp-label";
      label.textContent = `${obj.resW}×${obj.resH}`;
      el.appendChild(label);
    }
    this._applyTransform(obj, el);
    return el;
  }

  _applyTransform(obj, el = this.nodes.get(obj.id)) {
    if (!el) return;
    el.style.left = `${obj.x}px`;
    el.style.top = `${obj.y}px`;
    el.style.width = `${obj.w}px`;
    el.style.height = `${obj.h}px`;
    if (obj.type === "viewport") {
      const label = el.querySelector(".vp-label");
      if (label) label.textContent = `${obj.resW}×${obj.resH}`;
    } else if (obj.type === "image") {
      const img = el.querySelector("img");
      if (img) img.style.imageRendering = obj.interp === "nearest" ? "pixelated" : "auto";
    }
  }
}

// 创建图片对象。x,y = 想要的中心点（世界坐标）。blob = 不可变源数据。
// 显示用 URL 由 Scene._renderNode 懒生成、随对象生命周期销毁，对象之间不共享 URL（duplicate 也是各自一份 URL）。
// 原始分辨率（naturalW/H）单独存，给导出 / 后期高质量光栅化用。
export function makeImageObject({ blob, naturalW, naturalH, x, y, targetLongWorld }) {
  const longNat = Math.max(naturalW, naturalH) || 1;
  const factor = (targetLongWorld && targetLongWorld > 0) ? (targetLongWorld / longNat) : 1;
  const w = Math.max(8, Math.round(naturalW * factor));
  const h = Math.max(8, Math.round(naturalH * factor));
  return {
    type: "image",
    blob,
    _displayUrl: null,
    naturalW,
    naturalH,
    aspectLocked: true,
    interp: "linear", // 像素图切到 "nearest"
    x: Math.round(x - w / 2),
    y: Math.round(y - h / 2),
    w,
    h,
  };
}

export function makeViewportObject({ x, y, w = 512, h = 512, resW = 1024, resH = 1024, interp = "linear", binding = "", aspectLocked = true }) {
  // 锁定时强制 rect 比例 = 输出比例（默认 1:1）
  if (aspectLocked) {
    const ra = resW / resH;
    // 保持 max(w,h)，调小边
    if (w / h > ra) w = Math.round(h * ra);
    else h = Math.round(w / ra);
  }
  return {
    type: "viewport",
    x: Math.round(x - w / 2),
    y: Math.round(y - h / 2),
    w: Math.round(w),
    h: Math.round(h),
    resW,
    resH,
    interp,
    binding,
    aspectLocked,
  };
}

export const HANDLE_ANCHORS = ["nw", "n", "ne", "e", "se", "s", "sw", "w"];

// 把手拖拽：8 个 anchor，corner（两个字母）和 edge（一个字母）。
// corner + aspectLocked → uniform scale。
// edge → 永远 1D 自由拉伸（即使 aspectLocked，因为用户明确拖了边 = 想改长宽比）。
export function resizeRect(obj, anchor, targetWX, targetWY) {
  const { x, y, w, h } = obj;
  const isCorner = anchor.length === 2;
  const aspectLocked = !!obj.aspectLocked;
  const MIN = 8;
  let L = x, R = x + w, T = y, B = y + h;
  if (anchor.includes("e")) R = Math.max(L + MIN, targetWX);
  if (anchor.includes("w")) L = Math.min(R - MIN, targetWX);
  if (anchor.includes("s")) B = Math.max(T + MIN, targetWY);
  if (anchor.includes("n")) T = Math.min(B - MIN, targetWY);
  if (isCorner && aspectLocked && w > 0 && h > 0) {
    // 用「主导轴」决定缩放：哪个方向相对原尺寸增长更多，用它定 s
    const aspect = w / h;
    const newW = R - L;
    const newH = B - T;
    if (newW / newH > aspect) {
      const targetW = newH * aspect;
      if (anchor.includes("w")) L = R - targetW;
      else R = L + targetW;
    } else {
      const targetH = newW / aspect;
      if (anchor.includes("n")) T = B - targetH;
      else B = T + targetH;
    }
  }
  return {
    x: Math.round(L),
    y: Math.round(T),
    w: Math.max(MIN, Math.round(R - L)),
    h: Math.max(MIN, Math.round(B - T)),
  };
}

// 当 viewport aspectLocked，且其 rect 比例变化（如边把手拉过之后），让 res 跟上 rect。
// 保留 max(resW, resH)，缩另一个。返回 null 表示比例没变 / 无需调整。
export function syncViewportResToRect(vp) {
  if (!vp.aspectLocked || vp.type !== "viewport") return null;
  const targetAspect = vp.w / vp.h;
  const curAspect = vp.resW / vp.resH;
  if (Math.abs(targetAspect - curAspect) < 1e-4) return null;
  let { resW, resH } = vp;
  if (resW >= resH) resH = Math.max(1, Math.round(resW / targetAspect));
  else resW = Math.max(1, Math.round(resH * targetAspect));
  return { resW, resH };
}

