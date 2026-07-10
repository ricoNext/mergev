# Shiki 代码高亮技术方案

## 背景

当前三栏合并页面已经采用自定义 `MergeGrid` 渲染完整文件行：

- `src/App.tsx` 中的 `MergeGrid` 按 `MergeRow[]` 逐行渲染三栏。
- `MergeCell` 负责渲染行号、代码文本、冲突操作按钮。
- 冲突行已经有词级 diff token：`equal`、`insert`、`delete`、`replace`。
- 现有布局依赖自定义 grid 保证三栏行对齐和行内按钮定位。

因此，第一版语法高亮不引入 Monaco 或 CodeMirror，而是在现有只读 grid 上增加 Shiki token 渲染层。

## 目标

- 在 Ours、Result、Theirs 三栏中展示语法高亮。
- 保持现有三栏行对齐、同步滚动、冲突选择、行内接受按钮行为不变。
- 让语法高亮与现有词级 diff 高亮共存。
- 根据文件路径自动识别语言。
- 控制 bundle 体积和首次进入合并页的延迟。
- 为后续 Result 栏手动编辑或 CodeMirror 迁移保留空间。

## 非目标

- 不在本阶段实现可编辑代码编辑器。
- 不改变后端 `MergeDocument` 数据结构。
- 不改变冲突决策、保存、校验逻辑。
- 不做完整 IDE 级能力，如语义诊断、跳转定义、自动补全。

## 推荐方案

采用 **Shiki + 现有自定义三栏 grid**。

Shiki 只负责把每一行代码切成带颜色信息的语法 token；Mergev 继续负责：

- 行模型
- 三栏布局
- diff token
- 冲突行状态
- 交互按钮
- 滚动容器

第一版使用 Shiki 的 token 输出，不直接使用 `codeToHtml`。原因是 `codeToHtml` 会生成完整 HTML，而当前 `MergeCell` 需要把语法 token 与 diff token 合并，并且需要继续由 React 控制渲染。

## 依赖策略

新增前端依赖：

```sh
npm install shiki
```

初期可以直接从 `shiki` 导入 `createHighlighter`，但只显式加载少量主题和语言。后续如果 bundle 明显增大，再迁移到 fine-grained bundle：

- `shiki/core`
- `shiki/engine/javascript`
- `@shikijs/langs/*`
- `@shikijs/themes/*`

推荐第一版主题：

- `github-light`：贴近当前浅色 UI。

如果当前米色背景下对比度不足，可改为自定义 CSS 覆盖 token 颜色，或选择更柔和的浅色主题。

## 模块设计

新增文件：

```text
src/syntaxHighlight.ts
```

职责：

- 初始化并缓存 Shiki highlighter。
- 根据文件路径推断语言。
- 把多行文本高亮成逐行 token。
- 提供 fallback，保证不支持的语言或高亮失败时仍能显示纯文本。

建议导出：

```ts
export type SyntaxToken = {
  text: string;
  color?: string;
  fontStyle?: number;
};

export type HighlightedLine = SyntaxToken[];

export function languageFromPath(path: string): string;

export async function highlightLines(
  text: string,
  language: string,
): Promise<HighlightedLine[]>;
```

`fontStyle` 是否保留取决于 Shiki 当前 token 输出。如果第一版只使用颜色，可以先不暴露。

## 语言识别

第一版使用后缀映射，不引入额外语言检测库。

建议支持：

```ts
const LANGUAGE_BY_EXTENSION: Record<string, string> = {
  ".ts": "typescript",
  ".tsx": "tsx",
  ".js": "javascript",
  ".jsx": "jsx",
  ".json": "json",
  ".jsonc": "jsonc",
  ".rs": "rust",
  ".md": "markdown",
  ".css": "css",
  ".scss": "scss",
  ".html": "html",
  ".vue": "vue",
  ".svelte": "svelte",
  ".yml": "yaml",
  ".yaml": "yaml",
  ".toml": "toml",
  ".sh": "bash",
  ".zsh": "bash",
  ".py": "python",
  ".go": "go",
  ".java": "java",
};
```

特殊文件名：

```ts
const LANGUAGE_BY_FILENAME: Record<string, string> = {
  "package-lock.json": "json",
  "bun.lock": "text",
  "Cargo.lock": "toml",
  "Dockerfile": "docker",
};
```

如果语言不支持或不确定，返回 `text`，前端按纯文本渲染。

## Highlighter 生命周期

Shiki highlighter 创建成本较高，必须做成长生命周期单例。

建议：

```ts
let highlighterPromise: Promise<Highlighter> | null = null;

function getHighlighter() {
  if (!highlighterPromise) {
    highlighterPromise = createHighlighter({
      themes: ["github-light"],
      langs: INITIAL_LANGUAGES,
    });
  }

  return highlighterPromise;
}
```

`INITIAL_LANGUAGES` 不要加载全部语言，第一版只放 Mergev 常见冲突文件类型：

