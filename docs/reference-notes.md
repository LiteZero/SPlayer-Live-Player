# 参考资料分析

来源：本地 `SPlayer-docs/docs` 快照。整理日期：2026-11-11。
以下结论仅描述已提供的文档，不代表已运行或验证上游应用。
本项目已确定为插件采集、同机后端、OBS 网页歌词展示，提供可替换的渲染方式。
AMLL 为可选实现，分析见 [AMLL 接入](amll-integration.md)与[渲染器接口](renderers.md)。

## 产品与开发结构

[首页](../SPlayer-docs/docs/index.md)与[指南](../SPlayer-docs/docs/guide.md)将 SPlayer-Next 描述为桌面音乐播放器，包含本地音乐、在线音源、自建曲库、歌词、系统媒体控制和插件。

[贡献指南](../SPlayer-docs/docs/contributing.md)描述 Electron 主进程、preload、Vue 3 渲染层、独立窗口、Rust 原生模块与跨进程共享目录。
这是独立桌面方向的参考结构，不是仅凭文档便能启动的完整工程。

[原生模块](../SPlayer-docs/docs/native.md)说明音频引擎基于 Rust、FFmpeg 和 rodio，通过 NAPI-RS 提供能力；其余模块处理媒体控制、任务栏歌词与缩略图。
当前目录没有这些原生模块的实现和构建配置。

## HTTP 接口约束

来源：[外部 API](../SPlayer-docs/docs/api.md)。

- 默认关闭；启用后默认监听本机 `127.0.0.1:14558`，基础路径为 `/api`。
- 文档说明该 HTTP 服务不含鉴权；局域网访问需要宿主显式开启。
- 查询：`info`、`status`、`queue`、`volume`、`now-playing`、`lyrics`。
- 控制：`play`、`pause`、`stop`、`next`、`prev`、`seek`、`volume`。
- 控制成功响应为 `{ "ok": true }`；非法参数返回 HTTP 400 和 `{ "error": "原因" }`。
- `seek` 使用 `positionMs`；音量为 0–1；时间单位为毫秒。
- 队列参数 `offset` 为非负整数，默认 0；`limit` 为 1–100，默认 50。
- 队列返回 `tracks`、`total`、`currentIndex`、`offset`；无当前项时索引为 -1。
- `now-playing` 不带完整歌词，完整解析歌词由 `lyrics` 单独返回。

文档没有给出通过 HTTP 加入队列、搜索、调整播放模式的端点，不应自行假设存在。

## WebSocket 接口约束

来源：[WebSocket API](../SPlayer-docs/docs/socket.md)。

- 需先开启外部 API，再额外开启 WebSocket；默认地址为 `ws://127.0.0.1:14558/ws`。
- 下行通过 `kind` 区分 `hello`、`event`、`ack`、`error`。
- 事件形态为 `{ "kind": "event", "type": "…", "data": … }`。
- 上行通过 `op` 区分 `play`、`pause`、`stop`、`next`、`prev`、`seek`、`setVolume`。
- HTTP 设置音量路径为 `/api/volume`；WebSocket 操作名为 `setVolume`，两者名称不能直接混用。
- 文档没有穷举事件 `type` 与对应载荷，也没有给出命令请求 ID、心跳或重放协议。

若将来改用宿主外部 WebSocket，需实测事件契约，避免把插件事件载荷直接当作该接口载荷。
目前建议插件通过 HTTP 上传到本项目后端，后端到网页使用本项目自己的 WebSocket 协议，
两者与宿主的外部 API 是不同接口，首版不要求开启宿主外部 API。

## 当前方案所需的插件能力

来源：[播放控制与事件](../SPlayer-docs/docs/plugins/control.md)、[通用 API](../SPlayer-docs/docs/plugins/api.md)、[运行环境](../SPlayer-docs/docs/plugins/index.md)。

- API 2 支持订阅 `trackChange`、`lyricChange`、`lineChange` 和 `playStateChange`，就绪时发送订阅事件的当前快照。
- `lyricChange` 提供完整 `lines`；`lineChange` 提供行索引及毫秒进度，不承诺逐帧推送。
- API 4 的 `getNowPlaying()` 需要 `control`，提供曲目、状态、进度、倍率、歌词偏移及采样时间戳。
- `splayer.request()` 需要 `network`，可发送 HTTP GET／POST，JSON 请求体需自行序列化。
- API 2 支持声明插件设置及监听设置变化，可配置后端地址和启用状态。
- 插件没有文档化的 Node 模块导入、HTTP 服务监听、子进程启动或 WebSocket 客户端能力。
- 歌词事件没有携带曲目 ID；切歌与初始快照的归属、顺序和异步查询竞争需要实测。

插件采集后端与网页服务需分开交付；是否能提供用户期望的自动启动体验，取决于后续分发方案。

## 数据与扩展边界

| 主题 | 已知内容 | 进一步确认 |
| --- | --- | --- |
| 曲目 | `Track` 包含 ID、来源、标题、艺术家、时长等；插件曲目需要保留来源信息 | 所选版本的实际响应及可选字段 |
| 歌词 | 类型参考定义逐行与逐字数据，时间为毫秒 | HTTP 歌词响应完整外层结构及目标格式 |
| 插件 | 独立 utility process 中为每个插件创建 `node:vm` 上下文，通过 `splayer` 调用宿主 | 首版是否需要插件，以及目标 API 级别 |
| MCP | 独立开关与生命周期，默认端口 14559，使用 `X-MCP-Key`；能力比 HTTP 控制范围更广 | 是否有明确 AI 或高级控制需求 |
| 自建曲库 | 支持 Subsonic 系、Jellyfin、Emby | 本项目是否直接连接，还是由 SPlayer 处理 |

来源：[类型](../SPlayer-docs/docs/types.md)、[插件架构](../SPlayer-docs/docs/plugins/index.md)、[MCP](../SPlayer-docs/docs/mcp.md)、[流媒体](../SPlayer-docs/docs/streaming.md)。

## 资料缺口

- 快照包含 56 个 Markdown 文件及站点配置、组件、样式与图标，共 64 个文件；未提供应用源码和完整构建工程。
- 快照的取得日期、来源提交号与对应 SPlayer 发行版本尚未提供。
- 用户已补充直播歌词、OBS 浏览器源、同机部署和多渲染方式需求，具体展示样式与性能指标待明确。
- 尚未取得真实宿主事件记录、歌词与曲目归属证据，以及偏移和时钟校准结果。
- 尚未运行 AMLL 或 OBS 实测，组件适配与性能分析仍属于方案阶段。
