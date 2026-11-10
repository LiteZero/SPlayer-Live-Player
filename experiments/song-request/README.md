# 后端到 SPlayer 的点歌验证

这是独立验证程序，不包含弹幕接入、歌词网页或正式应用工程。不需要安装第三方依赖。
宿主需要插件 API 4 或以上，并允许插件使用 `network`、`control`。

## 运行

在本项目根目录启动后端：

```powershell
node experiments/song-request/server.mjs
```

在 SPlayer「设置 → 插件管理 → 本地导入」选择本目录的 `splayer-song-request.js`，启用插件并保留权限。
插件默认连接 `http://127.0.0.1:19630`；如果导入操作后源文件不在原目录，可从 Git 恢复仓库副本。

在另一终端查看连接与提交命令：

```powershell
Invoke-RestMethod http://127.0.0.1:19630/health
node experiments/song-request/request.mjs "晴天" netease
```

提交命令会在 SPlayer 中搜索并直接请求播放返回的第一个结果。
CLI 仅在后端收到 `playing` 确认时成功退出；其他最终状态以非零码退出。

后端端口通过环境变量 `SPLAYER_LIVE_PROBE_PORT` 修改，插件中的后端地址需相应修改。
程序只监听 IPv4 回环地址，不提供浏览器跨域接入。结束验证可关闭后端进程，并在 SPlayer 中关闭「启用点歌验证」或禁用该专用插件。

## 接口

| 方法 | 路径 | 作用 |
| --- | --- | --- |
| GET | `/health` | 插件连接状态、宿主版本与 API 级别 |
| POST | `/api/commands` | 提交 `{type: "requestSong", query, platform}` |
| GET | `/api/commands/:id` | 查询命令及执行结果 |
| POST | `/bridge/poll` | 专用插件领取一次命令 |
| POST | `/bridge/report` | 专用插件提交最终结果 |

命令仅在内存中保存，最多保留 100 条；同时仅允许一条未完成命令。
同一命令只派发一次，断开或超时不自动重播。重启后不恢复历史或自动执行旧命令。
`platform` 支持宿主文档列出的三个值，实际搜索和播放仍取决于宿主当时的音源可用性。

## 验证

```powershell
node --test experiments/song-request/probe.test.mjs
```

测试使用隔离端口，不向真实播放器发送命令，覆盖第一项与完整 Track 保留、
无结果、播放未确认、播放拒绝、重复领取和输入／API 版本检查，共六项。

真实宿主结果见 [validation.json](validation.json)，说明见 [项目点歌验证记录](../../docs/song-requests.md)。
