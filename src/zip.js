// ZIP 读写 = vendored zip.js (gildas-lormeau)。
// UMD bundle 自挂 window.zip，HTML head 里以 classic <script> 加载。
//
// 之前 v9-v0.6 我手写了 STORE-only zip。0.7 起切换：
//   - 加密 (AES-256, WinZip 规范) 需要 zip.js
//   - 不加密路径也走 zip.js，统一 API；STORE-only 仍是默认（{ level: 0 }）
//
// 格式（per AtlasMaker 约定）:
//   - 不加密 session = 直接的 atlas zip:
//       scene.json, images/<uuid>.<ext>, thumb.png
//   - 加密 session = 外层 STORE-only 明文 zip 包一个 AES-256 加密的内层 atlas zip:
//       外层: data.atlas.zip   (内容 = 加密的 inner zip)
//       内层（解开后）：scene.json, images/<uuid>.<ext>, thumb.png（可有可无）
//   外层故意不放 manifest / 任何识别信息 —— 全在加密层。
//
// detection: peek 外层 entries
//   - "scene.json" 在 → 未加密直接格式
//   - "data.atlas.zip" 在 → 加密格式，需要密码

function Z() {
  if (typeof window === "undefined" || !window.zip) {
    throw new Error("zip.js not loaded (load vendor/zip-js/zip-full.min.js as a classic <script> before app.js)");
  }
  return window.zip;
}

// 首次访问时关掉 web workers —— inline worker 在某些场景被 CSP 拒；不开省心。
let _configured = false;
function ensureConfigured() {
  if (_configured) return;
  try { Z().configure({ useWebWorkers: false }); } catch (_) {}
  _configured = true;
}

function toZipReader(data) {
  const z = Z();
  if (data instanceof Blob) return new z.BlobReader(data);
  if (data instanceof Uint8Array) return new z.Uint8ArrayReader(data);
  if (data instanceof ArrayBuffer) return new z.Uint8ArrayReader(new Uint8Array(data));
  if (typeof data === "string") return new z.TextReader(data);
  throw new TypeError("zip: unsupported data type");
}

// ----- 不加密 -----

/** entries: [{ path, data: Blob|Uint8Array|ArrayBuffer|string }, ...]; return Blob (application/zip) */
export async function zipPack(entries) {
  ensureConfigured();
  const z = Z();
  const writer = new z.ZipWriter(new z.BlobWriter("application/zip"));
  for (const { path, data } of entries) {
    await writer.add(path, toZipReader(data), { level: 0 });
  }
  return await writer.close();
}

/** 返回 { path: Uint8Array } */
export async function zipUnpack(blob) {
  ensureConfigured();
  const z = Z();
  const reader = new z.ZipReader(new z.BlobReader(blob));
  try {
    const entries = await reader.getEntries();
    const out = {};
    for (const e of entries) {
      if (e.directory) continue;
      out[e.filename] = await e.getData(new z.Uint8ArrayWriter());
    }
    return out;
  } finally { await reader.close(); }
}

// ----- 加密：AES-256（WinZip 规范，zip.js 默认 encryptionStrength=3）-----

/**
 * 加密：先把 entries 打成内层 AES-256 zip，再用外层明文 STORE-only zip 包一层（只放一个文件 data.atlas.zip）。
 * 这样网盘 / 扫描器看到的是普通 zip 不会被拦截；用 7-Zip 解一层后再开内层才需要密码。
 */
export async function zipPackEncrypted(entries, password) {
  ensureConfigured();
  if (!password) throw new Error("Password required to encrypt zip");
  const z = Z();
  // 1) 内层加密 zip
  const innerWriter = new z.ZipWriter(new z.BlobWriter("application/zip"), {
    password,
    encryptionStrength: 3, // 3 = AES-256
  });
  for (const { path, data } of entries) {
    await innerWriter.add(path, toZipReader(data), { level: 0 });
  }
  const innerBlob = await innerWriter.close();
  // 2) 外层明文包 —— 只放一个 entry，不暴露 manifest / 任何用户信息
  const outerWriter = new z.ZipWriter(new z.BlobWriter("application/zip"));
  await outerWriter.add("data.atlas.zip", new z.BlobReader(innerBlob), { level: 0 });
  return await outerWriter.close();
}

/** 解密：peek 外层 → 取 data.atlas.zip → 用 password 解内层 → 返回 { path: Uint8Array } */
export async function zipUnpackEncrypted(wrapperBlob, password) {
  ensureConfigured();
  if (!password) throw new Error("Password required to decrypt zip");
  const z = Z();
  // 1) 外层 (明文)
  const outerReader = new z.ZipReader(new z.BlobReader(wrapperBlob));
  let innerBlob;
  try {
    const outerEntries = await outerReader.getEntries();
    const dataEntry = outerEntries.find((e) => !e.directory && e.filename === "data.atlas.zip");
    if (!dataEntry) throw new Error("Malformed encrypted package: data.atlas.zip missing");
    innerBlob = await dataEntry.getData(new z.BlobWriter("application/zip"));
  } finally { await outerReader.close(); }
  // 2) 内层 (加密)
  const innerReader = new z.ZipReader(new z.BlobReader(innerBlob), { password });
  try {
    let entries;
    try { entries = await innerReader.getEntries(); }
    catch (e) { throw new Error("Wrong password or corrupted file (read entries)"); }
    const out = {};
    for (const e of entries) {
      if (e.directory) continue;
      try {
        out[e.filename] = await e.getData(new z.Uint8ArrayWriter(), { password });
      } catch (err) {
        throw new Error("Wrong password or corrupted file (decrypt " + e.filename + ")");
      }
    }
    return out;
  } finally { await innerReader.close(); }
}

// ----- 格式探测 -----

/**
 * peek atlas blob 顶层 entry，判断是 "direct"（未加密直接格式）还是 "encrypted"（外包加密格式）。
 * 不解内层 / 不需要密码。
 */
export async function detectAtlasFormat(blob) {
  ensureConfigured();
  const z = Z();
  const reader = new z.ZipReader(new z.BlobReader(blob));
  try {
    const entries = await reader.getEntries();
    const names = new Set(entries.filter((e) => !e.directory).map((e) => e.filename));
    if (names.has("scene.json")) return "direct";
    if (names.has("data.atlas.zip")) return "encrypted";
    throw new Error("非 atlas 格式（缺 scene.json 或 data.atlas.zip）");
  } finally { await reader.close(); }
}
