import { useLayoutEffect, useRef, useState, type RefObject } from "react";
import type { ConflictRegion } from "../../types";
import { isChangeBlock, sideDecisionMerged } from "../../utils/conflictUtils";
import { sideHasSubstantive } from "../../utils/conflictUtils";

type ConflictLinkGeometry = {
  index: number;
  path: string;
  isActive: boolean;
  isChange: boolean;
};

function readLineHeight(el: HTMLElement): number {
  const raw = getComputedStyle(el).getPropertyValue("--line-height").trim();
  if (raw.endsWith("rem")) {
    const rem = Number.parseFloat(raw);
    if (!Number.isNaN(rem)) {
      const root = Number.parseFloat(
        getComputedStyle(document.documentElement).fontSize,
      );
      return rem * (Number.isNaN(root) ? 14 : root);
    }
  }
  const px = Number.parseFloat(raw);
  return Number.isNaN(px) ? 24 : px;
}

/** 相对 gutter 顶边的冲突块 Y 区间（pane 与 gutter 同列对齐） */
function measureConflictY(
  pane: HTMLElement,
  gutterTop: number,
  conflictIndex: number,
): { top: number; bottom: number } | null {
  const cells = pane.querySelectorAll(
    `[data-conflict-index="${conflictIndex}"]`,
  );
  if (cells.length === 0) {
    return null;
  }
  const lineHeight = readLineHeight(pane);
  const first = cells[0].getBoundingClientRect();
  const last = cells[cells.length - 1].getBoundingClientRect();
  const top = first.top - gutterTop;
  const bottom = Math.max(last.bottom - gutterTop, top + lineHeight);
  return { top, bottom };
}

function measureResultY(
  resultPane: HTMLElement,
  gutterTop: number,
  conflict: ConflictRegion,
  fallback: { top: number; bottom: number },
): { top: number; bottom: number } {
  const direct = measureConflictY(resultPane, gutterTop, conflict.index);
  if (direct) {
    return direct;
  }

  const lineHeight = readLineHeight(resultPane);
  const cells = resultPane.querySelectorAll("[data-row-index]");
  let before: Element | null = null;
  let after: Element | null = null;
  for (const cell of cells) {
    const rowIndex = Number(cell.getAttribute("data-row-index"));
    if (Number.isNaN(rowIndex)) {
      continue;
    }
    if (rowIndex < conflict.rowStart) {
      before = cell;
    } else if (rowIndex > conflict.rowEnd && after === null) {
      after = cell;
    }
  }

  if (before) {
    const y = before.getBoundingClientRect().bottom - gutterTop;
    return { top: y, bottom: y + lineHeight };
  }
  if (after) {
    const y = after.getBoundingClientRect().top - gutterTop;
    return { top: y - lineHeight, bottom: y };
  }
  return fallback;
}

function ribbonPath(
  x0: number,
  x1: number,
  y0a: number,
  y0b: number,
  y1a: number,
  y1b: number,
): string {
  const cx = (x0 + x1) / 2;
  return [
    `M ${x0} ${y0a}`,
    `C ${cx} ${y0a}, ${cx} ${y1a}, ${x1} ${y1a}`,
    `L ${x1} ${y1b}`,
    `C ${cx} ${y1b}, ${cx} ${y0b}, ${x0} ${y0b}`,
    "Z",
  ].join(" ");
}

/** Result 端连接带高度：未解决时收成细条，两侧块高度不变 */
function resultRibbonSpan(
  top: number,
  bottom: number,
  lineHeight: number,
  unresolved: boolean,
): { top: number; bottom: number } {
  const safeBottom = Math.max(top + 2, bottom);
  if (!unresolved) {
    return { top, bottom: safeBottom };
  }
  const mid = (top + safeBottom) / 2;
  // 与 .is-result-strip::before 的 5px 细条对齐
  const half = Math.max(2, Math.min(lineHeight * 0.18, 2.5));
  return { top: mid - half, bottom: mid + half };
}

