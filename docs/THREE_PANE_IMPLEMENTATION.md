# 类 WebStorm 三栏合并实现方案

## 目标

把 Mergev 的合并页面从“冲突块选择器”升级为“类 WebStorm 的完整文件三栏合并编辑器”。

最高优先级能力：

- 完整文件三栏展示
- 同步滚动
- 行级和词级高亮
- 冲突行内接受按钮

本文是技术实现方案，不扩大合并页面之外的产品范围。

## 当前状态

后端：

- `load_conflict_file` 返回 `ours`、`theirs`、可选 `base`、冲突 `blocks` 和渲染后的 `result`。
- 冲突解析基于工作区文件里的 conflict markers。
- `save_conflict_file` 接收每个冲突块的决策，并写入渲染后的结果。

前端：

- `MergeScreen` 已经有三栏布局。
- 当存在当前冲突块时，三栏主要展示当前冲突块内容。
- Result 栏是决策预览，不是完整、可编辑的最终文件。
- 导航和接受操作主要集中在底部工具栏。

主要限制：

- 当前 UI 的心智模型是“选择这个冲突块怎么处理”，不是“检查并编辑最终文件”。

## 推荐架构

采用两层模型：

1. 后端根据 Git index stages 和工作区文件构建结构化的 merge document。
2. 前端把 merge document 渲染成对齐的完整文件行，并在每行附近提供控制按钮和同步滚动。

第一版不要直接做完整代码编辑器。先做结构化行渲染，等数据模型稳定后再加手动编辑。

## 后端数据模型

在迁移期间保留当前命令，同时新增完整文件合并文档接口。

新增命令：

```rust
#[tauri::command]
fn get_merge_document(app: tauri::AppHandle, path: String) -> Result<MergeDocument, String>
```

推荐暴露给 TypeScript 的结构：

```ts
type MergeDocument = {
  path: string;
  labels: {
    ours: string;
    theirs: string;
  };
  base: string | null;
  ours: string;
  theirs: string;
  working: string;
  rows: MergeRow[];
  conflicts: ConflictRegion[];
  result: ResultLine[];
  unresolvedCount: number;
};

type MergeRow = {
  id: string;
  kind: "context" | "conflict" | "insert" | "delete" | "empty";
  conflictIndex: number | null;
  oursLine: PaneLine | null;
  resultLine: PaneLine | null;
  theirsLine: PaneLine | null;
};

type PaneLine = {
  number: number | null;
  text: string;
  tokens?: DiffToken[];
};

type DiffToken = {
  kind: "equal" | "insert" | "delete" | "replace";
  text: string;
};

type ConflictRegion = {
  index: number;
  rowStart: number;
  rowEnd: number;
  decision: ConflictDecision;
};

type ResultLine = {
  source: "context" | "ours" | "theirs" | "both" | "manual" | "unresolved";
  conflictIndex: number | null;
  text: string;
};
```

## 后端 Merge Document 构建

### 第 1 步：继续以 Git stages 为事实来源

读取 Git index 中的三个版本：

```bash
git show :1:path   # base
git show :2:path   # ours
git show :3:path   # theirs
```

同时读取工作区文件，因为它包含 conflict markers，也可能包含用户在 Mergev 外部做过的手动修改。

### 第 2 步：解析工作区冲突区域

当前 `parse_conflict_file` 已经能把工作区文件拆成普通文本段和冲突段。

需要扩展解析结果，让每个 segment 记录：

- segment index
- 原始工作区行号范围
- ours lines
- theirs lines
- 冲突前后的 context lines

这样前端可以稳定定位冲突区域和导航目标。

### 第 3 步：构建对齐行

对每个解析出来的 segment：

- context segment：生成三栏都显示相同文本的 rows。
- conflict segment：生成一个对齐区域，左侧显示 ours，右侧显示 theirs，中间显示该冲突的当前 result。

第一版冲突区域可以按最大行数对齐：

```text
row count = max(oursLines.length, theirsLines.length, resultLines.length)
```

某一侧没有对应行时，用 `kind: "empty"` 的空行占位。

这不是最完美的 diff 对齐，但行为稳定，足够支撑第一版完整文件三栏。

### 第 4 步：增加行级 diff

基于 LCS 做行级 diff：

- base vs ours
- base vs theirs
- 冲突区域内 ours vs theirs

实现选择：

- 第一版优先：在 Rust 里实现一个小型 LCS，只返回行级状态。
- 后续可选：如果依赖策略允许，再引入维护良好的 Rust diff crate。

行状态：

- `equal`
- `insert`
- `delete`
- `replace`
- `conflict`

### 第 5 步：增加词级 diff

词级高亮只应该针对可见的变更行或冲突行计算，不要每次渲染都对整文件计算。

第一版建议：

- 后端只返回行级 rows。
- 前端用一个小的本地函数，为可见冲突行计算 word tokens。
- token 边界按空白和标点拆分。

这样可以避免 Rust 响应体过大，也能让 UI 迭代更快。

## 前端组件方案

用以下组件替换当前基于 `Pane` 的合并主体：

