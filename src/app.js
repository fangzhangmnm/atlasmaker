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
  nextDefaultViewportBinding,
  HANDLE_ANCHORS,
} from "./objects.js";
import { Input } from "./input.js";
import { BTPManager, BTPError } from "./btp.js";
import * as storage from "./storage.js";
import { zipPack, zipUnpack } from "./zip.js";
import * as cloud from "./cloud.js";
import { sessionFileName } from "./config.js";

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

// 导入 / 导出（按钮已搬进汉堡菜单；这里只挂 file picker）
const importInput = document.getElementById("importFile");
importInput.addEventListener("change", () => {
  if (importInput.files && importInput.files[0]) {
    importSceneFromZipFile(importInput.files[0]);
    importInput.value = ""; // 允许选同名文件再次
  }
});

// ----- session 名 + 持久化（v11：atomic single-zip）-----
//
// 设计：一个 session = 一个 atlas zip，整包 atomic 写进 IDB（不再拆 scene/blobs）。
// 保存策略：用户主导（Ctrl+S）+ 3-min 兜底 + 关页面 visibility/pagehide 兜底。
// 不走 debounce/heartbeat/trivial-skip 那套（参 webxiaoheiwu sync-design）——
// AtlasMaker 用 Blender 习惯，频繁自动保存反而带来不稳定。
const sessionInput = document.getElementById("sessionName");
const saveStatusEl = document.getElementById("saveStatus");
const AUTO_SAVE_FALLBACK_MS = 3 * 60 * 1000;

let _dirty = false;
let _saving = false;
let _loading = false;

function applySessionTitle() {
  const name = sessionInput.value.trim() || "未命名";
  document.title = `${name} — AtlasMaker`;
}
sessionInput.addEventListener("input",  () => { applySessionTitle(); markDirty(); onSessionNameChanged(); });
sessionInput.addEventListener("change", () => { applySessionTitle(); markDirty(); onSessionNameChanged(); });
applySessionTitle();

function onSessionNameChanged() {
  // 名一变 → 新名的云端要么从未见过、要么和本地内容不匹配，都按 dirty 看
  if (cloud.isAuthConfigured() && cloud.isSignedIn()) {
    cloud.setCloudDirty(sessionInput.value, true);
  }
  if (typeof refreshCloudUI === "function") refreshCloudUI();
}

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

function markDirty() {
  if (_loading) return;
  if (!_dirty) {
    _dirty = true;
    setSaveStatus("dirty");
  }
}

// 把当前 scene 序列化成 scene.json 文档（无 Blob，只引用 src）
function makeSceneDoc(snap) {
  const objects = Array.from(snap.objects.values()).map((o) => {
    const { _displayUrl, blob, ...rest } = o;
    return rest;
  });
  return {
    format_version: SCENE_FORMAT_VERSION,
    name: sessionInput.value,
    updatedAt: Date.now(),
    board: { ...board.viewport },
    objects,
    imageOrder: snap.imageOrder,
    viewportOrder: snap.viewportOrder,
  };
}

