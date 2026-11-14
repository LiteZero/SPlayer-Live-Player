import test from "node:test";
import assert from "node:assert/strict";
import { once } from "node:events";
import { setTimeout as delay } from "node:timers/promises";
import { createRequests, parseSongRequest } from "../backend/requests.mjs";
import { createApp } from "../backend/server.mjs";
import { startMockHost, mockTrack } from "../scripts/mock-host.mjs";

const config = { enabled: true, platform: "netease", allowAnonymous: false };
const transport = { protocolVersion: 1, serverId: "server", sessionId: "session", capable: true, schedulerVersion: 1 };
const playback = (q, track = mockTrack("idle", "普通歌单"), state = "playing") =>
  q.observePlayback({ sessionId: transport.sessionId, track, state });
const danmu = (overrides = {}) => ({ roomId: "123", senderUid: "777", senderName: "观众", text: "点歌 晴天",
  identityStatus: "identified", messageId: "message-1", sentAt: 1000, ...overrides });

test("只解析明确点歌前缀；消息去重、身份策略、游客和待处理容量", () => {
  for (const text of ["点歌", "点歌   ", "想点歌 晴天", "点歌晴天", null]) assert.equal(parseSongRequest(text), null);
  assert.equal(parseSongRequest("  点歌\t晴天 周杰伦  "), "晴天 周杰伦");
  const q = createRequests();
  q.ingest(danmu(), { mode: "account" });
  assert.equal(q.snapshot().receipts[0].outcome, "rejected");
  q.configure(config);
  q.ingest(danmu({ messageId: "m2" }), { mode: "guest" });
  q.ingest(danmu({ messageId: "m3", senderUid: null, identityStatus: "unavailable" }), { mode: "account" });
  assert.equal(q.snapshot().pending.length, 0);
  q.ingest(danmu({ messageId: "m4" }), { mode: "account" });
  q.ingest(danmu({ messageId: "m4" }), { mode: "account" });
  assert.equal(q.snapshot().pending.length, 1);
  // Same song by different messages is allowed; missing IDs do not collapse by text alone.
  q.ingest(danmu({ messageId: null, sentAt: null }), { mode: "account" });
  q.ingest(danmu({ messageId: null, sentAt: null }), { mode: "account" });
  assert.equal(q.snapshot().pending.length, 3);
  q.configure({ ...config, allowAnonymous: true });
  q.ingest(danmu({ messageId: "m5", senderUid: null, identityStatus: "restricted" }), { mode: "account" });
  assert.equal(q.snapshot().pending.length, 4);
  while (q.snapshot().pending.length < 50) q.enqueue("填充");
  assert.throws(() => q.enqueue("超过容量"), /已满/);
  q.cancel(q.snapshot().pending[0].commandId);
  assert.equal(q.snapshot().pending.length, 49);
});

test("FIFO 只派发一次，回报重试幂等；超时及会话切换不重放", () => {
  let now = 100;
  const q = createRequests({ now: () => now, leaseMs: 50 });
  q.configure(config);
  playback(q);
  q.enqueue("第一首"); q.enqueue("第二首");
  const first = q.poll(transport);
  assert.equal(first.args.query, "第一首");
  assert.equal(q.poll(transport), null);
  const report = { ...transport, ...first, status: "added", track: mockTrack("one", "一") };
  assert.equal(q.check(report), true);
  assert.equal(q.report({ ...report, leaseId: "wrong" }), false);
  assert.equal(q.report(report), true);
  assert.equal(q.report(report), true);
  assert.equal(q.snapshot().history.length, 1);
  assert.equal(q.poll(transport), null, "第一首还未播放，不能把第二首插到它前面");
  playback(q, mockTrack("one", "一"));
  const second = q.poll(transport);
  now += 60;
  q.expire();
  assert.equal(q.snapshot().history.at(-1).status, "expired");
  assert.equal(q.report({ ...transport, ...second, status: "added", track: mockTrack("two", "二") }), true);
  assert.equal(q.snapshot().history.at(-1).status, "expired");
  q.enqueue("第三首");
  assert.equal(q.poll(transport), null);
  q.resume();
  const third = q.poll(transport);
  q.sessionChanged("new-session");
  assert.equal(q.snapshot().history.at(-1).status, "unconfirmed");
  assert.equal(q.check({ ...transport, ...third }), false);
  assert.equal(q.snapshot().pending.length, 0);
});

