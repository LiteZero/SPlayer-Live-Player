import { readFileSync } from "node:fs";
import { runInNewContext } from "node:vm";

export const line = (word, startTime, extras = {}) => ({
  startTime, endTime: startTime + 2000, words: [{ word, startTime, endTime: startTime + 2000 }],
  ...extras,
});
export const mockTrack = (id, title) => ({
  id, source: "local", title, artists: [{ name: "模拟宿主" }], duration: 60000,
});

export function startMockHost({ origin, read, log = console, request = globalThis.fetch, music, player = {} }) {
  const handlers = new Map();
  const timers = new Set();
  let stopped = false;
  const plugin = readFileSync(new URL("../dist/splayer-live-lyrics.js", import.meta.url), "utf8");
  runInNewContext(plugin, {
    Buffer, URL,
    setTimeout(callback, delay) {
      if (stopped) return;
      const timer = setTimeout(() => { timers.delete(timer); callback(); }, delay);
      timers.add(timer);
      return timer;
    },
    clearTimeout(timer) { timers.delete(timer); clearTimeout(timer); },
    splayer: {
      apiLevel: 5, appVersion: "mock-1.2.0",
      register() {},
      getSetting: (key) => key === "backend" ? origin : undefined,
      onSettingChange() {},
      music,
      player: { on: (name, listener) => handlers.set(name, listener), getNowPlaying: read, ...player },
      async request(url, options) {
        const response = await request(url, {
          method: options.method, headers: options.headers, body: options.body,
          signal: AbortSignal.timeout(options.timeout),
        });
        return { status: response.status, body: await response.json() };
      },
      log,
    },
  }, { filename: "splayer-live-lyrics.js" });
  return {
    emit(event, payload) { if (!stopped) handlers.get(event)?.(payload); },
    stop() {
      stopped = true;
      handlers.clear();
      for (const timer of timers) clearTimeout(timer);
      timers.clear();
    },
  };
}
