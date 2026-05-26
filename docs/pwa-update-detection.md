# PWA 更新检测 + 版本号水印

> 这一份是 AtlasMaker 自己的副本。**canonical 文档**：[../../WebPaint/docs/pwa-update-detection.md](../../WebPaint/docs/pwa-update-detection.md) —— 模式抄那里，下面只写 AtlasMaker 的差异和落地位置。

## 两件事都必须做（不是可选）

1. **挂全 4 条 update 检测路径**，否则浏览器（尤其是 standalone PWA）默认不勤快 check SW，user 看不到「有新版本」toast。
2. **屏幕上常驻显示版本号**，否则 user 点「刷新」之后没法判断新代码是不是真的跑起来了，信任反馈回路是断的。

AtlasMaker 是 PC 端，但**这两件事跟设备无关** —— Chrome / Edge 在 PWA 安装后也会变懒。规则一样，全挂。

## AtlasMaker 的落点

### 单 SSoT 版本号

文件：[`src/version.js`](../src/version.js)

```js
self.ATLASMAKER_VERSION = "v2-2026-05-26";
```

引用三处：
- [`index.html`](../index.html) `<head>` 里 `<script src="./src/version.js">`（早于 `app.js`），挂到 `window.ATLASMAKER_VERSION`
- [`service-worker.js`](../service-worker.js) 顶部 `importScripts("./src/version.js")`，`const CACHE_VERSION = self.ATLASMAKER_VERSION`
- [`src/app.js`](../src/app.js) 启动时 `versionLabel.textContent = window.ATLASMAKER_VERSION`

Bump 那一处，三边自动同步、永不漂移。

### 版本水印位置

HUD（底部居中胶囊）最后一格，紧跟「状态」之后。CSS 写在 [`src/styles.css`](../src/styles.css)：

```css
.hud .version { opacity: 0.6; font-variant-numeric: tabular-nums; }
```

PC 端 HUD 不容易被遮挡，所以放这里。后期如果 HUD 太挤，可以移到顶栏右下角，但**不要藏进菜单** —— user 不该为了看版本号点开任何东西。

### 4 条路径全挂

完整实现：[`src/app.js`](../src/app.js) 末尾「SW 更新提示」段。和 canonical doc 字面相同，区别只在 toast 元素 ID 和 LOCAL_DEV_HOSTS 守卫位置。

| 路径 | AtlasMaker 落点 |
| - | - |
| 1 `registration.waiting` 开机检查 | `window.load` 回调里第一项 |
| 2 `updatefound` + `state === "installed"` | `registration.addEventListener("updatefound", ...)` |
| 3 SW `postMessage("asset-updated")` | `navigator.serviceWorker.addEventListener("message", ...)` |
| 4 主动 poke：visibility + focus + 10 分钟兜底 | `pokeUpdate()` |

### LOCAL_DEV_HOSTS 跳过 SW

```js
const LOCAL_DEV_HOSTS = new Set(["localhost", "127.0.0.1", "::1", ""]);
if ("serviceWorker" in navigator && !LOCAL_DEV_HOSTS.has(location.hostname)) { ... }
```

**user 现在主要在 localhost 测**，没有这个守卫每次 F5 会被 SW cache 挡，改了代码看不到。部署到 GitHub Pages 时 hostname 是 `fangzhangmnm.github.io` 不在白名单里，SW 正常注册。

## 兄弟约束

- 改了任何 `PRECACHE_URLS` 里的文件 → bump [`src/version.js`](../src/version.js)
- 文件没改但加了新文件 → 还是要 bump 并把新文件加进 PRECACHE_URLS
- 不要 `clients.claim()` 漏调 —— 漏了的话老 tab 不会切到新 SW
- 不要自动 reload —— user 可能正在拖图、画 viewport
- 不要在 `index.html` / SW 之外硬编版本号字符串 —— 永远从 `ATLASMAKER_VERSION` 来

## 待办（未来如果出问题）

- 当前 toast 文案只说「有新版本」。如果 bug 多了可以加 from-version → to-version 显示
- `setInterval(pokeUpdate, 10 * 60 * 1000)` —— PC 长开的 PWA 也每 10 分钟 check 一次。如果觉得太频繁可以拉长
- SW `notifyUpdate` 用 `updateAnnouncedThisLoad` 守一次。如果 user 同一 session 推了多版本，只会收到一次提示 —— 这是设计意图（不要骚扰）

## anti-pattern（参 canonical doc）

逐条都适用，AtlasMaker 没有特殊例外。重点：
- ❌ 只挂路径 3
- ❌ 不显示版本号 ← AtlasMaker 当前在 HUD 里露着，**别去掉**
- ❌ 自动 reload
- ❌ localhost 注册 SW
- ❌ 改了文件但忘 bump version