async function until(read, timeout = 10000) {
  const end = Date.now() + timeout;
  while (Date.now() < end) {
    const result = await read();
    if (result) return result;
    await delay(25);
  }
  assert.fail("等待点歌测试条件超时");
}

async function harness(t, { search, append, initialTracks, queueRead, shuffle = "off", leaseMs = 45000 } = {}) {
  const requests = createRequests({ leaseMs });
  const app = createApp({ requests });
  app.server.listen(0, "127.0.0.1");
  await once(app.server, "listening");
  const origin = `http://127.0.0.1:${app.server.address().port}`;
  t.after(() => new Promise((resolve) => app.close(resolve)));
  const original = mockTrack("original", "当前播放");
  const first = { ...mockTrack("first", "搜索首项"), source: "netease", providerExtra: "must-retain" };
  const tracks = initialTracks ? initialTracks(original, first) : [original];
  let currentIndex = 0, playState = "playing";
  const calls = [];
  let dropReport = true;
  const host = startMockHost({ origin, read: async () => ({ track: tracks[currentIndex] ?? null, state: playState, position: 400,
    lyricAvailable: false, speed: 1 }), log: { info() {}, warn() {}, error() {} },
    music: { searchOnline: async (args) => {
      calls.push({ method: "search", args });
      return search ? search(args, first) : { tracks: [first, mockTrack("second", "不能替补播放")] };
    } },
    player: {
      getStatus: async () => ({ currentIndex, repeat: "list", shuffle }),
      getQueue: async ({ offset = 0, limit = 50 } = {}) => queueRead ? queueRead({ offset, limit }, tracks, currentIndex) :
        ({ tracks: tracks.slice(offset, offset + limit), total: tracks.length, currentIndex, offset }),
      playTrack: async () => assert.fail("点歌不能打断当前播放"),
      addToQueue: async (added, position) => {
        calls.push({ method: "append", added, position });
        if (append) return append(added, tracks, currentIndex);
        const fresh = added.filter((track) => !tracks.some((existing) => existing.id === track.id));
        tracks.splice(position === "next" ? currentIndex + 1 : tracks.length, 0, ...fresh);
        return { count: added.length };
      },
    },
    request: async (url, options) => {
      const response = await fetch(url, options);
      if (url.endsWith("/commands/report") && dropReport) {
        dropReport = false;
        await response.text();
        throw new Error("模拟结果回报确认丢失");
      }
      return response;
    },
  });
  t.after(() => host.stop());
  const post = (path, body = {}, headers = {}) => fetch(origin + path, { method: "POST", headers: {
    "Content-Type": "application/json", "X-SPlayer-Live-Management": "1", ...headers }, body: JSON.stringify(body) });
  assert.equal((await post("/api/requests/config", config)).status, 200);
  return { requests, origin, post, tracks, calls, first, host,
    setPlaying(index, state = "playing") {
      currentIndex = index; playState = state;
      host.emit("trackChange", { track: tracks[index] });
      host.emit("playStateChange", { state, position: 0 });
    } };
}