// 把当前 board 可见区域光栅化成缩略图（thumb.png 进 zip）。
// 「web 视口」语义：你最后保存时看到的就是 thumb。
async function renderBoardThumb(maxSize = 512) {
  try {
    const r = boardEl.getBoundingClientRect();
    if (r.width < 4 || r.height < 4) return null;
    const aspect = r.width / r.height;
    const tw = aspect >= 1 ? maxSize : Math.round(maxSize * aspect);
    const th = aspect >= 1 ? Math.round(maxSize / aspect) : maxSize;
    const canvas = document.createElement("canvas");
    canvas.width = tw;
    canvas.height = th;
    const ctx = canvas.getContext("2d");
    const bg = getComputedStyle(boardEl).backgroundColor || "#e6e2d6";
    ctx.fillStyle = bg;
    ctx.fillRect(0, 0, tw, th);
    const sxThumb = tw / r.width;
    const syThumb = th / r.height;
    const wToThumb = (wx, wy) => {
      const s = board.worldToScreen(wx, wy);
      return { x: (s.x - r.left) * sxThumb, y: (s.y - r.top) * syThumb };
    };
    // images（按 z-order 顺序）
    for (const obj of scene.listImages()) {
      const tl = wToThumb(obj.x, obj.y);
      const br = wToThumb(obj.x + obj.w, obj.y + obj.h);
      const w_ = br.x - tl.x, h_ = br.y - tl.y;
      if (w_ < 0.5 || h_ < 0.5) continue;
      const node = scene.getNode(obj.id);
      const imgEl = node && node.querySelector("img");
      if (!imgEl || !imgEl.complete || !imgEl.naturalWidth) continue;
      ctx.imageSmoothingEnabled = obj.interp !== "nearest";
      if (obj.rotation) {
        const cx = (tl.x + br.x) / 2, cy = (tl.y + br.y) / 2;
        ctx.save();
        ctx.translate(cx, cy);
        ctx.rotate(obj.rotation * Math.PI / 180);
        try { ctx.drawImage(imgEl, -w_ / 2, -h_ / 2, w_, h_); } catch (_) {}
        ctx.restore();
      } else {
        try { ctx.drawImage(imgEl, tl.x, tl.y, w_, h_); } catch (_) {}
      }
    }
    // viewports（dashed frame + 淡 accent 底）
    ctx.lineWidth = 2;
    ctx.setLineDash([6, 4]);
    for (const obj of scene.listViewports()) {
      const tl = wToThumb(obj.x, obj.y);
      const br = wToThumb(obj.x + obj.w, obj.y + obj.h);
      const w_ = br.x - tl.x, h_ = br.y - tl.y;
      if (w_ < 1 || h_ < 1) continue;
      ctx.save();
      ctx.fillStyle = "rgba(138, 72, 30, 0.18)";
      ctx.strokeStyle = "#8a481e";
      if (obj.rotation) {
        const cx = (tl.x + br.x) / 2, cy = (tl.y + br.y) / 2;
        ctx.translate(cx, cy);
        ctx.rotate(obj.rotation * Math.PI / 180);
        ctx.fillRect(-w_ / 2, -h_ / 2, w_, h_);
        ctx.strokeRect(-w_ / 2, -h_ / 2, w_, h_);
      } else {
        ctx.fillRect(tl.x, tl.y, w_, h_);
        ctx.strokeRect(tl.x, tl.y, w_, h_);
      }
      ctx.restore();
    }
    return await new Promise((res) => canvas.toBlob(res, "image/png"));
  } catch (e) {
    console.warn("thumb render failed", e);
    return null;
  }
}

// 把当前 scene 打成 atlas zip：scene.json + images/<uuid>.<ext> + thumb.png
async function buildAtlasZip() {
  const snap = scene.snapshot();
  const doc = makeSceneDoc(snap);
  const entries = [{ path: "scene.json", data: JSON.stringify(doc, null, 2) }];
  for (const o of snap.objects.values()) {
    if (o.type === "image" && o.src && o.blob) {
      entries.push({ path: o.src, data: o.blob });
    }
  }
  let thumb = null;
  try { thumb = await renderBoardThumb(512); } catch (_) {}
  if (thumb) entries.push({ path: "thumb.png", data: thumb });
  const atlas = await zipPack(entries);
  return { atlas, thumb, doc };
}

// 当前 session 的 IDB key = "<sessionInput.value>.atlas.zip" / "characters/wall.atlas.zip" 之类。
// localStorage 跟踪上次打开的 path，刷新时回到那里。
const CURRENT_PATH_KEY = "atlasmaker.currentPath";
const DEFAULT_SESSION_NAME = "未命名";
function pathFromInput() { return sessionFileName(sessionInput.value || DEFAULT_SESSION_NAME); }
function getCurrentPath() {
  try { return localStorage.getItem(CURRENT_PATH_KEY) || sessionFileName(DEFAULT_SESSION_NAME); }
  catch (_) { return sessionFileName(DEFAULT_SESSION_NAME); }
}
function setCurrentPath(p) { try { localStorage.setItem(CURRENT_PATH_KEY, p); } catch (_) {} }

