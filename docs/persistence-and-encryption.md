# AtlasMaker 持久化 + 加密：设计决策回顾

> 写给下一个我 / 兄弟项目接手的 AI。AtlasMaker 0.5 → 0.7 这条线踩了一些坑、迭代了几次设计、和最直觉的方案分叉过。这里把关键决策与「为什么不这样做」都记下来。如果 WebPaint / 其他兄弟项目要做同类持久化，从这里抄；和 canonical PWA 同步模式 ([../../WebPaint/docs/pwa-update-detection.md](../../WebPaint/docs/pwa-update-detection.md)) 是并列的一份。

## TL;DR（直接抄这套）

1. **一个 session = 一个 atlas zip = 一次 IDB put**。原子写。不要拆 scene-json + 多个 blob 两个 store。
2. **保存策略：显式 Ctrl+S 主导 + 3 分钟 timer 兜底 + visibility/pagehide 兜底**。**不**抄 webxiaoheiwu 的 debounce / heartbeat。Blender 用户习惯 Ctrl+S；自动保存频繁带来不稳定。
3. **云端 push/pull 必须用户显式点按钮**。autosave **绝不**触云。autosave 后 UI 要明示「云端没同步」（用一个独立指示，比如脉冲点），让用户知道还需要按云上推。
4. **OneDrive layout = 一个 session 一个 zip 文件**，不要给用户网盘搞文件夹污染。
5. **冲突走 sibling-copy**：412 → 把本地另存为 `<name> N.atlas.zip`，把远端拉进来做主版本。
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

### 显式 push / pull，autosave 绝不触云

webxiaoheiwu / justreadpapers 是连续编辑场景，每次改动都自动同步。它们的 412 → 自动 sibling-copy 是「用户看不到」的后台操作。

AtlasMaker 用户工作单位更大（一个 atlas = 一会儿持续编辑、然后停下），且加密的存在让「云端被同步出去」变成有信任成本的事。所以：

- 本地 IDB save 是自动的（Ctrl+S / timer / visibility）
- **云端 push / pull 必须用户显式按 ↑ / ↓ 按钮**
- 412 只在用户主动 push 时发生 → sibling-copy + 弹窗告知（用户当时就在场）

### Cloud-dirty 指示器

autosave 后状态 pill 显「已保存」，但云端可能是 stale 的。设计陷阱：用户看到「已保存」会以为「全保存了」。

解法：状态分两个独立指示，互不混淆：
- 顶栏 **"已保存 / 未保存"** pill = **本地 IDB 状态**
- 顶栏 **云上传按钮 ↑** = **云端同步状态**（本地比云端新就右上角脉冲发光小点）

实现：localStorage `atlasmaker.cloudDirty:<sessionStem>`。本地 save 后置 true；push / pull 成功后置 false；session 名变即把新名也标 true。`getCloudDirty` 默认 dirty（保守：从未推过 = 未同步）。

### Layout：一个 session 一个 zip

OneDrive 上 `Apps/AtlasMaker/<sessionName>.atlas.zip` 一个文件，不展开成文件夹。理由：用户在 OneDrive 网页 / 桌面 client 能看到清楚的文件列表。展开文件夹反而污染。

代价：改 viewport 位置也要重传整个 zip（几 MB / 几十 MB）。能接受，因为云 push 是用户显式低频操作。

### 冲突 412 sibling-copy

```
push → 412 (eTag 不匹配)
  → 把*我们的*本地内容上传到 sibling 名 `<name> 1.atlas.zip`（409 → 2, 3, ...）
  → 主名 `<name>.atlas.zip` 在云上是别人新版（远端比我们新）
  → toast 弹窗：你的本地已另存为 `<name> 1`，要拉远端版本到本地吗？
  → 用户点是 → pullFromCloud()
  → 用户点否 → 本地仍是我们的内容，sibling 名先放着等用户自己手动 merge
```

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
