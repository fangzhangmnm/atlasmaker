# 同步策略 + UI 设计：对账 WebPaint sibling

写于 AtlasMaker 0.9.x。WebPaint 在 v45–v55 把云同步 / 保存按钮 / 重命名 / 全屏图库 这套打磨了几轮，文档在 [../../WebPaint/docs/sync-and-ui-shareback.md](../../WebPaint/docs/sync-and-ui-shareback.md)。本文 = **AtlasMaker 对账**：哪里同步、哪里不同、为什么、待补齐什么。

> 相关：[persistence-and-encryption.md](persistence-and-encryption.md)（核心 atomic / 加密设计，仍然有效）、[architecture.md](architecture.md)（快捷键 + DOM 结构）

---

## 1. 云策略：只 push，不 pull ✓ 同 WebPaint

- 本地 IDB = source of truth
- 云端 = backup + 跨设备搬运
- **没有"自动 pull"**。AtlasMaker 0.9.4 把顶栏 ↓ pull 按钮删了
- 跨设备同步路径：A 设备 push → B 设备打开 gallery 看到云端 tile → B 单击拉取并打开
- 412 冲突 → 不自动 sibling-copy（0.9.4+ 废了）

**和 WebPaint 唯一差异**：AtlasMaker 412 toast 当前只是提示「去 gallery 改名」，没有 inline 弹 rename sheet。待补齐（见 §4）。

## 2. Save 按钮：当前 3 态，待对齐到 5 态

**WebPaint**（单按钮 5 态视觉）：
| state | 触发条件 | 图标 | 点击 |
|---|---|---|---|
| `saving` | 正在写 IDB | disk 半透 | no-op |
| `cloud-busy` | 正在 push 云 | 云 + **旋转弧** | no-op |
| `dirty` | 本地未存 | 蓝 disk + 角点 | save + push |
| `cloud-dirty` | 本地已存 / 云未同步 | 橙 ↑ | push |
| `synced` | 全同步 | 灰云对勾 | no-op |
| `local-only` | 未登录 | 灰 disk | save |

**AtlasMaker 当前**（拆两个组件）：
- 顶栏 `#saveStatus` pill 显示文本：Saved / Saving / Dirty / Error（**本地状态**）
- 顶栏 `#cloudPushBtn` 只 2 态：normal / cloud-dirty 闪点（**云状态**）
- 没有 cloud-busy 旋转、没有 synced cloud-check、没有未登录 local-only 提示

**对账决定**：
- ✅ **加 cloud-busy 旋转动画**（low-hanging，本 bump 做）
- 🔜 **重做 cloudPushBtn 成 5 态**（独立 bump）。同时移除 / 简化 saveStatus pill — WebPaint 单按钮承载更紧凑，AtlasMaker 横向空间够但保留两个组件让 user 视线分散
- ✅ Click 行为对齐：永远是 `saveCurrentSession({ explicit: true })`（local + cloud 一把梭）

## 3. 快捷键 + Coalesce

### 快捷键 ✓ 对齐
- Ctrl+S = save + push
- Ctrl+Shift+S = local only
- Ctrl+Z / Shift+Z / Y = undo / redo

### Coalesce — AtlasMaker 0.9.11 与 WebPaint v52 比较

**WebPaint 的实现**：
- `_inFlightSaveType ∈ {"local", "push", null}`，`_savePending ∈ {"local", "push", null}`
- `_editVersion`（任何 `wp:histchange` 递增）/ `_inFlightStartVersion`（save start 时记下）
- 规则：
  - 当前没在跑 → 立刻跑
  - 当前在跑 + 中间没新编辑 + 同类型 → no-op
  - 当前在跑 + 中间真改了 → queue pending（同类型 / 升级）
  - **当前在跑是 `local` + 用户按 push → 必须 queue push**（云端还没推过，即使没新编辑）
  - pending 升级：push 覆盖 local

**AtlasMaker 0.9.11 的实现**：
- `_pendingSaveOpts` 单 slot
- drain 条件 = `_dirty`（保存中是否被 `markDirty` 复活）
- pending 覆盖：新 opts 完全替换旧 pending

**Gap**：AtlasMaker 当前**漏一个 corner case**：
1. 3-min autosave timer 在跑（`explicit: false`，本地 only）
2. 期间 _dirty 已经被 autosave set false（local 写完了）
3. 用户按 Ctrl+S（`explicit: true`，本地 + 云推）
4. saveCurrentSession 进，`_saving=true`，记 pending = `{explicit:true}`，return
5. autosave 完成 → finally → `_dirty=false`（中间没改东西）→ **不 drain**
6. 结果：用户的 explicit Ctrl+S **被吞了**，云没推

**修复**：drain 条件升级为：`_dirty || (pending.explicit && !inFlightWasExplicit)`。即「中间改了内容」**或**「用户的意图比正在跑的更强（local→explicit）」都要 drain。等价于 WebPaint 的「in-flight local + user 按 push → 必 queue push」。

本 bump 修复。

## 4. 重命名

**WebPaint v55**：
- 汉堡菜单「重命名当前画作…」入口（画画界面可调）
- 弹 in-app input sheet，本地同名循环检查
- **云冲突 (412) 自动弹同一个 sheet**，user 输入新名后 setCloudDirty + queueSave("push") 自动续推
- 数据安全：`_activeSessionName` 是 actually-loaded 真名，rename = save-new + delete-old 走它而不是 `localStorage.currentPath`

