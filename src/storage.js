// IndexedDB 持久化 —— v11 起改成「一个 session = 一个 atomic 包」。
//
// 之前 v9-v10 拆 scenes / blobs 两个 store + 多 tx 写：refresh 在中间截断
// → 半边状态 → 用户看到「有时候丢图、有时候丢 viewport」。
// 现在：一个 store "sessions"，每条记录 = { name, updatedAt, atlas, thumb }，
// 一次 put 一次 tx，要么全有要么全无。
//
// 代价：每次保存重序列化整个 atlas zip。所以保存频率必须低（Ctrl+S 为主，
// 3-min 兜底，关页面 visibility/pagehide 兜底）—— 不要再走 debounce 路径。
//
// 旧 stores（scenes/blobs）留着不动 —— DevTools 可看可清，新代码不再读写。

const DB_NAME = "atlasmaker";
const DB_VERSION = 2;
const STORE_SESSIONS = "sessions";

let _dbPromise = null;

function openDB() {
  if (_dbPromise) return _dbPromise;
  _dbPromise = new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = (ev) => {
      const db = ev.target.result;
      if (!db.objectStoreNames.contains(STORE_SESSIONS)) db.createObjectStore(STORE_SESSIONS);
      // 留着旧 stores（如有）—— 不删，让用户能用 DevTools 翻历史
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
  return _dbPromise;
}

/**
 * 取一个 session 包。返回 { name, updatedAt, atlas: Blob, thumb: Blob } 或 null。
 */
export async function getSession(id = "current") {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE_SESSIONS, "readonly");
    const req = tx.objectStore(STORE_SESSIONS).get(id);
    req.onsuccess = () => resolve(req.result || null);
    req.onerror = () => reject(req.error);
  });
}

/**
 * 原子写一个 session 包。pkg 整个作为一个 value 写入，IDB 保证 tx 内全有全无。
 */
export async function putSession(id, pkg) {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE_SESSIONS, "readwrite");
    tx.objectStore(STORE_SESSIONS).put(pkg, id);
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
}

export async function deleteSession(id) {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE_SESSIONS, "readwrite");
    tx.objectStore(STORE_SESSIONS).delete(id);
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
}

// 多 session UI 用得到（一期暂不暴露给 app）
export async function listSessionIds() {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE_SESSIONS, "readonly");
    const req = tx.objectStore(STORE_SESSIONS).getAllKeys();
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}
