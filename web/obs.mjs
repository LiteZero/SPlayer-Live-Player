import { connect } from "./client.mjs";
import { createDisplay, defaultRenderer, renderers } from "./renderers.mjs";
import { trackKey } from "../shared/protocol.mjs";
import { applyLayout } from "../shared/layout.mjs";

const badgeSlot = document.querySelector(".now-playing-slot");
const badgeTemplate = document.querySelector("#now-playing-template").content.firstElementChild;
let badge;
let leavingBadge;
let currentTrack;
let currentPlaying;
let stopTimer;
const stopGraceMs = 500;

function removeLeavingBadge() {
  leavingBadge?.remove();
  leavingBadge = undefined;
}

function transitionBadge(previous) {
  const { opacity, translate } = getComputedStyle(previous);
  if (leavingBadge && Number(getComputedStyle(leavingBadge).opacity) > Number(opacity)) {
    previous.remove();
    return;
  }
  removeLeavingBadge();
  leavingBadge = previous;
  previous.setAttribute("aria-hidden", "true");
  previous.style.setProperty("--now-playing-exit-opacity", opacity);
  previous.style.setProperty("--now-playing-exit-translate", translate);
  previous.classList.remove("is-playing", "now-playing--entering");
  previous.classList.add("now-playing--leaving");
  const animation = previous.getAnimations().find((item) => item.animationName === "now-playing-out");
  const remove = () => { if (leavingBadge === previous) removeLeavingBadge(); };
  if (animation) animation.finished.then(remove, remove);
  else remove();
}

function showCover(disc, url) {
  disc.querySelector("img")?.remove();
  disc.classList.remove("has-cover");
  if (!url) return;
  const image = document.createElement("img");
  image.alt = "";
  image.hidden = true;
  image.referrerPolicy = "no-referrer";
  image.addEventListener("load", () => {
    if (image.parentElement !== disc) return;
    image.hidden = false;
    disc.classList.add("has-cover");
  });
  image.addEventListener("error", () => image.remove());
  disc.append(image);
  image.src = url;
}

function showTrack(track, state) {
  if (state === "stopped") {
    if (!badge) return;
    badge.classList.remove("is-playing");
    currentPlaying = false;
    stopTimer ??= setTimeout(() => {
      stopTimer = undefined;
      const previous = badge;
      badge = currentPlaying = undefined;
      transitionBadge(previous);
    }, stopGraceMs);
    return;
  }
  clearTimeout(stopTimer);
  stopTimer = undefined;
  if (!track) {
    badge?.remove();
    removeLeavingBadge();
    badge = currentTrack = currentPlaying = undefined;
    return;
  }
  const playing = state === "playing";
  if (track === currentTrack && playing === currentPlaying) return;
  const switched = track !== currentTrack && trackKey(track) !== trackKey(currentTrack);
  const newBadge = !badge || switched;
  if (newBadge) {
    const previous = badge;
    badge = badgeTemplate.cloneNode(true);
    if (previous) transitionBadge(previous);
    badge.classList.add("now-playing--entering");
    if (switched && currentTrack) badge.classList.add("now-playing--next");
    badgeSlot.prepend(badge);
  }
  if (newBadge || playing !== currentPlaying) badge.classList.toggle("is-playing", playing);
  currentPlaying = playing;
  if (!newBadge && track === currentTrack) return;

  if (newBadge || track.coverUrl !== currentTrack?.coverUrl) {
    showCover(badge.querySelector(".now-playing-disc"), track.coverUrl);
  }
  badge.querySelector(".now-playing-title").textContent = track.title || "未知曲目";
  const artist = badge.querySelector(".now-playing-artist");
  artist.textContent = track.artists.filter(Boolean).join(" · ");
  artist.hidden = !artist.textContent;
  currentTrack = track;
}

const display = createDisplay(document.querySelector("#lyrics"), { onTrack: showTrack });
const style = document.querySelector("#custom-style");
let styleKey;

async function refreshLayout(key) {
  try {
    const response = await fetch("/api/layout");
    if (!response.ok) return;
    const layout = await response.json();
    if (key === styleKey) applyLayout(document.documentElement, layout);
  } catch (error) {
    console.error("无法读取输出布局", error);
  }
}

const client = connect((state, at) => {
  if (state) {
    const key = `${state.serverId}.${state.styleRevision}`;
    if (key !== styleKey) {
      if (styleKey || state.styleRevision > 0) style.href = `/obs-custom.css?v=${encodeURIComponent(key)}`;
      styleKey = key;
      refreshLayout(key);
    }
  }
  display.setState(state, at);
});
const chosen = new URLSearchParams(location.search).get("renderer");
display.select(renderers.has(chosen) ? chosen : defaultRenderer).catch(console.error);

let inPage = true;
let sourceVisible = true;
function refresh() {
  if (inPage && sourceVisible && !document.hidden) client.resume();
  else client.suspend();
}
document.addEventListener("visibilitychange", refresh);
window.addEventListener("pagehide", () => { inPage = false; refresh(); });
window.addEventListener("pageshow", () => { inPage = true; refresh(); });
window.addEventListener("obsSourceVisibleChanged", (event) => {
  sourceVisible = event.detail?.visible !== false;
  refresh();
});
refresh();
