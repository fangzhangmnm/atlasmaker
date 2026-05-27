# Blender Texture Protocol — v1 规范

**Bundle 版本**: `1.0.0`（与同目录 [btp.js](./btp.js) 严格对齐）
**Wire 版本**: `v1`（URL 前缀 `/v1`）

## 版本管理策略

- `BUNDLE_VERSION`（spec.md + btp.js）当**协议语义**或 **btp.js 文档化 API** 变化时 bump。
- 实现 bug 修复 / 内部 refactor / 非语义性 wording 调整**不 bump**。
- Major 升级（1.x → 2.x）意味着 wire 路径升到 `/v2/*`，本仓库出现并列 `protocol/v2/` 目录。
- v1 的所有 `/v1/*` endpoint 在 1.x 内**向前兼容**：可以新增字段，不可删字段、不可改语义、不可改 status code。

## 默认部署

- **transport**: localhost HTTP，监听 `127.0.0.1:18765`（端口可配置）。**默认开启**——让 sibling 应用（如 AtlasMaker）启动时自动 detect 并直连，无需用户配置。仅绑定 127.0.0.1，不暴露到局域网。
- **关闭方式**: Blender Preferences > Add-ons > Blender Texture Protocol，取消勾选"启用 localhost HTTP 服务"。
- **未来跨设备**: 同接口，transport 改 WebRTC DataChannel。Sibling 应用应当先尝试 localhost 直连，找不到再尝试牵手 (WebRTC)。

Server 实现见 [Blender addon](../../blender_addon/btp/)。

## 通用约定

### 编码
- 所有 JSON 请求/响应: UTF-8，`Content-Type: application/json; charset=utf-8`。
- 二进制贴图: `image/png`（v1 only）。后续版本可通过 `Accept` / `Content-Type` 协商加 `image/x-exr` 等。
- URL path 中的 `{name}` 必须 percent-encode（image 名可能含中文、空格、`.001` 之类）。

### 错误响应
status code 表达错误大类，`error.code` 表达具体原因（machine-readable，跨版本稳定）：

```json
{
  "error": {
    "code": "texture_not_found",
    "message": "No image named 'T_Body_Diffuse'",
    "details": { /* 可选 */ }
  }
}
```

| status | 语义 |
|---|---|
| 200 | 成功（含读、改） |
| 201 | 创建成功 |
| 400 | 请求格式错（缺字段、JSON 解析失败） |
| 404 | 资源不存在 / 路由不存在 / exec command 未注册 |
| 409 | 冲突（重名） |
| 415 | Content-Type 不支持（v1 PUT/POST 只接 PNG） |
| 500 | server 内部错（Blender API 异常） |

**冲突检测策略**: 不做。`PUT data` 语义即覆盖，多客户端竞争由用户管理。

### Undo 模型
所有 mutating endpoint（PUT / POST 创建 / rename）通过**内部 Blender Operator**（带 `bl_options = {'UNDO'}`）执行 mutation。Blender 在 operator 完成时自动 push memfile snapshot，比手动 `undo_push` 更可靠（尤其是新增 datablock 这种操作）。用户 Ctrl-Z 可回滚到 mutation 之前的状态。

GET data 在 image 未 packed 时会调用 `image.pack()` 作为副作用——这是无损的内部状态变化（像素本身不变），**不进 undo stack**。

## Endpoints

### `GET /v1/scene`
返回当前 .blend 的元信息。

**Response 200**:
```json
{
  "blend_filepath": "D:/path/foo.blend",
  "unit": "METRIC",
  "active_object_name": "Cube"
}
```
- `blend_filepath` 是空串表示 .blend 没保存
- `active_object_name` 是 `null` 表示无 active object

### `GET /v1/textures`
列出所有 user image (过滤掉 `VIEWER` / `MOVIE` source)。

**Response 200**:
```json
[
  {"name": "T_Body", "width": 2048, "height": 2048, "channels": 4, ...},
  ...
]
```

按 `name` 字典序排列。每项 metadata 字段见下"Texture metadata"。

### `GET /v1/textures/{name}`
单条 metadata。

**Response 200**: 单个 Texture metadata 对象  
**404** `texture_not_found`

### `GET /v1/textures/{name}/data`
取像素字节。

**Response 200**:
- `Content-Type` 反映源格式 (`image/png`、`image/jpeg`、`image/x-exr` etc.)
- Body 是原始字节

**副作用**: 如果 image 未 packed，server 会调用 `image.pack()`（与 pack-all 策略一致）。

### `PUT /v1/textures/{name}/data`
替换已有 image 的像素。

**Request**:
- `Content-Type: image/png`（强制）
- Body: PNG 字节

**Response 200**: 替换后的 Texture metadata。注意:
- `source` 可能从 `GENERATED` 变成 `FILE`（实现细节，不影响后续行为）
- `packed` 会变成 `true`
- 分辨率以请求体的 PNG 为准（client 决定分辨率）

**415**: Content-Type 不是 `image/png`  
**404**: image 不存在（PUT 不会创建，要创建用 POST）

### `POST /v1/textures`
新建 image。

**Request**:
- Header `X-BTP-Name: {name}`（必填，新 image 的名字）
- `Content-Type: image/png`
- Body: PNG 字节

