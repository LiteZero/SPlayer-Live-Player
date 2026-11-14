import {
  VERSION, DEFAULT_ORIGIN, SAMPLE_MS, MAX_ANCHOR_AGE_MS, MAX_BODY_BYTES, MAX_TRACE_BATCH,
  trackKey, clamp, coverUrl, validDocument,
} from "../shared/protocol.mjs";
import { startRequests } from "./requests.js";

const events = ["trackChange", "lyricChange", "lineChange", "playStateChange"];
splayer.register({
  events,
  controls: true,
  settings: [{ key: "backend", type: "text", label: "本地服务地址", default: DEFAULT_ORIGIN }],
});

const nonNegative = (value) => Number.isFinite(value) ? Math.max(0, value) : 0;
const asText = (value, limit = 8192) => typeof value === "string" ? value.slice(0, limit) : "";
const span = (value) => {
  const startTime = nonNegative(value?.startTime);
  return { word: asText(value?.word), startTime, endTime: Math.max(startTime, nonNegative(value?.endTime)) };
};
const normalizeTrack = (track) => track?.id && track.source ? {
  id: String(track.id).slice(0, 1024), source: String(track.source).slice(0, 160),
  title: asText(track.title, 2048), durationMs: nonNegative(track.duration),
  artists: Array.isArray(track.artists) ? track.artists.slice(0, 100).map((a) => asText(a?.name, 1024)) : [],
  coverUrl: track.source === "streaming" ? undefined : coverUrl(track.cover) ?? coverUrl(track.coverOriginal),
} : null;
const normalizeLines = (lines) => lines.map((line) => {
  if (!line || !Number.isFinite(line.startTime) || !Array.isArray(line.words)) {
    throw new Error("不支持的宿主歌词结构");
  }
  const startTime = nonNegative(line.startTime);
  return {
    startTime, endTime: Math.max(startTime, nonNegative(line.endTime)),
    translatedLyric: asText(line.translatedLyric), romanLyric: asText(line.romanLyric),
    isBG: line.isBG === true, isDuet: line.isDuet === true,
    ...(typeof line.language === "string" ? { language: asText(line.language, 40) } : {}),
    words: line.words.map((word) => ({
      ...span(word),
      ...(typeof word?.romanWord === "string" ? { romanWord: asText(word.romanWord) } : {}),
      ...(typeof word?.obscene === "boolean" ? { obscene: word.obscene } : {}),
      ...(Array.isArray(word?.ruby) ? { ruby: word.ruby.map(span) } : {}),
    })),
  };
});

