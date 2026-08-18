# Zed 扩展可行性报告（阶段 0）

> 状态：已完成
> 调研时间：2026-08-18
> 对应计划：`docs/ZED_PLUGIN_PLAN.md` 阶段 0
> PoC 代码：`apps/zed-poc/`

## 1. 结论速览

| 关键问题 | 答案 | 依据 |
| --- | --- | --- |
| 1. Zed 插件能否创建自定义编辑器 Tab？ | **不能** | Zed 1.0（2026-04）扩展 API 仅支持语言/调试器/主题/snippets/MCP；官方 FAQ 明确"未来才计划开放自定义 UI" |
| 2. 能否在该 Tab 中承载 React 三栏界面？ | **不能** | Zed 基于 GPUI 自绘，扩展体系无 WebView 能力，无任何 HTML 渲染入口 |
| 3. 能否安全启动并打包 mergev sidecar？ | **部分可行** | WASM 沙箱内无法 spawn 长驻进程；唯一官方通道是 Context Server（MCP over stdio），由 Zed 托管进程生命周期。已用 PoC 验证打通 |

**总体判定：计划中的方案 A（WebView 复用 merge-ui）与方案 B（原生自定义 UI）在当前 Zed 扩展 API 下均不可行，直接落入方案 C 场景。** 但存在一条计划未预见的中间路线——**MCP Context Server**——可以在不做 Zed fork 的前提下，把 mergev-core 的核心能力（冲突扫描、三栏数据、Accept Yours/Theirs、保存暂存）接入 Zed Agent Panel，达到接近里程碑 M1/M2 的后端能力，仅缺人类可直接操作的三栏 GUI。

## 2. Zed API 能力矩阵（2026-08，zed_extension_api 0.7.0 / Zed 1.0+）

| 计划所需能力 | 支持情况 | 说明 |
| --- | --- | --- |
| 注册用户命令 | ❌ | 无通用命令 API；仅 Agent Panel 的 slash command |
| 获取工作区路径 | ⚠️ 有限 | `Worktree` API 仅在语言服务器 / slash command 上下文中提供；Context Server 路径拿不到 worktree，需用户或 Agent 传入仓库根路径 |
| 侧边栏 / 树形列表视图 | ❌ | 无自定义面板能力 |
| 自定义编辑器 Tab | ❌ | 无 |
| WebView / 网页 Tab | ❌ | 无 |
| 扩展与 UI 双向通信 | ❌（无 UI）；✅（MCP） | MCP tools/call 即请求-响应通道 |
| 监听文件 / Git 状态变化 | ❌ | 无变更推送 API |
| 启动本地 sidecar 进程 | ⚠️ 仅两种形式 | ① LSP 语言服务器（协议受限不可用）；② MCP Context Server（协议开放，已验证可用）。WASM 内 `process::Command` 仅一次性 `output()`，无 spawn/stdin/stdout 流 |
| 打包 / 下载原生二进制 | ✅ | `latest_github_release` + `download_file` + `make_file_executable`，按 `current_platform()` 选择资产 |
| 向 Zed Git 面板添加入口 | ❌ | Git 面板未开放扩展点 |
| 多平台（macOS/Windows/Linux） | ✅ | WASM 扩展跨平台；原生 MCP 二进制需按 6 个平台矩阵发布 |

## 3. PoC 结果（已全部通过）

`apps/zed-poc/` 实现并验证：

1. **WASM 扩展**（`zed-mergev`，wasm32-wasip2 编译通过）：实现 `context_server_command`，按平台从 GitHub Release 下载 `mergev-mcp` 并交给 Zed 托管。
2. **原生 MCP 服务器**（`mergev-mcp`）：手写 MCP stdio 协议（无 SDK 依赖），包装 mergev-core，暴露 4 个工具：
   - `mergev_workspace(root)` — 仓库扫描 + 冲突列表
   - `mergev_get_merge_document(repoRoot, path)` — 三栏合并数据
   - `mergev_accept_file_side(repoRoot, path, side)` — 整文件 Accept Yours/Theirs
   - `mergev_save_merge_result(repoRoot, path, result, stage?)` — 写回 + `git add`
3. **端到端冒烟测试**（`scripts/test-mcp.mjs`，8/8 通过，无需安装 Zed）：真实 merge 冲突仓库上完成 initialize → tools/list → tools/call → 校验 Git 状态（已解决、已暂存、未越权提交、路径越界拒绝）。
4. **回归检查**：`cargo check --workspace` 通过，VS Code sidecar 与桌面端不受影响。

另验证了与 VS Code sidecar 相同的路径安全策略（拒绝绝对路径与 `..`）。

## 4. 对原计划的修订建议

### 4.1 路线决策

| 路线 | 内容 | 建议 |
| --- | --- | --- |
| **R1：MCP 集成（推荐先做）** | 以 PoC 为基础产品化：Agent Panel 中查看/解决冲突 | 成本低（1~2 周），复用 mergev-core 100%，风险已消除 |
| R2：Zed fork / 上游贡献 | 向 Zed 上游提自定义 pane 扩展点，或维护 fork 内嵌三栏 UI | 成本 3~5 个月起 + 长期维护，仅在"必须人类 GUI 在 Zed 内"时选择 |
| R3：桌面端联动 | Zed 内 Agent/命令发现冲突 → 调起 mergev 桌面 app 三栏界面 | 体验割裂，作为 R1 的可选补充 |

### 4.2 阶段计划修订

- **阶段 1（共享基础设施）仍然有效且必要**：`mergev-mcp` 目前直接依赖 mergev-core；产品化时应与 sidecar 一起收敛到 `mergev-protocol` / `mergev-sidecar` 共享层，协议增加版本号。
- **阶段 2（扩展宿主）大部分已完成**：骨架、生命周期、平台识别、下载机制已在 PoC 验证；剩余工作为 Release 流水线与 `mergev_workspace` 的多仓库参数化。
- **阶段 3（冲突入口）形态改变**：Zed 无侧边栏树视图，入口 = Agent Panel 工具调用（或后续 slash command `/mergev`）；文件级 Accept 能力已具备。
- **阶段 4（三栏界面）在 R1 下不做**；只有选择 R2 才启动，且为 GPUI 原生重写（方案 B），merge-ui 无法复用。
- Git 状态自动刷新（watchWorkspace）在 MCP 模式下无意义（Zed 不会订阅），从协议需求中移除或降级。

### 4.3 新增风险

| 风险 | 应对 |
| --- | --- |
| Agent Panel 依赖 LLM，纯人工工作流不友好 | 工具描述写清楚"不需要 AI 也可以直接调用"；关注 Zed 后续是否开放非 Agent 的 MCP 入口 |
| MCP 工具写入工作区文件的安全边界 | 保持路径校验；Zed 对工具调用有用户确认机制 |
| `mergev-mcp` 需要 6 平台构建矩阵 | 复用现有 sidecar 的 CI 产物流程，`zed-v*` 标签独立发布 |

## 5. 下一步（按修订后的计划）

1. 决策路线（建议 R1）。
2. R1 产品化清单：
   - 将 `apps/zed-poc/` 更名为 `apps/zed/`，补 `context_server_configuration`（设置项：Git 路径等经 env 传入）。
   - `mergev_workspace` 支持多仓库根；工具输出精简（避免大 JSON 占用上下文）。
   - 建立 6 平台 Release CI + 哈希校验，替换 `GITHUB_REPO` 占位符。
   - 发布到 Zed 扩展市场（zed-industries/extensions PR）。
   - 补充 rebase / cherry-pick / revert 场景测试。
