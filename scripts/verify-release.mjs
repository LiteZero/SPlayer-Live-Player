import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { once } from "node:events";
import { mkdtemp, mkdir, readFile, readdir, stat, writeFile } from "node:fs/promises";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { basename, join, resolve, sep } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { setTimeout as delay } from "node:timers/promises";
import { WebSocket } from "ws";
import { startMockHost, mockTrack } from "./mock-host.mjs";

const root = fileURLToPath(new URL("../", import.meta.url));
let archive = process.argv[2] && resolve(process.argv[2]);
if (!archive) {
  const folder = join(root, "release");
  const candidates = await Promise.all((await readdir(folder)).filter((name) => name.endsWith(".zip"))
    .map(async (name) => ({ path: join(folder, name), mtime: (await stat(join(folder, name))).mtimeMs })));
  archive = candidates.sort((a, b) => b.mtime - a.mtime)[0]?.path;
}
if (!archive) throw new Error("请先执行 npm run release，或传入 ZIP 路径");
const digest = createHash("sha256").update(await readFile(archive)).digest("hex");
assert.equal((await readFile(archive + ".sha256", "utf8")).split(/\s+/)[0], digest, "ZIP 校验值");
const scratch = await mkdtemp(join(tmpdir(), "splayer-release-check-"));
const destination = join(scratch, "首次解压 验证");
await mkdir(destination);
const extraction = spawnSync("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command",
  "Expand-Archive -LiteralPath $env:SPLAYER_VERIFY_ZIP -DestinationPath $env:SPLAYER_VERIFY_DIR"], {
  windowsHide: true, stdio: "inherit", env: { ...process.env, SPLAYER_VERIFY_ZIP: archive, SPLAYER_VERIFY_DIR: destination },
});
if (extraction.error) throw extraction.error;
assert.equal(extraction.status, 0, "ZIP 解压成功");
const entries = await readdir(destination);
assert.equal(entries.length, 1, "压缩包只有一个根目录");
const unpacked = join(destination, entries[0]);
const manifest = JSON.parse(await readFile(join(unpacked, "manifest.json"), "utf8"));
assert.equal(manifest.platform, "win32");
assert.equal(manifest.arch, "x64");
for (const item of manifest.files) {
  const target = resolve(unpacked, item.path);
  assert.ok(target.startsWith(unpacked + sep), "校验路径必须位于包内");
  assert.equal(createHash("sha256").update(await readFile(target)).digest("hex"), item.sha256, item.path);
  assert.doesNotMatch(item.path, /(?:\.local$|^\.env|^node_modules\/|^experiments\/|^tmp\/|^\.git\/)/, "不含本地配置及开发文件");
}
assert.equal(await readFile(join(unpacked, "plugins/splayer-live-lyrics.js"), "utf8"),
  await readFile(join(root, "dist/splayer-live-lyrics.js"), "utf8"), "交付实际构建的插件");

