// BTP 集成（AtlasMaker 侧）：BTPClient 上面包一层
//   - 启动时探活（getScene），失败就标 disconnected
//   - 用户点重试按钮 → 再探活
//   - 拉 textures 列表给 viewport binding 做 autocomplete
//   - push(blob, name) 决定 PUT（已存在）还是 POST（新建）

import { BTPClient, BTPError } from "./vendor/btp/v1/btp.js";

const STATES = ["idle", "connecting", "connected", "disconnected"];

export class BTPManager {
  constructor({ baseUrl } = {}) {
    this.client = new BTPClient({ baseUrl, timeoutMs: 5000 });
    this.state = "idle";        // "idle" | "connecting" | "connected" | "disconnected"
    this.scene = null;          // { blend_filepath, ... } 当前 .blend 信息
    this.lastError = null;
    this._listeners = new Set();
    this._textureCache = [];    // 上次 listTextures 的结果（仅名字）
    this._textureCacheAt = 0;
  }

  onChange(fn) {
    this._listeners.add(fn);
    return () => this._listeners.delete(fn);
  }
  _emit() {
    for (const fn of this._listeners) fn(this);
  }

  _setState(s, extra = {}) {
    this.state = s;
    if ("scene" in extra) this.scene = extra.scene;
    if ("lastError" in extra) this.lastError = extra.lastError;
    this._emit();
  }

  async probe() {
    if (this.state === "connecting") return;
    this._setState("connecting", { lastError: null });
    try {
      const scene = await this.client.getScene();
      this._setState("connected", { scene, lastError: null });
    } catch (e) {
      this._setState("disconnected", { scene: null, lastError: e });
    }
  }

  isConnected() { return this.state === "connected"; }

  // 列 Blender 当前 textures。带 5s 缓存防 spam。
  async listTextures({ force = false } = {}) {
    const now = Date.now();
    if (!force && now - this._textureCacheAt < 5000 && this._textureCache.length) {
      return this._textureCache;
    }
    const list = await this.client.listTextures();
    this._textureCache = list;
    this._textureCacheAt = now;
    return list;
  }

  // 推送：name 已存在 → PUT；否则 POST 新建
  async push(name, blob) {
    if (!name) throw new Error("binding 名为空");
    if (!blob) throw new Error("blob 为空");
    let exists = false;
    try {
      await this.client.getTextureMetadata(name);
      exists = true;
    } catch (e) {
      if (e instanceof BTPError && e.code === "texture_not_found") exists = false;
      else throw e;
    }
    if (exists) {
      const meta = await this.client.putTextureData(name, blob);
      // 列表可能变（packed / dirty）—— 清缓存
      this._textureCache = [];
      this._textureCacheAt = 0;
      return { action: "updated", meta };
    } else {
      const meta = await this.client.createTexture(name, blob);
      this._textureCache = [];
      this._textureCacheAt = 0;
      return { action: "created", meta };
    }
  }
}

export { BTPError };
