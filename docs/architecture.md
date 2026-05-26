# AtlasMaker 架构（一期）

> 谁先看到这个文档：下一位接手的 AI / 我自己回来续命。
> 这只是「一期决策」，不要当圣经 —— proposal 会更新，遇到大决策先回去重读 [../journal/20260524 proposal.md](../../journal/20260524 proposal.md)。

## 一期范围

- 无限工作台（pan / zoom）
- 粘贴图片（Ctrl+V）落到光标视野中心
- 鼠标拖动单个对象
- 拖框生成 viewport（带分辨率 + 插值），可导出 PNG
- 主题切换、SW 缓存、更新 toast

明确**不做**（一期）：
- 持久化（IndexedDB / OneDrive）—— 等 [[../../WebPaint]] 把同步定下来再抄
- 选区多选、变换把手（resize、rotate、perspective）
- 裁剪 / 透视修正 / 调色
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

### 4. 粘贴时按"长边 ≤ 800 世界 px"显示

避免一张 4K 屏幕截图占满整个视野。原始尺寸记在对象里（`naturalW/naturalH`），后期重新栅格化或调分辨率会用到。

### 5. Viewport 光栅化算法

`rasterizeViewport(vp)`：
1. 开一张 `vp.resW × vp.resH` 的 `<canvas>`
2. 遍历 scene（按 DOM 顺序，底图先画）
3. 跳过和 `vp` 包围盒不相交的图片
4. `drawImage(imgEl, dx, dy, dw, dh)`，dx/dy/dw/dh 把世界坐标换算到输出图坐标
5. `interp === "nearest"` → `imageSmoothingEnabled = false`

这个函数后期要喂给 BlenderTextureProtocol（直接传 blob，不下载）。

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

## 已知小坑

- **paste 事件**：必须挂 window 才能在没有 input focus 时收到。当前已挂。
- **跨源图**：从某些网站拖过来的图 `drawImage` 会污染 canvas，`toBlob` 会失败。粘贴本地 / 屏幕截图没问题。
- **中键 / 左键判别**：`ev.button === 1` 是中键，`ev.buttons & 4` 是中键 mask（容易写错）。
