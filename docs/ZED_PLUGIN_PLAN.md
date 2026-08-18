# mergev Zed 插件构建计划

> 状态：阶段 0 已完成（2026-08-18），结论见 [ZED_FEASIBILITY.md](./ZED_FEASIBILITY.md)：三栏 UI 无法以普通扩展实现，推荐 MCP Context Server 路线（R1）  
> 最后更新：2026-08-18

## 1. 目标

在 Zed 中实现一套与现有 VS Code 插件基本一致的 Git 冲突解决体验，同时最大程度复用 mergev 已有的 Rust 核心、sidecar 协议和三栏合并界面。

完成后的 Zed 版本应具备以下能力：

- 自动识别当前工作区中的 Git 冲突。
- 在 Zed 内显示仓库和冲突文件列表。
- 点击冲突文件打开三栏合并界面。
- 支持逐块选择 Yours、Theirs 或 Both。
- 支持整文件 Accept Yours / Accept Theirs。
- 支持撤销、恢复和未保存状态提示。
- 保存结果后自动执行 `git add`。
- Git 状态变化后自动刷新。
- 支持多工作区、多仓库。
- 提供 Git 路径等设置。
- 第一版与 VS Code 版保持一致：支持本地 macOS、Windows，不支持远程工作区。

## 2. 现有代码的复用边界

### 2.1 可以复用

- `crates/mergev-core/`：Git 仓库扫描、冲突解析、结果保存和暂存。
- `apps/vscode/sidecar/`：现有 JSON Lines RPC 服务，可重构为跨宿主 sidecar。
- `packages/merge-ui/`：三栏界面、冲突交互、主题、语法高亮及纯前端逻辑。
- 现有 merge、rebase、cherry-pick 等测试场景和发布流程设计。

### 2.2 必须重写或适配

- VS Code Extension Host 相关代码。
- `TreeView`、`CustomEditor`、`Webview` 和 `vscode.commands` 等 VS Code API。
- Zed 工作区、命令、面板、编辑器 Tab 和 Git 状态集成。
- Zed 扩展的构建、打包和发布流程。

## 3. 目标架构

```text
Zed Extension
  ├── 工作区与命令入口
  ├── 仓库/冲突文件视图
  ├── 合并编辑器宿主
  └── Sidecar Client
          │ JSON Lines RPC
          ▼
mergev-sidecar
          │
          ▼
mergev-core

合并编辑器宿主
          │
          ▼
merge-ui（Zed 支持 WebView 时复用）
或 Zed 原生 UI（Zed 不支持 WebView 时重写）
```

建议将当前 VS Code 专属 sidecar 重构为共享组件：

```text
crates/
├── mergev-core/
├── mergev-protocol/
└── mergev-sidecar/
```

Zed 扩展建议使用以下目录：

```text
apps/zed/
├── extension.toml
├── Cargo.toml
├── src/
│   ├── lib.rs
│   ├── commands.rs
│   ├── sidecar.rs
│   ├── workspace.rs
│   └── editor.rs
└── README.md
```

## 4. 分阶段实施计划

### 阶段 0：Zed API 可行性验证

预计时间：2～4 天。

这是整个计划的 Go/No-Go 闸门。在开始生产代码前，必须确认 Zed 当前稳定版扩展 API 是否支持：

- 注册用户命令。
- 获取当前工作区和文件路径。
- 创建侧边栏、树形列表或等效视图。
- 创建自定义编辑器 Tab 或 Panel。
- 在扩展与 UI 之间双向通信。
- 监听文件和 Git 状态变化。
- 启动本地 sidecar 进程。
- 打包或下载 macOS、Windows 原生二进制。
- 向 Zed Git 面板或文件菜单添加入口。

最小 PoC：

1. 创建 `apps/zed-poc/`。
2. 在 Zed 中注册“使用 mergev 打开”命令。
3. 获取当前工作区路径。
4. 启动现有 sidecar。
5. 调用 `getRepositoryWorkspace`。
6. 在 Zed 内显示一个最简单的冲突文件列表或页面。

交付物：

- `docs/ZED_FEASIBILITY.md`。
- Zed API 能力矩阵。
- 最小可运行 PoC。
- 原生实现、混合实现或维护 Zed fork 的明确结论。

决策规则：

