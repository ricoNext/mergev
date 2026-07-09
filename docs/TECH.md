# Mergev 技术实现方案

本文档是 [PRODUCT.md](./PRODUCT.md) 的技术落地规格，决策来自 grilling 会话锁定结论。
实现以本文为准；若与产品文档开放问题冲突，以本文「已锁定决策」为准。

## 一句话

Mergev 是 Node.js（≥ 20）上的 TypeScript CLI：用系统 `git` 读取 stage 1/2/3，在内存中用
diff3 建模冲突，经 Ink 三栏 TUI 按块决策后原子写回工作区，并默认 `git add`。

## 已锁定决策摘要

| 主题 | 决策 |
| --- | --- |
| 语言 / 模块 | TypeScript，ESM |
| 用户运行时 | Node ≥ 20，`#!/usr/bin/env node` |
| 开发工具 | bun（安装与 scripts）；发布产物给 Node 用 |
| 构建 | `tsup` → ESM `dist/`；`bin` → `dist/cli.js` |
| TUI | Ink |
| CLI 解析 | commander |
| Git 交互 | `execa` 调系统 `git`（不走 shell） |
| 冲突建模 | 内存三方合并；`node-diff3`（或同等库） |
| 状态模型 | 决策为源；有序 `stable \| conflict` region；结果派生 |
| 模型更新 | 可变 `MergeFileModel` + `revision` |
| 手动编辑 | MVP 仅 `$EDITOR`；只编辑当前冲突块 |
| 编辑器预填 | 当前派生结果；未解决用自有占位符 |
| 占位符 | `⟪mergev:unresolved:N⟫`（避开 `<<<<<<<`） |
| both | ours 在前、theirs 在后；不去重 |
| 保存 | 同目录临时文件 → `rename`；默认 `git add`；`--no-add` 可关 |
| `--check` 失败 | 已写盘，不 add |
| Git continue | MVP 只建议命令，不代跑 |
| 会话 | MVP 不持久化；后续目录 `.git/mergev/` |
| 配置 | MVP 仅 flags；后续 `.mergev.json`（可兼容 `package.json#mergev`） |
| lockfile | 强警告，仍走普通逐块流程 |
| 支持范围 | 仅 UTF-8 文本 modify/modify |
| 打开文件 | 忽略工作区，只从 stage 重建 |
| 换行 | 建模统一 `\n`；写回按 ours（否则 base）的 `\n`/`\r\n` |
| 高亮 | MVP 块级；行/词级 diff 后续 |
| 视口 | 以当前冲突为中心；上下各 8 行上下文 |
| 布局 | 上中下：标题 / 中间撑满可鼠标滚轮滚动 / Accept·Cancel·Apply；栏宽 ≥120 三栏；80–119 双栏；\<80 单栏；`--mode` 可强制 |
| 测试 | vitest；`merge/` 单测；`git/` 真实仓库 fixture |
| 非 TTY | `--list` / `--porcelain` 可用；TUI 需要 TTY |

## 目标与非目标（技术视角）

### MVP 必须交付

1. 检测仓库与进行中的 merge / rebase / cherry-pick / revert。
2. 列出未合并文件；过滤并标注不支持类型。
3. 从 stage OID 读取 base/ours/theirs，构建 region 模型。
4. Ink：文件列表 + 自适应三栏/双栏/单栏合并视图。
5. 按块：ours / theirs / both / 重置 / 撤销；`$EDITOR` 编辑当前块。
6. 保存：原子写盘 → 内置校验 → 默认 `git add`。
7. 全部解决后打印建议的下一步 Git 命令。
8. `--list` / `--porcelain` 供脚本与 agent 只读使用。

### MVP 明确不做

- 会话恢复、磁盘备份目录
- 配置文件解析
- Ink 内嵌编辑器、整文件 `$EDITOR` 回写映射
- 行级/词级 diff、非冲突变更审阅 UI
- 代跑 `git rebase --continue` 等
- 删除冲突 / 二进制 / add-add 等特殊未合并的精细处理
- lockfile 重新生成策略、语义建议、AI
- headless 自动解决冲突 API

## 技术栈

| 层 | 选择 | 说明 |
| --- | --- | --- |
| 语言 | TypeScript（ESM） | 与现有 `package.json` `"type": "module"` 一致 |
| 运行时（用户） | Node ≥ 20 | shebang：`#!/usr/bin/env node` |
| 包管理 / 开发 | bun | `bun install`、`bun run`、`bun test` |
| 构建 | tsup | 输出 ESM 到 `dist/` |
| CLI | commander | 薄封装，业务不进深层回调 |
| TUI | ink + react | 终端 UI |
| 进程 | execa | git 数组调用；`--check` 使用 `shell: true` |
| 合并 | node-diff3 | 进程内 diff3 |
| YAML 校验 | yaml | 解析校验 |
| JS/TS 校验 | oxc-parser | 仅语法 parse，不 typecheck |
| 测试 | vitest | 单元 + git fixture 集成 |

