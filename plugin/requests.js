import { VERSION } from "../shared/protocol.mjs";

const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const trackKey = (track) => JSON.stringify([track.source, String(track.id)]);
const summary = (track) => ({ id: String(track.id), source: track.source, title: track.title,
  artists: (track.artists ?? []).map((artist) => artist.name) });

async function bounded(promise, ms) {
  let timer;
  try {
    return await Promise.race([promise, new Promise((_, reject) => {
      timer = setTimeout(() => reject(new Error("宿主接口等待超时")), ms);
    })]);
  } finally { clearTimeout(timer); }
}

// Queue pages use playback order (including shuffle); an acknowledgement only
// counts submitted tracks. SPlayer silently skips tracks whose ID already exists.
async function readQueue(deadline) {
  const counts = new Map(), ids = new Set();
  let offset = 0, total, currentIndex, nextKey, currentKey;
  do {
    const remaining = deadline - Date.now();
    if (remaining <= 0) throw new Error("队列核对超时");
    const page = await bounded(splayer.player.getQueue({ offset, limit: 100 }), Math.min(2000, remaining));
    if (!Number.isSafeInteger(page?.total) || page.total < 0 || page.total > 10000 ||
      page.offset !== offset || (total !== undefined && page.total !== total) ||
      !Number.isSafeInteger(page.currentIndex) || page.currentIndex < -1 || page.currentIndex >= page.total ||
      (currentIndex !== undefined && page.currentIndex !== currentIndex) ||
      !Array.isArray(page.tracks) || page.tracks.length !== Math.min(100, page.total - offset)) {
      throw new Error("队列过大、不完整或读取期间发生变化");
    }
    total = page.total;
    currentIndex = page.currentIndex;
    for (const [index, track] of page.tracks.entries()) {
      if (!track || !["string", "number"].includes(typeof track.id) || typeof track.source !== "string") {
        throw new Error("队列曲目缺少标识");
      }
      const key = trackKey(track);
      if (offset + index === currentIndex + 1) nextKey = key;
      if (offset + index === currentIndex) currentKey = key;
      counts.set(key, (counts.get(key) ?? 0) + 1);
      ids.add(String(track.id));
    }
    offset += page.tracks.length;
  } while (offset < total);
  return { total, counts, ids, nextKey, currentKey };
}

function confirmsAppend(before, after, key) {
  if (after.nextKey !== key && after.currentKey !== key) return false;
  if (after.total !== before.total + 1 || after.counts.get(key) !== (before.counts.get(key) ?? 0) + 1) return false;
  const expected = new Map(before.counts);
  expected.set(key, (expected.get(key) ?? 0) + 1);
  return expected.size === after.counts.size && [...expected].every(([id, count]) => after.counts.get(id) === count);
}