**Response 201**: 新建的 Texture metadata  
**409** `name_exists`: 该名字已被占用  
**400** `missing_name`: 没有 `X-BTP-Name` header

### `POST /v1/textures/{name}/rename`
重命名 image。

**Request**:
```json
{ "new_name": "T_Body_New" }
```

**Response 200**: 重命名后的 Texture metadata  
**409** `name_exists`: 新名已存在  
**404**: 原名不存在

注: Blender 内 image 名本身唯一。冲突会被 server 拒绝；不做自动 `.001` 后缀。

### `GET /v1/selection`
当前用户选中的资源。

**Response 200**:
```json
{
  "texture": "T_Body",
  "object": null,
  "mesh": null
}
```

`object` / `mesh` 字段为 v2 占位，v1 总是 `null`。

`texture` 启发式: 优先返回 Image Editor 当前显示的 image；否则 active material 的 active image-texture node 的 image；都没有返回 `null`。

### `POST /v1/exec`
ad-hoc 命令入口。Server 端可通过 `api.register_exec(name, handler)` 注册命令。

**Request**:
```json
{
  "command": "build_three_view_mesh",
  "params": { /* 任意 */ }
}
```

**Response**: 由命令决定（JSON 或 binary）。  
**404** `unknown_command`: 命令未注册（`details.registered` 列出已注册命令名）。

⚠️ **`/v1/exec` 下注册的 command 不在版本保证范围内**。AtlasMaker / WebPaint 不应依赖 `/v1/exec` 跑核心流程，仅用于 ad-hoc 扩展。

## Texture metadata

```typescript
interface TextureMetadata {
  name: string;            // 唯一 ID（Blender 内保证）
  width: number;
  height: number;
  channels: number;        // 1, 3, 4
  color_space: string;     // "sRGB" | "Non-Color" | "Linear..." 等。Client 应当作 opaque string。
  is_float: boolean;       // true = 32-bit float (HDR)
  alpha_mode: string;      // "STRAIGHT" | "PREMUL" | "CHANNEL_PACKED" | "NONE"
  source: string;          // "FILE" | "GENERATED" | "MOVIE" | "VIEWER" 等
  file_format: string;     // "PNG" | "JPEG" | "OPEN_EXR" | ...
  is_dirty: boolean;       // .blend 内未保存的修改
  packed: boolean;         // 像素是否打包进 .blend
}
```

### Color space 注意事项
- v1 协议**不暴露 DPI**（Blender image datablock 不记 DPI；纹理用例下 DPI 无意义）。
- `color_space` 值在不同 Blender 版本可能略不同（4.x → 5.x OCIO 标准化中）。**Client 不应硬编码 enum 比对**，按字符串透传。

## 未来命名空间（v1 保留，不实现）

```
/v1/meshes/{name}                 — mesh datablock
/v1/objects/{name}                — scene object (mesh + transform)
/v1/materials/{name}              — material
/v1/jobs/{id}                     — async 长任务
POST /v1/meshes/{name}/uv-wireframe       — 生成 UV 线框 PNG
POST /v1/objects/{name}/three-view-mesh   — 三视图建模
GET /v1/textures/{name}/data with Accept: image/x-exr  — HDR 取
```

这些名字现在请勿占用。

## Client API 对应（btp.js）

```javascript
import { BTPClient, BTPError, BUNDLE_VERSION } from "./btp.js";

const client = new BTPClient(); // 默认 http://127.0.0.1:18765

await client.getScene();                              // GET /v1/scene
await client.listTextures();                          // GET /v1/textures
await client.getTextureMetadata("T_Body");            // GET /v1/textures/T_Body
const blob = await client.getTextureData("T_Body");   // GET /v1/textures/T_Body/data
await client.putTextureData("T_Body", pngBlob);       // PUT /v1/textures/T_Body/data
await client.createTexture("T_New", pngBlob);         // POST /v1/textures
await client.renameTexture("T_Old", "T_New");         // POST /v1/textures/T_Old/rename
await client.getSelection();                          // GET /v1/selection
await client.exec("my_command", { a: 1 });            // POST /v1/exec
await client.fetch("GET", "/v1/whatever");            // escape hatch

try {
  await client.getTextureMetadata("nonexistent");
} catch (e) {
  if (e instanceof BTPError && e.code === "texture_not_found") {
    // handle
  }
}
```

构造选项:
- `baseUrl` — 默认 `"http://127.0.0.1:18765"`
- `fetch` — 注入自定义 fetch (测试或未来 WebRTC transport)
- `timeoutMs` — 单请求超时（默认无超时）

## 给 sibling 项目集成的建议

1. 拷贝整个 `protocol/v1/` 目录到自己的 vendor 里（per umbrella 的 vendor-everything 约定）。
2. `import { BTPClient } from "./vendor/btp/v1/btp.js"`。
3. 启动时调一次 `getScene()` 探活。失败 → 提示用户启用 Blender 插件的 HTTP toggle。
4. 不要硬编码 `color_space` 值列表；当 opaque string 处理。
5. 不要依赖 `/v1/exec` 下的特定 command 跑核心流程。
6. PUT 之后**不需要**等待"sync"——response 200 时贴图已在 Blender 内更新。