function start() {
  const startedAt = Date.now();
  const session = {
    protocolVersion: VERSION, startedAt,
    sessionId: `splayer-${startedAt}-${Math.random().toString(36).slice(2)}`,
    apiLevel: splayer.apiLevel, appVersion: String(splayer.appVersion ?? ""),
  };
  let doc = { trackRevision: 1, lyricRevision: 1, track: null, lyricStatus: "none", lines: [] };
  let eventKey;
  let candidate = null;
  let fence = 0;
  let trackSeenAt = startedAt;
  let lyricsJson = "";
  let previousSample;
  let previousHostLyrics;
  let timer;
  let running = false;
  let urgent = false;
  let failures = 0;
  let origin;
  let serverId;
  let seq = 0;
  let ackRevision = 0;
  let traceAck = 0;
  let traceSeq = 0;
  const trace = [];

  function record(event, detail, key = trackKey(doc.track)) {
    trace.push({ n: ++traceSeq, elapsedMs: Math.max(0, Date.now() - startedAt), event,
      track: key?.slice(0, 1200) ?? null, ...(detail ? { detail: String(detail).slice(0, 300) } : {}) });
    if (trace.length > MAX_TRACE_BATCH) trace.shift();
  }

  function schedule(delay = 0) {
    if (running) { urgent = true; return; }
    clearTimeout(timer);
    timer = setTimeout(tick, delay);
  }

  function wake() {
    if (!failures) schedule();
  }

  function setTrack(track, force = false) {
    if (!force && trackKey(doc.track) === trackKey(track)) return;
    trackSeenAt = Date.now();
    lyricsJson = "";
    previousSample = previousHostLyrics = undefined;
    doc = {
      trackRevision: doc.trackRevision + 1, lyricRevision: doc.lyricRevision + 1,
      track, lyricStatus: track ? "waiting" : "none", lines: [],
    };
  }

  function setLyrics(status, lines = [], json = "") {
    if (doc.lyricStatus === status && lyricsJson === json) return;
    doc = { ...doc, lyricRevision: doc.lyricRevision + 1, lyricStatus: status, lines };
    lyricsJson = json;
    record("lyricStatus", `${status}, lines=${lines.length}`);
  }

  splayer.player.on("trackChange", ({ track } = {}) => {
    const next = normalizeTrack(track);
    const key = trackKey(next);
    record("trackChange", undefined, key);
    if (eventKey !== key) {
      eventKey = key;
      candidate = null;
      ++fence;
      setTrack(next, true);
    }
    wake();
  });
  splayer.player.on("lyricChange", ({ lines } = {}) => {
    ++fence;
    candidate = eventKey != null && Array.isArray(lines)
      ? { key: eventKey, raw: lines, receivedAt: Date.now() } : null;
    record("lyricChange", Array.isArray(lines)
      ? `lines=${lines.length}, firstWords=${lines[0]?.words?.length ?? 0}, firstStartMs=${lines[0]?.startTime ?? "-"}`
      : "invalid payload", eventKey ?? null);
    wake();
  });
  splayer.player.on("lineChange", ({ index, position } = {}) => {
    record("lineChange", `index=${index}, positionMs=${position}`);
    // 按固定周期取完整锚点，逐行事件只作为归属与时间诊断。
  });
  splayer.player.on("playStateChange", ({ state, position } = {}) => {
    record("playStateChange", `state=${state}, positionMs=${position}`);
    wake();
  });
  splayer.onSettingChange("backend", () => schedule());

  function backendOrigin() {
    const address = new URL(String(splayer.getSetting("backend") || DEFAULT_ORIGIN));
    if (address.protocol !== "http:" || address.hostname !== "127.0.0.1" || address.pathname !== "/" ||
        address.username || address.password || address.search || address.hash) {
      throw new Error("歌词后端地址必须是 http://127.0.0.1:端口");
    }
    return address.origin;
  }

  async function post(path, payload, maxBytes = MAX_BODY_BYTES) {
    const body = JSON.stringify(payload);
    if (Buffer.byteLength(body, "utf8") > maxBytes) throw new Error("歌词上传超过 2 MiB");
    return splayer.request(origin + path, {
      method: "POST", headers: { "Content-Type": "application/json", "X-SPlayer-Live-Protocol": String(VERSION) },
      body, responseType: "json", timeout: 1500,
    });
  }

  function observe(now, receivedAt) {
    const next = normalizeTrack(now.track);
    const key = trackKey(next);
    if (key !== trackKey(doc.track)) {
      // 查询可能先于 trackChange 回调；保留事件边界，绝不挪用旧候选。
      candidate = null;
      setTrack(next);
      record("queryTrackChange");
    } else if (next?.coverUrl && !doc.track.coverUrl) {
      // Some hosts fill the artwork after the initial track event.
      doc = { ...doc, track: { ...doc.track, coverUrl: next.coverUrl }, lyricRevision: doc.lyricRevision + 1 };
    }
    const count = now.lyricLineCount;
    const hostLyrics = `available=${now.lyricAvailable}, lines=${count}`;
    if (hostLyrics !== previousHostLyrics) record("queryLyrics", hostLyrics);
    previousHostLyrics = hostLyrics;
    if (next && eventKey === key && candidate?.key === key && now.lyricAvailable === true &&
        count > 0 && candidate.raw.length === count && candidate.receivedAt >= trackSeenAt) {
      if (!candidate.checked) {
        candidate.checked = true;
        try {
          const lines = normalizeLines(candidate.raw);
          const json = JSON.stringify(lines);
          if (Buffer.byteLength(json, "utf8") > MAX_BODY_BYTES - 96 * 1024) throw new Error("歌词正文超过上传上限");
          if (!validDocument({ ...doc, lyricStatus: "ready", lines })) throw new Error("歌词结构校验失败");
          setLyrics("ready", lines, json);
        } catch (error) {
          setLyrics("waiting");
          record("lyricRejected", error?.message);
        }
      }
    } else if (next && now.lyricAvailable === false && count === 0) {
      // 区分切歌加载中的短暂空白和已经观察到的空歌词。
      setLyrics(receivedAt - trackSeenAt >= 800 ? "none" : "waiting");
      if (candidate?.checked) candidate = null;
    } else if (next) {
      setLyrics("waiting");
      if (candidate?.checked) candidate = null;
    }

    const state = now.state === "playing" || now.state === "paused" ? now.state : "stopped";
    const positionMs = nonNegative(now.position);
    const speed = Number.isFinite(now.speed) && now.speed > 0 ? clamp(now.speed, 0.01, 16) : 1;
    const lyricOffsetMs = Number.isFinite(now.lyricOffsetMs) ? clamp(now.lyricOffsetMs, -60000, 60000) : 0;
    const ageMs = state === "playing" && Number.isFinite(now.sendTimestamp)
      ? clamp(receivedAt - now.sendTimestamp, 0, MAX_ANCHOR_AGE_MS) : 0;
    const sample = { trackRevision: doc.trackRevision, lyricRevision: doc.lyricRevision,
      state: next ? state : "stopped", positionMs, speed, lyricOffsetMs, ageMs };
    const last = previousSample;
    const expected = last?.state === "playing" ? (receivedAt - last.receivedAt) * last.speed : 0;
    if (!last || sample.state !== last.state || speed !== last.speed || lyricOffsetMs !== last.lyricOffsetMs ||
        Math.abs(positionMs - (last.positionMs + expected)) > 850) {
      record("queryPlayback", `state=${now.state}, positionMs=${positionMs}, speed=${speed}, offsetMs=${lyricOffsetMs}, ageMs=${ageMs}`);
    }
    previousSample = { ...sample, receivedAt };
    return sample;
  }

  async function tick() {
    running = true;
    urgent = false;
    const tickAt = Date.now();
    try {
      const address = backendOrigin();
      if (address !== origin) {
        origin = address;
        serverId = undefined;
      }
      if (!serverId) {
        const res = await post("/api/plugin/session", session);
        if (res.status !== 200 || typeof res.body?.serverId !== "string") {
          throw new Error(`歌词会话：${res.body?.code ?? res.status}`);
        }
        serverId = res.body.serverId;
        ackRevision = traceAck = 0;
        record("sessionReady");
      }
      const before = fence;
      const now = await splayer.player.getNowPlaying();
      const receivedAt = Date.now();
      if (before !== fence) {
        urgent = true;
        return;
      }
      const playback = observe(now, receivedAt);
      const full = ackRevision !== doc.lyricRevision;
      const batch = trace.filter((entry) => entry.n > traceAck);
      const res = await post("/api/plugin/push", {
        protocolVersion: VERSION, serverId, sessionId: session.sessionId, seq: ++seq,
        kind: full ? "document" : "sample", playback,
        ...(full ? { document: doc } : {}),
        ...(batch.length ? { trace: batch } : {}),
      });
      if (res.status === 409 && res.body?.code === "session_required") {
        serverId = undefined;
        urgent = true;
        failures = 0;
        return;
      }
      if (res.status === 409 && res.body?.code === "snapshot_required") {
        ackRevision = 0;
        urgent = true;
        failures = 0;
        return;
      }
      if (res.status !== 200 || res.body?.ok !== true) throw new Error(`歌词上传：${res.body?.code ?? res.status}`);
      ackRevision = playback.lyricRevision;
      if (batch.length) traceAck = batch.at(-1).n;
      if (failures) splayer.log.info("歌词后端已恢复连接");
      failures = 0;
    } catch (error) {
      if (!failures) {
        record("collectorError", error?.message);
        splayer.log.warn(`歌词采集：${error?.message ?? error}`);
      }
      ++failures;
    } finally {
      running = false;
      schedule(failures ? Math.min(4000, SAMPLE_MS * 2 ** Math.min(failures, 4))
        : urgent ? 0 : Math.max(0, SAMPLE_MS - (Date.now() - tickAt)));
    }
  }

  record("enabled", `app=${session.appVersion}, api=${session.apiLevel}`);
  startRequests(() => serverId && origin === backendOrigin()
    ? { origin, serverId, sessionId: session.sessionId } : null);
  schedule();
}

if (splayer.apiLevel >= 4 && typeof splayer.player.getNowPlaying === "function") start();
else splayer.log.error("歌词采集需要 SPlayer 插件 API 4 或以上");
