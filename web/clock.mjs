export function clockAt(document, sample, receivedAt, now) {
  if (!document || !sample || sample.state === "stopped" || !document.track) return null;
  const remainingMs = sample.remainingMs - Math.max(0, now - receivedAt);
  if (remainingMs <= 0) return null;
  const { speed, state, lyricOffsetMs } = sample;
  const elapsed = state === "playing" ? sample.ageMs + sample.heldMs + Math.max(0, now - receivedAt) : 0;
  const position = sample.positionMs + elapsed * speed;
  const positionMs = document.track.durationMs > 0 ? Math.min(position, document.track.durationMs) : position;
  return { positionMs, lyricTimeMs: positionMs + lyricOffsetMs, speed, state, remainingMs };
}

export function foregroundTimeline(lines) {
  const timeline = lines.map((line, index) => ({ startTime: line.startTime, index, isBG: line.isBG }))
    .filter(({ isBG }) => !isBG)
    .sort((a, b) => a.startTime - b.startTime);
  let endMarker = Infinity;
  while (timeline.length) {
    const last = timeline.at(-1);
    const line = lines[last.index];
    if (!line.romanLyric?.trim() && !line.translatedLyric?.trim() && !line.words.some(({ word }) => word.trim())) {
      endMarker = timeline.pop().startTime;
      continue;
    }
    const endTime = line.endTime > line.startTime ? line.endTime
      : line.words.reduce((end, word) => Math.max(end, word.endTime), line.startTime);
    last.endTime = Math.min(endTime > line.startTime ? endTime : Infinity, endMarker);
    break;
  }
  return timeline;
}

export function findLine(timeline, time) {
  let lo = 0, hi = timeline.length;
  while (lo < hi) {
    const mid = (lo + hi) >>> 1;
    if (timeline[mid].startTime <= time) lo = mid + 1;
    else hi = mid;
  }
  const active = timeline[lo - 1];
  const endTime = active?.endTime ?? Infinity;
  if (time >= endTime) return { index: -1, nextChangeMs: Infinity };
  return { index: active?.index ?? -1, nextChangeMs: timeline[lo]?.startTime ?? endTime };
}
