import { useEffect, type RefObject } from "react";

type PaneScrollRef = RefObject<HTMLDivElement | null>;

/**
 * 任一栏纵向滚动时，按共享 row-index（连接带两端同一冲突行）同步其余两栏，
 * 使冲突连接线在滚动中保持水平对齐。
 */
export function useLinkedPaneScroll(
  oursPaneRef: PaneScrollRef,
  resultPaneRef: PaneScrollRef,
  theirsPaneRef: PaneScrollRef,
  layoutEpoch: number,
) {
  useEffect(() => {
    const panes = [oursPaneRef.current, resultPaneRef.current, theirsPaneRef.current].filter(
      (el): el is HTMLDivElement => el instanceof HTMLDivElement,
    );
    if (panes.length < 2) {
      return;
    }

    let syncing = false;
    let raf = 0;
    let leader: HTMLDivElement | null = null;

    const cellContentTop = (pane: HTMLElement, cell: HTMLElement) =>
      cell.getBoundingClientRect().top -
      pane.getBoundingClientRect().top +
      pane.scrollTop;

    const findAnchor = (
      pane: HTMLDivElement,
    ): { rowIndex: number; offsetInViewport: number } | null => {
      const lines = pane.querySelector(".merge-pane-lines");
      if (!(lines instanceof HTMLElement) || lines.children.length === 0) {
        return null;
      }
      const children = lines.children;
      const probe = pane.scrollTop + Math.min(48, pane.clientHeight * 0.25);
      let lo = 0;
      let hi = children.length - 1;
      let ans = children.length - 1;
      while (lo <= hi) {
        const mid = (lo + hi) >> 1;
        const el = children[mid];
        if (!(el instanceof HTMLElement)) {
          break;
        }
        const top = cellContentTop(pane, el);
        if (top + el.offsetHeight > probe) {
          ans = mid;
          hi = mid - 1;
        } else {
          lo = mid + 1;
        }
      }
      const cell = children[ans];
      if (!(cell instanceof HTMLElement)) {
        return null;
      }
      const rowIndex = Number(cell.getAttribute("data-row-index"));
      if (Number.isNaN(rowIndex)) {
        return null;
      }
      return {
        rowIndex,
        offsetInViewport: cellContentTop(pane, cell) - pane.scrollTop,
      };
    };

    const syncFrom = (source: HTMLDivElement) => {
      const anchor = findAnchor(source);
      if (!anchor) {
        return;
      }
      syncing = true;
      for (const pane of panes) {
        if (pane === source) {
          continue;
        }
        const cell = pane.querySelector<HTMLElement>(
          `[data-row-index="${anchor.rowIndex}"]`,
        );
        if (!cell) {
          continue;
        }
        const nextTop = cellContentTop(pane, cell) - anchor.offsetInViewport;
        const maxTop = Math.max(0, pane.scrollHeight - pane.clientHeight);
        const clamped = Math.max(0, Math.min(maxTop, nextTop));
        if (Math.abs(pane.scrollTop - clamped) > 0.5) {
          pane.scrollTop = clamped;
        }
      }
      requestAnimationFrame(() => {
        syncing = false;
        leader = null;
      });
    };

    const onScroll = (event: Event) => {
      const source = event.currentTarget;
      if (!(source instanceof HTMLDivElement) || syncing) {
        return;
      }
      if (leader && leader !== source) {
        return;
      }
      leader = source;
      if (raf) {
        cancelAnimationFrame(raf);
      }
      raf = requestAnimationFrame(() => {
        raf = 0;
        syncFrom(source);
      });
    };

    for (const pane of panes) {
      pane.addEventListener("scroll", onScroll, { passive: true });
    }

    return () => {
      if (raf) {
        cancelAnimationFrame(raf);
      }
      for (const pane of panes) {
        pane.removeEventListener("scroll", onScroll);
      }
    };
  }, [layoutEpoch, oursPaneRef, resultPaneRef, theirsPaneRef]);
}
