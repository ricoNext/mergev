# Mergev 执行计划

本文档把 [TECH.md](./TECH.md) 拆成可按序交付的工作包。
实现以 TECH 锁定决策为准；本计划只回答「先做什么、做到什么算完、如何验收」。

## 目标与范围

### MVP 完成定义（DoD）

在有真实 merge 冲突的 Git 仓库中，开发者可以：

1. 运行 `mergev` / `mergev <path>` / `mergev --list`
2. 在文件列表中看到冲突（含不支持类型与 lockfile 警告）
3. 打开三栏（或自适应）合并视图，按块 `h`/`l`/`b`，必要时 `e` 调编辑器
4. `s` 保存：原子写盘 → 内置校验 → 默认 `git add`
5. 全部解决后看到建议的下一步 Git 命令（不代跑）
6. 相关单测与 git fixture 集成测试通过；`bun run build` 产出可执行
   `dist/cli.js`

### 明确不在本计划 MVP 内

会话恢复、配置文件、行/词 diff、代跑 continue、删除/二进制精细处理、
lockfile 重新生成、语义建议、AI、headless 自动解决。

## 原则

1. **垂直切片优先**：每个阶段结束都应有可运行/可测产物，避免「全写完再联调」。
2. **领域先于 UI**：`git/` → `merge/` → `validation/` → `app` 保存流 → Ink。
3. **测试跟着模块走**：合并模型与 Git 层不过夜无测试。
4. **范围闸门**：阶段内不提前做 TECH「MVP 明确不做」项。
5. **文档同步**：阶段验收时更新本计划勾选状态（或在 PR 描述中对照）。

## 依赖关系（总览）

```text
M0 搭建
 └─▶ M1 Git 检测 + --list
      └─▶ M2 合并模型（可独立于 UI 测完）
           ├─▶ M3 TUI（列表 + 决策，内存态）
           │    └─▶ M4 保存 / 校验 / add / 建议命令
           │         └─▶ M5 编辑器 / 撤销 / --check / --all / 窄屏打磨
           └─▶（M2 后可并行）validation 骨架，在 M4 接入保存流
```

建议顺序：**M0 → M1 → M2 → M3 → M4 → M5**。
M6+ 不在本执行计划冲刺范围内，仅列后备。

---

## M0：项目搭建

**目标：** 可安装依赖、可 typecheck、可 build、可跑空 CLI、可跑空测试。

### M0 任务

| ID | 任务 | 产出 |
| --- | --- | --- |
| M0.1 | 完善 `package.json`：`bin`、`engines`、`scripts`、依赖声明 | 元数据就绪 |
| M0.2 | 加入 `tsconfig.json`（strict、与 ESM 对齐） | TS 配置 |
| M0.3 | 配置 `tsup` 打包入口 → `dist/cli.js`（带 shebang） | 构建管线 |
| M0.4 | 配置 `vitest` | 测试管线 |
| M0.5 | 建各模块目录骨架与 `index` 占位 | 目录 |
| M0.6 | CLI 占位：`mergev --help` 可用；打印版本 | 可执行入口 |
| M0.7 | 更新 `.gitignore`（如需）；README 补开发命令 | 仓库卫生 |

目录骨架：

`src/{cli,app,git,merge,ui,validation,config,session,text,editor}/`

### M0 建议依赖（安装时）

- 运行时：`commander`、`execa`、`ink`、`react`、`node-diff3`、`yaml`、
  `oxc-parser`
- 开发：`typescript`、`tsup`、`vitest`、`@types/node`、`@types/react`、
  Ink 相关类型

### M0 验收

- [x] `bun install` 成功
- [x] `bun run typecheck` 通过
- [x] `bun run build` 生成 `dist/cli.js`
- [x] `node dist/cli.js --help` 退出码 0
- [x] `bun test` 至少有一条占位测试通过

### M0 预估

约 0.5–1 天。

---

## M1：Git 冲突检测

**目标：** 无 UI 也能列出冲突并读出三方内容；`--list` / `--porcelain` 可用。

### M1 任务

| ID | 任务 | 说明 |
| --- | --- | --- |
| M1.1 | `git` 薄封装：`runGit(args, cwd)` 基于 execa | 不走 shell |
| M1.2 | `findRepoRoot()` | 非仓库 → 明确错误 |
| M1.3 | `detectGitOperation()` | merge/rebase/cherry-pick/revert/none |
| M1.4 | `listUnmergedFiles()` | `ls-files -u` 聚合；modify/modify 判定 |
| M1.5 | `readStageBlobs(path)` | OID → `cat-file` |
| M1.6 | `checkBinaryAttr(path)` | `check-attr binary` |
| M1.7 | `text/`：`\0`、严格 UTF-8、eol 规范化 | 支撑「是否可打开」 |
| M1.8 | 文件条目：`supported` / `reason` / `isLockfile` | 列表用 |
| M1.9 | CLI：`--list`、`--porcelain`；非 TTY 可用 | 退出码按 TECH |
| M1.10 | `tests/git/`：真实临时仓库制造 merge 冲突 | fixture 可复用 |