```text
MergeScreen
  MergeToolbar
  MergeGrid
    PaneHeader x 3
    MergeRowView[]
      MergeCell ours
      MergeCell result
      MergeCell theirs
      InlineConflictActions
  MergeFooter
```

### MergeGrid

使用 CSS grid：

```css
.merge-grid {
  display: grid;
  grid-template-columns: minmax(0, 1fr) minmax(0, 1fr) minmax(0, 1fr);
  grid-auto-rows: minmax(var(--line-height), auto);
}
```

每个视觉行应在同一个 DOM row 中渲染三栏 cell，这样行高天然对齐。

完整文件版本不要继续使用三个独立 `<pre>` pane。独立 pane 会让同步行高、行内按钮和冲突区域定位变得更难。

### MergeCell

每个 cell 包含：

- gutter 行号
- 文本内容
- 可选 word tokens
- 冲突背景状态

建议形态：

```tsx
function MergeCell({ line, side, state }: MergeCellProps) {
  return (
    <div className={`merge-cell ${state}`}>
      <span className="line-number">{line?.number ?? ""}</span>
      <code>{renderTokens(line)}</code>
    </div>
  );
}
```

### InlineConflictActions

把接受按钮渲染在冲突区域内部，靠近实际变更行：

```text
left pane:    [x] [>>]
result pane:  conflict result
right pane:   [<<] [x]
```

第一版控制项：

- Accept Ours
- Accept Theirs
- Accept Both
- Reset

按钮使用紧凑的图标式按钮，并通过 `title` 提供 tooltip。

底部栏可以保留为键盘操作和状态区，但鼠标主操作应该发生在冲突行附近。

## 同步滚动

推荐实现：

- 用一个单独的 scroll container 包住 `MergeGrid`。
- 因为三栏是同一个 grid 里的 rows，滚动时天然同步。
- 第一版不要使用三个独立滚动容器。

这比监听三个 pane 的 `scrollTop` 更简单，也更可靠。

如果后续确实需要独立 pane 滚动：

- 记录触发滚动的源 pane。
- 在 `requestAnimationFrame` 中把 `scrollTop` 应用到其它 pane。
- 加 guard 防止递归触发 scroll 事件。

但默认方案应该是单滚动容器。

## Result 状态模型

前端在一次合并会话中维护可变的 result 模型：

```ts
type MergeSession = {
  document: MergeDocument;
  decisions: ConflictDecision[];
  resultLines: ResultLine[];
  activeConflict: number;
  dirty: boolean;
};
```

接受操作立即更新 `resultLines`：

- Ours：用 ours lines 替换该冲突的 result 区域。
- Theirs：用 theirs lines 替换该冲突的 result 区域。
- Both：用 ours lines 后接 theirs lines 替换。
- Reset：恢复未解决的 conflict marker lines。

后端保存命令应支持两种模式：

1. 当前的 decision list，用于兼容旧流程。
2. 完整 result text，用于新的 editor 流程。

推荐新增命令：

```rust
#[tauri::command]
fn save_merge_result(
    app: tauri::AppHandle,
    path: String,
    result: String,
    stage: bool,
) -> Result<ConflictFileDetail, String>
```

这样 Result 栏才是真正的事实来源。

## 高亮策略

### 行级高亮

给 row 应用 class：

- `.row-context`
- `.row-conflict`
- `.row-insert`
- `.row-delete`
- `.row-replace`
- `.row-active-conflict`

合并视图信息密度很高，颜色要克制。当前暖色调可以继续使用，但冲突区域需要比普通选中态更明显。

### 词级高亮

在每行内部渲染 tokens：

```tsx
<span className="token token-replace">changed</span>
```

第一版：

- 只为冲突行计算 tokens。
- 冲突左右两栏比较 ours vs theirs。
- Result 栏比较当前选中的 result source 和另一侧内容。

后续：

- 增加 toolbar 选项 `Highlight words`。
- 增加 `Do not ignore / Ignore whitespace` 选项。

## 键盘与鼠标行为

必备快捷键：

- `n`：下一个冲突
- `p`：上一个冲突
- `1`：接受 ours
- `2`：接受 theirs
- `3`：接受 both
- `r`：重置当前冲突
- `s`：所有冲突解决后保存
- `Escape`：返回冲突文件列表

鼠标行为：

- 点击冲突行会设置 `activeConflict`。
- 点击行内接受按钮会更新 result，并跳到下一个未解决冲突。
- 第一阶段点击 Result 栏不应意外改变决策。

## 实施阶段

### Phase 1：完整文件对齐只读视图

交付物：

- 新增 `get_merge_document` 命令。
- 基于当前 parser 构建 `MergeDocument` rows。
- 新增 `MergeGrid`，以三栏方式渲染完整文件。
- 使用单个共享 scroll container。
- 暂时保留现有底部栏决策按钮。

验收标准：

- 打开冲突文件后，三栏都显示完整文件内容。
- 冲突区域在原位高亮。
- 滚动时 left/result/right 保持对齐。

