import { CookieJar } from "tough-cookie";
import { signWbi } from "./protocol.mjs";

const PASSPORT = "https://passport.bilibili.com";
const API = "https://api.bilibili.com";
const LIVE = "https://api.live.bilibili.com";
export const userAgent = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36";

export class BiliError extends Error {
  constructor(stage, code = null) {
    super(`${stage}失败${code == null ? "，请检查网络或稍后重试" : `（平台代码 ${code}）`}`);
    this.code = code;
  }
}

export class BilibiliApi {
  constructor({ fetchImpl = fetch } = {}) {
    this.fetch = fetchImpl;
  }

  newJar() { return new CookieJar(); }

  async request(url, jar, stage, referer = "https://www.bilibili.com/") {
    // 所有 URL 均由后端固定构造，不接受浏览器提交的目标地址。
    let response;
    try {
      response = await this.fetch(url, {
        headers: { "User-Agent": userAgent, Referer: referer, Cookie: await jar.getCookieString(url) },
        redirect: "error",
        signal: AbortSignal.timeout(12_000),
      });
    } catch { throw new BiliError(stage); }
    if (!response.ok) throw new BiliError(stage, `HTTP ${response.status}`);
    for (const cookie of response.headers.getSetCookie()) {
      await jar.setCookie(cookie, url, { ignoreError: true });
    }
    let json;
    try { json = await response.json(); } catch { throw new BiliError(stage, "响应不是 JSON"); }
    if (json.code !== 0) throw new BiliError(stage, typeof json.code === "number" ? json.code : "响应格式异常");
    return json.data;
  }

  generateQr(jar) { return this.request(`${PASSPORT}/x/passport-login/web/qrcode/generate`, jar, "申请二维码"); }

  pollQr(key, jar) {
    return this.request(`${PASSPORT}/x/passport-login/web/qrcode/poll?qrcode_key=${encodeURIComponent(key)}`, jar, "查询扫码状态");
  }

  async nav(jar) {
    const data = await this.request(`${API}/x/web-interface/nav`, jar, "校验登录");
    if (!data?.isLogin || !Number.isSafeInteger(data.mid) || data.mid < 1) throw new BiliError("校验登录", -101);
    return { account: { uid: String(data.mid), name: String(data.uname ?? ""), face: data.face ?? null }, images: data.wbi_img };
  }

  async importCookie(text) {
    if (typeof text !== "string" || text.length > 16_000 || /[\r\n]/.test(text)) throw new Error("请输入单行 Cookie 字符串");
    const jar = this.newJar();
    for (const part of text.replace(/^Cookie:\s*/i, "").split(";")) {
      const cookie = part.trim();
      if (!cookie || cookie.indexOf("=") <= 0) continue;
      await jar.setCookie(`${cookie}; Domain=bilibili.com; Path=/; Secure`, "https://www.bilibili.com/", { ignoreError: true });
    }
    if (!(await jar.getCookies(API)).some((cookie) => cookie.key === "SESSDATA" && cookie.value)) throw new Error("Cookie 缺少 SESSDATA");
    return jar;
  }

  async room(id, jar) {
    const data = await this.request(`${LIVE}/room/v1/Room/room_init?id=${id}`, jar, "解析直播间", `https://live.bilibili.com/${id}`);
    if (!Number.isSafeInteger(data?.room_id) || data.room_id < 1) throw new BiliError("解析直播间", "缺少真实房间号");
    return { id: String(data.room_id), inputId: id, ownerUid: String(data.uid ?? ""), liveStatus: data.live_status };
  }

  async liveToken(roomId, jar, images) {
    if (!(await jar.getCookies(LIVE)).some((cookie) => cookie.key === "buvid3" && cookie.value)) {
      const device = await this.request(`${API}/x/frontend/finger/spi`, jar, "获取设备标识");
      if (typeof device?.b_3 !== "string" || !device.b_3) throw new BiliError("获取设备标识", "缺少 buvid3");
      await jar.setCookie(`buvid3=${device.b_3}; Domain=bilibili.com; Path=/; Secure`, API);
    }
    if (!images?.img_url || !images?.sub_url) throw new Error("缺少 WBI 密钥，请重新检查登录状态");
    const query = signWbi({ id: roomId, type: 0, web_location: 444.8 }, images);
    const data = await this.request(`${LIVE}/xlive/web-room/v1/index/getDanmuInfo?${query}`, jar, "获取直播认证", `https://live.bilibili.com/${roomId}`);
    if (typeof data?.token !== "string" || !data.token || !Array.isArray(data.host_list)) throw new BiliError("获取直播认证", "缺少 token 或节点");
    const nodes = data.host_list.filter((node) =>
      typeof node.host === "string" && /^[a-z0-9.-]+\.chat\.bilibili\.com$/i.test(node.host) &&
      Number.isInteger(node.wss_port) && node.wss_port > 0 && node.wss_port < 65536,
    );
    if (!nodes.length) throw new BiliError("获取直播认证", "没有可用的 WSS 节点");
    return { token: data.token, node: nodes[0] };
  }
}
