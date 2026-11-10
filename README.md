# SPlayer Live Player

基于本地 SPlayer-Next 参考文档开展的新项目，当前处于需求梳理与开发准备阶段。

本轮范围已确认：准备 Git 仓库、需求和开发计划，暂不编写应用代码。
项目名称中的「Live」尚未定义；独立播放器、远程控制端或其他产品形态均未定案。

## 从这里开始

1. 阅读 [需求草案](docs/requirements.md)，确定使用场景、平台和首版范围。
2. 在 [决策记录](docs/decisions.md) 中记录产品方向与技术选型。
3. 根据 [架构候选](docs/architecture.md) 选择实现路径。
4. 按 [开发计划](docs/roadmap.md) 进入后续实施。

完整资料入口见 [项目文档索引](docs/README.md)。

## 目录

```text
SPlayer-Live-Player/
├─ SPlayer-docs/docs/    已提供的 SPlayer-Next 参考文档快照
├─ docs/                本项目的需求、架构候选、计划与决策
├─ .editorconfig        文本编辑约定
├─ .gitattributes       Git 文本换行约定
├─ .gitignore           本地配置、依赖和产物排除规则
└─ README.md            项目入口
```

## 当前状态

- 参考资料已纳入版本管理，保持原有目录与内容。
- 需求与架构中的候选能力不代表首版承诺，待定事项集中在决策记录中。
- 尚无应用源码、依赖清单、启动命令或构建流程。
- `SPlayer-docs/docs/.vitepress/` 是参考站点配置，不是本项目应用骨架。

## 协作约定

- 项目说明使用中文；接口标识符保持参考文档中的原名。
- 修改需求时同步维护验收条件、开发计划和相关决策。
- 使用 Conventional Commits：`<类型>: <中文摘要>`，例如 `docs: 明确首版播放范围`。
- 后续代码格式、检查和测试命令在技术选型后补充，不预设尚不存在的命令。
