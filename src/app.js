// AtlasMaker — 无限工作台 + 粘贴图片 + viewport 框 + 持久化（IDB / ZIP）+ Blender 推送。

import { Board } from "./board.js";
import {
  Scene,
  makeImageObject,
  makeViewportObject,
  resizeRect,
  anchorWorldPos,
  handleWorldPositions,
  rotatedAABB,
  syncViewportResToRect,
  HANDLE_ANCHORS,
} from "./objects.js";
import { Input } from "./input.js";
import { BTPManager, BTPError } from "./btp.js";
import * as storage from "./storage.js";
import { zipPack, zipUnpack } from "./zip.js";

const SCENE_FORMAT_VERSION = 1;

const boardEl = document.getElementById("board");
const worldEl = document.getElementById("world");
const overlayEl = document.getElementById("overlay");

const board = new Board(boardEl, worldEl);
const scene = new Scene(worldEl);

// 初始视野放在 board 中心
{
  const r = boardEl.getBoundingClientRect();
  board.setViewport(r.width / 2, r.height / 2, 1);
}

// ----- HUD -----
const zoomLabel = document.getElementById("zoomLabel");
const countLabel = document.getElementById("countLabel");
const statusLabel = document.getElementById("statusLabel");

function refreshHud() {
  zoomLabel.textContent = `${Math.round(board.viewport.scale * 100)}%`;
  const n = scene.count();
  countLabel.textContent = `${n} 项`;
  if (n === 0) {
    statusLabel.textContent = "空白工作台 — Ctrl+V 粘贴图片";
  } else {
    const sel = scene.firstSelected();
    if (sel) {
      if (sel.type === "image") {
        statusLabel.textContent = `图片 ${sel.naturalW}×${sel.naturalH} (rect ${sel.w}×${sel.h})`;
      } else if (sel.type === "viewport") {
        statusLabel.textContent = `Viewport rect ${sel.w}×${sel.h} → 输出 ${sel.resW}×${sel.resH}`;
      }
    } else {
      statusLabel.textContent = "拖动 / 选中对象";
    }
  }
}

board.onChange(() => { refreshHud(); renderOverlay(); });
scene.onChange(() => { refreshHud(); refreshPanels(); renderOverlay(); });

// ----- 工具栏 -----
const toolButtons = {
  select: document.getElementById("toolSelect"),
  hand: document.getElementById("toolHand"),
  viewport: document.getElementById("toolViewport"),
};

function setActiveTool(tool) {
  for (const [name, btn] of Object.entries(toolButtons)) {
    btn.setAttribute("aria-pressed", name === tool ? "true" : "false");
  }
}

for (const [name, btn] of Object.entries(toolButtons)) {
  btn.addEventListener("click", () => input.setTool(name));
}

document.getElementById("fitButton").addEventListener("click", () => doFit());
function doFit() { board.fitTo(scene.bboxes()); }

// 导入 / 导出
document.getElementById("exportButton").addEventListener("click", () => exportCurrentSceneAsZip());
const importInput = document.getElementById("importFile");
document.getElementById("importButton").addEventListener("click", () => importInput.click());
importInput.addEventListener("change", () => {
  if (importInput.files && importInput.files[0]) {
    importSceneFromZipFile(importInput.files[0]);
    importInput.value = ""; // 允许选同名文件再次
  }
});

// ----- session 名 + 持久化 -----
const sessionInput = document.getElementById("sessionName");
const saveStatusEl = document.getElementById("saveStatus");

function applySessionTitle() {
  const name = sessionInput.value.trim() || "未命名";
  document.title = `${name} — AtlasMaker`;
}
sessionInput.addEventListener("input", () => { applySessionTitle(); scheduleSave(); });
sessionInput.addEventListener("change", () => { applySessionTitle(); scheduleSave(); });
applySessionTitle();

// 自动保存：scene / board / sessionName 变 → 防抖 800ms 写 IDB。
// Ctrl+S 立即 flush。导入 / 启动恢复时 _loading 防止把刚读进来的状态原样写回去。
let _saveTimer = null;
let _loading = false;
const SAVE_DEBOUNCE = 800;

function setSaveStatus(state) {
  if (!saveStatusEl) return;
  saveStatusEl.dataset.state = state;
  saveStatusEl.textContent = ({
    dirty:  "未保存",
    saving: "保存中…",
    saved:  "已保存",
    error:  "保存失败",
  })[state] || "";
}

function scheduleSave() {
  if (_loading) return;
  setSaveStatus("dirty");
  if (_saveTimer) clearTimeout(_saveTimer);
  _saveTimer = setTimeout(() => { _saveTimer = null; saveCurrentScene(); }, SAVE_DEBOUNCE);
}

function flushSave() {
  if (_saveTimer) { clearTimeout(_saveTimer); _saveTimer = null; }
  return saveCurrentScene();
}