async function saveCurrentSession() {
  if (_saving) return;
  _saving = true;
  setSaveStatus("saving");
  try {
    const { atlas, thumb, doc } = await buildAtlasZip();
    const path = pathFromInput();
    await storage.putSession(path, {
      name: doc.name,
      updatedAt: doc.updatedAt,
      atlas,
      thumb,
    });
    setCurrentPath(path);
    _dirty = false;
    setSaveStatus("saved");
    // 本地 IDB 写完 → 云端关系到此变 dirty（如果登录中）
    if (cloud.isAuthConfigured() && cloud.isSignedIn()) {
      cloud.setCloudDirty(doc.name, true);
      refreshCloudUI();
    }
  } catch (e) {
    console.warn("save failed", e);
    setSaveStatus("error");
  } finally {
    _saving = false;
  }
}

// 从 zip 解出来的 atlas 恢复到 scene。被 IDB 启动加载和 import 共用。
async function applyAtlasZipBlob(atlasBlob) {
  const entries = await zipUnpack(atlasBlob);
  const sceneBytes = entries["scene.json"];
  if (!sceneBytes) throw new Error("ZIP 里没有 scene.json");
  const doc = JSON.parse(new TextDecoder().decode(sceneBytes));
  if (doc.format_version !== SCENE_FORMAT_VERSION) {
    console.warn("scene.json format_version", doc.format_version, "vs current", SCENE_FORMAT_VERSION);
  }
  const objects = (doc.objects || []).map((o) => {
    const obj = { ...o };
    if (obj.type === "image" && obj.src) {
      const bytes = entries[obj.src];
      if (bytes) {
        const ext = (obj.src.split(".").pop() || "png").toLowerCase();
        const mime = (ext === "jpg" || ext === "jpeg") ? "image/jpeg" : "image/png";
        obj.blob = new Blob([bytes], { type: mime });
      }
      obj._displayUrl = null;
    }
    return obj;
  });
  const objMap = new Map();
  for (const o of objects) objMap.set(o.id, o);
  scene.restore({
    objects: objMap,
    imageOrder: doc.imageOrder || [],
    viewportOrder: doc.viewportOrder || [],
    selection: new Set(),
  });
  scene._undoStack.length = 0;
  scene._redoStack.length = 0;
  if (doc.board) board.setViewport(doc.board.tx, doc.board.ty, doc.board.scale);
  if (typeof doc.name === "string") { sessionInput.value = doc.name; applySessionTitle(); }
  return doc;
}

async function loadCurrentSession() {
  // 先迁移老 "current" 键（如果存在）—— 一次性
  try {
    const legacy = await storage.getSession("current");
    if (legacy && legacy.atlas) {
      const targetPath = sessionFileName(legacy.name || DEFAULT_SESSION_NAME);
      await storage.putSession(targetPath, legacy);
      await storage.deleteSession("current");
      setCurrentPath(targetPath);
    }
  } catch (_) {}
  const path = getCurrentPath();
  const pkg = await storage.getSession(path);
  if (!pkg || !pkg.atlas) return false;
  _loading = true;
  try {
    await applyAtlasZipBlob(pkg.atlas);
    _dirty = false;
    setSaveStatus("saved");
    return true;
  } finally {
    _loading = false;
  }
}

// 切到指定 path 的 session（保存当前 → 加载新）
async function openSessionByPath(path) {
  if (_dirty && !_saving) await saveCurrentSession();
  const pkg = await storage.getSession(path);
  if (!pkg) { showActionToast(`找不到：${path}`, 4000); return; }
  _loading = true;
  try {
    await applyAtlasZipBlob(pkg.atlas);
    const stem = path.replace(/\.atlas\.zip$/i, "");
    sessionInput.value = stem;
    applySessionTitle();
  } finally { _loading = false; }
  setCurrentPath(path);
  _dirty = false;
  setSaveStatus("saved");
  refreshCloudUI();
}

