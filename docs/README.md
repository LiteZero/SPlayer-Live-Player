# 项目文档索引

整理日期：2026-11-11。当前阶段：已明确直播歌词产品方向，准备技术验证。

## 本项目文档

| 文档 | 用途 |
| --- | --- |
| [需求与验收](requirements.md) | 插件、本地后端、OBS 歌词网页与多种展示方式 |
| [架构方案](architecture.md) | 采集、传输、快照恢复与同步时钟 |
| [渲染器接口草案](renderers.md) | 可替换展示方式、按需加载、切换与资源释放 |
| [AMLL 接入分析](amll-integration.md) | 本地源码基线、歌词映射、渲染 API 和验证点 |
| [参考资料分析](reference-notes.md) | SPlayer 能力、接口约束和资料缺口 |
| [开发计划](roadmap.md) | 阶段交付物、依赖与验收条件 |
| [决策记录](decisions.md) | 已确认事项、建议方案与待决问题 |
| [环境记录](environment.md) | 本次环境检查和参考仓库记录 |

## SPlayer 本地参考

`SPlayer-docs/docs/` 为用户提供的快照，保留原有内容。
其中的构建命令和完整产品功能描述的是 SPlayer-Next，不自动成为本项目的要求。

| 主题 | 文档 |
| --- | --- |
| 使用 | [首页](../SPlayer-docs/docs/index.md)、[指南](../SPlayer-docs/docs/guide.md) |
| 宿主架构 | [贡献指南](../SPlayer-docs/docs/contributing.md)、[原生模块](../SPlayer-docs/docs/native.md) |
| 插件与 HTTP 上传 | [插件总览](../SPlayer-docs/docs/plugins/index.md)、[通用 API](../SPlayer-docs/docs/plugins/api.md) |
| 歌词和状态采集 | [播放事件与查询](../SPlayer-docs/docs/plugins/control.md)、[类型参考](../SPlayer-docs/docs/types.md) |
| 可选外部接口 | [HTTP](../SPlayer-docs/docs/api.md)、[WebSocket](../SPlayer-docs/docs/socket.md)、[MCP](../SPlayer-docs/docs/mcp.md) |

英文参考位于 `SPlayer-docs/docs/en/`。

## AMLL 本地参考

用户已将 AMLL 克隆到同级目录 `../applemusic-like-lyrics/`。
本项目只读取其文档和源码，不复制整个仓库或修改其工作区。

- [中文说明](../../applemusic-like-lyrics/README-CN.md)
- [Core 说明](../../applemusic-like-lyrics/packages/core/README-CN.md)
- [歌词类型源码](../../applemusic-like-lyrics/packages/core/src/interfaces.ts)
- [Vue 绑定源码](../../applemusic-like-lyrics/packages/vue/src/LyricPlayer.tsx)

这些链接依赖当前同级目录布局；其他电脑缺少该克隆时，可先阅读本项目的接入分析。
