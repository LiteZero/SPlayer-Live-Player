# 环境记录

检查日期：2026-11-11。结果仅代表本次终端环境，未安装或更新工具。

| 项目 | 本机检查结果 | 与后续工作关系 |
| --- | --- | --- |
| 系统终端 | Windows / PowerShell | 当前项目所在环境 |
| Git | `2.55.0.windows.5` | 可进行本地版本管理 |
| Node.js | `v24.21.0` | 满足参考贡献指南中的 Node.js >= 24 要求 |
| pnpm | `11.25.0` | 低于参考贡献指南中的 pnpm >= 12 要求 |
| Rust | 当前终端找不到 `rustc` | 若选择构建上游原生模块，需另行准备工具链 |

Node.js、pnpm 和 Rust 的要求来自 [SPlayer-Next 贡献指南](../SPlayer-docs/docs/contributing.md)，不是本项目已确定的环境要求。
仅编辑本轮文档无需安装应用依赖。技术选型后再核实所选工具版本与安装方式。

## 本地仓库

- 根目录：`E:\Zero_Work_Folder\Project\1.Fun_Project\SPlayer-Live-Player`。
- 默认分支：`main`。
- 使用现有 Git 身份配置，不修改全局 Git 配置。
- 暂未配置远端或执行推送。

## 验证范围

本轮检查新建文档的本地 Markdown 文件链接、Git 空白问题、参考文件内容与 Git 工作区状态。
没有应用源码，因此不进行应用构建、播放测试或宿主接口联调。