// 把当前 scene 序列化成 scene.json 文档（无 Blob，只引用 src）
function makeSceneDoc(snap) {
  const objects = Array.from(snap.objects.values()).map((o) => {
    const { _displayUrl, blob, ...rest } = o;
    return rest;
  });
  return {
    format_version: SCENE_FORMAT_VERSION,
    id: "current",
    name: sessionInput.value,
    updatedAt: Date.now(),
    board: { ...board.viewport },
    objects,
    imageOrder: snap.imageOrder,
    viewportOrder: snap.viewportOrder,
  };
}

async function saveCurrentScene() {
  setSaveStatus("saving");
  try {
    const snap = scene.snapshot();
    // 先把所有 image 的 blob 落到 IDB blobs store —— put 是覆盖语义，重复写不会出错
    for (const o of snap.objects.values()) {
      if (o.type === "image" && o.src && o.blob) {
        try { await storage.putBlob(o.src, o.blob); } catch (e) { console.warn("putBlob failed", o.src, e); }
      }
    }
    const doc = makeSceneDoc(snap);
    await storage.putScene("current", doc);
    setSaveStatus("saved");
  } catch (e) {
    console.warn("save failed", e);
    setSaveStatus("error");
  }
}

async function loadCurrentScene() {
  const doc = await storage.getScene("current");
  if (!doc || !Array.isArray(doc.objects)) return false;
  _loading = true;
  try {
    const paths = doc.objects.filter((o) => o.type === "image" && o.src).map((o) => o.src);
    const blobMap = paths.length ? await storage.getBlobsBatch(paths) : {};
    const objMap = new Map();
    for (const o of doc.objects) {
      const obj = { ...o };
      if (obj.type === "image") {
        obj.blob = obj.src ? blobMap[obj.src] : null;
        obj._displayUrl = null;
      }
      objMap.set(obj.id, obj);
    }
    scene.restore({
      objects: objMap,
      imageOrder: doc.imageOrder || [],
      viewportOrder: doc.viewportOrder || [],
      selection: new Set(),
    });
    // restore 是「新基线」，不让 undo 跨越它
    scene._undoStack.length = 0;
    scene._redoStack.length = 0;
    if (doc.board) board.setViewport(doc.board.tx, doc.board.ty, doc.board.scale);
    if (typeof doc.name === "string") { sessionInput.value = doc.name; applySessionTitle(); }
    setSaveStatus("saved");
    return true;
  } finally {
    _loading = false;
  }
}

// 把 scene → ZIP blob（scene.json + images/*）
async function packCurrentSceneZip() {
  const snap = scene.snapshot();
  const doc = makeSceneDoc(snap);
  const entries = [
    { path: "scene.json", data: JSON.stringify(doc, null, 2) },
  ];
  for (const o of snap.objects.values()) {
    if (o.type === "image" && o.src && o.blob) {
      entries.push({ path: o.src, data: o.blob });
    }
  }
  return { blob: await zipPack(entries), doc, imageCount: entries.length - 1 };
}

