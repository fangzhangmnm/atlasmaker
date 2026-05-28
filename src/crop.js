// crop.js — 非破坏裁切模式：4 角 + 4 边 gizmo（Word 风格），拖向内裁。
//
// 数据：obj.crop = { x, y, w, h }（natural px，相对**原始**图片，不是相对上次 crop）。
//   undefined = 无裁切（全图）。
//
// 显示：_renderNode / _applyTransform 把 obj.crop 应用到 <img>：
//   .obj.image overflow:hidden + <img> 绝对定位 + 放大到 (naturalW × obj.w/crop.w, naturalH × obj.h/crop.h)
//   再 left/top 偏移 -crop.x × (obj.w/crop.w), -crop.y × (obj.h/crop.h)
//   → 在 obj.w × obj.h 矩形内正好显示 crop 区域。
//
// 裁切流程：
//   1. start({ obj }) — 进 mode。state.rect 初始化为 obj 在世界中的 bbox（即「当前可见全部」）
//   2. 用户拖 handle → state.rect 收缩（永远在 obj bbox 内、有最小尺寸）
//   3. commit() → 计算 new obj.crop（in natural px）+ new obj.x/y/w/h（位置 shrink-to-crop），
//      app 层在 scene.act 里 update。cancel() = 丢弃。
//
// **不支持旋转**：obj.rotation !== 0 直接拒绝进 mode（toast 提示先重置旋转）。
// **只能向内裁**：handle 不能拖出当前 image bbox 外（不存在「扩回上次 crop」的扩展 UX；
// 想反悔走「Reset crop」按钮或 Ctrl+Z）。

const MIN_WORLD = 16; // crop 最小尺寸（world px），太小没法操作

let _state = null;
let _onChange = null; // 通知 app 重渲染 overlay

export function isActive() { return !!_state; }
export function activeObjId() { return _state?.objId; }

/**
 * 进入裁切模式。回调用于 app 通知重渲染 / 应用 / 取消时回 hook。
 * bounds / initialRect 可选 —— 默认都是 obj bbox（只能向内裁）。
 * 想支持「向外拉回」时，app 层先 temp-expand obj 到 full natural，bounds = expanded bbox，
 * initialRect = 原可见区域 → 用户拖出去就是 uncrop。
 */
export function start({ obj, onApply, onCancel, onChange, bounds, initialRect }) {
  const defBox = { x: obj.x, y: obj.y, w: obj.w, h: obj.h };
  _state = {
    objId: obj.id,
    rect: initialRect ? { ...initialRect } : { ...defBox },
    bounds: bounds ? { ...bounds } : { ...defBox },
    onApply, onCancel,
  };
  _onChange = onChange || null;
}

export function cancel() {
  if (!_state) return;
  const cb = _state.onCancel;
  _state = null;
  _onChange = null;
  if (cb) cb();
}

export function commit() {
  if (!_state) return;
  const r = { ..._state.rect };
  const b = { ..._state.bounds };
  const cb = _state.onApply;
  _state = null;
  _onChange = null;
  if (cb) cb({ rect: r, bounds: b });
}

export function getRect() { return _state ? { ..._state.rect } : null; }
export function getBounds() { return _state ? { ..._state.bounds } : null; }

/** 拖 handle 时调用 */
export function setRect(rect) {
  if (!_state) return;
  const b = _state.bounds;
  // 收紧到 bounds 内 + 最小尺寸
  let x = Math.max(b.x, rect.x);
  let y = Math.max(b.y, rect.y);
  let w = Math.min(rect.w, b.x + b.w - x);
  let h = Math.min(rect.h, b.y + b.h - y);
  if (w < MIN_WORLD) w = MIN_WORLD;
  if (h < MIN_WORLD) h = MIN_WORLD;
  // 右下不能超
  if (x + w > b.x + b.w) x = b.x + b.w - w;
  if (y + h > b.y + b.h) y = b.y + b.h - h;
  _state.rect = { x, y, w, h };
  if (_onChange) _onChange();
}

/**
 * 应用结果数学：把 crop rect（世界、image-local）烤成新 obj 参数。
 * **无旋转假设**。
 *
 * @param {Object} obj — 当前 obj（含 x, y, w, h, naturalW, naturalH, crop?)
 * @param {Object} rect — 用户选的 crop rect（世界坐标）
 * @returns {{ x, y, w, h, crop }} new obj 字段
 */
export function applyCropMath(obj, rect) {
  const old = obj.crop || { x: 0, y: 0, w: obj.naturalW, h: obj.naturalH };
  // rect 在 obj bbox 内的偏移
  const dx = rect.x - obj.x;
  const dy = rect.y - obj.y;
  // world per natural px：旧的
  const wpnX = obj.w / old.w;
  const wpnY = obj.h / old.h;
  const newCrop = {
    x: old.x + dx / wpnX,
    y: old.y + dy / wpnY,
    w: rect.w / wpnX,
    h: rect.h / wpnY,
  };
  return {
    x: rect.x,
    y: rect.y,
    w: rect.w,
    h: rect.h,
    crop: newCrop,
  };
}
