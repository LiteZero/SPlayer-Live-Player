const el = (id) => document.getElementById(id);
const labels = { queued: "排队中", dispatched: "搜索 / 安排下一首中", added: "已安排下一首，等待播放", failed: "失败",
  alreadyQueued: "已在播放列表", unconfirmed: "入队结果待核对", expired: "执行超时", cancelled: "已取消" };
let configDirty = false, configRevision = 0, timer, controller;
const rendered = new Map();
function list(id, values, build) {
  const cacheKey = JSON.stringify(values);
  if (rendered.get(id) === cacheKey) return;
  rendered.set(id, cacheKey);
  const container = el(id);
  container.replaceChildren(...(values.length ? values.map(build) : [item("暂无记录")]));
}
function item(text) { const li = document.createElement("li"); li.textContent = text; return li; }
const trackText = (track) => [track.title || "未命名曲目", ...(track.artists ?? [])].filter(Boolean).join(" · ");
const sender = (entry) => entry.senderName || (entry.senderUid ? `UID ${entry.senderUid}` : "身份未提供");
async function action(path, body = {}) {
  const response = await fetch(path, { method: "POST", headers: { "Content-Type": "application/json", "X-SPlayer-Live-Management": "1" },
    body: JSON.stringify(body), signal: AbortSignal.timeout(40000) });
  const result = await response.json();
  if (!response.ok) throw new Error(result.error ?? "操作失败，请检查本地服务");
  return result;
}
async function operate(button, task) {
  if (button) button.disabled = true;
  el("request-action-status").textContent = "正在处理…";
  try { await task(); el("request-action-status").textContent = "操作完成"; }
  catch (error) { el("request-action-status").textContent = error.name === "TimeoutError" ? "等待超时，请检查当前状态后再操作" : error.message; }
  finally { if (button) button.disabled = false; }
}
document.querySelectorAll("[data-bili]").forEach((button) => button.addEventListener("click", () =>
  operate(button, () => action(`/api/bilibili/${button.dataset.bili}`))));
el("cookie-form").addEventListener("submit", (event) => {
  event.preventDefault();
  const cookie = el("bili-cookie").value;
  el("bili-cookie").value = "";
  operate(event.submitter, () => action("/api/bilibili/login/cookie", { cookie }));
});
el("room-form").addEventListener("submit", (event) => {
  event.preventDefault();
  operate(event.submitter, () => action("/api/bilibili/room/connect", { roomId: el("room-id").value, mode: el("room-mode").value }));
});
el("request-config").addEventListener("input", () => {
  ++configRevision;
  configDirty = true;
  el("request-config-status").textContent = "有未应用的点歌设置";
});
el("request-config").addEventListener("submit", (event) => {
  event.preventDefault();
  const config = { enabled: el("requests-enabled").checked, platform: el("request-platform").value,
    allowAnonymous: el("allow-anonymous").checked };
  const savingRevision = configRevision;
  operate(event.submitter, async () => {
    await action("/api/requests/config", config);
    configDirty = savingRevision !== configRevision;
    el("request-config-status").textContent = configDirty ? "已应用，仍有未应用的修改"
      : config.enabled ? "点歌处理已启用" : "点歌处理已关闭，待处理记录保留";
  });
});
el("manual-request").addEventListener("submit", (event) => {
  event.preventDefault();
  const query = el("manual-query").value;
  operate(event.submitter, async () => {
    await action("/api/requests/add", { query });
    if (el("manual-query").value === query) el("manual-query").value = "";
  });
});
el("resume-requests").addEventListener("click", (event) => operate(event.currentTarget, () => action("/api/requests/resume")));
el("release-scheduled").addEventListener("click", (event) => {
  const button = event.currentTarget, commandId = button.dataset.command;
  operate(button, () => action("/api/requests/release", { commandId }));
});
el("pending-requests").addEventListener("click", (event) => {
  const button = event.target.closest("button[data-command]");
  if (button) operate(button, () => action("/api/requests/cancel", { commandId: button.dataset.command }));
});

