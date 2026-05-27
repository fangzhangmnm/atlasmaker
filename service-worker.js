// SW: cache-first + 后台 revalidate + 新版本 toast。
// 版本号 SSoT 在 ./src/version.js，bump 那一个文件就行。
// AtlasMaker 一期：无任何跨源请求；OneDrive/MSAL 引入时再扩。
//
// 4 条更新检测路径见 WebPaint/docs/pwa-update-detection.md。

importScripts("./src/version.js");
const CACHE_VERSION = self.ATLASMAKER_VERSION;
const CACHE_NAME = `atlasmaker-${CACHE_VERSION}`;

const PRECACHE_URLS = [
  "./",
  "./index.html",
  "./manifest.webmanifest",
  "./icon.svg",
  "./src/version.js",
  "./src/styles.css",
  "./src/app.js",
  "./src/board.js",
  "./src/objects.js",
  "./src/input.js",
  "./src/btp.js",
  "./src/storage.js",
  "./src/zip.js",
  "./src/config.js",
  "./src/auth.js",
  "./src/graph.js",
  "./src/cloud.js",
  "./src/vendor/btp/v1/btp.js",
  "./src/vendor/msal/msal-browser.min.js",
];

self.addEventListener("install", (event) => {
  event.waitUntil((async () => {
    const cache = await caches.open(CACHE_NAME);
    await Promise.all(PRECACHE_URLS.map((u) =>
      cache.add(u).catch((err) => console.warn("precache miss", u, err))
    ));
    await self.skipWaiting();
  })());
});

self.addEventListener("activate", (event) => {
  event.waitUntil((async () => {
    const keys = await caches.keys();
    await Promise.all(
      keys.filter((k) => k.startsWith("atlasmaker-") && k !== CACHE_NAME)
          .map((k) => caches.delete(k))
    );
    await self.clients.claim();
  })());
});

let updateAnnouncedThisLoad = false;
async function notifyUpdate(url) {
  if (updateAnnouncedThisLoad) return;
  updateAnnouncedThisLoad = true;
  const clients = await self.clients.matchAll({ includeUncontrolled: true });
  for (const c of clients) c.postMessage({ type: "asset-updated", url });
}

self.addEventListener("fetch", (event) => {
  const req = event.request;
  if (req.method !== "GET") return;
  const url = new URL(req.url);
  if (url.origin !== self.location.origin) return;

  event.respondWith((async () => {
    const cache = await caches.open(CACHE_NAME);
    const cached = await cache.match(req);
    const network = fetch(req).then((resp) => {
      if (resp && resp.ok) {
        if (cached) {
          const cE = cached.headers.get("etag");
          const fE = resp.headers.get("etag");
          const cL = cached.headers.get("content-length");
          const fL = resp.headers.get("content-length");
          const changed = (cE && fE && cE !== fE) || (!cE && cL && fL && cL !== fL);
          if (changed) notifyUpdate(req.url).catch(() => {});
          // 顺便：notifyUpdate 用 updateAnnouncedThisLoad 守一次
        }
        cache.put(req, resp.clone()).catch(() => {});
      }
      return resp;
    }).catch(() => null);

    if (cached) {
      network.catch(() => {});
      return cached;
    }
    const resp = await network;
    if (resp) return resp;
    if (req.mode === "navigate") {
      const fallback = await cache.match("./index.html");
      if (fallback) return fallback;
    }
    return new Response("offline & not cached", { status: 503 });
  })());
});

self.addEventListener("message", (event) => {
  if (event.data?.type === "skip-waiting") self.skipWaiting();
});