- 如果 Zed 支持自定义面板和 Tab，继续开发原生扩展。
- 如果只能注册命令、不能创建自定义 UI，则普通 Zed 插件无法实现完整三栏界面。
- 如果目标必须完全运行在 Zed 内，而扩展 API 不支持，则需要向 Zed 上游贡献扩展点，或者维护 Zed fork。

阶段验收标准：三个关键问题必须获得明确答案：

1. Zed 插件能否创建自定义编辑器 Tab？
2. 能否在该 Tab 中承载或复用 React 三栏界面？
3. 能否安全启动并打包 mergev sidecar？

### 阶段 1：重构跨编辑器基础设施

预计时间：4～7 天。

主要工作：

- 将 sidecar 从 `apps/vscode/sidecar/` 移到共享目录。
- 新建 `mergev-protocol`，集中维护请求和响应类型。
- 为协议增加版本号和能力协商。
- 让 VS Code、Zed 使用同一个 sidecar。
- 保留 JSON Lines stdin/stdout 通信方式。
- 增加 sidecar 崩溃重启、超时和请求取消机制。
- 保证重构后 VS Code 版本行为不变。

建议补充的协议方法：

```text
watchWorkspace
unwatchWorkspace
validateEnvironment
shutdown
```

阶段验收标准：

- VS Code 插件全部现有功能通过回归测试。
- 共享 sidecar 可以独立构建和运行。
- 协议类型不再分别由不同宿主手工维护。

### 阶段 2：建立 Zed 扩展宿主

预计时间：5～8 天。

主要工作：

- 建立 `apps/zed/` 扩展骨架。
- 实现 Zed 扩展激活与释放。
- 获取一个或多个工作区根目录。
- 管理 sidecar 生命周期。
- 实现 JSON-RPC 请求、超时和错误处理。
- 增加 Git 路径设置。
- 注册“使用 mergev 打开”“刷新仓库”等命令。
- 增加不可信工作区和路径越界保护。
- 识别 macOS、Windows CPU 架构。

阶段验收标准：

- Zed 扩展可以稳定启动 sidecar。
- 可以读取当前仓库的分支、操作状态和冲突文件。
- sidecar 异常退出后能够显示错误并恢复。

### 阶段 3：实现冲突文件入口

预计时间：5～10 天。

主要工作：

- 显示仓库与冲突文件列表。
- 显示冲突文件数量。
- 点击文件打开 mergev 编辑器。
- 支持刷新仓库。
- 支持 Accept Yours / Accept Theirs。
- 支持复制仓库路径和复制分支。
- 从 Zed Git 面板进入 mergev；如果 Zed 没有开放对应接口，则使用命令面板和文件菜单替代。
- 监听 Git 和文件状态变化，自动刷新列表。

阶段验收标准：

- 用户无需离开 Zed，即可定位并打开任意冲突文件。
- merge、rebase、cherry-pick、revert 的冲突状态都能正确识别。
- 多仓库工作区可以分别显示和刷新。

### 阶段 4：实现三栏合并界面

预计时间：2～4 周。

这是工作量和技术风险最大的阶段，实施方案由阶段 0 的结论决定。

#### 方案 A：Zed 支持 WebView 或自定义网页 Tab

优先复用 `packages/merge-ui/`：

- 新建 Zed WebView 适配器。
- 抽象统一的 `MergeHost` 接口。
- 分别实现 `VsCodeMergeHost` 和 `ZedMergeHost`。
- 复用 React 组件、主题、语法高亮和冲突状态管理。

#### 方案 B：Zed 不支持 WebView，但支持原生自定义 UI

使用 Zed 原生 UI 重写界面，同时继续复用：

- `mergev-core`。
- sidecar 协议。
- 冲突数据结构。
- 合并状态机和纯逻辑测试。

#### 方案 C：Zed 不开放自定义编辑器 UI

如果目标仍要求界面完全位于 Zed 内，只能选择：

- 向 Zed 上游提交所需扩展 API。
- 维护一个内置 mergev 功能的 Zed fork。

完整 UI 验收项：

- 三栏同步滚动。
- 行号、语法高亮和冲突连接线。
- Yours、Theirs、Both 操作。
- 整文件选择。
- 撤销和恢复。
- Result 只读。
- 未处理冲突提示。
- 未保存关闭确认。
- 外部文件变更检测。
- 保存、写回、`git add` 和状态刷新。

### 阶段 5：测试与兼容性

预计时间：1～2 周。

测试范围：

