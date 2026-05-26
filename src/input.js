// 输入：pointer + wheel + 键盘 + 剪贴板。
// 工具：select（默认）、hand、viewport（拖框生成）。
// 通用：中键 / 空格临时变 hand；滚轮 zoom（光标为锚点，holding Ctrl 更快）。

const MIDDLE_BTN = 1;     // ev.button: 0=左, 1=中, 2=右
const MIDDLE_MASK = 4;    // ev.buttons: 1=左 2=右 4=中
const HAND_KEY = " ";

export class Input {
  constructor({ boardEl, board, scene, onTool, onPaste, onViewportFinish, hooks = {} }) {
    this.boardEl = boardEl;
    this.board = board;
    this.scene = scene;
    this.onTool = onTool;
    this.onPaste = onPaste;
    this.onViewportFinish = onViewportFinish;
    this.hooks = hooks;
    this.tool = "select";
    this._panState = null;     // { startX, startY, startTx, startTy }
    this._dragState = null;    // { id, startX, startY, ox, oy }
    this._marqueeState = null; // { x0, y0 } for viewport 拖出
    this._spaceHeld = false;

    boardEl.addEventListener("pointerdown", this._onPointerDown);
    boardEl.addEventListener("pointermove", this._onPointerMove);
    boardEl.addEventListener("pointerup", this._onPointerUp);
    boardEl.addEventListener("pointercancel", this._onPointerUp);
    boardEl.addEventListener("wheel", this._onWheel, { passive: false });
    boardEl.addEventListener("contextmenu", (e) => e.preventDefault());

    window.addEventListener("keydown", this._onKeyDown);
    window.addEventListener("keyup", this._onKeyUp);

    // 剪贴板：直接监听 paste 事件
    window.addEventListener("paste", this._onPaste);
  }

  setTool(tool) {
    this.tool = tool;
    document.body.dataset.tool = tool;
    if (this.onTool) this.onTool(tool);
  }

  _effectiveTool() {
    return (this._spaceHeld || this.tool === "hand") ? "hand" : this.tool;
  }

  _boardLocal(ev) {
    const r = this.boardEl.getBoundingClientRect();
    return { x: ev.clientX - r.left, y: ev.clientY - r.top };
  }

  _onPointerDown = (ev) => {
    this.boardEl.setPointerCapture(ev.pointerId);
    // 中键 / 空格 → pan，无论当前工具
    const wantPan = ev.button === MIDDLE_BTN || (ev.buttons & MIDDLE_MASK) || this._effectiveTool() === "hand";
    if (wantPan) {
      this._panState = {
        startX: ev.clientX, startY: ev.clientY,
        startTx: this.board.viewport.tx,
        startTy: this.board.viewport.ty,
      };
      document.body.dataset.panning = "1";
      return;
    }
    // viewport 工具：拖框
    if (this.tool === "viewport") {
      const w = this.board.screenToWorld(ev.clientX, ev.clientY);
      this._marqueeState = { x0: w.x, y0: w.y, node: null };
      return;
    }
    // select 工具：用 ev.target 走 DOM —— 这样 viewport 的 pointer-events: none 自动让点穿透到图，
    // 只有 .vp-edge 接到点击就选中 viewport；图直接选图。
    let el = ev.target;
    while (el && el !== this.boardEl && !(el.classList && el.classList.contains("obj"))) {
      el = el.parentElement;
    }
    const hitObj = (el && el.classList && el.classList.contains("obj"))
      ? this.scene.get(el.dataset.id)
      : null;
    if (hitObj) {
      this.scene.select(hitObj.id, ev.shiftKey);
      // 不自动 raise —— z-order 由用户手动控制
      this._dragState = {
        id: hitObj.id,
        startX: ev.clientX,
        startY: ev.clientY,
        ox: hitObj.x,
        oy: hitObj.y,
      };
    } else {
      this.scene.clearSelection();
    }
  };

  _onPointerMove = (ev) => {
    if (this._panState) {
      const dx = ev.clientX - this._panState.startX;
      const dy = ev.clientY - this._panState.startY;
      this.board.setViewport(
        this._panState.startTx + dx,
        this._panState.startTy + dy,
        this.board.viewport.scale,
      );
      return;
    }
    if (this._dragState) {
      const dx = (ev.clientX - this._dragState.startX) / this.board.viewport.scale;
      const dy = (ev.clientY - this._dragState.startY) / this.board.viewport.scale;
      this.scene.update(this._dragState.id, {
        x: Math.round(this._dragState.ox + dx),
        y: Math.round(this._dragState.oy + dy),
      });
      return;
    }
    if (this._marqueeState) {
      const w = this.board.screenToWorld(ev.clientX, ev.clientY);
      const { x0, y0 } = this._marqueeState;
      const x = Math.min(x0, w.x), y = Math.min(y0, w.y);
      const wW = Math.abs(w.x - x0), hH = Math.abs(w.y - y0);
      if (!this._marqueeState.node) {
        const n = document.createElement("div");
        n.className = "obj viewport";
        n.style.opacity = "0.6";
        this.board.worldEl.appendChild(n);
        this._marqueeState.node = n;
      }
      const n = this._marqueeState.node;
      n.style.left = `${x}px`;
      n.style.top = `${y}px`;
      n.style.width = `${wW}px`;
      n.style.height = `${hH}px`;
      return;
    }
  };

