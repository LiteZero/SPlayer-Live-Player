/**
 * @name Live Player 点歌链路验证
 * @id litezero.live-player.song-request-probe
 * @version 0.1.0
 * @description 从本地验证后端取命令，搜索并播放第一个结果
 * @apiLevel 4
 * @grant network control
 */
(() => {
  splayer.register({
    controls: true,
    settings: [
      { key: "enabled", type: "switch", label: "启用点歌验证", default: true },
      {
        key: "backend", type: "text", label: "本地验证后端",
        default: "http://127.0.0.1:19630",
      },
    ],
  });

  const clientId = `probe-${Date.now()}-${Math.random().toString(36).slice(2)}`;
  let pending = null;
  let reportedError = false;
  const enabled = () => splayer.getSetting("enabled") !== false;
  const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

  /** 仅向本机验证服务提交请求，不要求宿主打开外部 API。 */
  async function post(path, body) {
    const base = String(splayer.getSetting("backend") || "http://127.0.0.1:19630");
    const address = new URL(base);
    if (
      address.protocol !== "http:" || address.hostname !== "127.0.0.1" ||
      address.username || address.password || address.search || address.hash ||
      address.pathname !== "/"
    ) throw new Error("验证后端必须是 http://127.0.0.1:端口");
    const result = await splayer.request(`${address.origin}${path}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ ...body, clientId }),
      responseType: "json",
      timeout: 5000,
    });
    if (result.status !== 200) throw new Error(`验证后端响应 ${result.status}`);
    if (!result.body || typeof result.body !== "object") throw new Error("无效后端响应");
    return result.body;
  }

  /** 执行一次命令；播放请求和实际状态确认分别记录。 */
  async function execute(command) {
    let phase = "search";
    let requestAccepted = false;
    let summary = null;
    try {
      if (command.type !== "requestSong") throw new Error("不支持的命令类型");
      const { tracks } = await splayer.music.searchOnline({
        platform: command.platform, query: command.query, page: 1, limit: 1,
      });
      if (!tracks?.length) throw new Error("没有搜索结果");
      if (!enabled()) throw new Error("插件验证已关闭，未请求播放");
      const track = tracks[0];
      summary = { id: track.id, source: track.source, title: track.title };
      phase = "play";
      await splayer.player.playTrack(track);
      requestAccepted = true;
      phase = "confirm";
      for (let attempt = 0; attempt < 20; attempt++) {
        try {
          const now = await splayer.player.getNowPlaying();
          if (
            now.track?.id === track.id && now.track?.source === track.source &&
            now.state === "playing"
          ) {
            return { id: command.id, status: "playing", track: summary, requestAccepted, phase };
          }
        } catch {
          // 查询失败不重发播放请求，继续等待宿主状态。
        }
        await wait(500);
      }
      return {
        id: command.id, status: "unconfirmed", track: summary, requestAccepted, phase,
        error: "播放请求已发出，但未观察到目标曲目处于 playing 状态",
      };
    } catch (error) {
      return {
        id: command.id, status: "failed", track: summary, requestAccepted, phase,
        error: String(error?.message ?? error),
      };
    }
  }

  async function tick() {
    try {
      if (pending) {
        await post("/bridge/report", pending);
        splayer.log.info(`点歌验证结果：${pending.status}`);
        pending = null;
      }
      if (enabled()) {
        const { command } = await post("/bridge/poll", {
          apiLevel: splayer.apiLevel, appVersion: splayer.appVersion,
        });
        if (reportedError) splayer.log.info("点歌验证后端已恢复连接");
        reportedError = false;
        if (command) pending = await execute(command);
      }
    } catch (error) {
      if (!reportedError) splayer.log.warn(String(error?.message ?? error));
      reportedError = true;
    } finally {
      setTimeout(tick, 1000);
    }
  }

  if (
    splayer.apiLevel < 4 || typeof splayer.music?.searchOnline !== "function" ||
    typeof splayer.player?.playTrack !== "function" ||
    typeof splayer.player?.getNowPlaying !== "function"
  ) {
    splayer.log.error("点歌验证需要宿主插件 API 4 或以上");
    return;
  }
  tick();
})();
