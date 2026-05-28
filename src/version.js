// 版本号单一来源（SSoT）。
// - service-worker.js 用 importScripts 拿
// - index.html 用 <script> 加载到 window.ATLASMAKER_VERSION
// - app.js 把它打到 HUD
// 改 precached 文件就 bump 这个。
self.ATLASMAKER_VERSION = "0.10.3-2026-05-28";