function render(state) {
  const { bili, config, executor, native } = state;
  el("bili-account").textContent = bili.account ? `${bili.account.name} · UID ${bili.account.uid} · ${
    { valid: "有效", unknown: "暂时无法校验", expired: "已失效" }[bili.accountStatus] ?? bili.accountStatus}` : "未登录";
  el("bili-room").textContent = [bili.room.id && `房间 ${bili.room.id}`, bili.room.message].filter(Boolean).join(" · ");
  el("bili-connection-detail").textContent = bili.room.node
    ? `${bili.room.node}:${bili.room.port ?? "—"}${bili.room.attempt ? ` · 第 ${bili.room.attempt}/${bili.room.maxAttempts} 次尝试` : ""}` : "";
  list("bili-connection-logs", bili.logs.slice(-20).reverse(), (entry) => item(
    `${new Date(entry.at).toLocaleTimeString("zh-CN", { hour12: false })} · ${entry.stage} · ${entry.message}`));
  el("bili-login").textContent = bili.login.message;
  const qr = el("bili-qr");
  qr.hidden = !bili.login.image;
  if (bili.login.image && qr.getAttribute("src") !== bili.login.image) qr.src = bili.login.image;
  if (!bili.login.image) qr.removeAttribute("src");
  el("request-executor").textContent = state.schedulerVersion !== 1 ? "请重启后端以启用新版点歌队列"
    : !executor?.online ? "等待新版插件连接（需要 API 5）"
    : !executor.capable ? "请使用 0.4.0 插件及新版后端，宿主需要 API 5"
      : state.playbackOnline === false ? "播放状态同步中断，暂不安排新点歌" : "已连接，按点歌顺序安排下一首";
  if (!configDirty) {
    el("requests-enabled").checked = config.enabled;
    el("request-platform").value = config.platform;
    el("allow-anonymous").checked = config.allowAnonymous;
    el("request-config-status").textContent = config.enabled ? "点歌处理已启用" : "点歌处理已关闭，启用后开始处理点歌";
  }
  el("request-blocked").textContent = state.blocked ?? "";
  el("resume-requests").hidden = !state.blocked;
  el("request-playing").textContent = state.playing
    ? `${state.playbackState === "playing" ? "正在播放点歌" : "当前点歌（暂停 / 停止）"}：${trackText(state.playing.track)}`
    : "当前为普通歌单 / 尚无点歌开始播放";
  el("release-scheduled").hidden = el("scheduled-hint").hidden = !state.scheduled;
  el("release-scheduled").dataset.command = state.scheduled?.commandId ?? "";
  el("pending-count").textContent = `(${state.pending.length}${state.scheduled ? " + 1 首待播" : ""}${state.active ? " + 1 首处理中" : ""})`;
  list("pending-requests", [...(state.scheduled ? [state.scheduled] : []), ...(state.active ? [state.active] : []), ...state.pending], (entry) => {
    const li = item(`${entry.args.query} · ${sender(entry.sender)} · ${labels[entry.status]}${entry.track ? ` · ${trackText(entry.track)}` : ""}`);
    if (entry.status === "queued") {
      const button = document.createElement("button");
      button.type = "button"; button.dataset.command = entry.commandId; button.textContent = "取消"; li.append(button);
    }
    return li;
  });
  el("native-queue-status").textContent = !native ? "等待原生队列同步，请导入 0.4.0 插件（SPlayer API 5）"
    : `队列共 ${native.total} 首${native.currentIndex >= 0 ? ` · 当前第 ${native.currentIndex + 1} 首` : " · 尚未开始播放"}${native.stale ? " · 同步已中断，以下为上次记录" : " · 已同步"}`;
  el("native-mode-warning").textContent = native && (native.shuffle === "on" || native.repeat === "one")
    ? "SPlayer 已开启随机或单曲循环。点歌会核对“下一首”位置；若播放器没有切到待播歌曲，后端会等待，请检查播放模式。" : "";
  el("native-queue").start = (native?.offset ?? 0) + 1;
  list("native-queue", native?.tracks.map((track, i) => ({ ...track, current: native.offset + i === native.currentIndex })) ?? [], (track) => {
    const li = item(`${track.current ? "当前 · " : ""}${trackText(track)}`);
    li.dataset.current = String(track.current); return li;
  });
  list("request-history", state.history.slice(-30).reverse(), (entry) => item([
    entry.args.query, entry.track && trackText(entry.track), sender(entry.sender),
    entry.releasedAt ? "已解除待播等待" : entry.endedAt ? "已离开播放" : entry.startedAt ? "已开始播放" : labels[entry.status], entry.error,
    entry.status === "unconfirmed" && entry.queueCheck ? [
      Number.isSafeInteger(entry.queueCheck.beforeTotal) && `核对前 ${entry.queueCheck.beforeTotal} 首`,
      Number.isSafeInteger(entry.queueCheck.afterTotal) && `核对后 ${entry.queueCheck.afterTotal} 首`,
      Number.isSafeInteger(entry.queueCheck.afterMatches) && `目标曲目 ${entry.queueCheck.afterMatches} 项`,
    ].filter(Boolean).join("，") : "",
  ].filter(Boolean).join(" · ")));
  list("request-receipts", state.receipts.slice(-30).reverse(), (entry) => item(`${sender(entry)} · ${entry.query} · ${entry.detail}`));
  list("bili-messages", bili.messages.slice(-30).reverse(), (entry) => item(`${sender(entry)} · ${entry.text}`));
}
async function update() {
  const request = new AbortController();
  controller = request;
  const timeout = setTimeout(() => request.abort(), 2500);
  try {
    const response = await fetch("/api/requests", { signal: request.signal });
    if (!response.ok) throw new Error();
    const state = await response.json();
    if (controller === request) render(state);
  } catch {
    if (controller === request) {
      el("request-executor").textContent = "本地服务连接中断";
      el("native-queue-status").textContent = "同步中断，以下为上次记录";
    }
  } finally {
    clearTimeout(timeout);
    if (controller === request) { controller = null; timer = setTimeout(update, 1500); }
  }
}
window.addEventListener("pagehide", () => { clearTimeout(timer); const old = controller; controller = null; old?.abort(); });
window.addEventListener("pageshow", (event) => { if (event.persisted) update(); });
update();
