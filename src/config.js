// Azure AD 应用注册的 client id。AtlasMaker 自己的注册。
// 部署前在 https://entra.microsoft.com → App registrations 新建一个 SPA：
//   - redirect URI：page URL 完全相同（如 http://localhost:8765/ 和 https://fangzhangmnm.github.io/atlasmaker/）
//   - account types：personal + organization
//   - 拿到 client id 填进下面这个常量
// 占位时（仍是 REPLACE_ME...）App 走纯离线，不去碰 MSAL bundle —— 飞机模式 / 没注册时也能用。
export const CLIENT_ID = "REPLACE_ME_WITH_AZURE_CLIENT_ID";

// common = 个人 + 组织账号都能登
export const AUTHORITY = "https://login.microsoftonline.com/common";

// AppFolder = approot 沙盒；offline_access 给 silent refresh token
export const SCOPES = ["Files.ReadWrite.AppFolder", "offline_access"];

// Filename 工具：把 sessionName 转成 cloud 文件名
//   sessionName: "未命名" → "未命名.atlas.zip"
//   带非法字符的清洗一下
export function sessionFileName(sessionName) {
  const safe = (sessionName || "atlas").replace(/[\\/:*?"<>|]+/g, "_").trim() || "atlas";
  return `${safe}.atlas.zip`;
}
