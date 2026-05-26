# AtlasMaker 架构（一期）

> 谁先看到这个文档：下一位接手的 AI / 我自己回来续命。
> 这只是「一期决策」，不要当圣经 —— proposal 会更新，遇到大决策先回去重读 [../journal/20260524 proposal.md](../../journal/20260524 proposal.md)。

## 一期范围

- 无限工作台（pan / zoom），双层渲染（images / viewports），viewport 永远在最上面
- 粘贴图片（Ctrl+V）落到视野中心，1 世界 px = 1 物理 px（DPI-aware）
- 选择 / 拖动单个对象。viewport 走「边框选择」—— body 透明可穿透到下面的图
- 8 把手 resize（4 角 aspect-locked，4 边自由拉伸）
- Ctrl+D 复制选中
- 手动 z-order：Ctrl+] / Ctrl+[ 单步；加 Shift 到顶 / 底。或浮窗按钮
- X / Delete 删除（Blender 习惯对齐）
- 拖框生成 viewport（带分辨率 + 插值 + aspect lock），可导出 PNG 或复制到剪贴板
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

### 8. Undo / Redo（占位，未实现）

一期没做，但数据模型已经为它铺好。实现方案：

**Snapshot 法**（推荐）：每次 mutation 前把 `scene.objects`（一个 Map）的浅拷贝压栈：
```js
function snapshot() {
  return new Map([...scene.objects].map(([k, v]) => [k, { ...v }]));
}
```
回滚就是替换整个 map + 重建 DOM。一两百个对象的 scene 这么搞内存毫无压力。

要求：
- 所有 obj 字段都可浅拷贝（没有内嵌可变子对象） —— ✓ 当前满足
- Blob 引用允许共享（不可变） —— ✓ 已经是这样
- DOM 节点要能从纯数据重建 —— ✓ `Scene._renderNode` 就是干这个的

未来如果 obj 内嵌嵌套对象（如 viewport.bindings 列表），改成结构化深拷贝即可。

**Command 法**：如果以后单步操作变得很重（如 1000 张图片 resize），按 mutation 类型做 inverse command 更省。但这种规模在 AtlasMaker 里大概率不会出现。

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

### 12. Overlay 在屏幕 px，不在 #world 里

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
- `Ctrl+D` 复制
- `Ctrl+]` / `Ctrl+[` z-order 上 / 下一步；加 `Shift` 到顶 / 底
- `Space` / 中键临时平移；`H` 切平移工具；`R` viewport 工具；`S` 选择工具
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
