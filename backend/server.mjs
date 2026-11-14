import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import { fileURLToPath, pathToFileURL } from "node:url";
import { WebSocketServer, WebSocket } from "ws";
import { DEFAULT_PORT, MAX_BODY_BYTES, STALE_MS, VERSION } from "../shared/protocol.mjs";
import { normalizeLayout } from "../shared/layout.mjs";
import { createState } from "./state.mjs";
import { createStyleStore, MAX_CSS_BYTES } from "./style.mjs";
import { BilibiliLive } from "./bilibili/live.mjs";
import { createRequests } from "./requests.mjs";

const defaultCssPath = fileURLToPath(new URL("../obs-custom.css.local", import.meta.url));
const defaultLayoutPath = fileURLToPath(new URL("../obs-layout.json.local", import.meta.url));

const assets = new Map([
  ["/", "web/settings.html"],
  ["/obs", "web/obs.html"],
  ["/settings.css", "web/settings.css"],
  ["/obs.css", "web/obs.css"],
  ["/settings.mjs", "web/settings.mjs"],
  ["/requests.mjs", "web/requests.mjs"],
  ["/obs.mjs", "web/obs.mjs"],
  ["/client.mjs", "web/client.mjs"],
  ["/clock.mjs", "web/clock.mjs"],
  ["/renderers.mjs", "web/renderers.mjs"],
  ["/renderers/single-line.mjs", "web/renderers/single-line.mjs"],
  ["/shared/protocol.mjs", "shared/protocol.mjs"],
  ["/shared/layout.mjs", "shared/layout.mjs"],
]);
const mime = { html: "text/html", css: "text/css", mjs: "text/javascript" };
const writeJson = (response, status, data) => {
  response.writeHead(status, { "Content-Type": "application/json; charset=utf-8" });
  response.end(JSON.stringify(data));
};
const sendCode = (response, status, code) => writeJson(response, status, { code });

async function readJson(request, limit) {
  if (!/^application\/json(?:\s*;|$)/i.test(request.headers["content-type"] ?? "")) {
    throw Object.assign(new Error("json_required"), { status: 415 });
  }
  if (Number(request.headers["content-length"]) > limit) {
    throw Object.assign(new Error("body_too_large"), { status: 413 });
  }
  const chunks = [];
  let bytes = 0;
  // Leave the socket writable long enough to return HTTP 413 for streamed bodies.
  for await (const chunk of request.iterator({ destroyOnReturn: false })) {
    bytes += chunk.length;
    if (bytes > limit) throw Object.assign(new Error("body_too_large"), { status: 413 });
    chunks.push(chunk);
  }
  try {
    return { bytes, message: JSON.parse(Buffer.concat(chunks).toString("utf8")) };
  } catch {
    throw Object.assign(new Error("invalid_json"), { status: 400 });
  }
}