test("正式后端与构建插件：首项完整安排下一首，回报丢失不重复添加，歌词继续同步", async (t) => {
  let release;
  const gate = new Promise((resolve) => { release = resolve; });
  const h = await harness(t, { search: async (args, first) => { await gate; return { tracks: [first] }; } });
  assert.equal((await h.post("/api/requests/add", { query: "晴天" })).status, 200);
  await until(() => h.calls.some((call) => call.method === "search"));
  const before = await (await fetch(h.origin + "/api/status")).json();
  await delay(600);
  const during = await (await fetch(h.origin + "/api/status")).json();
  assert.ok(during.metrics.samples > before.metrics.samples, "搜索期间歌词采样持续上传");
  release();
  await until(() => h.requests.snapshot().history[0]?.status === "added");
  await delay(1600);
  assert.equal(h.calls.filter((c) => c.method === "append").length, 1);
  const appended = h.calls.find((c) => c.method === "append");
  assert.equal(appended.position, "next");
  assert.equal(appended.added[0].providerExtra, "must-retain");
  assert.deepEqual(JSON.parse(JSON.stringify(h.calls.find((c) => c.method === "search").args)),
    { platform: "netease", query: "晴天", page: 1, limit: 1 });
  await until(() => h.requests.snapshot().native?.total === 2);
  assert.equal(h.requests.snapshot().native.currentIndex, 0);
  assert.equal(h.requests.snapshot().history.length, 1);
  assert.equal((await h.post("/api/requests/add", { query: "外部" }, { Origin: "https://example.com" })).status, 403);
  assert.equal((await h.post("/api/requests/add", { query: "外部" }, { "X-SPlayer-Live-Management": "" })).status, 403);
  assert.equal((await h.post("/api/plugin/commands/poll", { protocolVersion: 1, serverId: "wrong", sessionId: "wrong" },
    { "X-SPlayer-Live-Protocol": "1" })).status, 409);
});

test("无结果明确失败并继续处理下一条，不挑选替补曲目", async (t) => {
  const h = await harness(t, { search: async (args, first) => ({ tracks: args.query === "空" ? [] : [first] }) });
  await h.post("/api/requests/add", { query: "空" });
  await h.post("/api/requests/add", { query: "有效" });
  await until(() => h.requests.snapshot().history.length === 2);
  assert.deepEqual(h.requests.snapshot().history.map((item) => item.status), ["failed", "added"]);
  assert.equal(h.calls.filter((item) => item.method === "append").length, 1);
});

test("入队调用失败视为结果不确定，阻止自动重放和后续入队", async (t) => {
  const h = await harness(t, { append: async (added, tracks) => {
    tracks.push(...added); // Host may have acted before its reply was lost.
    throw new Error("宿主回包丢失");
  } });
  await h.post("/api/requests/add", { query: "第一首" });
  await h.post("/api/requests/add", { query: "第二首" });
  await until(() => h.requests.snapshot().history.length === 1);
  assert.equal(h.requests.snapshot().history[0].status, "unconfirmed");
  assert.ok(h.requests.snapshot().blocked);
  await delay(1600);
  assert.equal(h.calls.filter((item) => item.method === "append").length, 1);
  assert.equal(h.requests.snapshot().pending.length, 1);
});

test("搜索期间关闭点歌，不再向播放器添加", async (t) => {
  let release;
  const gate = new Promise((resolve) => { release = resolve; });
  const h = await harness(t, { search: async (_, first) => { await gate; return { tracks: [first] }; } });
  await h.post("/api/requests/add", { query: "停止" });
  await until(() => h.calls.some((call) => call.method === "search"));
  await h.post("/api/requests/config", { ...config, enabled: false });
  release();
  await until(() => h.requests.snapshot().history.length === 1);
  assert.equal(h.requests.snapshot().history[0].status, "failed");
  assert.equal(h.calls.filter((item) => item.method === "append").length, 0);
});

test("搜索期间命令过期，迟到的搜索结果不能入队", async (t) => {
  let release;
  const gate = new Promise((resolve) => { release = resolve; });
  const h = await harness(t, { leaseMs: 150, search: async (_, first) => { await gate; return { tracks: [first] }; } });
  await h.post("/api/requests/add", { query: "迟到搜索" });
  await until(() => h.calls.some((call) => call.method === "search"));
  await delay(250);
  h.requests.expire();
  release();
  await delay(1300);
  assert.equal(h.requests.snapshot().history[0].status, "expired");
  assert.equal(h.calls.filter((item) => item.method === "append").length, 0);
});

