import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import vm from "node:vm";
import { createSongRequestServer } from "./server.mjs";

const source = await readFile(new URL("./splayer-song-request.js", import.meta.url), "utf8");

/** 启动隔离端口，避免测试命令送入真实播放器。 */
async function fixture(t, options) {
  const server = createSongRequestServer(options);
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  t.after(() => {
    server.closeAllConnections();
    server.close();
  });
  async function post(path, body) {
    const response = await fetch(`${base}${path}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    return { status: response.status, body: await response.json() };
  }
  return { base, post };
}

/** 执行实际插件文件，仅替换 SPlayer 接口与定时器。 */
function attachPlugin(t, base, { tracks = [], playError = null, confirms = true } = {}) {
  const calls = { searches: [], played: [], queries: 0 };
  let closed = false;
  const timers = new Set();
  const splayer = {
    apiLevel: 5,
    appVersion: "test-host",
    register() {},
    getSetting: (key) => key === "backend" ? base : true,
    log: { info() {}, warn() {}, error() {} },
    async request(url, options) {
      const response = await fetch(url, {
        method: options.method,
        headers: options.headers,
        body: options.body,
        signal: AbortSignal.timeout(2000),
      });
      return { status: response.status, body: await response.json() };
    },
    music: {
      async searchOnline(options) {
        calls.searches.push(options);
        return { tracks };
      },
    },
    player: {
      async playTrack(track) {
        calls.played.push(track);
        if (playError) throw new Error(playError);
        return { id: track.id, source: track.source };
      },
      async getNowPlaying() {
        calls.queries++;
        return { track: tracks[0] ?? null, state: confirms ? "playing" : "paused" };
      },
    },
  };
  t.after(() => {
    closed = true;
    for (const timer of timers) clearTimeout(timer);
  });
  vm.runInNewContext(source, {
    splayer,
    URL,
    setTimeout(callback, delay) {
      if (closed) return;
      const timer = setTimeout(() => {
        timers.delete(timer);
        if (!closed) callback();
      }, Math.min(delay, 5));
      timers.add(timer);
      return timer;
    },
  });
  return calls;
}

async function waitResult(base, id) {
  const deadline = Date.now() + 3000;
  while (Date.now() < deadline) {
    const response = await fetch(`${base}/api/commands/${id}`);
    const command = await response.json();
    if (!["queued", "dispatched"].includes(command.status)) return command;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error("测试等待超时");
}

test("经真实 HTTP 后端和插件文件，原样播放搜索第一项并确认状态", async (t) => {
  const { base, post } = await fixture(t);
  const first = {
    id: "first", source: "netease", title: "第一项", artists: [{ name: "歌手" }],
    duration: 1000, plugin: { musicInfo: { opaque: "保留字段" } },
  };
  const second = { ...first, id: "second" };
  const calls = attachPlugin(t, base, { tracks: [first, second] });
  const { body } = await post("/api/commands", {
    type: "requestSong", query: " 测试歌曲 ", platform: "netease",
  });
  const result = await waitResult(base, body.id);
  assert.equal(result.status, "playing");
  assert.equal(result.result.requestAccepted, true);
  assert.equal(calls.played.length, 1);
  assert.strictEqual(calls.played[0], first);
  assert.equal(calls.searches[0].query, "测试歌曲");
  assert.equal(calls.searches[0].page, 1);
  assert.equal(calls.searches[0].limit, 1);
  assert.ok(calls.queries > 0);
});

test("无搜索结果时失败且不调用播放", async (t) => {
  const { base, post } = await fixture(t);
  const calls = attachPlugin(t, base);
  const { body } = await post("/api/commands", {
    type: "requestSong", query: "查无此歌", platform: "qqmusic",
  });
  const result = await waitResult(base, body.id);
  assert.equal(result.status, "failed");
  assert.equal(result.result.phase, "search");
  assert.equal(result.result.requestAccepted, false);
  assert.equal(calls.played.length, 0);
});

test("播放请求成功但宿主未进入 playing，不误报成功或重复播放", async (t) => {
  const { base, post } = await fixture(t);
  const calls = attachPlugin(t, base, {
    tracks: [{ id: "first", source: "kugou", title: "测试" }], confirms: false,
  });
  const { body } = await post("/api/commands", {
    type: "requestSong", query: "测试", platform: "kugou",
  });
  const result = await waitResult(base, body.id);
  assert.equal(result.status, "unconfirmed");
  assert.equal(result.result.requestAccepted, true);
  assert.equal(calls.played.length, 1);
  assert.equal(calls.queries, 20);
});

test("宿主拒绝播放，保留错误与阶段", async (t) => {
  const { base, post } = await fixture(t);
  attachPlugin(t, base, {
    tracks: [{ id: "first", source: "netease", title: "测试" }], playError: "权限不足",
  });
  const { body } = await post("/api/commands", {
    type: "requestSong", query: "测试", platform: "netease",
  });
  const result = await waitResult(base, body.id);
  assert.equal(result.status, "failed");
  assert.equal(result.result.phase, "play");
  assert.equal(result.result.error, "权限不足");
  assert.equal(result.result.requestAccepted, false);
});

test("命令只派发一次，执行中拒绝另一命令和错误会话回报", async (t) => {
  const { post } = await fixture(t);
  const command = { type: "requestSong", query: "测试", platform: "netease" };
  const created = await post("/api/commands", command);
  assert.equal(created.status, 202);
  assert.equal((await post("/api/commands", command)).status, 409);
  const client = { clientId: "test-client", apiLevel: 5, appVersion: "test" };
  const first = await post("/bridge/poll", client);
  assert.equal(first.body.command.id, created.body.id);
  assert.equal((await post("/bridge/poll", client)).body.command, null);
  const report = { id: created.body.id, status: "failed" };
  assert.equal((await post("/bridge/report", { ...report, clientId: "other" })).status, 409);
  assert.equal((await post("/bridge/report", { ...report, clientId: client.clientId })).status, 200);
  assert.equal((await post("/bridge/report", { ...report, clientId: client.clientId })).status, 200);
});

test("拒绝空关键词、未知指令、未知平台和低版本宿主", async (t) => {
  const { post } = await fixture(t);
  const valid = { type: "requestSong", query: "测试", platform: "netease" };
  for (const body of [
    { ...valid, query: " " }, { ...valid, type: "skip" }, { ...valid, platform: "other" },
  ]) assert.equal((await post("/api/commands", body)).status, 400);
  assert.equal((await post("/bridge/poll", { clientId: "old", apiLevel: 3 })).status, 400);
});
