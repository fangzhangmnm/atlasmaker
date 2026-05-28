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
const saveStatusEl = document.getElementById("saveStatus");
const AUTO_SAVE_FALLBACK_MS = 3 * 60 * 1000;

let _dirty = false;
let _saving = false;
let _loading = false;

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

function setSaveStatus(state) {
  if (!saveStatusEl) return;
  saveStatusEl.dataset.state = state;
  const label = ({
    dirty:  "Unsaved",
    saving: "Saving…",
    saved:  "Saved",
    error:  "Save failed",
  })[state] || "";
  saveStatusEl.textContent = _currentEncrypted ? `${label} 🔒` : label;
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
  setSaveStatus("saving");
  if (explicit && cloud.isAuthConfigured() && cloud.isSignedIn()) {
    cloudPushBtn.disabled = true;
  }
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
      setSaveStatus("saved");
      if (cloud.isAuthConfigured() && cloud.isSignedIn()) {
        cloud.setCloudDirty(doc.name, true);
        refreshCloudUI();
      }
    } catch (e) {
      localErr = e;
      console.warn("save failed", e);
      setSaveStatus("error");
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
    cloudPushBtn.dataset.state = "cloud-busy"; // 旋转弧动画（CSS）
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
      refreshCloudUI();
    } catch (e) {
      if (e instanceof cloud.CloudConflictError) {
        pushOutcome = { conflict: true, sessionName: e.sessionName };
      } else {
        pushOutcome = { error: e.message || String(e) };
      }
    } finally {
      delete cloudPushBtn.dataset.state;
    }

    if (pushOutcome?.error) {
      showActionToast(`Saved locally (cloud push failed: ${pushOutcome.error})`, 5000);
    } else if (pushOutcome?.conflict) {
      showActionToast(`Saved locally — OneDrive has a newer "${pushOutcome.sessionName}". Rename your board and Ctrl+S again.`, 8000);
    } else if (pushOutcome?.action === "uploaded") {
      showActionToast(pushOutcome.renamedFrom
        ? `Saved (local + cloud, deleted old ${pushOutcome.renamedFrom})`
        : "Saved (local + cloud)");
    }
  } finally {
    _saving = false;
    const wasExplicit = _inFlightExplicit;
    _inFlightExplicit = false;
    cloudPushBtn.disabled = !cloud.isSignedIn();
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
    vpLock.textContent = sel.locked ? "🔒" : "🔓";
  } else if (sel && sel.type === "image") {
    imgPanel.classList.remove("hidden");
    vpPanel.classList.add("hidden");
    // 显示原图分辨率 + blob 字节 —— 让用户能看出哪张是 4K 大块头白浪费内存
    const sizeStr = sel.blob ? formatBytes(sel.blob.size) : "—";
    const cropStr = sel.crop ? ` (cropped ${Math.round(sel.crop.w)}×${Math.round(sel.crop.h)})` : "";
    imgNaturalLabel.textContent = `${sel.naturalW}×${sel.naturalH}${cropStr} · ${sizeStr}`;
    imgLock.setAttribute("aria-pressed", sel.locked ? "true" : "false");
    imgLock.textContent = sel.locked ? "🔒" : "🔓";
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
  rasterSourceLabel.textContent = `Source: ${sel.naturalW}×${sel.naturalH}${sel.crop ? ` (cropped ${cw}×${ch})` : ""} · ${formatBytes(sel.blob.size)}`;
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
        targetW,
        targetH,
        mode,
      })
    );
    const newSrc = _newImageSrc(newBlob);
    scene.act(() => {
      scene.replaceImageBlob(id, newBlob, newSrc);
      // 同步更新 natural 尺寸 + 重置 crop（已 baked 进新 blob）
      scene.update(id, { naturalW: targetW, naturalH: targetH, crop: undefined });
    });
    showActionToast(`Rasterized to ${targetW}×${targetH} (${formatBytes(newBlob.size)})`);
  } catch (e) {
    console.warn("rasterize failed", e);
    showActionToast(`Rasterize failed: ${e.message || e}`, 4000);
  }
});

imgRasterizeBtn.addEventListener("click", () => openRasterizeDialog());

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