/** Independent from lyric uploads: slow online searches never hold the lyric clock. */
export function startRequests(getTransport) {
  const capable = splayer.apiLevel >= 5 && typeof splayer.music?.searchOnline === "function" &&
    typeof splayer.player.addToQueue === "function" && typeof splayer.player.getQueue === "function" &&
    typeof splayer.player.getStatus === "function";
  let pending;
  let schedulerServer;
  let warned = false;
  function current(transport) {
    const live = getTransport();
    return live?.serverId === transport.serverId && live?.origin === transport.origin && live?.sessionId === transport.sessionId;
  }
  async function post(transport, path, message) {
    const response = await splayer.request(transport.origin + path, {
      method: "POST", headers: { "Content-Type": "application/json", "X-SPlayer-Live-Protocol": String(VERSION) },
      body: JSON.stringify({ ...message, protocolVersion: VERSION, serverId: transport.serverId, sessionId: transport.sessionId }),
      responseType: "json", timeout: 1500,
    });
    if (response.status !== 200) throw new Error("点歌后端暂不可用");
    return response.body;
  }
  async function execute(transport, command) {
    const identity = { commandId: command.commandId, leaseId: command.leaseId };
    let phase = "search", mutated = false, requestAccepted = false, track = null;
    const queueCheck = {};
    try {
      if (command.type !== "requestSong") throw new Error("不支持的点歌命令");
      if (command.position !== "next") throw new Error("请更新后端以使用下一首点歌队列");
      const result = await bounded(splayer.music.searchOnline({ platform: command.args.platform,
        query: command.args.query, page: 1, limit: 1 }), 15000);
      const fullTrack = result.tracks?.[0];
      if (!fullTrack) throw new Error("没有搜索结果");
      track = summary(fullTrack);
      phase = "queueBefore";
      const before = await readQueue(Date.now() + 6000);
      const key = trackKey(fullTrack);
      queueCheck.beforeTotal = before.total;
      queueCheck.beforeMatches = before.counts.get(key) ?? 0;
      if (queueCheck.beforeMatches > 0) {
        return { ...identity, status: "alreadyQueued", track, phase, requestAccepted, queueCheck,
          error: "该曲目已在 SPlayer 播放列表中，本次未重复添加；播放顺序由 SPlayer 决定" };
      }
      if (before.ids.has(String(fullTrack.id))) {
        return { ...identity, status: "failed", track, phase, requestAccepted, queueCheck,
          error: "播放列表已有相同 ID 的其他来源曲目，SPlayer 会跳过此项；本次未提交" };
      }
      phase = "authorize";
      if (!current(transport) || Date.now() >= command.expiresAt ||
        !(await post(transport, "/api/plugin/commands/check", identity)).allowed || !current(transport)) {
        throw new Error("点歌已停用、过期或执行会话已更换");
      }
      phase = "enqueue";
      // Keep the complete search Track. Only one audience song occupies the next slot.
      mutated = true;
      const accepted = await bounded(splayer.player.addToQueue([fullTrack], "next"), 6000);
      requestAccepted = accepted?.count === 1;
      phase = "confirmQueue";
      const deadline = Date.now() + 10000;
      for (let attempt = 0; attempt < 6; ++attempt) {
        if (!current(transport) || Date.now() >= deadline) break;
        try {
          const after = await readQueue(deadline);
          queueCheck.afterTotal = after.total;
          queueCheck.afterMatches = after.counts.get(key) ?? 0;
          if (confirmsAppend(before, after, key)) {
            return { ...identity, status: "added", track, phase, requestAccepted, queueCheck };
          }
        } catch { /* Only retry reading the queue; never repeat the append. */ }
        await wait(300);
      }
      return { ...identity, status: "unconfirmed", track, phase, requestAccepted, queueCheck,
        error: "已发出入队请求，但未能核对列表中的新增曲目；请检查 SPlayer 播放列表" };
    } catch (error) {
      return { ...identity, status: mutated ? "unconfirmed" : "failed", track, phase, requestAccepted, queueCheck,
        error: phase === "search" ? (error.message === "没有搜索结果" ? error.message : "搜索失败或超时")
          : mutated ? "入队结果不确定；不会自动重试" : "入队前检查未通过，未提交曲目" };
    }
  }
  async function tick() {
    try {
      const transport = getTransport();
      if (!transport) return;
      if (pending && !current(pending.transport)) pending = null;
      if (pending) {
        await post(pending.transport, "/api/plugin/commands/report", pending.result);
        pending = null;
      }
      const { command, schedulerVersion } = await post(transport, "/api/plugin/commands/poll", {
        capable: capable && schedulerServer === transport.serverId, schedulerVersion: 1,
      });
      schedulerServer = schedulerVersion === 1 ? transport.serverId : undefined;
      if (!schedulerServer) {
        if (!warned) splayer.log.warn("点歌需要更新后端至支持下一首队列的版本");
        warned = true;
        return;
      }
      warned = false;
      if (command) pending = { transport, result: await execute(transport, command) };
    } catch {
      if (!warned) splayer.log.warn("点歌后端连接中断，等待恢复；不会重复提交入队请求");
      warned = true;
    } finally { setTimeout(tick, 750); }
  }
  async function syncQueue() {
    try {
      const transport = getTransport();
      if (!transport || !capable) return;
      const status = await bounded(splayer.player.getStatus(), 2500);
      const queue = await bounded(splayer.player.getQueue({ offset: Math.max(0, status.currentIndex ?? 0), limit: 50 }), 2500);
      if (!current(transport)) return;
      await post(transport, "/api/plugin/queue", { queue: { total: queue.total, offset: queue.offset,
        currentIndex: queue.currentIndex, tracks: queue.tracks.map(summary), repeat: status.repeat, shuffle: status.shuffle } });
    } catch {
      // Existing snapshot ages out in settings. Do not clear a newer session's queue.
    } finally { setTimeout(syncQueue, 2000); }
  }
  setTimeout(tick, 250);
  setTimeout(syncQueue, 500);
}