```ts
const INITIAL_LANGUAGES = [
  "typescript",
  "tsx",
  "javascript",
  "jsx",
  "json",
  "jsonc",
  "rust",
  "markdown",
  "css",
  "html",
  "yaml",
  "toml",
  "bash",
  "text",
];
```

如果遇到未加载语言：

1. 尝试 `highlighter.loadLanguage(language)`。
2. 成功后重新高亮。
3. 失败则 fallback 为纯文本。

## 前端状态设计

`MergeScreen` 或 `MergeGrid` 上层维护高亮结果，避免每个 `MergeCell` 自己异步高亮。

建议新增状态：

```ts
type HighlightState = {
  language: string;
  byRowId: Map<
    string,
    {
      ours?: HighlightedLine;
      result?: HighlightedLine;
      theirs?: HighlightedLine;
    }
  >;
  loading: boolean;
  error: string | null;
};
```

更轻量的第一版可以不存 `byRowId`，而是按 pane 生成 line-number 到 highlighted line 的映射：

```ts
type PaneHighlights = {
  ours: Map<number, HighlightedLine>;
  result: Map<number, HighlightedLine>;
  theirs: Map<number, HighlightedLine>;
};
```

推荐使用 line-number 映射，因为当前 `PaneLine` 已经有 `number`：

- `null` 行不高亮。
- 行号与后端行模型一致。
- Result 栏在决策变化后可以单独重算。

## 渲染 token 设计

现有：

```ts
type DiffToken = {
  kind: DiffTokenKind;
  text: string;
};
```

建议引入统一渲染 token：

```ts
type RenderToken = {
  text: string;
  color?: string;
  diffKind?: DiffTokenKind;
};
```

`MergeCell` 改为接收：

```ts
renderTokens?: RenderToken[];
```

渲染：

```tsx
{renderTokens?.length
  ? renderTokens.map((token, index) => (
      <span
        key={index}
        className={token.diffKind ? `token token-${token.diffKind}` : "syntax-token"}
        style={token.color ? { color: token.color } : undefined}
      >
        {token.text}
      </span>
    ))
  : (line?.text ?? "")}
```

## 语法 token 与 diff token 合并

核心问题：语法 token 和 diff token 的边界不一定一致。

例如：

```ts
const userName = getName()
```

语法 token 可能按关键字、变量、函数名切分；diff token 可能只标记 `userName` 中的一段。需要把两组 token 按字符区间合并。

建议实现一个纯函数：

```ts
function mergeSyntaxAndDiffTokens(
  syntaxTokens: SyntaxToken[],
  diffTokens?: DiffToken[],
): RenderToken[];
```

算法：

1. 把 `syntaxTokens` 展平为字符区间：`start`、`end`、`color`、`text`。
2. 把 `diffTokens` 展平为字符区间：`start`、`end`、`diffKind`、`text`。
3. 用双指针按区间交集切片。
4. 生成同时包含 `color` 和 `diffKind` 的 `RenderToken[]`。
5. 如果没有 `diffTokens`，直接把语法 token 转为 `RenderToken[]`。
6. 如果没有 `syntaxTokens`，直接把 diff token 转为 `RenderToken[]`。

注意事项：

- 按 JavaScript string 索引处理即可，第一版不需要 grapheme cluster。
- 必须保留空格 token，否则缩进会丢失。
- 合并后所有 token 文本拼接必须等于原始行文本。

## 数据流

建议数据流：

```text
load_merge_document
  -> buildSessionFromDocument
  -> languageFromPath(selectedPath)
  -> highlight pane text with Shiki
  -> MergeGrid receives PaneHighlights
  -> each row builds RenderToken[]
  -> MergeCell renders spans
```

Ours / Theirs：

- 文件加载后高亮一次。
- 冲突决策变化时不需要重算。

Result：

- 首次加载后高亮一次。
- 每次用户选择 ours / theirs / both / unresolved 后，Result 行会变化，需要对 result 文本重新高亮。
- 可以先整栏重算；如果性能不足，再做按冲突区域局部重算。

## 异步与竞态

高亮是异步的，切换文件或快速切换决策时可能出现旧结果覆盖新结果。

建议在 `useEffect` 中使用递增 request id：

```ts
const highlightRequestRef = useRef(0);

useEffect(() => {
  const requestId = highlightRequestRef.current + 1;
  highlightRequestRef.current = requestId;

  void highlightCurrentSession().then((next) => {
    if (highlightRequestRef.current !== requestId) {
      return;
    }
    setHighlights(next);
  });
}, [selectedPath, session?.rows, session?.resultLines]);
```

如果组件卸载，旧 Promise resolve 后也不得更新 state。

## CSS 策略

保留现有 `.token-insert`、`.token-delete`、`.token-replace` 背景样式，让 diff 背景优先表达冲突差异。

新增：

```css
.syntax-token {
  color: inherit;
}
```

不要把 Shiki 主题背景色直接应用到 `.line-text` 或 `.merge-cell`，否则会破坏 Mergev 当前的冲突区域底色。

