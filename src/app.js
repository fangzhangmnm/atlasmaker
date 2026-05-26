// AtlasMaker — 一期：无限工作台 + 粘贴图片 + viewport 框。
// 没有持久化、没有 OneDrive，刷新会丢。两个一期之后从兄弟项目抄。

import { Board } from "./board.js";
import {
  Scene,
  makeImageObject,
  makeViewportObject,
  resizeRect,
  syncViewportResToRect,
  HANDLE_ANCHORS,
} from "./objects.js";
import { Input } from "./input.js";

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
const vpAspectLock = document.getElementById("vpAspectLock");
const vpExportBtn = document.getElementById("vpExport");
const vpCopyBtn = document.getElementById("vpCopy");
const vpDeleteBtn = document.getElementById("vpDelete");

// ----- 图片属性浮窗 -----
const imgPanel = document.getElementById("imagePanel");
const imgNaturalLabel = document.getElementById("imgNaturalLabel");
const imgRectLabel = document.getElementById("imgRectLabel");
const imgAspectLock = document.getElementById("imgAspectLock");
const imgInterp = document.getElementById("imgInterp");
const imgDeleteBtn = document.getElementById("imgDelete");

document.getElementById("viewportPanelClose").addEventListener("click", () => {
  scene.clearSelection();
});
document.getElementById("imagePanelClose").addEventListener("click", () => {
  scene.clearSelection();
});

function refreshPanels() {
  const sel = scene.firstSelected();
  if (sel && sel.type === "viewport") {
    vpPanel.classList.remove("hidden");
    imgPanel.classList.add("hidden");
    vpResW.value = sel.resW;
    vpResH.value = sel.resH;
    vpInterp.value = sel.interp || "linear";
    vpBinding.value = sel.binding || "";
    vpAspectLock.setAttribute("aria-pressed", sel.aspectLocked ? "true" : "false");
    vpAspectLock.textContent = sel.aspectLocked ? "🔒" : "🔓";
  } else if (sel && sel.type === "image") {
    imgPanel.classList.remove("hidden");
    vpPanel.classList.add("hidden");
    imgNaturalLabel.textContent = `${sel.naturalW}×${sel.naturalH}`;
    imgRectLabel.textContent = `${sel.w}×${sel.h}`;
    imgAspectLock.setAttribute("aria-pressed", sel.aspectLocked ? "true" : "false");
    imgAspectLock.textContent = sel.aspectLocked ? "🔒" : "🔓";
    imgInterp.value = sel.interp || "linear";
  } else {
    vpPanel.classList.add("hidden");
    imgPanel.classList.add("hidden");
  }
}

function patchSelectedViewport(patch) {
  const sel = scene.firstSelected();
  if (!sel || sel.type !== "viewport") return;
  scene.update(sel.id, patch);
}

function onResChange(field) {
  const sel = scene.firstSelected();
  if (!sel || sel.type !== "viewport") return;
  let newResW = field === "w" ? clampInt(vpResW.value, 1, 8192) : sel.resW;
  let newResH = field === "h" ? clampInt(vpResH.value, 1, 8192) : sel.resH;
  if (sel.aspectLocked && sel.w > 0 && sel.h > 0) {
    // 锁定：res 比例 = rect 比例。改谁，另一个 res 跟（不动 rect）。
    const rectAspect = sel.w / sel.h;
    if (field === "w") newResH = Math.max(1, Math.round(newResW / rectAspect));
    else newResW = Math.max(1, Math.round(newResH * rectAspect));
  }
  scene.update(sel.id, { resW: newResW, resH: newResH });
}
vpResW.addEventListener("change", () => onResChange("w"));
vpResH.addEventListener("change", () => onResChange("h"));
vpInterp.addEventListener("change", () => patchSelectedViewport({ interp: vpInterp.value }));

vpAspectLock.addEventListener("click", () => {
  const sel = scene.firstSelected();
  if (!sel || sel.type !== "viewport") return;
  const next = !sel.aspectLocked;
  const patch = { aspectLocked: next };
  if (next) {
    // 刚锁上 —— 把 res 拉到 rect 比例（rect 是用户手感的主导）
    const resPatch = syncViewportResToRect({ ...sel, aspectLocked: true });
    if (resPatch) Object.assign(patch, resPatch);
  }
  scene.update(sel.id, patch);
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
  if (sel) scene.remove(sel.id);
});

// ----- 图片浮窗 wiring -----
imgAspectLock.addEventListener("click", () => {
  const sel = scene.firstSelected();
  if (!sel || sel.type !== "image") return;
  scene.update(sel.id, { aspectLocked: !sel.aspectLocked });
});
imgInterp.addEventListener("change", () => {
  const sel = scene.firstSelected();
  if (!sel || sel.type !== "image") return;
  scene.update(sel.id, { interp: imgInterp.value });
});
imgDeleteBtn.addEventListener("click", () => {
  const sel = scene.firstSelected();
  if (sel) scene.remove(sel.id);
});

