const [query, platform = "netease"] = process.argv.slice(2);
if (!query?.trim()) {
  console.error('用法：node experiments/song-request/request.mjs "歌曲名" [netease|qqmusic|kugou]');
  process.exit(1);
}
const base = `http://127.0.0.1:${process.env.SPLAYER_LIVE_PROBE_PORT ?? 19630}`;
const created = await fetch(`${base}/api/commands`, {
  method: "POST",
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify({ type: "requestSong", query, platform }),
  signal: AbortSignal.timeout(5000),
});
const command = await created.json();
if (!created.ok) {
  console.error(JSON.stringify(command, null, 2));
  process.exit(1);
}
console.log(`验证命令：${command.id}`);
for (let attempt = 0; attempt < 70; attempt++) {
  const response = await fetch(`${base}/api/commands/${command.id}`, {
    signal: AbortSignal.timeout(5000),
  });
  if (!response.ok) throw new Error(`查询命令失败：${response.status}`);
  const result = await response.json();
  if (!["queued", "dispatched"].includes(result.status)) {
    console.log(JSON.stringify(result, null, 2));
    process.exit(result.status === "playing" ? 0 : 1);
  }
  await new Promise((resolve) => setTimeout(resolve, 1000));
}
console.error("等待超时，请查询 /health 确认插件连接");
process.exitCode = 1;
