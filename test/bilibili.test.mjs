import test from "node:test";
import assert from "node:assert/strict";
import { EventEmitter, once } from "node:events";
import { deflateSync, brotliCompressSync } from "node:zlib";
import { BilibiliApi } from "../backend/bilibili/api.mjs";
import { BilibiliLive as LiveDemo } from "../backend/bilibili/live.mjs";
import { createApp } from "../backend/server.mjs";
import { startMockHost, mockTrack } from "../scripts/mock-host.mjs";
import { WebSocket } from "ws";
import { decodePackets, packet, signWbi, normalizeDanmu } from "../backend/bilibili/protocol.mjs";
import { connectionCandidates, connectionError } from "../backend/bilibili/connection.mjs";

const images = {
  img_url: "https://i0.hdslb.com/bfs/wbi/7cd084941338484aae1ad9425b84077c.png",
  sub_url: "https://i0.hdslb.com/bfs/wbi/4932caff0ff746eab6f01bf08b70ac45.png",
};
const secret = "fixture-session-secret";

class FakeSocket extends EventEmitter {
  static instances = [];
  constructor(address, options) {
    super();
    this.address = address;
    this.options = options;
    this.sent = [];
    this.terminated = false;
    FakeSocket.instances.push(this);
    setImmediate(() => { if (!this.terminated && this.constructor.autoOpen !== false) this.emit("open"); });
  }
  send(bytes) { this.sent.push(bytes); }
  terminate() { this.terminated = true; }
  receive(bytes) { this.emit("message", bytes); }
}

function fixture(t, { codes = [0], qrLifetimeMs = 2000, pollMs = 2, WebSocketImpl = FakeSocket,
  connectTimeoutMs = 6000, authTimeoutMs = 8000 } = {}) {
  const calls = [];
  const settings = { navCode: 0, failNav: false, waitToken: null, nodes: [{ host: "fixture.chat.bilibili.com", wss_port: 443 }] };
  const api = new BilibiliApi({ fetchImpl: async (target, options) => {
    const url = new URL(target);
    calls.push({ url, options });
    let data;
    const headers = new Headers({ "Content-Type": "application/json" });
    let code = 0;
    switch (url.pathname) {
      case "/x/passport-login/web/qrcode/generate":
        data = { qrcode_key: "fixture-qr-secret", url: "https://account.bilibili.com/h5-app/passport/login/scan?qrcode_key=fixture-qr-secret" };
        break;
      case "/x/passport-login/web/qrcode/poll":
        data = { code: codes.length > 1 ? codes.shift() : codes[0], refresh_token: "fixture-refresh-secret", url: `https://passport.biligame.com/?SESSDATA=${secret}` };
        if (data.code === 0) {
          headers.append("Set-Cookie", `SESSDATA=${secret}; Domain=bilibili.com; Path=/; Secure; HttpOnly`);
          headers.append("Set-Cookie", "DedeUserID=999; Domain=bilibili.com; Path=/; Secure");
        }
        break;
      case "/x/web-interface/nav":
        if (settings.failNav) throw new Error("模拟网络断开");
        code = /SESSDATA=/.test(options.headers.Cookie) ? settings.navCode : -101;
        data = { isLogin: code === 0, mid: 123, uname: "接收账号", wbi_img: images };
        break;
      case "/room/v1/Room/room_init": data = { room_id: 456, uid: 789, live_status: 1 }; break;
      case "/x/frontend/finger/spi": data = { b_3: "fixture-device-id" }; break;
      case "/xlive/web-room/v1/index/getDanmuInfo":
        assert.match(options.headers.Cookie, /buvid3=fixture-device-id/);
        assert.match(url.searchParams.get("w_rid"), /^[a-f0-9]{32}$/);
        if (settings.waitToken) await settings.waitToken;
        data = { token: "fixture-live-secret", host_list: settings.nodes };
        break;
      default: throw new Error(`未预期的模拟请求 ${url.pathname}`);
    }
    return new Response(JSON.stringify({ code, data }), { headers });
  } });
  const demo = new LiveDemo({ api, WebSocketImpl, pollMs, qrLifetimeMs, connectTimeoutMs, authTimeoutMs });
  t.after(() => demo.close());
  return { api, demo, calls, settings };
}