- `mergev-core` 单元测试。
- sidecar 协议测试。
- Git merge、rebase、cherry-pick、revert 集成测试。
- 文件新增、删除、重命名和两边删除场景。
- 多仓库工作区。
- Unicode 路径、空格路径和大文件。
- sidecar 崩溃、Git 不存在、仓库被删除等错误场景。
- macOS arm64/x64。
- Windows x64/arm64。
- Zed 不同主题和缩放比例。

安全检查：

- 所有文件路径必须限制在仓库内部。
- 禁止通过字符串拼接 shell 命令。
- 拒绝包含 `../` 的相对路径和仓库外绝对路径。
- sidecar 只允许调用协议中声明的方法。
- 发布的原生二进制需要提供哈希校验。

阶段验收标准：

- 自动化测试覆盖核心冲突流程。
- 支持平台的安装包通过真实 Git 仓库验证。
- VS Code、桌面端没有因共享层重构产生功能回退。

### 阶段 6：构建和发布

预计时间：3～5 天。

主要工作：

- 增加 Zed 扩展构建脚本。
- 增加 sidecar 多平台 CI 构建。
- 建立 Zed 扩展版本和变更日志。
- 增加 Zed 扩展市场发布配置。
- 编写安装、卸载和故障排查文档。
- 为三个产品保持独立版本和发布标签。

```text
desktop-vx.y.z
vscode-vx.y.z
zed-vx.y.z
```

阶段验收标准：

- 用户可以从 Zed 支持的扩展分发渠道完成安装。
- 扩展能够获取与当前平台匹配的 sidecar。
- 发布失败不会影响桌面端或 VS Code 插件的发布。

## 5. 总体排期

在单人全职开发且 Zed API 足够的情况下：

| 阶段 | 预计时间 |
| --- | ---: |
| Zed API 可行性 PoC | 2～4 天 |
| 共享核心重构 | 4～7 天 |
| Zed 扩展宿主 | 5～8 天 |
| 冲突列表与入口 | 5～10 天 |
| 三栏合并界面 | 2～4 周 |
| 测试与发布 | 1～2 周 |
| 合计 | 约 6～10 周 |

如果必须修改 Zed 上游或维护 Zed fork，周期可能增加到 3～5 个月，并产生长期跟随 Zed 升级的维护成本。

## 6. 主要风险

| 风险 | 影响 | 应对方案 |
| --- | --- | --- |
| Zed 扩展 API 不支持自定义 Tab 或 Panel | 无法通过普通插件实现完整内嵌 UI | 在阶段 0 提前验证；必要时向 Zed 上游贡献或维护 fork |
| Zed 无法承载 WebView | React 三栏 UI 无法直接复用 | 使用 Zed 原生 UI 重写，继续复用核心数据和状态逻辑 |
| Zed WASM 沙箱不能直接启动 sidecar | 扩展无法调用本地 Rust 核心 | 验证官方进程 API、语言服务器式启动机制或引入受控桥接程序 |
| Zed 未开放 Git 面板扩展点 | 无法完全复刻 VS Code SCM 入口 | 使用命令面板、文件菜单和独立冲突视图替代 |
| 多平台二进制分发复杂 | 安装或更新失败 | 建立平台矩阵、哈希校验和独立 CI 发布产物 |
| 共享层重构影响现有产品 | VS Code 或桌面端功能回退 | 先补测试，再迁移 sidecar，并对现有入口执行回归测试 |

## 7. 里程碑

### M0：可行性结论

- PoC 可以在 Zed 中调用 sidecar。
- 明确 UI 承载方式。
- 明确是否需要修改 Zed 上游。

### M1：后端贯通

- 共享 sidecar 和协议完成。
- Zed 能读取仓库和冲突文件。

### M2：入口可用

- Zed 中可以查看并打开冲突文件。
- 文件级 Accept Yours / Accept Theirs 可用。

### M3：三栏编辑器可用

- 逐块处理、撤销、恢复和保存流程完整。
- 保存后自动执行 `git add`。

### M4：功能对齐

- 与 VS Code 版的核心体验基本一致。
- 多仓库、错误恢复和状态刷新通过验收。

### M5：正式发布

- 多平台构建和发布流程完成。
- 文档、变更日志和故障排查说明完整。

## 8. 下一步

优先执行阶段 0，仅建立可行性 PoC 和能力矩阵。在三个关键问题得到明确答案之前，不开始大规模迁移或重写三栏界面。
