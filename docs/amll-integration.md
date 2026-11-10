# AMLL 接入分析

整理日期：2026-11-11。仅做本地源码阅读，未安装依赖或运行示例。
AMLL 是可选渲染器；公共层和其他展示方式不依赖其类型、样式或初始化。

## 本地基线

| 项目 | 读取结果 |
| --- | --- |
| 克隆目录 | `E:/Zero_Work_Folder/Project/1.Fun_Project/applemusic-like-lyrics`，与本项目同级 |
| 分支 | `main-xmh` |
| 提交 | `9db9236818464ce83f696ee9c5ff0e5395cb744a` |
| Core／Vue 包声明版本 | `0.6.0`，仅为本地清单值，未核对发布版本 |
| 读取时工作区 | 干净 |

本地克隆独立于本仓库管理。最终依赖已发布包还是固定提交构建产物，在 M2 决定。

## 数据适配

对照 SPlayer [歌词类型](../SPlayer-docs/docs/types.md)与 AMLL [接口源码](../../applemusic-like-lyrics/packages/core/src/interfaces.ts)，
核心字段在结构上对应，但仍需真实数据兼容测试。

| 字段 | AMLL 适配处理 |
| --- | --- |
| `words[].startTime/endTime/word` | 保留毫秒逐字时间，校验有限非负数和起止顺序 |
| `romanWord/ruby/obscene` | 保留可用的可选字段，校验嵌套注音数据 |
| `translatedLyric/romanLyric` | 映射同名字段，缺省补空字符串 |
| 行 `startTime/endTime` | 保留时间，不自行推造逐字时间 |
| `isBG/isDuet` | 保留背景行和对唱标记 |
| `language` | 当前 AMLL `LyricLine` 未声明；可保留在公共模型，但不承诺组件据此切换字形 |

公共类型由本项目维护，转换在 AMLL 适配器内部完成。
宿主已给出解析歌词，首版优先直接适配，不重复解析或重新获取歌词源。
逐行歌词按逐行展示，不把文字平均切分成伪造的逐字高亮。

## 渲染驱动

根据 [Core 播放器](../../applemusic-like-lyrics/packages/core/src/lyric-player/base/index.ts)
及 [DOM 实现](../../applemusic-like-lyrics/packages/core/src/lyric-player/dom/index.ts)：

- `setLyricLines(lines, initialTime)` 设置全文，传入后不要继续修改数组；仅歌词修订变化时调用。
- `setCurrentTime(time, isSeek)` 接收毫秒进度，真实跳转才显式使用 seek 标记。
- `update(delta)` 更新动画，帧间隔与歌曲进度分开计算。
- `pause()`／`resume()` 配合公共播放状态，销毁时调用 `dispose()`。

[Vue 绑定源码](../../applemusic-like-lyrics/packages/vue/src/LyricPlayer.tsx)提供歌词、进度、播放状态等属性及动画更新逻辑。
选用绑定时需核实其帧调度职责，避免公共层重复启动动画循环。

## 性能与 OBS

- 仅选择 AMLL 时加载其适配模块和 CSS，进入其他模式不初始化 AMLL。
- 接入统一渲染器生命周期，切换后释放实例及资源；不将完整演示播放器并入输出页。
- 页面及容器默认建议透明，不默认加入动态背景组件。
- 用实际 OBS 版本验证字体、遮罩、模糊、发光、透明合成和尺寸变化。
- 浏览器源隐藏、刷新或恢复后使用公共时钟重新校准。

## 待验证

真实歌词时间合法性、背景行及重叠规则、歌词偏移、组件内部时间优化行为和 OBS 环境样式表现。
本地源码基线不代表已确认所有歌词或 OBS 版本均兼容。
