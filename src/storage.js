// IndexedDB 持久化。
//
// 两个 store：
//   "scenes" — keyed by scene id（一期只用 "current"），value = scene.json 文档（无 Blob，只引用 src）
//   "blobs"  — keyed by 路径字符串 "images/<uuid>.<ext>"，value = Blob
//
// 这套结构和 ZIP 文件格式一一对应：导出时把 scenes/<id> 当 scene.json，blobs 按路径塞进 zip。
// 导入反过来。
//
// 一期没做 GC：删除 obj 不会回收对应 blob。session 内可接受；将来加引用计数 / 周期 GC。

const DB_NAME = "atlasmaker";
const DB_VERSION = 1;
const STORE_SCENES = "scenes";
const STORE_BLOBS = "blobs";

let _dbPromise = null;

function openDB() {
  if (_dbPromise) return _dbPromise;
  _dbPromise = new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = (ev) => {
      const db = ev.target.result;
      if (!db.objectStoreNames.contains(STORE_SCENES)) db.createObjectStore(STORE_SCENES);
      if (!db.objectStoreNames.contains(STORE_BLOBS)) db.createObjectStore(STORE_BLOBS);
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
  return _dbPromise;
}

function _get(store, key) {
  return openDB().then((db) => new Promise((resolve, reject) => {
    const tx = db.transaction(store, "readonly");
    const req = tx.objectStore(store).get(key);
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  }));
}

function _put(store, key, value) {
  return openDB().then((db) => new Promise((resolve, reject) => {
    const tx = db.transaction(store, "readwrite");
    tx.objectStore(store).put(value, key);
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  }));
}

function _del(store, key) {
  return openDB().then((db) => new Promise((resolve, reject) => {
    const tx = db.transaction(store, "readwrite");
    tx.objectStore(store).delete(key);
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  }));
}

function _keys(store) {
  return openDB().then((db) => new Promise((resolve, reject) => {
    const tx = db.transaction(store, "readonly");
    const req = tx.objectStore(store).getAllKeys();
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  }));
}

export const getScene  = (id = "current") => _get(STORE_SCENES, id);
export const putScene  = (id, doc)        => _put(STORE_SCENES, id, doc);
export const delScene  = (id)             => _del(STORE_SCENES, id);
export const getBlob   = (path)           => _get(STORE_BLOBS, path);
export const putBlob   = (path, blob)     => _put(STORE_BLOBS, path, blob);
export const delBlob   = (path)           => _del(STORE_BLOBS, path);
export const listBlobs = ()               => _keys(STORE_BLOBS);

// 包多个 blob 同事务写入 / 读取 —— 比逐个事务快很多（导入 ZIP 用得到）
export function putBlobsBatch(entries) {
  return openDB().then((db) => new Promise((resolve, reject) => {
    const tx = db.transaction(STORE_BLOBS, "readwrite");
    const store = tx.objectStore(STORE_BLOBS);
    for (const [path, blob] of entries) store.put(blob, path);
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  }));
}

export function getBlobsBatch(paths) {
  return openDB().then((db) => new Promise((resolve, reject) => {
    const tx = db.transaction(STORE_BLOBS, "readonly");
    const store = tx.objectStore(STORE_BLOBS);
    const out = {};
    let pending = paths.length;
    if (!pending) { resolve(out); return; }
    for (const p of paths) {
      const req = store.get(p);
      req.onsuccess = () => { out[p] = req.result; if (--pending === 0) resolve(out); };
      req.onerror = () => reject(req.error);
    }
  }));
}