function enterCropMode(obj) {
  if (obj.rotation && Math.abs(obj.rotation) > 0.01) {
    showActionToast("Crop doesn't support rotated images yet — reset rotation first.", 4500);
    return;
  }
  crop.start({
    obj,
    onChange: () => renderOverlay(),
    onApply: ({ rect }) => doApplyCrop(obj.id, rect),
    onCancel: () => exitCropMode(),
  });
  overlayEl.innerHTML = "";
  _cropDom = _buildCropDom();
  cropToolbar.classList.remove("hidden");
  document.body.dataset.cropMode = "1";
  renderOverlay();
}

function exitCropMode() {
  if (_cropDom) overlayEl.innerHTML = "";
  _cropDom = null;
  cropToolbar.classList.add("hidden");
  delete document.body.dataset.cropMode;
  renderOverlay();
}

function doApplyCrop(objId, rect) {
  const obj = scene.get(objId);
  if (!obj) { exitCropMode(); return; }
  const out = crop.applyCropMath(obj, rect);
  scene.act(() => {
    scene.update(objId, { x: out.x, y: out.y, w: out.w, h: out.h, crop: out.crop });
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

function refreshCloudUI() {
  const signedIn = cloud.isSignedIn();
  cloudPushBtn.disabled = !signedIn;
  // 云端待推：登录中 + 本地比云端新 → push 按钮闪小点（独立于本地保存状态）
  const dirty = signedIn && cloud.isCloudDirty(sessionInput.value);
  cloudPushBtn.classList.toggle("cloud-dirty", dirty);
  if (dirty) cloudPushBtn.title = "Save to cloud — local has un-uploaded changes (Ctrl+S also saves to cloud)";
  else cloudPushBtn.title = "Save to cloud (Ctrl+S also saves to cloud)";
  if (!cloud.isAuthConfigured()) {
    cloudPill.dataset.state = "disconnected";
    cloudLabel.textContent = "OneDrive not configured";
    cloudPill.title = "Set CLIENT_ID in src/config.js (Azure App Registration)";
    return;
  }
  if (signedIn) {
    const acc = cloud.getActiveAccount();
    const tag = (acc?.username || acc?.name || "Signed in").replace(/@.*/, "");
    cloudPill.dataset.state = "connected";
    cloudLabel.textContent = `OneDrive · ${tag}`;
    cloudPill.title = `Signed in: ${acc?.username || ""}\nClick to sign out`;
  } else {
    cloudPill.dataset.state = "disconnected";
    cloudLabel.textContent = "OneDrive";
    cloudPill.title = "Click to sign in to OneDrive";
  }
}

cloudPill.addEventListener("click", async () => {
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
    cloudPill.dataset.state = "connecting";
    cloudLabel.textContent = "OneDrive · signing in";
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
    const color = await samplePixel(obj.blob, np.x, np.y);
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
  let localKeys = [];
  try { localKeys = await storage.listSessionIds(); } catch (e) { console.warn("list local failed", e); }
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
    thumb.textContent = "📁";
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
    thumb.textContent = "🔒";
  } else if (!inLocal && inCloud) {
    thumb.textContent = "☁";
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
    const b = document.createElement("span"); b.className = "badge cloud"; b.textContent = "☁ Cloud"; badges.appendChild(b);
  }
  if (isEncrypted) {
    const b = document.createElement("span"); b.className = "badge encrypted"; b.textContent = "🔒 Encrypted"; badges.appendChild(b);
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
    cryptBtn.textContent = isEncrypted ? "🔓 Decrypt" : "🔒 Encrypt";
    cryptBtn.title = isEncrypted ? "Remove encryption (requires current password + strong consent)" : "Encrypt (set a new password)";
    cryptBtn.addEventListener("click", async (e) => {
      e.stopPropagation();
      if (isEncrypted) await decryptSessionToggle(key, pkg);
      else await encryptSessionToggle(key, pkg);
      await refreshSessionsList();
    });
    actions.appendChild(cryptBtn);
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
  // 打开前 flush 一下，让当前 session 出现在列表里且 thumb 最新
  if (_dirty && !_saving) await saveCurrentSession();
  await refreshSessionsList();
  galleryCurrentName.value = sessionInput.value;
  sessionsGallery.classList.remove("hidden");
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
function closeSessionsModal() {
  sessionsGallery.classList.add("hidden");
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
document.getElementById("sessionsCloseBtn").addEventListener("click", closeSessionsModal);
document.getElementById("sessionsRefreshBtn").addEventListener("click", refreshSessionsList);
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
