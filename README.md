# SPlayer Live Player

通过 SPlayer-Next 插件采集歌词与播放状态，经本地后端传递给网页，作为 OBS 等直播软件的浏览器源叠加到直播画面中。
网页提供可切换的歌词展示方式，AMLL（Apple Music-like Lyrics）是其中一种可选渲染器。

首版在同一台电脑运行 SPlayer、后端与 OBS。正式应用仍在准备，已完成后端控制 SPlayer 搜索并播放首个结果的独立验证。
长期功能包含弹幕「点歌 xxx」及未来更多指令。B 站独立示例已实测游客收弹幕，登录模式的身份验收待完成。

## 从这里开始

1. 阅读 [需求与验收](docs/requirements.md)，了解已确认需求与待定细节。
2. 阅读 [架构方案](docs/architecture.md)，了解插件、后端、同步时钟与可替换渲染器的职责。
3. 阅读 [渲染器接口草案](docs/renderers.md)，了解性能与扩展边界。
4. 参考 [AMLL 接入分析](docs/amll-integration.md) 和 [开发计划](docs/roadmap.md) 进入后续验证。

完整入口见 [项目文档索引](docs/README.md)。
点歌验证的运行方式见 [验证程序](experiments/song-request/README.md)，实测结果见 [点歌与后端控制](docs/song-requests.md)。
B 站直播间到后端的接入依据见 [弹幕接入可行性方案](docs/bilibili-ingress.md)和 [鉴权与用户信息方案](docs/bilibili-auth.md)。
人工验收入口见 [B 站登录与弹幕示例](experiments/bilibili-live/README.md)，支持二维码登录、Cookie 导入、账号检查和游客连接。

## 当前状态

- Git 仓库已建立，默认分支为 `main`。
- 产品方向、OBS 浏览器源、同机部署及多种展示方式已确认。
- 正式歌词应用工程尚未建立；`experiments/song-request/` 为点歌验证代码，`experiments/bilibili-live/` 为独立登录及收弹幕示例。
- `SPlayer-docs/docs/` 保留原始宿主文档；其中 `.vitepress/` 是参考站点配置。
- AMLL 克隆位于同级目录 `../applemusic-like-lyrics/`，作为只读参考，不包含在本仓库内。
- B 站接口资料位于同级目录 `../bilibili-api-collect/`，保持只读；游客实测结论和二维码域名以 [验证记录](experiments/bilibili-live/guest-validation.json) 为准。

## 协作约定

- 本项目说明放在 `docs/`，项目说明使用中文，接口名称保持原名。
- 区分已确认需求、建议方案和待验证行为，修改需求时同步维护计划与决策记录。
- 使用 Conventional Commits：`<类型>: <中文摘要>`。
- 后续代码格式、检查和测试命令在工程建立后补充。

## 致谢

感谢以下项目及其贡献者提供的播放器接口、歌词组件和接口资料：

| 项目 | 本项目参考内容 |
| --- | --- |
| [SPlayer-Next](https://github.com/SPlayer-Dev/SPlayer-Next) | 插件机制、歌词事件、搜索与播放接口及相关文档 |
| [Apple Music-like Lyrics](https://github.com/Steve-xmh/applemusic-like-lyrics) | 可选 AMLL 歌词渲染器的组件、类型与示例 |
| [bilibili-api-collect](https://github.com/bilibili-plugins/bilibili-api-collect) | 直播消息流、弹幕结构和鉴权资料；同时感谢其[上游项目](https://github.com/SocialSisterYi/bilibili-API-collect) |
