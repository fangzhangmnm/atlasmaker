# AtlasMaker 持久化 + 加密：设计决策回顾

> 写给下一个我 / 兄弟项目接手的 AI。AtlasMaker 0.5 → 0.7 这条线踩了一些坑、迭代了几次设计、和最直觉的方案分叉过。这里把关键决策与「为什么不这样做」都记下来。如果 WebPaint / 其他兄弟项目要做同类持久化，从这里抄；和 canonical PWA 同步模式 ([../../WebPaint/docs/pwa-update-detection.md](../../WebPaint/docs/pwa-update-detection.md)) 是并列的一份。

## TL;DR（直接抄这套）

1. **一个 session = 一个 atlas zip = 一次 IDB put**。原子写。不要拆 scene-json + 多个 blob 两个 store。
2. **保存策略：显式 Ctrl+S 主导 + 3 分钟 timer 兜底 + visibility/pagehide 兜底**。**不**抄 webxiaoheiwu 的 debounce / heartbeat。Blender 用户习惯 Ctrl+S；自动保存频繁带来不稳定。
3. **「保存」的语义** = 本地 IDB + 云端 push（如登录中）一起做。Ctrl+S 和云按钮**走同一条路径**，都是「完全保存」。autosave 是**不完全态**，只写本地 IDB，绝不触云 —— 用户没在场，412 sibling-copy 静默发生 = 数据失踪。Pull 仍是独立显式按钮（拉远端覆盖本地是 destructive，不能跟 save 混）。
4. **OneDrive layout = 一个 session 一个 zip 文件**，不要给用户网盘搞文件夹污染。
5. **冲突 412 走「停下让用户改名」**（0.9.4 修，废弃 sibling-copy）：Step 1 本地存了，step 2 云推 412 → toast 提示用户在 gallery 里改名后再 Ctrl+S。不自动 sibling-copy（不预期地多出 cloud 文件 = surprise，UX 重）。
6. **加密 = 外层明文 zip 包内层 AES-256 zip**。理由：网盘扫描器拒绝裸加密 zip；外层 STORE 让扫描器开心，内层用 password 把任何信息（包括 manifest / thumb）都关在里面。
7. **密码绝不存储**，关页面就忘。`_currentSessionPassword` 只在内存。
8. **取消加密走强 consent**：要求用户键入「确定取消加密」原文 + 验过原密码。误点零容忍。
9. **document.title 不要包含 session 名**。浏览器历史会按 title 把不同 session 显示成「都叫这个名的网页」，点了又跳不到对应 session，confusing 且 leak privacy。

## 演进史

| 阶段 | 改动 | 教训 |
|---|---|---|
| 0.5 (v9) | 拆 `scenes` + `blobs` 两个 IDB store；每次保存多 tx 写 | Refresh 在中间被截断 → 半边状态。`Ctrl+R 之后丢图 / 丢 viewport` 报告 |
| 0.6.0 (v11) | 合成一个 atomic zip 一次 put；保存策略改 Ctrl+S 主导 + 3min 兜底 | 改完之后 refresh 再不丢东西 |
| 0.6.0 | 加 thumb.png 进 zip，作为外层（明文）格式的一部分 | 加密化后 thumb 必须搬进加密层（不能在明文 metadata 露脸） |
| 0.6.0 | 多 session：IDB key 改成 path（`name.atlas.zip` / `chars/wall.atlas.zip`），加 sessions 模态 | path 里允许 `/` —— 顺手得到子文件夹组织能力 |
| 0.6.0 | OneDrive: MSAL（vendored）+ 一文件一 session + sibling-on-412 + cloud-dirty 指示 | autosave **不**触云；用 ↑ 按钮上的脉冲点表达「本地 ahead」 |
| 0.6.1 | 重命名后云端旧 zip 没被删 → push 成功后清理旧 cloud item | 跟踪 `_activeIDBPath` / `_activeCloudPath` 在 push 时做 rename detection |
| 0.7.0 | AES-256 per-session 加密，zip 包加密 zip 结构 | 用 vendored `zip.js`（gildas-lormeau），不自写 WinZip 实现 |
| 0.7.1 | 密码错可以重试；title 不显示 session 名 | 出错时 inline 重 prompt，不让用户跑掉一次错的就再无机会 |
| 0.9.0 | 英文 UI；boot 失败 fallback 找 fresh "Untitled (N)" slot（防覆盖既有 Untitled）；busy overlay 锁 UI；密码 prompt 改 themed dialog（防 browser 把它当账号密码保存） | Untitled 默认要找 fresh slot，否则两个 Untitled 撞在一起会覆盖 |
| 0.9.1 | 致命 bug 修复：`_idSeq` 撞 id 炸板 | 见下文「id 序列模块级状态 vs 持久化 = 炸板」陷阱 |
| 0.9.x | **Ctrl+S 重新定义为"完全保存" = 本地 + 云推**；云按钮走同一路径；autosave 仍只写本地 | 见下文「local-only 是不完全态」一节 |

