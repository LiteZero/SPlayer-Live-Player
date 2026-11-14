import { randomUUID } from "node:crypto";
import {
  VERSION, STALE_MS, validSession, validDocument, validPlayback, validTrace, positiveInt, trackKey,
} from "../shared/protocol.mjs";

export function createState({ publish, now = () => performance.now(), staleMs = STALE_MS }) {
  const serverId = randomUUID();
  let serial = 0;
  let session;
  let document = null;
  let playback = null;
  let receivedAt = 0;
  let lastSeq = 0;
  let watermark;
  let trace = [];
  let traceSeq = 0;
  let metrics;
  let styleRevision = 0;

  const wire = (kind) => ({ protocolVersion: VERSION, serverId, serial, kind, styleRevision });
  const timing = () => {
    const age = playback ? Math.max(0, now() - receivedAt) : 0;
    return { heldMs: age, remainingMs: playback ? Math.max(0, staleMs - age) : 0 };
  };
  function update(changedDocument) {
    ++serial;
    publish({ ...wire("update"), playback, ...timing(), ...(changedDocument ? { document } : {}) });
  }

  function expire() {
    if (!playback || now() - receivedAt < staleMs) return;
    document = playback = null;
    update(true);
  }

  function openSession(message) {
    if (!validSession(message)) return "invalid_session";
    if (session?.sessionId === message.sessionId) return "ok";
    if (session && (message.startedAt < session.startedAt ||
        (message.startedAt === session.startedAt && message.sessionId < session.sessionId))) return "stale_session";
    session = {
      sessionId: message.sessionId, startedAt: message.startedAt,
      appVersion: message.appVersion, apiLevel: message.apiLevel,
    };
    document = playback = null;
    lastSeq = traceSeq = 0;
    watermark = undefined;
    trace = [];
    metrics = { documents: 0, samples: 0, bytes: 0, lastDocumentBytes: 0, lastSampleBytes: 0 };
    update(true);
    return "ok";
  }

  function accept(message, bytes) {
    if (!message || message.protocolVersion !== VERSION || !positiveInt(message.seq) ||
        !["document", "sample"].includes(message.kind) || !validPlayback(message.playback) ||
        (message.trace !== undefined && !validTrace(message.trace))) return "invalid_message";
    if (message.serverId !== serverId || !session) return "session_required";
    if (message.sessionId !== session.sessionId) return "stale_session";
    if (message.seq <= lastSeq) return "stale_seq";
    const sample = message.playback;
    const next = message.document;
    const full = message.kind === "document";
    if (full && (!validDocument(next) || next.trackRevision !== sample.trackRevision ||
        next.lyricRevision !== sample.lyricRevision || (!next.track && sample.state !== "stopped"))) {
      return "invalid_document";
    }
    if (!full && (!document || sample.trackRevision !== document.trackRevision ||
        sample.lyricRevision !== document.lyricRevision)) return "snapshot_required";
    if (!full && (next !== undefined || (!document.track && sample.state !== "stopped"))) return "invalid_message";
    if (full && watermark) {
      if (next.trackRevision < watermark.trackRevision || next.lyricRevision < watermark.lyricRevision) return "stale_revision";
      if ((next.trackRevision !== watermark.trackRevision && next.lyricRevision === watermark.lyricRevision) ||
          (next.trackRevision === watermark.trackRevision && trackKey(next.track) !== watermark.key)) {
        return "invalid_revision";
      }
    }
    const changedDocument = full && (!document || next.lyricRevision !== document.lyricRevision);
    if (changedDocument) {
      document = next;
      watermark = { trackRevision: next.trackRevision, lyricRevision: next.lyricRevision, key: trackKey(next.track) };
    }
    playback = sample;
    receivedAt = now();
    lastSeq = message.seq;
    metrics.bytes += bytes;
    if (full) {
      ++metrics.documents;
      metrics.lastDocumentBytes = bytes;
    } else {
      ++metrics.samples;
      metrics.lastSampleBytes = bytes;
    }
    for (const item of message.trace ?? []) {
      if (item.n <= traceSeq) continue;
      trace.push(item);
      traceSeq = item.n;
    }
    if (trace.length > 120) trace = trace.slice(-120);
    update(changedDocument);
    return "ok";
  }

  return {
    serverId, expire, openSession, accept,
    authorize(message) {
      return !!(session && message?.protocolVersion === VERSION && message.serverId === serverId && message.sessionId === session.sessionId);
    },
    styleChanged() {
      expire();
      ++styleRevision;
      update(false);
    },
    snapshot: () => ({ ...wire("snapshot"), document, playback, ...timing() }),
    status: () => ({
      protocolVersion: VERSION, serverId,
      status: !playback ? (lastSeq ? "host_disconnected" : "host_waiting")
        : !document.track ? "no_track" : `lyric_${document.lyricStatus}`,
      session: session ?? null,
      track: document?.track ?? null,
      lineCount: document?.lines.length ?? 0,
      playback, ...timing(),
      metrics: metrics ?? null, trace,
    }),
  };
}
