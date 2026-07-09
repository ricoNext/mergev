# 内容分析

## 领域与体裁

- 领域：开发者工具 / Git / 终端 UI 产品规划
- 体裁：产品规格与路线图（Product Plan）
- 结构：定位 → 问题 → MVP → 增强特性 → CLI/快捷键 → 架构 → 非目标 → 成功标准 → 里程碑 → 开放问题

## 语气与风格

- 原文：英文技术产品文档，祈使句与条目清单为主，语气克制、可执行
- 目标风格：`technical` — 简洁精确、术语稳定、少修辞
- 读者：`technical` — 开发者/工程师，常见 Git/CLI/TUI 术语少加注释

## 关键术语表（会话）

| English | Chinese | Note |
|---------|---------|------|
| merge conflict | 合并冲突 | |
| conflict block | 冲突块 | |
| three-pane | 三栏 | |
| ours / theirs | ours / theirs | 保留英文，首次可注「当前分支 / 传入分支」 |
| base | base | Git stage 1，可保留 |
| working tree | 工作区 | |
| unmerged files | 未合并文件 | |
| rebase / cherry-pick / revert | rebase / cherry-pick / revert | 保留英文命令语境 |
| git add | `git add` | 保留命令 |
| validation | 校验 | |
| diagnostics | 诊断信息 | |
| keymap | 快捷键映射 | |
| session recovery | 会话恢复 | |
| lockfile | lockfile | 可写「锁文件（lockfile）」首次 |
| MVP | MVP | 保留 |
| TUI | TUI | 终端 UI，保留缩写 |
| Ink | Ink | 库名保留 |
| Non-Goals | 非目标 | |
| Roadmap / Milestone | 路线图 / 里程碑 | |
| Semantic Suggestions | 语义建议 | |
| inline diff | 行内 diff | |
| word-level / line-level | 词级 / 行级 | |

## 翻译难点

1. 原文已有「Chinese Introduction」小节；全文译为中文后应并入「一句话介绍」，避免重复双语小节。
2. CLI 命令、快捷键、代码块、路径、配置键名保持原文不译。
3. UI 示意图中的英文标签可译为中文，但快捷键字母与命令保留。
4. 「Accept ours/theirs/both」统一为「接受 ours / theirs / both」，必要时括号补充含义。
5. 开放问题（Open Questions）保持疑问句语气，便于后续决策讨论。
6. 架构目录树、模块名保持英文路径。

## 结构处理建议

- 标题层级与列表结构完整保留
- 示例终端输出可本地化为中文界面文案，便于产品文档阅读
- JSON/bash 示例中的键与命令不译