## 文件格式

### 不加密

```
<sessionName>.atlas.zip      ← STORE-only 直接 atlas zip
├── scene.json               ← 元数据：name, board, objects[], imageOrder, viewportOrder
├── images/<uuid>.<ext>      ← 每张源图（uuid 文件名避免冲突）
└── thumb.png                ← 当前可见区域 ≤512px PNG（多 session UI 卡片预览用）
```

### 加密（per-session AES-256）

```
<sessionName>.atlas.zip      ← 外层 STORE-only 明文 zip（网盘扫描器友好）
└── data.atlas.zip           ← 内层 AES-256 加密 zip（zip.js encryptionStrength=3）
                                  解开后才是 scene.json + images/ + thumb.png
```

**外层故意不放 manifest 或任何标签**：只一个 entry 叫 `data.atlas.zip`。所有 session 信息（包括名字、thumb）都在加密层。「这是 atlas 加密包」的事实通过条目名识别。

**为什么要外层 wrap**：
- 部分网盘 / 邮箱扫描器看到顶层加密 zip 直接 quarantine / reject —— 扫不了内容 = 默认不信
- 7-Zip / Mac unzip 解一层后看到 `data.atlas.zip`，双击 → 弹密码 → 标准体验，不黑盒
- 内层 AES-256 仍是标准 WinZip 加密，外部工具可直接打开

**为什么不用 ZipCrypto**：弱密，几秒可破，名义加密。zip.js 支持但我们 UI 不暴露。

## IDB schema

```
DB: atlasmaker (version 2)
  store: sessions
    key:   <session path>          // e.g. "characters/wall.atlas.zip"
    value: {
      name: string,                // user-given display name
      updatedAt: number,           // ms epoch
      atlas: Blob,                 // 完整 zip（加密 / 不加密）
      thumb: Blob | null,          // 加密 session 是 null
      encrypted: boolean,
    }
```

key 用 path（带 `/`）：
- 一个 session = 一个 key，atomic put
- 子文件夹 / 命名空间天然支持
- 重命名 = put new + delete old（一次 IDB 操作）

旧 stores（v1 的 `scenes` / `blobs`）保留在 IDB 不删 —— DevTools 还能翻历史。新代码不读。

## 保存策略：用户主导，不要 debounce 复杂度

抄 [WebXiaoHeiWu sync-design](../../20260516 WebXiaoHeiWu/docs/sync-design.md) 的智慧但 **反向应用**：

webxiaoheiwu 是连续文字编辑，user 反对 sub-second debounce「我不小心碰了文件你别立刻推」→ 用 15s/30s heartbeat + ceiling + trivial-skip。

AtlasMaker 是 Blender 工作流，user 习惯 Ctrl+S 主导，自动保存频繁反而带来不稳定。所以：

- `Ctrl+S` 立刻 `saveCurrentSession()` —— 用户主导
- `setInterval(saveIfDirty, 3*60*1000)` —— 3 分钟兜底
- `visibilitychange → hidden` —— 关 tab 前抢救
- `pagehide` —— 同上，移动端 / iOS 更可靠
- **不要** debounce / heartbeat / trivial-skip / single-flight / `flushKeepalive` 这套 webxiaoheiwu 那种复杂性
- IDB save 是 atomic，关页面中间截断 = 没写 = 用户上次 Ctrl+S 是 ground truth