// 新建空白 session 并切过去
async function newBlankSession(path) {
  if (_dirty && !_saving) await saveCurrentSession();
  _loading = true;
  try {
    scene.restore({ objects: new Map(), imageOrder: [], viewportOrder: [], selection: new Set() });
    scene._undoStack.length = 0;
    scene._redoStack.length = 0;
    const r = boardEl.getBoundingClientRect();
    board.setViewport(r.width / 2, r.height / 2, 1);
    const stem = path.replace(/\.atlas\.zip$/i, "");
    sessionInput.value = stem;
    applySessionTitle();
  } finally { _loading = false; }
  setCurrentPath(path);
  _dirty = true; // 立刻写一次让它出现在列表里
  await saveCurrentSession();
  refreshCloudUI();
}

async function exportCurrentSceneAsZip() {
  try {
    const { atlas, doc } = await buildAtlasZip();
    const safeName = (sessionInput.value || "atlas").replace(/[\\/:*?"<>|]+/g, "_").trim() || "atlas";
    downloadBlob(atlas, `${safeName}.atlas.zip`);
    const n = (doc.objects || []).filter((o) => o.type === "image").length;
    showActionToast(`已导出（${n} 张图）`);
  } catch (e) {
    showActionToast(`导出失败：${e.message || e}`, 4000);
  }
}

async function importSceneFromZipFile(file) {
  _loading = true;
  try {
    const doc = await applyAtlasZipBlob(file);
    _loading = false;
    // 立刻 atomic 写一次 IDB（让导入立刻持久化，避免 refresh 又丢）
    await saveCurrentSession();
    const n = (doc.objects || []).filter((o) => o.type === "image").length;
    showActionToast(`已导入：${doc.name || "未命名"}（${n} 张图）`);
  } catch (e) {
    _loading = false;
    showActionToast(`导入失败：${e.message || e}`, 5000);
  }
}

// ----- 钩子：变 → 标 dirty。不立即写。 -----
board.onChange(() => markDirty());
scene.onChange(() => markDirty());

// 3-min 兜底（dirty 才写）—— 用户主要 Ctrl+S，这层是安全网
setInterval(() => {
  if (_dirty && !_saving && !_loading) saveCurrentSession().catch(() => {});
}, AUTO_SAVE_FALLBACK_MS);

// 关页面前抢救（visibilitychange / pagehide）
document.addEventListener("visibilitychange", () => {
  if (document.visibilityState === "hidden" && _dirty && !_saving) {
    saveCurrentSession().catch(() => {});
  }
});
window.addEventListener("pagehide", () => {
  if (_dirty && !_saving) saveCurrentSession().catch(() => {});
});

// ----- 主题 + 汉堡菜单 -----
const THEMES = ["auto", "day", "night"];
const THEME_LABELS = { auto: "自动", day: "日", night: "夜" };

function cycleTheme() {
  const cur = document.documentElement.getAttribute("data-theme") || "auto";
  const next = THEMES[(THEMES.indexOf(cur) + 1) % THEMES.length];
  document.documentElement.setAttribute("data-theme", next);
  try { localStorage.setItem("atlasmaker.theme", next); } catch (_) {}
  updateThemeMenuLabel();
}
function updateThemeMenuLabel() {
  const cur = document.documentElement.getAttribute("data-theme") || "auto";
  const lbl = document.getElementById("menuThemeLabel");
  if (lbl) lbl.textContent = `主题：${THEME_LABELS[cur] || cur}`;
}
updateThemeMenuLabel();

const hamburgerBtn = document.getElementById("hamburgerBtn");
const hamburgerMenu = document.getElementById("hamburgerMenu");
function openHamburger() {
  const r = hamburgerBtn.getBoundingClientRect();
  hamburgerMenu.style.top = `${r.bottom + 6}px`;
  hamburgerMenu.style.right = `${Math.max(8, window.innerWidth - r.right)}px`;
  hamburgerMenu.classList.remove("hidden");
  hamburgerBtn.setAttribute("aria-expanded", "true");
}
function closeHamburger() {
  hamburgerMenu.classList.add("hidden");
  hamburgerBtn.setAttribute("aria-expanded", "false");
}
hamburgerBtn.addEventListener("click", (e) => {
  e.stopPropagation();
  if (hamburgerMenu.classList.contains("hidden")) openHamburger();
  else closeHamburger();
});
document.addEventListener("click", (e) => {
  if (hamburgerMenu.classList.contains("hidden")) return;
  if (hamburgerMenu.contains(e.target) || hamburgerBtn.contains(e.target)) return;
  closeHamburger();
});
document.addEventListener("keydown", (e) => {
  if (e.key === "Escape" && !hamburgerMenu.classList.contains("hidden")) closeHamburger();
});
window.addEventListener("resize", () => { if (!hamburgerMenu.classList.contains("hidden")) openHamburger(); });

// 菜单项 → 动作
document.getElementById("menuTheme").addEventListener("click", () => { cycleTheme(); });
document.getElementById("menuImport").addEventListener("click", () => { closeHamburger(); importInput.click(); });
document.getElementById("menuExport").addEventListener("click", () => { closeHamburger(); exportCurrentSceneAsZip(); });

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
const imgLock = document.getElementById("imgLock");
const imgInterp = document.getElementById("imgInterp");
const imgDeleteBtn = document.getElementById("imgDelete");

function formatBytes(n) {
  if (!Number.isFinite(n)) return "—";
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / 1024 / 1024).toFixed(2)} MB`;
}

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
    // 显示原图分辨率 + blob 字节 —— 让用户能看出哪张是 4K 大块头白浪费内存
    const sizeStr = sel.blob ? formatBytes(sel.blob.size) : "—";
    imgNaturalLabel.textContent = `${sel.naturalW}×${sel.naturalH} · ${sizeStr}`;
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
    // markDirty 由 scene.onChange 自动触发；不在这里再调一次
  },
  onViewportFinish: ({ x, y, w, h }) => {
    scene.act(() => {
      const binding = nextDefaultViewportBinding(scene);
      const obj = makeViewportObject({ x, y, w, h, binding });
      scene.add(obj);
      scene.select(obj.id, false);
    });
  },
  hooks: {
    onFit: doFit,
    onSave: () => saveCurrentSession(),
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

// ----- OneDrive 同步 -----
const cloudPill = document.getElementById("cloudPill");
const cloudLabel = document.getElementById("cloudLabel");
const cloudPushBtn = document.getElementById("cloudPushBtn");
const cloudPullBtn = document.getElementById("cloudPullBtn");

function refreshCloudUI() {
  const signedIn = cloud.isSignedIn();
  cloudPushBtn.disabled = !signedIn;
  cloudPullBtn.disabled = !signedIn;
  // 云端待推：登录中 + 本地比云端新 → push 按钮闪小点（独立于本地保存状态）
  const dirty = signedIn && cloud.isCloudDirty(sessionInput.value);
  cloudPushBtn.classList.toggle("cloud-dirty", dirty);
  if (dirty) cloudPushBtn.title = "推到 OneDrive（本地有未推送的修改）";
  else cloudPushBtn.title = "推到 OneDrive（覆盖云端）";
  if (!cloud.isAuthConfigured()) {
    cloudPill.dataset.state = "disconnected";
    cloudLabel.textContent = "OneDrive 未配置";
    cloudPill.title = "需要在 src/config.js 填 CLIENT_ID（Azure App Registration）";
    return;
  }
  if (signedIn) {
    const acc = cloud.getActiveAccount();
    const tag = (acc?.username || acc?.name || "已登录").replace(/@.*/, "");
    cloudPill.dataset.state = "connected";
    cloudLabel.textContent = `OneDrive · ${tag}`;
    cloudPill.title = `已登录：${acc?.username || ""}\n点击注销`;
  } else {
    cloudPill.dataset.state = "disconnected";
    cloudLabel.textContent = "OneDrive";
    cloudPill.title = "点击登录 OneDrive";
  }
}

cloudPill.addEventListener("click", async () => {
  if (!cloud.isAuthConfigured()) {
    showActionToast("未配置 OneDrive — 先在 src/config.js 填 CLIENT_ID", 5000);
    return;
  }
  if (cloud.isSignedIn()) {
    if (!confirm("注销 OneDrive？本地数据保留。")) return;
    await cloud.signOut();
    refreshCloudUI();
    showActionToast("已注销 OneDrive");
  } else {
    cloudPill.dataset.state = "connecting";
    cloudLabel.textContent = "OneDrive · 登录中";
    try { await cloud.signIn(); /* 跳转登录 */ }
    catch (e) {
      refreshCloudUI();
      showActionToast(`登录失败：${e.message}`, 4000);
    }
  }
});

cloudPushBtn.addEventListener("click", async () => {
  if (!cloud.isSignedIn()) return;
  cloudPushBtn.disabled = true;
  showActionToast("推到 OneDrive…", 60000);
  try {
    // 先确保 IDB 与即将推送的 zip 一致
    await saveCurrentSession();
    const { atlas } = await buildAtlasZip();
    const name = sessionInput.value || "atlas";
    const result = await cloud.pushAtlas(name, atlas, {
      onConflict: (sib) => showActionToast(`云端有新版，你的本地已另存为 ${sib}`, 8000),
    });
    if (result.action === "uploaded") {
      showActionToast(`已推到 OneDrive：${name}.atlas.zip`);
    } else if (result.action === "sibling-copy") {
      // 远端冲突 → 用户的本地保留在 sibling，但*主*文件仍是远端版本，需要 pull
      if (confirm(`OneDrive 上 ${name}.atlas.zip 比本地新。\n你的本地已另存为 ${result.siblingName}。\n现在拉远端版本到本地？`)) {
        await pullFromCloud();
      }
    }
    refreshCloudUI();
  } catch (e) {
    showActionToast(`推送失败：${e.message || e}`, 5000);
  } finally {
    cloudPushBtn.disabled = !cloud.isSignedIn();
  }
});

async function pullFromCloud() {
  if (!cloud.isSignedIn()) return;
  cloudPullBtn.disabled = true;
  showActionToast("从 OneDrive 拉…", 60000);
  try {
    const name = sessionInput.value || "atlas";
    const result = await cloud.pullAtlas(name);
    if (!result) {
      showActionToast(`OneDrive 上没有 ${name}.atlas.zip`, 5000);
      return;
    }
    _loading = true;
    try { await applyAtlasZipBlob(result.blob); }
    finally { _loading = false; }
    await saveCurrentSession();
    // pull 之后 local == cloud；saveCurrentSession 设了 dirty=true，这里 override 回 false
    cloud.setCloudDirty(sessionInput.value, false);
    refreshCloudUI();
    showActionToast(`已从 OneDrive 拉回：${result.item.name}`);
  } catch (e) {
    _loading = false;
    showActionToast(`拉取失败：${e.message || e}`, 5000);
  } finally {
    cloudPullBtn.disabled = !cloud.isSignedIn();
  }
}

cloudPullBtn.addEventListener("click", async () => {
  if (!cloud.isSignedIn()) return;
  if (_dirty) {
    if (!confirm("本地有未保存修改，从 OneDrive 拉会覆盖。继续？")) return;
  }
  await pullFromCloud();
});

// 启动时尝试 MSAL init + 处理可能的 redirect 回调
cloud.initAuth().then(() => refreshCloudUI()).catch((e) => {
  console.warn("OneDrive 初始化失败:", e);
  refreshCloudUI();
});
refreshCloudUI();

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
// 不在启动时自动 probe —— 那会触发浏览器的 PNA 提示（"访问设备上其他应用"），
// 还没让用户决定要不要连 Blender 就弹出，体验差。
// 改为 lazy：用户点 Blender pill / 推到 Blender 按钮时才发起连接。

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
loadCurrentSession().catch((e) => console.warn("初始加载失败", e));

// ----- 会话浏览模态 -----
const sessionsBackdrop = document.getElementById("sessionsBackdrop");
const sessionsModal = document.getElementById("sessionsModal");
const sessionsList = document.getElementById("sessionsList");

async function refreshSessionsList() {
  sessionsList.innerHTML = "";
  let keys = [];
  try { keys = await storage.listSessionIds(); } catch (e) { console.warn("list sessions failed", e); }
  keys = keys.filter((k) => typeof k === "string" && k.endsWith(".atlas.zip"));
  keys.sort((a, b) => a.localeCompare(b));
  const cur = getCurrentPath();
  for (const key of keys) {
    let pkg = null;
    try { pkg = await storage.getSession(key); } catch (_) {}
    if (!pkg) continue;
    const row = document.createElement("div");
    row.className = "session-row";
    if (key === cur) row.dataset.current = "true";

    const thumb = document.createElement("div");
    thumb.className = "thumb";
    if (pkg.thumb) {
      const url = URL.createObjectURL(pkg.thumb);
      thumb.style.backgroundImage = `url(${url})`;
      // 不 revoke：模态关闭后整个 list 被 innerHTML 清掉，浏览器自然回收
    }
    row.appendChild(thumb);

    const body = document.createElement("div");
    body.className = "body";
    const pathEl = document.createElement("div");
    pathEl.className = "path";
    pathEl.textContent = key.replace(/\.atlas\.zip$/i, "");
    body.appendChild(pathEl);
    const meta = document.createElement("div");
    meta.className = "meta";
    const t = pkg.updatedAt ? new Date(pkg.updatedAt).toLocaleString() : "—";
    const sizeStr = pkg.atlas ? formatBytes(pkg.atlas.size) : "—";
    meta.textContent = key === cur ? `当前 · ${t} · ${sizeStr}` : `${t} · ${sizeStr}`;
    body.appendChild(meta);
    row.appendChild(body);

    const actions = document.createElement("div");
    actions.className = "actions";
    if (key !== cur) {
      const openBtn = document.createElement("button");
      openBtn.textContent = "打开";
      openBtn.addEventListener("click", async (e) => {
        e.stopPropagation();
        await openSessionByPath(key);
        closeSessionsModal();
      });
      actions.appendChild(openBtn);
    }
    const delBtn = document.createElement("button");
    delBtn.className = "danger";
    delBtn.textContent = "删除";
    delBtn.addEventListener("click", async (e) => {
      e.stopPropagation();
      if (!confirm(`删除 ${key}？无法撤销。`)) return;
      try { await storage.deleteSession(key); } catch (err) { showActionToast(`删除失败：${err.message || err}`); return; }
      if (key === getCurrentPath()) {
        await newBlankSession(sessionFileName(DEFAULT_SESSION_NAME));
      }
      await refreshSessionsList();
    });
    actions.appendChild(delBtn);
    row.appendChild(actions);

    row.addEventListener("dblclick", async () => {
      if (key !== getCurrentPath()) { await openSessionByPath(key); closeSessionsModal(); }
    });
    sessionsList.appendChild(row);
  }
}

async function openSessionsModal() {
  // 打开前 flush 一下，让当前 session 出现在列表里且 thumb 最新
  if (_dirty && !_saving) await saveCurrentSession();
  await refreshSessionsList();
  sessionsModal.classList.remove("hidden");
  sessionsBackdrop.classList.remove("hidden");
}
function closeSessionsModal() {
  sessionsModal.classList.add("hidden");
  sessionsBackdrop.classList.add("hidden");
}

document.getElementById("sessionsButton").addEventListener("click", () => openSessionsModal());
document.getElementById("sessionsCloseBtn").addEventListener("click", closeSessionsModal);
document.getElementById("sessionsRefreshBtn").addEventListener("click", refreshSessionsList);
sessionsBackdrop.addEventListener("click", closeSessionsModal);
document.getElementById("sessionsNewBtn").addEventListener("click", async () => {
  const name = prompt("新会话路径（可带 / 组织到子文件夹，如 characters/wall）", "未命名");
  if (!name) return;
  const path = sessionFileName(name);
  const existing = await storage.getSession(path);
  if (existing) {
    if (!confirm(`${path} 已存在。覆盖（先打开它再清空）？`)) return;
    await openSessionByPath(path);
    closeSessionsModal();
    return;
  }
  await newBlankSession(path);
  await refreshSessionsList();
});