export function ConflictLinkGutter({
  side,
  conflicts,
  activeConflict,
  layoutKey,
  paneEpoch,
  sidePaneRef,
  resultPaneRef,
  onSelectConflict,
}: {
  side: "ours" | "theirs";
  conflicts: ConflictRegion[];
  activeConflict: number;
  layoutKey: string;
  paneEpoch: number;
  sidePaneRef: RefObject<HTMLDivElement | null>;
  resultPaneRef: RefObject<HTMLDivElement | null>;
  onSelectConflict: (index: number) => void;
}) {
  const gutterRef = useRef<HTMLDivElement>(null);
  const [links, setLinks] = useState<ConflictLinkGeometry[]>([]);
  const [size, setSize] = useState({ width: 0, height: 0 });

  useLayoutEffect(() => {
    const gutter = gutterRef.current;
    const sidePane = sidePaneRef.current;
    const resultPane = resultPaneRef.current;
    if (!gutter || !sidePane || !resultPane) {
      return;
    }

    let raf = 0;

    const redraw = () => {
      raf = 0;
      const gutterRect = gutter.getBoundingClientRect();
      const width = Math.max(gutter.clientWidth, gutterRect.width, 1);
      const height = Math.max(gutter.clientHeight, gutterRect.height, 1);
      setSize((prev) =>
        prev.width === width && prev.height === height
          ? prev
          : { width, height },
      );

      const lineHeight = readLineHeight(sidePane);
      const next: ConflictLinkGeometry[] = [];

      conflicts.forEach((conflict, order) => {
        // 已合并到 Result 的一侧：不再画连接带
        if (sideDecisionMerged(side, conflict)) {
          return;
        }
        // 单方绿色变更：只在有内容的一侧画连接带（WebStorm：左侧不出现右侧独有绿块）
        if (isChangeBlock(conflict)) {
          const sideText = side === "ours" ? conflict.ours : conflict.theirs;
          if (!sideHasSubstantive(sideText)) {
            return;
          }
        }

        const measured = measureConflictY(
          sidePane,
          gutterRect.top,
          conflict.index,
        );
        // 测量失败也不丢操作块：按序号给一个可见落点
        const sideBlock = measured ?? {
          top: Math.min(height - lineHeight, 24 + order * lineHeight * 4),
          bottom: Math.min(height, 24 + order * lineHeight * 4 + lineHeight * 3),
        };
        const resultBlock = measureResultY(
          resultPane,
          gutterRect.top,
          conflict,
          {
            top: (sideBlock.top + sideBlock.bottom) / 2 - lineHeight / 2,
            bottom: (sideBlock.top + sideBlock.bottom) / 2 + lineHeight / 2,
          },
        );

        const sideTop = sideBlock.top;
        const sideBottom = Math.max(sideTop + 2, sideBlock.bottom);
        const { top: resultTop, bottom: resultBottom } = resultRibbonSpan(
          resultBlock.top,
          resultBlock.bottom,
          lineHeight,
          conflict.decision === "unresolved",
        );

        if (
          (sideBottom < -120 && resultBottom < -120) ||
          (sideTop > height + 120 && resultTop > height + 120)
        ) {
          return;
        }

        const path =
          side === "ours"
            ? ribbonPath(0, width, sideTop, sideBottom, resultTop, resultBottom)
            : ribbonPath(
                0,
                width,
                resultTop,
                resultBottom,
                sideTop,
                sideBottom,
              );

        const isChange = isChangeBlock(conflict);

        next.push({
          index: conflict.index,
          path,
          isActive: conflict.index === activeConflict,
          isChange,
        });
      });

      setLinks(next);
    };

    const schedule = () => {
      if (raf) {
        return;
      }
      raf = requestAnimationFrame(redraw);
    };

    redraw();
    // 首帧布局有时尚未完成，再补两次
    const t1 = window.setTimeout(schedule, 50);
    const t2 = window.setTimeout(schedule, 200);

    sidePane.addEventListener("scroll", schedule, { passive: true });
    resultPane.addEventListener("scroll", schedule, { passive: true });
    window.addEventListener("resize", schedule);

    const observer = new ResizeObserver(schedule);
    observer.observe(gutter);
    observer.observe(sidePane);
    observer.observe(resultPane);
    const sideLines = sidePane.querySelector(".merge-pane-lines");
    const resultLines = resultPane.querySelector(".merge-pane-lines");
    if (sideLines) {
      observer.observe(sideLines);
    }
    if (resultLines) {
      observer.observe(resultLines);
    }

    return () => {
      if (raf) {
        cancelAnimationFrame(raf);
      }
      window.clearTimeout(t1);
      window.clearTimeout(t2);
      sidePane.removeEventListener("scroll", schedule);
      resultPane.removeEventListener("scroll", schedule);
      window.removeEventListener("resize", schedule);
      observer.disconnect();
    };
  }, [
    activeConflict,
    conflicts,
    layoutKey,
    paneEpoch,
    resultPaneRef,
    side,
    sidePaneRef,
  ]);

  return (
    <div
      ref={gutterRef}
      className={`conflict-link-gutter gutter-${side}`}
      aria-label={side === "ours" ? "Yours 冲突连接" : "Theirs 冲突连接"}
    >
      <svg
        className="conflict-link-svg"
        width={size.width}
        height={size.height}
        viewBox={`0 0 ${Math.max(size.width, 1)} ${Math.max(size.height, 1)}`}
      >
        {links.map((link) => {
          const base = link.isChange
            ? "change-link-path"
            : "conflict-link-path";
          return (
            <path
              key={link.index}
              d={link.path}
              className={link.isActive ? `${base} is-active` : base}
              onClick={() => onSelectConflict(link.index)}
            />
          );
        })}
      </svg>
    </div>
  );
}