## 云端同步策略

### 「保存」= 本地 + 云（用户在场时），autosave = 不完全态

> **0.9.x 心智模型修正**。0.6 - 0.8 期一直走「Ctrl+S = 本地 only，云得另外点按钮」，理由是怕 autosave 偷推。但这把「用户在场显式按 Ctrl+S」也牵连进去了 — 用户在场的话 412 sibling 弹窗他看得到，没有失踪风险。修正后：

| 触发 | 本地 IDB | 云推 | 心态 |
|---|---|---|---|
| **Ctrl+S** | ✅ | ✅（如登录） | 「我现在就要 commit，到云上」 |
| **云按钮 ↑** | ✅ | ✅（如登录） | 同上，跟 Ctrl+S 走完全同一条路径 |
| **3-min timer** | ✅ | ❌ | crash 保险，不完全态 |
| **visibility / pagehide** | ✅ | ❌ | 关页面抢救，不完全态 |
| **云按钮 ↓**（pull） | （覆盖） | — | 拉云覆盖本地，destructive，单独按钮 |

**关键原则**：用户**在场** + **显式 consent** 是触云的两个必要条件。Ctrl+S 满足两条，autosave 都不满足。412 sibling-copy 只在用户在场时发生，因为 toast 能被看到。

webxiaoheiwu / justreadpapers 是连续小编辑 + 即时 cloud，412 自动 sibling 在后台跑也 OK（用户不需要立刻知道）。AtlasMaker 工作单位大（一个 atlas = 一会儿持续 + 停 + 一会儿）+ 加密带来信任成本，所以 412 必须**当场处理** —— 用户在场时只见 toast / confirm 弹窗，autosave 不在场就根本不去引发 412。

### Coalesce + "改了才 drain"（0.9.11）

用户狂按 Ctrl+S 不应触发多次并发上传。但 0.9.10 把「按了几次就 drain 几次」是错的 —— 应该「保存期间真的改了内容才 drain」，否则当前保存已经盖住全部状态，再跑一次就纯浪费。

```js
let _pendingSaveOpts = null; // 保存期间最近一次显式按键的 opts

async function saveCurrentSession(opts) {
  if (_saving) {
    _pendingSaveOpts = opts;  // 记录意图但不一定真用
    return;
  }
  _saving = true;
  try {
    // ... 整段 local + cloud + toast ...
    // 注意：local 段会 `_dirty = false`；若保存期间用户 markDirty()，_dirty 会复活
  } finally {
    _saving = false;
    const wantDrain = _dirty;           // ← 改了才 drain
    const opts = _pendingSaveOpts;
    _pendingSaveOpts = null;
    if (wantDrain) {
      queueMicrotask(() => saveCurrentSession(opts || { explicit: false, skipCloud: false }));
    }
  }
}
```

**矩阵**：

| 保存期间 | drain? | drain 用谁的意图 |
|---|---|---|
| 啥都没干（按 0 次 Ctrl+S，没改） | ❌ no-op | — |
| 狂按 Ctrl+S 5 次，没改 | ❌ no-op | — |
| 改了几笔，没按 Ctrl+S | ✅ drain | autosave 默认（local only, 静默） |
| 改了几笔，按了 Ctrl+S | ✅ drain | Ctrl+S（本地 + 云） |
| 改了几笔，先 Ctrl+S 后 Ctrl+Shift+S | ✅ drain | Ctrl+Shift+S（latest wins，local only） |

**关键点**：
- drain 条件 = `_dirty`（保存中是否被 markDirty 复活），不是按键计数
- 没改 = 当前保存已经盖住全部状态，drain 是浪费 → no-op
- `_saving` 覆盖**整段**（local + 云推 + toast），不只本地段。否则云推期间 `_saving` 已放，第二次 Ctrl+S 就并发上传同一份 zip
- `queueMicrotask` 避免同步递归 stack
- autosave timer 也走同一路径，自动被 coalesce