test("后台只预放一首；暂停和无关切歌不推进，确认开始播放才安排后续点歌", async (t) => {
  const h = await harness(t, {
    initialTracks: (original) => [original, mockTrack("idle-2", "普通歌单 2"), mockTrack("idle-3", "普通歌单 3")],
    search: async ({ query }) => ({ tracks: [{ ...mockTrack(query, query), source: "netease" }] }),
  });
  for (const query of ["A", "B", "C"]) await h.post("/api/requests/add", { query });
  await until(() => h.requests.snapshot().scheduled?.track.id === "A");
  await delay(1000);
  assert.equal(h.calls.filter((call) => call.method === "append").length, 1);
  assert.deepEqual(h.tracks.map((track) => track.id), ["original", "A", "idle-2", "idle-3"]);
  h.setPlaying(1, "paused");
  await delay(1000);
  assert.equal(h.requests.snapshot().pending.length, 2);
  h.setPlaying(1);
  await until(() => h.requests.snapshot().scheduled?.track.id === "B");
  assert.deepEqual(h.tracks.map((track) => track.id), ["original", "A", "B", "idle-2", "idle-3"]);
  assert.equal(h.requests.snapshot().playing.track.id, "A");
  h.setPlaying(0); // Manual navigation doesn't prove B has started.
  await delay(1000);
  assert.equal(h.requests.snapshot().pending.length, 1);
  h.setPlaying(2);
  await until(() => h.requests.snapshot().scheduled?.track.id === "C");
  h.setPlaying(3);
  await until(() => h.requests.snapshot().playing?.track.id === "C");
  assert.equal(h.requests.snapshot().scheduled, null);
  assert.equal(h.requests.snapshot().pending.length, 0);
  assert.equal(h.calls.filter((call) => call.method === "append").length, 3);
  assert.ok(h.calls.filter((call) => call.method === "append").every((call) => call.position === "next"));
});

test("469 首随机列表中的已有歌曲明确跳过，不调用入队也不阻塞后续点歌", async (t) => {
  const h = await harness(t, { shuffle: "on",
    initialTracks: (original, first) => [original, ...Array.from({ length: 468 }, (_, i) =>
      i === 430 ? first : mockTrack(`idle-${i}`, `普通歌曲 ${i}`))],
    search: async ({ query }, first) => ({ tracks: [query === "已有" ? first : { ...first, id: "new" }] }),
  });
  await h.post("/api/requests/add", { query: "已有" });
  await h.post("/api/requests/add", { query: "新增" });
  await until(() => h.requests.snapshot().history.length === 2);
  const state = h.requests.snapshot();
  assert.deepEqual(state.history.map((entry) => entry.status), ["alreadyQueued", "added"]);
  assert.equal(state.history[0].queueCheck.beforeTotal, 469);
  assert.equal(state.history[0].queueCheck.beforeMatches, 1);
  assert.equal(state.blocked, null);
  assert.equal(h.calls.filter((call) => call.method === "append").length, 1);
  assert.equal(h.tracks[1].id, "new");
  assert.equal(h.tracks.length, 470);
});

test("新曲放到下一首且其他曲目重排时仍能核对；只读取队列重试", async (t) => {
  const h = await harness(t, {
    initialTracks: (original) => [original, ...Array.from({ length: 220 }, (_, i) => mockTrack(`idle-${i}`, "普通歌单"))],
    append: async (added, tracks) => {
      const rest = tracks.splice(1).reverse();
      tracks.push(...added, ...rest);
      return { count: 1 };
    },
  });
  await h.post("/api/requests/add", { query: "新歌" });
  await until(() => h.requests.snapshot().history.length === 1);
  assert.equal(h.requests.snapshot().history[0].status, "added");
  assert.equal(h.requests.snapshot().history[0].queueCheck.afterMatches, 1);
  assert.equal(h.calls.filter((call) => call.method === "append").length, 1);
});

