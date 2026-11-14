import { VERSION, validDocument, validPlayback } from "../shared/protocol.mjs";

export function applyFrame(previous, frame) {
  if (!frame || frame.protocolVersion !== VERSION || typeof frame.serverId !== "string" ||
      !Number.isSafeInteger(frame.serial) || frame.serial < 0 ||
      !Number.isFinite(frame.heldMs) || frame.heldMs < 0 ||
      !Number.isFinite(frame.remainingMs) || frame.remainingMs < 0) return null;
  if (!previous) {
    if (frame.kind !== "snapshot" || !Object.hasOwn(frame, "document")) return null;
  } else if (frame.kind !== "update" || frame.serverId !== previous.serverId || frame.serial !== previous.serial + 1) {
    return null;
  }
  const doc = Object.hasOwn(frame, "document") ? frame.document : previous.document;
  if (Object.hasOwn(frame, "document") && doc !== null && !validDocument(doc)) return null;
  const playback = frame.playback;
  if (playback === null ? doc !== null : (!validPlayback(playback) || !doc ||
      playback.trackRevision !== doc.trackRevision || playback.lyricRevision !== doc.lyricRevision)) return null;
  return {
    serverId: frame.serverId, serial: frame.serial, document: doc, styleRevision: frame.styleRevision ?? 0,
    playback: playback && { ...playback, heldMs: frame.heldMs, remainingMs: frame.remainingMs },
  };
}

export function connect(onState) {
  let socket;
  let retry;
  let delay = 250;
  let active = false;
  let previous = null;

  function disconnect() {
    clearTimeout(retry);
    const old = socket;
    socket = undefined;
    old?.close();
    previous = null;
    onState(null);
  }
  function reconnect() {
    disconnect();
    if (!active) return;
    retry = setTimeout(open, delay);
    delay = Math.min(delay * 2, 3000);
  }
  function open() {
    const current = new WebSocket(`ws://${location.host}/ws`);
    socket = current;
    current.onmessage = (event) => {
      if (socket !== current) return;
      try {
        const state = applyFrame(previous, JSON.parse(event.data));
        if (!state) return reconnect();
        previous = state;
        delay = 250;
        onState(state, performance.now());
      } catch {
        reconnect();
      }
    };
    current.onclose = () => { if (socket === current) reconnect(); };
  }
  return {
    resume() { if (!active) { active = true; delay = 250; open(); } },
    suspend() { active = false; disconnect(); },
  };
}
