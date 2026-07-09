import type { LayoutMode } from "../config/index.js";

/** 外层大模块边框占用行数。 */
export const MERGE_SHELL_BORDER_ROWS = 2;
/** 顶栏小模块：边框 2 + 标题/状态约 2。 */
export const MERGE_HEADER_ROWS = 4;
/** 底栏小模块：边框 2 + 操作/提示/消息约 3。 */
export const MERGE_FOOTER_ROWS = 5;
/** 中间区下限，避免极矮终端完全不可用。 */
export const MERGE_PANES_MIN_HEIGHT = 8;

export type PaneWindow = {
  scrollY: number;
  scrollX: number;
  visibleRows: number;
  visibleCols: number;
};

export function resolveLayoutMode(columns: number, forced?: LayoutMode): LayoutMode {
  if (forced) {
    return forced;
  }

  if (columns >= 120) {
    return "three-pane";
  }

  if (columns >= 80) {
    return "two-pane";
  }

  return "result";
}

/** 中间操作区撑满顶栏与底栏之间的剩余空间。 */
export function resolvePanesHeight(rows: number): number {
  const chrome = MERGE_SHELL_BORDER_ROWS + MERGE_HEADER_ROWS + MERGE_FOOTER_ROWS;
  return Math.max(MERGE_PANES_MIN_HEIGHT, rows - chrome);
}

/** 外层大模块可用内容宽度（扣除左右边框与内边距）。 */
export function resolveShellInnerWidth(columns: number): number {
  // round 边框 2 + paddingX 1*2
  return Math.max(40, columns - 4);
}

/** 单栏内容区可视列数（扣除栏边框与内边距）。 */
export function resolvePaneContentWidth(innerWidth: number, paneCount: number): number {
  const count = Math.max(1, paneCount);
  const perPane = Math.floor(innerWidth / count);
  // 左右边框 2 + paddingX 1*2
  return Math.max(8, perPane - 4);
}

/** 栏内正文可视行数（扣除栏边框与标题行）。 */
export function resolvePaneContentRows(panesHeight: number): number {
  return Math.max(1, panesHeight - 3);
}

export function splitPaneLines(text: string): string[] {
  const lines = text.replace(/\r\n/g, "\n").replace(/\r/g, "\n").split("\n");
  if (lines.length > 0 && lines[lines.length - 1] === "") {
    lines.pop();
  }
  return lines;
}

/** 按滚动偏移裁出可视窗口；不足处右侧/下方留空，保持固定视口。 */
export function windowPaneText(text: string, window: PaneWindow): string {
  const { scrollY, scrollX, visibleRows, visibleCols } = window;
  if (visibleRows <= 0 || visibleCols <= 0) {
    return "";
  }

  const lines = splitPaneLines(text);
  const rows: string[] = [];

  for (let row = 0; row < visibleRows; row++) {
    const source = lines[scrollY + row] ?? "";
    const sliced = source.slice(scrollX, scrollX + visibleCols);
    rows.push(sliced.padEnd(visibleCols, " "));
  }

  return rows.join("\n");
}

export function clampScrollY(scrollY: number, totalLines: number, visibleRows: number): number {
  const maxScroll = Math.max(0, totalLines - visibleRows);
  return Math.min(Math.max(0, scrollY), maxScroll);
}

export function clampScrollX(scrollX: number, maxLineWidth: number, visibleCols: number): number {
  const maxScroll = Math.max(0, maxLineWidth - visibleCols);
  return Math.min(Math.max(0, scrollX), maxScroll);
}

export function maxLineWidth(text: string): number {
  const lines = splitPaneLines(text);
  return lines.reduce((max, line) => Math.max(max, line.length), 0);
}
