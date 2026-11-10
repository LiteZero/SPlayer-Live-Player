import { createServer } from "node:http";
import { randomBytes } from "node:crypto";
import { readFile } from "node:fs/promises";
import { pathToFileURL } from "node:url";
import { LiveDemo } from "./demo.mjs";

const assets = new Map([
  ["/", ["index.html", "text/html; charset=utf-8"]],
  ["/app.js", ["app.js", "text/javascript; charset=utf-8"]],
  ["/style.css", ["style.css", "text/css; charset=utf-8"]],
]);

export function createDemoServer({ demo = new LiveDemo() } = {}) {
  const managementToken = randomBytes(24).toString("base64url");
  const clients = new Set();
  let dirty = false;
  const markDirty = () => { dirty = true; };
  demo.on("change", markDirty);
  const ticker = setInterval(() => {
    if (!dirty) return;
    dirty = false;
    const event = `data: ${JSON.stringify(demo.snapshot())}\n\n`;
    for (const client of clients) {
      if (client.writableLength > 1024 * 1024) client.destroy();
      else client.write(event);
    }
  }, 250);
  ticker.unref();
  const keepalive = setInterval(() => {
    for (const client of clients) client.write(": keepalive\n\n");
  }, 15_000);
  keepalive.unref();

  const server = createServer(async (request, response) => {
    const port = response.socket.localPort;
    const origin = `http://${request.headers.host}`;
    const json = (code, data) => {
      response.writeHead(code, { "Content-Type": "application/json; charset=utf-8" });
      response.end(JSON.stringify(data));
    };
    response.setHeader("Cache-Control", "no-store");
    response.setHeader("X-Content-Type-Options", "nosniff");
    response.setHeader("Referrer-Policy", "no-referrer");
    response.setHeader("Content-Security-Policy", "default-src 'self'; img-src 'self' data:; script-src 'self'; style-src 'self'; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'");
    if (![`127.0.0.1:${port}`, `localhost:${port}`].includes(request.headers.host) ||
        (request.headers.origin && request.headers.origin !== origin) ||
        request.headers["sec-fetch-site"] === "cross-site") return json(403, { error: "仅接受本机同源访问" });
    try {
      const url = new URL(request.url, origin);
      if (request.method === "GET" && assets.has(url.pathname)) {
        const [name, contentType] = assets.get(url.pathname);
        let content = await readFile(new URL(`./public/${name}`, import.meta.url), "utf8");
        if (name === "index.html") content = content.replace("__MANAGEMENT_TOKEN__", managementToken);
        response.writeHead(200, { "Content-Type": contentType });
        return response.end(content);
      }
      if (request.method === "GET" && url.pathname === "/api/state") return json(200, demo.snapshot());
      if (request.method === "GET" && url.pathname === "/api/events") {
        if (clients.size >= 10) return json(429, { error: "打开的验证页面过多" });
        response.writeHead(200, { "Content-Type": "text/event-stream", Connection: "keep-alive" });
        response.write(`data: ${JSON.stringify(demo.snapshot())}\n\n`);
        clients.add(response);
        response.on("close", () => clients.delete(response));
        return;
      }
      if (request.method !== "POST") return json(404, { error: "接口不存在" });
      if (request.headers["x-demo-token"] !== managementToken) return json(403, { error: "请从本地验证网页执行操作" });
      if (request.headers["content-type"]?.split(";")[0] !== "application/json") return json(415, { error: "需要 JSON 请求" });
      const chunks = [];
      let size = 0;
      for await (const chunk of request) {
        size += chunk.length;
        if (size > 20_000) return json(413, { error: "请求过大" });
        chunks.push(chunk);
      }
      let data;
      try { data = JSON.parse(Buffer.concat(chunks).toString("utf8")); } catch { return json(400, { error: "JSON 格式错误" }); }
      if (!data || typeof data !== "object" || Array.isArray(data)) return json(400, { error: "需要 JSON 对象" });
      switch (url.pathname) {
        case "/api/login/qr": await demo.startQr(); break;
        case "/api/login/cancel": demo.cancelLogin(); break;
        case "/api/login/check": await demo.checkAccount(); break;
        case "/api/login/cookie": await demo.importCookie(data.cookie); break;
        case "/api/logout": demo.logout(); break;
        case "/api/room/connect": await demo.connect(data.roomId); break;
        case "/api/room/disconnect": demo.disconnect(); break;
        default: return json(404, { error: "接口不存在" });
      }
      return json(200, { ok: true });
    } catch (error) {
      // 上游错误经过 API 适配器归一化，不返回请求对象、Cookie 或原始响应。
      return json(400, { error: error.message || "操作失败，请查看页面状态" });
    }
  });
  server.requestTimeout = 20_000;
  server.headersTimeout = 15_000;
  server.on("close", () => {
    clearInterval(ticker);
    clearInterval(keepalive);
    demo.off("change", markDirty);
    demo.close();
  });
  return { server, demo, stop: () => {
    for (const client of clients) client.end();
    demo.close();
    return new Promise((resolve, reject) => {
      server.close((error) => error ? reject(error) : resolve());
      server.closeIdleConnections();
    });
  } };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const port = Number(process.env.BILI_DEMO_PORT || 19631);
  if (!Number.isInteger(port) || port < 1024 || port > 65535) throw new Error("BILI_DEMO_PORT 必须为 1024–65535 的端口");
  const app = createDemoServer();
  app.server.once("error", (error) => {
    console.error(error.code === "EADDRINUSE" ? `端口 ${port} 已被占用，请更换 BILI_DEMO_PORT` : "本地服务启动失败");
    process.exitCode = 1;
  });
  app.server.listen(port, "127.0.0.1", () => {
    console.log(`Bilibili 验证网页：http://127.0.0.1:${port}`);
    console.log("仅内存保存登录态；扫码和连接直播间均由网页按钮触发。Ctrl+C 退出。");
  });
  for (const signal of ["SIGINT", "SIGTERM"]) process.once(signal, () => app.stop().then(() => process.exit(0)));
}
