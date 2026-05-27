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

const MAX_UNDO = 100;

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
    // undo / redo
    this._undoStack = [];
    this._redoStack = [];
    this._actSnap = null;       // 拖拽 / resize 期间的预快照
    this._actDirty = false;     // 期间是否真的改了
  }

  // ----- snapshot / restore / undo / redo -----
  // 快照 = scene.objects 的浅拷贝 + DOM 顺序 + 选区。Blob 共享（不可变），_displayUrl 置空，restore 时重生成。
  snapshot() {
    const objects = new Map();
    for (const [id, obj] of this.objects) {
      objects.set(id, { ...obj, _displayUrl: null });
    }
    const imageOrder = Array.from(this.imagesLayer.children).map((el) => el.dataset.id);
    const viewportOrder = Array.from(this.viewportsLayer.children).map((el) => el.dataset.id);
    return { objects, imageOrder, viewportOrder, selection: new Set(this.selection) };
  }

  restore(snap) {
    // 清场（含 revoke 老 URL）
    for (const id of Array.from(this.objects.keys())) this.remove(id);
    // 用快照里的对象 + 顺序重建
    const rebuild = (orderArr, layer) => {
      for (const id of orderArr) {
        const src = snap.objects.get(id);
        if (!src) continue;
        const copy = { ...src }; // _displayUrl 已经是 null，_renderNode 会重生成
        this.objects.set(id, copy);
        const node = this._renderNode(copy);
        this.nodes.set(id, node);
        layer.appendChild(node);
      }
    };
    rebuild(snap.imageOrder, this.imagesLayer);
    rebuild(snap.viewportOrder, this.viewportsLayer);
    // 还原选区
    this.selection.clear();
    for (const id of snap.selection) {
      this.selection.add(id);
      const n = this.nodes.get(id);
      if (n) n.classList.add("selected");
    }
    this._emit();
  }

  commit(prevSnap) {
    if (!prevSnap) return;
    this._undoStack.push(prevSnap);
    if (this._undoStack.length > MAX_UNDO) this._undoStack.shift();
    this._redoStack.length = 0;
  }

  // 原子动作：snap → fn → commit。一次按键 / 点击 / 粘贴用这个。
  act(fn) {
    const snap = this.snapshot();
    fn();
    this.commit(snap);
  }

  // 拖拽 / resize：pointerdown beginAct，pointerup endAct。期间多次 update 只标 dirty 不重复推栈。
  beginAct() {
    this._actSnap = this.snapshot();
    this._actDirty = false;
  }
  endAct() {
    if (this._actSnap && this._actDirty) {
      this.commit(this._actSnap);
    }
    this._actSnap = null;
    this._actDirty = false;
  }
  cancelAct() {
    this._actSnap = null;
    this._actDirty = false;
  }

  undo() {
    if (!this._undoStack.length) return false;
    const cur = this.snapshot();
    const prev = this._undoStack.pop();
    this._redoStack.push(cur);
    this.restore(prev);
    return true;
  }
  redo() {
    if (!this._redoStack.length) return false;
    const cur = this.snapshot();
    const next = this._redoStack.pop();
    this._undoStack.push(cur);
    this.restore(next);
    return true;
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
    if (this._actSnap) this._actDirty = true;
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

  deselect(id) {
    if (!this.selection.has(id)) return;
    this.selection.delete(id);
    const n = this.nodes.get(id);
    if (n) n.classList.remove("selected");
    this._emit();
  }

  selectMany(ids, additive = false) {
    if (!additive) {
      for (const sid of this.selection) {
        const n = this.nodes.get(sid);
        if (n) n.classList.remove("selected");
      }
      this.selection.clear();
    }
    for (const id of ids) {
      if (!this.objects.has(id)) continue;
      this.selection.add(id);
      const n = this.nodes.get(id);
      if (n) n.classList.add("selected");
    }
    this._emit();
  }

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
    // 旋转后的 AABB 才是视觉包围盒
    return this.list().map((o) => {
      const a = rotatedAABB(o);
      return [a.x0, a.y0, a.x1, a.y1];
    });
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
    el.style.transformOrigin = "50% 50%";
    el.style.transform = obj.rotation ? `rotate(${obj.rotation}deg)` : "";
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
// src = "images/<uuid>.<ext>" —— 既是 IDB blobs 的 key，也是 ZIP 内的路径，跨载体一致。
// blob 是运行时引用（不可变 Blob，duplicate 时多 obj 共享），存储 / 序列化时只保留 src。
export function makeImageObject({ blob, src, naturalW, naturalH, x, y, targetLongWorld }) {
  const longNat = Math.max(naturalW, naturalH) || 1;
  const factor = (targetLongWorld && targetLongWorld > 0) ? (targetLongWorld / longNat) : 1;
  const w = Math.max(8, Math.round(naturalW * factor));
  const h = Math.max(8, Math.round(naturalH * factor));
  return {
    type: "image",
    src,
    blob,
    _displayUrl: null,
    naturalW,
    naturalH,
    locked: false,    // 锁住 = 禁止拖 / 转 / 缩。aspect-lock-on-corner 是默认行为，内化进 resizeRect 里。
    interp: "linear", // 像素图切到 "nearest"
    rotation: 0,      // 度数；CSS rotate 围绕 obj 中心
    x: Math.round(x - w / 2),
    y: Math.round(y - h / 2),
    w,
    h,
  };
}

export function makeViewportObject({ x, y, w = 512, h = 512, resW = 1024, resH = 1024, interp = "linear", binding = "" }) {
  // viewport rect 比例和 res 比例永远一致 —— 创建时就拍平
  const ra = resW / resH;
  if (w / h > ra) w = Math.round(h * ra);
  else h = Math.round(w / ra);
  return {
    type: "viewport",
    x: Math.round(x - w / 2),
    y: Math.round(y - h / 2),
    w: Math.round(w),
    h: Math.round(h),
    rotation: 0,
    locked: false,    // 同 image
    resW,
    resH,
    interp,
    binding,
  };
}

export const HANDLE_ANCHORS = ["nw", "n", "ne", "e", "se", "s", "sw", "w"];

const MIN_SIZE = 8;

// 把 (dx, dy) 旋转 rad 弧度
function rotateVec(dx, dy, rad) {
  const c = Math.cos(rad), s = Math.sin(rad);
  return { x: dx * c - dy * s, y: dx * s + dy * c };
}

// 计算 anchor 在 obj 自身参考系下相对 center 的偏移（即 drag 中保持不动的「对角」）
function anchorLocalOffset(obj, anchor) {
  const isCorner = anchor.length === 2;
  const sgnX = anchor.includes("e") ? +1 : anchor.includes("w") ? -1 : 0;
  const sgnY = anchor.includes("s") ? +1 : anchor.includes("n") ? -1 : 0;
  // anchor 是"对角"：拖动 dragged-anchor → opposite stays。
  // 对边 / 对角的 local offset：
  // corner: opposite = (-sgnX * w/2, -sgnY * h/2)
  // edge "e" (sgnX=+1, sgnY=0): opposite = LEFT 边中点 = (-w/2, 0)
  // edge "n" (sgnX=0, sgnY=-1): opposite = BOTTOM 边中点 = (0, +h/2)
  const ax = (sgnX !== 0) ? -sgnX * obj.w / 2 : 0;
  const ay = (sgnY !== 0) ? -sgnY * obj.h / 2 : 0;
  return { ax, ay, sgnX, sgnY, isCorner };
}

// drag 开始时算一次：anchor 的 world 坐标（drag 全程保持）
export function anchorWorldPos(obj, anchor) {
  const { ax, ay } = anchorLocalOffset(obj, anchor);
  const cx = obj.x + obj.w / 2;
  const cy = obj.y + obj.h / 2;
  const rad = (obj.rotation || 0) * Math.PI / 180;
  const r = rotateVec(ax, ay, rad);
  return { x: cx + r.x, y: cy + r.y };
}

// 把手拖拽（支持任意 rotation）：保持 anchor world 不动，cursor 决定新 rect 的对角 / 对边。
// corner → 永远 uniform scale（图 / viewport 都不希望被斜拉）。edge → 1D 自由拉伸（用户拖边 = 想改比例）。
export function resizeRect(obj, anchor, cursorWX, cursorWY, anchorStartWX, anchorStartWY) {
  const { sgnX, sgnY, isCorner } = anchorLocalOffset(obj, anchor);
  const rad = (obj.rotation || 0) * Math.PI / 180;
  // 把「cursor - anchor」转回 obj 自身坐标系，得到 local 对角向量
  const dWorld = { x: cursorWX - anchorStartWX, y: cursorWY - anchorStartWY };
  const dLocal = rotateVec(dWorld.x, dWorld.y, -rad);
  // 新尺寸
  let newW = (sgnX !== 0) ? sgnX * dLocal.x : obj.w;
  let newH = (sgnY !== 0) ? sgnY * dLocal.y : obj.h;
  if (newW < MIN_SIZE) newW = MIN_SIZE;
  if (newH < MIN_SIZE) newH = MIN_SIZE;
  // corner 永远 uniform scale 保留 aspect
  if (isCorner && obj.w > 0 && obj.h > 0) {
    const aspect = obj.w / obj.h;
    if (newW / newH > aspect) newW = newH * aspect;
    else newH = newW / aspect;
    if (newW < MIN_SIZE) { newW = MIN_SIZE; newH = newW / aspect; }
    if (newH < MIN_SIZE) { newH = MIN_SIZE; newW = newH * aspect; }
  }
  // 新中心 = anchor_world - R(rad) * anchor_local
  const anchorLocalX = (sgnX !== 0) ? -sgnX * newW / 2 : 0;
  const anchorLocalY = (sgnY !== 0) ? -sgnY * newH / 2 : 0;
  const rotatedAnchorLocal = rotateVec(anchorLocalX, anchorLocalY, rad);
  const newCX = anchorStartWX - rotatedAnchorLocal.x;
  const newCY = anchorStartWY - rotatedAnchorLocal.y;
  return {
    x: Math.round(newCX - newW / 2),
    y: Math.round(newCY - newH / 2),
    w: Math.round(newW),
    h: Math.round(newH),
  };
}

// 计算 obj 旋转后 8 个把手 + 旋转把手在 world 中的位置（相对 obj 中心 = (cx, cy)）
// 用于 overlay 渲染。rotationOffsetWorld 是「旋转把手离 top-center 的 local 距离」（一般传 screen-24 / scale）。
export function handleWorldPositions(obj, rotationOffsetWorld = 24) {
  const cx = obj.x + obj.w / 2;
  const cy = obj.y + obj.h / 2;
  const rad = (obj.rotation || 0) * Math.PI / 180;
  const hw = obj.w / 2, hh = obj.h / 2;
  const local = {
    nw: [-hw, -hh], n: [0, -hh], ne: [+hw, -hh],
    w:  [-hw, 0],                e:  [+hw, 0],
    sw: [-hw, +hh], s: [0, +hh], se: [+hw, +hh],
    rot: [0, -hh - rotationOffsetWorld],
  };
  const out = {};
  for (const [k, [lx, ly]] of Object.entries(local)) {
    const r = rotateVec(lx, ly, rad);
    out[k] = { x: cx + r.x, y: cy + r.y };
  }
  return out;
}

// obj 旋转后 4 个 corner 的 world bbox（AABB）
export function rotatedAABB(obj) {
  const cx = obj.x + obj.w / 2;
  const cy = obj.y + obj.h / 2;
  const rad = (obj.rotation || 0) * Math.PI / 180;
  const hw = obj.w / 2, hh = obj.h / 2;
  const corners = [[-hw, -hh], [+hw, -hh], [+hw, +hh], [-hw, +hh]];
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
  for (const [lx, ly] of corners) {
    const r = rotateVec(lx, ly, rad);
    const px = cx + r.x, py = cy + r.y;
    if (px < x0) x0 = px;
    if (py < y0) y0 = py;
    if (px > x1) x1 = px;
    if (py > y1) y1 = py;
  }
  return { x0, y0, x1, y1 };
}

// viewport：rect 比例变了（边把手拉了）就让 res 跟上。保留 max(resW, resH)，缩另一个。
// 返回 null 表示比例没变 / 无需调整。viewport rect 和 res 永远同纵横比，这是「always-on」行为。
export function syncViewportResToRect(vp) {
  if (vp.type !== "viewport") return null;
  const targetAspect = vp.w / vp.h;
  const curAspect = vp.resW / vp.resH;
  if (Math.abs(targetAspect - curAspect) < 1e-4) return null;
  let { resW, resH } = vp;
  if (resW >= resH) resH = Math.max(1, Math.round(resW / targetAspect));
  else resW = Math.max(1, Math.round(resH * targetAspect));
  return { resW, resH };
}

