# SPlayer Live Player

通过 SPlayer-Next 插件采集歌词与播放状态，经本地后端传递给网页，作为 OBS 等直播软件的浏览器源叠加到直播画面中。
网页提供可切换的歌词展示方式，AMLL（Apple Music-like Lyrics）是其中一种可选渲染器。

首版在同一台电脑运行 SPlayer、后端与 OBS。当前继续整理需求和技术方案，尚未编写应用代码。

## 从这里开始

1. 阅读 [需求与验收](docs/requirements.md)，了解已确认需求与待定细节。
2. 阅读 [架构方案](docs/architecture.md)，了解插件、后端、同步时钟与可替换渲染器的职责。
3. 阅读 [渲染器接口草案](docs/renderers.md)，了解性能与扩展边界。
4. 参考 [AMLL 接入分析](docs/amll-integration.md) 和 [开发计划](docs/roadmap.md) 进入后续验证。

完整入口见 [项目文档索引](docs/README.md)。

## 当前状态

- Git 仓库已建立，默认分支为 `main`。
- 产品方向、OBS 浏览器源、同机部署及多种展示方式已确认。
- 当前只准备文档；应用源码、依赖、启动和构建流程尚未建立。
- `SPlayer-docs/docs/` 保留原始宿主文档；其中 `.vitepress/` 是参考站点配置。
- AMLL 克隆位于同级目录 `../applemusic-like-lyrics/`，作为只读参考，不包含在本仓库内。

## 协作约定

- 本项目说明放在 `docs/`，项目说明使用中文，接口名称保持原名。
- 区分已确认需求、建议方案和待验证行为，修改需求时同步维护计划与决策记录。
- 使用 Conventional Commits：`<类型>: <中文摘要>`。
- 后续代码格式、检查和测试命令在工程建立后补充。