  _onPointerUp = (ev) => {
    try { this.boardEl.releasePointerCapture(ev.pointerId); } catch (_) {}
    if (this._panState) {
      this._panState = null;
      delete document.body.dataset.panning;
      return;
    }
    if (this._dragState) {
      this._dragState = null;
      return;
    }
    if (this._marqueeState) {
      const w = this.board.screenToWorld(ev.clientX, ev.clientY);
      const { x0, y0, node } = this._marqueeState;
      this._marqueeState = null;
      if (node) node.remove();
      const x = Math.min(x0, w.x), y = Math.min(y0, w.y);
      const wW = Math.abs(w.x - x0), hH = Math.abs(w.y - y0);
      if (this.onViewportFinish) {
        if (wW < 16 || hH < 16) {
          // 太小当点击处理 —— 给个默认尺寸放在那
          this.onViewportFinish({ x: x + wW / 2, y: y + hH / 2, w: 512, h: 512 });
        } else {
          this.onViewportFinish({ x: x + wW / 2, y: y + hH / 2, w: wW, h: hH });
        }
      }
      // 创建完一个就退回 select —— 不要让用户拖出连串 viewport
      this.setTool("select");
      return;
    }
  };

  _onWheel = (ev) => {
    ev.preventDefault();
    const local = this._boardLocal(ev);
    // Ctrl 一直 zoom；触摸板两指捏合也走 ctrlKey
    const deltaY = ev.deltaY;
    const factor = Math.exp(-deltaY * (ev.ctrlKey ? 0.01 : 0.0015));
    this.board.zoomAt(local.x, local.y, factor);
  };

  _onKeyDown = (ev) => {
    const tgt = ev.target;
    if (tgt && (tgt.tagName === "INPUT" || tgt.tagName === "TEXTAREA" || tgt.isContentEditable)) return;
    if (ev.key === HAND_KEY && !this._spaceHeld) {
      this._spaceHeld = true;
      document.body.dataset.tool = "hand";
      ev.preventDefault();
      return;
    }
    if ((ev.key === "Delete" || ev.key === "Backspace" || ev.key === "x" || ev.key === "X")) {
      // X 和 Delete 都删 —— Blender 习惯
      if (this.hooks.onDelete) this.hooks.onDelete();
      ev.preventDefault();
      return;
    }
    if ((ev.ctrlKey || ev.metaKey) && (ev.key === "d" || ev.key === "D")) {
      if (this.hooks.onDuplicate) this.hooks.onDuplicate();
      ev.preventDefault();
      return;
    }
    // z-order：Ctrl+] / Ctrl+[ 单步；加 Shift 顶 / 底
    if ((ev.ctrlKey || ev.metaKey) && (ev.key === "]" || ev.key === "[")) {
      const top = ev.key === "]";
      for (const id of this.scene.selection) {
        if (ev.shiftKey) {
          if (top) this.scene.raiseToTop(id); else this.scene.lowerToBottom(id);
        } else {
          if (top) this.scene.raiseOne(id); else this.scene.lowerOne(id);
        }
      }
      ev.preventDefault();
      return;
    }
    // 单字符工具切换（V 已经被 Ctrl+V 占用 → 不再绑 V 作工具，select 是默认）
    if (ev.key === "h" || ev.key === "H") this.setTool("hand");
    else if (ev.key === "r" || ev.key === "R") this.setTool("viewport");
    else if (ev.key === "s" || ev.key === "S") this.setTool("select");
    else if (ev.key === "0") { if (this.hooks.onFit) this.hooks.onFit(); }
    else if (ev.key === "Escape") { this.scene.clearSelection(); if (this.hooks.onEscape) this.hooks.onEscape(); }
  };

  _onKeyUp = (ev) => {
    if (ev.key === HAND_KEY) {
      this._spaceHeld = false;
      document.body.dataset.tool = this.tool;
    }
  };

  _onPaste = async (ev) => {
    const items = ev.clipboardData && ev.clipboardData.items;
    if (!items) return;
    for (const it of items) {
      if (it.kind === "file" && it.type.startsWith("image/")) {
        const file = it.getAsFile();
        if (file) {
          ev.preventDefault();
          await this._ingestImageFile(file);
          return;
        }
      }
    }
    // 也支持粘贴 URL（部分浏览器把网图当 text/html 给）—— 一期不做，太多边角情况
  };

  async _ingestImageFile(file) {
    // 测量阶段：临时 URL 拿 naturalW/H，测完立刻 revoke。真正给 obj 的是 Blob 自己。
    const tmpUrl = URL.createObjectURL(file);
    const img = new Image();
    let naturalW = 0, naturalH = 0;
    try {
      await new Promise((res, rej) => {
        img.onload = res;
        img.onerror = () => rej(new Error("图片加载失败"));
        img.src = tmpUrl;
      });
      naturalW = img.naturalWidth;
      naturalH = img.naturalHeight;
    } finally {
      try { URL.revokeObjectURL(tmpUrl); } catch (_) {}
    }
    if (!naturalW || !naturalH) return;
    const r = this.boardEl.getBoundingClientRect();
    const center = this.board.screenToWorld(r.left + r.width / 2, r.top + r.height / 2);
    // DPI 校正：让 1 世界 px = 1 物理屏幕 px。
    // Win+Shift+S 之类截屏是物理像素，在 1.5x 显示器上不校正会被放大成 1.5 倍 CSS px。
    const dpr = window.devicePixelRatio || 1;
    let targetLong = Math.max(naturalW, naturalH) / dpr;
    // 安全帽：再大不超过当前视野短边的 90%（防止 4K 截屏一来塞满视野）
    const scale = this.board.viewport.scale;
    const maxLong = Math.min(r.width, r.height) / scale * 0.9;
    if (targetLong > maxLong) targetLong = maxLong;
    if (this.onPaste) {
      this.onPaste({
        blob: file,
        naturalW,
        naturalH,
        x: center.x,
        y: center.y,
        targetLongWorld: targetLong,
      });
    }
  }
}
