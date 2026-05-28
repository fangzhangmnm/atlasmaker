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
import { zipPack, zipUnpack, zipPackEncrypted, zipUnpackEncrypted, detectAtlasFormat } from "./zip.js";
import * as cloud from "./cloud.js";
import { sessionFileName } from "./config.js";
import { rasterizeImage } from "./raster.js";
import * as crop from "./crop.js";
import { filtersToCssString } from "./filters.js";
import { applyChromaKey, applyChromaToImageData, sampleTopLeftPixel } from "./chromakey.js";
import {
  applyLevels, applyCurves, buildCurveLut, applyColorBalance,
  bakeImageWithCanvasFilter, buildPreviewSource,
} from "./canvas-filters.js";
import { bakePerspective, estimateOutputSize } from "./perspective.js";
import { makeSwatchBlob, samplePixel, worldToNaturalPx, colorToHex, hexToColor } from "./swatch.js";

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
const sizeLabel = document.getElementById("sizeLabel");
const statusLabel = document.getElementById("statusLabel");

function refreshHud() {
  zoomLabel.textContent = `${Math.round(board.viewport.scale * 100)}%`;
  const n = scene.count();
  countLabel.textContent = `${n} item${n === 1 ? "" : "s"}`;
  // 估算 atlas 大小 = Σ image.blob.size。PNG/JPEG 已压缩，zip wrap 开销忽略。
  // thumb.png + scene.json 加起来通常 < 100KB，对几 MB 量级的图集来说零头。
  let totalBytes = 0;
  for (const o of scene.objects.values()) {
    if (o.type === "image" && o.blob) totalBytes += o.blob.size;
  }
  sizeLabel.textContent = formatBytes(totalBytes);
  if (n === 0) {
    statusLabel.textContent = "Empty board — Ctrl+V to paste an image";
  } else {
    const sel = scene.firstSelected();
    if (sel) {
      if (sel.type === "image") {
        statusLabel.textContent = `Image ${sel.naturalW}×${sel.naturalH} (rect ${sel.w}×${sel.h})`;
      } else if (sel.type === "viewport") {
        statusLabel.textContent = `Viewport rect ${sel.w}×${sel.h} → output ${sel.resW}×${sel.resH}`;
      }
    } else {
      statusLabel.textContent = "Drag / select an object";
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
  eyedropper: document.getElementById("toolEyedropper"),
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
document.getElementById("pasteButton").addEventListener("click", () => smartPasteFromClipboard());
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
const AUTO_SAVE_FALLBACK_MS = 3 * 60 * 1000;

let _dirty = false;
let _saving = false;
let _loading = false;
let _cloudPushing = false; // cloud push 在跑（独立 _saving，因为云推是 save 后期；冷启 / 单纯 push 也会动）

function applySessionTitle() {
  // 标题永远是固定的 "AtlasMaker"。理由：
  // - 浏览器历史会按 title 给条目去重显示；放 session 名会产生「点了之后跳不到正确文件」的重复
  // - session 名是潜在敏感信息（路径里可能有内容线索），不应漏进 history / 任务管理器 / 标签预览
  document.title = "AtlasMaker";
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

// === Save 按钮多态 ===
// 状态：cloud-busy / saving / dirty / cloud-dirty / synced / local-only / error
// 永远点 = saveCurrentSession({explicit:true})（同 Ctrl+S）。saving / cloud-busy disabled。
// 替代之前的 saveStatus pill。
const _stroke = 'fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"';
const ICON_DISK = `<svg viewBox="0 0 24 24" ${_stroke} aria-hidden="true"><path d="M19 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h11l5 5v11a2 2 0 0 1-2 2z"/><polyline points="17 21 17 13 7 13 7 21"/><polyline points="7 3 7 8 15 8"/></svg>`;
const ICON_DISK_DIRTY = `<svg viewBox="0 0 24 24" ${_stroke} aria-hidden="true"><path d="M19 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h11l5 5v11a2 2 0 0 1-2 2z"/><polyline points="17 21 17 13 7 13 7 21"/><polyline points="7 3 7 8 15 8"/><circle cx="19" cy="6" r="3" fill="currentColor" stroke="none"/></svg>`;
const ICON_CLOUD_UPLOAD = `<svg viewBox="0 0 24 24" ${_stroke} aria-hidden="true"><path d="M18 10h-1.3A8 8 0 1 0 9 20h9a5 5 0 0 0 0-10z"/><polyline points="8 13 12 9 16 13"/><line x1="12" y1="9" x2="12" y2="17"/></svg>`;
const ICON_CLOUD_BUSY = `<svg viewBox="0 0 24 24" ${_stroke} aria-hidden="true"><path d="M18 10h-1.3A8 8 0 1 0 9 20h9a5 5 0 0 0 0-10z"/><g class="spin-arc" style="transform-origin: 12px 14px"><path d="M9 14a3 3 0 0 1 5.5-1.6"/><polyline points="14.5 11.4 14.5 13.4 12.6 13.4"/></g></svg>`;
const ICON_CLOUD_CHECK = `<svg viewBox="0 0 24 24" ${_stroke} aria-hidden="true"><path d="M18 10h-1.3A8 8 0 1 0 9 20h9a5 5 0 0 0 0-10z"/><polyline points="9 13 11 15 15 11"/></svg>`;
const ICON_LOCK_BADGE = ' (encrypted)';
const ICON_LOCK_OPEN = `<svg viewBox="0 0 24 24" ${_stroke} aria-hidden="true"><rect x="5" y="11" width="14" height="10" rx="2"/><path d="M8 11V7a4 4 0 0 1 7.7-1.5"/></svg>`;
const ICON_LOCK_CLOSED = `<svg viewBox="0 0 24 24" ${_stroke} aria-hidden="true"><rect x="5" y="11" width="14" height="10" rx="2"/><path d="M8 11V7a4 4 0 0 1 8 0v4"/></svg>`;
const ICON_FOLDER = `<svg viewBox="0 0 24 24" ${_stroke} aria-hidden="true"><path d="M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v9a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V7z"/></svg>`;
const ICON_CLOUD_ONLY = `<svg viewBox="0 0 24 24" ${_stroke} aria-hidden="true"><path d="M18 10h-1.3A8 8 0 1 0 9 20h9a5 5 0 0 0 0-10z"/></svg>`;
const ICON_LOCK_THUMB = `<svg viewBox="0 0 24 24" ${_stroke} aria-hidden="true"><rect x="6" y="11" width="12" height="9" rx="2"/><path d="M9 11V7a3 3 0 0 1 6 0v4"/></svg>`;

let _lastSaveError = null;
function computeSaveState() {
  if (_cloudPushing) return "cloud-busy";
  if (_saving) return "saving";
  if (_lastSaveError) return "error";
  if (_dirty) return "dirty";
  const signed = cloud.isAuthConfigured && cloud.isAuthConfigured() && cloud.isSignedIn && cloud.isSignedIn();
  if (signed && cloud.isCloudDirty(sessionInput.value)) return "cloud-dirty";
  if (signed) return "synced";
  return "local-only";
}

const cloudPushBtn = document.getElementById("cloudPushBtn");
function updateSaveBtnState() {
  if (!cloudPushBtn) return;
  const state = computeSaveState();
  cloudPushBtn.dataset.state = state;
  const name = sessionInput.value || "Untitled";
  const enc = _currentEncrypted ? ICON_LOCK_BADGE : "";
  let html, title, disabled;
  switch (state) {
    case "cloud-busy":
      html = ICON_CLOUD_BUSY;
      title = `Saving to cloud… · ${name}${enc}`;
      disabled = true;
      break;
    case "saving":
      html = ICON_DISK;
      title = `Saving… · ${name}${enc}`;
      disabled = true;
      break;
    case "error":
      html = ICON_DISK_DIRTY;
      title = `Save failed — click to retry · ${name}${enc}`;
      disabled = false;
      break;
    case "dirty":
      html = ICON_DISK_DIRTY;
      title = `Save (Ctrl+S) · ${name}${enc} · unsaved`;
      disabled = false;
      break;
    case "cloud-dirty":
      html = ICON_CLOUD_UPLOAD;
      title = `Push to cloud (Ctrl+S) · ${name}${enc} · local ahead of cloud`;
      disabled = false;
      break;
    case "synced":
      html = ICON_CLOUD_CHECK;
      title = `Synced to cloud · ${name}${enc}`;
      disabled = false;
      break;
    default: // local-only
      html = ICON_DISK;
      title = `Saved locally · ${name}${enc} · sign in to OneDrive to back up`;
      disabled = false;
  }
  cloudPushBtn.innerHTML = html;
  cloudPushBtn.title = title;
  cloudPushBtn.disabled = disabled;
}

function markDirty() {
  if (_loading) return;
  if (!_dirty) {
    _dirty = true;
    updateSaveBtnState();
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
      // Bake CSS filter 进 thumb（drawImage 不会自动套 img 的 style.filter）
      const fs = obj.filters ? filtersToCssString(obj.filters) : "";
      const savedFilter = ctx.filter;
      ctx.filter = fs || "none";
      const needTransform = obj.rotation || obj.flipH || obj.flipV;
      // 9-arg drawImage 走 source crop：obj.crop 时只画那块；没 crop 时画整图。
      // bug 修复（0.11.1）：之前用 5-arg 形式 → cropped 图在 thumb 里显示成未裁切的整图。
      const c = obj.crop || { x: 0, y: 0, w: imgEl.naturalWidth, h: imgEl.naturalHeight };
      if (needTransform) {
        const cx = (tl.x + br.x) / 2, cy = (tl.y + br.y) / 2;
        ctx.save();
        ctx.translate(cx, cy);
        if (obj.rotation) ctx.rotate(obj.rotation * Math.PI / 180);
        if (obj.flipH || obj.flipV) ctx.scale(obj.flipH ? -1 : 1, obj.flipV ? -1 : 1);
        try { ctx.drawImage(imgEl, c.x, c.y, c.w, c.h, -w_ / 2, -h_ / 2, w_, h_); } catch (_) {}
        ctx.restore();
      } else {
        try { ctx.drawImage(imgEl, c.x, c.y, c.w, c.h, tl.x, tl.y, w_, h_); } catch (_) {}
      }
      ctx.filter = savedFilter;
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
  // 防御性 dedupe by src：0.9.5 之前 duplicate 复制了 src，老 atlas zip 可能两个 obj 同 path → 写两次 = 损坏。
  // 现在 duplicate 强制换新 src，但已有的脏文件 load 进来仍可能 dupe。这里按 src 去重。
  const seenSrcs = new Set();
  for (const o of snap.objects.values()) {
    if (o.type === "image" && o.src && o.blob) {
      if (seenSrcs.has(o.src)) continue;
      seenSrcs.add(o.src);
      entries.push({ path: o.src, data: o.blob });
    }
  }
  let thumb = null;
  try { thumb = await renderBoardThumb(512); } catch (_) {}
  if (thumb) entries.push({ path: "thumb.png", data: thumb });
  // 加密：当前 session 标了加密 + 内存里有密码 → 走 wrap-with-AES 路径
  // 不在内存的话强不起来（应该不可能 reach 这里 with encrypted + no password）
  if (_currentEncrypted && _currentSessionPassword) {
    const atlas = await zipPackEncrypted(entries, _currentSessionPassword);
    return { atlas, thumb: null, doc, encrypted: true };
  }
  const atlas = await zipPack(entries);
  return { atlas, thumb, doc, encrypted: false };
}

// 当前 session 的 IDB key = "<sessionInput.value>.atlas.zip" / "characters/wall.atlas.zip" 之类。
// localStorage 跟踪上次打开的 path，刷新时回到那里。
const CURRENT_PATH_KEY = "atlasmaker.currentPath";
const DEFAULT_SESSION_NAME = "Untitled";

// 找一个还没被占的「Untitled (n)」路径。boot 失败时用，避免误覆盖已有「Untitled」session。
async function findFreshSlotPath() {
  const base = sessionFileName(DEFAULT_SESSION_NAME);
  const baseExists = await storage.getSession(base).catch(() => null);
  if (!baseExists) return base;
  for (let i = 2; i < 1000; i++) {
    const path = sessionFileName(`${DEFAULT_SESSION_NAME} ${i}`);
    const existing = await storage.getSession(path).catch(() => null);
    if (!existing) return path;
  }
  return sessionFileName(`${DEFAULT_SESSION_NAME} ${Date.now()}`);
}
function pathFromInput() { return sessionFileName(sessionInput.value || DEFAULT_SESSION_NAME); }
function getCurrentPath() {
  try { return localStorage.getItem(CURRENT_PATH_KEY) || sessionFileName(DEFAULT_SESSION_NAME); }
  catch (_) { return sessionFileName(DEFAULT_SESSION_NAME); }
}
function setCurrentPath(p) { try { localStorage.setItem(CURRENT_PATH_KEY, p); } catch (_) {} }

// _activeIDBPath：当前 session 在 IDB 里实际保存的 key（区分于 pathFromInput() 这个 *目标* 路径）
// 重命名场景：用户在 sessionInput 改名 → pathFromInput() 是新 path；_activeIDBPath 是老 path
// 下一次 saveCurrentSession 时：新 path 写入，老 path 删除（IDB rename done）
// _activeCloudPath：上次成功推送到 OneDrive 的路径。push 成功后若 _activeCloudPath !== 新 path → 删老云
let _activeIDBPath = getCurrentPath();
let _activeCloudPath = getCurrentPath(); // 启动时假设 = IDB path（404 时 deleteAtlas 会 no-op）

function stemOfPath(path) { return path.replace(/\.atlas\.zip$/i, ""); }

// ----- 加密状态（per session，纯内存，关页面就忘）-----
let _currentSessionPassword = null;
let _currentEncrypted = false;

// 密码 / phrase dialog：替代 window.prompt（themed UI、密码字段 type=password、显隐切换、回车确认、Esc 取消）
// 三种 mode：
//   "password"    — 单密码框，OK 返回字符串，cancel 返回 null
//   "newPassword" — 双密码框 + 校验一致，OK 返回字符串
//   "typePhrase"  — 单文本框 + 校验等于 expectedPhrase，OK 返回 true，cancel 返回 false
const _pwEls = {
  backdrop: document.getElementById("pwBackdrop"),
  dialog: document.getElementById("pwDialog"),
  title: document.getElementById("pwTitle"),
  message: document.getElementById("pwMessage"),
  input1: document.getElementById("pwInput1"),
  input2: document.getElementById("pwInput2"),
  field2: document.getElementById("pwField2"),
  show1: document.getElementById("pwShow1"),
  error: document.getElementById("pwError"),
  cancel: document.getElementById("pwCancel"),
  ok: document.getElementById("pwOk"),
};
let _pwActiveResolve = null;
function _closePwDialog(value) {
  _pwEls.dialog.classList.add("hidden");
  _pwEls.backdrop.classList.add("hidden");
  _pwEls.input1.value = "";
  _pwEls.input2.value = "";
  _pwEls.error.textContent = "";
  _pwEls.input1.type = "password";
  _pwEls.input2.type = "password";
  const r = _pwActiveResolve;
  _pwActiveResolve = null;
  if (r) r(value);
}
_pwEls.cancel.addEventListener("click", () => _closePwDialog(null));
_pwEls.backdrop.addEventListener("click", () => _closePwDialog(null));
_pwEls.show1.addEventListener("click", () => {
  const showing = _pwEls.input1.type === "text";
  _pwEls.input1.type = showing ? "password" : "text";
  _pwEls.input2.type = showing ? "password" : "text";
});
function _pwDialog({ mode, title, message, expectedPhrase, okLabel = "OK" }) {
  return new Promise((resolve) => {
    if (_pwActiveResolve) { _closePwDialog(null); }
    _pwActiveResolve = resolve;
    _pwEls.title.textContent = title;
    _pwEls.message.textContent = message || "";
    _pwEls.message.style.display = message ? "" : "none";
    _pwEls.ok.textContent = okLabel;
    if (mode === "newPassword") {
      _pwEls.field2.classList.remove("hidden");
      _pwEls.input1.type = "password";
      _pwEls.input2.type = "password";
      _pwEls.input1.placeholder = "New password";
      _pwEls.show1.style.display = "";
    } else if (mode === "password") {
      _pwEls.field2.classList.add("hidden");
      _pwEls.input1.type = "password";
      _pwEls.input1.placeholder = "";
      _pwEls.show1.style.display = "";
    } else { // typePhrase
      _pwEls.field2.classList.add("hidden");
      _pwEls.input1.type = "text";
      _pwEls.input1.placeholder = expectedPhrase || "";
      _pwEls.show1.style.display = "none";
    }
    _pwEls.error.textContent = "";
    _pwEls.backdrop.classList.remove("hidden");
    _pwEls.dialog.classList.remove("hidden");
    setTimeout(() => _pwEls.input1.focus(), 0);

    const submit = () => {
      const v1 = _pwEls.input1.value;
      if (mode === "newPassword") {
        if (!v1) { _pwEls.error.textContent = "Password is empty"; return; }
        if (v1 !== _pwEls.input2.value) { _pwEls.error.textContent = "Passwords don't match"; return; }
        _closePwDialog(v1);
      } else if (mode === "password") {
        _closePwDialog(v1);
      } else { // typePhrase
        _closePwDialog(v1 === expectedPhrase);
      }
    };
    const onKey = (e) => {
      if (e.key === "Enter") { e.preventDefault(); submit(); }
      else if (e.key === "Escape") { e.preventDefault(); _closePwDialog(mode === "typePhrase" ? false : null); }
    };
    const okClick = () => submit();
    _pwEls.ok.addEventListener("click", okClick);
    _pwEls.input1.addEventListener("keydown", onKey);
    _pwEls.input2.addEventListener("keydown", onKey);
    // 清理：dialog 关闭时 _closePwDialog 通过 _pwActiveResolve = null 标记已关
    // 把 listener 一并清掉避免叠加
    const cleanup = (val) => {
      _pwEls.ok.removeEventListener("click", okClick);
      _pwEls.input1.removeEventListener("keydown", onKey);
      _pwEls.input2.removeEventListener("keydown", onKey);
      resolve(val);
    };
    // 用 wrapper 替换 _pwActiveResolve，让 _closePwDialog 在退出时清 listener
    _pwActiveResolve = cleanup;
  });
}

async function promptPassword(message = "Enter password") {
  return await _pwDialog({ mode: "password", title: "Password", message });
}
async function promptNewPassword(title = "Set a password to encrypt this session") {
  return await _pwDialog({ mode: "newPassword", title: "Set password", message: title });
}
async function confirmTypePhrase(phrase, message) {
  return await _pwDialog({ mode: "typePhrase", title: "Confirm", message, expectedPhrase: phrase, okLabel: "Confirm" });
}

// === 通用 input sheet（rename / new board / etc）===
// validate(value) → null = OK，string = 错误信息（inline 显示，不关 sheet，让用户改）
// 返回 trim 后的字符串 / null（取消）
const _isEls = {
  backdrop: document.getElementById("inputBackdrop"),
  dialog: document.getElementById("inputDialog"),
  title: document.getElementById("inputTitle"),
  message: document.getElementById("inputMessage"),
  field: document.getElementById("inputField"),
  error: document.getElementById("inputError"),
  cancel: document.getElementById("inputCancel"),
  ok: document.getElementById("inputOk"),
};
let _isActiveResolve = null;
function _closeInputSheet(value) {
  _isEls.dialog.classList.add("hidden");
  _isEls.backdrop.classList.add("hidden");
  _isEls.field.value = "";
  _isEls.error.textContent = "";
  const r = _isActiveResolve;
  _isActiveResolve = null;
  if (r) r(value);
}
_isEls.cancel.addEventListener("click", () => _closeInputSheet(null));
_isEls.backdrop.addEventListener("click", () => _closeInputSheet(null));

async function openInputSheet({ title, message = "", initial = "", placeholder = "", okLabel = "OK", validate = null }) {
  return new Promise((resolve) => {
    if (_isActiveResolve) { _closeInputSheet(null); }
    _isActiveResolve = resolve;
    _isEls.title.textContent = title;
    _isEls.message.textContent = message;
    _isEls.message.style.display = message ? "" : "none";
    _isEls.field.value = initial;
    _isEls.field.placeholder = placeholder;
    _isEls.ok.textContent = okLabel;
    _isEls.error.textContent = "";
    _isEls.backdrop.classList.remove("hidden");
    _isEls.dialog.classList.remove("hidden");
    setTimeout(() => { _isEls.field.focus(); _isEls.field.select(); }, 0);

    const submit = async () => {
      const v = _isEls.field.value.trim();
      if (!v) { _isEls.error.textContent = "Required"; return; }
      if (validate) {
        const err = await validate(v);
        if (err) { _isEls.error.textContent = err; return; }
      }
      _closeInputSheet(v);
    };
    const onKey = (e) => {
      if (e.key === "Enter") { e.preventDefault(); submit(); }
      else if (e.key === "Escape") { e.preventDefault(); _closeInputSheet(null); }
    };
    const okClick = () => submit();
    _isEls.ok.addEventListener("click", okClick);
    _isEls.field.addEventListener("keydown", onKey);
    const cleanup = (val) => {
      _isEls.ok.removeEventListener("click", okClick);
      _isEls.field.removeEventListener("keydown", onKey);
      resolve(val);
    };
    _isActiveResolve = cleanup;
  });
}

// === Rename current board ===
// 入口：汉堡菜单「Rename current board…」+ 412 冲突自动弹。
// 同名循环：本地已有同名 → 提示换个名 → loop until 唯一 / 取消。
// 数据安全：rename = saveSession(newName) + deleteSession(oldName)，oldName 走 _activeIDBPath（actually-loaded，避开 ghost current path 陷阱 0.7.2）。
async function renameCurrentBoard({ suggested, reason } = {}) {
  const oldPath = _activeIDBPath;
  const oldStem = stemOfPath(oldPath);
  let candidate = suggested || oldStem;
  while (true) {
    const title = reason ? `Rename (${reason})` : "Rename current board";
    const msg = reason ? `Cloud has a newer "${oldStem}". Choose a new name to save your version as.` : "";
    const newStem = await openInputSheet({
      title, message: msg, initial: candidate,
      placeholder: "Board name (use / for subfolders)",
      okLabel: "Rename",
      validate: async (v) => {
        if (v === oldStem) return null; // 没改名也算 OK
        const newPath = sessionFileName(v);
        try {
          const existing = await storage.getSession(newPath);
          if (existing) return `"${v}" already exists locally — pick another`;
        } catch (_) {}
        return null;
      },
    });
    if (newStem === null) return null;
    if (newStem === oldStem) return oldStem;
    // 改 sessionInput → 触发 input 事件 → markDirty + onSessionNameChanged。然后 explicit save。
    sessionInput.value = newStem;
    applySessionTitle();
    if (cloud.isAuthConfigured() && cloud.isSignedIn()) {
      cloud.setCloudDirty(newStem, true);
    }
    markDirty(); // 让 save 真跑（_dirty=true）
    refreshCloudUI();
    // 保存：local + cloud（用户在场显式 rename + push）
    await saveCurrentSession({ explicit: true });
    return newStem;
  }
}

// 412 冲突回调：自动弹 rename sheet。用户给名 → setCloudDirty(新名) → drain 一次推
async function handleCloudConflictRename(conflictName) {
  const newName = await renameCurrentBoard({
    suggested: conflictName + " (new)",
    reason: "cloud conflict",
  });
  // renameCurrentBoard 内部已经 saveCurrentSession 续推了，这里不用再 push
  if (!newName) {
    showActionToast(`Saved locally — OneDrive has a newer "${conflictName}". Click save again after renaming.`, 6000);
  }
}

// 保存 = 本地 IDB（atomic）；explicit=true 时**额外**触发云推（用户在场 = 能看见 toast 和 412 提示）。
// autosave / 3-min / visibility 仍走 explicit=false → 绝不触云（用户没在场，412 sibling 会失踪）。
// Ctrl+Shift+S 走 explicit=true + skipCloud=true：用户明确「只存本地」，跳过云、但给个 toast 确认。
// Coalesced save 模式（0.9.12 升级）：
//   - `_saving` 覆盖**整段** local + cloud + toast，期间任何 saveCurrentSession 调用都立刻 return
//   - drain 条件 = `_dirty`（改了内容）**或** `pending.explicit && !inFlight.explicit`
//     （用户在 autosave 跑期间按了 Ctrl+S，意图升级了）。后者对齐 WebPaint v52
//     的「in-flight local + user 按 push → 必 queue push」规则。
//   - `_pendingSaveOpts` 是「**如果**要 drain，用谁的意图」：保存期间最近一次按键的 opts
//     （或 autosave 默认）。
//
//   矩阵：
//   | 在跑 explicit | 中间 markDirty | 中间按 Ctrl+S (explicit) | drain? | drain 用谁 |
//   |---|---|---|---|---|
//   | * | no   | no  | no       | — |
//   | * | yes  | no  | yes      | pending（或 autosave 默认） |
//   | * | yes  | yes | yes      | pending |
//   | false | no | yes  | **yes** | pending（用户意图升级到云推） |
//   | true  | no | yes  | no | — （云已经在推了） |
//
//   `queueMicrotask` drain 避免同步递归 stack。
let _pendingSaveOpts = null;
let _inFlightExplicit = false;

async function saveCurrentSession({ explicit = false, skipCloud = false } = {}) {
  if (_saving) {
    _pendingSaveOpts = { explicit, skipCloud };
    return;
  }
  // _loading 期间（boot apply / 密码 prompt / 解密 zip / cloud pull-and-open）拒绝保存：
  // 此时 scene 状态可能是「正在被替换」的半成品，存下去会污染 IDB。
  // 用户在场触发（explicit=true）给个 toast；autosave 静默 return。
  if (_loading) {
    if (explicit) showActionToast("Still loading — try again in a moment", 3000);
    return;
  }
  _saving = true;
  _inFlightExplicit = explicit;
  _lastSaveError = null;
  updateSaveBtnState();
  try {
    // === 本地 IDB ===
    let localErr = null;
    let builtAtlas = null;
    let savedDoc = null;
    try {
      const { atlas, thumb, doc, encrypted } = await buildAtlasZip();
      builtAtlas = atlas;
      savedDoc = doc;
      const newPath = pathFromInput();
      const oldPath = _activeIDBPath;
      await storage.putSession(newPath, {
        name: doc.name,
        updatedAt: doc.updatedAt,
        atlas,
        thumb: encrypted ? null : thumb,
        encrypted: !!encrypted,
      });
      if (oldPath && oldPath !== newPath) {
        try { await storage.deleteSession(oldPath); } catch (e) { console.warn("rename: 删老 key 失败", e); }
      }
      _activeIDBPath = newPath;
      setCurrentPath(newPath);
      _dirty = false;
      if (cloud.isAuthConfigured() && cloud.isSignedIn()) {
        cloud.setCloudDirty(doc.name, true);
      }
    } catch (e) {
      localErr = e;
      _lastSaveError = e;
      console.warn("save failed", e);
    }
    if (localErr) {
      if (explicit) showActionToast(`Save failed: ${localErr.message || localErr}`, 5000);
      return;
    }
    if (!explicit) return;
    if (skipCloud) {
      showActionToast("Saved locally (cloud skipped — use Ctrl+S to push)");
      return;
    }
    if (!cloud.isAuthConfigured() || !cloud.isSignedIn()) {
      showActionToast("Saved locally");
      return;
    }

    // === 云推 ===
    let pushOutcome = null;
    _cloudPushing = true;
    updateSaveBtnState();
    try {
      const name = savedDoc.name;
      const newCloudPath = pathFromInput();
      const oldCloudPath = _activeCloudPath;
      const result = await cloud.pushAtlas(name, builtAtlas);
      if (result.action === "uploaded") {
        let renamedFrom = null;
        if (oldCloudPath && oldCloudPath !== newCloudPath) {
          try { await cloud.deleteAtlas(stemOfPath(oldCloudPath)); renamedFrom = oldCloudPath; }
          catch (e) { console.warn("delete old cloud failed:", e); }
        }
        _activeCloudPath = newCloudPath;
        pushOutcome = { action: "uploaded", renamedFrom };
      }
    } catch (e) {
      if (e instanceof cloud.CloudConflictError) {
        pushOutcome = { conflict: true, sessionName: e.sessionName };
      } else {
        pushOutcome = { error: e.message || String(e) };
      }
    } finally {
      _cloudPushing = false;
    }

    if (pushOutcome?.error) {
      showActionToast(`Saved locally (cloud push failed: ${pushOutcome.error})`, 5000);
    } else if (pushOutcome?.conflict) {
      // 412 冲突 → 自动弹 rename sheet（不再只 toast）
      await handleCloudConflictRename(pushOutcome.sessionName);
    } else if (pushOutcome?.action === "uploaded") {
      showActionToast(pushOutcome.renamedFrom
        ? `Saved (local + cloud, deleted old ${pushOutcome.renamedFrom})`
        : "Saved (local + cloud)");
    }
  } finally {
    _saving = false;
    const wasExplicit = _inFlightExplicit;
    _inFlightExplicit = false;
    updateSaveBtnState();
    refreshCloudUI();
    // Drain 条件：
    //   (a) 保存期间真改了 (_dirty 复活)
    //   (b) 或：in-flight 非 explicit，但 pending 是 explicit
    //       → 用户的意图升级了（autosave 在跑时按了 Ctrl+S），云推没跑过，必须 drain
    const opts = _pendingSaveOpts;
    _pendingSaveOpts = null;
    const explicitUpgrade = !wasExplicit && opts?.explicit;
    const wantDrain = _dirty || explicitUpgrade;
    if (wantDrain) {
      queueMicrotask(() => saveCurrentSession(opts || { explicit: false, skipCloud: false }));
    }
  }
}

// 从 zip 解出来的 atlas 恢复到 scene。被 IDB 启动加载和 import 共用。
// passwordHint 是可选预知密码（pull 时常用）；没传 + 是加密格式 = prompt 用户。
// 流程：先确认加密类型 + 拿密码（不锁 UI，让 prompt 能显示）→ withBusy 包住解包 + scene 重建。
async function applyAtlasZipBlob(atlasBlob, { passwordHint = null } = {}) {
  const fmt = await detectAtlasFormat(atlasBlob);
  let usedPassword = null;
  if (fmt === "encrypted") {
    let pw = passwordHint;
    if (!pw) pw = await promptPassword("Enter password to unlock encrypted session");
    if (pw === null) throw new Error("cancelled (no password)");
    usedPassword = pw;
  }
  return await withBusy(fmt === "encrypted" ? "Decrypting…" : "Loading session…", async () => {
    let entries;
    if (fmt === "encrypted") {
      try {
        entries = await zipUnpackEncrypted(atlasBlob, usedPassword);
      } catch (e) {
        throw new Error(e.message || "wrong password or file corrupted");
      }
    } else {
      entries = await zipUnpack(atlasBlob);
    }
    const sceneBytes = entries["scene.json"];
    if (!sceneBytes) throw new Error("ZIP has no scene.json");
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
    // 消毒 imageOrder / viewportOrder：
    //   - dedupe 同层重复 id（0.9.0 之前 _idSeq 撞 id 写出来的脏 scene.json）
    //   - 把 obj 实际类型不属于本层的 id 过滤掉（防止 image obj 漏到 viewport 层）
    //   - 若 obj 存在但没出现在任何 order 里，按 type 自动补到对应层尾
    const cleanOrder = (raw, wantType) => {
      const seen = new Set();
      const out = [];
      for (const id of raw || []) {
        if (seen.has(id)) continue;
        const o = objMap.get(id);
        if (!o || o.type !== wantType) continue;
        seen.add(id);
        out.push(id);
      }
      return out;
    };
    const imageOrder = cleanOrder(doc.imageOrder, "image");
    const viewportOrder = cleanOrder(doc.viewportOrder, "viewport");
    const inImg = new Set(imageOrder);
    const inVp = new Set(viewportOrder);
    for (const o of objMap.values()) {
      if (o.type === "image" && !inImg.has(o.id)) imageOrder.push(o.id);
      else if (o.type === "viewport" && !inVp.has(o.id)) viewportOrder.push(o.id);
    }
    scene.restore({
      objects: objMap,
      imageOrder,
      viewportOrder,
      selection: new Set(),
    });
    scene._undoStack.length = 0;
    scene._redoStack.length = 0;
    if (doc.board) board.setViewport(doc.board.tx, doc.board.ty, doc.board.scale);
    if (typeof doc.name === "string") { sessionInput.value = doc.name; applySessionTitle(); }
    // 更新内存里的加密状态
    _currentEncrypted = (fmt === "encrypted");
    _currentSessionPassword = usedPassword;
    return doc;
  });
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
    updateSaveBtnState();
    return true;
  } finally {
    _loading = false;
  }
}

// 切到指定 path 的 session（保存当前 → 加载新）
async function openSessionByPath(path) {
  if (_dirty && !_saving) await saveCurrentSession();
  const pkg = await storage.getSession(path);
  if (!pkg) { showActionToast(`Not found: ${path}`, 4000); return; }
  // 如果是重新打开「实际已经在内存里那个 session」，复用 memory 里的密码免再 prompt
  const passwordHint = (path === _activeIDBPath && _currentEncrypted) ? _currentSessionPassword : null;
  _loading = true;
  try {
    await applyAtlasZipBlob(pkg.atlas, { passwordHint });
    sessionInput.value = stemOfPath(path);
    applySessionTitle();
  } finally { _loading = false; }
  setCurrentPath(path);
  _activeIDBPath = path;
  _activeCloudPath = path; // 假设云上同名（不存在的话 deleteAtlas 是 no-op）
  _dirty = false;
  updateSaveBtnState();
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
    sessionInput.value = stemOfPath(path);
    applySessionTitle();
  } finally { _loading = false; }
  _activeIDBPath = path;
  _activeCloudPath = null; // 全新的，云端没有
  _currentEncrypted = false; // 新建默认不加密
  _currentSessionPassword = null;
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
    showActionToast(`Exported (${n} image${n === 1 ? "" : "s"})`);
  } catch (e) {
    showActionToast(`Export failed: ${e.message || e}`, 4000);
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
    showActionToast(`Imported: ${doc.name || "Untitled"} (${n} image${n === 1 ? "" : "s"})`);
  } catch (e) {
    _loading = false;
    showActionToast(`Import failed: ${e.message || e}`, 5000);
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
const THEME_LABELS = { auto: "Auto", day: "Day", night: "Night" };

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
  if (lbl) lbl.textContent = `Theme: ${THEME_LABELS[cur] || cur}`;
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
    vpLock.innerHTML = sel.locked ? ICON_LOCK_CLOSED : ICON_LOCK_OPEN;
    // 顶行：板上矩形尺寸 → 输出分辨率
    const lbl = document.getElementById("vpNaturalLabel");
    if (lbl) lbl.textContent = `Rect ${Math.round(sel.w)}×${Math.round(sel.h)} → out ${sel.resW}×${sel.resH}`;
  } else if (sel && sel.type === "image") {
    imgPanel.classList.remove("hidden");
    vpPanel.classList.add("hidden");
    // 显示原图分辨率 + blob 字节 —— 让用户能看出哪张是 4K 大块头白浪费内存
    const sizeStr = sel.blob ? formatBytes(sel.blob.size) : "—";
    const cropStr = sel.crop ? ` (cropped ${Math.round(sel.crop.w)}×${Math.round(sel.crop.h)})` : "";
    // 「· adjusted」标签删（0.10.7）— Color 段的滑块自身已经体现状态，徽章是冗余信息
    imgNaturalLabel.textContent = `${sel.naturalW}×${sel.naturalH}${cropStr} · ${sizeStr}`;
    imgLock.setAttribute("aria-pressed", sel.locked ? "true" : "false");
    imgLock.innerHTML = sel.locked ? ICON_LOCK_CLOSED : ICON_LOCK_OPEN;
    imgInterp.value = sel.interp || "linear";
    // Reset crop 只在有 crop 时显示（用 disabled，避免按钮位置跳）
    const resetBtn = document.getElementById("imgResetCrop");
    if (resetBtn) resetBtn.disabled = !sel.crop;
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
  if (!blob) { showActionToast("Export failed"); return; }
  downloadBlob(blob, `viewport-${sel.resW}x${sel.resH}.png`);
  showActionToast(`Exported ${sel.resW}×${sel.resH} PNG`);
});

vpCopyBtn.addEventListener("click", async () => {
  const sel = scene.firstSelected();
  if (!sel || sel.type !== "viewport") return;
  const blob = await rasterizeViewport(sel);
  if (!blob) { showActionToast("Export failed"); return; }
  try {
    await navigator.clipboard.write([new ClipboardItem({ "image/png": blob })]);
    showActionToast(`Copied ${sel.resW}×${sel.resH} to clipboard`);
  } catch (e) {
    showActionToast("Clipboard copy failed: " + (e.message || e));
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
    showActionToast("Blender not connected — click the Blender pill in the top bar to retry");
    return;
  }
  const name = (sel.binding || "").trim();
  if (!name) {
    showActionToast("Set a binding name first");
    vpBinding.focus();
    return;
  }
  vpPushBtn.disabled = true;
  showActionToast(`Pushing ${sel.resW}×${sel.resH} → ${name}…`, 60000);
  try {
    const blob = await rasterizeViewport(sel);
    if (!blob) throw new Error("rasterize failed");
    const { action } = await btp.push(name, blob);
    showActionToast(action === "created"
      ? `Created Blender texture: ${name} (${sel.resW}×${sel.resH})`
      : `Updated Blender texture: ${name} (${sel.resW}×${sel.resH})`);
  } catch (e) {
    const msg = e instanceof BTPError ? `${e.code}: ${e.message}` : (e.message || String(e));
    showActionToast(`Push failed: ${msg}`, 4000);
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

// ----- Rasterize 对话框 -----
// 把当前 image obj 的 nondestructive 状态（crop / 未来的 filters / 等）烤进新 blob，
// 同时按目标分辨率重采样。模式 = "adaptive"（浏览器内插）或 "nearest"（像素硬复制）。
// 默认值：若 obj.interp == "nearest" → 默认 nearest mode（像素图用户的预期）。
const rasterBackdrop = document.getElementById("rasterBackdrop");
const rasterDialog = document.getElementById("rasterDialog");
const rasterWInput = document.getElementById("rasterW");
const rasterHInput = document.getElementById("rasterH");
const rasterLockAspect = document.getElementById("rasterLockAspect");
const rasterModeSelect = document.getElementById("rasterMode");
const rasterSourceLabel = document.getElementById("rasterSource");
const rasterEstimateLabel = document.getElementById("rasterEstimate");
const rasterApplyBtn = document.getElementById("rasterApply");
const rasterCancelBtn = document.getElementById("rasterCancel");
const imgRasterizeBtn = document.getElementById("imgRasterize");

let _rasterTargetId = null; // 打开时锁定的目标 obj id（中途 selection 变了也跑这个）
let _rasterAspect = 1;

function _rasterUpdateEstimate() {
  const w = parseInt(rasterWInput.value, 10) || 0;
  const h = parseInt(rasterHInput.value, 10) || 0;
  if (w < 1 || h < 1) { rasterEstimateLabel.textContent = "—"; return; }
  // 粗估 PNG 大小：4 bytes/px × W × H × 0.3 压缩率（典型自然图）。pixel art 更小，但保守估。
  const bytes = Math.round(w * h * 4 * 0.3);
  rasterEstimateLabel.textContent = `Output ≈ ${formatBytes(bytes)} PNG`;
}

function openRasterizeDialog() {
  const sel = scene.firstSelected();
  if (!sel || sel.type !== "image") {
    showActionToast("Select an image to rasterize", 3000);
    return;
  }
  if (!sel.blob) { showActionToast("Image has no data"); return; }
  _rasterTargetId = sel.id;
  // 默认 = crop 后的 native 分辨率（无 crop 时就是 naturalW/H）。
  // crop.w/h 来自 applyCropMath 是浮点 → 这里 round 给用户整数默认值；
  // raster.js 内部仍按整数 px 处理 canvas。
  const cw = Math.round(sel.crop?.w ?? sel.naturalW);
  const ch = Math.round(sel.crop?.h ?? sel.naturalH);
  rasterWInput.value = cw;
  rasterHInput.value = ch;
  _rasterAspect = ch > 0 ? cw / ch : 1;
  rasterLockAspect.checked = true;
  rasterModeSelect.value = sel.interp === "nearest" ? "nearest" : "adaptive";
  const hasFilters = sel.filters && Object.values(sel.filters).some((v) => v && Math.abs(v) > 0.01);
  rasterSourceLabel.textContent = `Source: ${sel.naturalW}×${sel.naturalH}${sel.crop ? ` (cropped ${cw}×${ch})` : ""}${hasFilters ? " (filtered)" : ""} · ${formatBytes(sel.blob.size)}`;
  _rasterUpdateEstimate();
  rasterBackdrop.classList.remove("hidden");
  rasterDialog.classList.remove("hidden");
  setTimeout(() => rasterWInput.focus(), 0);
}

function closeRasterizeDialog() {
  rasterBackdrop.classList.add("hidden");
  rasterDialog.classList.add("hidden");
  _rasterTargetId = null;
}

rasterWInput.addEventListener("input", () => {
  if (rasterLockAspect.checked) {
    const w = parseInt(rasterWInput.value, 10) || 0;
    if (w > 0) rasterHInput.value = Math.max(1, Math.round(w / _rasterAspect));
  }
  _rasterUpdateEstimate();
});
rasterHInput.addEventListener("input", () => {
  if (rasterLockAspect.checked) {
    const h = parseInt(rasterHInput.value, 10) || 0;
    if (h > 0) rasterWInput.value = Math.max(1, Math.round(h * _rasterAspect));
  }
  _rasterUpdateEstimate();
});
rasterLockAspect.addEventListener("change", () => {
  if (rasterLockAspect.checked) {
    const w = parseInt(rasterWInput.value, 10) || 0;
    const h = parseInt(rasterHInput.value, 10) || 0;
    if (w > 0 && h > 0) _rasterAspect = w / h;
  }
});

rasterCancelBtn.addEventListener("click", () => closeRasterizeDialog());
rasterBackdrop.addEventListener("click", () => closeRasterizeDialog());
rasterDialog.addEventListener("keydown", (e) => {
  if (e.key === "Enter") { e.preventDefault(); rasterApplyBtn.click(); }
  else if (e.key === "Escape") { e.preventDefault(); closeRasterizeDialog(); }
});

rasterApplyBtn.addEventListener("click", async () => {
  const id = _rasterTargetId;
  if (!id) { closeRasterizeDialog(); return; }
  const obj = scene.get(id);
  if (!obj || obj.type !== "image" || !obj.blob) { closeRasterizeDialog(); return; }
  const targetW = parseInt(rasterWInput.value, 10) || 0;
  const targetH = parseInt(rasterHInput.value, 10) || 0;
  if (targetW < 1 || targetH < 1) {
    showActionToast("Invalid target dimensions", 3000);
    return;
  }
  const mode = rasterModeSelect.value === "nearest" ? "nearest" : "adaptive";
  closeRasterizeDialog();
  try {
    const newBlob = await withBusy(`Rasterizing → ${targetW}×${targetH}…`, () =>
      rasterizeImage({
        blob: obj.blob,
        naturalW: obj.naturalW,
        naturalH: obj.naturalH,
        crop: obj.crop,
        filters: obj.filters,
        targetW,
        targetH,
        mode,
      })
    );
    const newSrc = _newImageSrc(newBlob);
    scene.act(() => {
      scene.replaceImageBlob(id, newBlob, newSrc);
      // 同步更新 natural 尺寸 + 重置 crop / filters（已 baked 进新 blob）
      scene.update(id, { naturalW: targetW, naturalH: targetH, crop: undefined, filters: undefined });
    });
    showActionToast(`Rasterized to ${targetW}×${targetH} (${formatBytes(newBlob.size)})`);
  } catch (e) {
    console.warn("rasterize failed", e);
    showActionToast(`Rasterize failed: ${e.message || e}`, 4000);
  }
});

imgRasterizeBtn.addEventListener("click", () => openRasterizeDialog());

// ----- Color 调色 filter chain（0.10.6 合进 #imagePanel Color 分区）-----
// 非破坏：滑块改 obj.filters → _applyTransform 写 img.style.filter（CSS GPU 合成，实时预览零成本）。
// Bake：Rasterize 时 raster.js 把同样的 filter 字符串挂 ctx.filter 烤进新 blob。
// Undo coalesce：每次拖滑块只生成 1 个 undo entry（pointerdown 起 beginAct，pointerup 起 endAct）。
const adjustSliders = imgPanel.querySelectorAll('input[type="range"][data-filter]');

function _adjustTargetObj() {
  const sel = scene.firstSelected();
  return (sel && sel.type === "image") ? sel : null;
}
function _syncAdjustPanelToObj(obj) {
  const f = (obj && obj.filters) || { brightness: 0, contrast: 0, saturation: 0, hue: 0 };
  for (const slider of adjustSliders) {
    const key = slider.dataset.filter;
    const v = f[key] || 0;
    slider.value = v;
    const label = imgPanel.querySelector(`.adjust-value[data-for="${key}"]`);
    if (label) label.textContent = key === "hue" ? `${v}°` : `${v}`;
  }
}

// ----- Flip / Rotate 90° -----
function _rotateBy(deg) {
  const sel = scene.firstSelected();
  if (!sel) return;
  let r = (sel.rotation || 0) + deg;
  while (r > 180) r -= 360;
  while (r <= -180) r += 360;
  scene.act(() => scene.update(sel.id, { rotation: r }));
}
function _toggleFlip(axis) {
  const sel = scene.firstSelected();
  if (!sel || sel.type !== "image") return;
  const key = axis === "h" ? "flipH" : "flipV";
  scene.act(() => scene.update(sel.id, { [key]: !sel[key] }));
}
document.getElementById("imgRotL").addEventListener("click", () => _rotateBy(-90));
document.getElementById("imgRotR").addEventListener("click", () => _rotateBy(90));
document.getElementById("imgFlipH").addEventListener("click", () => _toggleFlip("h"));
document.getElementById("imgFlipV").addEventListener("click", () => _toggleFlip("v"));

// 选区变 → 同步 sliders 到新 obj.filters（image panel 可见时）
scene.onChange(() => {
  if (!imgPanel.classList.contains("hidden")) {
    const obj = _adjustTargetObj();
    if (obj) _syncAdjustPanelToObj(obj);
  }
});

// Slider 拖拽：一次拖 = 一个 undo entry（pointerdown beginAct / pointerup endAct）
let _adjustActOpen = false;
function _adjustBegin() { if (_adjustActOpen) return; scene.beginAct(); _adjustActOpen = true; }
function _adjustCommit() { if (!_adjustActOpen) return; scene.endAct(); _adjustActOpen = false; }
for (const slider of adjustSliders) {
  slider.addEventListener("pointerdown", _adjustBegin);
  slider.addEventListener("input", () => {
    const obj = _adjustTargetObj();
    if (!obj) return;
    const key = slider.dataset.filter;
    const val = parseInt(slider.value, 10) || 0;
    const newFilters = { ...(obj.filters || {}), [key]: val };
    scene.update(obj.id, { filters: newFilters });
    const label = imgPanel.querySelector(`.adjust-value[data-for="${key}"]`);
    if (label) label.textContent = key === "hue" ? `${val}°` : `${val}`;
  });
  slider.addEventListener("pointerup", _adjustCommit);
  slider.addEventListener("pointercancel", _adjustCommit);
  slider.addEventListener("keydown", () => { if (!_adjustActOpen) _adjustBegin(); });
  slider.addEventListener("keyup", () => { if (_adjustActOpen) _adjustCommit(); });
}

document.getElementById("adjustReset").addEventListener("click", () => {
  const obj = _adjustTargetObj();
  if (!obj) return;
  scene.act(() => scene.update(obj.id, { filters: undefined }));
  _syncAdjustPanelToObj(obj);
});

// ----- Chroma key（去背景色）对话框 -----
// 一次性 bake：原图 → 抠掉「关键色 ± 容差」的像素 → 新 PNG with alpha 替换 obj.blob。
// undo 走 scene.act → snapshot 保住旧 blob 引用，Ctrl+Z 回去。
// MVP：native color picker（去 emoji 化）+ tolerance + soft edge + 实时缩略预览（240px max）。
const chromaBackdrop = document.getElementById("chromaBackdrop");
const chromaDialog = document.getElementById("chromaDialog");
const chromaColorInput = document.getElementById("chromaColor");
const chromaToleranceInput = document.getElementById("chromaTolerance");
const chromaSoftInput = document.getElementById("chromaSoft");
const chromaPreviewEl = document.getElementById("chromaPreview");
const chromaApplyBtn = document.getElementById("chromaApply");
const chromaCancelBtn = document.getElementById("chromaCancel");

let _chromaState = null; // { objId, sourceImageData, ctx }

async function openChromaDialog() {
  const sel = scene.firstSelected();
  if (!sel || sel.type !== "image" || !sel.blob) {
    showActionToast("Select an image first", 2500);
    return;
  }
  // 预览：缩到 ≤ 240px 边；有 crop 就只画那块，跟 board 显示一致（0.11.1 bug fix）
  const bitmap = await createImageBitmap(sel.blob);
  const MAX = 240;
  const c = sel.crop || { x: 0, y: 0, w: bitmap.width, h: bitmap.height };
  const ratio = Math.min(MAX / c.w, MAX / c.h, 1);
  const pw = Math.max(1, Math.round(c.w * ratio));
  const ph = Math.max(1, Math.round(c.h * ratio));
  chromaPreviewEl.width = pw;
  chromaPreviewEl.height = ph;
  const ctx = chromaPreviewEl.getContext("2d");
  ctx.drawImage(bitmap, c.x, c.y, c.w, c.h, 0, 0, pw, ph);
  const sourceImageData = ctx.getImageData(0, 0, pw, ph);
  bitmap.close();
  // 默认 key color = 显示区域左上角（cropped 时是 crop 起点，不是原图 0,0）
  const tl = await sampleTopLeftPixel(sel.blob, sel.crop || null);
  chromaColorInput.value = `#${[tl.r, tl.g, tl.b].map((v) => v.toString(16).padStart(2, "0")).join("")}`;
  chromaToleranceInput.value = 10;
  chromaSoftInput.value = 0;
  document.getElementById("chromaToleranceVal").textContent = "10";
  document.getElementById("chromaSoftVal").textContent = "0";
  _chromaState = { objId: sel.id, sourceImageData, ctx };
  _updateChromaPreview();
  chromaBackdrop.classList.remove("hidden");
  chromaDialog.classList.remove("hidden");
}

function _updateChromaPreview() {
  if (!_chromaState) return;
  const { sourceImageData, ctx } = _chromaState;
  // Clone source（applyChromaToImageData 原地改）
  const fresh = new ImageData(
    new Uint8ClampedArray(sourceImageData.data),
    sourceImageData.width,
    sourceImageData.height,
  );
  const keyColor = hexToColor(chromaColorInput.value);
  const tol = parseInt(chromaToleranceInput.value, 10) || 0;
  const soft = parseInt(chromaSoftInput.value, 10) || 0;
  applyChromaToImageData(fresh, keyColor, tol, soft);
  ctx.clearRect(0, 0, fresh.width, fresh.height);
  ctx.putImageData(fresh, 0, 0);
}

function closeChromaDialog() {
  chromaBackdrop.classList.add("hidden");
  chromaDialog.classList.add("hidden");
  _chromaState = null;
}

chromaColorInput.addEventListener("input", _updateChromaPreview);
chromaToleranceInput.addEventListener("input", () => {
  document.getElementById("chromaToleranceVal").textContent = chromaToleranceInput.value;
  _updateChromaPreview();
});
chromaSoftInput.addEventListener("input", () => {
  document.getElementById("chromaSoftVal").textContent = chromaSoftInput.value;
  _updateChromaPreview();
});
chromaCancelBtn.addEventListener("click", closeChromaDialog);
chromaBackdrop.addEventListener("click", closeChromaDialog);
chromaDialog.addEventListener("keydown", (e) => {
  if (e.key === "Enter") { e.preventDefault(); chromaApplyBtn.click(); }
  else if (e.key === "Escape") { e.preventDefault(); closeChromaDialog(); }
});

chromaApplyBtn.addEventListener("click", async () => {
  if (!_chromaState) return;
  const { objId } = _chromaState;
  const obj = scene.get(objId);
  if (!obj || !obj.blob) { closeChromaDialog(); return; }
  const keyColor = hexToColor(chromaColorInput.value);
  const tol = parseInt(chromaToleranceInput.value, 10) || 0;
  const soft = parseInt(chromaSoftInput.value, 10) || 0;
  closeChromaDialog();
  try {
    const newBlob = await withBusy("Removing background…", () =>
      applyChromaKey(obj.blob, keyColor, tol, soft)
    );
    const newSrc = _newImageSrc(newBlob);
    scene.act(() => scene.replaceImageBlob(objId, newBlob, newSrc));
    showActionToast(`Background removed (${formatBytes(newBlob.size)})`);
  } catch (e) {
    console.warn("chroma key failed", e);
    showActionToast(`Failed: ${e.message || e}`, 4000);
  }
});

document.getElementById("imgChroma").addEventListener("click", () => openChromaDialog());

// ----- Pixel filter dialogs（Levels / Curves / Color Balance）-----
// Pattern：modal 内一张小预览 canvas（240px 边），滑块实时跑 pixel op → put 到预览。
// Apply → 全分辨率 bake → 替换 obj.blob via scene.act（破坏式，Ctrl+Z 回原）。
// 跟 chroma key 同款，只是 op 不同。canvas-filters.js 提供 op 函数 + bake helper。
function _setupPixelFilterDialog({
  dialog, backdrop, preview, applyBtn, cancelBtn, resetBtn,
  sliders, paramsFn, applyFn, busyLabel, onUpdate,
}) {
  let state = null;

  function close() {
    backdrop.classList.add("hidden");
    dialog.classList.add("hidden");
    state = null;
  }

  async function open() {
    const sel = scene.firstSelected();
    if (!sel || sel.type !== "image" || !sel.blob) {
      showActionToast("Select an image first", 2500);
      return;
    }
    const { imageData, w, h } = await buildPreviewSource(sel.blob, 240, sel.crop || null);
    preview.width = w;
    preview.height = h;
    state = { objId: sel.id, sourceImageData: imageData, ctx: preview.getContext("2d") };
    for (const s of sliders) {
      s.input.value = s.default;
      s.label.textContent = s.format(s.default);
    }
    update();
    backdrop.classList.remove("hidden");
    dialog.classList.remove("hidden");
  }

  function update() {
    if (!state) return;
    const params = paramsFn();
    const fresh = new ImageData(
      new Uint8ClampedArray(state.sourceImageData.data),
      state.sourceImageData.width,
      state.sourceImageData.height,
    );
    applyFn(fresh, params);
    state.ctx.clearRect(0, 0, fresh.width, fresh.height);
    state.ctx.putImageData(fresh, 0, 0);
    if (onUpdate) onUpdate(params);
  }

  for (const s of sliders) {
    s.input.addEventListener("input", () => {
      s.label.textContent = s.format(parseFloat(s.input.value));
      update();
    });
  }
  cancelBtn.addEventListener("click", close);
  backdrop.addEventListener("click", close);
  if (resetBtn) resetBtn.addEventListener("click", () => {
    for (const s of sliders) {
      s.input.value = s.default;
      s.label.textContent = s.format(s.default);
    }
    update();
  });
  dialog.addEventListener("keydown", (e) => {
    if (e.key === "Enter") { e.preventDefault(); applyBtn.click(); }
    else if (e.key === "Escape") { e.preventDefault(); close(); }
  });

  applyBtn.addEventListener("click", async () => {
    if (!state) return;
    const { objId } = state;
    const params = paramsFn();
    close();
    const obj = scene.get(objId);
    if (!obj || !obj.blob) return;
    try {
      const newBlob = await withBusy(busyLabel, () =>
        bakeImageWithCanvasFilter(obj.blob, (id) => applyFn(id, params))
      );
      const newSrc = _newImageSrc(newBlob);
      scene.act(() => scene.replaceImageBlob(objId, newBlob, newSrc));
      showActionToast(`${busyLabel.replace(/…$/, "")} done`);
    } catch (e) {
      console.warn(`${busyLabel} failed`, e);
      showActionToast(`Failed: ${e.message || e}`, 4000);
    }
  });

  return { open };
}

const $id = (id) => document.getElementById(id);

// ----- 0.11.0 V2: tabbed pixel-filter dialog factory（per-channel / tonal-range）-----
// 跟 _setupPixelFilterDialog 类似，但加 tab 切换：同一组 slider DOM，按 tab 切换显示哪个 channel/range 的值。
// state.tabValues[tabKey] = { sliderKey: value, ... }
function _setupTabbedFilterDialog({
  dialog, backdrop, preview, applyBtn, cancelBtn, resetBtn,
  sliders,         // [{ input, label, key, default, format }]
  tabKeys,         // [{ key, label }]
  tabNavId,        // ID 容器
  applyFn,         // (imageData, fullState) where fullState = { tabKey: { sliderKey: val, ... }, ... }
  busyLabel, onUpdate,
}) {
  let state = null;
  const tabNav = document.getElementById(tabNavId);

  function _readSlidersToState() {
    if (!state) return;
    const obj = {};
    for (const s of sliders) obj[s.key] = parseFloat(s.input.value);
    state.tabValues[state.activeTab] = obj;
  }
  function _writeStateToSliders() {
    if (!state) return;
    const obj = state.tabValues[state.activeTab];
    for (const s of sliders) {
      const v = obj[s.key];
      s.input.value = v;
      s.label.textContent = s.format(v);
    }
  }
  function _highlightTabs() {
    if (!tabNav) return;
    for (const b of tabNav.querySelectorAll(".tab-btn")) {
      b.classList.toggle("active", b.dataset.tab === state.activeTab);
    }
  }
  function switchTab(key) {
    if (!state) return;
    _readSlidersToState();
    state.activeTab = key;
    _writeStateToSliders();
    _highlightTabs();
    update();
  }
  // 一次性 build tab 按钮
  if (tabNav) {
    tabNav.innerHTML = "";
    for (const tk of tabKeys) {
      const btn = document.createElement("button");
      btn.type = "button";
      btn.className = "tab-btn";
      btn.dataset.tab = tk.key;
      btn.textContent = tk.label;
      btn.addEventListener("click", () => switchTab(tk.key));
      tabNav.appendChild(btn);
    }
  }

  function close() {
    backdrop.classList.add("hidden");
    dialog.classList.add("hidden");
    state = null;
  }
  async function open() {
    const sel = scene.firstSelected();
    if (!sel || sel.type !== "image" || !sel.blob) {
      showActionToast("Select an image first", 2500); return;
    }
    const { imageData, w, h } = await buildPreviewSource(sel.blob, 240, sel.crop || null);
    preview.width = w;
    preview.height = h;
    const tabValues = {};
    for (const tk of tabKeys) {
      const def = {};
      for (const s of sliders) def[s.key] = s.default;
      tabValues[tk.key] = def;
    }
    state = {
      objId: sel.id,
      sourceImageData: imageData,
      ctx: preview.getContext("2d"),
      tabValues,
      activeTab: tabKeys[0].key,
    };
    _writeStateToSliders();
    _highlightTabs();
    update();
    backdrop.classList.remove("hidden");
    dialog.classList.remove("hidden");
  }
  function _params() {
    if (!state) return null;
    _readSlidersToState();
    return state.tabValues;
  }
  function update() {
    if (!state) return;
    const params = _params();
    const fresh = new ImageData(
      new Uint8ClampedArray(state.sourceImageData.data),
      state.sourceImageData.width,
      state.sourceImageData.height,
    );
    applyFn(fresh, params);
    state.ctx.clearRect(0, 0, fresh.width, fresh.height);
    state.ctx.putImageData(fresh, 0, 0);
    if (onUpdate) onUpdate(params, state.activeTab);
  }
  for (const s of sliders) {
    s.input.addEventListener("input", () => {
      s.label.textContent = s.format(parseFloat(s.input.value));
      update();
    });
  }
  cancelBtn.addEventListener("click", close);
  backdrop.addEventListener("click", close);
  if (resetBtn) resetBtn.addEventListener("click", () => {
    // 重置 ALL tabs 到默认
    if (!state) return;
    for (const tk of tabKeys) {
      const def = {};
      for (const s of sliders) def[s.key] = s.default;
      state.tabValues[tk.key] = def;
    }
    _writeStateToSliders();
    update();
  });
  dialog.addEventListener("keydown", (e) => {
    if (e.key === "Enter") { e.preventDefault(); applyBtn.click(); }
    else if (e.key === "Escape") { e.preventDefault(); close(); }
  });
  applyBtn.addEventListener("click", async () => {
    if (!state) return;
    const { objId } = state;
    const params = _params();
    close();
    const obj = scene.get(objId);
    if (!obj || !obj.blob) return;
    try {
      const newBlob = await withBusy(busyLabel, () =>
        bakeImageWithCanvasFilter(obj.blob, (id) => applyFn(id, params))
      );
      const newSrc = _newImageSrc(newBlob);
      scene.act(() => scene.replaceImageBlob(objId, newBlob, newSrc));
      showActionToast(`${busyLabel.replace(/…$/, "")} done`);
    } catch (e) {
      console.warn(`${busyLabel} failed`, e);
      showActionToast(`Failed: ${e.message || e}`, 4000);
    }
  });
  return { open };
}

// Levels V2 — 4 tabs (Master / R / G / B)
const _levelsDlg = _setupTabbedFilterDialog({
  dialog: $id("levelsDialog"),
  backdrop: $id("levelsBackdrop"),
  preview: $id("levelsPreview"),
  applyBtn: $id("levelsApply"),
  cancelBtn: $id("levelsCancel"),
  tabNavId: "levelsTabNav",
  tabKeys: [
    { key: "master", label: "Master" },
    { key: "r", label: "R" },
    { key: "g", label: "G" },
    { key: "b", label: "B" },
  ],
  sliders: [
    { input: $id("lvInBlack"), label: $id("lvInBlackVal"), key: "inBlack", default: 0, format: (v) => `${v | 0}` },
    { input: $id("lvInWhite"), label: $id("lvInWhiteVal"), key: "inWhite", default: 255, format: (v) => `${v | 0}` },
    { input: $id("lvGamma"), label: $id("lvGammaVal"), key: "gamma", default: 1, format: (v) => v.toFixed(2) },
    { input: $id("lvOutBlack"), label: $id("lvOutBlackVal"), key: "outBlack", default: 0, format: (v) => `${v | 0}` },
    { input: $id("lvOutWhite"), label: $id("lvOutWhiteVal"), key: "outWhite", default: 255, format: (v) => `${v | 0}` },
  ],
  applyFn: (id, p) => applyLevels(id, p),
  busyLabel: "Applying levels…",
});
$id("imgLevels").addEventListener("click", () => _levelsDlg.open());

// Color Balance V2 — 3 tabs (Shadows / Midtones / Highlights)
const _cbDlg = _setupTabbedFilterDialog({
  dialog: $id("cbDialog"),
  backdrop: $id("cbBackdrop"),
  preview: $id("cbPreview"),
  applyBtn: $id("cbApply"),
  cancelBtn: $id("cbCancel"),
  tabNavId: "cbTabNav",
  tabKeys: [
    { key: "shadows", label: "Shadows" },
    { key: "midtones", label: "Midtones" },
    { key: "highlights", label: "Highlights" },
  ],
  sliders: [
    { input: $id("cbCR"), label: $id("cbCRVal"), key: "cr", default: 0, format: (v) => `${v | 0}` },
    { input: $id("cbMG"), label: $id("cbMGVal"), key: "mg", default: 0, format: (v) => `${v | 0}` },
    { input: $id("cbYB"), label: $id("cbYBVal"), key: "yb", default: 0, format: (v) => `${v | 0}` },
  ],
  applyFn: (id, p) => applyColorBalance(id, p),
  busyLabel: "Applying color balance…",
});
$id("imgColorBalance").addEventListener("click", () => _cbDlg.open());

// Curves V2 — 4 tabs + curve graph shows active channel
const _curveGraph = $id("curveGraph");
const _curveGraphCtx = _curveGraph.getContext("2d");
const _curveChannelColors = {
  master: getComputedStyle(document.documentElement).getPropertyValue("--accent") || "#8a481e",
  r: "#e54e3a",
  g: "#3fae5f",
  b: "#4f7adf",
};
function _drawCurveGraphForTab(tabValuesObj, activeTab) {
  // tabValuesObj = { y32, y64, y128, y192, y224 }（活 tab）
  if (!tabValuesObj) return;
  const ys = [tabValuesObj.y32, tabValuesObj.y64, tabValuesObj.y128, tabValuesObj.y192, tabValuesObj.y224];
  const w = _curveGraph.width, h = _curveGraph.height;
  _curveGraphCtx.clearRect(0, 0, w, h);
  // 网格
  _curveGraphCtx.strokeStyle = "rgba(127,127,127,0.25)";
  _curveGraphCtx.lineWidth = 1;
  for (let i = 1; i < 4; i++) {
    const x = (w * i) / 4, y = (h * i) / 4;
    _curveGraphCtx.beginPath(); _curveGraphCtx.moveTo(x, 0); _curveGraphCtx.lineTo(x, h); _curveGraphCtx.stroke();
    _curveGraphCtx.beginPath(); _curveGraphCtx.moveTo(0, y); _curveGraphCtx.lineTo(w, y); _curveGraphCtx.stroke();
  }
  // identity
  _curveGraphCtx.strokeStyle = "rgba(127,127,127,0.5)";
  _curveGraphCtx.setLineDash([3, 3]);
  _curveGraphCtx.beginPath(); _curveGraphCtx.moveTo(0, h); _curveGraphCtx.lineTo(w, 0); _curveGraphCtx.stroke();
  _curveGraphCtx.setLineDash([]);
  // LUT 曲线
  const lut = buildCurveLut(ys);
  _curveGraphCtx.strokeStyle = _curveChannelColors[activeTab] || _curveChannelColors.master;
  _curveGraphCtx.lineWidth = 2;
  _curveGraphCtx.beginPath();
  for (let i = 0; i < 256; i++) {
    const x = (i / 255) * w;
    const y = h - (lut[i] / 255) * h;
    if (i === 0) _curveGraphCtx.moveTo(x, y); else _curveGraphCtx.lineTo(x, y);
  }
  _curveGraphCtx.stroke();
  // 控制点
  _curveGraphCtx.fillStyle = _curveGraphCtx.strokeStyle;
  const xs = [32, 64, 128, 192, 224];
  for (let i = 0; i < 5; i++) {
    const x = (xs[i] / 255) * w;
    const y = h - (ys[i] / 255) * h;
    _curveGraphCtx.beginPath(); _curveGraphCtx.arc(x, y, 3, 0, Math.PI * 2); _curveGraphCtx.fill();
  }
}
const _curvesDlg = _setupTabbedFilterDialog({
  dialog: $id("curvesDialog"),
  backdrop: $id("curvesBackdrop"),
  preview: $id("curvesPreview"),
  applyBtn: $id("curvesApply"),
  cancelBtn: $id("curvesCancel"),
  resetBtn: $id("curvesReset"),
  tabNavId: "curvesTabNav",
  tabKeys: [
    { key: "master", label: "Master" },
    { key: "r", label: "R" },
    { key: "g", label: "G" },
    { key: "b", label: "B" },
  ],
  sliders: [
    { input: $id("cvY32"),  label: $id("cvY32Val"),  key: "y32",  default: 32,  format: (v) => `${v | 0}` },
    { input: $id("cvY64"),  label: $id("cvY64Val"),  key: "y64",  default: 64,  format: (v) => `${v | 0}` },
    { input: $id("cvY128"), label: $id("cvY128Val"), key: "y128", default: 128, format: (v) => `${v | 0}` },
    { input: $id("cvY192"), label: $id("cvY192Val"), key: "y192", default: 192, format: (v) => `${v | 0}` },
    { input: $id("cvY224"), label: $id("cvY224Val"), key: "y224", default: 224, format: (v) => `${v | 0}` },
  ],
  applyFn: (id, p) => {
    // p = { master: {y32,y64,y128,y192,y224}, r: {...}, ... }
    // 转成 applyCurves V2 接受的 {master: [array], r: [array], ...} 形式
    const conv = (o) => o ? [o.y32, o.y64, o.y128, o.y192, o.y224] : null;
    return applyCurves(id, { master: conv(p.master), r: conv(p.r), g: conv(p.g), b: conv(p.b) });
  },
  onUpdate: (params, activeTab) => _drawCurveGraphForTab(params[activeTab], activeTab),
  busyLabel: "Applying curves…",
});
$id("imgCurves").addEventListener("click", () => _curvesDlg.open());

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

// ----- Busy overlay：长操作期间锁 UI 防误触 -----
// 加密 / 解密 / 大 zip 解包 / 云拉，主线程会卡 1-3 秒，必须挡住所有点击。
// 用 depth 计数支持嵌套调用（e.g. openSessionByPath → applyAtlasZipBlob 各自 wrap）。
const busyOverlay = document.getElementById("busyOverlay");
const busyLabel = document.getElementById("busyLabel");
let _busyDepth = 0;
function showBusy(label = "Working…") {
  _busyDepth++;
  busyLabel.textContent = label;
  busyOverlay.classList.remove("hidden");
}
function hideBusy() {
  _busyDepth = Math.max(0, _busyDepth - 1);
  if (_busyDepth === 0) busyOverlay.classList.add("hidden");
}
async function withBusy(label, fn) {
  showBusy(label);
  // 让 overlay 真的绘出来再开干 —— double rAF 是必须的：
  //   单 rAF 的 callback 在「下一帧 paint 前」触发，立刻 microtask resolve → fn 同步堵主线程
  //   → paint 永远没机会发生。double rAF 等过一个完整 paint 周期再跑 fn。
  await new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));
  try { return await fn(); }
  finally { hideBusy(); }
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
  onPaste: (m) => smartPasteFromMeasured(m),
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
    onSave: () => saveCurrentSession({ explicit: true }),
    onSaveLocal: () => saveCurrentSession({ explicit: true, skipCloud: true }),
    onCopy: () => copySelectedImageToClipboard(),
    onEyedropper: ({ obj, clientX, clientY }) => handleEyedropper({ obj, clientX, clientY }),
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
          // 复制 = 完全独立。新 src（zip 路径必须唯一）+ 新 Blob 对象（独立字节副本）。
          // Blob 共享虽然 immutable 安全 + 内存友好，但 user vision 是"如果出现两次，存两边"，
          // 不想未来某次 lifecycle / cleanup 把一个引用 revoke 影响到另一个、也不想 memory profiler
          // 看到「两个 obj 一个 blob」这种含糊状态。`new Blob([blob], {type})` 同步深拷贝字节。
          const copy = { ...src };
          delete copy.id;
          copy._displayUrl = null;
          if (copy.type === "image" && copy.blob) {
            copy.blob = new Blob([copy.blob], { type: copy.blob.type });
            copy.src = _newImageSrc(copy.blob);
          }
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
  if (crop.isActive()) {
    renderCropOverlay();
    return;
  }
  if (_perspState) {
    renderPerspectiveOverlay();
    return;
  }
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

// ----- Crop 4-gizmo 模式 -----
// 状态 + DOM 由 crop.js 管，但 DOM 渲染（overlayEl 里）+ pointer 拖拽在这里。
// 进 mode 时 _cropDom 创建一次；renderCropOverlay 只 update 位置。退出时 _cropDom 拆。
let _cropDom = null;   // { rectEl, handles: {nw,n,ne,e,se,s,sw,w}, dimT, dimR, dimB, dimL }
let _cropDragState = null; // { anchor, startRect, startWorld }
const cropToolbar = document.getElementById("cropToolbar");

function _buildCropDom() {
  const dimT = document.createElement("div"); dimT.className = "crop-dim"; overlayEl.appendChild(dimT);
  const dimR = document.createElement("div"); dimR.className = "crop-dim"; overlayEl.appendChild(dimR);
  const dimB = document.createElement("div"); dimB.className = "crop-dim"; overlayEl.appendChild(dimB);
  const dimL = document.createElement("div"); dimL.className = "crop-dim"; overlayEl.appendChild(dimL);
  const rectEl = document.createElement("div"); rectEl.className = "crop-rect"; overlayEl.appendChild(rectEl);
  const handles = {};
  for (const a of ["nw", "n", "ne", "e", "se", "s", "sw", "w"]) {
    const h = document.createElement("div");
    h.className = `crop-handle h-${a}`;
    h.dataset.anchor = a;
    h.addEventListener("pointerdown", onCropHandlePointerDown);
    overlayEl.appendChild(h);
    handles[a] = h;
  }
  return { dimT, dimR, dimB, dimL, rectEl, handles };
}

// Crop 模式期间「往回拉」支持：
//   如果 obj 已有 crop → temp-expand obj 到 full natural（直接 mutate，不走 scene.act 不 dirty），
//   bounds 设为 expanded full、initialRect 设为 orig 可见区域。用户可拖 handle 向外，到极限就是 uncrop。
//   Apply / Cancel 时把 obj 状态恢复 / 替换，scene.act 在「恢复后」take snapshot → undo 回正确旧态。
let _cropOrig = null;

function _silentMutateObj(obj, patch) {
  Object.assign(obj, patch);
  scene._applyTransform(obj);
}
function _restoreCropOrig(obj) {
  if (!_cropOrig) return;
  _silentMutateObj(obj, {
    x: _cropOrig.x, y: _cropOrig.y, w: _cropOrig.w, h: _cropOrig.h,
    crop: _cropOrig.crop,
  });
}

function enterCropMode(obj) {
  // 已在 crop mode 时再点 Crop = no-op，否则 _cropOrig 会被「已 expanded 的状态」覆盖
  // → cancel 时恢复成 expanded 状态 → 用户感觉「双击 Crop 把 crop reset 了」。
  if (crop.isActive()) return;
  if ((obj.rotation && Math.abs(obj.rotation) > 0.01) || obj.flipH || obj.flipV) {
    showActionToast("Crop doesn't support rotated / flipped images yet — reset rotation / flip first.", 4500);
    return;
  }
  _cropOrig = {
    crop: obj.crop ? { ...obj.crop } : undefined,
    x: obj.x, y: obj.y, w: obj.w, h: obj.h,
  };
  let bounds, initialRect;
  if (obj.crop) {
    // Temp uncrop：展开到 full natural，旧 visible 区域留在原 world 位置（让 initialRect 默认就是原可见）
    const oldCrop = obj.crop;
    const wpnX = obj.w / oldCrop.w;
    const wpnY = obj.h / oldCrop.h;
    const fullW = obj.naturalW * wpnX;
    const fullH = obj.naturalH * wpnY;
    const fullX = obj.x - oldCrop.x * wpnX;
    const fullY = obj.y - oldCrop.y * wpnY;
    _silentMutateObj(obj, { x: fullX, y: fullY, w: fullW, h: fullH, crop: undefined });
    bounds = { x: fullX, y: fullY, w: fullW, h: fullH };
    initialRect = { x: _cropOrig.x, y: _cropOrig.y, w: _cropOrig.w, h: _cropOrig.h };
  }
  crop.start({
    obj,
    bounds,
    initialRect,
    onChange: () => { renderOverlay(); _cropUpdateDimsLabel(); },
    onApply: ({ rect }) => doApplyCrop(obj.id, rect),
    onCancel: () => exitCropMode({ restoreOrig: true }),
  });
  overlayEl.innerHTML = "";
  _cropDom = _buildCropDom();
  cropToolbar.classList.remove("hidden");
  if (cropAspectSelect) cropAspectSelect.value = "free"; // 进 mode 默认 Free
  document.body.dataset.cropMode = "1";
  renderOverlay();
  _cropUpdateDimsLabel();
}

// aspect select 变化 → 强制 crop rect 按新 ratio 调整（对当前 rect 做 setRect 触发 clamp + onChange）
if (cropAspectSelect) {
  cropAspectSelect.addEventListener("change", () => {
    const r = crop.getRect();
    if (!r) return;
    const ar = _cropTargetAspect();
    if (!ar) { _cropUpdateDimsLabel(); return; }
    // 围绕 rect 中心按新 ratio 调整：保 max(w, h)，让 H = W/AR 或 W = H*AR 取小的，居中
    const cx = r.x + r.w / 2, cy = r.y + r.h / 2;
    let newW = r.w, newH = r.w / ar;
    if (newH > r.h) { newH = r.h; newW = r.h * ar; }
    crop.setRect({ x: cx - newW / 2, y: cy - newH / 2, w: newW, h: newH });
  });
}

function exitCropMode({ restoreOrig = false } = {}) {
  if (restoreOrig && _cropOrig) {
    const obj = scene.get(crop.activeObjId());
    if (obj) _restoreCropOrig(obj);
  }
  _cropOrig = null;
  if (_cropDom) overlayEl.innerHTML = "";
  _cropDom = null;
  cropToolbar.classList.add("hidden");
  delete document.body.dataset.cropMode;
  renderOverlay();
}

function doApplyCrop(objId, rect) {
  const obj = scene.get(objId);
  if (!obj) { exitCropMode(); return; }
  // 1) 在当前（可能 temp-expand 过的）坐标系下算 newState
  const out = crop.applyCropMath(obj, rect);
  // 用户拖回全图 → crop 完全 = natural 全图 → 标准化为 undefined（数据更干净）
  const isFullCrop = (
    Math.abs(out.crop.x) < 0.5 &&
    Math.abs(out.crop.y) < 0.5 &&
    Math.abs(out.crop.w - obj.naturalW) < 1 &&
    Math.abs(out.crop.h - obj.naturalH) < 1
  );
  const finalCrop = isFullCrop ? undefined : out.crop;
  // 2) 静默恢复 orig → scene.act 的 snapshot 抓到 orig
  if (_cropOrig) _restoreCropOrig(obj);
  // 3) 把 new state 通过 act 应用 → undo 回 orig
  scene.act(() => {
    scene.update(objId, { x: out.x, y: out.y, w: out.w, h: out.h, crop: finalCrop });
  });
  exitCropMode();
}

function renderCropOverlay() {
  if (!_cropDom) return;
  const rect = crop.getRect();
  const bounds = crop.getBounds();
  if (!rect || !bounds) return;
  const br = boardEl.getBoundingClientRect();
  // 把 world 矩形转屏幕 px（相对 overlayEl/boardEl）
  const r = boardRectToScreen(rect, br);
  const b = boardRectToScreen(bounds, br);
  // dim 四块（包住 b 范围、留空 r 范围）
  _cropDom.dimT.style.left = `${b.x}px`;
  _cropDom.dimT.style.top = `${b.y}px`;
  _cropDom.dimT.style.width = `${b.w}px`;
  _cropDom.dimT.style.height = `${Math.max(0, r.y - b.y)}px`;
  _cropDom.dimB.style.left = `${b.x}px`;
  _cropDom.dimB.style.top = `${r.y + r.h}px`;
  _cropDom.dimB.style.width = `${b.w}px`;
  _cropDom.dimB.style.height = `${Math.max(0, b.y + b.h - (r.y + r.h))}px`;
  _cropDom.dimL.style.left = `${b.x}px`;
  _cropDom.dimL.style.top = `${r.y}px`;
  _cropDom.dimL.style.width = `${Math.max(0, r.x - b.x)}px`;
  _cropDom.dimL.style.height = `${r.h}px`;
  _cropDom.dimR.style.left = `${r.x + r.w}px`;
  _cropDom.dimR.style.top = `${r.y}px`;
  _cropDom.dimR.style.width = `${Math.max(0, b.x + b.w - (r.x + r.w))}px`;
  _cropDom.dimR.style.height = `${r.h}px`;
  // 边框
  _cropDom.rectEl.style.left = `${r.x}px`;
  _cropDom.rectEl.style.top = `${r.y}px`;
  _cropDom.rectEl.style.width = `${r.w}px`;
  _cropDom.rectEl.style.height = `${r.h}px`;
  // 8 handle（screen px 定位，margin-left/top -6px 居中）
  const cx = r.x + r.w / 2;
  const cy = r.y + r.h / 2;
  const right = r.x + r.w;
  const bot = r.y + r.h;
  const place = (a, x, y) => {
    const h = _cropDom.handles[a];
    h.style.left = `${x}px`;
    h.style.top = `${y}px`;
  };
  place("nw", r.x, r.y);
  place("n",  cx,  r.y);
  place("ne", right, r.y);
  place("e",  right, cy);
  place("se", right, bot);
  place("s",  cx,  bot);
  place("sw", r.x, bot);
  place("w",  r.x, cy);
}

function boardRectToScreen(rectWorld, br) {
  const a = board.worldToScreen(rectWorld.x, rectWorld.y);
  const b = board.worldToScreen(rectWorld.x + rectWorld.w, rectWorld.y + rectWorld.h);
  return { x: a.x - br.left, y: a.y - br.top, w: b.x - a.x, h: b.y - a.y };
}

function onCropHandlePointerDown(ev) {
  ev.preventDefault();
  ev.stopPropagation();
  const anchor = ev.currentTarget.dataset.anchor;
  const startRect = crop.getRect();
  const startWorld = board.screenToWorld(ev.clientX, ev.clientY);
  _cropDragState = { anchor, startRect, startWorld, handleEl: ev.currentTarget };
  try { ev.currentTarget.setPointerCapture(ev.pointerId); } catch (_) {}
  ev.currentTarget.addEventListener("pointermove", onCropHandlePointerMove);
  ev.currentTarget.addEventListener("pointerup", onCropHandlePointerUp);
  ev.currentTarget.addEventListener("pointercancel", onCropHandlePointerUp);
}
// Crop aspect lock：toolbar 下拉 + dims label。Free / 1:1 / 16:9 等 / Original（= obj natural aspect）。
// Aspect 非 free 时拖 handle 强制按 ratio 调整对边；输出 ratio = W / H。
const cropAspectSelect = document.getElementById("cropAspect");
const cropDimsLabel = document.getElementById("cropDimsLabel");
function _cropTargetAspect() {
  if (!_cropOrig || !cropAspectSelect) return null;
  const v = cropAspectSelect.value || "free";
  if (v === "free") return null;
  if (v === "original") {
    // 原图 natural aspect
    const obj = scene.get(crop.activeObjId());
    if (!obj) return null;
    return obj.naturalW / obj.naturalH;
  }
  const [a, b] = v.split(":").map(Number);
  if (!a || !b) return null;
  return a / b;
}
function _cropUpdateDimsLabel() {
  if (!cropDimsLabel) return;
  const rect = crop.getRect();
  const objId = crop.activeObjId();
  const obj = scene.get(objId);
  if (!rect || !obj) { cropDimsLabel.textContent = "— × — px"; return; }
  // dims in natural px（rect 是世界坐标，按 obj.w/h ↔ naturalW/H 比例转）
  // 注意：obj 在 crop mode 已经 temp-expanded 到 full natural（如果之前 cropped），
  // 所以 obj.naturalW / obj.w = natural per world
  const wpnX = obj.w / obj.naturalW;
  const wpnY = obj.h / obj.naturalH;
  const natW = Math.round(rect.w / wpnX);
  const natH = Math.round(rect.h / wpnY);
  cropDimsLabel.textContent = `${natW} × ${natH} px`;
}

function onCropHandlePointerMove(ev) {
  if (!_cropDragState) return;
  const s = _cropDragState;
  const w = board.screenToWorld(ev.clientX, ev.clientY);
  const dx = w.x - s.startWorld.x;
  const dy = w.y - s.startWorld.y;
  let { x, y, w: rw, h: rh } = s.startRect;
  // 按 anchor 决定哪边动
  if (s.anchor.includes("n")) { y += dy; rh -= dy; }
  if (s.anchor.includes("s")) { rh += dy; }
  if (s.anchor.includes("w")) { x += dx; rw -= dx; }
  if (s.anchor.includes("e")) { rw += dx; }
  // Aspect lock：拖完之后按比例修副轴。corner = 跟手主导轴长一点的；edge = 锁那一轴
  const targetAR = _cropTargetAspect();
  if (targetAR) {
    const cornerH = s.anchor.includes("n") || s.anchor.includes("s");
    const cornerV = s.anchor.includes("e") || s.anchor.includes("w");
    if (cornerH && cornerV) {
      // 角：W 跟手，H = W / AR；保持当前 anchor 固定（对边不动）
      const newH = rw / targetAR;
      const fixedSide = s.anchor.includes("n") ? "bottom" : "top";
      if (fixedSide === "bottom") {
        const bottom = s.startRect.y + s.startRect.h;
        y = bottom - newH;
      }
      rh = newH;
    } else if (cornerV) {
      // 左 / 右 边：W 已经跟手 → H = W / AR；H 居中调（顶 + 底 各一半）
      const oldH = rh;
      rh = rw / targetAR;
      y -= (rh - oldH) / 2;
    } else {
      // 上 / 下 边：H 已经跟手 → W = H × AR；W 居中调
      const oldW = rw;
      rw = rh * targetAR;
      x -= (rw - oldW) / 2;
    }
  }
  crop.setRect({ x, y, w: rw, h: rh });
}
function onCropHandlePointerUp(ev) {
  if (!_cropDragState) return;
  const h = _cropDragState.handleEl;
  try { h.releasePointerCapture(ev.pointerId); } catch (_) {}
  h.removeEventListener("pointermove", onCropHandlePointerMove);
  h.removeEventListener("pointerup", onCropHandlePointerUp);
  h.removeEventListener("pointercancel", onCropHandlePointerUp);
  _cropDragState = null;
}

// 入口：image panel 的 Crop / Reset crop 按钮
document.getElementById("imgCrop").addEventListener("click", () => {
  const sel = scene.firstSelected();
  if (!sel || sel.type !== "image") {
    showActionToast("Select an image to crop", 3000);
    return;
  }
  enterCropMode(sel);
});
document.getElementById("imgResetCrop").addEventListener("click", () => {
  const sel = scene.firstSelected();
  if (!sel || sel.type !== "image") return;
  if (!sel.crop) { showActionToast("No crop to reset"); return; }
  // Reset crop = obj.w/h 应该恢复到「full image 在当前 scale 下」
  // 当前 scale = obj.w / sel.crop.w （世界 px per natural px）
  const sx = sel.w / sel.crop.w;
  const sy = sel.h / sel.crop.h;
  const newW = sel.naturalW * sx;
  const newH = sel.naturalH * sy;
  // 新 top-left = 当前 top-left - (crop.x * sx, crop.y * sy)
  const newX = sel.x - sel.crop.x * sx;
  const newY = sel.y - sel.crop.y * sy;
  scene.act(() => {
    scene.update(sel.id, { x: newX, y: newY, w: newW, h: newH, crop: undefined });
  });
});

// 底部 toolbar
document.getElementById("cropApply").addEventListener("click", () => crop.commit());
document.getElementById("cropCancel").addEventListener("click", () => crop.cancel());

// Enter / Esc 退 crop mode（在 crop mode 才生效）
window.addEventListener("keydown", (ev) => {
  if (!crop.isActive()) return;
  // 忽略 focus 在 input/textarea 的情况
  const t = ev.target;
  if (t && (t.tagName === "INPUT" || t.tagName === "TEXTAREA" || t.isContentEditable)) return;
  if (ev.key === "Enter") { ev.preventDefault(); crop.commit(); }
  else if (ev.key === "Escape") { ev.preventDefault(); crop.cancel(); }
}, true);

// ----- Perspective 4-point fix 模式 -----
// 4 个 handle 标 source quad 的 4 个角（NW, NE, SE, SW）→ Apply 算 homography → 全分辨率 inverse-warp 烤新 blob
// 跟 crop 同款 mode lifecycle，只是数学不一样。MVP 要求 obj 无 rotation/flip/crop（用同一个 reset toast）。
let _perspState = null;  // { objId, corners[4]={x,y world}, svgEl, lineEl, handles[4] }
let _perspDragState = null;
const perspToolbar = document.getElementById("perspToolbar");
const perspWInput = document.getElementById("perspW");
const perspHInput = document.getElementById("perspH");

function _perspNaturalQuad(obj, cornersWorld) {
  // obj 无 rotation/flip/crop（mode 进入时保证）→ 简单线性映射 world → natural
  const sx = obj.naturalW / obj.w;
  const sy = obj.naturalH / obj.h;
  return cornersWorld.map((c) => ({ x: (c.x - obj.x) * sx, y: (c.y - obj.y) * sy }));
}

function _perspUpdateAutoSize() {
  if (!_perspState) return;
  const obj = scene.get(_perspState.objId);
  if (!obj) return;
  const nat = _perspNaturalQuad(obj, _perspState.corners);
  const est = estimateOutputSize(nat);
  perspWInput.value = est.w;
  perspHInput.value = est.h;
}

function enterPerspectiveMode(obj) {
  if (crop.isActive()) return;
  if ((obj.rotation && Math.abs(obj.rotation) > 0.01) || obj.flipH || obj.flipV || obj.crop) {
    showActionToast("Perspective needs the image with no rotation / flip / crop — reset first (or Rasterize to bake them).", 5500);
    return;
  }
  // 初始 4 个角放在 obj bbox 4 个角（用户拖到照片里那个矩形的实际角）
  _perspState = {
    objId: obj.id,
    corners: [
      { x: obj.x,         y: obj.y         }, // NW
      { x: obj.x + obj.w, y: obj.y         }, // NE
      { x: obj.x + obj.w, y: obj.y + obj.h }, // SE
      { x: obj.x,         y: obj.y + obj.h }, // SW
    ],
    svgEl: null, lineEl: null, handles: [],
  };
  // 在 overlay 里画 SVG + 4 handles
  overlayEl.innerHTML = "";
  const svgNS = "http://www.w3.org/2000/svg";
  const svg = document.createElementNS(svgNS, "svg");
  svg.setAttribute("class", "persp-svg");
  const poly = document.createElementNS(svgNS, "polygon");
  poly.setAttribute("class", "persp-line");
  svg.appendChild(poly);
  overlayEl.appendChild(svg);
  _perspState.svgEl = svg;
  _perspState.lineEl = poly;
  for (let i = 0; i < 4; i++) {
    const h = document.createElement("div");
    h.className = "persp-handle";
    h.dataset.idx = i;
    h.addEventListener("pointerdown", onPerspHandlePointerDown);
    overlayEl.appendChild(h);
    _perspState.handles.push(h);
  }
  perspToolbar.classList.remove("hidden");
  document.body.dataset.cropMode = "1"; // 复用 crop 的 input lock (禁误点别 obj)
  _perspUpdateAutoSize();
  renderOverlay();
}

function exitPerspectiveMode() {
  _perspState = null;
  overlayEl.innerHTML = "";
  perspToolbar.classList.add("hidden");
  delete document.body.dataset.cropMode;
  renderOverlay();
}

function renderPerspectiveOverlay() {
  if (!_perspState) return;
  const obj = scene.get(_perspState.objId);
  if (!obj) { exitPerspectiveMode(); return; }
  const br = boardEl.getBoundingClientRect();
  const pts = _perspState.corners.map((c) => {
    const s = board.worldToScreen(c.x, c.y);
    return { x: s.x - br.left, y: s.y - br.top };
  });
  // polygon points
  _perspState.lineEl.setAttribute("points", pts.map((p) => `${p.x},${p.y}`).join(" "));
  // 4 handles
  for (let i = 0; i < 4; i++) {
    _perspState.handles[i].style.left = `${pts[i].x}px`;
    _perspState.handles[i].style.top  = `${pts[i].y}px`;
  }
}

function onPerspHandlePointerDown(ev) {
  ev.preventDefault();
  ev.stopPropagation();
  const idx = parseInt(ev.currentTarget.dataset.idx, 10);
  _perspDragState = {
    idx,
    startWorld: board.screenToWorld(ev.clientX, ev.clientY),
    startCorner: { ..._perspState.corners[idx] },
    handleEl: ev.currentTarget,
  };
  try { ev.currentTarget.setPointerCapture(ev.pointerId); } catch (_) {}
  ev.currentTarget.addEventListener("pointermove", onPerspHandlePointerMove);
  ev.currentTarget.addEventListener("pointerup", onPerspHandlePointerUp);
  ev.currentTarget.addEventListener("pointercancel", onPerspHandlePointerUp);
}
function onPerspHandlePointerMove(ev) {
  if (!_perspDragState) return;
  const s = _perspDragState;
  const w = board.screenToWorld(ev.clientX, ev.clientY);
  _perspState.corners[s.idx] = {
    x: s.startCorner.x + (w.x - s.startWorld.x),
    y: s.startCorner.y + (w.y - s.startWorld.y),
  };
  _perspUpdateAutoSize();
  renderOverlay();
}
function onPerspHandlePointerUp(ev) {
  if (!_perspDragState) return;
  const h = _perspDragState.handleEl;
  try { h.releasePointerCapture(ev.pointerId); } catch (_) {}
  h.removeEventListener("pointermove", onPerspHandlePointerMove);
  h.removeEventListener("pointerup", onPerspHandlePointerUp);
  h.removeEventListener("pointercancel", onPerspHandlePointerUp);
  _perspDragState = null;
}

// Apply：算 homography + bake + replaceImageBlob
async function applyPerspective() {
  if (!_perspState) return;
  const obj = scene.get(_perspState.objId);
  if (!obj || !obj.blob) { exitPerspectiveMode(); return; }
  const outW = parseInt(perspWInput.value, 10) || 0;
  const outH = parseInt(perspHInput.value, 10) || 0;
  if (outW < 1 || outH < 1) {
    showActionToast("Invalid output dimensions", 3000);
    return;
  }
  const natQuad = _perspNaturalQuad(obj, _perspState.corners);
  const objId = obj.id;
  exitPerspectiveMode();
  try {
    const newBlob = await withBusy(`Perspective fix → ${outW}×${outH}…`, () =>
      bakePerspective(obj.blob, natQuad, outW, outH)
    );
    const newSrc = _newImageSrc(newBlob);
    // 新 obj：保持 world 左上角 + 横向世界宽不变；高 = 按新 aspect 算；natural = 输出尺寸
    const aspect = outW / outH;
    const newWWorld = obj.w;
    const newHWorld = obj.w / aspect;
    scene.act(() => {
      scene.replaceImageBlob(objId, newBlob, newSrc);
      scene.update(objId, { naturalW: outW, naturalH: outH, h: newHWorld });
    });
    showActionToast(`Perspective fixed → ${outW}×${outH}`);
  } catch (e) {
    console.warn("perspective failed", e);
    showActionToast(`Perspective failed: ${e.message || e}`, 5000);
  }
}

document.getElementById("imgPerspective").addEventListener("click", () => {
  const sel = scene.firstSelected();
  if (!sel || sel.type !== "image") { showActionToast("Select an image first", 2500); return; }
  enterPerspectiveMode(sel);
});
document.getElementById("perspApply").addEventListener("click", () => applyPerspective());
document.getElementById("perspCancel").addEventListener("click", () => exitPerspectiveMode());

// Enter / Esc 退 perspective mode
window.addEventListener("keydown", (ev) => {
  if (!_perspState) return;
  const t = ev.target;
  if (t && (t.tagName === "INPUT" || t.tagName === "TEXTAREA" || t.isContentEditable)) return;
  if (ev.key === "Enter") { ev.preventDefault(); applyPerspective(); }
  else if (ev.key === "Escape") { ev.preventDefault(); exitPerspectiveMode(); }
}, true);

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
    // 烤进所有非破坏视觉效果：filter / flip / crop（不烤 = 输出和屏幕看到的不一致 = bug）
    const fs = obj.filters ? filtersToCssString(obj.filters) : "";
    ctx.save();
    if (fs) ctx.filter = fs;
    ctx.translate(dxCenter, dyCenter);
    if (relRotRad) ctx.rotate(relRotRad);
    if (obj.flipH || obj.flipV) ctx.scale(obj.flipH ? -1 : 1, obj.flipV ? -1 : 1);
    // crop = drawImage 的 source rect（natural px）；没 crop = 整张
    const c = obj.crop || { x: 0, y: 0, w: obj.naturalW || bitmap.width, h: obj.naturalH || bitmap.height };
    try { ctx.drawImage(bitmap, c.x, c.y, c.w, c.h, -dw / 2, -dh / 2, dw, dh); } catch (_) {}
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
// 0.10.6：cloudPill 移除 —— save 按钮的 5 态 icon 已经传达云端状态，pill 是多余信息。
// Sign in / out 进汉堡菜单 #menuCloudAuth，label 跟 state 同步。

const menuCloudAuthLabel = document.getElementById("menuCloudAuthLabel");
function refreshCloudUI() {
  // save 按钮 icon / title 由 updateSaveBtnState 统一管（5 态视觉传达状态）
  updateSaveBtnState();
  // 汉堡菜单 sign in/out label
  if (menuCloudAuthLabel) {
    if (!cloud.isAuthConfigured()) {
      menuCloudAuthLabel.textContent = "OneDrive not configured";
    } else if (cloud.isSignedIn()) {
      const acc = cloud.getActiveAccount();
      const tag = (acc?.username || acc?.name || "").replace(/@.*/, "");
      menuCloudAuthLabel.textContent = `Sign out (${tag})`;
    } else {
      menuCloudAuthLabel.textContent = "Sign in to OneDrive";
    }
  }
}

document.getElementById("menuCloudAuth").addEventListener("click", async () => {
  closeHamburger();
  if (!cloud.isAuthConfigured()) {
    showActionToast("OneDrive not configured — set CLIENT_ID in src/config.js", 5000);
    return;
  }
  if (cloud.isSignedIn()) {
    if (!confirm("Sign out of OneDrive? Local data is preserved.")) return;
    await cloud.signOut();
    refreshCloudUI();
    showActionToast("Signed out of OneDrive");
  } else {
    showActionToast("Signing in to OneDrive…", 3000);
    try { await cloud.signIn(); /* 跳转登录 */ }
    catch (e) {
      refreshCloudUI();
      showActionToast(`Sign-in failed: ${e.message}`, 4000);
    }
  }
});

// 云按钮 = "完全保存"，走和 Ctrl+S 同一条路径（不分 explicit / 隐式两套）。
// 不登录时按钮其实 disabled，所以 saveCurrentSession 里的 fallback 不会到 "Saved locally" 这种 toast。
cloudPushBtn.addEventListener("click", () => saveCurrentSession({ explicit: true }));

// 注：cloudPullBtn 已删（pull 不再是顶栏 first-class 行为）。
// 进入 cloud-only session 走 gallery 里的 tile 点击 → pullSessionFromCloudAndOpen（拉 + 切到那个 session）。
// 想「拉云覆盖当前」的场景：在 gallery 里删本地后单击云端 tile 即等价。

// 启动时尝试 MSAL init + 处理可能的 redirect 回调
// 飞行模式 → 在线后 silent retry：boot 时离线 silent 抛错 → activeAccount=null →
// isSignedIn() 永远 false 直到下次重启。online 事件回来时重试一次。
window.addEventListener("online", async () => {
  if (!cloud.isSignedIn()) await cloud.retrySilentSignIn();
  refreshCloudUI();
});

cloud.initAuth().then(() => refreshCloudUI()).catch((e) => {
  console.warn("OneDrive init failed:", e);
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
    const base = fp ? fp.split(/[\\/]/).pop() : "(unsaved)";
    btpLabel.textContent = `Blender · ${base}`;
    btpPill.title = `Connected to Blender (click to re-probe)\n${fp || "(unsaved .blend)"}`;
  } else if (btp.state === "connecting") {
    btpLabel.textContent = "Blender · probing";
    btpPill.title = "Probing…";
  } else if (btp.state === "disconnected") {
    btpLabel.textContent = "Blender · disconnected";
    btpPill.title = `Blender unreachable\n${btp.lastError ? (btp.lastError.message || btp.lastError) : ""}\nClick to retry`;
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
// 「Reload」按钮（toast）：必须推给 `reg.waiting`（新 SW），不是 `controller`（旧 SW）。
// 旧 SW 收到 skip-waiting 自己已经 active 是 no-op；新 SW 永远卡 waiting；reload 又拿旧 cache → 死循环
// 报「有新版本」。听 controllerchange 等新 SW 接管再 reload，没等到 5s 兜底。
// (WebPaint v60 教训：[WebPaint/docs/pwa-update-detection.md §4.5])
document.getElementById("updateReloadButton").addEventListener("click", async () => {
  const reg = _swRegistration || (await navigator.serviceWorker?.getRegistration());
  if (!reg || !reg.waiting) { location.reload(); return; }
  let reloaded = false;
  const doReload = () => { if (reloaded) return; reloaded = true; location.reload(); };
  navigator.serviceWorker.addEventListener("controllerchange", doReload, { once: true });
  reg.waiting.postMessage({ type: "skip-waiting" });
  setTimeout(doReload, 5000);
});
document.getElementById("updateDismissButton").addEventListener("click", () => {
  updateDismissed = true;
  document.getElementById("updateToast").classList.add("hidden");
});

// SW 注册必须在**模块顶层**，不能 window.load —— 模块 dynamic import 异步，load 经常已 fire 完
// → addEventListener("load",...) 永远不触发 → SW 根本没装 → iPad PWA 加主屏 + 飞行模式 = 找不到 server
// (v58 WebPaint 教训：[WebPaint/docs/pwa-update-detection.md §0](../../WebPaint/docs/pwa-update-detection.md))
let _swRegistration = null;
if ("serviceWorker" in navigator && !LOCAL_DEV_HOSTS.has(location.hostname)) {
  // 路径 3：SW 主动告知 asset 变了
  navigator.serviceWorker.addEventListener("message", (e) => {
    if (e.data?.type === "asset-updated") showUpdate();
  });
  navigator.serviceWorker.register("./service-worker.js").then((registration) => {
    _swRegistration = registration;
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
  }).catch((err) => { console.warn("SW register failed", err); });
}

// 手动「检测更新」菜单项：用 _swRegistration（iPad save-to-home-screen 模式下
// getRegistration() 偶尔返 undefined，启动时存的 reg 更稳）。返回信息带版本号闭环。
const menuCheckUpdate = document.getElementById("menuCheckUpdate");
if (menuCheckUpdate) menuCheckUpdate.addEventListener("click", async () => {
  closeHamburger();
  showActionToast("Checking for updates…", 4000);
  try {
    const reg = _swRegistration || (await navigator.serviceWorker?.getRegistration());
    if (!reg) { showActionToast("Service Worker not registered (reload the page)", 5000); return; }
    await reg.update();
    setTimeout(() => {
      const v = self.ATLASMAKER_VERSION || window.ATLASMAKER_VERSION || "v?";
      if (reg.waiting) showActionToast("New version available — click reload in the toast", 6000);
      else showActionToast(`Up to date (${v})`, 4000);
    }, 1500);
  } catch (e) {
    showActionToast("Check failed: " + (e?.message || e), 5000);
  }
});

refreshHud();
renderOverlay();
updateSaveBtnState();

// 启动时尝试从 IDB 恢复上次 session
loadCurrentSession().then((ok) => {
  if (ok) {
    const path = getCurrentPath();
    _activeIDBPath = path;
    _activeCloudPath = path;
  }
}).catch(async (e) => {
  console.warn("初始加载失败", e);
  // 关键修复：boot 时 apply 失败（最常见 = 加密 session 被取消密码）
  // _activeIDBPath 还指向那个加密 path → 用户随便改一下 → save 会把它当 rename → **删除加密 session** = 数据丢
  // 对偶 bug：fallback 到「Untitled」如果已被一个真 session 占着 → 用户随手画 → 覆盖那个 session
  // → 用 findFreshSlotPath 找一个空 slot ("Untitled" / "Untitled 2" / ...)。
  // localStorage currentPath 保留 = 下次 boot 仍试着加载原来的（让用户能重试）。
  const lastPath = getCurrentPath();
  const safePath = await findFreshSlotPath();
  _activeIDBPath = safePath;
  _activeCloudPath = null;
  sessionInput.value = stemOfPath(safePath);
  applySessionTitle();
  if (e && e.message && e.message.includes("cancelled")) {
    showActionToast(`Last session "${stemOfPath(lastPath)}" needs a password and didn't load. Reopen it from the session list to retry.`, 8000);
  }
});

// ----- Ctrl+C 复制选中图片到系统剪贴板（让 AtlasMaker 也能当图版用）-----
async function blobToPng(blob) {
  if (blob.type === "image/png") return blob;
  const bitmap = await createImageBitmap(blob);
  const canvas = document.createElement("canvas");
  canvas.width = bitmap.width;
  canvas.height = bitmap.height;
  canvas.getContext("2d").drawImage(bitmap, 0, 0);
  bitmap.close();
  return await new Promise((res) => canvas.toBlob(res, "image/png"));
}

async function copySelectedImageToClipboard() {
  const sel = scene.firstSelected();
  if (!sel || sel.type !== "image") {
    showActionToast("Select an image first, then Ctrl+C to copy", 3000);
    return;
  }
  if (!sel.blob) { showActionToast("Image data missing"); return; }
  try {
    const png = await blobToPng(sel.blob);
    await navigator.clipboard.write([new ClipboardItem({ "image/png": png })]);
    showActionToast("Copied image to clipboard");
  } catch (e) {
    showActionToast(`Copy failed: ${e.message || e}`, 4000);
  }
}

// 从系统剪贴板读一张图（用于 Ctrl+Shift+V / iPad paste 按钮）。
// 浏览器 paste 事件路径靠 ev.clipboardData；这里是「不依赖 keypress 的 paste」路径，
// 用 navigator.clipboard.read() —— 用户首次会有权限提示。
async function readClipboardImageBlob() {
  if (!navigator.clipboard || !navigator.clipboard.read) return null;
  let items;
  try { items = await navigator.clipboard.read(); }
  catch (e) { showActionToast(`Clipboard read failed: ${e.message || e}`, 3000); return null; }
  for (const it of items) {
    for (const type of it.types) {
      if (type.startsWith("image/")) {
        try { return await it.getType(type); } catch (_) {}
      }
    }
  }
  return null;
}

// 生成 in-zip 路径："images/<uuid>.<ext>"
function _newImageSrc(blob) {
  const ext = (blob.type && blob.type.includes("jpeg")) ? "jpg" : "png";
  const uid = (typeof crypto !== "undefined" && crypto.randomUUID)
    ? crypto.randomUUID()
    : `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
  return `images/${uid}.${ext}`;
}

// 「Smart paste」：恰好选中 1 张未锁 image → replace blob（保留几何 / 锁 / interp）；
// 其它情况（多选 / 选 viewport / 啥都没选 / 选的图锁着）→ 新建图，落画板中心。
// 两路入口共用：① 浏览器 paste 事件（Ctrl+V）走 onPaste hook，blob + 预测尺寸已有；
//              ② Paste 按钮 / 触屏走 navigator.clipboard.read()，需要现场量尺寸。
// undo：scene.act() 包裹，snapshot 浅拷贝包含旧 blob 引用，undo 时旧 blob 还在内存。
function _pickReplaceTarget() {
  const sels = Array.from(scene.selection).map((id) => scene.get(id)).filter(Boolean);
  const imageSels = sels.filter((o) => o.type === "image" && !o.locked);
  return imageSels.length === 1 ? imageSels[0] : null;
}

// 入口 1：从 paste 事件来（已有 blob + 测好的尺寸 + 目标中心点）
function smartPasteFromMeasured({ blob, naturalW, naturalH, x, y, targetLongWorld }) {
  const target = _pickReplaceTarget();
  if (target) {
    scene.act(() => {
      scene.replaceImageBlob(target.id, blob, _newImageSrc(blob));
    });
    showActionToast("Replaced selected image");
    return;
  }
  scene.act(() => {
    const obj = makeImageObject({ blob, src: _newImageSrc(blob), naturalW, naturalH, x, y, targetLongWorld });
    scene.add(obj);
    scene.select(obj.id, false);
  });
}

// 入口 2：从 Paste 按钮 / 触屏来（要现场读剪贴板 + 测尺寸）
async function smartPasteFromClipboard() {
  const blob = await readClipboardImageBlob();
  if (!blob) { showActionToast("No image in clipboard", 3000); return; }
  const target = _pickReplaceTarget();
  if (target) {
    scene.act(() => {
      scene.replaceImageBlob(target.id, blob, _newImageSrc(blob));
    });
    showActionToast("Replaced selected image");
    return;
  }
  // 新建路径需要测尺寸 + 算画板中心
  const tmpUrl = URL.createObjectURL(blob);
  const img = new Image();
  let naturalW = 0, naturalH = 0;
  try {
    await new Promise((res, rej) => {
      img.onload = res;
      img.onerror = () => rej(new Error("Image decode failed"));
      img.src = tmpUrl;
    });
    naturalW = img.naturalWidth;
    naturalH = img.naturalHeight;
  } catch (e) {
    URL.revokeObjectURL(tmpUrl);
    showActionToast(`Paste failed: ${e.message || e}`, 3000);
    return;
  }
  URL.revokeObjectURL(tmpUrl);
  if (!naturalW || !naturalH) return;
  const r = boardEl.getBoundingClientRect();
  const center = board.screenToWorld(r.left + r.width / 2, r.top + r.height / 2);
  const dpr = window.devicePixelRatio || 1;
  const longNat = Math.max(naturalW, naturalH);
  let targetLong = longNat / dpr;
  // 宽 AND 高 都不超过视野 2/3
  const scaleV = board.viewport.scale;
  const capW = (r.width * 2 / 3) * longNat / (naturalW * scaleV);
  const capH = (r.height * 2 / 3) * longNat / (naturalH * scaleV);
  const maxLong = Math.min(capW, capH);
  if (targetLong > maxLong) targetLong = maxLong;
  scene.act(() => {
    const obj = makeImageObject({ blob, src: _newImageSrc(blob), naturalW, naturalH, x: center.x, y: center.y, targetLongWorld: targetLong });
    scene.add(obj);
    scene.select(obj.id, false);
  });
}

// ----- Eyedropper + Color swatch -----
// Eyedropper：tool=eyedropper 时点击 image obj → 采该点像素 → 生成 64×64 纯色 swatch 放该位置。
// 处理完自动回 select 工具，符合一次性采色直觉。
// Add color swatch（菜单）：弹原生 color picker，确定后用上次或默认色生成 swatch 放视野中心。
const SWATCH_NATURAL = 64;
const SWATCH_WORLD = 64; // 世界 px 默认显示大小

async function handleEyedropper({ obj, clientX, clientY }) {
  // 不管点中啥都回 select（一次性工具）
  try {
    if (!obj || obj.type !== "image" || !obj.blob) {
      showActionToast("Eyedropper: click on an image", 2500);
      return;
    }
    const world = board.screenToWorld(clientX, clientY);
    const np = worldToNaturalPx(obj, world.x, world.y);
    // WYSIWYG：把 obj.filters 转 CSS filter 一并应用，采到屏幕上看到的色
    const cssFilter = obj.filters ? filtersToCssString(obj.filters) : "";
    const color = await samplePixel(obj.blob, np.x, np.y, cssFilter);
    const hex = colorToHex(color);
    await createSwatchAt(color, world.x, world.y);
    showActionToast(`Sampled ${hex} → swatch`);
  } catch (e) {
    console.warn("eyedropper failed", e);
    showActionToast(`Eyedropper failed: ${e.message || e}`, 4000);
  } finally {
    input.setTool("select");
  }
}

async function createSwatchAt(color, wx, wy) {
  const blob = await makeSwatchBlob(color, SWATCH_NATURAL);
  const src = _newImageSrc(blob);
  scene.act(() => {
    const obj = makeImageObject({
      blob,
      src,
      naturalW: SWATCH_NATURAL,
      naturalH: SWATCH_NATURAL,
      x: wx - SWATCH_WORLD / 2, // 居中在点击点
      y: wy - SWATCH_WORLD / 2,
      targetLongWorld: SWATCH_WORLD,
    });
    obj.interp = "nearest"; // swatch 放大缩小都该硬边
    scene.add(obj);
    scene.select(obj.id, false);
  });
}

// 菜单「Add color swatch…」：native color picker → 视野中心生成 swatch
const addSwatchColorInput = document.getElementById("addSwatchColorInput");
document.getElementById("menuAddSwatch").addEventListener("click", () => {
  closeHamburger();
  // 点击隐藏的 <input type="color"> 触发系统颜色选择器
  addSwatchColorInput.click();
});
addSwatchColorInput.addEventListener("change", async () => {
  const color = hexToColor(addSwatchColorInput.value);
  const r = boardEl.getBoundingClientRect();
  const center = board.screenToWorld(r.left + r.width / 2, r.top + r.height / 2);
  await createSwatchAt(color, center.x, center.y);
  showActionToast(`Added swatch ${colorToHex(color)}`);
});

// ----- 会话浏览模态 -----
const sessionsGallery = document.getElementById("sessionsGallery");
const sessionsList = document.getElementById("sessionsList");
const galleryCurrentName = document.getElementById("galleryCurrentName");
const sessionsBreadcrumb = document.getElementById("sessionsBreadcrumb");

let _currentFolder = ""; // 模态内当前查看的子文件夹路径，"" = 根

function renderSessionsBreadcrumb() {
  sessionsBreadcrumb.innerHTML = "";
  const rootBtn = document.createElement("button");
  rootBtn.textContent = "/";
  if (!_currentFolder) rootBtn.classList.add("current");
  else rootBtn.addEventListener("click", () => { _currentFolder = ""; refreshSessionsList(); });
  sessionsBreadcrumb.appendChild(rootBtn);
  if (_currentFolder) {
    const segs = _currentFolder.split("/").filter(Boolean);
    let accum = "";
    for (let i = 0; i < segs.length; i++) {
      const sep = document.createElement("span");
      sep.className = "sep";
      sep.textContent = "/";
      sessionsBreadcrumb.appendChild(sep);
      const seg = segs[i];
      accum = accum ? `${accum}/${seg}` : seg;
      const btn = document.createElement("button");
      btn.textContent = seg;
      if (i === segs.length - 1) {
        btn.classList.add("current");
      } else {
        const target = accum;
        btn.addEventListener("click", () => { _currentFolder = target; refreshSessionsList(); });
      }
      sessionsBreadcrumb.appendChild(btn);
    }
  }
}

// thumb URL 生命周期：每次 refresh 把旧 URL 全 revoke。
// 不 revoke 的话每次 refresh 漏 N 个 URL，gallery 多刷几次内存炸。
let _galleryThumbUrls = [];
function _revokeGalleryThumbs() {
  for (const u of _galleryThumbUrls) { try { URL.revokeObjectURL(u); } catch (_) {} }
  _galleryThumbUrls = [];
}

async function refreshSessionsList() {
  _revokeGalleryThumbs();
  sessionsList.innerHTML = "";
  renderSessionsBreadcrumb();

  // 1) 本地 IDB keys
  // 出错就 toast 提示用户 —— iOS Safari 隐私窗口 IDB 受限 / 配额耗尽都会在这里抛。
  // (WebPaint v57 教训：[WebPaint/docs/sync-and-ui-shareback.md §8](../../WebPaint/docs/sync-and-ui-shareback.md))
  let localKeys = [];
  try { localKeys = await storage.listSessionIds(); }
  catch (e) {
    console.warn("list local failed", e);
    showActionToast(`Couldn't read local storage: ${e.message || e}. Likely a private window or quota issue.`, 8000);
  }
  localKeys = localKeys.filter((k) => typeof k === "string" && k.endsWith(".atlas.zip"));
  const localSet = new Set(localKeys);

  // 2) 云端 auto-discovery（递归）
  let cloudPaths = [];
  if (cloud.isAuthConfigured() && cloud.isSignedIn()) {
    try {
      const items = await cloud.listAtlasesRecursive();
      cloudPaths = items.map((it) => it.path);
    } catch (e) { console.warn("list cloud failed:", e); }
  }
  const cloudSet = new Set(cloudPaths);

  // 3) 取并集 → 按当前 folder 切片成子文件夹 + 文件
  const allPaths = new Set([...localSet, ...cloudSet]);
  const prefix = _currentFolder ? `${_currentFolder}/` : "";
  const folders = new Set();
  const files = [];
  for (const p of allPaths) {
    if (_currentFolder && !p.startsWith(prefix)) continue;
    const rest = p.slice(prefix.length);
    const slashIdx = rest.indexOf("/");
    if (slashIdx >= 0) {
      folders.add(rest.slice(0, slashIdx));
    } else if (rest) {
      files.push(p);
    }
  }

  const cur = getCurrentPath();

  // 4) 渲染：folder 先（字母序）
  for (const folderName of [...folders].sort((a, b) => a.localeCompare(b))) {
    const row = document.createElement("div");
    row.className = "session-row folder";
    const thumb = document.createElement("div");
    thumb.className = "thumb";
    thumb.innerHTML = ICON_FOLDER;
    row.appendChild(thumb);
    const body = document.createElement("div");
    body.className = "body";
    const p = document.createElement("div");
    p.className = "path";
    p.textContent = folderName + "/";
    body.appendChild(p);
    row.appendChild(body);
    const targetFolder = _currentFolder ? `${_currentFolder}/${folderName}` : folderName;
    row.addEventListener("click", () => { _currentFolder = targetFolder; refreshSessionsList(); });
    sessionsList.appendChild(row);
  }

  // 5) 渲染：file 后（字母序）
  files.sort((a, b) => a.localeCompare(b));
  for (const key of files) {
    const inLocal = localSet.has(key);
    const inCloud = cloudSet.has(key);
    const pkg = inLocal ? await storage.getSession(key).catch(() => null) : null;
    const row = renderSessionFileRow(key, { pkg, inLocal, inCloud, isCurrent: key === cur });
    sessionsList.appendChild(row);
  }
}

function renderSessionFileRow(key, { pkg, inLocal, inCloud, isCurrent }) {
  const row = document.createElement("div");
  row.className = "session-row";
  if (isCurrent) row.dataset.current = "true";
  if (!inLocal && inCloud) row.classList.add("cloud-only");

  const isEncrypted = pkg && pkg.encrypted === true;
  const thumb = document.createElement("div");
  thumb.className = "thumb" + (isEncrypted ? " locked" : "");
  if (isEncrypted) {
    thumb.innerHTML = ICON_LOCK_THUMB;
  } else if (!inLocal && inCloud) {
    thumb.innerHTML = ICON_CLOUD_ONLY;
  } else if (pkg && pkg.thumb) {
    const url = URL.createObjectURL(pkg.thumb);
    _galleryThumbUrls.push(url);
    thumb.style.backgroundImage = `url(${url})`;
  }
  row.appendChild(thumb);

  const body = document.createElement("div");
  body.className = "body";
  const pathEl = document.createElement("div");
  pathEl.className = "path";
  // 在当前文件夹视图下显示 leaf 名（去掉前缀）
  const leafName = key.replace(/\.atlas\.zip$/i, "").slice(_currentFolder ? _currentFolder.length + 1 : 0);
  pathEl.textContent = leafName;
  body.appendChild(pathEl);

  const meta = document.createElement("div");
  meta.className = "meta";
  if (pkg) {
    const t = pkg.updatedAt ? new Date(pkg.updatedAt).toLocaleString() : "—";
    const sizeStr = pkg.atlas ? formatBytes(pkg.atlas.size) : "—";
    meta.textContent = isCurrent ? `Current · ${t} · ${sizeStr}` : `${t} · ${sizeStr}`;
  } else if (inCloud) {
    meta.textContent = "Cloud only, no local cache (click to download)";
  }
  body.appendChild(meta);

  // Badges
  const badges = document.createElement("div");
  badges.className = "badges";
  if (inLocal) {
    const b = document.createElement("span"); b.className = "badge local"; b.textContent = "Local"; badges.appendChild(b);
  }
  if (inCloud) {
    const b = document.createElement("span"); b.className = "badge cloud"; b.textContent = "Cloud"; badges.appendChild(b);
  }
  if (isEncrypted) {
    const b = document.createElement("span"); b.className = "badge encrypted"; b.textContent = "Encrypted"; badges.appendChild(b);
  }
  if (inLocal && cloud.isAuthConfigured() && cloud.isSignedIn()) {
    const stem = stemOfPath(key);
    if (cloud.isCloudDirty(stem)) {
      const b = document.createElement("span"); b.className = "badge dirty"; b.textContent = "Unpushed"; badges.appendChild(b);
    }
  }
  body.appendChild(badges);
  row.appendChild(body);

  // Actions
  const actions = document.createElement("div");
  actions.className = "actions";
  // 不再放「打开」按钮 —— 整行单击就是打开

  if (inLocal) {
    const cryptBtn = document.createElement("button");
    cryptBtn.textContent = isEncrypted ? "Decrypt" : "Encrypt";
    cryptBtn.title = isEncrypted ? "Remove encryption (requires current password + strong consent)" : "Encrypt (set a new password)";
    cryptBtn.addEventListener("click", async (e) => {
      e.stopPropagation();
      if (isEncrypted) await decryptSessionToggle(key, pkg);
      else await encryptSessionToggle(key, pkg);
      await refreshSessionsList();
    });
    actions.appendChild(cryptBtn);
  }

  // 单独推送这一幅（局部 push，不影响 active doc）。条件：本地有 + 登录中 + 云未同步
  if (inLocal && pkg?.atlas && cloud.isAuthConfigured() && cloud.isSignedIn() && cloud.isCloudDirty(stemOfPath(key))) {
    const pushBtn = document.createElement("button");
    pushBtn.textContent = "Push";
    pushBtn.title = "Push this board to OneDrive (independent of current doc)";
    pushBtn.addEventListener("click", async (e) => {
      e.stopPropagation();
      pushBtn.disabled = true;
      pushBtn.textContent = "Pushing…";
      try {
        await cloud.pushAtlas(stemOfPath(key), pkg.atlas);
        showActionToast(`Pushed: ${stemOfPath(key)}`);
        await refreshSessionsList();
      } catch (err) {
        if (err instanceof cloud.CloudConflictError) {
          showActionToast(`Cloud has a newer "${stemOfPath(key)}" — rename (open it first, then Rename) to push.`, 6000);
        } else {
          showActionToast(`Push failed: ${err.message || err}`, 4000);
        }
      } finally {
        pushBtn.disabled = false;
        pushBtn.textContent = "Push";
      }
    });
    actions.appendChild(pushBtn);
  }

  // 卸载本地（弱删除）：本地+云时可见。清本地 IDB，云端保留；下次单击 tile 重新拉。
  if (inLocal && inCloud && !isCurrent) {
    const unloadBtn = document.createElement("button");
    unloadBtn.textContent = "Unload local";
    unloadBtn.title = "Drop the local copy; cloud copy stays (click tile to fetch back)";
    unloadBtn.addEventListener("click", async (e) => {
      e.stopPropagation();
      try { await storage.deleteSession(key); }
      catch (err) { showActionToast(`Unload failed: ${err.message || err}`); return; }
      showActionToast(`Unloaded local: ${stemOfPath(key)}`);
      await refreshSessionsList();
      updateIdbUsageFooter();
    });
    actions.appendChild(unloadBtn);
  }

  const delBtn = document.createElement("button");
  delBtn.className = "danger";
  delBtn.textContent = "Delete";
  delBtn.addEventListener("click", async (e) => {
    e.stopPropagation();
    const where = inLocal && inCloud ? "local + cloud" : (inLocal ? "local" : "cloud");
    if (!confirm(`Delete "${stemOfPath(key)}" (${where})? Cannot be undone.`)) return;
    if (inLocal) {
      try { await storage.deleteSession(key); } catch (err) { showActionToast(`Local delete failed: ${err.message || err}`); }
    }
    if (inCloud && cloud.isAuthConfigured() && cloud.isSignedIn()) {
      try { await cloud.deleteAtlas(stemOfPath(key)); }
      catch (err) { console.warn("cloud delete failed:", err); }
    }
    if (key === getCurrentPath()) {
      await newBlankSession(sessionFileName(DEFAULT_SESSION_NAME));
    }
    await refreshSessionsList();
  });
  actions.appendChild(delBtn);
  row.appendChild(actions);

  // 整 tile 单击 = 打开（actions 里的按钮各自 stopPropagation）。
  // current tile：点击 = 退出 gallery（已经在编辑此 board，open 是 no-op，只是关 gallery 回画板）。
  row.style.cursor = "pointer";
  row.addEventListener("click", async () => {
    if (isCurrent) { closeSessionsModal(); return; }
    try {
      if (!inLocal && inCloud) await pullSessionFromCloudAndOpen(key);
      else await openSessionByPath(key);
      closeSessionsModal();
    } catch (err) {
      showActionToast(`Open failed: ${err.message || err}`, 4000);
    }
  });

  return row;
}

// 云端拉一个 session 到 IDB，然后用 openSessionByPath 打开（含密码 prompt 流程）
async function pullSessionFromCloudAndOpen(path) {
  const stem = stemOfPath(path);
  // 下载 + 探测格式 + 写 IDB 阶段：锁 UI（防误触别的 session）
  await withBusy(`Pulling "${stem}" from OneDrive…`, async () => {
    const result = await cloud.pullAtlasByPath(path);
    if (!result) throw new Error(`OneDrive has no ${path}`);
    // 探测格式，决定 encrypted 标志，并可选地预存 thumb
    let isEncrypted = false;
    let thumb = null;
    try {
      const fmt = await detectAtlasFormat(result.blob);
      isEncrypted = (fmt === "encrypted");
      if (!isEncrypted) {
        try {
          const entries = await zipUnpack(result.blob);
          if (entries["thumb.png"]) {
            thumb = new Blob([entries["thumb.png"]], { type: "image/png" });
          }
        } catch (_) {}
      }
    } catch (_) {}
    await storage.putSession(path, {
      name: stem,
      updatedAt: Date.now(),
      atlas: result.blob,
      thumb,
      encrypted: isEncrypted,
    });
  });
  // openSessionByPath 内部会再 prompt 密码 + 自己 withBusy 解密
  await openSessionByPath(path);
  showActionToast(`Opened: ${stem}`);
}

async function openSessionsModal() {
  // 打开前 flush 一下，让当前 session 出现在列表里且 thumb 最新（autosave 力度，不触云）
  if (_dirty && !_saving) await saveCurrentSession();
  await refreshSessionsList();
  galleryCurrentName.value = sessionInput.value;
  sessionsGallery.classList.remove("hidden");
  document.body.dataset.mode = "gallery"; // CSS disable 主画布 / 浮窗
  updateIdbUsageFooter();
}

// IDB 占用 = Σ atlas.size。**不**走 navigator.storage.estimate（会算上 SW cache / localStorage，
// 虚高几 MB，对用户误导）。参考 WebPaint sync-and-ui-shareback §5。
async function updateIdbUsageFooter() {
  const el = document.getElementById("galleryFooter");
  if (!el) return;
  try {
    const keys = await storage.listSessionIds();
    let total = 0;
    let n = 0;
    for (const k of keys) {
      const pkg = await storage.getSession(k).catch(() => null);
      if (pkg?.atlas) { total += pkg.atlas.size; n++; }
    }
    el.textContent = `Local: ${formatBytes(total)} (${n} board${n === 1 ? "" : "s"})`;
  } catch (e) {
    el.textContent = "Local: —";
  }
}

// ----- 加密 toggle（per-session）-----
// 加密：读 IDB pkg（未加密直接 zip）→ 解出 entries → 用新密码包成加密 zip → 写回 IDB
async function encryptSessionToggle(path, pkg) {
  if (pkg.encrypted) { showActionToast("Already encrypted"); return; }
  const pw = await promptNewPassword(`Set a password to encrypt "${stemOfPath(path)}"`);
  if (!pw) return;
  let newAtlas;
  try {
    newAtlas = await withBusy(`Encrypting "${stemOfPath(path)}"…`, async () => {
      const innerEntries = await zipUnpack(pkg.atlas);
      return await zipPackEncrypted(
        Object.entries(innerEntries).map(([p, d]) => ({ path: p, data: d })),
        pw,
      );
    });
  } catch (e) { showActionToast(`Encrypt failed: ${e.message}`, 4000); return; }
  await storage.putSession(path, {
    name: pkg.name,
    updatedAt: Date.now(),
    atlas: newAtlas,
    thumb: null,
    encrypted: true,
  });
  if (path === _activeIDBPath) {
    _currentEncrypted = true;
    _currentSessionPassword = pw;
  }
  if (cloud.isAuthConfigured() && cloud.isSignedIn()) {
    cloud.setCloudDirty(stemOfPath(path), true);
    refreshCloudUI();
  }
  showActionToast(`Encrypted: ${stemOfPath(path)} (password required on reopen)`);
}

// 取消加密：读密码（验证）→ 强 consent → 解出 → 重打成 direct zip → 写回
async function decryptSessionToggle(path, pkg) {
  if (!pkg.encrypted) { showActionToast("Already unencrypted"); return; }
  const pw = await promptPassword(`Enter the password for "${stemOfPath(path)}"`);
  if (pw === null) return;
  // 用密码验证 + 拿 entries（耗时操作，必须锁 UI）
  let innerEntries;
  try {
    innerEntries = await withBusy(`Verifying password…`, () => zipUnpackEncrypted(pkg.atlas, pw));
  }
  catch (e) { showActionToast(`Wrong password or corrupted file`, 4000); return; }
  // 强 consent（不锁 UI，让 prompt 显示）
  const phrase = "I confirm decrypt";
  const ok = await confirmTypePhrase(
    phrase,
    `Type "${phrase}" to confirm.\n\nAfter decrypting, the board content will be stored as plaintext in IndexedDB (and in OneDrive after push). Anyone with access to this device / cloud account will be able to read it.\n\nContinue?`,
  );
  if (!ok) { showActionToast("Not confirmed, cancelled"); return; }
  // 提取 thumb（若内层有）
  let thumb = null;
  if (innerEntries["thumb.png"]) {
    thumb = new Blob([innerEntries["thumb.png"]], { type: "image/png" });
  }
  let newAtlas;
  try {
    newAtlas = await withBusy(`Decrypting "${stemOfPath(path)}"…`, () =>
      zipPack(Object.entries(innerEntries).map(([p, d]) => ({ path: p, data: d })))
    );
  } catch (e) { showActionToast(`Re-pack failed: ${e.message}`, 4000); return; }
  await storage.putSession(path, {
    name: pkg.name,
    updatedAt: Date.now(),
    atlas: newAtlas,
    thumb,
    encrypted: false,
  });
  if (path === _activeIDBPath) {
    _currentEncrypted = false;
    _currentSessionPassword = null;
  }
  if (cloud.isAuthConfigured() && cloud.isSignedIn()) {
    cloud.setCloudDirty(stemOfPath(path), true);
    refreshCloudUI();
  }
  showActionToast(`Decrypted: ${stemOfPath(path)}`);
}
async function closeSessionsModal() {
  // 退图库也兜底 saveNow（autosave 力度，不触云）。用户在编辑中跑别处看图库回来，落盘一次。
  if (_dirty && !_saving) await saveCurrentSession();
  sessionsGallery.classList.add("hidden");
  delete document.body.dataset.mode;
  _revokeGalleryThumbs();
}

// gallery 里的「正在编辑」名字框：双向同步顶栏 sessionInput（顶栏被 gallery 覆盖看不到）。
// 改名是 destructive op，但只是把 sessionInput.value 改了 —— 下次 save 走 IDB rename
// path（saveCurrentSession 检测 oldPath != newPath → del 旧）。和 ghost-current-path 修复
// 兼容（_activeIDBPath 是 actually-loaded path，不是 input 的）。
galleryCurrentName.addEventListener("input", () => {
  sessionInput.value = galleryCurrentName.value;
  // 让 cloud-dirty 跟着新名重算（旧名 cloud-dirty 状态不变，新名按默认 dirty）
  refreshCloudUI();
});

document.getElementById("menuSessions").addEventListener("click", () => { closeHamburger(); openSessionsModal(); });
document.getElementById("menuRename").addEventListener("click", () => { closeHamburger(); renameCurrentBoard(); });
document.getElementById("sessionsCloseBtn").addEventListener("click", closeSessionsModal);
document.getElementById("sessionsRefreshBtn").addEventListener("click", async () => {
  // 用户主动刷 → 顺手 silent retry（处理 boot 离线 case）
  if (!cloud.isSignedIn() && navigator.onLine !== false) {
    await cloud.retrySilentSignIn();
    refreshCloudUI();
  }
  await refreshSessionsList();
});
document.getElementById("sessionsNewBtn").addEventListener("click", async () => {
  // 默认在当前文件夹下新建
  const defaultText = _currentFolder ? `${_currentFolder}/Untitled` : "Untitled";
  const name = prompt("New board path (use / for subfolders, e.g. characters/wall)", defaultText);
  if (!name) return;
  const path = sessionFileName(name);
  const existing = await storage.getSession(path);
  if (existing) {
    if (!confirm(`${path} already exists. Open it?`)) return;
    await openSessionByPath(path);
    closeSessionsModal();
    return;
  }
  await newBlankSession(path);
  await refreshSessionsList();
});
