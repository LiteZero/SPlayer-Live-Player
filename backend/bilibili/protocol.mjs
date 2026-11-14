import { createHash } from "node:crypto";
import { inflateSync, brotliDecompressSync } from "node:zlib";

const mixinTable = [
  46, 47, 18, 2, 53, 8, 23, 32, 15, 50, 10, 31, 58, 3, 45, 35,
  27, 43, 5, 49, 33, 9, 42, 19, 29, 28, 14, 39, 12, 38, 41, 13,
  37, 48, 7, 16, 24, 55, 40, 61, 26, 17, 0, 1, 60, 51, 30, 4,
  22, 25, 54, 21, 56, 59, 6, 63, 57, 62, 11, 36, 20, 34, 44, 52,
];

export function signWbi(params, images, now = Date.now()) {
  const key = (url) => new URL(url).pathname.split("/").at(-1).split(".")[0];
  const raw = key(images.img_url) + key(images.sub_url);
  if (raw.length !== 64) throw new Error("WBI 密钥格式异常，请重新校验登录");
  const mixin = mixinTable.map((i) => raw[i]).join("").slice(0, 32);
  const values = { ...params, wts: Math.floor(now / 1000) };
  const query = Object.keys(values).sort().map((name) =>
    `${encodeURIComponent(name)}=${encodeURIComponent(String(values[name]).replace(/[!'()*]/g, ""))}`,
  ).join("&");
  const signature = createHash("md5").update(query + mixin).digest("hex");
  return `${query}&w_rid=${signature}`;
}

export function packet(operation, body = "", version = 1) {
  const bytes = Buffer.isBuffer(body) ? body : Buffer.from(
    typeof body === "string" ? body : JSON.stringify(body),
  );
  const header = Buffer.alloc(16);
  header.writeUInt32BE(16 + bytes.length, 0);
  header.writeUInt16BE(16, 4);
  header.writeUInt16BE(version, 6);
  header.writeUInt32BE(operation, 8);
  header.writeUInt32BE(1, 12);
  return Buffer.concat([header, bytes]);
}

/** WebSocket 帧中可能有多个包，压缩包内仍有完整包头。 */
export function decodePackets(input, depth = 0, budget = { bytes: 8 * 1024 * 1024, packets: 4000 }) {
  const bytes = Buffer.from(input);
  if (depth > 4 || bytes.length > budget.bytes) throw new Error("消息解压超出验证程序限制");
  budget.bytes -= bytes.length;
  const results = [];
  for (let offset = 0; offset < bytes.length;) {
    if (bytes.length - offset < 16) throw new Error("消息包头不完整");
    const length = bytes.readUInt32BE(offset);
    const header = bytes.readUInt16BE(offset + 4);
    const version = bytes.readUInt16BE(offset + 6);
    const operation = bytes.readUInt32BE(offset + 8);
    if (header < 16 || length < header || offset + length > bytes.length) throw new Error("消息包长度异常");
    if (--budget.packets < 0) throw new Error("消息包数量超出限制");
    const body = bytes.subarray(offset + header, offset + length);
    if (version === 2 || version === 3) {
      if (budget.bytes < 1) throw new Error("消息解压超出验证程序限制");
      const decompress = version === 2 ? inflateSync : brotliDecompressSync;
      const nested = decompress(body, { maxOutputLength: budget.bytes });
      results.push(...decodePackets(nested, depth + 1, budget));
    } else if (version === 0 || version === 1) {
      results.push({ operation, body });
    } else {
      throw new Error("不支持的消息压缩版本");
    }
    offset += length;
  }
  return results;
}

function uid(value) {
  const text = String(value ?? "");
  return /^[1-9]\d*$/.test(text) ? text : null;
}

export function normalizeDanmu(data, context) {
  if (typeof data.cmd !== "string" || data.cmd.split(":")[0] !== "DANMU_MSG") return null;
  const info = data.info;
  if (!Array.isArray(info) || typeof info[1] !== "string") return null;
  const user = info[0]?.[15]?.user;
  const legacy = info[2];
  const oldUid = uid(legacy?.[0]);
  const newUid = uid(user?.uid);
  const conflict = !!(oldUid && newUid && oldUid !== newUid);
  const mystery = user?.base?.is_mystery === true;
  const senderUid = conflict || mystery ? null : newUid ?? oldUid;
  const senderName = user?.base?.name ?? legacy?.[1];
  let extra;
  try { extra = JSON.parse(info[0]?.[15]?.extra ?? "{}"); } catch { /* 可选扩展字段。 */ }
  const sent = Number(info[0]?.[4]);
  return {
    sourcePlatform: "bilibili",
    roomId: context.roomId,
    receiverAccountId: context.receiverAccountId,
    text: info[1].slice(0, 4000),
    senderUid,
    senderName: typeof senderName === "string" ? senderName.slice(0, 100) : null,
    identityStatus: mystery || conflict ? "restricted" : senderUid ? "identified" : "unavailable",
    messageId: typeof extra?.id_str === "string" ? extra.id_str.slice(0, 200) : null,
    sentAt: Number.isFinite(sent) && sent > 0 ? (sent < 1e12 ? sent * 1000 : sent) : null,
    receivedAt: Date.now(),
  };
}
