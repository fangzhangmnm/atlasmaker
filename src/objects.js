// Scene = 对象集合。每个对象有：id, type, x, y, w, h（世界单位），加上类型特定字段。
// 渲染：DOM 节点。世界 px 直接写 left/top/width/height；外层 #world 的 scale 负责放大缩小。
// 这样浏览器原生 GPU compositing；几十张参考图也很流畅。
//
// type:
//   "image"    — { src (object URL), naturalW, naturalH }
//   "viewport" — { resW, resH, interp ("linear"|"nearest"), binding }

let _idSeq = 0;
const nextId = () => `o${++_idSeq}`;

export class Scene {
  constructor(worldEl) {
    this.worldEl = worldEl;
    this.objects = new Map(); // id -> obj
    this.nodes = new Map();   // id -> DOM 节点
    this.selection = new Set();
    this._listeners = new Set();
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

  add(obj) {
    if (!obj.id) obj.id = nextId();
    this.objects.set(obj.id, obj);
    const node = this._renderNode(obj);
    this.nodes.set(obj.id, node);
    this.worldEl.appendChild(node);
    this._emit();
    return obj;
  }

  remove(id) {
    const node = this.nodes.get(id);
    if (node) node.remove();
    this.nodes.delete(id);
    const obj = this.objects.get(id);
    // 释放 object URL，避免泄漏
    if (obj && obj.type === "image" && obj._ownsUrl && obj.src) {
      try { URL.revokeObjectURL(obj.src); } catch (_) {}
    }
    this.objects.delete(id);
    this.selection.delete(id);
    this._emit();
  }

  update(id, patch) {
    const obj = this.objects.get(id);
    if (!obj) return;
    Object.assign(obj, patch);
    this._applyTransform(obj);
    this._emit();
  }

  // 提到最上层（z-order = DOM 顺序）
  raise(id) {
    const node = this.nodes.get(id);
    if (node) this.worldEl.appendChild(node);
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
      const img = document.createElement("img");
      img.src = obj.src;
      img.draggable = false;
      el.appendChild(img);
    } else if (obj.type === "viewport") {
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
    }
  }
}

export function makeImageObject({ src, naturalW, naturalH, x, y, ownsUrl = true, maxLong = 800 }) {
  // 让粘贴进来的图按"长边 ≤ maxLong 世界 px"显示，避免一张超大图把视野塞满
  const long = Math.max(naturalW, naturalH);
  const scale = long > maxLong ? maxLong / long : 1;
  const w = Math.round(naturalW * scale);
  const h = Math.round(naturalH * scale);
  return {
    type: "image",
    src,
    naturalW,
    naturalH,
    _ownsUrl: ownsUrl,
    x: Math.round(x - w / 2),
    y: Math.round(y - h / 2),
    w,
    h,
  };
}

export function makeViewportObject({ x, y, w = 512, h = 512, resW = 1024, resH = 1024, interp = "linear", binding = "" }) {
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
  };
}
