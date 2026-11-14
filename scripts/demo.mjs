import { createInterface } from "node:readline";
import { DEFAULT_ORIGIN } from "../shared/protocol.mjs";
import { line, mockTrack, startMockHost } from "./mock-host.mjs";

const origin = process.argv[2] ?? DEFAULT_ORIGIN;
const songs = [
  { track: mockTrack("demo-a", "模拟歌曲 A"), lines: [
    line("初めまして", 0, { romanLyric: "Hajimemashite", translatedLyric: "初次见面" }),
    line("第二行 · 播放时按时间换行", 4000),
    line("第三行 · 暂停和跳转可以随时试", 8000, { translatedLyric: "Pause and seek at any time" }),
  ] },
  { track: mockTrack("demo-b", "模拟歌曲 B"), lines: [
    line("现在显示的是第二首歌", 0),
    line("切歌后不会继续显示第一首的歌词", 4000),
    line("刷新页面也能收到当前歌词", 8000),
  ] },
  { track: mockTrack("demo-empty", "模拟歌曲 · 无歌词"), lines: [] },
];
let song = songs[0];
let state = "playing";
let position = 0;
let anchor = Date.now();
let lyricOffsetMs = 0;
const currentPosition = (at) => Math.min(song.track.duration, position + (state === "playing" ? at - anchor : 0));
const host = startMockHost({ origin, read() {
  const at = Date.now();
  return { track: song.track, state, position: currentPosition(at), speed: 1, lyricOffsetMs,
    lyricAvailable: !!song.lines.length, lyricLineCount: song.lines.length, sendTimestamp: at };
} });

function change(index) {
  song = songs[index];
  position = 0;
  anchor = Date.now();
  host.emit("trackChange", { track: song.track });
  host.emit("lyricChange", { lines: song.lines });
}
function toggle() {
  const now = Date.now();
  position = currentPosition(now);
  anchor = now;
  state = state === "playing" ? "paused" : "playing";
  host.emit("playStateChange", { state, position });
}
change(0);

console.log(`模拟宿主已启动：${origin}/obs\n命令：a / b 切歌，empty 无歌词，p 播放/暂停，seek 毫秒，offset 毫秒，q 退出`);
const input = createInterface({ input: process.stdin, output: process.stdout });
input.on("line", (value) => {
  const [command, arg] = value.trim().split(/\s+/);
  if (command === "q") input.close();
  else if (command === "a" || command === "b" || command === "empty") change(["a", "b", "empty"].indexOf(command));
  else if (command === "p") toggle();
  else if (command === "seek" && Number.isFinite(Number(arg))) {
    position = Math.max(0, Math.min(song.track.duration, Number(arg)));
    anchor = Date.now();
    host.emit("lineChange", { index: -1, position });
  } else if (command === "offset" && Number.isFinite(Number(arg))) {
    lyricOffsetMs = Math.max(-60000, Math.min(60000, Number(arg)));
  }
});
input.on("close", () => host.stop());
