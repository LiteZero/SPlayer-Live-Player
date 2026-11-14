import assert from "node:assert/strict";
import { once } from "node:events";
import { mkdtemp, rm, rmdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { test } from "node:test";
import { WebSocket } from "ws";
import { createApp } from "../backend/server.mjs";
import { line, mockTrack, startMockHost } from "../scripts/mock-host.mjs";
import { VERSION } from "../shared/protocol.mjs";
import { applyFrame } from "../web/client.mjs";
import { clockAt, findLine, foregroundTimeline } from "../web/clock.mjs";
import { createDisplay } from "../web/renderers.mjs";

async function listen(options, port = 0) {
  const app = createApp(options);
  app.server.listen(port, "127.0.0.1");
  await once(app.server, "listening");
  return {
    port: app.server.address().port,
    origin: `http://127.0.0.1:${app.server.address().port}`,
    close: () => new Promise((resolve) => app.close(resolve)),
  };
}

async function waitFor(check, timeout = 5000) {
  const until = performance.now() + timeout;
  while (performance.now() < until) {
    const result = await check();
    if (result) return result;
    await delay(20);
  }
  assert.fail("等待测试条件超时");
}

function openStream(origin) {
  const socket = new WebSocket(origin.replace(/^http/, "ws") + "/ws", { origin });
  const frames = [];
  socket.on("message", (data) => frames.push(JSON.parse(data.toString())));
  return { socket, frames, next: () => waitFor(() => frames.shift()) };
}

const session = (sessionId, startedAt) => ({
  protocolVersion: VERSION, sessionId, startedAt, appVersion: "1.2.0", apiLevel: 5,
});
const document = {
  trackRevision: 1, lyricRevision: 1,
  track: { id: "a", source: "local", title: "A", artists: [], durationMs: 30000 },
  lyricStatus: "ready", lines: [
    line("甲", 1000, { translatedLyric: "", romanLyric: "", isBG: false, isDuet: false }),
    line("乙", 3000, { translatedLyric: "", romanLyric: "", isBG: false, isDuet: false }),
  ],
};
const playback = {
  trackRevision: 1, lyricRevision: 1, state: "playing", positionMs: 800,
  speed: 2, lyricOffsetMs: 100, ageMs: 25,
};

test("HTTP 和 WebSocket 快照、增量、刷新、过期、会话接管及乱序保护", async (t) => {
  const app = await listen({ staleMs: 700 });
  t.after(app.close);
  const post = async (route, value) => {
    const response = await fetch(app.origin + "/api/plugin/" + route, {
      method: "POST", body: JSON.stringify(value),
      headers: { "Content-Type": "application/json", "X-SPlayer-Live-Protocol": String(VERSION) },
    });
    return { status: response.status, ...await response.json() };
  };
  const initial = openStream(app.origin);
  let current = applyFrame(null, await initial.next());
  assert.equal(current.document, null);
  const old = session("old", 1);
  const { serverId } = await post("session", old);
  current = applyFrame(current, await initial.next());
  const envelope = { protocolVersion: VERSION, serverId, sessionId: old.sessionId };
  const full = { ...envelope, seq: 1, kind: "document", document, playback };
  assert.equal((await post("push", full)).status, 200);
  current = applyFrame(current, await initial.next());
  assert.deepEqual(current.document, document);

  const sample = { ...envelope, seq: 2, kind: "sample", playback: { ...playback, positionMs: 1200 } };
  assert.equal((await post("push", sample)).status, 200);
  const update = await initial.next();
  assert.equal(Object.hasOwn(update, "document"), false);
  assert.equal(applyFrame(current, { ...update, serial: update.serial + 1 }), null);
  assert.equal(applyFrame(current, { ...update, serverId: "restart" }), null);
  assert.equal(applyFrame(current, { ...update, playback: { ...update.playback, lyricRevision: 9 } }), null);
  current = applyFrame(current, update);
  assert.equal(current.playback.positionMs, 1200);
  assert.equal((await post("push", full)).code, "stale_seq");
  assert.equal((await post("push", { ...sample, seq: 3, playback: { ...playback, lyricRevision: 9 } })).code, "snapshot_required");

  initial.socket.close();
  const refreshed = openStream(app.origin);
  const refreshedState = applyFrame(null, await refreshed.next());
  assert.deepEqual(refreshedState.document, document);
  assert.equal(refreshedState.playback.positionMs, 1200);
  const expired = applyFrame(refreshedState, await refreshed.next());
  assert.equal(expired.document, null);
  assert.equal((await post("push", { ...sample, seq: 3 })).code, "snapshot_required");
  assert.equal((await post("push", { ...full, seq: 4 })).status, 200);
  assert.equal((await post("session", session("new", 2))).status, 200);
  assert.equal((await post("session", old)).code, "stale_session");
  assert.equal((await post("push", { ...full, seq: 5 })).code, "stale_session");
  assert.equal((await post("push", { ...full, serverId: "previous-boot", seq: 6 })).code, "session_required");
});

test("编译后的插件丢弃切歌中的查询和未匹配歌词，后端重启后自动重送全文", async (t) => {
  let app = await listen();
  t.after(() => app.close());
  const a = mockTrack("a", "A"), b = mockTrack("b", "B"), c = mockTrack("c", "C");
  const lyricsA = [line("A1", 0), line("A2", 5000)];
  const lyricsB = [line("B1", 0)];
  const lyricsC = [line("C1", 0, { translatedLyric: "译文", isDuet: true, language: "ja" }), line("C2", 2000)];
  let data = { track: a, lyrics: lyricsA, position: 900, state: "paused", offset: 0 };
  let pendingRead;
  let intercepted = false;
  const uploaded = [];
  const host = startMockHost({
    origin: app.origin,
    log: { info() {}, warn() {}, error: assert.fail },
    read() {
      const result = { track: data.track, position: data.position, state: data.state, speed: 1,
        lyricOffsetMs: data.offset, lyricAvailable: !!data.lyrics.length,
        lyricLineCount: data.lyrics.length, sendTimestamp: Date.now() };
      if (pendingRead) {
        const gate = pendingRead;
        pendingRead = undefined;
        intercepted = true;
        return gate.then(() => result);
      }
      return Promise.resolve(result);
    },
    request(url, options) {
      if (url.endsWith("/push")) uploaded.push(JSON.parse(options.body));
      return fetch(url, options);
    },
  });
  t.after(() => host.stop());
  const status = async () => (await fetch(app.origin + "/api/status", { headers: { Connection: "close" } })).json();
  const song = (track, lines) => {
    host.emit("trackChange", { track });
    host.emit("lyricChange", { lines });
  };
  song(a, lyricsA);
  await waitFor(async () => (await status()).status === "lyric_ready");
  await waitFor(async () => (await status()).metrics.samples > 0);
  assert.equal(uploaded.filter((entry) => entry.document).length, 1);

  let release;
  pendingRead = new Promise((resolve) => { release = resolve; });
  await waitFor(() => intercepted);
  const beforeSwitch = uploaded.length;
  data = { track: b, lyrics: lyricsB, state: "paused", position: 0, offset: 0 };
  song(b, lyricsA); // 两行旧歌词与新曲的单行轻量快照不相符。
  release();
  await waitFor(async () => {
    const value = await status();
    return value.track?.id === "b" && value.status === "lyric_waiting";
  });
  data = { track: c, lyrics: lyricsC, state: "paused", position: 6000, offset: 100 };
  song(c, lyricsC);
  const current = await waitFor(async () => {
    const value = await status();
    return value.track?.id === "c" && value.status === "lyric_ready" && value;
  });
  assert.equal(current.playback.positionMs, 6000);
  assert.equal(current.playback.lyricOffsetMs, 100);
  assert.ok(uploaded.slice(beforeSwitch).every((entry) => entry.playback.trackRevision > uploaded[0].playback.trackRevision));
  const cDocument = uploaded.find((entry) => entry.document?.track?.id === "c").document;
  assert.deepEqual(cDocument.lines[0].words, lyricsC[0].words);
  assert.equal(cDocument.lines[0].translatedLyric, "译文");

  // Artwork can arrive after the track/lyrics events; its update must retain the lyric document.
  data.track = { ...c, cover: "file:///private/art.jpg", coverOriginal: "https://art.example/track-c.png" };
  const withCover = await waitFor(async () => {
    const value = await status();
    return value.track?.coverUrl && value;
  });
  assert.equal(withCover.track.coverUrl, "https://art.example/track-c.png");
  const coverUpdate = uploaded.find((entry) => entry.document?.track?.coverUrl).document;
  assert.equal(coverUpdate.trackRevision, cDocument.trackRevision);
  assert.deepEqual(coverUpdate.lines, cDocument.lines);

  const port = app.port;
  await app.close();
  app = await listen(undefined, port);
  const resumed = await waitFor(async () => {
    const value = await status().catch((error) => {
      if (["ECONNRESET", "ECONNREFUSED"].includes(error.cause?.code)) return null;
      throw error;
    });
    return value?.status === "lyric_ready" && value;
  });
  assert.notEqual(resumed.serverId, current.serverId);
  assert.equal(resumed.track.id, "c");
  assert.equal(resumed.track.coverUrl, withCover.track.coverUrl);
  assert.equal(resumed.metrics.documents, 1);
  host.stop();
  await waitFor(async () => (await status()).status === "host_disconnected");
});

test("统一时钟应用正偏移一次，按倍率前进；暂停、向后跳转和过期分别处理", () => {
  const sample = { ...playback, heldMs: 25, remainingMs: 3000 };
  const timeline = foregroundTimeline([...document.lines, line("和声", 2500, { isBG: true })]);
  const initial = clockAt(document, sample, 10, 10);
  assert.equal(initial.positionMs, 900);
  assert.equal(initial.lyricTimeMs, 1000);
  assert.deepEqual(findLine(timeline, initial.lyricTimeMs), { index: 0, nextChangeMs: 3000 });
  assert.equal(findLine(timeline, clockAt(document, sample, 10, 1010).lyricTimeMs).index, 1);
  const paused = { ...sample, state: "paused", positionMs: 3500 };
  assert.equal(clockAt(document, paused, 10, 1010).positionMs, 3500);
  assert.equal(findLine(timeline, clockAt(document, { ...paused, positionMs: 0 }, 10, 1010).lyricTimeMs).index, -1);
  assert.equal(clockAt(document, paused, 10, 3010), null);
});

test("首句前留空，末句按结束时间退出，背景行不改变结束边界", () => {
  const timeline = foregroundTimeline([
    line("末句", 5000, { endTime: 6500 }),
    line("首句", 1000),
    line("和声", 7000, { isBG: true }),
    line(" ", 8000),
  ]);
  assert.deepEqual(findLine(timeline, 999), { index: -1, nextChangeMs: 1000 });
  assert.deepEqual(findLine(timeline, 4500), { index: 1, nextChangeMs: 5000 });
  assert.deepEqual(findLine(timeline, 6499), { index: 0, nextChangeMs: 6500 });
  assert.deepEqual(findLine(timeline, 6500), { index: -1, nextChangeMs: Infinity });

  const withoutLineEnd = foregroundTimeline([line("逐字时间", 1000, { endTime: 1000 })]);
  assert.deepEqual(findLine(withoutLineEnd, 1000), { index: 0, nextChangeMs: 3000 });
  const startOnly = line("仅有起点", 1000, { endTime: 1000, words: [{ word: "仅有起点", startTime: 1000, endTime: 1000 }] });
  const untimedEnd = foregroundTimeline([startOnly]);
  assert.deepEqual(findLine(untimedEnd, 15000), { index: 0, nextChangeMs: Infinity });
  const markedEnd = foregroundTimeline([startOnly, line("", 3000)]);
  assert.deepEqual(findLine(markedEnd, 2999), { index: 0, nextChangeMs: 3000 });
  assert.deepEqual(findLine(markedEnd, 3000), { index: -1, nextChangeMs: Infinity });
});

test("切歌中的停止采样保留状态信号，断连立即清空输出", (t) => {
  const seen = [];
  const display = createDisplay({ replaceChildren() {} }, { onTrack: (...args) => seen.push(args) });
  t.after(() => display.dispose());
  const sample = { ...playback, heldMs: 0, remainingMs: 3000 };
  const next = { ...document, track: { ...document.track, id: "b", title: "B" } };
  display.setState({ document, playback: sample });
  display.setState({ document, playback: { ...sample, state: "stopped" } });
  display.setState({ document: next, playback: { ...sample, state: "stopped" } });
  display.setState({ document: next, playback: sample });
  display.setState(null);
  assert.deepEqual(seen, [
    [document.track, "playing"],
    [null, "stopped"],
    [null, "stopped"],
    [next.track, "playing"],
    [null, undefined],
  ]);
});

test("自定义 CSS 保存后通知现有输出页，重启保留，清空后恢复默认", async (t) => {
  const dir = await mkdtemp(join(tmpdir(), "splayer-style-test-"));
  const cssPath = join(dir, "obs-custom.css");
  let app = await listen({ cssPath });
  t.after(async () => {
    await app.close();
    await rm(cssPath, { force: true });
    await rmdir(dir);
  });
  const fetchCss = () => fetch(app.origin + "/obs-custom.css", { headers: { Connection: "close" } });
  const saveCss = (css, origin = app.origin) => fetch(app.origin + "/api/style", {
    method: "PUT", body: JSON.stringify({ css }),
    headers: { "Content-Type": "application/json", Origin: origin, Connection: "close" },
  });
  const css = ".lyric-original { color: #c4ff72; }";
  const stream = openStream(app.origin);
  let current = applyFrame(null, await stream.next());
  assert.equal(await (await fetchCss()).text(), "");
  assert.equal((await saveCss(css, "https://other.example")).status, 403);
  assert.equal((await saveCss("词".repeat(23000))).status, 413);
  assert.equal((await saveCss(css)).status, 200);
  current = applyFrame(current, await stream.next());
  assert.equal(current.styleRevision, 1);
  assert.equal(current.document, null);
  const stylesheet = await fetchCss();
  assert.match(stylesheet.headers.get("content-type"), /^text\/css\b/);
  assert.equal(await stylesheet.text(), css);

  await app.close();
  app = await listen({ cssPath });
  assert.equal(await (await fetchCss()).text(), css);
  assert.equal((await saveCss("")).status, 200);
  assert.equal(await (await fetchCss()).text(), "");
});

test("布局与自定义 CSS 独立保存、通知现有输出页，重启后读取布局", async (t) => {
  const dir = await mkdtemp(join(tmpdir(), "splayer-layout-test-"));
  const options = { layoutPath: join(dir, "layout.json"), cssPath: join(dir, "custom.css") };
  let app = await listen(options);
  t.after(async () => {
    await app.close();
    await rm(options.layoutPath, { force: true });
    await rm(options.cssPath, { force: true });
    await rmdir(dir);
  });
  const save = (name, body) => fetch(app.origin + "/api/" + name, {
    method: "PUT", headers: { "Content-Type": "application/json", Connection: "close" }, body: JSON.stringify(body),
  });
  const read = async () => (await fetch(app.origin + "/api/layout", { headers: { Connection: "close" } })).json();
  const stream = openStream(app.origin);
  assert.equal((await stream.next()).styleRevision, 0);
  assert.deepEqual((await read()).card, { scale: 100, x: 0, y: 0 });
  assert.equal((await save("layout", { title: { x: 101 } })).status, 400);
  assert.equal((await save("layout", { unknown: { x: 0 } })).status, 400);

  const css = ".lyric-original { color: #ffcc88; }";
  const draft = { card: { scale: 125, x: -6 }, translation: { y: 8 } };
  const [layoutResponse, cssResponse] = await Promise.all([save("layout", draft), save("style", { css })]);
  assert.equal(layoutResponse.status, 200);
  assert.equal(cssResponse.status, 200);
  assert.equal((await stream.next()).styleRevision, 1);
  assert.equal((await stream.next()).styleRevision, 2);
  const saved = await layoutResponse.json();
  assert.deepEqual(saved.card, { scale: 125, x: -6, y: 0 });
  assert.deepEqual(saved.translation, { scale: 100, x: 0, y: 8 });
  assert.equal((await save("layout", draft)).status, 200);
  const snapshot = openStream(app.origin);
  assert.equal((await snapshot.next()).styleRevision, 2);

  const port = app.port;
  await app.close();
  app = await listen(options, port);
  assert.deepEqual(await read(), saved);
  assert.equal(await (await fetch(app.origin + "/obs-custom.css")).text(), css);
  assert.equal((await save("layout", {})).status, 200);
  assert.deepEqual((await read()).card, { scale: 100, x: 0, y: 0 });
  assert.equal(await (await fetch(app.origin + "/obs-custom.css")).text(), css);
});
