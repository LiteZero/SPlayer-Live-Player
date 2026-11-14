import { randomUUID } from "node:crypto";

export function parseSongRequest(text) {
  return typeof text === "string" ? /^点歌\s+(.+)$/su.exec(text.trim())?.[1]?.trim() || null : null;
}
const platforms = new Set(["netease", "qqmusic", "kugou"]);
export function summarizeTrack(track) {
  if (!track || !["string", "number"].includes(typeof track.id) || typeof track.source !== "string") return null;
  return {
    id: String(track.id).slice(0, 1024), source: track.source.slice(0, 160),
    title: String(track.title ?? "").slice(0, 2048),
    artists: (Array.isArray(track.artists) ? track.artists : []).slice(0, 20)
      .map((artist) => String(typeof artist === "string" ? artist : artist?.name ?? "").slice(0, 200)),
  };
}

/** Keep the audience FIFO here and reserve at most one native "next" slot. */
export function createRequests({ now = Date.now, leaseMs = 45000 } = {}) {
  let config = { enabled: false, platform: "netease", allowAnonymous: false };
  let pending = [], history = [], receipts = [];
  const seen = new Map();
  let active = null, executor = null, native = null, blocked = null;
  let scheduled = null, playing = null, playback = null;
  function receipt(message, outcome, detail, commandId) {
    receipts.push({ at: now(), senderName: message.senderName ?? null, senderUid: message.senderUid ?? null,
      query: parseSongRequest(message.text)?.slice(0, 200), outcome, detail, commandId });
    receipts = receipts.slice(-100);
  }
  function finish(status, extra = {}) {
    if (!active) return;
    const item = { ...active, status, finishedAt: now(), ...extra };
    history.push(item);
    history = history.slice(-100);
    active = null;
    if (["expired", "unconfirmed"].includes(status)) blocked = "上次入队结果不确定，请检查 SPlayer 播放列表，再继续处理。";
    return item;
  }
  const sameTrack = (a, b) => a && b && a.id === b.id && a.source === b.source;
  function advancePlayback() {
    if (!playback) return;
    if (playing && playback.track && !sameTrack(playing.track, playback.track)) {
      playing.endedAt = now();
      playing = null;
    }
    if (playback.state !== "playing") return;
    if (scheduled && playback.at >= scheduled.dispatchedAt && sameTrack(scheduled.track, playback.track)) {
      scheduled.startedAt = now();
      playing = scheduled;
      scheduled = null;
    }
  }
  function expire() {
    if (active && now() >= active.expiresAt) finish("expired", { error: "执行超时；不会自动重试入队" });
  }
  function configure(value) {
    if (typeof value?.enabled !== "boolean" || typeof value.allowAnonymous !== "boolean" || !platforms.has(value.platform)) {
      throw new Error("点歌设置无效");
    }
    config = { enabled: value.enabled, platform: value.platform, allowAnonymous: value.allowAnonymous };
  }
  function enqueue(query, sender = { source: "manual", senderName: "本机手动" }) {
    if (!config.enabled) throw new Error("请先启用点歌处理");
    if (typeof query !== "string" || !query.trim() || query.trim().length > 200) throw new Error("点歌关键词需为 1–200 个字符");
    if (pending.length + (active ? 1 : 0) + (scheduled ? 1 : 0) >= 50) throw new Error("待处理点歌已满（50 首）");
    const command = { commandId: randomUUID(), type: "requestSong", args: { query: query.trim(), platform: config.platform },
      createdAt: now(), status: "queued", sender };
    pending.push(command);
    return command.commandId;
  }
  function ingest(message, room) {
    const query = parseSongRequest(message.text);
    if (!query) return;
    // A missing timestamp is deliberately NOT deduplicated by text or nickname.
    const stamp = message.messageId ? `id:${message.messageId}` : message.sentAt && message.senderUid
      ? `fallback:${message.senderUid}:${message.sentAt}:${message.text}` : null;
    const dedup = stamp && `${message.roomId}:${stamp}`;
    for (const [id, at] of seen) if (now() - at > 600000) seen.delete(id);
    if (dedup && seen.has(dedup)) return;
    if (dedup) seen.set(dedup, now());
    if (seen.size > 2000) seen.delete(seen.keys().next().value);
    let reason;
    if (!config.enabled) reason = "点歌处理尚未启用";
    else if (room?.mode !== "account") reason = "游客连接仅用于收弹幕，请登录后开启点歌";
    else if (!config.allowAnonymous && (message.identityStatus !== "identified" || !/^[1-9]\d*$/.test(message.senderUid ?? ""))) reason = "无法确认发送者身份，未接收点歌";
    if (reason) return receipt(message, "rejected", reason);
    try {
      const commandId = enqueue(query, { source: "bilibili", roomId: message.roomId,
        senderUid: message.senderUid, senderName: message.senderName, identityStatus: message.identityStatus });
      receipt(message, "accepted", "已进入点歌队列，轮到时安排为下一首", commandId);
    } catch (error) { receipt(message, "rejected", error.message); }
  }
  function matches(message) {
    return active && active.commandId === message.commandId && active.leaseId === message.leaseId &&
      active.sessionId === message.sessionId && active.serverId === message.serverId;
  }
  return {
    configure, enqueue, ingest, expire,
    cancel(commandId) {
      const index = pending.findIndex((item) => item.commandId === commandId);
      if (index < 0) throw new Error("只能取消尚未派发的点歌；已入队曲目请在 SPlayer 中管理");
      const [item] = pending.splice(index, 1);
      history.push({ ...item, status: "cancelled", finishedAt: now() });
      history = history.slice(-100);
    },
    resume() { expire(); blocked = null; },
    releaseScheduled(commandId) {
      if (!scheduled || scheduled.commandId !== commandId) throw new Error("待播歌曲已变化，请刷新后核对");
      scheduled.releasedAt = now();
      scheduled.error = "已手动解除待播等待；未从 SPlayer 删除歌曲";
      scheduled = null;
    },
    sessionChanged(sessionId) {
      if (executor?.sessionId !== sessionId) { executor = null; native = null; playback = null; }
      if (active && active.sessionId !== sessionId) finish("unconfirmed", { error: "执行插件会话已更换；不会重复派发" });
    },
    poll(message) {
      expire();
      executor = { sessionId: message.sessionId, at: now(), capable: message.capable === true && message.schedulerVersion === 1 };
      if (!config.enabled || blocked || active || scheduled || !executor.capable ||
        !playback || playback.sessionId !== message.sessionId || now() - playback.at >= 6000) return null;
      const item = pending.shift();
      if (!item) return null;
      active = { ...item, status: "dispatched", sessionId: message.sessionId, serverId: message.serverId,
        position: "next", leaseId: randomUUID(), dispatchedAt: now(), expiresAt: now() + leaseMs };
      return structuredClone(active);
    },
    check(message) { expire(); return !!(config.enabled && matches(message)); },
    report(message) {
      expire();
      // A lost HTTP acknowledgement can only retry the report, never the command.
      const prior = history.find((item) => item.commandId === message.commandId && item.leaseId === message.leaseId &&
        item.sessionId === message.sessionId && item.serverId === message.serverId);
      if (prior) return true;
      if (!matches(message) || !["added", "alreadyQueued", "failed", "unconfirmed"].includes(message.status)) return false;
      const track = summarizeTrack(message.track);
      if (["added", "alreadyQueued"].includes(message.status) && !track) return false;
      const queueCheck = Object.fromEntries(["beforeTotal", "beforeMatches", "afterTotal", "afterMatches"]
        .filter((key) => Number.isSafeInteger(message.queueCheck?.[key]) && message.queueCheck[key] >= 0 && message.queueCheck[key] <= 1000000)
        .map((key) => [key, message.queueCheck[key]]));
      const item = finish(message.status, { track, requestAccepted: message.requestAccepted === true,
        queueCheck, phase: String(message.phase ?? "").slice(0, 40), error: String(message.error ?? "").slice(0, 300) });
      if (message.status === "added") { scheduled = item; advancePlayback(); }
      return true;
    },
    observePlayback({ sessionId, track, state }) {
      playback = { sessionId, track: summarizeTrack(track), state, at: now() };
      advancePlayback();
    },
    observeQueue(message) {
      const q = message.queue;
      if (q === null) { native = null; return true; }
      if (!q || !Number.isSafeInteger(q.total) || q.total < 0 || q.total > 1000000 ||
        !Number.isSafeInteger(q.currentIndex) || q.currentIndex < -1 || q.currentIndex >= q.total ||
        !Number.isSafeInteger(q.offset) || q.offset < 0 || !Array.isArray(q.tracks) || q.tracks.length > 50 ||
        q.offset + q.tracks.length > q.total) return false;
      const tracks = q.tracks.map(summarizeTrack);
      if (tracks.some((track) => !track)) return false;
      native = { tracks, total: q.total, currentIndex: q.currentIndex, offset: q.offset,
        repeat: q.repeat === "one" ? "one" : "list", shuffle: q.shuffle === "on" ? "on" : "off", at: now() };
      if (executor?.sessionId === message.sessionId) executor.at = now();
      return true;
    },
    snapshot() {
      expire();
      return structuredClone({ schedulerVersion: 1, config, pending, active, scheduled, playing, history, receipts, blocked,
        playbackOnline: !!playback && now() - playback.at < 6000, playbackState: playback?.state ?? "stopped",
        executor: executor ? { ...executor, online: now() - executor.at < 6000 } : null,
        native: native ? { ...native, stale: now() - native.at > 7000 } : null });
    },
  };
}