const reserved = createServer();
reserved.listen(0, "127.0.0.1");
await once(reserved, "listening");
const port = reserved.address().port;
await new Promise((resolveClose) => reserved.close(resolveClose));
const origin = `http://127.0.0.1:${port}`;
const runtime = join(unpacked, "runtime/node.exe");
// Keep this check offline: only QR generation/polling is mocked, the packaged QR renderer is real.
const mockPlatform = join(scratch, "mock-platform.mjs");
await writeFile(mockPlatform, `globalThis.fetch = async (address) => {
  const url = new URL(address);
  if (url.hostname !== "passport.bilibili.com") throw new Error("验收禁止外部请求");
  if (url.pathname.endsWith("/generate")) return new Response(JSON.stringify({ code: 0, data: {
    qrcode_key: "release-fixture-only", url: "https://account.bilibili.com/scan?qrcode_key=release-fixture-only"
  }}), {headers: {"Content-Type":"application/json"}});
  if (url.pathname.endsWith("/poll")) return new Response(JSON.stringify({code:0,data:{code:86101}}));
  throw new Error("验收禁止未知接口");
};\n`);
const environment = { ...process.env, SPLAYER_LIVE_PORT: String(port), SPLAYER_LIVE_NO_OPEN: "1", NODE_PATH: "", NODE_OPTIONS: "" };
const child = spawn(runtime, ["--import", pathToFileURL(mockPlatform).href, "scripts/launch.mjs"], {
  cwd: unpacked, windowsHide: true, env: environment, stdio: ["ignore", "pipe", "pipe"],
});
let logs = "", host, stream;
child.stdout.on("data", (bytes) => { logs = (logs + bytes).slice(-10000); });
child.stderr.on("data", (bytes) => { logs = (logs + bytes).slice(-10000); });
async function until(check, label, timeout = 10000) {
  const end = Date.now() + timeout;
  while (Date.now() < end) {
    try { const result = await check(); if (result) return result; } catch { /* Process may still be starting. */ }
    await delay(40);
  }
  throw new Error(`${label} 超时\n${logs}`);
}
try {
  const status = await until(async () => (await fetch(origin + "/api/status")).json(), "解压包启动");
  assert.equal(status.status, "host_waiting");
  assert.ok(logs.includes(`v${manifest.version}`));
  for (const path of ["/", "/obs", "/settings.css", "/settings.mjs", "/requests.mjs", "/obs.mjs", "/shared/protocol.mjs", "/shared/layout.mjs"]) {
    assert.equal((await fetch(origin + path)).status, 200, path);
  }
  const management = async (path, body = {}) => {
    const response = await fetch(origin + path, { method: "POST", headers: {
      "Content-Type": "application/json", "X-SPlayer-Live-Management": "1" }, body: JSON.stringify(body) });
    assert.equal(response.status, 200, await response.text());
  };
  await management("/api/bilibili/login/qr");
  const qrState = await (await fetch(origin + "/api/requests")).json();
  assert.match(qrState.bili.login.image, /^data:image\/png;base64,/);
  await management("/api/bilibili/login/cancel");
  const frames = [];
  stream = new WebSocket(origin.replace("http:", "ws:") + "/ws", { origin });
  stream.on("message", (bytes) => frames.push(JSON.parse(bytes.toString())));
  await once(stream, "open");
  const tracks = [mockTrack("current", "当前曲目")];
  let currentIndex = 0;
  host = startMockHost({ origin, read: async () => ({ track: tracks[currentIndex], state: "playing", position: 100, lyricAvailable: false }),
    log: { info() {}, warn() {}, error() {} }, music: { searchOnline: async ({ query }) =>
      ({ tracks: [{ ...mockTrack(query === "首版验证" ? "first" : "second", query), source: "netease" }] }) },
    player: {
      getStatus: async () => ({ currentIndex, repeat: "list", shuffle: "off" }),
      getQueue: async ({ offset, limit }) => ({ tracks: tracks.slice(offset, offset + limit), currentIndex, total: tracks.length, offset }),
      addToQueue: async (added, position) => { assert.equal(position, "next"); tracks.splice(currentIndex + 1, 0, ...added); return { count: added.length }; },
    },
  });
  await management("/api/requests/config", { enabled: true, platform: "netease", allowAnonymous: false });
  await management("/api/requests/add", { query: "首版验证" });
  await management("/api/requests/add", { query: "连续验证" });
  await until(async () => (await (await fetch(origin + "/api/requests")).json()).history[0]?.status === "added", "独立包原生入队");
  assert.equal(tracks.length, 2);
  await until(() => frames.some((frame) => frame.document?.track?.id === "current"), "独立包 OBS 快照");
  const waiting = await (await fetch(origin + "/api/requests")).json();
  assert.equal(waiting.scheduled.track.id, "first");
  assert.equal(waiting.pending.length, 1);
  currentIndex = 1;
  host.emit("trackChange", { track: tracks[currentIndex] });
  await until(async () => (await (await fetch(origin + "/api/requests")).json()).scheduled?.track.id === "second", "独立包播放采样推进下一首");
  assert.deepEqual(tracks.map((track) => track.id), ["current", "first", "second"]);
  const style = await fetch(origin + "/api/style", { method: "PUT", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ css: ".lyric-original { color: gold; }" }) });
  assert.equal(style.status, 200);
  assert.match(await readFile(join(unpacked, "obs-custom.css.local"), "utf8"), /gold/);
  // Opening a second launcher must exit without killing/replacing the active instance.
  const second = spawn(runtime, ["scripts/launch.mjs"], { cwd: unpacked, windowsHide: true, env: environment,
    stdio: ["ignore", "pipe", "pipe"] });
  let secondLog = "";
  second.stdout.on("data", (bytes) => { secondLog += bytes; });
  const secondExit = once(second, "exit");
  const timer = setTimeout(() => second.kill(), 5000);
  const [secondCode] = await secondExit;
  clearTimeout(timer);
  assert.equal(secondCode, 0);
  assert.match(secondLog, /已在运行/);
  assert.equal((await (await fetch(origin + "/api/status")).json()).serverId, status.serverId);
  console.log(JSON.stringify({ result: "pass", archive: basename(archive), version: manifest.version,
    pluginVersion: manifest.pluginVersion, checkedFiles: manifest.files.length,
    checks: ["ZIP 与文件校验", "中文及空格路径", "内置 Node 独立启动", "网页资源", "离线模拟扫码 PNG", "实际插件单首下一首预放及播放采样推进", "OBS WebSocket", "样式写入解压目录", "重复启动复用服务"],
  }, null, 2));
} finally {
  host?.stop(); stream?.terminate();
  child.kill();
}