// ----- z-order 按钮（两个 panel 共用一套 handler） -----
function wireZBtn(btnId, fn) {
  const btn = document.getElementById(btnId);
  if (!btn) return;
  btn.addEventListener("click", () => {
    const sel = scene.firstSelected();
    if (sel) fn(sel.id);
  });
}
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
    const obj = makeImageObject({ blob, naturalW, naturalH, x, y, targetLongWorld });
    scene.add(obj);
    scene.select(obj.id, false);
  },
  onViewportFinish: ({ x, y, w, h }) => {
    const obj = makeViewportObject({ x, y, w, h });
    scene.add(obj);
    scene.select(obj.id, false);
  },
  hooks: {
    onFit: doFit,
    onDelete: () => {
      for (const id of Array.from(scene.selection)) scene.remove(id);
    },
    onDuplicate: () => {
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
    },
  },
});
input.setTool("select");

// ----- Overlay：选框 + 8 把手（屏幕 px，不跟 #world 缩放） -----
// 拖拽中不能 innerHTML 清空 —— 否则把手 DOM 被销毁，pointerCapture 丢，drag 中断。
// 所以：选区集没变 → 只更新位置；变了 → 重建。
let _renderedSelSig = "";
function renderOverlay() {
  const sig = Array.from(scene.selection).join(",");
  const rebuild = sig !== _renderedSelSig;
  if (rebuild) {
    overlayEl.innerHTML = "";
    _renderedSelSig = sig;
  }
  const br = boardEl.getBoundingClientRect();
  for (const id of scene.selection) {
    const obj = scene.get(id);
    if (!obj) continue;
    let rectEl;
    const handles = {};
    if (rebuild) {
      rectEl = document.createElement("div");
      rectEl.className = "overlay-rect";
      rectEl.dataset.id = id;
      overlayEl.appendChild(rectEl);
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
    } else {
      rectEl = overlayEl.querySelector(`.overlay-rect[data-id="${id}"]`);
      for (const a of HANDLE_ANCHORS) {
        handles[a] = overlayEl.querySelector(`.overlay-handle[data-id="${id}"][data-anchor="${a}"]`);
      }
    }
    const aPt = board.worldToScreen(obj.x, obj.y);
    const bPt = board.worldToScreen(obj.x + obj.w, obj.y + obj.h);
    const L = aPt.x - br.left, T = aPt.y - br.top;
    const R = bPt.x - br.left, B = bPt.y - br.top;
    if (rectEl) {
      rectEl.style.left = `${L}px`;
      rectEl.style.top = `${T}px`;
      rectEl.style.width = `${R - L}px`;
      rectEl.style.height = `${B - T}px`;
    }
    const mx = (L + R) / 2, my = (T + B) / 2;
    const pos = {
      nw: [L, T], n: [mx, T], ne: [R, T],
      w:  [L, my],            e:  [R, my],
      sw: [L, B], s: [mx, B], se: [R, B],
    };
    for (const a of HANDLE_ANCHORS) {
      const h = handles[a];
      if (!h) continue;
      h.style.left = `${pos[a][0]}px`;
      h.style.top = `${pos[a][1]}px`;
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
  _resizeState = { id, anchor, pointerId: ev.pointerId, handleEl: ev.currentTarget };
  ev.currentTarget.addEventListener("pointermove", onHandlePointerMove);
  ev.currentTarget.addEventListener("pointerup", onHandlePointerUp);
  ev.currentTarget.addEventListener("pointercancel", onHandlePointerUp);
}
function onHandlePointerMove(ev) {
  if (!_resizeState || ev.pointerId !== _resizeState.pointerId) return;
  const obj = scene.get(_resizeState.id);
  if (!obj) return;
  const w = board.screenToWorld(ev.clientX, ev.clientY);
  const next = resizeRect(obj, _resizeState.anchor, w.x, w.y);
  const patch = next;
  // viewport aspectLocked + 边把手改了比例 → res 跟上
  if (obj.type === "viewport" && obj.aspectLocked) {
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
  // 按 DOM 顺序（z-order 由低到高），底图先画
  for (const obj of scene.listImages()) {
    if (obj.x + obj.w < vp.x || obj.x > vp.x + vp.w ||
        obj.y + obj.h < vp.y || obj.y > vp.y + vp.h) continue;
    if (!obj.blob) continue;
    let bitmap = null;
    try { bitmap = await createImageBitmap(obj.blob); }
    catch (e) { console.warn("decode failed", e); continue; }
    // viewport 或 image 任一标 nearest → 这次 draw 关 smoothing
    ctx.imageSmoothingEnabled = !(vpNearest || obj.interp === "nearest");
    const dx = (obj.x - vp.x) * sx;
    const dy = (obj.y - vp.y) * sy;
    const dw = obj.w * sx;
    const dh = obj.h * sy;
    try { ctx.drawImage(bitmap, dx, dy, dw, dh); } catch (_) {}
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
