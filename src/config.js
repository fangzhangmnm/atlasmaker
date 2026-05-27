// Azure AD 应用注册的 client id。AtlasMaker 自己的注册。
// 部署前在 https://entra.microsoft.com → App registrations 新建一个 SPA：
//   - redirect URI：page URL 完全相同（如 http://localhost:8765/ 和 https://fangzhangmnm.github.io/atlasmaker/）
//   - account types：personal + organization
//   - 拿到 client id 填进下面这个常量
// 占位时（仍是 REPLACE_ME...）App 走纯离线，不去碰 MSAL bundle —— 飞机模式 / 没注册时也能用。
export const CLIENT_ID = "cd8651a0-118f-4d90-bb06-d0c1ea1b668c";

// common = 个人 + 组织账号都能登
export const AUTHORITY = "https://login.microsoftonline.com/common";

// AppFolder = approot 沙盒；offline_access 给 silent refresh token
export const SCOPES = ["Files.ReadWrite.AppFolder", "offline_access"];

// Filename 工具：把 sessionName 转成 cloud 文件名 / IDB key
//   "未命名"          → "未命名.atlas.zip"
//   "characters/wall" → "characters/wall.atlas.zip"  （/ 保留 = 子文件夹组织）
// `/` 以外的非法字符 per-segment 清洗。
export function sessionFileName(sessionName) {
  const segments = (sessionName || "atlas")
    .split("/")
    .map((s) => s.replace(/[\\:*?"<>|]+/g, "_").trim())
    .filter(Boolean);
  if (!segments.length) segments.push("atlas");
  return `${segments.join("/")}.atlas.zip`;
}
