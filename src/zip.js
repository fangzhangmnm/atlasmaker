// 最小化 ZIP 读写：只支持 STORE（method=0，不压缩）。
//
// 为什么够：AtlasMaker 的 ZIP 内容是 scene.json + PNG/JPEG，后两者已经压缩过，
// 用 DEFLATE 反而浪费 CPU。所以 STORE-only 就是正解，顺带把代码量压到 ~150 行无 deps。
//
// 标准 ZIP 工具（7z、Windows Explorer、unzip）都能读 STORE-only zip。
// 不支持别人压的 DEFLATE zip —— 拒收即可（throw 提示用户重新压成 STORE）。

const SIG_LFH  = 0x04034b50;
const SIG_CD   = 0x02014b50;
const SIG_EOCD = 0x06054b50;

// CRC-32（IEEE，table 法）
const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let i = 0; i < 256; i++) {
    let c = i;
    for (let j = 0; j < 8; j++) c = (c & 1) ? (0xedb88320 ^ (c >>> 1)) : (c >>> 1);
    t[i] = c >>> 0;
  }
  return t;
})();

function crc32(bytes) {
  let c = 0xffffffff;
  for (let i = 0; i < bytes.length; i++) {
    c = CRC_TABLE[(c ^ bytes[i]) & 0xff] ^ (c >>> 8);
  }
  return (c ^ 0xffffffff) >>> 0;
}

async function toBytes(data) {
  if (data instanceof Uint8Array) return data;
  if (data instanceof ArrayBuffer) return new Uint8Array(data);
  if (data instanceof Blob) return new Uint8Array(await data.arrayBuffer());
  if (typeof data === "string") return new TextEncoder().encode(data);
  throw new TypeError("zip: 不支持的数据类型");
}

/**
 * entries: array of { path: string, data: Blob | ArrayBuffer | Uint8Array | string }
 * 返回 Blob (application/zip)
 */
export async function zipPack(entries) {
  const parts = [];
  const cdParts = [];
  let offset = 0;
  for (const { path, data } of entries) {
    const bytes = await toBytes(data);
    const nameBytes = new TextEncoder().encode(path);
    const crc = crc32(bytes);
    const size = bytes.length;
    // Local File Header
    const lfh = new Uint8Array(30 + nameBytes.length);
    const ldv = new DataView(lfh.buffer);
    ldv.setUint32(0, SIG_LFH, true);
    ldv.setUint16(4, 20, true);   // version needed
    ldv.setUint16(6, 0x0800, true); // flags：bit 11 = UTF-8 filename
    ldv.setUint16(8, 0, true);    // method = store
    ldv.setUint16(10, 0, true);   // mod time
    ldv.setUint16(12, 0x0021, true); // mod date = 1980-01-01
    ldv.setUint32(14, crc, true);
    ldv.setUint32(18, size, true);
    ldv.setUint32(22, size, true);
    ldv.setUint16(26, nameBytes.length, true);
    ldv.setUint16(28, 0, true);   // extra length
    lfh.set(nameBytes, 30);
    parts.push(lfh, bytes);
    // Central Directory entry
    const cd = new Uint8Array(46 + nameBytes.length);
    const cdv = new DataView(cd.buffer);
    cdv.setUint32(0, SIG_CD, true);
    cdv.setUint16(4, 20, true);   // version made by
    cdv.setUint16(6, 20, true);   // version needed
    cdv.setUint16(8, 0x0800, true); // flags
    cdv.setUint16(10, 0, true);
    cdv.setUint16(12, 0, true);
    cdv.setUint16(14, 0x0021, true);
    cdv.setUint32(16, crc, true);
    cdv.setUint32(20, size, true);
    cdv.setUint32(24, size, true);
    cdv.setUint16(28, nameBytes.length, true);
    cdv.setUint16(30, 0, true);
    cdv.setUint16(32, 0, true);
    cdv.setUint16(34, 0, true);
    cdv.setUint16(36, 0, true);
    cdv.setUint32(38, 0, true);
    cdv.setUint32(42, offset, true);
    cd.set(nameBytes, 46);
    cdParts.push(cd);
    offset += 30 + nameBytes.length + size;
  }
  const cdOffset = offset;
  let cdSize = 0;
  for (const cd of cdParts) cdSize += cd.length;
  // End of Central Directory
  const eocd = new Uint8Array(22);
  const edv = new DataView(eocd.buffer);
  edv.setUint32(0, SIG_EOCD, true);
  edv.setUint16(4, 0, true);
  edv.setUint16(6, 0, true);
  edv.setUint16(8, entries.length, true);
  edv.setUint16(10, entries.length, true);
  edv.setUint32(12, cdSize, true);
  edv.setUint32(16, cdOffset, true);
  edv.setUint16(20, 0, true);
  return new Blob([...parts, ...cdParts, eocd], { type: "application/zip" });
}

/**
 * 解 zip。返回 { path: Uint8Array }。method != STORE 会抛错。
 */
export async function zipUnpack(blob) {
  const buf = await blob.arrayBuffer();
  const view = new DataView(buf);
  // EOCD 在尾部，可能有 comment（最长 65535）。从后往前找 magic。
  let eocdOffset = -1;
  const minPos = Math.max(0, buf.byteLength - 22 - 0xffff);
  for (let i = buf.byteLength - 22; i >= minPos; i--) {
    if (view.getUint32(i, true) === SIG_EOCD) { eocdOffset = i; break; }
  }
  if (eocdOffset < 0) throw new Error("无效 ZIP：没找到 EOCD");
  const cdCount = view.getUint16(eocdOffset + 10, true);
  const cdOffset = view.getUint32(eocdOffset + 16, true);
  const entries = {};
  let p = cdOffset;
  for (let i = 0; i < cdCount; i++) {
    if (view.getUint32(p, true) !== SIG_CD) throw new Error(`无效 ZIP：CD 条目 ${i}`);
    const method = view.getUint16(p + 10, true);
    const csize = view.getUint32(p + 20, true);
    const nameLen = view.getUint16(p + 28, true);
    const extraLen = view.getUint16(p + 30, true);
    const commentLen = view.getUint16(p + 32, true);
    const lfhOffset = view.getUint32(p + 42, true);
    const nameBytes = new Uint8Array(buf, p + 46, nameLen);
    const name = new TextDecoder().decode(nameBytes);
    p += 46 + nameLen + extraLen + commentLen;
    if (method !== 0) {
      throw new Error(`ZIP 条目 "${name}" 用了 method=${method}（DEFLATE 等），本工具只支持 STORE。重新打成 STORE 再试`);
    }
    const lfhNameLen = view.getUint16(lfhOffset + 26, true);
    const lfhExtraLen = view.getUint16(lfhOffset + 28, true);
    const dataStart = lfhOffset + 30 + lfhNameLen + lfhExtraLen;
    entries[name] = new Uint8Array(buf, dataStart, csize);
  }
  return entries;
}
