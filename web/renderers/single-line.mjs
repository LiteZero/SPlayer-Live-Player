import { trackKey } from "../../shared/protocol.mjs";

export function mount(container) {
  const owner = container.ownerDocument;
  const rows = new Map();
  let lyrics;
  let active;
  let activeKey;
  let leaving;
  container.style.height = "0px";

  // Reserve the active block's height while rows measure their own horizontal overflow.
  const observer = new ResizeObserver((entries) => {
    const changed = new Set();
    for (const { target, contentRect } of entries) {
      if (target === active) {
        container.style.height = `${active.offsetHeight}px`;
        continue;
      }
      const item = rows.get(target) ?? rows.get(target.parentElement);
      if (!item) continue;
      if (target === item.row) item.rowWidth = contentRect.width;
      else if (target === item.text) item.textWidth = contentRect.width;
      changed.add(item);
    }
    for (const item of changed) updateScroll(item);
  });

  function updateScroll(item) {
    const { rowWidth, textWidth, text, deadline } = item;
    if (item.row.parentElement !== active || rowWidth <= 0 || !Number.isFinite(textWidth)) return;
    const overflow = textWidth - rowWidth;
    if (overflow <= 0.5) {
      item.animation?.cancel();
      item.animation = undefined;
      item.travel = 0;
      return;
    }

    // The text is centered by default, so move half the overflow in each direction.
    const travel = overflow / 2 * (getComputedStyle(text).direction === "rtl" ? -1 : 1);
    if (Math.abs((item.travel ?? 0) - travel) < 0.25 && item.animation) return;
    const progress = item.animation?.effect.getComputedTiming().progress ?? 0;
    item.animation?.cancel();
    item.travel = travel;
    const desiredMs = Math.max(900, overflow / 90 * 1000 + 750);
    const remainingMs = Math.max(1, deadline - performance.now());
    const duration = progress === 1 ? desiredMs : Math.min(desiredMs, remainingMs / (1 - progress));
    const hold = Math.min(375 / duration, 0.18);
    const start = `translateX(${travel}px)`;
    const end = `translateX(${-travel}px)`;
    item.animation = text.animate([
      { transform: start, offset: 0 },
      { transform: start, offset: hold },
      { transform: end, offset: 1 - hold },
      { transform: end, offset: 1 },
    ], { duration, fill: "both" });
    item.animation.currentTime = duration * progress;
  }

  function removeBlock(block) {
    if (!block) return;
    observer.unobserve(block);
    for (const row of block.children) {
      const item = rows.get(row);
      observer.unobserve(row);
      observer.unobserve(item.text);
      item.animation?.cancel();
      rows.delete(row);
    }
    block.remove();
  }

  function removeLeaving() {
    removeBlock(leaving);
    leaving = undefined;
  }

  function clear() {
    removeLeaving();
    removeBlock(active);
    active = activeKey = undefined;
    container.style.height = "0px";
  }

  function leaveActive() {
    if (!active) return;
    removeLeaving();
    const previous = leaving = active;
    active = activeKey = undefined;
    observer.unobserve(previous);
    for (const row of previous.children) rows.get(row).animation?.pause();
    const { opacity, translate } = getComputedStyle(previous);
    previous.style.setProperty("--lyric-exit-opacity", opacity);
    previous.style.setProperty("--lyric-exit-translate", translate);
    previous.classList.replace("lyric-block--entering", "lyric-block--leaving");
    previous.setAttribute("aria-hidden", "true");
    const animation = previous.getAnimations().find((item) => item.animationName === "lyric-out");
    const remove = () => { if (leaving === previous) removeLeaving(); };
    if (animation) animation.finished.then(remove, remove);
    else remove();
  }

  function hide() {
    leaveActive();
    container.style.height = "0px";
  }

  function addRow(block, className, content, deadline, language) {
    if (!content) return;
    const row = owner.createElement("div");
    const text = owner.createElement("span");
    row.className = `lyric-row ${className}`;
    text.className = "lyric-text";
    text.textContent = content;
    text.dir = "auto";
    if (language) text.lang = language;
    row.append(text);
    block.append(row);
    rows.set(row, { row, text, deadline });
    observer.observe(row);
    observer.observe(text);
  }

  return {
    cadence: "line",
    setLyrics(doc) {
      if (!doc) clear();
      else if (doc.lyricStatus !== "ready" || doc.trackRevision !== lyrics?.trackRevision ||
          trackKey(doc.track) !== trackKey(lyrics.track)) hide();
      lyrics = doc;
    },
    render({ lineIndex, nextChangeMs, lyricTimeMs, speed, state }) {
      const line = lyrics?.lines[lineIndex];
      const original = line?.words.map(({ word }) => word).join("").trim();
      const roman = line?.romanLyric.trim();
      const translation = line?.translatedLyric.trim();
      if (!original && !roman && !translation) {
        hide();
        return;
      }
      const key = JSON.stringify([lineIndex, line.startTime, line.language, original, roman, translation]);
      if (key === activeKey) return;
      const deadline = state === "playing" ? performance.now() + (nextChangeMs - lyricTimeMs) / speed : Infinity;
      const block = owner.createElement("div");
      block.className = "lyric-block lyric-block--entering";
      addRow(block, "lyric-line lyric-original", original, deadline, line.language);
      addRow(block, "lyric-roman", roman, deadline);
      addRow(block, "lyric-translation", translation, deadline);
      leaveActive();
      active = block;
      activeKey = key;
      container.append(block);
      container.style.height = `${block.offsetHeight}px`;
      observer.observe(block, { box: "border-box" });
    },
    hide,
    clear,
    dispose() { lyrics = undefined; clear(); observer.disconnect(); },
  };
}
