# Vendored: Blender Texture Protocol

源码同步自兄弟仓库：`../../../../BlenderTextureProtocol/protocol/v1/`。

更新规则（参 [[feedback-vendor-everything]]）：
- 直接复制源到 `v1/` 子目录，不做修改
- 升级时对照 `BUNDLE_VERSION`：spec.md / btp.js / package.json 三个文件必须保持一致版本号
- AtlasMaker 通过 `import { BTPClient } from "./vendor/btp/v1/btp.js"` 用

当前 vendored 版本：见 `v1/package.json` 的 `version` 字段（v1.0.0）。
