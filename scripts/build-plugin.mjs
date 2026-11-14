import { build } from "esbuild";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("../", import.meta.url));
await build({
  absWorkingDir: root,
  entryPoints: ["plugin/collector.js"],
  outfile: "dist/splayer-live-lyrics.js",
  format: "iife",
  platform: "neutral",
  target: "es2020",
  bundle: true,
  banner: { js: `/**
 * @name SPlayer Live Player 歌词与点歌
 * @id litezero.live-player.lyrics
 * @version 0.4.0
 * @description 同步歌词与封面，按后端点歌顺序逐首安排 SPlayer 下一首播放
 * @apiLevel 4
 * @grant network control
 */` },
  legalComments: "none",
});
console.log("插件已生成：dist/splayer-live-lyrics.js");