### Ctrl+S 的四种 toast outcome

按用户心态分类：

| 场景 | toast | 后续 |
|---|---|---|
| 未登录 / 不在 OneDrive 模式 | `Saved locally` | 本地保了，云端无概念 |
| 登录中 + 推成功 | `Saved (local + cloud)` | 完全态，cloud-dirty 清 |
| 登录中 + 推失败（401 / 网络） | `Saved locally (cloud push failed: ...)` | 本地保了，云端 dirty 仍亮 |
| 登录中 + 412 冲突 | confirm 弹窗：「云端比本地新，你的版本已 sibling 到 `xxx 1`，要拉远端到本地吗？」 | 用户决定 pull 还是手动 merge |

### Cloud-dirty 指示器 = 「不完全态」可见

autosave 是「不完全态」—— 本地保了，云端未同步。UI 必须明示这种中间状态，否则用户以为「全保了」就关窗。

两个独立指示，互不混淆：
- 顶栏 **"已保存 / 未保存"** pill = **本地 IDB 状态**
- 顶栏 **云按钮 ↑** = **云端同步状态**（本地比云端新就右上角脉冲发光小点）

实现：localStorage `atlasmaker.cloudDirty:<sessionStem>`。本地 save 后置 true；push / pull 成功后置 false；session 名变即把新名也标 true。`getCloudDirty` 默认 dirty（保守：从未推过 = 未同步）。

用户看到脉冲点 = 「这是不完全态，按 Ctrl+S 或者云按钮完成保存」。点击行为都是「完全保存」（走 saveCurrentSession({ explicit: true })）。

### Layout：一个 session 一个 zip

OneDrive 上 `Apps/AtlasMaker/<sessionName>.atlas.zip` 一个文件，不展开成文件夹。理由：用户在 OneDrive 网页 / 桌面 client 能看到清楚的文件列表。展开文件夹反而污染。

代价：改 viewport 位置也要重传整个 zip（几 MB / 几十 MB）。能接受，因为云 push 是用户显式低频操作。

### 冲突 412：停在 step 1，引导用户改名（0.9.4 修正）

**旧策略**（0.6 - 0.9.3）：sibling-copy —— 412 时把本地另存为 `<name> 1`，然后 confirm「拉远端？」。问题：低频大颗粒操作中「不预期地多出一个文件」是 surprise，用户得回头找 sibling、决定 merge / 删；UX 重。

**新策略**（0.9.4+）：Ctrl+S 是两步（本地 + 云推），第二步 412 → 停。不自动 sibling-copy。直接长 toast 提示：

```
"Saved locally — OneDrive has a newer <name>. Rename your session and Ctrl+S again."
```

`cloud.pushAtlas()` 抛 `CloudConflictError`，app 层 catch → toast。本地已保（step 1 已完成），云端动也没动。

**用户路径**：开 gallery → 改 `galleryCurrentName` → 关 gallery → Ctrl+S。新名 cloud 路径不冲突，正常 upload。原 cloud 文件保留另一台设备版本，未来用户可在 gallery 里看到两条记录决定怎么合并。

**为什么这样更好**：destructive 操作的 surprise 等级低 + 用户当场看名字栏（在 gallery 里）即知道改什么。sibling-copy 是"看起来已经处理了"的幻觉，实际把决策推给以后的自己。

### Pull 不再是顶栏 first-class（0.9.4）

旧：顶栏 ↑ push / ↓ pull 两个按钮对称。
新：只有 ↑（Save to cloud）。pull 集成进 gallery —— cloud-only tile 单击即「拉这个 session 到本地并打开」。

理由：日常场景里「pull 覆盖当前」太 destructive 且不是用户对 cloud 的真实直觉。真实直觉 = "我想打开那个其他设备的 atlas"，gallery 那一击直接给。412 冲突也不用 pull 了（不再 sibling-copy，没有 sibling 要去拉）。

### Gallery 全屏改造（0.9.4）

