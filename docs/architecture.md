# AtlasMaker 架构（一期）

> 谁先看到这个文档：下一位接手的 AI / 我自己回来续命。
> 这只是「一期决策」，不要当圣经 —— proposal 会更新，遇到大决策先回去重读 [../journal/20260524 proposal.md](../../journal/20260524 proposal.md)。

## 一期范围

- 无限工作台（pan / zoom），双层渲染（images / viewports），viewport 永远在最上面
- 粘贴图片（Ctrl+V）落到视野中心，1 世界 px = 1 物理 px（DPI-aware）
- 选择 / 拖动单个对象。viewport 走「边框选择」—— body 透明可穿透到下面的图
- 8 把手 resize（4 角 aspect-locked，4 边自由拉伸）+ 1 旋转把手（顶部外侧，shift 吸附 15°）
- 旋转：每个 obj 有 `rotation` 字段（度数），CSS `transform: rotate` 实现；resize 数学全部走 anchor-world + 反旋转的统一公式
- 多选：marquee 空白处框选；shift-click 加入 / 取消；多选时 union AABB 高亮，禁用 resize 把手；拖任何一个 → 一起挪
- Undo / Redo：snapshot 法，`Ctrl+Z` / `Ctrl+Shift+Z` / `Ctrl+Y`。每次 mutation 前自动 snap，拖拽 / resize 走 beginAct/endAct 不重复入栈
- Ctrl+D 复制选中
- 手动 z-order：Ctrl+] / Ctrl+[ 单步；加 Shift 到顶 / 底。或浮窗按钮
- X / Delete 删除（Blender 习惯对齐）
- 拖框生成 viewport（带分辨率 + 插值 + aspect lock），可导出 PNG 或复制到剪贴板
- 顶栏 session 名输入（仅显示 + 改 document.title；不持久化）
- 主题切换、SW 缓存、更新 toast（4 路径检测，HUD 显示版本号）

明确**不做**（一期）：
- 持久化（IndexedDB / OneDrive）—— 等 [[../../WebPaint]] 把同步定下来再抄
- 多选 marquee、群组、对齐 snap
- 旋转、透视修正
- 裁剪 / 调色
- BlenderTextureProtocol 绑定 —— 占位字段已经在 viewport 对象里
- 移动端 / iPad 支持（先 PC localhost 跑通）

## 关键决策

### 1. DOM 渲染图片对象，不 redraw canvas

参考图可能堆几十张大图，用 `<img>` 让浏览器原生 GPU compositing 接管：
- 缩放 / 移动只改 transform，无 JS 重绘
- 跨 retina 一切都对
- 选区高亮就是 `outline`，不用每帧手画

代价：viewport 光栅化要单独拉一张 `<canvas>` 出来 `drawImage` 每张相交的图片。
这是个**单次**操作（导出 PNG / 推 Blender），不在热路径上。

### 2. 世界单位 = 1 像素 @ scale=1

`#world` 是个 0×0 的绝对定位容器，挂在 `#board` 上。`#world` 唯一的样式就是 `transform: translate(tx,ty) scale(scale); transform-origin: 0 0;`。

子节点用世界 px 写 `left/top/width/height`，浏览器自动跟着 transform 缩放。**屏幕 ↔ 世界**的换算只在做命中测试 / 拖动 / 缩放锚点的时候算一次，不参与渲染。

### 3. 网格背景在 #board 上，不在 #world 里

网格用 CSS 的 `radial-gradient` + `background-size/position`，由 JS 把 `--bg-size / --bg-x / --bg-y` 跟 pan/zoom 联动写到 board 上。这样网格永远是屏幕 px 精度，不会因为放大而糊成色块。

### 4. 粘贴 DPI-aware：1 世界 px = 1 物理屏幕 px

Win+Shift+S 之类截屏是**物理像素**。在 1.5x 显示器上不校正的话，naturalWidth=450 的图按 CSS px 渲染会被放大 1.5 倍。

校正：`targetLongWorld = max(naturalW, naturalH) / devicePixelRatio`。然后 scale=1 时图在屏幕上正好 = 原截屏的物理像素数 = 「我截到什么样就看到什么样」。

安全帽：长边再大也不超过当前视野短边的 90%（防 4K 截屏一来塞满视野）。

原始分辨率（`naturalW/H`）单独记，给导出 / 后期高质量光栅化用。

### 5. 8 把手 resize（4 角 + 4 边）

- 角把手 (`nw, ne, sw, se`)：`aspectLocked === true` 时 uniform scale 保持比例；`false` 时自由 2D。
- 边把手 (`n, e, s, w`)：永远只动一轴，**会改变长宽比** —— 用户拖边就是想 stretch，所以不强行守 aspect。
- viewport `aspectLocked === true` 时，边拖完导致 rect 比例变了 → res 也按比例跟上（保留 max(resW,resH)），保证「res 比例 = rect 比例」恒等。
- viewport 浮窗里改 resW / resH（locked）→ 只调另一个 res 值，不动 rect。

### 6. Viewport 是个框，不是 canvas

Board 是 DOM 不是 canvas：`#world` 是 div + CSS transform，图是 `<img>` 元素，浏览器原生采样。viewport 也是 DOM —— 一个透明 div + 4 条 dashed 边带 + 一个 label，**自己不画内容**。透过 viewport 看到的就是底层 `<img>` 在当前 zoom 下的浏览器采样结果。

**为什么不在 viewport 里塞一个 resW×resH 的预览 canvas**：曾经试过（v3），用户砍了。理由：
- 预览根本不需要「按 viewport 分辨率」 —— 用户要看到的就是源图，缩放看精度
- 源图天然就在 `<img>` 里，**zoom in 就能放大到原生像素**（图当前显示尺寸 ≥ naturalW 时，每个源像素 ≥ 1 物理屏幕 px）
- 加预览 canvas 反而要在每次 scene.onChange 重画，开销没必要

所以 viewport 实时显示走浏览器原生路径。导出走另一条专门的、**按需**的光栅化。

### 6a. 导出光栅化 —— `rasterizeViewport(vp)`（async，按需）

点「导出 PNG」/「复制到剪贴板」时跑一次：

1. 临时 `document.createElement("canvas")` —— 输出 buffer = `vp.resW × vp.resH`
2. `imageSmoothingEnabled = vp.interp !== "nearest"`
3. 按 DOM 顺序遍历 `scene.listImages()`，跳过和 vp bbox 不相交的
4. **`createImageBitmap(obj.blob)` 从 Blob 现解码** —— 拿自然分辨率，不靠 DOM `<img>` 的浏览器解码缓存（chrome 会在小尺寸显示时丢高清缓存，drawImage 拿到的可能是缩小版）
5. `drawImage(bitmap, dx, dy, dw, dh)` + `bitmap.close()`
6. `canvas.toBlob("image/png")`

输出走两路：
- 下载：`downloadBlob(blob, "viewport-WxH.png")`
- 剪贴板：`navigator.clipboard.write([new ClipboardItem({ "image/png": blob })])`

后期 BlenderTextureProtocol 也接 blob。

### 7. Image 对象拥有 Blob，懒生成 URL

之前是 `obj.src = blob_url`。两份 obj（duplicate）共享 src 时，revoke 行为很容易把别人弄废。

现在：
- `obj.blob` 是 `Blob` 引用（**不可变**，多 obj 共享完全安全）
- `obj._displayUrl` 在 `Scene._renderNode` 里 `URL.createObjectURL(obj.blob)` 懒生成，每个 obj 一份
- `Scene.remove` 只 revoke 自己的 `_displayUrl`，不关心别人
- duplicate：浅拷贝 obj，`_displayUrl = null`，下次渲染时重新生成 URL。Blob 引用共享（不可变所以安全）

这套设计同时给「Ctrl+Z 删除恢复」铺好路 —— 删除时不要丢 Blob 引用，将来从 undo stack 恢复 obj 就能直接重新生成 URL。

### 8. Undo / Redo（已实现，snapshot 法）

实现位置：`Scene.snapshot / restore / commit / act / beginAct / endAct / undo / redo`。

**Snapshot 内容**：`{ objects: Map<id, { ...obj, _displayUrl: null }>, imageOrder: [id...], viewportOrder: [id...], selection: Set<id> }`。
- obj 字段全部浅拷贝。`blob` 是同一个 Blob 引用（不可变所以安全）。
- `_displayUrl` 在 snapshot 里强制置 null —— restore 时让 `_renderNode` 重新生成 URL，避免悬空。
- 顺序记两个数组（images / viewports 各自的 DOM 顺序）—— 这是 z-order 真相。
- 选区一并记。

**触发模式**：
- 原子动作 → `scene.act(fn)`：snap 之前的状态，跑 fn，commit。粘贴、复制、删除、z-order、panel 改值、viewport 创建都走这条。
- 拖拽 / resize / rotate → `beginAct()` + `endAct()`：pointerdown 时 snap，pointermove 调 `update()`（标记 dirty），pointerup 时 `endAct()` —— 真改了才 commit，纯点击不入栈。
- 选区变化不入栈（不算可撤销动作；但 snapshot 时会捕获选区附带在 mutation 上下文里）。

栈深 `MAX_UNDO = 100`，溢出时丢最早的。redo 栈在任何新 commit 时清空（标准 undo 行为）。

**坑**：
- 用户拖出 marquee 选了 5 个 obj 然后挪一下：begin 时 snap（含「这 5 个被选」状态），endAct 提交。undo 时同时恢复「这 5 个的旧位置」和「这 5 个被选」。
- duplicate 现在 emits 多次（add + selectMany），但都在同一个 act() 内，只产生一个 undo entry。
- 删除是真删（含 revoke URL）；undo 时 `_renderNode` 重新拿 obj.blob 生成新 URL。Blob 对象仍活着，因为 snapshot 持有引用。
- URL 泄漏：每次 undo/restore 都生成新 URL，老 URL 没显式 revoke。session 内有限，能接受。如果将来真泄漏严重再做 GC。

### 9. 双层渲染 + viewport 边框选择

`#world` 下两个层：
```
#world
  .layer.images       ← 所有 image 对象
  .layer.viewports    ← 所有 viewport 对象（永远在 images 上）
```

viewport 的「边框选择」：
- `.obj.viewport` 整个 div 设 `pointer-events: none`，body 透明可点穿到下面的图
- 4 个子 `.vp-edge` 边带（top/right/bottom/left），各占 8 世界 px，`pointer-events: auto`
- 视觉 dashed 边框由这 4 条边带各自的 `border-top/right/bottom/left` 渲染（不是 .obj.viewport 自己）
- 用户点 viewport body → 落到下面的图；点 viewport 边框 → 选中 viewport

input.js 的 `_onPointerDown` 用 `ev.target` 往上走找最近的 `.obj` 作为命中，不再用世界坐标 hitTest。这样 DOM `pointer-events` 配置直接决定行为，不用在 JS 里重复一遍。

### 10. Z-order 手动控制

每个对象在自己所在层内可以：
- `Ctrl+]` 上移一步（raiseOne）
- `Ctrl+[` 下移一步（lowerOne）
- `Ctrl+Shift+]` 顶层（raiseToTop）
- `Ctrl+Shift+[` 底层（lowerToBottom）

或浮窗里按 ⤒ / ↑ / ↓ / ⤓ 按钮。

实现就是 DOM 节点在 parent layer 内的 insertBefore/appendChild。viewport 永远在 images 上，靠双层 DOM 结构保证，z-order 操作不会跨层（也不应该）。

`scene.listImages()` 现在按 DOM 顺序遍历 —— 这就是 paint 顺序（底图先画），也是导出时正确的合成顺序。

### 11. 版本号 SSoT + 4 路径 SW 检测

详见 [`pwa-update-detection.md`](pwa-update-detection.md)（AtlasMaker 本地副本）。canonical doc：[../../WebPaint/docs/pwa-update-detection.md](../../WebPaint/docs/pwa-update-detection.md)。

要点：
- 版本号 SSoT 在 [`src/version.js`](../src/version.js)，三处引用（HTML / SW / app.js）
- HUD 末位常驻版本号 —— **user 必须能不操作就读到当前装的是哪版**
- 4 条检测路径全挂（`waiting` / `updatefound+installed` / `asset-updated` postMessage / 主动 poke）
- `LOCAL_DEV_HOSTS` 白名单跳过 SW 注册（dev 时 F5 不被 cache 挡）

### 12. 旋转：CSS rotate + anchor-world resize 数学

每个 obj 有 `rotation` 字段（度数）。`Scene._applyTransform` 写 `el.style.transform = "rotate(<r>deg)"`，`transformOrigin: 50% 50%`。视觉就转了。

**数据 vs 视觉**：obj 的 `x, y, w, h` 永远是「未旋转的 axis-aligned rect 在世界中的位置」，旋转纯视觉。这样很多代码（z-order、删除、复制、blob 引用）都不需要关心旋转。

但 resize 数学要小心。**关键公式**：拖把手时 anchor 的 world 位置在 drag 全程不动（drag start 时 `anchorWorldPos(obj, anchor)` 算一次存住）。pointermove 时：
1. `dWorld = cursor - anchor`（world）
2. `dLocal = R(-rotation)(dWorld)`（反旋转到 obj 自身坐标系）
3. 在 obj-local 算 newW / newH（直接读 dLocal 的两轴分量乘 sgn）
4. 锁比例 (corner + aspectLocked) 在 obj-local 处理
5. 新中心 = `anchorWorld - R(rotation)(anchorLocalAfter)`
6. 新 x, y = 新中心 - (newW/2, newH/2)

这个公式对 rotation=0 退化成原 axis-aligned 算法。所有 8 把手共用一套，corner / edge 只是 sgnX、sgnY 不同。代码：[`resizeRect`, `anchorWorldPos` in src/objects.js](../src/objects.js)。

**旋转把手**：单独一个圆形 handle，在 top-center 上方 24 屏幕 px。drag 时按 `atan2(dx, -dy)` 算新角度（local up `(0,-1)` 映射到 cursor 方向）。shift 吸附 15°。

**导出 rasterize**：每张图按「先 inverse-rotate 到 viewport-local，再 CTX.rotate(图相对 vp 的旋转) 后绘制」。这样 vp 自己有旋转也支持（虽然 vp 旋转不常见）。代码在 [`rasterizeViewport` in src/app.js](../src/app.js)。

**多选 marquee + AABB 命中**：用 `rotatedAABB(obj)` 算每个 obj 旋转后的世界包围盒，再和 marquee 矩形相交。`Scene.bboxes()` 也用这个，所以 fit-to-content 看到的是视觉边界。

### 13. Overlay 在屏幕 px，不在 #world 里

`.overlay` div 是 board 的子节点，不在 #world 里 —— 不被 transform 缩放。
选框（.overlay-rect）和 8 个把手（.overlay-handle）都直接定位用屏幕 px。
渲染时 `worldToScreen(obj.x, obj.y)` 换算坐标。

**坑**：拖把手时不能 `innerHTML = ""` 重建 overlay —— 那样会销毁 pointerCapture 的 handle DOM，drag 中断。
所以 `renderOverlay()` 用 `_renderedSelSig` 判断：选区集合 ID 没变就只更新现有元素的 left/top（不重建），变了才重建。

## 文件分工

- [src/board.js](../src/board.js) — viewport（pan/zoom）；屏幕 ↔ 世界换算；fit-to-content
- [src/objects.js](../src/objects.js) — Scene、Image/Viewport 对象、DOM 节点的增删改、命中测试
- [src/input.js](../src/input.js) — pointer / wheel / 键盘 / paste；工具切换
- [src/app.js](../src/app.js) — 顶栏 / HUD / viewport 浮窗 / 主题 / SW；连接其他模块
- [src/styles.css](../src/styles.css) — 米色 / 夜黑色板，跟兄弟项目一致

## 兄弟项目可以抄什么

| 来源 | 抄什么 | 何时 |
|---|---|---|
| [[ScratchPad]] | pointer/pen 输入、palm rejection、smoothing | 想支持 iPad / 触控笔时 |
| [[WebPaint]] | 主题色板、浮窗布局、错误条 | 已经抄了 |
| [[WebXiaoHeiWu]] | OneDrive AppFolder 同步、dirty tracking、conditional write | 引入持久化时 |
| [[RealHome]] | `docs/sync-constraints.md` 的核心约束（不擅自删网盘） | 引入持久化时 |
| [[JustReadBooks]] | `reconcileWithRemoteList` 空列表保护 | 引入持久化时 |

## 快捷键（参 [[feedback-blender-hotkeys]]）

- `X` / `Delete` / `Backspace` 删
- `Ctrl+Z` undo；`Ctrl+Shift+Z` / `Ctrl+Y` redo
- `Ctrl+D` 复制
- `Ctrl+]` / `Ctrl+[` z-order 上 / 下一步；加 `Shift` 到顶 / 底
- `Shift+click` toggle 加入 / 移出选区
- 空白处拖 marquee 多选
- `Space` / 中键临时平移；`H` 切平移工具；`R` viewport 工具；`S` 选择工具
- 旋转把手拖 +`Shift` 吸附 15°
- `0` fit to content
- `Esc` 取消选区

## 已知小坑

- **paste 事件**：必须挂 window 才能在没有 input focus 时收到。当前已挂。
- **跨源图**：从某些网站拖过来的图 `drawImage` 会污染 canvas，`toBlob` 会失败。粘贴本地 / 屏幕截图没问题。
- **中键 / 左键判别**：`ev.button === 1` 是中键，`ev.buttons & 4` 是中键 mask（容易写错）。
- **devicePixelRatio**：当前只在粘贴时取一次。用户把窗口拖到不同 DPI 的显示器之后再粘贴会用新值，老对象不变。可接受。
- **Duplicate 共享 object URL**：Ctrl+D 出来的拷贝和原图 src 指向同一 blob URL。Scene.remove 用「没有其他对象引用同一 src」检查决定要不要 revoke，避免悬空。
- **粘贴大图卡帧**：未做。decodeImage 不在主线程，但 `<img>` 解码大图时合成会顿。后期可以走 `createImageBitmap` 或 OffscreenCanvas。
- **粘贴时 dpr 在多显示器场景**：getBoundingClientRect 和 devicePixelRatio 都基于当前所在的显示器。粘贴瞬间正确就行。
