import { clockAt, findLine, foregroundTimeline } from "./clock.mjs";

export const renderers = new Map([
  ["single-line", { label: "轻量歌词", load: () => import("./renderers/single-line.mjs") }],
]);
export const defaultRenderer = "single-line";

export function createDisplay(container, { registry = renderers, onTrack = () => {} } = {}) {
  let revision = 0;
  let renderer;
  let doc;
  let playback;
  let receivedAt;
  let timeline = [];
  let timer;
  let frameId;
  let lastIndex;

  function cancel() {
    clearTimeout(timer);
    if (frameId !== undefined) cancelAnimationFrame(frameId);
    frameId = undefined;
  }

  function draw() {
    cancel();
    const now = performance.now();
    const clock = clockAt(doc, playback, receivedAt, now);
    const remainingMs = playback ? playback.remainingMs - Math.max(0, now - receivedAt) : 0;
    const stopped = playback?.state === "stopped" && remainingMs > 0;
    onTrack(clock ? doc.track : null, stopped ? "stopped" : clock?.state);
    if (!clock || !renderer || doc.lyricStatus !== "ready") {
      if (stopped && lastIndex !== undefined) {
        if (renderer?.hide) renderer.hide();
        else renderer?.clear();
      } else if (!clock && !stopped) {
        renderer?.clear();
      }
      lastIndex = undefined;
      if (remainingMs > 0) timer = setTimeout(draw, Math.max(1, Math.ceil(remainingMs)));
      return;
    }
    const { index, nextChangeMs } = findLine(timeline, clock.lyricTimeMs);
    if (renderer.cadence === "frame" || lastIndex !== index) {
      renderer.render({ ...clock, lineIndex: index, nextChangeMs });
      lastIndex = index;
    }
    if (clock.state === "playing" && renderer.cadence === "frame") {
      frameId = requestAnimationFrame(draw);
    } else {
      const duration = doc.track.durationMs;
      const reachable = duration <= 0 || nextChangeMs <= duration + playback.lyricOffsetMs;
      const nextChange = clock.state === "playing" && reachable ? (nextChangeMs - clock.lyricTimeMs) / clock.speed : Infinity;
      timer = setTimeout(draw, Math.max(1, Math.ceil(Math.min(clock.remainingMs, nextChange))));
    }
  }

  function disposeCurrent() {
    cancel();
    renderer?.dispose();
    renderer = undefined;
    lastIndex = undefined;
    container.replaceChildren();
  }

  return {
    async select(id) {
      const choice = registry.get(id);
      if (!choice) return false;
      const requested = ++revision;
      const module = await choice.load();
      if (requested !== revision) return false;
      const slot = container.ownerDocument.createElement("div");
      slot.className = "renderer-slot";
      const next = module.mount(slot);
      disposeCurrent();
      renderer = next;
      container.replaceChildren(slot);
      renderer.setLyrics(doc ?? null);
      draw();
      return true;
    },
    setState(state, at = performance.now()) {
      const document = state?.document ?? null;
      if (doc !== document) {
        doc = document;
        timeline = foregroundTimeline(doc?.lines ?? []);
        renderer?.setLyrics(doc);
        lastIndex = undefined;
      }
      playback = state?.playback ?? null;
      receivedAt = at;
      draw();
    },
    dispose() { ++revision; disposeCurrent(); onTrack(null); },
  };
}
