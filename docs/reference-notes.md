# 参考资料分析

来源：本地 `SPlayer-docs/docs` 快照。整理日期：2026-11-11。
以下结论仅描述已提供的文档，不代表已运行或验证上游应用。

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

控制端实现前需通过宿主实测或上游源码补齐事件契约，避免把插件事件载荷直接当作 WebSocket 载荷。

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
- 「Live Player」的产品定义、目标用户、目标平台及首版交互没有在参考资料中确定。
- 若方向是浏览器控制端，还需验证实际宿主的跨域行为和部署环境，现有文档未声明相应支持。
- 若方向是直播音视频播放器，需要补充协议、媒体样例、延迟要求与播放引擎资料。
