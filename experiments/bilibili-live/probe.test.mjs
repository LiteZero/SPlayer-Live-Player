import test from "node:test";
import assert from "node:assert/strict";
import { EventEmitter, once } from "node:events";
import { request as httpRequest } from "node:http";
import { deflateSync, brotliCompressSync } from "node:zlib";
import { BilibiliApi } from "./bilibili.mjs";
import { LiveDemo } from "./demo.mjs";
import { createDemoServer } from "./server.mjs";
import { decodePackets, packet, signWbi, normalizeDanmu } from "./protocol.mjs";

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
    setImmediate(() => { if (!this.terminated) this.emit("open"); });
  }
  send(bytes) { this.sent.push(bytes); }
  terminate() { this.terminated = true; }
  receive(bytes) { this.emit("message", bytes); }
}

function fixture(t, { codes = [0], qrLifetimeMs = 2000, pollMs = 2 } = {}) {
  const calls = [];
  const settings = { navCode: 0, failNav: false, waitToken: null };
  const api = new BilibiliApi({ fetchImpl: async (target, options) => {
    const url = new URL(target);
    calls.push({ url, options });
    let data;
    const headers = new Headers({ "Content-Type": "application/json" });
    let code = 0;
    switch (url.pathname) {
      case "/x/passport-login/web/qrcode/generate":
        data = { qrcode_key: "fixture-qr-secret", url: "https://passport.bilibili.com/h5-app/passport/login/scan?qrcode_key=fixture-qr-secret" };
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
        assert.match(options.headers.Cookie, /SESSDATA=/);
        code = settings.navCode;
        data = { isLogin: code === 0, mid: 123, uname: "接收账号", wbi_img: images };
        break;
      case "/room/v1/Room/room_init": data = { room_id: 456, uid: 789, live_status: 1 }; break;
      case "/x/frontend/finger/spi": data = { b_3: "fixture-device-id" }; break;
      case "/xlive/web-room/v1/index/getDanmuInfo":
        assert.match(options.headers.Cookie, /buvid3=fixture-device-id/);
        assert.match(options.headers.Cookie, /SESSDATA=/);
        assert.match(url.searchParams.get("w_rid"), /^[a-f0-9]{32}$/);
        if (settings.waitToken) await settings.waitToken;
        data = { token: "fixture-live-secret", host_list: [{ host: "fixture.chat.bilibili.com", wss_port: 443 }] };
        break;
      default: throw new Error(`未预期的模拟请求 ${url.pathname}`);
    }
    return new Response(JSON.stringify({ code, data }), { headers });
  } });
  const demo = new LiveDemo({ api, WebSocketImpl: FakeSocket, pollMs, qrLifetimeMs });
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
  const { demo } = fixture(t);
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

test("真实 HTTP 页面、管理令牌、同源限制与 SSE 状态", async (t) => {
  const { demo, calls } = fixture(t);
  const app = createDemoServer({ demo });
  app.server.listen(0, "127.0.0.1");
  await once(app.server, "listening");
  t.after(() => app.stop());
  const origin = `http://127.0.0.1:${app.server.address().port}`;
  const page = await fetch(origin);
  assert.match(page.headers.get("content-security-policy"), /frame-ancestors 'none'/);
  const html = await page.text();
  const token = html.match(/name="demo-token" content="([^"]+)"/)[1];
  assert.ok(token && token !== "__MANAGEMENT_TOKEN__");
  assert.equal(calls.length, 0);
  const send = (pathname, value = {}, headers = {}) => fetch(origin + pathname, {
    method: "POST", headers: { "Content-Type": "application/json", "X-Demo-Token": token, ...headers }, body: JSON.stringify(value),
  });
  assert.equal((await send("/api/login/qr", {}, { "X-Demo-Token": "wrong" })).status, 403);
  assert.equal((await send("/api/login/qr", {}, { Origin: "https://example.com" })).status, 403);
  const forbiddenHost = await new Promise((resolve, reject) => {
    const request = httpRequest(origin + "/api/state", { headers: { Host: "attacker.example" } }, (response) => {
      response.resume();
      resolve(response.statusCode);
    });
    request.on("error", reject);
    request.end();
  });
  assert.equal(forbiddenHost, 403);
  assert.equal((await send("/api/room/connect", { roomId: "1" })).status, 400);
  assert.equal((await send("/api/login/qr")).status, 200);
  await until(() => demo.state.login.status === "success");
  const stateText = await (await fetch(origin + "/api/state")).text();
  assert.equal(stateText.includes(secret), false);
  assert.equal(JSON.parse(stateText).account.uid, "123");
  const abort = new AbortController();
  const events = await fetch(origin + "/api/events", { signal: abort.signal });
  const reader = events.body.getReader();
  assert.match(new TextDecoder().decode((await reader.read()).value), /data:.*"uid":"123"/);
  abort.abort();
  await reader.cancel().catch(() => {});
  assert.equal((await send("/api/logout")).status, 200);
  assert.equal(demo.state.account, null);
});
