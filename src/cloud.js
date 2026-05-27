// AtlasMaker × OneDrive 同步层。把 atlas zip 当作单文件推 / 拉。
//
// Layout (per user instruction, 不要文件夹污染):
//   Apps/AtlasMaker/<sessionName>.atlas.zip
//
// 触发策略（与 [[本地持久化]] 区分）：
//   - 本地 IDB save: Ctrl+S / 3-min / visibility / pagehide — 自动
//   - 云端 push / pull: 用户**显式**点按钮 — 绝不偷推
//   - 用户没意识到时不会发生 412 → sibling-copy 只在用户主动 push 时跑
//
// 冲突 (412 If-Match) → sibling-copy（webxiaoheiwu 模式）：
//   1. 拉 fresh remote 进本地 IDB（覆盖本地）
//   2. 把*我们的*pre-conflict 本地内容 PUT 到 `<name> 1.atlas.zip` (409 → 2, 3, …)
//   3. toast 告知用户：你的旧本地已在云端 sibling，本地现在 = 云端最新
//
// 不抄 webxiaoheiwu 的 debounce/heartbeat —— AtlasMaker 是 Blender 习惯，显式 Ctrl+S。

import { isAuthConfigured, initAuth, signIn, signOut, getActiveAccount, isSignedIn } from "./auth.js";
import { listChildren, getItemByPath, downloadItemBlob, uploadFileToApproot, deleteItem } from "./graph.js";
import { sessionFileName } from "./config.js";

const ZIP_CT = "application/zip";

// eTag / itemId 本地缓存（per sessionName）。survive reload。
// localStorage 比 IDB 快，单条字符串够用。
function etagKey(sessionName) { return `atlasmaker.etag:${sessionName}`; }
export function getKnownETag(sessionName) {
  try { return localStorage.getItem(etagKey(sessionName)) || null; } catch (_) { return null; }
}
function setKnownETag(sessionName, eTag) {
  try {
    if (eTag) localStorage.setItem(etagKey(sessionName), eTag);
    else localStorage.removeItem(etagKey(sessionName));
  } catch (_) {}
}

// Cloud-dirty 标记：本地 IDB 自从上次成功推 / 拉云端之后又改过。
// 单独存（per sessionName），让 UI 在 autosave "已保存" 之外仍能提示用户「云端还没同步」。
// 默认 = dirty（保守：从未推过的 session 当 dirty 看待）。
function cloudDirtyKey(sessionName) { return `atlasmaker.cloudDirty:${sessionName}`; }
export function isCloudDirty(sessionName) {
  if (!isSignedIn()) return false; // 没登录无意义
  try {
    const v = localStorage.getItem(cloudDirtyKey(sessionName));
    if (v === null) return true; // 没记录 → 假定 dirty
    return v === "1";
  } catch (_) { return false; }
}
export function setCloudDirty(sessionName, dirty) {
  try { localStorage.setItem(cloudDirtyKey(sessionName), dirty ? "1" : "0"); } catch (_) {}
}

export { isAuthConfigured, initAuth, signIn, signOut, getActiveAccount, isSignedIn };

// ----- push 当前 session 到 OneDrive -----
// onConflict(siblingName) 在 sibling-copy 后回调，由 app 决定怎么 toast / 提示用户重新加载。
//
// 返回 { action: "uploaded" | "sibling-copy", siblingName?, item }
export async function pushAtlas(sessionName, atlasBlob, { onConflict } = {}) {
  if (!isSignedIn()) throw new Error("尚未登录 OneDrive");
  const path = sessionFileName(sessionName);
  const knownETag = getKnownETag(sessionName);
  try {
    const item = await uploadFileToApproot(path, atlasBlob, ZIP_CT, {
      conflictBehavior: "replace",
      eTag: knownETag, // 第一次推送 knownETag 是 null → 服务器接受
    });
    setKnownETag(sessionName, item.eTag);
    setCloudDirty(sessionName, false);
    return { action: "uploaded", item };
  } catch (e) {
    if (e.status !== 412) throw e;
    // 冲突 → sibling-copy
    const sibling = await handleConflictSiblingCopy(sessionName, atlasBlob);
    if (onConflict) onConflict(sibling.siblingName);
    return sibling;
  }
}

// ----- sibling-copy 子程序 -----
async function handleConflictSiblingCopy(sessionName, ourAtlasBlob) {
  // 1. 把*我们的*内容推到 sibling（防止丢，先做这一步）
  let siblingItem = null;
  let siblingName = null;
  for (let n = 1; n < 50; n++) {
    const candidate = sessionFileName(`${sessionName} ${n}`);
    try {
      siblingItem = await uploadFileToApproot(candidate, ourAtlasBlob, ZIP_CT, { conflictBehavior: "fail" });
      siblingName = candidate;
      break;
    } catch (e) {
      if (e.status === 409) continue; // 这个名也被占了 → 下一个
      throw e;
    }
  }
  if (!siblingItem) throw new Error("没法腾出 sibling 名（试了 50 个）");
  // 2. 同步本地 eTag：sessionName 主文件的新 eTag 要 re-fetch（remote 比我们新）
  const remoteMeta = await getItemByPath(sessionFileName(sessionName));
  if (remoteMeta) setKnownETag(sessionName, remoteMeta.eTag);
  return { action: "sibling-copy", siblingName, item: siblingItem, remoteMeta };
}

// ----- pull 远端 session（覆盖本地） -----
// 返回 { blob, item } —— app 负责 applyAtlasZipBlob + saveCurrentSession。
export async function pullAtlas(sessionName) {
  if (!isSignedIn()) throw new Error("尚未登录 OneDrive");
  const path = sessionFileName(sessionName);
  const item = await getItemByPath(path);
  if (!item) return null;
  const blob = await downloadItemBlob(item.id);
  setKnownETag(sessionName, item.eTag);
  setCloudDirty(sessionName, false);
  return { blob, item };
}

// ----- 列云端所有 atlas zip（多 session UI 用得到）-----
export async function listAtlases() {
  const items = await listChildren();
  return items.filter((it) => it.file && /\.atlas\.zip$/i.test(it.name));
}

// ----- 删除云端 session（重命名 / 显式清理用）-----
// 404 视为 no-op（已经没有就当成功）。同时清干净 localStorage 里的 etag / dirty 标记。
export async function deleteAtlas(sessionName) {
  if (!isSignedIn()) throw new Error("尚未登录");
  const path = sessionFileName(sessionName);
  const item = await getItemByPath(path);
  if (item) await deleteItem(item.id);
  clearCloudState(sessionName);
}

export function clearCloudState(sessionName) {
  try {
    localStorage.removeItem(etagKey(sessionName));
    localStorage.removeItem(cloudDirtyKey(sessionName));
  } catch (_) {}
}
