// 输入：pointer + wheel + 键盘 + 剪贴板。
// 工具：select（默认）、hand、viewport（拖框生成）。
// 通用：中键 / 空格临时变 hand；滚轮 zoom（光标为锚点，holding Ctrl 更快）。

import { rotatedAABB, nextDefaultViewportBinding } from "./objects.js";

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
    // Crop 模式期间锁住普通 scene 交互（pan / 选择 / marquee 都禁）。
    // 中键 / 空格 → pan，无论当前工具
    const wantPan = ev.button === MIDDLE_BTN || (ev.buttons & MIDDLE_MASK) || this._effectiveTool() === "hand";
    if (document.body.dataset.cropMode === "1") {
      // crop handles 自己 stopPropagation；这里到达的都是非 handle 点击（背景 / 别的 obj）
      // 允许 pan（中键 / 空格），其它一律忽略，防误选误清
      if (!wantPan) return;
    }
    if (wantPan) {
      this._panState = {
        startX: ev.clientX, startY: ev.clientY,
        startTx: this.board.viewport.tx,
        startTy: this.board.viewport.ty,
      };
      document.body.dataset.panning = "1";
      return;
    }
    // viewport 工具：拖框（aspect-locked，外观和 final viewport 一致）
    if (this.tool === "viewport") {
      const w = this.board.screenToWorld(ev.clientX, ev.clientY);
      this._marqueeState = { x0: w.x, y0: w.y, node: null, label: null, lastDx: 0, lastDy: 0 };
      return;
    }
    // eyedropper 工具：单击采色 + 生成 swatch。处理完自动回 select 工具。
    if (this.tool === "eyedropper") {
      let elE = ev.target;
      while (elE && elE !== this.boardEl && !(elE.classList && elE.classList.contains("obj"))) {
        elE = elE.parentElement;
      }
      const hitObjE = (elE && elE.classList && elE.classList.contains("obj"))
        ? this.scene.get(elE.dataset.id)
        : null;
      if (this.hooks.onEyedropper) {
        this.hooks.onEyedropper({ obj: hitObjE, clientX: ev.clientX, clientY: ev.clientY });
      }
      return;
    }
    // select 工具：用 ev.target 走 DOM —— viewport 的 pointer-events: none 自动让点穿透到图，
    // 只有 .vp-edge 接到点击就选中 viewport；图直接选图。
    let el = ev.target;
    while (el && el !== this.boardEl && !(el.classList && el.classList.contains("obj"))) {
      el = el.parentElement;
    }
    const hitObj = (el && el.classList && el.classList.contains("obj"))
      ? this.scene.get(el.dataset.id)
      : null;
    if (hitObj) {
      if (ev.shiftKey) {
        // shift-click：toggle 选择，不开始拖拽
        if (this.scene.selection.has(hitObj.id)) this.scene.deselect(hitObj.id);
        else this.scene.select(hitObj.id, true);
        return;
      }
      // 普通点：如果不在选区内，替换为只选这个；在选区内则保持多选
      if (!this.scene.selection.has(hitObj.id)) this.scene.select(hitObj.id, false);
      // 锁住的 obj 选中但不开始拖拽。多选时也只挪没锁的。
      const items = [];
      for (const id of this.scene.selection) {
        const o = this.scene.get(id);
        if (o && !o.locked) items.push({ id, ox: o.x, oy: o.y });
      }
      if (!items.length) return; // 全锁，不拖
      this.scene.beginAct();
      this._dragState = {
        items,
        startX: ev.clientX,
        startY: ev.clientY,
        moved: false,
      };
    } else {
      // 空白处按下：marquee 框选
      this._marqueeSelState = {
        startX: ev.clientX,
        startY: ev.clientY,
        additive: !!ev.shiftKey,
        el: null,
      };
      if (!ev.shiftKey) this.scene.clearSelection();
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
      // 多选时一起挪
      for (const item of this._dragState.items) {
        this.scene.update(item.id, {
          x: Math.round(item.ox + dx),
          y: Math.round(item.oy + dy),
        });
      }
      this._dragState.moved = true;
      return;
    }
    if (this._marqueeSelState) {
      const r = this.boardEl.getBoundingClientRect();
      const x0 = this._marqueeSelState.startX;
      const y0 = this._marqueeSelState.startY;
      const L = Math.min(x0, ev.clientX) - r.left;
      const T = Math.min(y0, ev.clientY) - r.top;
      const W = Math.abs(ev.clientX - x0);
      const H = Math.abs(ev.clientY - y0);
      if (!this._marqueeSelState.el) {
        const n = document.createElement("div");
        n.className = "marquee-select";
        this.boardEl.appendChild(n);
        this._marqueeSelState.el = n;
      }
      const n = this._marqueeSelState.el;
      n.style.left = `${L}px`;
      n.style.top = `${T}px`;
      n.style.width = `${W}px`;
      n.style.height = `${H}px`;
      return;
    }
    if (this._marqueeState) {
      const w = this.board.screenToWorld(ev.clientX, ev.clientY);
      const { x0, y0 } = this._marqueeState;
      // 锁 1:1（default viewport ratio）。锚点在 (x0, y0)；cursor 决定主导轴的方向 + 长度，副轴反推。
      const ASPECT = 1;
      let dx = w.x - x0;
      let dy = w.y - y0;
      const sgnX = dx >= 0 ? 1 : -1;
      const sgnY = dy >= 0 ? 1 : -1;
      if (Math.abs(dx) > Math.abs(dy) * ASPECT) {
        dy = sgnY * Math.abs(dx) / ASPECT;
      } else {
        dx = sgnX * Math.abs(dy) * ASPECT;
      }
      this._marqueeState.lastDx = dx;
      this._marqueeState.lastDy = dy;
      const x = Math.min(x0, x0 + dx), y = Math.min(y0, y0 + dy);
      const wW = Math.abs(dx), hH = Math.abs(dy);
      if (!this._marqueeState.node) {
        // 跟最终 viewport DOM 结构一致：.obj.viewport + 4 条 .vp-edge + 一个 .vp-label
        // 视觉上立刻就是 WYSIWYG，不再用「朴素矩形」误导
        const n = document.createElement("div");
        n.className = "obj viewport vp-marquee";
        for (const side of ["top", "right", "bottom", "left"]) {
          const e = document.createElement("div");
          e.className = `vp-edge ${side}`;
          n.appendChild(e);
        }
        const label = document.createElement("span");
        label.className = "vp-label";
        n.appendChild(label);
        this.board.worldEl.appendChild(n);
        this._marqueeState.node = n;
        this._marqueeState.label = label;
      }
      const n = this._marqueeState.node;
      n.style.left = `${x}px`;
      n.style.top = `${y}px`;
      n.style.width = `${wW}px`;
      n.style.height = `${hH}px`;
      // 让 marquee label 显示马上要分到的 default binding —— WYSIWYG，落下后这个就是 viewport 上的字
      if (!this._marqueeState.defaultName) {
        this._marqueeState.defaultName = nextDefaultViewportBinding(this.scene);
      }
      this._marqueeState.label.textContent = this._marqueeState.defaultName;
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
      this.scene.endAct(); // 内部会判断是否真改了 (_actDirty)；没动就不入栈
      return;
    }
    if (this._marqueeSelState) {
      const { startX, startY, additive, el } = this._marqueeSelState;
      this._marqueeSelState = null;
      if (el) el.remove();
      const w0 = this.board.screenToWorld(startX, startY);
      const w1 = this.board.screenToWorld(ev.clientX, ev.clientY);
      const x0 = Math.min(w0.x, w1.x), y0 = Math.min(w0.y, w1.y);
      const x1 = Math.max(w0.x, w1.x), y1 = Math.max(w0.y, w1.y);
      // 太小当点击空白处（已 clearSelection）
      if (x1 - x0 < 4 && y1 - y0 < 4) return;
      const hits = [];
      for (const obj of this.scene.objects.values()) {
        // 旋转后的 AABB 才是 obj 的视觉包围盒
        const a = rotatedAABB(obj);
        if (a.x1 >= x0 && a.x0 <= x1 && a.y1 >= y0 && a.y0 <= y1) {
          hits.push(obj.id);
        }
      }
      this.scene.selectMany(hits, additive);
      return;
    }
    if (this._marqueeState) {
      const { x0, y0, lastDx, lastDy, node } = this._marqueeState;
      this._marqueeState = null;
      if (node) node.remove();
      // 用最后一次 pointermove 锁过 aspect 的 dx/dy（点击 = 0/0 → 走 fallback default）
      const x = Math.min(x0, x0 + lastDx), y = Math.min(y0, y0 + lastDy);
      const wW = Math.abs(lastDx), hH = Math.abs(lastDy);
      if (this.onViewportFinish) {
        if (wW < 16 || hH < 16) {
          // 太小当点击处理 —— 给个默认尺寸放在 pointer 处
          this.onViewportFinish({ x: x0, y: y0, w: 512, h: 512 });
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
    // 只对**文本编辑**类元素 swallow scene 快捷键（避免误删 obj 等 0.9.x 报告过的「输 Backspace 删图」类 bug）。
    // range / checkbox / color / file 等 input 没有文本编辑历史概念 —— Ctrl+Z 应该穿透给 scene undo。
    const inputType = (tgt && tgt.tagName === "INPUT") ? (tgt.type || "text").toLowerCase() : "";
    const inTextInput = tgt && (
      (tgt.tagName === "INPUT" && /^(text|password|email|search|tel|url|number)$/.test(inputType))
      || tgt.tagName === "TEXTAREA"
      || tgt.isContentEditable
    );
    // Ctrl+S / Ctrl+Shift+S 在 input-focus guard **之前**处理：
    // 永远 preventDefault（避免浏览器弹「保存网页」对话框），永远 call hook —— hook 内部
    // 会判 _loading / _saving 决定要不要真存（密码 dialog / boot apply 期间会 refuse）。
    // 用户在 sessionInput / galleryCurrentName 改名时按 Ctrl+S 也应该保存（保存名字改动），合理。
    // 用户在密码 dialog 按 Ctrl+S → hook 看到 _loading=true → refuse + toast。
    if ((ev.ctrlKey || ev.metaKey) && (ev.key === "s" || ev.key === "S")) {
      ev.preventDefault();
      if (ev.shiftKey) {
        if (this.hooks.onSaveLocal) this.hooks.onSaveLocal();
      } else {
        if (this.hooks.onSave) this.hooks.onSave();
      }
      return;
    }
    if (inTextInput) return;
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
    // Ctrl+C 复制选中图片到系统剪贴板
    if ((ev.ctrlKey || ev.metaKey) && (ev.key === "c" || ev.key === "C") && !ev.shiftKey) {
      if (this.hooks.onCopy) this.hooks.onCopy();
      ev.preventDefault();
      return;
    }
    // z-order：Ctrl+] / Ctrl+[ 单步；加 Shift 顶 / 底
    if ((ev.ctrlKey || ev.metaKey) && (ev.key === "]" || ev.key === "[")) {
      const top = ev.key === "]";
      this.scene.act(() => {
        for (const id of this.scene.selection) {
          if (ev.shiftKey) {
            if (top) this.scene.raiseToTop(id); else this.scene.lowerToBottom(id);
          } else {
            if (top) this.scene.raiseOne(id); else this.scene.lowerOne(id);
          }
        }
      });
      ev.preventDefault();
      return;
    }
    // undo / redo
    if ((ev.ctrlKey || ev.metaKey) && (ev.key === "z" || ev.key === "Z")) {
      if (ev.shiftKey) this.scene.redo(); else this.scene.undo();
      ev.preventDefault();
      return;
    }
    if ((ev.ctrlKey || ev.metaKey) && (ev.key === "y" || ev.key === "Y")) {
      this.scene.redo();
      ev.preventDefault();
      return;
    }
    // 注：Ctrl+S / Ctrl+Shift+S 已在顶部 input-focus guard 之前处理（永远 preventDefault）。
    // 单字符工具切换（V 已经被 Ctrl+V 占用 → 不再绑 V 作工具，select 是默认）
    if (ev.key === "h" || ev.key === "H") this.setTool("hand");
    else if (ev.key === "r" || ev.key === "R") this.setTool("viewport");
    else if (ev.key === "s" || ev.key === "S") this.setTool("select");
    else if (ev.key === "i" || ev.key === "I") this.setTool("eyedropper");
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
    const longNat = Math.max(naturalW, naturalH);
    let targetLong = longNat / dpr;
    // 安全帽：粘进来后宽 AND 高都不超过当前视野的 2/3（防 4K 大图 / 长图塞满视野）
    const scale = this.board.viewport.scale;
    const capW = (r.width * 2 / 3) * longNat / (naturalW * scale);
    const capH = (r.height * 2 / 3) * longNat / (naturalH * scale);
    const maxLong = Math.min(capW, capH);
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
