# SPlayer Live Player

基于[SPlayer-Next](https://github.com/SPlayer-Dev/SPlayer-Next)的插件功能，为您提供的 **⌈下一个⌋** B站直播点歌服务解决方案。

Powered by ChatGPT.

## 这是什么？

如上述所言，这是一个基于SPlayer-Next所提供的插件API，向主播们提供的一个点歌解决方案。

目前市面上的其他产品都存在着如下问题：

- 点歌机使用体验不像真正的音乐播放器，通常需要混用点歌机与播放器。

- 为了保证观众的音乐体验，通常需要多个音乐软件反复切换。

- OBS显示的点歌插件不够美观，可定制性不高。

SPlayer Live Player正是为了解决这些问题所制作的，基于SPlayer Next已实现的在线播放、向外开放的API接口，实现了更贴合平常使用体验的中转接入平台。

## 当前状态？

此项目当前还处于早期开发状态，当前还不提供使用。

## 致谢

感谢以下项目及其贡献者提供的播放器接口、歌词组件和接口资料：

| 项目 | 本项目参考内容 |
| --- | --- |
| [SPlayer-Next](https://github.com/SPlayer-Dev/SPlayer-Next) | 插件机制、歌词事件、搜索与播放接口及相关文档 |
| [Apple Music-like Lyrics](https://github.com/Steve-xmh/applemusic-like-lyrics) | 可选 AMLL 歌词渲染器的组件、类型与示例 |
| [bilibili-api-collect](https://github.com/bilibili-plugins/bilibili-api-collect) | 直播消息流、弹幕结构和鉴权资料；同时感谢其[上游项目](https://github.com/SocialSisterYi/bilibili-API-collect) |