后续可选：`diff`（行/词级高亮）。

## 仓库结构

```text
src/
  cli/           # commander 入口、flags、退出码
  app/           # 应用控制器、屏幕状态机、保存流程
  git/           # 仓库检测、操作类型、ls-files、cat-file、add
  merge/         # diff3 → region、决策、派生结果、撤销栈
  ui/            # Ink 组件：列表、合并视图、状态栏、帮助、确认框
  validation/    # 冲突标记、JSON/YAML/oxc、--check
  config/        # MVP：仅解析 CLI；预留后续 .mergev.json
  session/       # MVP：空实现或 no-op；预留 .git/mergev/
  text/          # 换行检测、UTF-8/二进制判定、占位符常量
  editor/        # 解析编辑器命令、tmpdir 临时文件、unmount 交接
tests/
  merge/         # 决策与派生单测
  git/           # 临时真实 git 仓库 fixture
  validation/
```

`package.json` 关键字段（目标形态）：

- `"bin": { "mergev": "./dist/cli.js" }`
- `"engines": { "node": ">=20" }`
- `"scripts"`：`build`（tsup）、`dev`、`test`、`typecheck`

## 架构总览

```text
┌─────────────┐     ┌──────────────┐     ┌─────────────────┐
│  cli/       │────▶│  app/        │────▶│  ui/ (Ink)      │
│  commander  │     │  controller  │◀────│  revision 订阅   │
└─────────────┘     └──────┬───────┘     └─────────────────┘
                           │
           ┌───────────────┼───────────────┐
           ▼               ▼               ▼
     ┌──────────┐   ┌──────────┐   ┌──────────────┐
     │  git/    │   │  merge/  │   │ validation/  │
     │  execa   │   │  regions │   │  + --check   │
     └──────────┘   └──────────┘   └──────────────┘
```

原则：

- `merge/` 与 `git/` 不依赖 React。
- UI 持有模型引用 + `revision`；快捷键调用模型方法后 `setState(revision)`。
- 写盘与 `git add` 只经过 `app/` 保存流程，不在按键处理里直接散落。

## 模块设计

### `git/`

职责：

- `rev-parse --show-toplevel`：仓库根；失败 → 清晰错误，退出码 `1`。
- 经 `rev-parse --git-path` 检查：
  - `MERGE_HEAD` → merge
  - `rebase-merge` / `rebase-apply` 或 `REBASE_HEAD` → rebase
  - `CHERRY_PICK_HEAD` → cherry-pick
  - `REVERT_HEAD` → revert
- 未合并列表：`git ls-files -u`，按 path 聚合 stage 条目。
- 内容：对 blob OID 使用 `git cat-file -p`（文件多时可 `--batch`）。
- `git add -- <path>`（数组形式，不走 shell）。
- `git check-attr binary -- <path>`：属性为 binary 则标不支持。

modify/modify 判定（MVP 可打开三栏）：

- 同一 path 同时存在 stage 1、2、3（典型两边都改）。
- 缺 stage 的删除/添加类冲突 → 列表标注「不支持」。

保存前一致性检查：

- 重新 `ls-files -u`；若 path 已非未合并，或 stage 2/3 OID 与打开时不同 → 中止写入，提示并回列表。

### `merge/`

核心类型（示意）：

```ts
type Decision =
  | { kind: "unresolved" }
  | { kind: "ours" }
  | { kind: "theirs" }
  | { kind: "both" }
  | { kind: "manual"; text: string };

type StableRegion = { type: "stable"; text: string };
type ConflictRegion = {
  type: "conflict";
  id: number;
  base: string;
  ours: string;
  theirs: string;
  decision: Decision;
};

type Region = StableRegion | ConflictRegion;
```

流程：

1. base/ours/theirs 文本先规范为 `\n`（保留写回用的 eol 风格元数据）。
2. `node-diff3` 生成冲突区间，映射为 `Region[]`。
3. 自动合并成功的区间 → `stable`（MVP 只读）。
4. 冲突区间初始 `decision: unresolved`。
5. `deriveResult(regions)`：按序拼接；`unresolved` 输出
   `⟪mergev:unresolved:N⟫`；`both` = `ours + theirs`（按行拼接，ours 在前）。
6. 决策变更推入撤销栈：`{ conflictId, prevDecision }`；`u` 弹出恢复。
7. `r`：当前冲突重置为 `unresolved`（同样入栈）。
8. 每次变更 `revision++`。

打开文件：

- **始终忽略工作区内容**，只从 stage 1/2/3 重建。
- 不尝试导入半解决的工作区标记。

### `validation/`