### Phase 2：冲突行内接受按钮

交付物：

- 在当前冲突区域内渲染行内按钮。
- 实现 ours/theirs/both/reset 点击处理。
- 接受后自动跳到下一个未解决冲突。
- 高亮 active conflict。

验收标准：

- 用户可以不依赖底部接受按钮完成文件解决。
- Result 栏能原位更新。
- unresolved count 正确变化。

### Phase 3：保存完整 result text

交付物：

- 新增 `save_merge_result` 命令。
- 前端把 `resultLines` 序列化为最终文件文本。
- 保存前校验没有残留 conflict markers，除非用户明确允许。

验收标准：

- Result 栏成为事实来源。
- 保存写入的内容与 Result 栏展示一致。
- 用户选择 stage 时仍执行 `git add -- path`。

### Phase 4：行级和词级高亮

交付物：

- 在 `MergeRow` 中增加行级 diff 状态。
- 为冲突行渲染 word tokens。
- Toolbar 提供词级高亮和空白处理开关。

验收标准：

- 用户能快速看出哪些行发生变化。
- 长行中的小范围词级变化容易识别。
- 高亮开关不会导致布局明显跳动。

### Phase 5：Result 手动编辑

交付物：

- 让 result cell 可编辑，或在 Result 栏嵌入代码编辑器。
- 手动编辑后仍保留冲突区域 metadata。
- 手动改过的行标记为 `source: "manual"`。

验收标准：

- 用户可以直接在 Result 栏修复杂冲突。
- 手动编辑在导航和保存后仍保留。

## 编辑器库选择

Phase 1 不引入 Monaco 或 CodeMirror。

原因：

- 第一优先级是行对齐和冲突操作，不是富文本编辑。
- 自定义 grid 更小，也更容易控制三栏同步布局。
- 手动编辑可以等 Result 数据模型稳定后再评估。

Phase 5 再重新评估 CodeMirror 6，条件是：

- 手动编辑变成核心能力。
- 需要语法高亮。
- 大文件需要虚拟化和编辑器级选择行为。

## 虚拟化

Phase 1 不主动做虚拟化，除非性能明显变差。

出现以下情况再加虚拟化：

- 超过 5,000 行的文件明显卡顿。
- 渲染 word tokens 导致输入或点击有延迟。

推荐方式：

- 对三栏共用同一个虚拟化 row list。
- 不要分别虚拟化三个 pane。

## 预计会修改的文件

后端：

- `src-tauri/src/workspace.rs`
  - 新增 `MergeDocument`、`MergeRow`、`PaneLine`、`ConflictRegion`、`ResultLine`。
  - 新增 merge document builder。
  - 新增保存完整 result 的函数。
- `src-tauri/src/lib.rs`
  - 注册 `get_merge_document`。
  - 注册 `save_merge_result`。

前端：

- `src/App.tsx`
  - 用 merge session state 和 `MergeGrid` 替换 block-only 的 `MergeScreen` 主体。
  - 暂时保留旧 `get_conflict_file` 路径作为 fallback。
- `src/App.css`
  - 新增 grid row 布局、gutter、冲突高亮、行内操作按钮样式。

后续可选拆分：

- `src/components/MergeGrid.tsx`
- `src/components/MergeCell.tsx`
- `src/lib/wordDiff.ts`

## 测试计划

后端单元测试：

- 解析单个冲突。
- 解析多个带上下文的冲突。
- 保留文件末尾换行。
- 当 ours/theirs 行数不同，能构建对齐 rows。
- 完整 result text 保存必须精确一致。

如果后续引入前端测试：

- 点击行内 Accept Ours 会更新 result rows。
- Next conflict 会聚焦正确区域。
- 决策变化后 unresolved count 正确变化。

手动 QA：

- 单行冲突。
- 多行冲突。
- 一个文件有两个或更多冲突。
- 文件开头发生冲突。
- 文件结尾发生冲突。
- added/deleted side conflict。
- Markdown 或 JSON 长行。
- 没有末尾换行的文件。

## 迁移策略

在构建新三栏期间，保持当前合并页面可用。

建议路径：

1. 新增 `get_merge_document`，不删除 `get_conflict_file`。
2. 在同一个 `MergeScreen` 中渲染 `MergeGrid`。
3. Phase 3 之前继续用旧 decision 保存方式。
4. 切换到 `save_merge_result`。
5. 新流程稳定后，再移除旧 block-preview 路径。

## 待确认问题

- `Accept Both` 应固定为 ours then theirs，还是根据 Git/IDE 操作语义调整顺序？
- 手动保存模式是否允许残留 conflict markers？
- Result 栏可编辑应该放在词级高亮之前还是之后？
- binary file 或超大文件在冲突列表里应该如何展示？

## 建议

优先一起启动 Phase 1 和 Phase 2。

这能以较低风险带来最明显的 WebStorm-like 改善：

- 完整文件上下文
- 天然同步滚动
- 原位冲突操作

词级高亮建议等 row model 稳定后再做，因为 token 高亮依赖 rows 和 conflict regions 的最终表达方式。
