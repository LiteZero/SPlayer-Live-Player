const el = (id) => document.getElementById(id);
const token = document.querySelector('meta[name="demo-token"]').content;
let current;
let online = false;
const busy = new Set();
const accountLabels = { signedOut: "未登录", valid: "登录有效", expired: "登录已失效", unknown: "暂时无法校验" };
const roomLabels = { disconnected: "未连接", resolving: "解析房间中", token: "获取认证中", connecting: "连接中", authenticating: "认证中", connected: "认证成功", error: "连接失败" };
const identityLabels = { identified: "身份可识别", restricted: "身份受限", unavailable: "身份缺失" };
const time = (value) => value ? new Date(value).toLocaleTimeString("zh-CN", { hour12: false }) : "—";

function badge(id, text, state = "") {
  el(id).textContent = text;
  el(id).className = `badge ${state}`;
}

async function action(name, path, body = {}) {
  if (busy.has(name)) return;
  busy.add(name);
  el("error").hidden = true;
  renderControls();
  try {
    const response = await fetch(path, {
      method: "POST", headers: { "Content-Type": "application/json", "X-Demo-Token": token }, body: JSON.stringify(body),
    });
    const result = await response.json();
    if (!response.ok) throw new Error(result.error || "操作失败");
  } catch (error) {
    el("error").textContent = error.message;
    el("error").hidden = false;
  } finally {
    busy.delete(name);
    renderControls();
  }
}

function renderControls() {
  const hasAccount = !!current?.account;
  const roomActive = current && !["disconnected", "error"].includes(current.room.status);
  el("qrButton").disabled = !online || busy.has("qr") || busy.has("cookie");
  el("checkButton").disabled = !online || !hasAccount || busy.has("check");
  el("logoutButton").disabled = !online || (!hasAccount && !current?.login.image) || busy.has("logout");
  el("connectButton").disabled = !online || !hasAccount || busy.has("connect") || roomActive;
  el("disconnectButton").disabled = !online || !roomActive || busy.has("disconnect");
  el("cookieButton").disabled = !online || busy.has("cookie") || busy.has("qr");
  el("cancelButton").disabled = !online || busy.has("cancel");
}

function render(state) {
  current = state;
  const { account, accountStatus, login, room, messages, logs } = state;
  badge("accountBadge", accountLabels[accountStatus] || accountStatus, accountStatus === "valid" ? "good" : ["expired", "unknown"].includes(accountStatus) ? "bad" : "");
  el("accountName").textContent = account ? `${account.name || "未提供昵称"} · 接收账号 UID ${account.uid}` : "尚未登录接收账号";
  el("loginMessage").textContent = login.message;
  el("qrArea").hidden = !login.image;
  if (login.image) el("qrImage").src = login.image;
  else el("qrImage").removeAttribute("src");
  badge("roomBadge", roomLabels[room.status] || room.status, room.status === "connected" ? "good" : room.status === "error" ? "bad" : "");
  el("roomMessage").textContent = room.message;
  el("roomInfo").replaceChildren();
  const rows = [
    ["真实房间号", room.id], ["房主 UID", room.ownerUid],
    ["开播状态", room.liveStatus == null ? null : ({ 0: "未开播", 1: "直播中", 2: "轮播中" }[room.liveStatus] || "未知")],
    ["接入节点", room.node], ["最近心跳", room.lastHeartbeatAt ? time(room.lastHeartbeatAt) : null],
  ];
  for (const [label, value] of rows) {
    if (value == null) continue;
    const dt = document.createElement("dt");
    const dd = document.createElement("dd");
    dt.textContent = label; dd.textContent = value;
    el("roomInfo").append(dt, dd);
  }
  el("stats").textContent = `收到消息包 ${room.commandCount || 0} · 弹幕 ${room.danmuCount || 0} · 显示最近 ${messages.length} 条（最多 100 条）`;
  const fragment = document.createDocumentFragment();
  for (const message of [...messages].reverse()) {
    const tr = document.createElement("tr");
    if (message.text.includes("歌词验收")) tr.className = "acceptance";
    for (const value of [time(message.receivedAt), message.senderName || "未提供昵称", message.senderUid || "—", identityLabels[message.identityStatus] || message.identityStatus, message.text]) {
      const td = document.createElement("td");
      td.textContent = value;
      tr.append(td);
    }
    fragment.append(tr);
  }
  el("messages").replaceChildren(fragment);
  el("empty").hidden = messages.length > 0;
  const logFragment = document.createDocumentFragment();
  for (const log of [...logs].reverse()) {
    const li = document.createElement("li");
    li.textContent = `${time(log.at)} · ${log.stage} · ${log.message}`;
    logFragment.append(li);
  }
  el("logs").replaceChildren(logFragment);
  renderControls();
  countdown();
}

function countdown() {
  if (!current?.login.expiresAt) return;
  el("qrCountdown").textContent = `二维码剩余 ${Math.max(0, Math.ceil((current.login.expiresAt - Date.now()) / 1000))} 秒`;
}

el("qrButton").addEventListener("click", () => action("qr", "/api/login/qr"));
el("cancelButton").addEventListener("click", () => action("cancel", "/api/login/cancel"));
el("checkButton").addEventListener("click", () => action("check", "/api/login/check"));
el("logoutButton").addEventListener("click", () => action("logout", "/api/logout"));
el("disconnectButton").addEventListener("click", () => action("disconnect", "/api/room/disconnect"));
el("roomForm").addEventListener("submit", (event) => {
  event.preventDefault();
  action("connect", "/api/room/connect", { roomId: el("roomId").value.trim() });
});
el("cookieForm").addEventListener("submit", (event) => {
  event.preventDefault();
  const cookie = el("cookie").value;
  el("cookie").value = "";
  action("cookie", "/api/login/cookie", { cookie });
});
el("exportButton").addEventListener("click", () => {
  if (!current) return;
  const { image, ...login } = current.login;
  const evidence = { demoVersion: "0.1.0", exportedAt: new Date().toISOString(), ...current, login };
  const url = URL.createObjectURL(new Blob([JSON.stringify(evidence, null, 2)], { type: "application/json" }));
  const a = document.createElement("a");
  a.href = url; a.download = `bilibili-acceptance-${Date.now()}.json`;
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
});
const events = new EventSource("/api/events");
events.onopen = () => { online = true; badge("backend", "本地后端已连接", "good"); renderControls(); };
events.onmessage = (event) => render(JSON.parse(event.data));
events.onerror = () => { online = false; badge("backend", "本地后端失联，正在重连", "bad"); renderControls(); };
setInterval(countdown, 1000);
renderControls();