### M1 `--porcelain` 建议格式（可微调，需稳定）

```text
path<TAB>status<TAB>conflictCountOr-<TAB>supported<TAB>lockfile
```

`status` 示例：`unmerged`；`supported`：`true|false`。

### M1 验收

- [x] 在冲突仓库中 `mergev --list` 打印路径与操作类型相关信息
- [x] `--porcelain` 无颜色、可脚本解析
- [x] 非 Git 目录退出码 `1` 且信息可读
- [x] fixture 覆盖：操作类型、ls-files、cat-file、binary/非 UTF-8
- [x] 尚不启动 Ink

### M1 预估

约 1–2 天。

---

## M2：合并模型

**目标：** 纯 TS 完成「stage 文本 → region → 决策 → 派生结果 → 撤销」，
单测充分。

### M2 任务

| ID | 任务 | 说明 |
| --- | --- | --- |
| M2.1 | 占位符常量 `⟪mergev:unresolved:N⟫` | `text/placeholders.ts` |
| M2.2 | 接入 `node-diff3`，映射 `Region[]` | stable + conflict |
| M2.3 | `MergeFileModel`：可变 + `revision` | 打开时忽略工作区 |
| M2.4 | 决策 API：ours/theirs/both、reset、manual | both：ours→theirs |
| M2.5 | `deriveResult()` / 未解决计数 / 导航索引 | 含占位派生 |
| M2.6 | 决策撤销栈（软上限 100） | `undo()` |
| M2.7 | eol：内部 `\n`；记录写回风格 | 与保存衔接 |
| M2.8 | `tests/merge/` 覆盖主路径与边界 | 空文件、both、undo 等 |

### M2 验收

- [x] 给定固定三方字符串，决策序列的派生结果可断言
- [x] 未解决时派生含占位且不含 `<<<<<<<`
- [x] `revision` 随每次决策递增
- [x] 无 React / Ink 依赖进入 `merge/`

### M2 预估

约 1.5–2.5 天。

---

## M3：终端 UI MVP（内存决策）

**目标：** 可交互解决冲突（尚未写盘也可演示）；列表 ↔ 合并视图闭环。

### M3 任务

| ID | 任务 | 说明 |
| --- | --- | --- |
| M3.1 | `app/` 状态机：列表 / 合并 / 帮助等 | 与 UI 解耦 |
| M3.2 | 打开文件：M1 读 blob → M2 建模型 | 不支持则不进三栏 |
| M3.3 | 文件列表 UI | 冲突数、lockfile、不支持标记 |
| M3.4 | 布局阈值与 `--mode` | ≥120 / 80–119 / \<80 |
| M3.5 | 合并视图 + 状态栏（含 Git 操作类型） | 不对调 ours/theirs |
| M3.6 | 视口切片：当前冲突 ±8 行；块级高亮 | 纯函数可单测 |
| M3.7 | 快捷键：`n/p/g/h/l/b/f/?` | 保存/编辑可先 stub |
| M3.8 | `mergev <path>` 直达合并视图 | 非法 path → 码 `1` |
| M3.9 | TTY 检测：非 TTY 进 TUI → 明确错误 | |
| M3.10 | 双栏 `Tab` 切换侧栏 | TECH 建议默认 |

### M3 验收

- [ ] 宽终端可见三栏；缩窄自动切双栏/单栏
- [ ] `h`/`l`/`b` 后 Result 立即变；未解决计数更新
- [ ] `f` 回列表；带 path 启动可直达文件
- [ ] rebase 夹具下标签仍为 Ours=stage2 / Theirs=stage3
- [ ] 本阶段可以不写盘，避免半成品污染仓库

### M3 预估

约 2–3.5 天。

---

## M4：保存与校验

**目标：** 完整「解决 → 写盘 → 校验 → add → 建议命令」主路径。

### M4 任务

| ID | 任务 | 说明 |
| --- | --- | --- |
| M4.1 | 原子写盘：同目录 tmp → `rename`；按 eol 写回 | |
| M4.2 | 保存前：unresolved 门闩；OID 一致性 | 失败回列表 |
| M4.3 | `validation/`：冲突标记扫描 | |
| M4.4 | JSON / YAML / oxc-parser（按扩展名） | 仅 parse |
| M4.5 | `s`：写盘 → 校验 → 默认 add（尊重 `--no-add`） | |
| M4.6 | `a`：同上但强制 add | |
| M4.7 | `git add` 封装；保存后刷新列表 | |
| M4.8 | 全部解决后打印建议命令 | 不代跑 |
| M4.9 | `c` 手动触发内置校验 | 状态栏展示结果 |
| M4.10 | 集成测试：解决单文件后不再 unmerged | |

### M4 验收

- [ ] 手动走通 PRODUCT 成功标准主路径（编辑器细节可在 M5 补）
- [x] 内置校验失败：文件已写盘，未 add
- [x] OID 被外部改掉时拒绝覆盖
- [x] `--no-add` 时 `s` 不 add，`a` 仍 add

### M4 预估

约 1.5–2.5 天。

---