| 检查 | 时机 | 行为 |
| --- | --- | --- |
| 未解决块数量 | 决策后轻量；保存门闩 | \>0 则禁止保存 |
| 派生结果含占位符 | 保存门闩 | 禁止保存（防御） |
| Git 冲突标记 `<<<<<<<` 等 | 保存 / `c` | 失败则展示行列 |
| `.json` → `JSON.parse` | 保存 / `c` | 失败则展示信息 |
| `.yaml`/`.yml` → `yaml` | 保存 / `c` | 同上 |
| `.js/.jsx/.ts/.tsx` → oxc | 保存 / `c` | 仅 parse |
| `--check <cmd>` | 写盘且内置校验通过后 | `shell: true`；失败则不 add |

决策过程中不自动跑 JSON/YAML/oxc。

### `editor/`

优先级：`--editor` > `VISUAL` > `EDITOR` > 平台兜底（`vi` / `notepad`）。

流程：

1. 取当前冲突块的派生文本（未解决则为占位或空策略：预填当前派生结果）。
2. 写入 `os.tmpdir()/mergev-<pid>-<hash>.txt`。
3. **卸载 Ink**，恢复终端。
4. `execa` 运行编辑器（继承 stdio）。
5. 读回文件 → 该块 `manual` 决策 → 删临时文件（`finally`）。
6. 重新 `render` Ink。

MVP 不支持整文件编辑回写。

### `ui/`

屏幕状态（与产品 UI 状态对齐，可合并实现）：

- 无仓库 / 无冲突 / 文件列表 / 合并视图 / 等待编辑器 /
  校验中 / 校验失败 / 退出确认 / 帮助

合并视图整体为**外层大模块 + 上中下小模块**：

| 层级 | 内容 |
| --- | --- |
| 外层 | 圆角边框包裹整个合并视图 |
| 上 | 标题 `Merge Revisions for <path>` + 操作类型/冲突进度 |
| 中 | 三栏（或双栏/单栏）操作区，**撑满顶栏与底栏之间剩余空间**；无外框，仅各栏有边框；内容超出时用**鼠标滚轮**滚动（Shift+滚轮横向） |
| 下 | `Accept Left` / `Accept Right` / `Cancel` / `Apply` 操作栏 + 快捷键提示 |

栏宽自适应：

| 终端列宽 | 中间区布局 |
| --- | --- |
| ≥ 120 | Ours (Left) \| Result \| Theirs (Right) |
| 80–119 | Result \| 当前侧（ours/theirs，可切换） |
| \< 80 | 仅 Result |

`--mode three-pane|two-pane|result` 强制覆盖。

视口：以当前冲突块为中心；上下各 **8** 行 stable 上下文作为滚动内容源。
中间区**撑满**顶/底栏之间的剩余高度；内容超出时用鼠标滚轮纵向滚动，Shift+滚轮（或水平滚轮）横向平移，三栏同步。
（终端无 DOM `overflow:scroll`；通过 SGR mouse reporting 实现滚轮。）

栏目标题：左 `Ours (Left)`（stage 2）、右 `Theirs (Right)`（stage 3）；状态行显示操作类型
（merge/rebase/…）。rebase 下**不对调**标签。

高亮：当前冲突块强调；已解决/未解决状态色。无行级/词级 diff。

快捷键（与产品一致，语义按本文锁定）：

| 键 | 行为 |
| --- | --- |
| 鼠标滚轮 | 中间区纵向滚动 |
| Shift+滚轮 / 水平滚轮 | 中间区横向平移 |
| `n` / `p` | 下一/上一冲突（并重置滚动） |
| `g` | 第一个未解决（并重置滚动） |
| `h` / `l` / `b` | 当前块 ours / theirs / both |
| `H` / `L` | Accept Left / Accept Right（全部冲突块） |
| `e` | `$EDITOR` 编辑当前块 |
| `u` / `r` | 撤销 / 重置当前冲突 |
| `s` | Apply：保存流程（尊重 `--no-add`） |
| `a` | 保存流程且**强制** `git add` |
| `f` | 回文件列表 |
| `c` | 手动跑内置校验 |
| `q` | Cancel：退出合并视图（有未保存决策则 Y/N 确认） |
| `?` | 帮助 |

### `cli/`

命令：

```bash
mergev
mergev <path>
mergev --list
mergev --list --porcelain
mergev --check "pnpm test"
mergev --no-add
mergev --all
mergev --mode three-pane|two-pane|result
mergev --editor <command>
mergev --debug
```

行为：

- 无 path：有冲突 → 文件列表（需 TTY）；无冲突 → 提示并以 `0` 退出。
- 有 path：直接进该文件合并视图；非未合并 → 错误，退出码 `1`；`f` 仍可回列表。
- `--all`：保存成功后自动打开下一个「未解决且受支持」的文件。
- 非 TTY：允许 `--list` / `--porcelain`；进入 TUI → 错误退出。