async function exportCurrentSceneAsZip() {
  try {
    const { blob, imageCount } = await packCurrentSceneZip();
    const safeName = (sessionInput.value || "atlas").replace(/[\\/:*?"<>|]+/g, "_").trim() || "atlas";
    downloadBlob(blob, `${safeName}.atlas.zip`);
    showActionToast(`已导出（${imageCount} 张图）`);
  } catch (e) {
    showActionToast(`导出失败：${e.message || e}`, 4000);
  }
}

async function importSceneFromZipFile(file) {
  try {
    const entries = await zipUnpack(file);
    const sceneBytes = entries["scene.json"];
    if (!sceneBytes) throw new Error("ZIP 里没有 scene.json");
    const doc = JSON.parse(new TextDecoder().decode(sceneBytes));
    if (doc.format_version !== SCENE_FORMAT_VERSION) {
      console.warn("scene.json format_version", doc.format_version, "vs current", SCENE_FORMAT_VERSION);
    }
    const blobEntries = [];
    for (const [path, bytes] of Object.entries(entries)) {
      if (path === "scene.json") continue;
      const ext = path.split(".").pop().toLowerCase();
      const mime = (ext === "jpg" || ext === "jpeg") ? "image/jpeg" : "image/png";
      blobEntries.push([path, new Blob([bytes], { type: mime })]);
    }
    await storage.putBlobsBatch(blobEntries);
    await storage.putScene("current", { ...doc, id: "current", updatedAt: Date.now() });
    await loadCurrentScene();
    showActionToast(`已导入：${doc.name || "未命名"}（${blobEntries.length} 张图）`);
  } catch (e) {
    showActionToast(`导入失败：${e.message || e}`, 5000);
  }
}

// 钩子：scene / board 变 → 自动保存
board.onChange(() => scheduleSave());
scene.onChange(() => scheduleSave());

// ----- 主题 -----
const THEMES = ["auto", "day", "night"];
document.getElementById("themeButton").addEventListener("click", () => {
  const cur = document.documentElement.getAttribute("data-theme") || "auto";
  const next = THEMES[(THEMES.indexOf(cur) + 1) % THEMES.length];
  document.documentElement.setAttribute("data-theme", next);
  try { localStorage.setItem("atlasmaker.theme", next); } catch (_) {}
});

// ----- viewport 属性浮窗 -----
const vpPanel = document.getElementById("viewportPanel");
const vpResW = document.getElementById("vpResW");
const vpResH = document.getElementById("vpResH");
const vpInterp = document.getElementById("vpInterp");
const vpBinding = document.getElementById("vpBinding");
const vpLock = document.getElementById("vpLock");
const vpPushBtn = document.getElementById("vpPush");
const btpDatalist = document.getElementById("btpTextureList");
const vpExportBtn = document.getElementById("vpExport");
const vpCopyBtn = document.getElementById("vpCopy");
const vpDeleteBtn = document.getElementById("vpDelete");

// ----- 图片属性浮窗 -----
const imgPanel = document.getElementById("imagePanel");
const imgNaturalLabel = document.getElementById("imgNaturalLabel");
const imgRectLabel = document.getElementById("imgRectLabel");
const imgLock = document.getElementById("imgLock");
const imgInterp = document.getElementById("imgInterp");
const imgDeleteBtn = document.getElementById("imgDelete");

document.getElementById("viewportPanelClose").addEventListener("click", () => {
  scene.clearSelection();
});
document.getElementById("imagePanelClose").addEventListener("click", () => {
  scene.clearSelection();
});

function refreshPanels() {
  // 多选时两个浮窗都不显示（per-obj 属性不适合多选编辑）
  if (scene.selection.size > 1) {
    vpPanel.classList.add("hidden");
    imgPanel.classList.add("hidden");
    return;
  }
  const sel = scene.firstSelected();
  if (sel && sel.type === "viewport") {
    vpPanel.classList.remove("hidden");
    imgPanel.classList.add("hidden");
    vpResW.value = sel.resW;
    vpResH.value = sel.resH;
    vpInterp.value = sel.interp || "linear";
    vpBinding.value = sel.binding || "";
    vpLock.setAttribute("aria-pressed", sel.locked ? "true" : "false");
    vpLock.textContent = sel.locked ? "🔒" : "🔓";
  } else if (sel && sel.type === "image") {
    imgPanel.classList.remove("hidden");
    vpPanel.classList.add("hidden");
    imgNaturalLabel.textContent = `${sel.naturalW}×${sel.naturalH}`;
    imgRectLabel.textContent = `${sel.w}×${sel.h}`;
    imgLock.setAttribute("aria-pressed", sel.locked ? "true" : "false");
    imgLock.textContent = sel.locked ? "🔒" : "🔓";
    imgInterp.value = sel.interp || "linear";
  } else {
    vpPanel.classList.add("hidden");
    imgPanel.classList.add("hidden");
  }
}

function patchSelectedViewport(patch) {
  const sel = scene.firstSelected();
  if (!sel || sel.type !== "viewport") return;
  scene.act(() => scene.update(sel.id, patch));
}

function onResChange(field) {
  const sel = scene.firstSelected();
  if (!sel || sel.type !== "viewport") return;
  let newResW = field === "w" ? clampInt(vpResW.value, 1, 8192) : sel.resW;
  let newResH = field === "h" ? clampInt(vpResH.value, 1, 8192) : sel.resH;
  // viewport rect/res 永远同比 —— 改谁，另一个 res 跟（不动 rect）
  if (sel.w > 0 && sel.h > 0) {
    const rectAspect = sel.w / sel.h;
    if (field === "w") newResH = Math.max(1, Math.round(newResW / rectAspect));
    else newResW = Math.max(1, Math.round(newResH * rectAspect));
  }
  scene.act(() => scene.update(sel.id, { resW: newResW, resH: newResH }));
}
vpResW.addEventListener("change", () => onResChange("w"));
vpResH.addEventListener("change", () => onResChange("h"));
vpInterp.addEventListener("change", () => patchSelectedViewport({ interp: vpInterp.value }));

vpLock.addEventListener("click", () => {
  const sel = scene.firstSelected();
  if (!sel || sel.type !== "viewport") return;
  scene.act(() => scene.update(sel.id, { locked: !sel.locked }));
});

vpExportBtn.addEventListener("click", async () => {
  const sel = scene.firstSelected();
  if (!sel || sel.type !== "viewport") return;
  const blob = await rasterizeViewport(sel);
  if (!blob) { showActionToast("导出失败"); return; }
  downloadBlob(blob, `viewport-${sel.resW}x${sel.resH}.png`);
  showActionToast(`已导出 ${sel.resW}×${sel.resH} PNG`);
});

vpCopyBtn.addEventListener("click", async () => {
  const sel = scene.firstSelected();
  if (!sel || sel.type !== "viewport") return;
  const blob = await rasterizeViewport(sel);
  if (!blob) { showActionToast("导出失败"); return; }
  try {
    await navigator.clipboard.write([new ClipboardItem({ "image/png": blob })]);
    showActionToast(`${sel.resW}×${sel.resH} 已复制到剪贴板`);
  } catch (e) {
    showActionToast("剪贴板复制失败：" + (e.message || e));
  }
});

vpDeleteBtn.addEventListener("click", () => {
  const sel = scene.firstSelected();
  if (sel) scene.act(() => scene.remove(sel.id));
});

// ----- viewport binding & push to Blender -----
function onBindingChange() {
  const sel = scene.firstSelected();
  if (!sel || sel.type !== "viewport") return;
  if (sel.binding === vpBinding.value) return;
  scene.act(() => scene.update(sel.id, { binding: vpBinding.value }));
}
vpBinding.addEventListener("change", onBindingChange);
vpBinding.addEventListener("blur", onBindingChange);

vpBinding.addEventListener("focus", async () => {
  if (!btp.isConnected()) return;
  try {
    const list = await btp.listTextures();
    btpDatalist.innerHTML = "";
    for (const t of list) {
      const opt = document.createElement("option");
      opt.value = t.name;
      opt.textContent = `${t.width}×${t.height}`;
      btpDatalist.appendChild(opt);
    }
  } catch (_) {}
});

vpPushBtn.addEventListener("click", async () => {
  const sel = scene.firstSelected();
  if (!sel || sel.type !== "viewport") return;
  if (!btp.isConnected()) {
    showActionToast("Blender 未连接 —— 点顶栏「Blender」图标重试");
    return;
  }
  const name = (sel.binding || "").trim();
  if (!name) {
    showActionToast("先填 binding 名");
    vpBinding.focus();
    return;
  }
  vpPushBtn.disabled = true;
  showActionToast(`推送中 ${sel.resW}×${sel.resH} → ${name}…`, 60000);
  try {
    const blob = await rasterizeViewport(sel);
    if (!blob) throw new Error("光栅化失败");
    const { action } = await btp.push(name, blob);
    showActionToast(action === "created"
      ? `已新建 Blender texture: ${name} (${sel.resW}×${sel.resH})`
      : `已更新 Blender texture: ${name} (${sel.resW}×${sel.resH})`);
  } catch (e) {
    const msg = e instanceof BTPError ? `${e.code}: ${e.message}` : (e.message || String(e));
    showActionToast(`推送失败：${msg}`, 4000);
  } finally {
    vpPushBtn.disabled = false;
  }
});

// ----- 图片浮窗 wiring -----
imgLock.addEventListener("click", () => {
  const sel = scene.firstSelected();
  if (!sel || sel.type !== "image") return;
  scene.act(() => scene.update(sel.id, { locked: !sel.locked }));
});
imgInterp.addEventListener("change", () => {
  const sel = scene.firstSelected();
  if (!sel || sel.type !== "image") return;
  scene.act(() => scene.update(sel.id, { interp: imgInterp.value }));
});
imgDeleteBtn.addEventListener("click", () => {
  const sel = scene.firstSelected();
  if (sel) scene.act(() => scene.remove(sel.id));
});

// ----- z-order 按钮（两个 panel 共用一套 handler） -----
function wireZBtn(btnId, fn) {
  const btn = document.getElementById(btnId);
  if (!btn) return;
  btn.addEventListener("click", () => {
    if (!scene.selection.size) return;
    scene.act(() => {
      for (const id of scene.selection) fn(id);
    });
  });
}
// 注：旧 wireZBtn 的 fn 直接对 id 操作；包裹 act 之后只跑一次，下面这些就是单步动作
wireZBtn("vpZTop",    (id) => scene.raiseToTop(id));
wireZBtn("vpZUp",     (id) => scene.raiseOne(id));
wireZBtn("vpZDown",   (id) => scene.lowerOne(id));
wireZBtn("vpZBottom", (id) => scene.lowerToBottom(id));
wireZBtn("imgZTop",    (id) => scene.raiseToTop(id));
wireZBtn("imgZUp",     (id) => scene.raiseOne(id));
wireZBtn("imgZDown",   (id) => scene.lowerOne(id));
wireZBtn("imgZBottom", (id) => scene.lowerToBottom(id));

// ----- 短 toast -----
const actionToast = document.getElementById("actionToast");
const actionToastText = document.getElementById("actionToastText");
let _toastTimer = null;
function showActionToast(text, ms = 2000) {
  actionToastText.textContent = text;
  actionToast.classList.remove("hidden");
  if (_toastTimer) clearTimeout(_toastTimer);
  _toastTimer = setTimeout(() => actionToast.classList.add("hidden"), ms);
}

function clampInt(v, lo, hi) {
  const n = Math.round(Number(v) || 0);
  return Math.max(lo, Math.min(hi, n));
}

// ----- 输入 -----
const input = new Input({
  boardEl,
  board,
  scene,
  onTool: setActiveTool,
  onPaste: ({ blob, naturalW, naturalH, x, y, targetLongWorld }) => {
    const ext = (blob.type && blob.type.includes("jpeg")) ? "jpg" : "png";
    const uid = (typeof crypto !== "undefined" && crypto.randomUUID)
      ? crypto.randomUUID()
      : `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
    const src = `images/${uid}.${ext}`;
    scene.act(() => {
      const obj = makeImageObject({ blob, src, naturalW, naturalH, x, y, targetLongWorld });
      scene.add(obj);
      scene.select(obj.id, false);
    });
    // scheduleSave 由 scene.onChange 自动触发；不在这里再调一次
  },
  onViewportFinish: ({ x, y, w, h }) => {
    scene.act(() => {
      const obj = makeViewportObject({ x, y, w, h });
      scene.add(obj);
      scene.select(obj.id, false);
    });
  },
  hooks: {
    onFit: doFit,
    onSave: () => flushSave(),
    onDelete: () => {
      if (!scene.selection.size) return;
      scene.act(() => {
        for (const id of Array.from(scene.selection)) scene.remove(id);
      });
    },
    onDuplicate: () => {
      if (!scene.selection.size) return;
      scene.act(() => {
        const ids = Array.from(scene.selection);
        const newIds = [];
        for (const id of ids) {
          const src = scene.get(id);
          if (!src) continue;
          // 浅拷贝就行：Blob 不可变可共享，URL 让 _renderNode 重新生成
          const copy = { ...src };
          delete copy.id;
          copy._displayUrl = null;
          copy.x += 20;
          copy.y += 20;
          scene.add(copy);
          newIds.push(copy.id);
        }
        if (newIds.length) {
          scene.clearSelection();
          for (const nid of newIds) scene.select(nid, true);
        }
      });
    },
  },
});
input.setTool("select");

// ----- Overlay：选框 + 8 把手（屏幕 px，不跟 #world 缩放） -----
// 拖拽中不能 innerHTML 清空 —— 否则把手 DOM 被销毁，pointerCapture 丢，drag 中断。
// 所以：选区集没变 → 只更新位置；变了 → 重建。
let _renderedSelSig = "";
function renderOverlay() {
  const multi = scene.selection.size > 1;
  // 多选时签名 = "multi:<ids>"，单选 = id。变了就重建（多选没有 handle）。
  const sig = (multi ? "multi:" : "") + Array.from(scene.selection).join(",");
  const rebuild = sig !== _renderedSelSig;
  if (rebuild) {
    overlayEl.innerHTML = "";
    _renderedSelSig = sig;
  }
  const br = boardEl.getBoundingClientRect();
  if (multi) {
    // 多选：每个 obj 旋转后的 AABB 取并集，画 union rect。不放 handle（一期不支持群组 resize）。
    let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
    for (const id of scene.selection) {
      const o = scene.get(id);
      if (!o) continue;
      const a = rotatedAABB(o);
      if (a.x0 < x0) x0 = a.x0;
      if (a.y0 < y0) y0 = a.y0;
      if (a.x1 > x1) x1 = a.x1;
      if (a.y1 > y1) y1 = a.y1;
    }
    if (x0 === Infinity) return;
    let rectEl = overlayEl.querySelector(".overlay-rect[data-id=__multi__]");
    if (rebuild || !rectEl) {
      rectEl = document.createElement("div");
      rectEl.className = "overlay-rect";
      rectEl.dataset.id = "__multi__";
      overlayEl.appendChild(rectEl);
    }
    const aPt = board.worldToScreen(x0, y0);
    const bPt = board.worldToScreen(x1, y1);
    rectEl.style.left = `${aPt.x - br.left}px`;
    rectEl.style.top = `${aPt.y - br.top}px`;
    rectEl.style.width = `${bPt.x - aPt.x}px`;
    rectEl.style.height = `${bPt.y - aPt.y}px`;
    rectEl.style.transform = "";
    return;
  }
  // 单选：rect（CSS rotate）+ 8 resize handle（屏幕 px 位置，每个 handle 已被旋转）+ 1 rotation handle
  // obj 锁住时不画 handle/rotation handle，rect 加 .locked class 视觉提示
  for (const id of scene.selection) {
    const obj = scene.get(id);
    if (!obj) continue;
    const showHandles = !obj.locked;
    let rectEl, rotEl;
    const handles = {};
    if (rebuild) {
      rectEl = document.createElement("div");
      rectEl.className = "overlay-rect";
      rectEl.dataset.id = id;
      overlayEl.appendChild(rectEl);
      if (showHandles) {
        for (const a of HANDLE_ANCHORS) {
          const h = document.createElement("div");
          h.className = "overlay-handle";
          h.dataset.anchor = a;
          h.dataset.id = id;
          if (a === "n" || a === "s") h.style.cursor = "ns-resize";
          else if (a === "e" || a === "w") h.style.cursor = "ew-resize";
          h.addEventListener("pointerdown", onHandlePointerDown);
          overlayEl.appendChild(h);
          handles[a] = h;
        }
        rotEl = document.createElement("div");
        rotEl.className = "overlay-rot";
        rotEl.dataset.id = id;
        rotEl.addEventListener("pointerdown", onRotateHandlePointerDown);
        overlayEl.appendChild(rotEl);
      }
    } else {
      rectEl = overlayEl.querySelector(`.overlay-rect[data-id="${id}"]`);
      if (showHandles) {
        for (const a of HANDLE_ANCHORS) {
          handles[a] = overlayEl.querySelector(`.overlay-handle[data-id="${id}"][data-anchor="${a}"]`);
        }
        rotEl = overlayEl.querySelector(`.overlay-rot[data-id="${id}"]`);
      }
    }
    // rect：用 CSS rotate 表示旋转，宽高 = 世界 × scale
    const scale = board.viewport.scale;
    const cWorldX = obj.x + obj.w / 2, cWorldY = obj.y + obj.h / 2;
    const cScreen = board.worldToScreen(cWorldX, cWorldY);
    const cL = cScreen.x - br.left, cT = cScreen.y - br.top;
    const wScreen = obj.w * scale, hScreen = obj.h * scale;
    if (rectEl) {
      rectEl.style.left = `${cL - wScreen / 2}px`;
      rectEl.style.top = `${cT - hScreen / 2}px`;
      rectEl.style.width = `${wScreen}px`;
      rectEl.style.height = `${hScreen}px`;
      rectEl.style.transform = obj.rotation ? `rotate(${obj.rotation}deg)` : "";
      rectEl.style.transformOrigin = "50% 50%";
      rectEl.classList.toggle("locked", !!obj.locked);
    }
    if (!showHandles) continue;
    // handle 位置：用 handleWorldPositions 拿到旋转后的 world 坐标，再转屏幕
    const rotationOffsetWorld = 24 / scale; // 旋转把手离 top-center 24 屏幕 px
    const hwp = handleWorldPositions(obj, rotationOffsetWorld);
    for (const a of HANDLE_ANCHORS) {
      const h = handles[a];
      if (!h) continue;
      const sp = board.worldToScreen(hwp[a].x, hwp[a].y);
      h.style.left = `${sp.x - br.left}px`;
      h.style.top = `${sp.y - br.top}px`;
    }
    if (rotEl) {
      const sp = board.worldToScreen(hwp.rot.x, hwp.rot.y);
      rotEl.style.left = `${sp.x - br.left}px`;
      rotEl.style.top = `${sp.y - br.top}px`;
    }
  }
}

let _resizeState = null;
function onHandlePointerDown(ev) {
  ev.preventDefault();
  ev.stopPropagation();
  const anchor = ev.currentTarget.dataset.anchor;
  const id = ev.currentTarget.dataset.id;
  const obj = scene.get(id);
  if (!obj) return;
  ev.currentTarget.setPointerCapture(ev.pointerId);
  scene.beginAct();
  // 把 anchor 的 world 坐标算好（drag 中保持，对支持旋转的 resize 数学是必需）
  const aw = anchorWorldPos(obj, anchor);
  _resizeState = {
    id, anchor,
    anchorStartWX: aw.x,
    anchorStartWY: aw.y,
    pointerId: ev.pointerId,
    handleEl: ev.currentTarget,
  };
  ev.currentTarget.addEventListener("pointermove", onHandlePointerMove);
  ev.currentTarget.addEventListener("pointerup", onHandlePointerUp);
  ev.currentTarget.addEventListener("pointercancel", onHandlePointerUp);
}
function onHandlePointerMove(ev) {
  if (!_resizeState || ev.pointerId !== _resizeState.pointerId) return;
  const obj = scene.get(_resizeState.id);
  if (!obj) return;
  const w = board.screenToWorld(ev.clientX, ev.clientY);
  const next = resizeRect(
    obj, _resizeState.anchor,
    w.x, w.y,
    _resizeState.anchorStartWX, _resizeState.anchorStartWY,
  );
  const patch = next;
  // viewport 边把手改了比例 → res 永远跟上
  if (obj.type === "viewport") {
    const tmp = { ...obj, ...next };
    const resPatch = syncViewportResToRect(tmp);
    if (resPatch) Object.assign(patch, resPatch);
  }
  scene.update(_resizeState.id, patch);
}
function onHandlePointerUp(ev) {
  if (!_resizeState) return;
  const h = _resizeState.handleEl;
  try { h.releasePointerCapture(ev.pointerId); } catch (_) {}
  h.removeEventListener("pointermove", onHandlePointerMove);
  h.removeEventListener("pointerup", onHandlePointerUp);
  h.removeEventListener("pointercancel", onHandlePointerUp);
  _resizeState = null;
  scene.endAct();
}

// ----- 旋转把手 -----
let _rotateState = null;
function onRotateHandlePointerDown(ev) {
  ev.preventDefault();
  ev.stopPropagation();
  const id = ev.currentTarget.dataset.id;
  const obj = scene.get(id);
  if (!obj) return;
  ev.currentTarget.setPointerCapture(ev.pointerId);
  scene.beginAct();
  _rotateState = { id, pointerId: ev.pointerId, handleEl: ev.currentTarget };
  ev.currentTarget.addEventListener("pointermove", onRotateHandlePointerMove);
  ev.currentTarget.addEventListener("pointerup", onRotateHandlePointerUp);
  ev.currentTarget.addEventListener("pointercancel", onRotateHandlePointerUp);
}
function onRotateHandlePointerMove(ev) {
  if (!_rotateState || ev.pointerId !== _rotateState.pointerId) return;
  const obj = scene.get(_rotateState.id);
  if (!obj) return;
  const w = board.screenToWorld(ev.clientX, ev.clientY);
  const cx = obj.x + obj.w / 2;
  const cy = obj.y + obj.h / 2;
  // local (0, -1) → world (sin r, -cos r)；反推 r = atan2(dx, -dy)
  let rDeg = Math.atan2(w.x - cx, -(w.y - cy)) * 180 / Math.PI;
  if (ev.shiftKey) rDeg = Math.round(rDeg / 15) * 15; // shift 吸附 15°
  // 归一化到 (-180, 180]
  while (rDeg > 180) rDeg -= 360;
  while (rDeg <= -180) rDeg += 360;
  scene.update(_rotateState.id, { rotation: rDeg });
}
function onRotateHandlePointerUp(ev) {
  if (!_rotateState) return;
  const h = _rotateState.handleEl;
  try { h.releasePointerCapture(ev.pointerId); } catch (_) {}
  h.removeEventListener("pointermove", onRotateHandlePointerMove);
  h.removeEventListener("pointerup", onRotateHandlePointerUp);
  h.removeEventListener("pointercancel", onRotateHandlePointerUp);
  _rotateState = null;
  scene.endAct();
}

window.addEventListener("resize", () => renderOverlay());

// ----- viewport 光栅化（按需，只在导出 / 复制剪贴板时跑） -----
// 输出 canvas = vp.resW × vp.resH（视口分辨率，不是画板分辨率）。
// 每张图用 createImageBitmap 从 Blob 现解码，确保拿到 *自然分辨率*
// 而不是浏览器缓存的「显示尺寸缩小版」。
async function rasterizeViewport(vp) {
  const canvas = document.createElement("canvas");
  canvas.width = vp.resW;
  canvas.height = vp.resH;
  const ctx = canvas.getContext("2d");
  ctx.imageSmoothingQuality = "high";
  ctx.clearRect(0, 0, canvas.width, canvas.height);
  const sx = vp.resW / vp.w;
  const sy = vp.resH / vp.h;
  const vpNearest = vp.interp === "nearest";
  // viewport 自身的旋转：每张图先反旋转回 viewport 自身坐标系，再画到输出 canvas
  const vpRotRad = (vp.rotation || 0) * Math.PI / 180;
  const vpCx = vp.x + vp.w / 2;
  const vpCy = vp.y + vp.h / 2;
  const cos = Math.cos(-vpRotRad), sin = Math.sin(-vpRotRad);
  // 用旋转 AABB 做相交粗过滤
  const vpAABB = rotatedAABB(vp);
  // 按 DOM 顺序（z-order 由低到高），底图先画
  for (const obj of scene.listImages()) {
    const aabb = rotatedAABB(obj);
    if (aabb.x1 < vpAABB.x0 || aabb.x0 > vpAABB.x1 ||
        aabb.y1 < vpAABB.y0 || aabb.y0 > vpAABB.y1) continue;
    if (!obj.blob) continue;
    let bitmap = null;
    try { bitmap = await createImageBitmap(obj.blob); }
    catch (e) { console.warn("decode failed", e); continue; }
    ctx.imageSmoothingEnabled = !(vpNearest || obj.interp === "nearest");
    // 图的中心相对 viewport 中心的 world 偏移
    const wdx = (obj.x + obj.w / 2) - vpCx;
    const wdy = (obj.y + obj.h / 2) - vpCy;
    // 反旋转到 viewport-local 帧（vp 没旋时 cos=1 sin=0 即 identity）
    const lx = wdx * cos - wdy * sin;
    const ly = wdx * sin + wdy * cos;
    // 输出像素中心位置 = 输出 canvas 中心 + lx/ly 缩到输出尺度
    const dxCenter = vp.resW / 2 + lx * sx;
    const dyCenter = vp.resH / 2 + ly * sy;
    // 图相对 viewport 的旋转
    const relRotRad = ((obj.rotation || 0) - (vp.rotation || 0)) * Math.PI / 180;
    const dw = obj.w * sx;
    const dh = obj.h * sy;
    ctx.save();
    ctx.translate(dxCenter, dyCenter);
    if (relRotRad) ctx.rotate(relRotRad);
    try { ctx.drawImage(bitmap, -dw / 2, -dh / 2, dw, dh); } catch (_) {}
    ctx.restore();
    bitmap.close();
  }
  return await new Promise((res) => canvas.toBlob(res, "image/png"));
}

function downloadBlob(blob, name) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = name;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

// ----- BTP 连接状态 pill -----
const btpPill = document.getElementById("btpPill");
const btpLabel = document.getElementById("btpLabel");
const btp = new BTPManager();
btp.onChange(() => {
  btpPill.dataset.state = btp.state;
  if (btp.state === "connected") {
    const fp = (btp.scene && btp.scene.blend_filepath) || "";
    const base = fp ? fp.split(/[\\/]/).pop() : "(未保存)";
    btpLabel.textContent = `Blender · ${base}`;
    btpPill.title = `已连接到 Blender（点击重新探活）\n${fp || "(未保存的 .blend)"}`;
  } else if (btp.state === "connecting") {
    btpLabel.textContent = "Blender · 探活中";
    btpPill.title = "正在探活…";
  } else if (btp.state === "disconnected") {
    btpLabel.textContent = "Blender · 未连接";
    btpPill.title = `Blender 不可达\n${btp.lastError ? (btp.lastError.message || btp.lastError) : ""}\n点击重试`;
  } else {
    btpLabel.textContent = "Blender";
  }
});
btpPill.addEventListener("click", () => btp.probe());
// 启动时探活一次（不要 await，让 UI 先出来）
btp.probe();

// ----- 版本号 -----
const versionLabel = document.getElementById("versionLabel");
versionLabel.textContent = window.ATLASMAKER_VERSION || "v?";

// ----- SW 更新提示（4 条检测路径，模式抄自 WebPaint/docs/pwa-update-detection.md） -----
const LOCAL_DEV_HOSTS = new Set(["localhost", "127.0.0.1", "::1", ""]);
let updateDismissed = false;
function showUpdate() {
  if (updateDismissed) return;
  document.getElementById("updateToast").classList.remove("hidden");
}
document.getElementById("updateReloadButton").addEventListener("click", () => {
  navigator.serviceWorker?.controller?.postMessage({ type: "skip-waiting" });
  location.reload();
});
document.getElementById("updateDismissButton").addEventListener("click", () => {
  updateDismissed = true;
  document.getElementById("updateToast").classList.add("hidden");
});

if ("serviceWorker" in navigator && !LOCAL_DEV_HOSTS.has(location.hostname)) {
  // 路径 3：SW 主动告知 asset 变了
  navigator.serviceWorker.addEventListener("message", (e) => {
    if (e.data?.type === "asset-updated") showUpdate();
  });
  window.addEventListener("load", async () => {
    let registration;
    try {
      registration = await navigator.serviceWorker.register("./service-worker.js");
    } catch (err) {
      console.warn("SW register failed", err);
      return;
    }
    // 路径 1：开机检查 waiting
    if (registration.waiting && navigator.serviceWorker.controller) showUpdate();
    // 路径 2：本 session 内装到新 SW
    registration.addEventListener("updatefound", () => {
      const nw = registration.installing;
      if (!nw) return;
      nw.addEventListener("statechange", () => {
        if (nw.state === "installed" && navigator.serviceWorker.controller) showUpdate();
      });
    });
    // 路径 4：主动 poke 浏览器 check SW
    const pokeUpdate = () => { registration.update().catch(() => {}); };
    document.addEventListener("visibilitychange", () => {
      if (document.visibilityState === "visible") pokeUpdate();
    });
    window.addEventListener("focus", pokeUpdate);
    setInterval(pokeUpdate, 10 * 60 * 1000);
  });
}

refreshHud();
renderOverlay();
setSaveStatus("saved");

// 启动时尝试从 IDB 恢复上次 session
loadCurrentScene().catch((e) => console.warn("初始加载失败", e));
