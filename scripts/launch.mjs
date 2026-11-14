import { spawn } from "node:child_process";
import { readFile } from "node:fs/promises";
import { createApp } from "../backend/server.mjs";
import { DEFAULT_PORT, VERSION } from "../shared/protocol.mjs";

const port = Number(process.env.SPLAYER_LIVE_PORT ?? DEFAULT_PORT);
if (!Number.isInteger(port) || port < 1024 || port > 65535) {
  console.error("端口设置无效，请使用 1024–65535 之间的整数。");
  process.exitCode = 1;
} else {
  const origin = `http://127.0.0.1:${port}`;
  const metadata = JSON.parse(await readFile(new URL("../release.json", import.meta.url), "utf8"));
  function openSettings() {
    if (process.env.SPLAYER_LIVE_NO_OPEN === "1") return;
    // The URL is constructed locally; no shell text comes from account or chat data.
    const opener = spawn("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", "Start-Process $env:SPLAYER_SETTINGS_URL"], {
      windowsHide: true, stdio: "ignore", env: { ...process.env, SPLAYER_SETTINGS_URL: origin + "/" },
    });
    opener.on("error", () => console.log(`请在浏览器打开：${origin}/`));
    opener.unref();
  }
  const app = createApp();
  app.server.once("error", async (error) => {
    app.close(() => {});
    if (error.code === "EADDRINUSE") {
      try {
        const response = await fetch(origin + "/api/status", { signal: AbortSignal.timeout(2000), redirect: "error" });
        const state = await response.json();
        if (response.ok && state.protocolVersion === VERSION && typeof state.serverId === "string" &&
          typeof state.lineCount === "number" && Array.isArray(state.trace)) {
          console.log(`歌词设置服务已在运行：${origin}/`);
          console.log("当前窗口不会接管或关闭已经运行的服务。");
          openSettings();
          return;
        }
      } catch { /* A different listener must never be terminated by the launcher. */ }
      console.error(`端口 ${port} 已被其他程序占用，请关闭冲突程序后重试。`);
    } else console.error(`服务启动失败：${error.message}`);
    process.exitCode = 1;
  });
  app.server.listen(port, "127.0.0.1", () => {
    console.log(`SPlayer Live Player v${metadata.version}`);
    console.log(`歌词设置：${origin}/\nOBS 输出：${origin}/obs`);
    console.log("请保留此窗口；按 Ctrl+C 可停止本次启动的服务。");
    console.log("首次使用请导入 plugins 文件夹中的插件，再在设置页登录并连接 B 站。");
    openSettings();
  });
  for (const signal of ["SIGINT", "SIGTERM"]) process.once(signal, () => app.close());
}