旧：sessions 是顶栏直接按钮 + 居中 modal 700px 宽列表。挤。
新：sessions 入汉堡菜单（不常用 first-class）；点开 = 全屏 overlay，header 含 ←返回 / 标题 / 「正在编辑：名字框」/ + New / ↻ Refresh；breadcrumb 一行；tile grid（自适应列，180px+ 一格）。Tile = 大缩略图 4:3 + 名字 + meta + actions（Encrypt/Decrypt/Delete）。

「正在编辑：名字框」是 gallery 内重要功能：用户**在场处理 412 冲突**时这是改名入口。和顶栏 sessionInput 双向同步，gallery 一关就回顶栏 input 看见。

### 重命名 = 移动

User 在 sessionInput 改名 → 下次 save 写到新 path → 老 path IDB key 立即删。
下次 push 到新 cloud path → 老 cloud path 删（如果之前推过；404 当 no-op）。

跟踪状态：
- `_activeIDBPath`：当前 session 的 IDB key（rename 后 = 新 path）
- `_activeCloudPath`：上次成功 push 到云的 path
- save 时 `pathFromInput() !== _activeIDBPath` → IDB rename
- push 后 `pathFromInput() !== _activeCloudPath` → cloud delete old

## 加密设计

### 安全模型

「静态层加密」semantics：
- **加密 session**：IDB / 网盘里的 zip 永远是密文；明文 scene / blobs 只在内存
- **未加密 session**：IDB / 网盘明文存（standard）

→ 关 tab 后内存清空，IDB 里只剩密文。没密码 = 没法看。

### 密码生命周期

```
打开加密 session  → prompt 密码 → 解密 → 内存里 _currentSessionPassword 缓存
每次 save        → 用缓存密码加密 → 写 IDB
切换 session     → _currentSessionPassword 清空
关 tab           → 内存清空（即所有密码忘记）
```

**绝不持久化密码**。每次冷启动都要重新输。

### 中途切加密 / 取消加密

加密（unencrypted → encrypted）：
1. prompt 新密码 ×2（不匹配 = 取消）
2. 读当前 unencrypted 内层 entries
3. 用新密码包成加密 zip
4. 写回 IDB（atlas = 加密包，thumb = null，encrypted = true）

取消加密（encrypted → unencrypted） —— **强 consent，防误点**：
1. prompt 当前密码（验证 = 尝试解密；错 → 不进下一步）
2. confirm phrase：用户必须键入「确定取消加密」原文（不是 OK/Cancel 弹窗）+ message 写明后果（明文存 IDB / 云端）
3. 重打成 direct zip + 从内层提 thumb 出来
4. 写回 IDB（encrypted = false）

### 密码错重试循环

错的时候不要直接 throw 让用户跑掉。在 `applyAtlasZipBlob` 里 while loop：
- 解密失败 → 立刻再 prompt（提示「密码错，再试一次」）
- 用户按 Cancel 才真退出
- 否则用户操作流程：「输错 → 没反应 → 觉得没事」就懵了

## 一些零散坑

### MSAL 走 vendor 不走 CDN

早期兄弟（webxiaoheiwu / justreadpapers）从 CDN 加载 MSAL，后期（RealHome / JustReadBooks）改 vendor。AtlasMaker 跟 vendor 路线。理由：

- CDN 偶尔抽风 / GFW
- 版本控制 = 直接 commit
- 离线第一原则

代价：~660KB 进 repo + precache。值。

### `@microsoft.graph.conflictBehavior` 是 URL 查询不是 header

`@` 在 HTTP header 名里是非法字符。webxiaoheiwu 踩过这个坑。统一放 URL `?@microsoft.graph.conflictBehavior=fail`。

### Graph 上传 body 要支持 TypedArray

```js
if (typeof body === "string" || body instanceof ArrayBuffer || ArrayBuffer.isView(body) || body instanceof Blob) {
  init.body = body;
} else {
  init.body = JSON.stringify(body);
}
```

漏 `ArrayBuffer.isView` 检查 → Uint8Array 被 JSON.stringify 成 `{"0":byte, "1":byte, ...}`，10× 膨胀，PNG 上传炸。

### document.title 不能用 session 名

