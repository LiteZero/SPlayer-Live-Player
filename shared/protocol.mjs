export const VERSION = 1;
export const DEFAULT_PORT = 19633;
export const DEFAULT_ORIGIN = `http://127.0.0.1:${DEFAULT_PORT}`;
export const SAMPLE_MS = 400;
export const STALE_MS = 3000;
export const MAX_ANCHOR_AGE_MS = 2000;
export const MAX_BODY_BYTES = 2 * 1024 * 1024;
export const MAX_COVER_CHARS = 64 * 1024;
export const MAX_TRACE_BATCH = 24;
export const PLAY_STATES = ["playing", "paused", "stopped"];
export const LYRIC_STATES = ["waiting", "none", "ready"];

export const trackKey = (track) => track ? JSON.stringify([track.source, track.id]) : null;
export const clamp = (value, min, max) => Math.min(max, Math.max(min, value));

const record = (value) => value !== null && typeof value === "object" && !Array.isArray(value);
const str = (value, limit) => typeof value === "string" && value.length <= limit;
const number = (value, min, max = Infinity) => Number.isFinite(value) && value >= min && value <= max;
export const positiveInt = (value) => Number.isSafeInteger(value) && value > 0;
export const validId = (value) => typeof value === "string" && /^[a-zA-Z0-9_-]{1,80}$/.test(value);
const optional = (value, check) => value === undefined || check(value);

export function coverUrl(value) {
  if (!str(value, MAX_COVER_CHARS)) return undefined;
  if (/^data:image\/(?:jpeg|png|webp|gif);base64,[a-z\d+/]+={0,2}$/i.test(value)) return value;
  if (!/^https?:\/\//i.test(value) || value.length > 4096) return undefined;
  try {
    const url = new URL(value);
    if (!url.username && !url.password) return url.href;
  } catch {
    // Unsupported or malformed artwork falls back to the record icon.
  }
}

export function validSession(message) {
  return record(message) && message.protocolVersion === VERSION && validId(message.sessionId) &&
    positiveInt(message.startedAt) && positiveInt(message.apiLevel) && message.apiLevel >= 4 &&
    str(message.appVersion, 80);
}

function validTrack(track) {
  return track === null || (record(track) && str(track.id, 1024) && !!track.id &&
    str(track.source, 160) && !!track.source && str(track.title, 2048) &&
    Array.isArray(track.artists) && track.artists.length <= 100 &&
    track.artists.every((artist) => str(artist, 1024)) && number(track.durationMs, 0) &&
    optional(track.coverUrl, (value) => Boolean(coverUrl(value))));
}

function validSpan(span) {
  return record(span) && str(span.word, 8192) && number(span.startTime, 0) &&
    number(span.endTime, span.startTime);
}

function validLine(line) {
  return record(line) && number(line.startTime, 0) && number(line.endTime, line.startTime) &&
    typeof line.isBG === "boolean" && typeof line.isDuet === "boolean" &&
    str(line.translatedLyric, 8192) && str(line.romanLyric, 8192) &&
    optional(line.language, (value) => str(value, 40)) &&
    Array.isArray(line.words) && line.words.every((word) => validSpan(word) &&
      optional(word.romanWord, (value) => str(value, 8192)) &&
      optional(word.obscene, (value) => typeof value === "boolean") &&
      optional(word.ruby, (value) => Array.isArray(value) && value.every(validSpan)));
}

export function validDocument(doc) {
  return record(doc) && positiveInt(doc.trackRevision) && positiveInt(doc.lyricRevision) &&
    validTrack(doc.track) && LYRIC_STATES.includes(doc.lyricStatus) &&
    Array.isArray(doc.lines) && (doc.lyricStatus === "ready"
      ? doc.track !== null && doc.lines.length > 0 && doc.lines.every(validLine)
      : doc.lines.length === 0 && (doc.track !== null || doc.lyricStatus === "none"));
}

export function validPlayback(sample) {
  return record(sample) && positiveInt(sample.trackRevision) && positiveInt(sample.lyricRevision) &&
    PLAY_STATES.includes(sample.state) && number(sample.positionMs, 0) &&
    number(sample.speed, 0.01, 16) && number(sample.lyricOffsetMs, -60000, 60000) &&
    number(sample.ageMs, 0, MAX_ANCHOR_AGE_MS);
}

export function validTrace(trace) {
  return Array.isArray(trace) && trace.length <= MAX_TRACE_BATCH && trace.every((item) =>
    record(item) && positiveInt(item.n) && number(item.elapsedMs, 0) &&
    str(item.event, 48) && optional(item.track, (v) => v === null || str(v, 1200)) &&
    optional(item.detail, (v) => str(v, 300)));
}
