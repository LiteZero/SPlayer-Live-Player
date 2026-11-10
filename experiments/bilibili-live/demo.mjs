import { EventEmitter } from "node:events";
import QRCode from "qrcode";
import WebSocket from "ws";
import { BilibiliApi, BiliError, userAgent } from "./bilibili.mjs";
import { packet, decodePackets, normalizeDanmu } from "./protocol.mjs";

export class LiveDemo extends EventEmitter {
  constructor({ api = new BilibiliApi(), WebSocketImpl = WebSocket, pollMs = 2000, qrLifetimeMs = 180_000 } = {}) {
    super();
    this.api = api;
    this.WebSocketImpl = WebSocketImpl;
    this.pollMs = pollMs;
    this.qrLifetimeMs = qrLifetimeMs;
    this.loginGeneration = 0;
    this.roomGeneration = 0;
    this.active = null;
    this.state = {
      account: null,
      accountStatus: "signedOut",
      login: { status: "idle", message: "点击二维码登录，使用哔哩哔哩手机客户端扫码确认" },
      room: { status: "disconnected", message: "尚未连接直播间" },
      messages: [],
      logs: [],
    };
  }

  snapshot() { return structuredClone(this.state); }
  changed() { this.emit("change"); }

  log(stage, message) {
    this.state.logs.push({ at: Date.now(), stage, message });
    this.state.logs = this.state.logs.slice(-40);
    this.changed();
  }

  cancelLogin(update = true) {
    ++this.loginGeneration;
    clearTimeout(this.pollTimer);
    this.pending = null;
    if (update) {
      this.state.login = { status: "idle", message: "已取消本次登录" };
      this.changed();
    }
  }

  async startQr() {
    this.cancelLogin(false);
    const generation = this.loginGeneration;
    const jar = this.api.newJar();
    this.state.login = { status: "generating", message: "正在申请二维码" };
    this.changed();
    try {
      const data = await this.api.generateQr(jar);
      if (generation !== this.loginGeneration) return;
      if (typeof data?.qrcode_key !== "string" || typeof data.url !== "string") throw new Error("二维码响应格式异常");
      const scanUrl = new URL(data.url);
      if (scanUrl.protocol !== "https:" || scanUrl.hostname !== "passport.bilibili.com") throw new Error("扫码链接来源异常");
      const image = await QRCode.toDataURL(data.url, { width: 256, margin: 2, errorCorrectionLevel: "M" });
      if (generation !== this.loginGeneration) return;
      const expiresAt = Date.now() + this.qrLifetimeMs;
      const candidate = { jar, key: data.qrcode_key, generation, expiresAt };
      this.pending = candidate;
      this.state.login = { status: "waitingScan", message: "等待扫码，请在手机端确认登录", image, expiresAt };
      this.log("登录", "二维码已生成，等待用户扫码");
      this.schedulePoll(candidate);
    } catch (error) {
      if (generation !== this.loginGeneration) return;
      this.state.login = { status: "error", message: error.message };
      this.log("登录", error.message);
    }
  }

  schedulePoll(candidate) {
    this.pollTimer = setTimeout(() => this.pollQr(candidate), this.pollMs);
    this.pollTimer.unref();
  }

  async pollQr(candidate) {
    if (candidate !== this.pending) return;
    if (Date.now() >= candidate.expiresAt) return this.expireQr();
    try {
      const data = await this.api.pollQr(candidate.key, candidate.jar);
      if (candidate !== this.pending) return;
      if (Date.now() >= candidate.expiresAt || data?.code === 86038) return this.expireQr();
      if (data?.code === 0) {
        this.state.login = { status: "validating", message: "扫码完成，正在校验账号" };
        this.changed();
        const verified = await this.api.nav(candidate.jar);
        if (candidate !== this.pending) return;
        this.promote(candidate.jar, verified);
        return;
      }
      if (data?.code !== 86101 && data?.code !== 86090) throw new Error(`扫码状态异常（代码 ${Number(data?.code) || "未知"}），请重新申请二维码`);
      this.state.login.status = data.code === 86090 ? "waitingConfirm" : "waitingScan";
      this.state.login.message = data.code === 86090 ? "已扫码，请在手机端确认登录" : "等待扫码";
      this.changed();
    } catch (error) {
      if (candidate !== this.pending) return;
      if (this.state.login.status === "validating") {
        this.pending = null;
        this.state.login = { status: "error", message: error.message };
        this.log("账号校验", error.message);
        return;
      }
      // 暂时网络失败允许下一次轮询；不清空已有登录态。
      this.state.login.message = `${error.message}；有效期内将重试`;
      this.changed();
    }
    if (candidate === this.pending) this.schedulePoll(candidate);
  }