## M5：编辑与流程打磨

**目标：** MVP 体验闭环；达到 TECH「MVP 必须交付」全文。

### M5 任务

| ID | 任务 | 说明 |
| --- | --- | --- |
| M5.1 | `editor/`：解析编辑器优先级 | |
| M5.2 | Ink unmount → 编辑当前块 → `manual` → remount | tmpdir 清理 |
| M5.3 | `u` / `r` 接到 UI | 与 M2 栈对齐 |
| M5.4 | `--check`：失败不 add | shell: true |
| M5.5 | `--all`：保存后开下一受支持未解决文件 | |
| M5.6 | `q` 未保存决策确认 Y/N | |
| M5.7 | 窄屏/双栏/帮助与状态栏打磨 | |
| M5.8 | 退出码与 Ctrl-C（130）梳理 | |
| M5.9 | README：安装、用法、快捷键、MVP 限制 | |
| M5.10 | 手工验收清单跑通 | 见下 |

### M5 手工验收清单

- [ ] merge 冲突：列表 → 三栏 → 全块解决 → `s` → 状态符合预期
- [ ] rebase 冲突：操作类型正确；建议 `git rebase --continue`
- [ ] `mergev --list` / `--porcelain` 在管道中可用
- [ ] lockfile 有强警告仍可打开
- [ ] 二进制/非 modify-modify 显示不支持
- [ ] `e` 编辑一块后结果正确
- [ ] `--check` 失败命令 → 已写盘不 add
- [ ] `--no-add` + `s` / `a` 行为符合 TECH
- [ ] 非 TTY 下无 `--list` 时失败信息清晰

### M5 验收

- [ ] TECH「MVP 必须交付」8 条全部满足
- [ ] `bun test` / `typecheck` / `build` 全绿
- [ ] 未误做：会话持久化、配置文件、代跑 continue

### M5 预估

约 2–3 天。

---

## M6+：后备（不排入当前冲刺）

仅在 MVP 验收后再开新计划：

| 阶段 | 内容 |
| --- | --- |
| M6a | `.mergev.json` + flags 优先级；可选 `package.json#mergev` |
| M6b | `.git/mergev/` 会话恢复与失效条件 |
| M6c | 行级/词级 diff（`diff` 库） |
| M6d | lockfile 重新生成策略；整文件 ours/theirs |
| M6e | 删除冲突 / 二进制整文件选择 |
| M6f | 类型感知建议（JSON 路径、import 去重等） |
| M6g | 可选 AI（opt-in、需确认） |
| M6h | `mergev continue` 需确认的代跑 |

---

## 建议排期（单人全职）

| 阶段 | 预估 | 累计 |
| --- | --- | --- |
| M0 | 0.5–1 天 | ~1 天 |
| M1 | 1–2 天 | ~3 天 |
| M2 | 1.5–2.5 天 | ~5.5 天 |
| M3 | 2–3.5 天 | ~9 天 |
| M4 | 1.5–2.5 天 | ~11.5 天 |
| M5 | 2–3 天 | **约 10–14 天** |

缓冲建议：再留 2–3 天处理 Ink 终端差异、oxc 原生绑定、真实 rebase 夹具问题。

## 每日/每阶段节奏

1. 只做一个阶段的任务 ID，不跨阶段「顺手做」。
2. 阶段结束：跑测试 + 对照本节验收清单 + 在本文件勾选（或 PR 列出）。
3. 发现与 TECH 冲突：先改 TECH/PLAN 再改代码，避免静默偏航。
4. 阻塞超过半天：记入风险并缩小切片（例如 M3 先只做三栏固定宽度）。

## 风险与检查点

| 检查点 | 若失败则 |
| --- | --- |
| M1 fixture 不稳定 | 固定作者环境变量；封装可复用 helper |
| M2 与 Git 标记块不一致 | 坚持 stage+diff3 为真相；文档说明 |
| M3 Ink 性能 | 先保证视口切片；减少每键全树重算 |
| M4 oxc 安装失败 | 文档写明平台；该扩展名可降级跳过并警告 |
| M5 编辑器交接花屏 | 先 unmount；加 `--debug` 日志 |

## 首周推荐切片（立刻可开干）

若现在开工，按下列顺序提交（每个都可单独 PR）：

1. **PR1 / M0**：工具链 + 空 CLI + 目录骨架
2. **PR2 / M1**：`git/` + `text/` + `--list` + fixture 测试
3. **PR3 / M2**：`merge/` + 单测
4. **PR4 / M3**：Ink 列表与合并视图（保存可暂缓）
5. **PR5 / M4**：保存与校验主路径
6. **PR6 / M5**：编辑器、`--check`、`--all`、确认退出、README

## 文档关系

| 文档 | 职责 |
| --- | --- |
| [PRODUCT.md](./PRODUCT.md) | 产品做什么 |
| [TECH.md](./TECH.md) | 技术怎么做（锁定决策） |
| [PLAN.md](./PLAN.md) | 本文件：按什么顺序做、如何验收 |

下一步：从 **M0.1** 开始实现，或指定先做某一阶段。