async function until(predicate, ms = 3000) {
  const end = Date.now() + ms;
  while (!predicate()) {
    if (Date.now() > end) throw new Error("等待测试状态超时");
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

async function login(demo) {
  await demo.startQr();
  await until(() => demo.state.login.status === "success");
}

test("WBI 签名与资料中的固定向量一致，空格按百分号编码", () => {
  assert.equal(signWbi({ foo: "114", bar: "514", zab: 1919810 }, images, 1702204169000), "bar=514&foo=114&wts=1702204169&zab=1919810&w_rid=8f6f2b5b3d485fe1886cec6a0be8c5d4");
  assert.match(signWbi({ text: "中 文!'()*" }, images, 1702204169000), /text=%E4%B8%AD%20%E6%96%87&/);
});

test("合包、zlib、Brotli 嵌套解码，损坏长度拒绝", () => {
  const auth = packet(8, { code: 0 });
  const nested = packet(5, { cmd: "DANMU_MSG" }, 0);
  const compressed = packet(5, brotliCompressSync(packet(5, deflateSync(nested), 2)), 3);
  const decoded = decodePackets(Buffer.concat([auth, compressed]));
  assert.deepEqual(decoded.map((item) => item.operation), [8, 5]);
  assert.deepEqual(JSON.parse(decoded[1].body), { cmd: "DANMU_MSG" });
  const corrupt = Buffer.from(auth);
  corrupt.writeUInt32BE(65536, 0);
  assert.throws(() => decodePackets(corrupt), /长度/);
  assert.throws(() => decodePackets(Buffer.alloc(4)), /包头/);
});

test("发送者身份来自弹幕，缺失、神秘和冲突时不伪造 UID", () => {
  const context = { roomId: "456", receiverAccountId: "123" };
  const data = { cmd: "DANMU_MSG:4:0:2:2:2:0", info: [[], "歌词验收 <script>alert(1)</script>", [777, "观众"]] };
  const message = normalizeDanmu(data, context);
  assert.equal(message.senderUid, "777");
  assert.equal(message.receiverAccountId, "123");
  assert.equal(message.identityStatus, "identified");
  data.info[2][0] = 0;
  assert.equal(normalizeDanmu(data, context).identityStatus, "unavailable");
  data.info[0][15] = { user: { uid: 777, base: { name: "神秘", is_mystery: true } } };
  assert.equal(normalizeDanmu(data, context).senderUid, null);
  assert.equal(normalizeDanmu(data, context).identityStatus, "restricted");
  data.info[0][15].user.base.is_mystery = false;
  data.info[2][0] = 888;
  assert.equal(normalizeDanmu(data, context).identityStatus, "restricted");
});

test("启动不请求平台；扫码区分根级成功与 data.code 并校验实际账号", async (t) => {
  const { demo, calls } = fixture(t, { codes: [86101, 86090, 0] });
  assert.equal(calls.length, 0);
  await demo.startQr();
  assert.match(demo.state.login.image, /^data:image\/png;base64,/);
  await until(() => demo.state.login.status === "success");
  assert.equal(demo.state.account.uid, "123");
  assert.notEqual(demo.state.account.uid, "999");
  const snapshot = JSON.stringify(demo.snapshot());
  for (const sensitive of [secret, "fixture-refresh-secret", "fixture-qr-secret", "fixture-live-secret"]) assert.equal(snapshot.includes(sensitive), false);
});

test("二维码过期、取消后的迟到响应不提交登录态", async (t) => {
  const { demo, api } = fixture(t, { codes: [86038] });
  await demo.startQr();
  await until(() => demo.state.login.status === "expired");
  assert.equal(demo.state.login.image, undefined);
  let release;
  api.generateQr = () => new Promise((resolve) => { release = resolve; });
  const pending = demo.startQr();
  demo.cancelLogin();
  release({ qrcode_key: "old", url: "https://passport.bilibili.com/scan?qrcode_key=old" });
  await pending;
  assert.equal(demo.state.login.status, "idle");
  assert.equal(demo.state.account, null);
});

test("二维码仅接受允许的 HTTPS 登录域名，拒绝相似域名", async (t) => {
  const { demo, api } = fixture(t);
  api.generateQr = async () => ({ qrcode_key: "fixture", url: "https://account.bilibili.com.example.com/scan?qrcode_key=fixture" });
  await demo.startQr();
  assert.equal(demo.state.login.status, "error");
  assert.match(demo.state.login.message, /来源异常/);
  assert.equal(demo.state.login.image, undefined);
});

test("导入 Cookie 后验证 UID；无效导入不破坏已有账号", async (t) => {
  const { demo } = fixture(t);
  await demo.importCookie("Cookie: SESSDATA=encoded%2Cvalue; bili_jct=csrf");
  assert.equal(demo.state.account.uid, "123");
  assert.match(await demo.active.jar.getCookieString("https://api.bilibili.com/"), /encoded%2Cvalue/);
  const active = demo.active;
  await assert.rejects(demo.importCookie("bili_jct=csrf"), /缺少 SESSDATA/);
  assert.equal(demo.active, active);
  assert.equal(demo.state.accountStatus, "valid");
});

test("暂时校验失败保留凭据；-101 清除活动会话并断开房间", async (t) => {
  const { demo, settings } = fixture(t);
  await login(demo);
  const active = demo.active;
  settings.failNav = true;
  await assert.rejects(demo.checkAccount());
  assert.equal(demo.active, active);
  assert.equal(demo.state.accountStatus, "unknown");
  settings.failNav = false;
  settings.navCode = -101;
  await assert.rejects(demo.checkAccount());
  assert.equal(demo.active, null);
  assert.equal(demo.state.accountStatus, "expired");
});

test("短号到真实房间、同 UID 认证、心跳和压缩弹幕接收", async (t) => {
  const { demo, calls } = fixture(t);
  await login(demo);
  await demo.connect("1");
  const socket = demo.socket;
  await until(() => socket.sent.length > 0);
  const auth = decodePackets(socket.sent[0])[0];
  assert.equal(auth.operation, 7);
  const payload = JSON.parse(auth.body);
  assert.equal(payload.uid, 123);
  assert.equal(payload.roomid, 456);
  assert.equal(payload.key, "fixture-live-secret");
  assert.match(calls.find((call) => call.url.pathname.endsWith("getDanmuInfo")).options.headers.Cookie, /SESSDATA=/);
  assert.equal(demo.state.room.status, "authenticating");
  socket.receive(packet(8, { code: 0 }));
  assert.equal(demo.state.room.status, "connected");
  assert.equal(decodePackets(socket.sent[1])[0].operation, 2);
  socket.receive(packet(3, Buffer.alloc(4)));
  const data = { cmd: "DANMU_MSG", info: [[], "歌词验收", [777, "观众"]] };
  socket.receive(packet(5, brotliCompressSync(packet(5, data, 0)), 3));
  assert.equal(demo.state.messages[0].senderUid, "777");
  assert.equal(demo.state.messages[0].receiverAccountId, "123");
  assert.equal(demo.state.room.danmuCount, 1);
  assert.ok(demo.state.room.lastHeartbeatAt);
  demo.disconnect();
  socket.receive(packet(5, data, 0));
  assert.equal(demo.state.room.status, "disconnected");
  assert.equal(demo.state.messages.length, 1);
});

test("未登录可用游客连接；即使已有账号也不发送账号 Cookie", async (t) => {
  const { demo, calls } = fixture(t);
  await demo.connect("1", "guest");
  assert.equal(demo.state.accountStatus, "signedOut");
  assert.equal(demo.state.room.mode, "guest");
  await login(demo);
  const firstGuestCall = calls.length;
  await demo.connect("1", "guest");
  const socket = demo.socket;
  await until(() => socket.sent.length > 0);
  assert.equal(JSON.parse(decodePackets(socket.sent[0])[0].body).uid, 0);
  assert.doesNotMatch(socket.options.headers.Cookie, /SESSDATA=|DedeUserID=/);
  for (const call of calls.slice(firstGuestCall)) assert.doesNotMatch(call.options.headers.Cookie, /SESSDATA=|DedeUserID=/);
  socket.receive(packet(8, { code: 0 }));
  socket.receive(packet(5, { cmd: "DANMU_MSG", info: [[], "游客验收", [0, "观***"]] }, 0));
  assert.equal(demo.state.account.uid, "123");
  assert.equal(demo.state.messages[0].receiverAccountId, null);
  assert.equal(demo.state.messages[0].senderUid, null);
  assert.equal(demo.state.messages[0].identityStatus, "unavailable");
});

test("认证拒绝不会记为已连接，数据包异常安全停止", async (t) => {
  const { demo } = fixture(t);
  await login(demo);
  await demo.connect("1");
  demo.socket.receive(packet(8, { code: -101 }));
  assert.equal(demo.state.room.status, "error");
  assert.equal(demo.socket, null);
  await demo.connect("1");
  demo.socket.receive(Buffer.alloc(4));
  assert.equal(demo.state.room.status, "error");
  assert.match(demo.state.room.message, /解析失败/);
});

test("断开时使在途直播 token 失效，不创建旧连接", async (t) => {
  const { demo, settings, calls } = fixture(t);
  await login(demo);
  let release;
  settings.waitToken = new Promise((resolve) => { release = resolve; });
  const pending = demo.connect("1");
  await until(() => calls.some((call) => call.url.pathname.endsWith("getDanmuInfo")));
  demo.disconnect();
  release();
  await pending;
  assert.equal(demo.socket, null);
  assert.equal(demo.state.room.status, "disconnected");
  await assert.rejects(demo.connect("https://example.com"), /有效的数字/);
});

test("连接候选仅使用返回的 B 站域名，补充 443、去重并限制数量；错误不输出原始凭据", () => {
  const nodes = [{ host: "first.chat.bilibili.com", wss_port: 2245 }, { host: "second.chat.bilibili.com", wss_port: 443 },
    { host: "evil.example", wss_port: 443 }, { host: "ignored.chat.bilibili.com", wss_port: 443 }];
  assert.deepEqual(connectionCandidates(nodes), [
    { host: "first.chat.bilibili.com", wss_port: 2245 }, { host: "first.chat.bilibili.com", wss_port: 443 },
    { host: "second.chat.bilibili.com", wss_port: 443 },
  ]);
  assert.deepEqual(connectionCandidates([nodes[0], nodes[0]]), connectionCandidates([nodes[0]]));
  assert.equal(connectionError({ code: "ECONNRESET", message: "SESSDATA=secret" }), "连接被重置（ECONNRESET）");
  assert.equal(connectionError({ code: "unknown", message: "token=secret" }), "WSS 连接失败");
});

test("连接停滞受独立时限限制，2245 失败后切换 443，旧 socket 不能覆盖新连接", async (t) => {
  class StalledSocket extends FakeSocket { static autoOpen = false; }
  const { demo, settings } = fixture(t, { WebSocketImpl: StalledSocket, connectTimeoutMs: 60, authTimeoutMs: 1000 });
  settings.nodes = [{ host: "fixture.chat.bilibili.com", wss_port: 2245 }];
  await login(demo);
  await demo.connect("1");
  const first = demo.socket;
  assert.match(first.address, /:2245\/sub$/);
  await until(() => demo.socket && demo.socket !== first);
  const second = demo.socket;
  assert.equal(first.terminated, true);
  assert.match(second.address, /:443\/sub$/);
  assert.equal(demo.state.room.attempt, 2);
  second.emit("open");
  second.receive(packet(8, { code: 0 }));
  first.emit("open"); first.emit("error", { code: "ECONNRESET" }); first.emit("close", 1006);
  first.receive(packet(8, { code: -101 }));
  assert.equal(demo.socket, second);
  assert.equal(demo.state.room.status, "connected");
  assert.equal(JSON.parse(decodePackets(second.sent[0])[0].body).uid, 123);
  assert.match(second.options.headers.Cookie, /SESSDATA=/);
  const snapshot = JSON.stringify(demo.snapshot());
  for (const value of [secret, "fixture-live-secret"]) assert.equal(snapshot.includes(value), false);
});

test("所有候选都无回应时明确结束，不永久停在建立 WSS 连接", async (t) => {
  class StalledSocket extends FakeSocket { static autoOpen = false; }
  const { demo, settings } = fixture(t, { WebSocketImpl: StalledSocket, connectTimeoutMs: 25 });
  settings.nodes = [{ host: "first.chat.bilibili.com", wss_port: 443 }, { host: "second.chat.bilibili.com", wss_port: 443 }];
  await demo.connect("1", "guest");
  await until(() => demo.state.room.status === "error");
  assert.match(demo.state.room.message, /节点尝试完毕.*超时/);
  assert.equal(demo.state.room.attempt, 2);
  assert.equal(demo.socket, null);
});

test("握手 HTTP 拒绝时使用备用节点，显式认证拒绝则停止回退", async (t) => {
  const { demo, settings } = fixture(t);
  settings.nodes = [{ host: "first.chat.bilibili.com", wss_port: 443 }, { host: "second.chat.bilibili.com", wss_port: 443 }];
  await login(demo);
  await demo.connect("1");
  const first = demo.socket;
  let drained = false;
  first.emit("unexpected-response", null, { statusCode: 503, resume() { drained = true; } });
  await until(() => demo.socket && demo.socket !== first);
  assert.equal(drained, true);
  assert.equal(demo.state.room.attempt, 2);
  assert.match(demo.state.room.lastError, /HTTP 503/);
  const second = demo.socket;
  second.receive(packet(8, { code: -101 }));
  await new Promise((resolve) => setTimeout(resolve, 20));
  assert.equal(demo.state.room.status, "error");
  assert.match(demo.state.room.message, /认证被拒绝/);
  assert.equal(demo.socket, null);
});

test("认证回复超时可切换节点，手动断开会停止剩余尝试", async (t) => {
  const { demo, settings } = fixture(t, { authTimeoutMs: 35 });
  settings.nodes = [{ host: "first.chat.bilibili.com", wss_port: 443 }, { host: "second.chat.bilibili.com", wss_port: 443 }];
  await demo.connect("1", "guest");
  const first = demo.socket;
  await until(() => demo.socket && demo.socket !== first);
  assert.match(demo.state.room.lastError, /认证回复超时/);
  const second = demo.socket;
  demo.disconnect();
  first.emit("error", { code: "ECONNRESET" });
  second.emit("open"); second.receive(packet(8, { code: 0 }));
  await new Promise((resolve) => setTimeout(resolve, 60));
  assert.equal(demo.socket, null);
  assert.equal(demo.state.room.status, "disconnected");
});

test("正式链路：管理页登录与连接 → 压缩弹幕 → 去重身份检查 → 构建插件入原生队列", async (t) => {
  const { demo, calls } = fixture(t);
  const app = createApp({ bili: demo });
  app.server.listen(0, "127.0.0.1");
  await once(app.server, "listening");
  t.after(() => new Promise((resolve) => app.close(resolve)));
  const origin = `http://127.0.0.1:${app.server.address().port}`;
  const send = (path, body = {}) => fetch(origin + path, { method: "POST", headers: {
    "Content-Type": "application/json", "X-SPlayer-Live-Management": "1" }, body: JSON.stringify(body) });
  const page = await fetch(origin);
  assert.match(await page.text(), /观众点歌队列/);
  assert.equal(calls.length, 0, "启动及访问页面不自动请求 B 站");
  assert.equal((await send("/api/bilibili/login/qr")).status, 200);
  await until(() => demo.state.login.status === "success");
  assert.equal((await send("/api/bilibili/room/connect", { roomId: "1", mode: "account" })).status, 200);
  const socket = demo.socket;
  await until(() => socket.sent.length > 0);
  socket.receive(packet(8, { code: 0 }));
  assert.equal((await send("/api/requests/config", { enabled: true, platform: "netease", allowAnonymous: false })).status, 200);
  const frames = [];
  const obs = new WebSocket(origin.replace("http:", "ws:") + "/ws", { origin });
  obs.on("message", (bytes) => frames.push(bytes.toString()));
  await once(obs, "open");
  t.after(() => obs.terminate());
  const tracks = [mockTrack("original", "原来的歌")];
  let searches = 0;
  const host = startMockHost({ origin, read: async () => ({ track: tracks[0], state: "playing", position: 100,
    lyricAvailable: false }), log: { info() {}, warn() {}, error() {} },
    music: { searchOnline: async ({ query }) => { ++searches; return { tracks: [{ ...mockTrack("first", query), source: "netease" }] }; } },
    player: {
      getStatus: async () => ({ currentIndex: 0, repeat: "list", shuffle: "off" }),
      getQueue: async ({ offset, limit }) => ({ tracks: tracks.slice(offset, offset + limit), total: tracks.length, currentIndex: 0, offset }),
      addToQueue: async (added, position) => { assert.equal(position, "next"); tracks.splice(1, 0, ...added); return { count: added.length }; },
      playTrack: async () => assert.fail("不得抢播"),
    },
  });
  t.after(() => host.stop());
  const message = { cmd: "DANMU_MSG", info: [[], "点歌 晴天", [777, "观众"]] };
  message.info[0][4] = 1700000000;
  message.info[0][15] = { extra: JSON.stringify({ id_str: "same-message" }) };
  const compressed = packet(5, brotliCompressSync(packet(5, message, 0)), 3);
  socket.receive(compressed); socket.receive(compressed);
  socket.receive(packet(5, { cmd: "DANMU_MSG", info: [[], "点歌 缺失身份", [0, "观***"]] }, 0));
  socket.receive(packet(5, { cmd: "DANMU_MSG", info: [[], "我想点歌 晴天", [777, "观众"]] }, 0));
  let state;
  for (let attempt = 0; attempt < 100; ++attempt) {
    state = await (await fetch(origin + "/api/requests")).json();
    if (state.history[0]?.status === "added" && state.native?.total === 2) break;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  assert.equal(searches, 1);
  assert.equal(tracks.length, 2);
  assert.equal(state.history[0].status, "added");
  assert.equal(state.history[0].sender.senderUid, "777");
  assert.equal(state.native.total, 2);
  assert.equal(state.receipts.filter((item) => item.outcome === "rejected").length, 1);
  const snapshot = JSON.stringify(state);
  for (const value of [secret, "fixture-live-secret", "fixture-refresh-secret", "fixture-qr-secret"]) assert.equal(snapshot.includes(value), false);
  assert.ok(frames.length);
  for (const frame of frames) {
    for (const value of ["senderUid", "receiverAccountId", "receipts", "SESSDATA", "qrcode", "pending"]) assert.equal(frame.includes(value), false);
  }
  assert.equal((await send("/api/bilibili/logout")).status, 200);
  assert.equal(demo.active, null);
  socket.receive(compressed);
  assert.equal(searches, 1);
});