  expireQr() {
    this.pending = null;
    this.state.login = { status: "expired", message: "二维码已过期，请重新点击二维码登录" };
    this.log("登录", "二维码已过期");
  }

  promote(jar, verified) {
    this.cancelLogin(false);
    this.disconnect(false);
    this.active = { jar, ...verified };
    this.state.account = verified.account;
    this.state.accountStatus = "valid";
    this.state.messages = [];
    this.state.login = { status: "success", message: "登录校验成功，可连接直播间" };
    this.log("账号校验", `已确认接收账号 UID ${verified.account.uid}`);
  }

  async importCookie(text) {
    this.cancelLogin(false);
    const generation = this.loginGeneration;
    this.state.login = { status: "validating", message: "正在校验导入的 Cookie" };
    this.changed();
    try {
      const jar = await this.api.importCookie(text);
      const verified = await this.api.nav(jar);
      if (generation === this.loginGeneration) this.promote(jar, verified);
    } catch (error) {
      if (generation !== this.loginGeneration) return;
      this.state.login = { status: "error", message: error.message };
      this.log("Cookie 导入", error.message);
      throw error;
    }
  }

  async checkAccount() {
    const session = this.active;
    if (!session) throw new Error("请先登录");
    try {
      const verified = await this.api.nav(session.jar);
      if (session !== this.active) throw new Error("账号已切换，请重试");
      Object.assign(session, verified);
      this.state.account = verified.account;
      this.state.accountStatus = "valid";
      this.log("账号校验", "登录仍有效");
      return session;
    } catch (error) {
      if (session !== this.active) throw error;
      if (error instanceof BiliError && error.code === -101) {
        this.disconnect(false);
        this.active = null;
        this.state.account = null;
        this.state.accountStatus = "expired";
        this.state.login = { status: "error", message: "登录已失效，请重新扫码或导入 Cookie" };
      } else {
        this.state.accountStatus = "unknown";
      }
      this.log("账号校验", error.message);
      throw error;
    }
  }

  logout() {
    this.cancelLogin(false);
    this.disconnect(false);
    this.active = null;
    this.state.account = null;
    this.state.accountStatus = "signedOut";
    this.state.messages = [];
    this.state.login = { status: "idle", message: "本地登录态已移除" };
    this.log("登录", "已移除本地凭据");
  }

  disconnect(announce = true) {
    ++this.roomGeneration;
    clearTimeout(this.authTimer);
    clearInterval(this.heartbeatTimer);
    const socket = this.socket;
    this.socket = null;
    if (socket) socket.terminate();
    this.state.room = { status: "disconnected", message: "已断开；需要时可手动连接" };
    if (announce) this.log("直播", "已手动断开连接");
  }

  failRoom(generation, message) {
    if (generation !== this.roomGeneration) return;
    const previous = this.state.room;
    this.disconnect(false);
    this.state.room = { ...previous, status: "error", message };
    this.log("直播", message);
  }