export function createApp({ staleMs = STALE_MS, cssPath = defaultCssPath, layoutPath = defaultLayoutPath,
  bili = new BilibiliLive(), requests = createRequests() } = {}) {
  const style = createStyleStore(cssPath);
  const layoutStore = createStyleStore(layoutPath);
  const onDanmu = (message, context) => requests.ingest(message, context);
  bili.on("danmu", onDanmu);
  const wss = new WebSocketServer({ noServer: true, maxPayload: 1024, perMessageDeflate: false });
  const send = (socket, json) => {
    if (socket.readyState !== WebSocket.OPEN) return;
    if (socket.bufferedAmount > 2 * MAX_BODY_BYTES) socket.terminate();
    else socket.send(json);
  };
  const state = createState({ staleMs, publish(frame) {
    if (!wss.clients.size) return;
    const json = JSON.stringify(frame);
    for (const socket of wss.clients) send(socket, json);
  } });

  const authority = (request) => `127.0.0.1:${request.socket.localPort}`;
  const server = createServer({ requestTimeout: 10000, headersTimeout: 5000 }, async (request, response) => {
    response.setHeader("Cache-Control", "no-store");
    response.setHeader("X-Content-Type-Options", "nosniff");
    const path = request.url.split("?")[0];
    response.setHeader("Content-Security-Policy",
      `default-src 'self'; connect-src 'self' ws://${authority(request)}; frame-ancestors 'self'; object-src 'none'; base-uri 'none'` +
      (path === "/obs" ? "; img-src 'self' https: http: data:" : "; img-src 'self' data:"));
    if (request.headers.host !== authority(request)) return sendCode(response, 403, "invalid_host");
    if (request.method === "GET" && path === "/api/requests") {
      return writeJson(response, 200, { ...requests.snapshot(), bili: bili.snapshot() });
    }
    if (request.method === "POST" && (path.startsWith("/api/requests/") || path.startsWith("/api/bilibili/"))) {
      if (request.headers["x-splayer-live-management"] !== "1" ||
        (request.headers.origin && request.headers.origin !== `http://${authority(request)}`)) return sendCode(response, 403, "invalid_origin");
      try {
        const { message } = await readJson(request, 24000);
        if (!message || typeof message !== "object" || Array.isArray(message)) return sendCode(response, 400, "invalid_message");
        switch (path) {
          case "/api/requests/config": requests.configure(message); break;
          case "/api/requests/add": requests.enqueue(message.query); break;
          case "/api/requests/cancel": requests.cancel(message.commandId); break;
          case "/api/requests/resume": requests.resume(); break;
          case "/api/requests/release": requests.releaseScheduled(message.commandId); break;
          case "/api/bilibili/login/qr": await bili.startQr(); break;
          case "/api/bilibili/login/cancel": bili.cancelLogin(); break;
          case "/api/bilibili/login/check": await bili.checkAccount(); break;
          case "/api/bilibili/login/cookie": await bili.importCookie(message.cookie); break;
          case "/api/bilibili/logout": bili.logout(); break;
          case "/api/bilibili/room/connect": await bili.connect(message.roomId, message.mode); break;
          case "/api/bilibili/room/disconnect": bili.disconnect(); break;
          default: return sendCode(response, 404, "not_found");
        }
        return writeJson(response, 200, { ok: true });
      } catch (error) {
        return writeJson(response, error.status ?? 400, { error: error.message });
      }
    }
    if (request.method === "POST" && ["/api/plugin/commands/poll", "/api/plugin/commands/check",
      "/api/plugin/commands/report", "/api/plugin/queue"].includes(path)) {
      if (request.headers["x-splayer-live-protocol"] !== String(VERSION)) return sendCode(response, 403, "plugin_only");
      try {
        const { message } = await readJson(request, 192000);
        if (!state.authorize(message)) return sendCode(response, 409, "stale_session");
        if (path.endsWith("/poll")) return writeJson(response, 200, { schedulerVersion: 1, command: requests.poll(message) });
        if (path.endsWith("/check")) return writeJson(response, 200, { allowed: requests.check(message) });
        const ok = path.endsWith("/report") ? requests.report(message) : requests.observeQueue(message);
        return ok ? writeJson(response, 200, { ok: true }) : sendCode(response, 409, "invalid_result");
      } catch (error) {
        return sendCode(response, error.status ?? 400, error.status ? error.message : "bad_request");
      }
    }
    if (request.method === "GET" && path === "/api/status") {
      state.expire();
      return writeJson(response, 200, state.status());
    }
    if (request.method === "GET" && path === "/obs-custom.css") {
      try {
        const css = await style.read();
        response.writeHead(200, { "Content-Type": "text/css; charset=utf-8" });
        return response.end(css);
      } catch {
        return sendCode(response, 500, "style_unavailable");
      }
    }
    if (request.method === "GET" && path === "/api/layout") {
      try {
        const layout = normalizeLayout(JSON.parse(await layoutStore.read() || "{}"));
        if (layout) return writeJson(response, 200, layout);
      } catch {
        return sendCode(response, 500, "layout_unavailable");
      }
      return sendCode(response, 500, "layout_unavailable");
    }
    if (request.method === "PUT" && ["/api/style", "/api/layout"].includes(path)) {
      const origin = request.headers.origin;
      if (origin && origin !== `http://${authority(request)}`) return sendCode(response, 403, "invalid_origin");
      const editingLayout = path === "/api/layout";
      let message;
      try {
        ({ message } = await readJson(request, editingLayout ? 4096 : 6 * MAX_CSS_BYTES + 64));
      } catch (error) {
        if (!response.destroyed) {
          response.setHeader("Connection", "close");
          sendCode(response, error.status ?? 400, error.status ? error.message : "bad_request");
        }
        return;
      }
      if (editingLayout) {
        const layout = normalizeLayout(message);
        if (!layout) return sendCode(response, 400, "invalid_layout");
        try {
          if (await layoutStore.save(JSON.stringify(layout))) state.styleChanged();
          return writeJson(response, 200, layout);
        } catch {
          return sendCode(response, 500, "layout_save_failed");
        }
      }
      if (typeof message?.css !== "string") return sendCode(response, 400, "invalid_style");
      if (Buffer.byteLength(message.css, "utf8") > MAX_CSS_BYTES) return sendCode(response, 413, "style_too_large");
      try {
        if (await style.save(message.css)) state.styleChanged();
        return writeJson(response, 200, { ok: true });
      } catch {
        return sendCode(response, 500, "style_save_failed");
      }
    }
    if (request.method === "POST" && ["/api/plugin/session", "/api/plugin/push"].includes(path)) {
      // A cross-origin browser would need a preflight to send this header; the app never enables CORS.
      if (request.headers["x-splayer-live-protocol"] !== String(VERSION)) return sendCode(response, 403, "plugin_only");
      try {
        const hello = path.endsWith("/session");
        const { message, bytes } = await readJson(request, hello ? 4096 : MAX_BODY_BYTES);
        state.expire();
        const result = hello ? state.openSession(message) : state.accept(message, bytes);
        if (hello && result === "ok") requests.sessionChanged(message.sessionId);
        if (!hello && result === "ok") {
          const snapshot = state.status();
          requests.observePlayback({ sessionId: message.sessionId, track: snapshot.track, state: snapshot.playback.state });
        }
        if (result === "ok") return writeJson(response, 200, { ok: true, serverId: state.serverId });
        return sendCode(response, result.startsWith("invalid_") ? 400 : 409, result);
      } catch (error) {
        if (!response.destroyed) {
          response.setHeader("Connection", "close");
          sendCode(response, error.status ?? 400, error.status ? error.message : "bad_request");
        }
      }
      return;
    }
    const asset = request.method === "GET" && assets.get(path);
    if (!asset) return sendCode(response, 404, "not_found");
    try {
      const body = await readFile(new URL(`../${asset}`, import.meta.url));
      response.writeHead(200, { "Content-Type": `${mime[asset.split(".").at(-1)]}; charset=utf-8` });
      response.end(body);
    } catch {
      sendCode(response, 500, "asset_unavailable");
    }
  });

  server.on("upgrade", (request, socket, head) => {
    if (request.url !== "/ws" || request.headers.host !== authority(request) ||
        request.headers.origin !== `http://${authority(request)}` || wss.clients.size >= 16) {
      socket.end("HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n");
      return;
    }
    state.expire();
    wss.handleUpgrade(request, socket, head, (client) => {
      client.on("error", () => client.terminate());
      client.on("message", () => client.close(1008, "read-only stream"));
      client.on("pong", () => { client.awaitingPong = false; });
      // The initial snapshot and subsequent broadcasts run on the same event loop.
      send(client, JSON.stringify(state.snapshot()));
    });
  });
  const expiry = setInterval(() => { state.expire(); requests.expire(); }, Math.min(250, staleMs)).unref();
  const heartbeat = setInterval(() => {
    for (const client of wss.clients) {
      if (client.awaitingPong) client.terminate();
      else if (client.readyState === WebSocket.OPEN) {
        client.awaitingPong = true;
        client.ping();
      }
    }
  }, 10000).unref();
  let disposed = false;
  function dispose() {
    if (disposed) return;
    disposed = true;
    clearInterval(expiry); clearInterval(heartbeat);
    bili.off("danmu", onDanmu); bili.close();
  }
  server.on("close", dispose);
  return {
    server,
    close(callback) {
      dispose();
      for (const socket of wss.clients) socket.terminate();
      wss.close();
      server.close(callback);
    },
  };
}

if (process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url) {
  const port = Number(process.env.SPLAYER_LIVE_PORT ?? DEFAULT_PORT);
  if (!Number.isInteger(port) || port < 1024 || port > 65535) {
    console.error("SPLAYER_LIVE_PORT 必须是 1024–65535 的整数");
    process.exitCode = 1;
  } else {
    const app = createApp();
    app.server.on("error", (error) => {
      console.error(`歌词服务启动失败：${error.message}`);
      process.exitCode = 1;
    });
    app.server.listen(port, "127.0.0.1", () => {
      console.log(`设置：http://127.0.0.1:${port}/\nOBS：http://127.0.0.1:${port}/obs`);
    });
    for (const signal of ["SIGINT", "SIGTERM"]) process.once(signal, () => app.close());
  }
}
