// AtlasMaker — 一期：无限工作台 + 粘贴图片 + viewport 框。
// 没有持久化、没有 OneDrive，刷新会丢。两个一期之后从兄弟项目抄。

import { Board } from "./board.js";
import { Scene, makeImageObject, makeViewportObject } from "./objects.js";
import { Input } from "./input.js";

const boardEl = document.getElementById("board");
const worldEl = document.getElementById("world");

const board = new Board(boardEl, worldEl);
const scene = new Scene(worldEl);

// 视野放在 board 中心
const r = boardEl.getBoundingClientRect();
board.setViewport(r.width / 2, r.height / 2, 1);

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
        statusLabel.textContent = `图片 ${sel.naturalW}×${sel.naturalH}`;
      } else if (sel.type === "viewport") {
        statusLabel.textContent = `Viewport ${sel.w}×${sel.h} → ${sel.resW}×${sel.resH}`;
      }
    } else {
      statusLabel.textContent = "拖动 / 选中对象";
    }
  }
}

board.onChange(refreshHud);
scene.onChange(() => { refreshHud(); refreshViewportPanel(); });

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
const themeBtn = document.getElementById("themeButton");
themeBtn.addEventListener("click", () => {
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
const vpExportBtn = document.getElementById("vpExport");
const vpDeleteBtn = document.getElementById("vpDelete");

document.getElementById("viewportPanelClose").addEventListener("click", () => {
  scene.clearSelection();
});

function refreshViewportPanel() {
  const sel = scene.firstSelected();
  if (sel && sel.type === "viewport") {
    vpPanel.classList.remove("hidden");
    vpResW.value = sel.resW;
    vpResH.value = sel.resH;
    vpInterp.value = sel.interp || "linear";
    vpBinding.value = sel.binding || "";
  } else {
    vpPanel.classList.add("hidden");
  }
}

function patchSelectedViewport(patch) {
  const sel = scene.firstSelected();
  if (sel && sel.type === "viewport") scene.update(sel.id, patch);
}

vpResW.addEventListener("change", () => patchSelectedViewport({ resW: clampInt(vpResW.value, 1, 8192) }));
vpResH.addEventListener("change", () => patchSelectedViewport({ resH: clampInt(vpResH.value, 1, 8192) }));
vpInterp.addEventListener("change", () => patchSelectedViewport({ interp: vpInterp.value }));

vpExportBtn.addEventListener("click", async () => {
  const sel = scene.firstSelected();
  if (sel && sel.type === "viewport") {
    const blob = await rasterizeViewport(sel);
    downloadBlob(blob, `viewport-${sel.id}.png`);
  }
});

vpDeleteBtn.addEventListener("click", () => {
  const sel = scene.firstSelected();
  if (sel) scene.remove(sel.id);
});

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
  onPaste: ({ src, naturalW, naturalH, x, y }) => {
    const obj = makeImageObject({ src, naturalW, naturalH, x, y, ownsUrl: true });
    scene.add(obj);
    scene.select(obj.id, false);
  },
  onViewportFinish: ({ x, y, w, h, defaulted }) => {
    const obj = makeViewportObject({ x, y, w, h });
    scene.add(obj);
    scene.select(obj.id, false);
    if (defaulted) input.setTool("select"); // 单击落了个默认 viewport，回到选择
  },
  hooks: {
    onFit: doFit,
    onDelete: () => {
      // 删掉所有选中
      for (const id of Array.from(scene.selection)) scene.remove(id);
    },
  },
});
input.setTool("select");

// ----- viewport 光栅化 -----
// 找出和 viewport 包围盒相交的所有图片，按世界坐标绘制进一张 resW×resH 的 canvas。
async function rasterizeViewport(vp) {
  const canvas = document.createElement("canvas");
  canvas.width = vp.resW;
  canvas.height = vp.resH;
  const ctx = canvas.getContext("2d");
  ctx.imageSmoothingEnabled = vp.interp !== "nearest";
  ctx.imageSmoothingQuality = "high";
  ctx.fillStyle = "#ffffff00";
  ctx.clearRect(0, 0, canvas.width, canvas.height);

  // 世界 → viewport 内坐标的缩放（每个世界 px 在输出图里占多少 px）
  const sx = vp.resW / vp.w;
  const sy = vp.resH / vp.h;

  // DOM 顺序 = z 顺序，最下面的先画
  for (const obj of scene.list()) {
    if (obj.type !== "image") continue;
    // 交集检测
    if (obj.x + obj.w < vp.x || obj.x > vp.x + vp.w ||
        obj.y + obj.h < vp.y || obj.y > vp.y + vp.h) continue;
    const node = scene.getNode(obj.id);
    const imgEl = node && node.querySelector("img");
    if (!imgEl) continue;
    const dx = (obj.x - vp.x) * sx;
    const dy = (obj.y - vp.y) * sy;
    const dw = obj.w * sx;
    const dh = obj.h * sy;
    try {
      ctx.drawImage(imgEl, dx, dy, dw, dh);
    } catch (_) { /* 跨源等 */ }
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

// ----- SW 更新提示 -----
if ("serviceWorker" in navigator) {
  navigator.serviceWorker.register("./service-worker.js").catch((err) => console.warn("SW register failed", err));
  navigator.serviceWorker.addEventListener("message", (ev) => {
    if (ev.data?.type === "asset-updated") {
      const toast = document.getElementById("updateToast");
      toast.classList.remove("hidden");
    }
  });
  document.getElementById("updateToastReload").addEventListener("click", () => location.reload());
  document.getElementById("updateToastDismiss").addEventListener("click", () => {
    document.getElementById("updateToast").classList.add("hidden");
  });
}

// 首屏刷新一次 HUD
refreshHud();