  async connect(input) {
    const roomId = String(input ?? "").trim();
    if (!/^[1-9]\d{0,15}$/.test(roomId) || !Number.isSafeInteger(Number(roomId))) throw new Error("请输入有效的数字直播间号（支持短号）");
    if (!this.active) throw new Error("请先登录并校验账号");
    this.disconnect(false);
    const generation = this.roomGeneration;
    const session = this.active;
    this.state.messages = [];
    this.state.room = { status: "resolving", inputId: roomId, message: "正在校验账号和解析直播间", commandCount: 0, danmuCount: 0 };
    this.changed();
    const current = () => generation === this.roomGeneration && session === this.active;
    try {
      await this.checkAccount();
      if (!current()) return;
      const room = await this.api.room(roomId, session.jar);
      if (!current()) return;
      this.state.room = { ...this.state.room, ...room, status: "token", message: "正在获取直播认证" };
      this.log("房间解析", `输入 ${roomId} → 真实房间 ${room.id}`);
      const { token, node } = await this.api.liveToken(room.id, session.jar, session.images);
      if (!current()) return;
      const address = `wss://${node.host}:${node.wss_port}/sub`;
      const cookies = await session.jar.getCookieString(`https://${node.host}/`);
      const buvid = (await session.jar.getCookies(`https://${node.host}/`)).find((cookie) => cookie.key === "buvid3")?.value;
      if (!current()) return;
      this.state.room.status = "connecting";
      this.state.room.node = node.host;
      this.state.room.message = "正在建立 WSS 连接";
      this.changed();
      const socket = new this.WebSocketImpl(address, {
        origin: "https://live.bilibili.com",
        headers: { "User-Agent": userAgent, Referer: `https://live.bilibili.com/${room.id}`, Cookie: cookies },
        handshakeTimeout: 12_000,
        maxPayload: 4 * 1024 * 1024,
        perMessageDeflate: false,
      });
      this.socket = socket;
      socket.on("error", () => this.failRoom(generation, "WSS 连接失败，请检查网络或重新连接"));
      socket.on("close", (code) => this.failRoom(generation, `直播连接已关闭（${code}），请手动重新连接`));
      this.authTimer = setTimeout(() => this.failRoom(generation, "直播连接或认证等待超时，请手动重连"), 20_000);
      this.authTimer.unref();
      socket.on("open", () => {
        if (!current()) return;
        try {
          this.state.room.status = "authenticating";
          this.state.room.message = "WSS 已建立，等待直播认证回复";
          this.changed();
          socket.send(packet(7, { uid: Number(session.account.uid), roomid: Number(room.id), protover: 3, buvid, platform: "web", type: 2, key: token }));
        } catch { this.failRoom(generation, "发送直播认证失败"); }
      });
      socket.on("message", (bytes) => {
        if (!current()) return;
        try {
          for (const decoded of decodePackets(bytes)) {
            if (!current()) break;
            if (decoded.operation === 8) {
              const reply = JSON.parse(decoded.body.toString("utf8"));
              if (reply.code !== 0) {
                this.failRoom(generation, `直播认证被拒绝（代码 ${Number(reply.code) || "未知"}），请检查登录后重连`);
                break;
              }
              if (this.state.room.status === "connected") continue;
              clearTimeout(this.authTimer);
              this.state.room.status = "connected";
              this.state.room.message = "直播认证成功，等待弹幕";
              this.state.room.connectedAt = Date.now();
              let lastHeartbeat = Date.now();
              const heartbeat = () => {
                if (!current()) return;
                if (Date.now() - lastHeartbeat > 75_000) return this.failRoom(generation, "直播心跳超时，请手动重新连接");
                try { socket.send(packet(2, "[object Object]")); }
                catch { this.failRoom(generation, "发送心跳失败，请手动重连"); }
              };
              this.onHeartbeat = () => { lastHeartbeat = Date.now(); };
              heartbeat();
              this.heartbeatTimer = setInterval(heartbeat, 30_000);
              this.heartbeatTimer.unref();
              this.log("直播认证", "认证成功；接收账号与弹幕发送者分别记录");
            } else if (decoded.operation === 3 && this.state.room.status === "connected") {
              this.onHeartbeat?.();
              this.state.room.lastHeartbeatAt = Date.now();
              this.changed();
            } else if (decoded.operation === 5 && this.state.room.status === "connected") {
              const data = JSON.parse(decoded.body.toString("utf8"));
              ++this.state.room.commandCount;
              const message = normalizeDanmu(data, { roomId: room.id, receiverAccountId: session.account.uid });
              if (message) {
                ++this.state.room.danmuCount;
                message.sequence = this.state.room.danmuCount;
                this.state.messages.push(message);
                this.state.messages = this.state.messages.slice(-100);
                this.state.room.lastDanmuAt = message.receivedAt;
              }
              this.changed();
            }
          }
        } catch {
          this.failRoom(generation, "直播数据包解析失败，已停止接收；请记录出现阶段后重连");
        }
      });
    } catch (error) {
      this.failRoom(generation, error.message);
      throw error;
    }
  }

  close() {
    this.cancelLogin(false);
    this.disconnect(false);
    this.active = null;
  }
}
