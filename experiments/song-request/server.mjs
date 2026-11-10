import { createServer as createHttpServer } from "node:http";
import { randomUUID } from "node:crypto";
import { pathToFileURL } from "node:url";

const terminal = new Set(["playing", "unconfirmed", "failed", "expired"]);
const platforms = new Set(["netease", "qqmusic", "kugou"]);

/** 创建仅用于验证点歌链路的内存后端。 */
export function createSongRequestServer({ commandTimeoutMs = 60_000 } = {}) {
  const commands = new Map();
  let client = null;

  function expire() {
    for (const command of commands.values()) {
      if (!terminal.has(command.status) && Date.now() >= command.deadline) {
        command.status = "expired";
        command.error = "验证超时；不自动重放，播放结果可能未知";
      }
    }
  }

  return createHttpServer(async (request, response) => {
    const send = (status, data) => {
      response.writeHead(status, {
        "Content-Type": "application/json; charset=utf-8",
        "Cache-Control": "no-store",
      });
      response.end(JSON.stringify(data));
    };
    try {
      expire();
      const port = response.socket.localPort;
      if (
        request.headers.origin ||
        ![`127.0.0.1:${port}`, `localhost:${port}`].includes(request.headers.host)
      ) {
        return send(403, { error: "仅接受本机程序请求" });
      }
      const url = new URL(request.url, `http://127.0.0.1:${port}`);
      if (request.method === "GET" && url.pathname === "/health") {
        return send(200, {
          protocol: 1,
          pluginConnected: !!client && Date.now() - client.lastSeen < 15_000,
          client,
        });
      }
      if (request.method === "GET" && url.pathname.startsWith("/api/commands/")) {
        const command = commands.get(url.pathname.slice("/api/commands/".length));
        return command ? send(200, command) : send(404, { error: "未知命令" });
      }
      if (request.method !== "POST") return send(404, { error: "未知接口" });
      if (request.headers["content-type"]?.split(";")[0] !== "application/json") {
        return send(415, { error: "需要 application/json" });
      }
      let bytes = 0;
      const chunks = [];
      for await (const chunk of request) {
        bytes += chunk.length;
        if (bytes > 16_384) return send(413, { error: "请求过大" });
        chunks.push(chunk);
      }
      let body;
      try {
        body = JSON.parse(Buffer.concat(chunks).toString("utf8"));
      } catch {
        return send(400, { error: "无效 JSON" });
      }
      if (!body || typeof body !== "object" || Array.isArray(body)) {
        return send(400, { error: "请求必须是对象" });
      }
      if (url.pathname === "/api/commands") {
        const query = typeof body.query === "string" ? body.query.trim() : "";
        if (
          body.type !== "requestSong" ||
          !query || query.length > 200 || !platforms.has(body.platform)
        ) {
          return send(400, { error: "需要 requestSong、1–200 字符 query 和有效 platform" });
        }
        if ([...commands.values()].some((command) => !terminal.has(command.status))) {
          return send(409, { error: "已有验证命令执行中，请等待结果" });
        }
        const command = {
          id: randomUUID(),
          type: "requestSong",
          query,
          platform: body.platform,
          status: "queued",
          createdAt: Date.now(),
          deadline: Date.now() + commandTimeoutMs,
        };
        commands.set(command.id, command);
        if (commands.size > 100) commands.delete(commands.keys().next().value);
        return send(202, command);
      }
      if (!body.clientId || typeof body.clientId !== "string" || body.clientId.length > 100) {
        return send(400, { error: "缺少有效 clientId" });
      }
      if (url.pathname === "/bridge/poll") {
        if (!Number.isInteger(body.apiLevel) || body.apiLevel < 4) {
          return send(400, { error: "需要 SPlayer 插件 API 4 或以上" });
        }
        const active = [...commands.values()].find((command) => !terminal.has(command.status));
        if (
          client && client.clientId !== body.clientId &&
          (Date.now() - client.lastSeen < 15_000 || active?.clientId === client.clientId)
        ) {
          return send(409, { error: "已有插件会话连接" });
        }
        client = {
          clientId: body.clientId,
          apiLevel: body.apiLevel,
          appVersion: String(body.appVersion ?? ""),
          lastSeen: Date.now(),
        };
        const command = [...commands.values()].find((item) => item.status === "queued");
        if (command) {
          command.status = "dispatched";
          command.clientId = body.clientId;
          command.dispatchedAt = Date.now();
        }
        return send(200, { command: command ?? null });
      }
      if (url.pathname === "/bridge/report") {
        const command = commands.get(body.id);
        if (!command) return send(404, { error: "未知命令" });
        if (command.clientId !== body.clientId) return send(409, { error: "命令会话不匹配" });
        if (terminal.has(command.status)) return send(200, { ok: true, status: command.status });
        if (!["playing", "unconfirmed", "failed"].includes(body.status)) {
          return send(400, { error: "无效执行结果" });
        }
        command.status = body.status;
        command.result = {
          track: body.track ?? null,
          requestAccepted: body.requestAccepted === true,
          error: typeof body.error === "string" ? body.error.slice(0, 1000) : null,
          phase: body.phase,
        };
        command.completedAt = Date.now();
        if (client?.clientId === body.clientId) client.lastSeen = Date.now();
        return send(200, { ok: true, status: command.status });
      }
      return send(404, { error: "未知接口" });
    } catch (error) {
      if (!response.headersSent) send(500, { error: error.message });
      else response.end();
    }
  });
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const port = Number(process.env.SPLAYER_LIVE_PROBE_PORT ?? 19630);
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error("无效端口");
  const server = createSongRequestServer();
  server.on("error", (error) => {
    console.error(error.message);
    process.exitCode = 1;
  });
  server.listen(port, "127.0.0.1", () => {
    console.log(`点歌验证后端：http://127.0.0.1:${port}`);
  });
}