如果 Shiki token 颜色和当前背景对比度不足，优先调整主题或 token color 映射，不调整三栏结构。

## 性能策略

第一版性能目标：

- 进入普通冲突文件时，高亮延迟不影响页面先展示纯文本。
- 高亮完成后渐进增强为彩色 token。
- 大文件也不能阻塞冲突操作。

建议：

- 初始渲染直接显示纯文本。
- Shiki 完成后再替换为 token 渲染。
- highlighter 单例缓存。
- 语言和主题显式加载。
- Result 栏决策变化先整栏重算，后续再按性能数据优化。
- 如果文件超过阈值，比如 3000 行，默认关闭高亮或只高亮可见区域。

后续优化选项：

- 使用 `requestIdleCallback` 分批更新。
- 把高亮放到 Web Worker。
- 引入行虚拟化后，只高亮可见窗口附近。
- 改用 fine-grained bundle 减少体积。

## 错误处理

高亮失败不得影响合并流程。

错误策略：

- `languageFromPath` 返回未知语言时使用 `text`。
- `loadLanguage` 失败时使用纯文本。
- Shiki 初始化失败时记录错误，但 UI 不弹阻塞式错误。
- `MergeCell` 始终有 `(line?.text ?? "")` fallback。

## 实施步骤

### 第 1 步：安装依赖

```sh
npm install shiki
```

提交 `package.json` 和 lockfile 变化。

### 第 2 步：新增 `syntaxHighlight.ts`

实现：

- `languageFromPath`
- `getHighlighter`
- `highlightLines`
- 纯文本 fallback

### 第 3 步：新增 token 合并函数

可以放在 `src/App.tsx` 附近，或拆成：

```text
src/renderTokens.ts
```

实现：

- `RenderToken`
- `mergeSyntaxAndDiffTokens`
- 覆盖空格、空行、diff-only、syntax-only 场景。

### 第 4 步：改造 `MergeCell`

把 `tokens?: DiffToken[]` 改为：

```ts
renderTokens?: RenderToken[];
```

`MergeGrid` 负责根据当前行的语法高亮和 diff token 生成 `RenderToken[]`。

### 第 5 步：在合并页生成高亮数据

在 `MergeScreen` 或 `MergeGrid` 上层：

- 根据 `selectedPath` 推断语言。
- 对 Ours、Theirs、Result 生成 `PaneHighlights`。
- 把 `PaneHighlights` 传给 `MergeGrid`。

### 第 6 步：保留纯文本降级

在高亮未完成、失败、文件过大、语言未知时，页面行为应与当前版本一致。

### 第 7 步：验证

手工验证：

- TypeScript 冲突文件。
- JSON 冲突文件。
- Rust 冲突文件。
- Markdown 冲突文件。
- 不支持后缀文件。
- 大文件。
- 快速切换冲突决策。
- 快速切换文件。

自动测试建议：

- `languageFromPath` 后缀映射。
- `mergeSyntaxAndDiffTokens` token 拼接不丢字符。
- diff token 和 syntax token 边界错位时仍能正确切片。
- Shiki 失败 fallback 为纯文本。

## 验收标准

- 三栏代码有语法颜色。
- 行号、行高、三栏对齐不变。
- 冲突行底色、active conflict 高亮、diff 背景仍然可见。
- 接受 ours / theirs / both 后 Result 栏高亮能更新。
- 不支持语言仍显示纯文本。
- 高亮失败不影响保存和冲突决策。
- 构建通过：`npm run build`。

## 风险与应对

### 风险：Shiki token 颜色压过 diff 背景

应对：

- diff 用背景色，syntax 用前景色。
- 保持 `.token-insert`、`.token-delete`、`.token-replace` 的背景样式。
- 必要时降低 diff 背景透明度或选择更柔和的 Shiki 主题。

### 风险：Result 栏频繁重算导致卡顿

应对：

- 第一版整栏重算，观察实际体验。
- 如果卡顿，只重算受影响 conflict region。
- 大文件关闭高亮或延迟高亮。

### 风险：bundle 增大

应对：

- 第一版显式加载常用语言。
- 如果打包体积明显增加，迁移到 fine-grained bundle。
- 避免加载全部主题和全部语言。

### 风险：异步结果覆盖当前文件

应对：

- 使用 request id 或 cancelled flag。
- Promise resolve 后检查当前 `selectedPath` 和 session 是否仍匹配。

## 后续演进

当 Result 栏进入手动编辑阶段，再重新评估 CodeMirror 6：

- CodeMirror 只用于 Result 栏编辑。
- Ours / Theirs 仍可继续使用自定义只读 grid。
- 或在完整编辑器化阶段统一迁移三栏，但必须先解决行对齐、冲突按钮定位和虚拟化。

## 参考资料

- Shiki Installation & Usage: https://shiki.style/guide/install
- Shiki Bundles: https://shiki.style/guide/bundles
- Shiki Best Performance Practices: https://shiki.style/guide/best-performance