浏览器历史按 title 显示。如果 title = "wall — AtlasMaker" 那种，用户访问多次同 AtlasMaker、不同 session 名的时候，history 会出现多条「叫不同名的页面」，点了之后又都跳到同一个 URL（因为 session 不在 URL 里）。结果：
1. confusing —— 同一个 app 看上去是多个网页
2. privacy leak —— history 里赤裸记录每个 session 名

固定 title = "AtlasMaker"。session 名在 app 内可见（顶栏 input），不需要在 title 重复。

### IDB DB_VERSION bump 不会自动丢数据

`DB_VERSION` 仅 trigger `onupgradeneeded`。回调里你决定怎么做：additive（新建 store）= 零丢失，destructive（删 store）= 丢。`ATLASMAKER_VERSION`（app/SW cache 版本号）跟 IDB 完全无关，bump 100 次也不丢 IDB 一个字节。

### id 序列模块级状态 vs 持久化 = 炸板（0.9.1 修）

**症状**：用户偶尔报告「打开文件后丢图、有些图点不中、改完后保存重开整张板被炸成同一张图重复」。检查损坏 zip 的 scene.json 发现：
```json
"imageOrder": ["o1", "o1", "o1", "o1"],
"viewportOrder": ["o1"]
```
同一 id 在 imageOrder 出现多次 + 跨层（image obj 出现在 viewportOrder）。

**根因**：[objects.js](../src/objects.js) 早期版本：
```js
let _idSeq = 0;
const nextId = () => `o${++_idSeq}`;
```
`_idSeq` 是**模块级**变量，每次刷新页面 reset 到 0。但 obj id 是**持久化**的（写进 scene.json）。

cycle：
1. Boot：从 zip load 进 obj，id=`"o1"`，scene.objects 有 o1。`_idSeq` 仍 = 0。
2. 用户粘贴新图 → `scene.add(obj)` 没 id → `nextId() = "o1"` → 跟载入的撞了
3. `this.objects.set("o1", newObj)` 静默覆盖；`layer.appendChild(newNode)` 但旧 DOM 节点没删 → imagesLayer 有 2 个 `data-id="o1"` 兄弟
4. 下次 `snapshot()` 读 `imagesLayer.children` 拿到 `["o1", "o1"]`
5. 保存 → scene.json `imageOrder` 写脏
6. 再 load → `restore()` 遍历 imageOrder 给每个 id 都建一个 DOM 节点 + appendChild → DOM 兄弟数翻倍
7. 越保存越炸

viewport 创建同样撞：用户在 image 加载后第一次创建 viewport，nextId 给它 `"o1"`（_idSeq=0 → 1），但 image 的 o1 已经在 scene.objects 里 → viewport obj 覆盖 image。viewportsLayer 拿到 image 的 DOM children → `viewportOrder` 写出 image id。

**修复**（两路）：
1. **`nextId()` 改 UUID** —— 跨 session、跨刷新都唯一。根除碰撞可能。
2. **Loader 消毒**（applyAtlasZipBlob）：
   - imageOrder/viewportOrder dedupe（同层去重）
   - 把 obj type 不匹配本层的 id 过滤（image 出现在 viewport 层 → 踢出）
   - 缺失的 obj 按 type 自动补到对应层尾
3. **`scene.add` 防御**：撞已存在 id 时强制换新 id（永不静默覆盖）

**教训**：任何**模块级 / 全局**的 id / counter / cache，要么持久化它（重启时 restore 到上次值），要么用全局唯一的方式（UUID / nanoid）。模块级状态 + 持久化 id 是天然冲突。

兄弟项目检查清单：scratchpad、webxiaoheiwu 这些是否也有类似 pattern？答案：scratchpad / webxiaoheiwu 的对象 id 都基于 timestamp + random，没这个问题。AtlasMaker 是因为图省事用 incrementing counter 才中招。

### Boot 失败的「幽灵 current」陷阱（0.7.2 修）

启动时 `loadCurrentSession` 会从 `localStorage.currentPath` 拉，如果它是加密 session 而用户取消密码 → `applyAtlasZipBlob` throw → scene 还是初始 blank。