**AtlasMaker 当前**：
- 顶栏 `#sessionName` input 直接编辑（input 事件触发 markDirty）
- Gallery 头部 `#galleryCurrentName` 双向同步顶栏 sessionInput
- 412 冲突 → toast「Rename your board and Ctrl+S again」，**没有 inline rename sheet，没有自动弹**
- 本地同名也没有循环检查
- 数据安全：`_activeIDBPath` 是 actually-loaded（0.7.2 修了 ghost current）✓

**对账决定**（独立 bump）：
- 加汉堡菜单「Rename current board…」入口，弹 in-app sheet
- Sheet 内做同名循环检查
- 412 冲突时自动弹这个 sheet 让用户改名 → 续推
- 顶栏 sessionInput 改名仍可用（直接 in-place rename），sheet 是「正式重命名 + 强检查」的入口

## 5. 全屏图库（"full screen folder"）

**WebPaint v50+**：
- **无返回键**（session picker 模式：退路 = 点 active tile / 别的 tile / 新建）
- **没有「正在编辑」input** 在标题栏
- 进 / 退都 `saveNow`
- `body[data-mode="gallery"]` disable 主画布 UI（CSS hide canvas + 浮窗）
- Tile 状态：本地+云 / 纯云端 / 未上传 / 本地
- **未上传 + 已登录 → tile 旁「推送」按钮**（独立推这一幅）
- **本地+云 → tile 旁「卸载本地」按钮**（弱删除：清本地保留云）
- **底栏 IDB 占用**：`listSessions().map(s.size).reduce(+)`，**不**走 `navigator.storage.estimate()`（会算上 SW cache 虚高）
- **不显示 quota**（iOS 给 36GB 误导）

**AtlasMaker 0.9.4**：
- ✅ 全屏 overlay（z-index 60）
- ✅ Tile grid（auto-fill minmax 180px）
- ✅ 单击 tile 打开
- ✅ Thumb URL 不漏（_galleryThumbUrls 在 close 时 revoke）
- ❌ **有返回键** ← gallery-back 按钮
- ❌ **有「正在编辑」input**（galleryCurrentName 双向同步）
- ❌ 退时不 saveNow（只 revoke URL）
- ❌ 没有 body[data-mode] disable（但 z-index 60 全屏覆盖够 disable 视觉，pointer 不会穿透）
- ❌ 没 per-tile「推送」按钮（只能整体 Ctrl+S 推 active）
- ❌ 没「卸载本地」按钮（只有 Delete = 双端删）
- ❌ 没底栏 IDB 占用

**对账决定**：
- **保留返回键 + 正在编辑 input**：AtlasMaker 用户语境是 multi-board reference picker（你常常打开 gallery 看看其他参考板再返回）；这两个跟 WebPaint 的 "session picker only" 不同。决定差异化
- **进退都 saveNow**：✅ 本 bump 加
- **per-tile 推送按钮**：🔜 独立 bump
- **per-tile 卸载本地按钮**：🔜 独立 bump（也是低 friction，省云盘流量）
- **底栏 IDB 占用**：🔜 独立 bump

### z-index 排查约定
参考 WebPaint 那张表，AtlasMaker 当前实际：
```
40  通用 backdrop（password / form）
41  普通 modal（password / form 卡片）
50  hamburger dropdown
60  sessions-gallery 全屏
70  busy overlay（含 spinner，覆盖一切）
80  password / form dialog（gallery 内可弹）
90  busy overlay v2
```
混乱。**待整理**：用统一 base + step 10 的方案对齐 WebPaint。

## 6. 旋转动画 — 待加

WebPaint 的 cloud-busy spin：
```css
.tool[data-state="cloud-busy"] .spin-arc {
  animation: wp-spin 1s linear infinite;
}
@keyframes wp-spin { from { transform: rotate(0deg); } to { transform: rotate(360deg); } }
```

SVG 里：
```html
<g class="spin-arc" style="transform-origin: 12px 13px;">
  <path .../>
</g>
```

✅ 本 bump 加到 AtlasMaker：cloudPushBtn 处于 cloud-busy 状态时旋转。

## 7. iPad 坑（WebPaint 列了一堆，AtlasMaker 也都适用）

参考 WebPaint §7。AtlasMaker 已经做到的：
- ✅ SVG icon（不用 emoji）
- ✅ in-app dialog 代替 alert / prompt / confirm（pw-dialog / form-dialog / sheets）
- ✅ SW registration cached

AtlasMaker 没做（小到不必要）：
- visualViewport listener（AtlasMaker 没 canvas pixel buffer 这条线，只有 CSS 拉伸 DOM；不会偏移）
- Ghost pointer purge（AtlasMaker 不画笔触，不用纠结）

## 8. 不抄 WebPaint 的（AtlasMaker 不需要）
- 棋盘透明背景（atlas 都是普通图片）
- 参考小窗（atlas 本身就是参考板）
- liquify / lasso / 笔刷（无笔触工具）

---

## 改动 / 待办（cross-link 到 version.js）

- 0.9.11 — Coalesce v1，drain 条件 = _dirty
- 0.9.12 (this bump) — Coalesce v2 补「in-flight 非 explicit + pending explicit」漏；cloud-busy 旋转动画
- 0.10 — Save 按钮 5 态整合；汉堡 Rename sheet + 412 auto-prompt；gallery 进退 saveNow；per-tile push / unload；底栏 IDB 占用
- 后续 — z-index 重新整理