test("宿主只确认收到请求或插到错误位置，不能误报已安排下一首", async (t) => {
  for (const insert of [false, true]) {
    const h = await harness(t, {
      initialTracks: (original) => [original, mockTrack("idle", "原本的下一首")],
      append: async (added, tracks) => { if (insert) tracks.push(...added); return { count: 1 }; },
    });
    await h.post("/api/requests/add", { query: "未确认" });
    await until(() => h.requests.snapshot().history.length === 1);
    const state = h.requests.snapshot();
    assert.equal(state.history[0].status, "unconfirmed");
    assert.equal(state.history[0].requestAccepted, true);
    assert.ok(state.blocked);
    assert.equal(h.calls.filter((call) => call.method === "append").length, 1);
  }
});

test("不完整的队列页在提交前失败，不会凭截断列表再次入队", async (t) => {
  const h = await harness(t, { queueRead: ({ offset }, tracks, currentIndex) =>
    ({ tracks: [], total: tracks.length, currentIndex, offset }) });
  await h.post("/api/requests/add", { query: "截断页" });
  await until(() => h.requests.snapshot().history.length === 1);
  assert.equal(h.requests.snapshot().history[0].status, "failed");
  assert.equal(h.requests.snapshot().blocked, null);
  assert.equal(h.calls.filter((call) => call.method === "append").length, 0);
});

test("待播管理：旧插件不领取、播放先于回报不漏推进、失联不派发、手动解除不重放", () => {
  let now = 100;
  const q = createRequests({ now: () => now });
  q.configure(config); playback(q);
  q.enqueue("第一首"); q.enqueue("第二首");
  assert.equal(q.poll({ ...transport, schedulerVersion: undefined }), null);
  const first = q.poll(transport);
  assert.equal(first.position, "next");
  playback(q, mockTrack("one", "第一首")); // A fast track can start before the report arrives.
  q.report({ ...transport, ...first, status: "added", track: mockTrack("one", "第一首") });
  assert.equal(q.snapshot().scheduled, null);
  assert.equal(q.snapshot().playing.track.id, "one");
  now += 6001;
  assert.equal(q.poll(transport), null);
  playback(q, mockTrack("one", "第一首"));
  const second = q.poll(transport);
  q.report({ ...transport, ...second, status: "added", track: mockTrack("two", "第二首") });
  q.enqueue("第三首");
  q.configure({ ...config, enabled: false });
  assert.throws(() => q.releaseScheduled(first.commandId), /已变化/);
  q.releaseScheduled(second.commandId);
  assert.equal(q.snapshot().scheduled, null);
  assert.equal(q.snapshot().history[1].releasedAt, now);
  assert.equal(q.poll(transport), null);
  q.configure(config);
  assert.equal(q.poll(transport).args.query, "第三首");
});

test("已安排待播项跨插件会话保留，新会话确认播放后才能继续", () => {
  const q = createRequests();
  q.configure(config); playback(q);
  q.enqueue("A"); q.enqueue("B");
  const first = q.poll(transport), track = mockTrack("one", "A");
  q.report({ ...transport, ...first, status: "added", track });
  q.sessionChanged("replacement");
  const replacement = { ...transport, sessionId: "replacement" };
  q.observePlayback({ sessionId: replacement.sessionId, track: mockTrack("idle", "普通歌单"), state: "playing" });
  assert.equal(q.poll(replacement), null);
  assert.equal(q.snapshot().scheduled.commandId, first.commandId);
  q.observePlayback({ sessionId: replacement.sessionId, track, state: "playing" });
  assert.equal(q.snapshot().scheduled, null);
  assert.equal(q.poll(replacement).args.query, "B");
});