陷阱 1：`_activeIDBPath` 在文件顶部以 `let _activeIDBPath = getCurrentPath()` 初始化，**已经**指向那个加密 path。用户在 blank scene 上做任何修改 → Ctrl+S → `saveCurrentSession` 把 `pathFromInput()`（= "未命名"）当 newPath，oldPath = "加密 session 路径" → 当作 rename → **`storage.deleteSession(old)` 直接把加密 session 删了**。数据丢失。

陷阱 2：sessions 模态原本 `key === cur` 不画「打开」按钮 —— 用户连重试都没地方点。

修复（都在 boot 的 `.catch`）：
1. `_activeIDBPath = sessionFileName(DEFAULT_SESSION_NAME)` —— 重置到 safe default，后续 save 不会误删加密
2. `_activeCloudPath = null` —— 同理，避免 push 误删
3. `localStorage.currentPath` **不**重置，下次 boot 还能试着加载
4. Toast 提示用户去模态重试
5. 模态「打开」按钮永远显示，current 行改成「重新打开」label

教训：「`localStorage` 里宣称的 current」≠ 「scene 里实际加载的 session」。任何会基于「current」做 destructive 操作（save 时的 rename-delete-old）的代码，都要确认 current 是「实际加载过」的状态，而不是「localStorage 里记的、但加载失败过的」状态。

## 0.8.0 sessions browser overhaul

模态从 v0.6/0.7 的「平铺字母序列表」改成「文件夹导航 + 云端合并发现」：

- **真正的文件夹导航**：`_currentFolder` 状态 + breadcrumb（`/` › `characters` › `wall`），点 folder 进、点 breadcrumb 节回。模态打开后 `_currentFolder` 持久（不重置到根），方便用户回到上次位置。
- **云端 auto-discovery**：模态打开时 `cloud.listAtlasesRecursive()` 递归列 approot 下所有 `*.atlas.zip`，合并到列表。深度上限 8，避免病态嵌套。
- **状态合并**：每个 row 三个独立 axes
  - 来源：`本地` / `☁ 云端` / 两个都有（两个 badge 都挂）
  - 加密：`🔒 加密`（只对本地已知，云端单独项目要拉了才知道）
  - 同步：`未推送`（本地 dirty since last cloud push）
- **云端-only row**：thumb 显「☁」，按钮叫「拉并打开」，点 → `cloud.pullAtlasByPath(path)` → 探测格式 → 写 IDB → `openSessionByPath` 启动正常 open 流程（含密码 prompt 如加密）。如果是非加密的，顺手把 `thumb.png` 也从 zip 里提出来存进 IDB pkg，下次模态显示带预览。
- **删除**：合并删除 —— row 同时存在于本地 + 云端时，确认弹窗会说「本地 + 云端」，两边一起删（本地 `storage.deleteSession`，云端 `cloud.deleteAtlas`）。
- **新建**：`prompt` 默认值会带当前 folder 前缀（`characters/未命名`），简化在子目录新建。

### 加密 session 不自动 pull 的设计

云端 row 列表里加密 session 是「未知项」—— 我们不在 list 阶段去 peek 内容（避免 N 次网络下载 + N 次密码 prompt）。只在用户主动点「拉并打开」时下载 + 探测 + 必要时 prompt 密码。

代价：云端加密 session 在 list 里看起来跟非加密一样（都是 ☁ 图标）。点开才知道。可以将来通过 zip 顶层条目名 `data.atlas.zip` 在 HEAD 请求探测，但 Graph API 不便直接抓 zip 前 N 字节；先不做。

### `listAtlasesRecursive` 深度上限

Graph `listChildren(subfolder)` 每层一次请求。100 子文件夹 = 100 次 round-trip。当前递归无并行；深目录树会慢。短期接受；未来如有性能问题，可以并行 + cache。

### Cloud-only session 拉下来之后

下载后立即写一份 IDB（包含 atlas blob + 探测好的 encrypted 标志 + 提取的 thumb），让下次模态展示更丰富。**但**：纯网盘里加密 zip 的 thumb 我们提不出（被加密），所以加密 row 拉下来后 thumb 仍是 🔒，与本地一致。