退出码：

| 码 | 含义 |
| --- | --- |
| 0 | 成功（含无冲突干净退出、list 成功、正常结束） |
| 1 | 业务失败（非仓库、路径无效、校验/保存失败等） |
| 2 | 用法错误 |
| 130 | Ctrl-C |

### `config/` / `session/`

- MVP：`config` 只反映 CLI flags。
- 预定后续：`.mergev.json`，并可兼容 `package.json` 的 `mergev` 字段；flags 覆盖文件配置。
- MVP：`session` no-op；预定路径 `.git/mergev/`。

## 关键流程

### 保存（`s` / `a`）

```text
1. 若存在 unresolved → 拒绝，提示
2. deriveResult（不得含占位符）
3. 重读 git：path 仍未合并且 OID 一致，否则中止
4. 同目录写临时文件 → rename 覆盖工作区文件（按检测的 eol 写回）
5. 内置校验；失败 → 保留写盘结果，不 add，展示诊断
6. 若有 --check → 在 repoRoot 下 shell 执行；失败 → 不 add，展示输出
7. 若应 add（s 且未 --no-add，或按了 a）→ git add
8. 更新列表状态；若全部已解决 → 打印下一步建议命令
9. 默认回列表；若 --all → 打开下一文件
```

### 文本与二进制

1. `git check-attr binary` 为 binary → 不支持。
2. blob 含 `\0` → 二进制，不支持。
3. 严格 UTF-8 解码失败 → 不支持。
4. 否则进入 merge 模型。

### lockfile

识别常见名称（`package-lock.json`、`pnpm-lock.yaml`、`yarn.lock`、`bun.lock` 等）：
列表与状态栏**强警告**；仍允许逐块解决；不提供重新生成动作。

## 测试策略

- `merge/`：region 构建、ours/theirs/both/manual、派生文本、占位符、撤销栈、eol 元数据。
- `git/`：临时目录 `git init` fixture，制造 merge 冲突；断言操作类型、`ls-files -u` 聚合、
  cat-file 内容、add 后未合并消失。
- `validation/`：标记扫描、JSON/YAML/oxc 成败用例。
- UI：优先测纯函数（布局阈值、视口切片）；不做脆弱的全量 Ink E2E。

## 与产品里程碑的映射

| 里程碑 | 技术交付 |
| --- | --- |
| 0 搭建 | bun、tsup、commander 入口、vitest、目录骨架 |
| 1 Git 检测 | `git/`：根目录、操作类型、ls-files、cat-file、`--list` |
| 2 合并模型 | `merge/` + 单测 |
| 3 TUI MVP | 列表、自适应栏、导航、h/l/b、块级高亮、帮助 |
| 4 保存与校验 | 原子写盘、校验、add、建议 continue 命令 |
| 5 打磨 | `$EDITOR` 交接、撤销/重置、`--check`、`--all`、窄屏、退出确认 |
| 6+ | 配置文件、`.git/mergev/` 会话、行/词 diff、lockfile 策略、类型感知 |

说明：产品里程碑 5 中的「会话恢复」按本文推迟；`$EDITOR` 可在 4–5 间落地，但规格已定。

## 风险与缓解

| 风险 | 缓解 |
| --- | --- |
| rebase 下 ours/theirs 直觉相反 | 严格跟 stage；状态栏标明操作类型 |
| 大文件渲染卡顿 | 视口切片，不渲染整文件 |
| 外部改 Git 导致误写 | 保存前 OID/未合并校验 |
| Ink 与编辑器抢终端 | 先 unmount 再启动编辑器 |
| diff3 与 Git 块边界不一致 | 以 stage+diff3 为产品模型；Git 标记仅作校验 |
| oxc 原生绑定与平台 | engines 限制 Node 20+；CI 多平台 smoke |

## 开放实现细节（不阻塞开工）

以下可在实现时做合理默认，无需再开 grilling：

- 双栏下切换 ours/theirs 的具体键（建议 `Tab`）。
- `both` 拼接时是否在两段之间强制补一个 `\n`（建议：若 ours 非空且不以 `\n` 结尾则补一个）。
- 撤销栈软上限（建议 100）。
- `--porcelain` 列格式（建议稳定、无颜色、易切分的字段序）。

## 文档关系

| 文档 | 职责 |
| --- | --- |
| [PRODUCT.md](./PRODUCT.md) | 产品定位、体验、路线图 |
| [TECH.md](./TECH.md) | 本文件：实现规格与锁定决策 |
| [PLAN.md](./PLAN.md) | 分阶段执行计划、任务拆解与验收 |

开始编码前以本文模块边界与 MVP 非目标为准，避免范围膨胀。
按 [PLAN.md](./PLAN.md) 从 M0 起交付。
