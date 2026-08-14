import { useLayoutEffect, useRef, useState, type RefObject } from "react";
import type { ConflictRegion } from "../../types";
import type { PaneRowIndex } from "../../hooks/useLinkedPaneScroll";
import {
	isChangeBlock,
	sideDecisionMerged,
	sideHasSubstantive,
} from "../../utils/conflictUtils";

type ConflictLink = {
	index: number;
	isChange: boolean;
};

type PaneGeometry = {
	cellContentTops: Map<HTMLElement, number>;
	cellHeights: Map<HTMLElement, number>;
	conflicts: Map<number, { first: HTMLElement; last: HTMLElement }>;
	rows: Array<{ rowIndex: number; cell: HTMLElement }>;
};

function shouldRenderLink(
	side: "ours" | "theirs",
	conflict: ConflictRegion,
): boolean {
	if (sideDecisionMerged(side, conflict)) {
		return false;
	}
	if (isChangeBlock(conflict)) {
		const sideText = side === "ours" ? conflict.ours : conflict.theirs;
		return sideHasSubstantive(sideText);
	}
	return true;
}

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

function buildPaneGeometry(pane: HTMLElement): PaneGeometry {
	const lines = pane.querySelector(".merge-pane-lines");
	const paneRect = pane.getBoundingClientRect();
	const cellContentTops = new Map<HTMLElement, number>();
	const cellHeights = new Map<HTMLElement, number>();
	const conflicts = new Map<
		number,
		{ first: HTMLElement; last: HTMLElement }
	>();
	const rows: Array<{ rowIndex: number; cell: HTMLElement }> = [];

	if (!(lines instanceof HTMLElement)) {
		return { cellContentTops, cellHeights, conflicts, rows };
	}

	for (const child of lines.children) {
		if (!(child instanceof HTMLElement)) {
			continue;
		}

		const rect = child.getBoundingClientRect();
		cellContentTops.set(child, rect.top - paneRect.top + pane.scrollTop);
		cellHeights.set(child, rect.height);

		const rowIndex = Number(child.getAttribute("data-row-index"));
		if (!Number.isNaN(rowIndex)) {
			rows.push({ rowIndex, cell: child });
		}

		const conflictIndex = Number(child.getAttribute("data-conflict-index"));
		if (Number.isNaN(conflictIndex)) {
			continue;
		}

		const existing = conflicts.get(conflictIndex);
		if (existing) {
			existing.last = child;
		} else {
			conflicts.set(conflictIndex, { first: child, last: child });
		}
	}

	return { cellContentTops, cellHeights, conflicts, rows };
}

function cellTop(
	pane: HTMLElement,
	geometry: PaneGeometry,
	cell: HTMLElement,
	gutterOffset: number,
): number {
	return (
		(geometry.cellContentTops.get(cell) ?? 0) - pane.scrollTop + gutterOffset
	);
}

/** 相对 gutter 顶边的冲突块 Y 区间（pane 与 gutter 同列对齐） */
function measureConflictY(
	pane: HTMLElement,
	geometry: PaneGeometry,
	gutterOffset: number,
	conflictIndex: number,
	lineHeight: number,
): { top: number; bottom: number } | null {
	const cells = geometry.conflicts.get(conflictIndex);
	if (!cells) {
		return null;
	}
	const top = cellTop(pane, geometry, cells.first, gutterOffset);
	const bottom = Math.max(
		cellTop(pane, geometry, cells.last, gutterOffset) +
			(geometry.cellHeights.get(cells.last) ?? lineHeight),
		top + lineHeight,
	);
	return { top, bottom };
}

function findLastBefore(
	rows: Array<{ rowIndex: number; cell: HTMLElement }>,
	rowIndex: number,
): HTMLElement | null {
	let lo = 0;
	let hi = rows.length - 1;
	let result: HTMLElement | null = null;
	while (lo <= hi) {
		const mid = (lo + hi) >> 1;
		if (rows[mid].rowIndex < rowIndex) {
			result = rows[mid].cell;
			lo = mid + 1;
		} else {
			hi = mid - 1;
		}
	}
	return result;
}

function findFirstAfter(
	rows: Array<{ rowIndex: number; cell: HTMLElement }>,
	rowIndex: number,
): HTMLElement | null {
	let lo = 0;
	let hi = rows.length - 1;
	let result: HTMLElement | null = null;
	while (lo <= hi) {
		const mid = (lo + hi) >> 1;
		if (rows[mid].rowIndex > rowIndex) {
			result = rows[mid].cell;
			hi = mid - 1;
		} else {
			lo = mid + 1;
		}
	}
	return result;
}

function measureResultY(
	resultPane: HTMLElement,
	geometry: PaneGeometry,
	gutterOffset: number,
	conflict: ConflictRegion,
	fallback: { top: number; bottom: number },
	lineHeight: number,
): { top: number; bottom: number } {
	const direct = measureConflictY(
		resultPane,
		geometry,
		gutterOffset,
		conflict.index,
		lineHeight,
	);
	if (direct) {
		return direct;
	}

	const before = findLastBefore(geometry.rows, conflict.rowStart);
	const after = findFirstAfter(geometry.rows, conflict.rowEnd);

	if (before) {
		const y =
			cellTop(resultPane, geometry, before, gutterOffset) +
			(geometry.cellHeights.get(before) ?? lineHeight);
		return { top: y, bottom: y + lineHeight };
	}
	if (after) {
		const y = cellTop(resultPane, geometry, after, gutterOffset);
		return { top: y - lineHeight, bottom: y };
	}
	return fallback;
}

function rowPositionMap(rows: PaneRowIndex[]): Map<number, number> {
	return new Map(rows.map((row, position) => [row.rowIndex, position]));
}

function measureVirtualConflictY(
	pane: HTMLElement,
	positions: Map<number, number>,
	conflict: ConflictRegion,
	gutterOffset: number,
	lineHeight: number,
): { top: number; bottom: number } | null {
	let first = Number.POSITIVE_INFINITY;
	let last = Number.NEGATIVE_INFINITY;
	for (
		let rowIndex = conflict.rowStart;
		rowIndex <= conflict.rowEnd;
		rowIndex += 1
	) {
		const position = positions.get(rowIndex);
		if (position == null) continue;
		first = Math.min(first, position);
		last = Math.max(last, position);
	}
	if (!Number.isFinite(first) || !Number.isFinite(last)) return null;
	const top = first * lineHeight - pane.scrollTop + gutterOffset;
	const bottom = Math.max(
		top + lineHeight,
		(last + 1) * lineHeight - pane.scrollTop + gutterOffset,
	);
	return { top, bottom };
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
	sideRows,
	resultRows,
	sidePaneRef,
	resultPaneRef,
	onSelectConflict,
}: {
	side: "ours" | "theirs";
	conflicts: ConflictRegion[];
	activeConflict: number;
	layoutKey: string;
	paneEpoch: number;
	sideRows: PaneRowIndex[];
	resultRows: PaneRowIndex[];
	sidePaneRef: RefObject<HTMLDivElement | null>;
	resultPaneRef: RefObject<HTMLDivElement | null>;
	onSelectConflict: (index: number) => void;
}) {
	const gutterRef = useRef<HTMLDivElement>(null);
	const pathRefs = useRef(new Map<number, SVGPathElement>());
	const sizeRef = useRef({ width: 0, height: 0 });
	const [size, setSize] = useState({ width: 0, height: 0 });

	const linkItems: ConflictLink[] = conflicts
		.filter((conflict) => shouldRenderLink(side, conflict))
		.map((conflict) => ({
			index: conflict.index,
			isChange: isChangeBlock(conflict),
		}));

	useLayoutEffect(() => {
		const gutter = gutterRef.current;
		const sidePane = sidePaneRef.current;
		const resultPane = resultPaneRef.current;
		if (!gutter || !sidePane || !resultPane) {
			return;
		}

		let raf = 0;
		const resultGeometry = buildPaneGeometry(resultPane);
		const sidePositions = rowPositionMap(sideRows);
		const resultPositions = rowPositionMap(resultRows);
		const linkConflicts = conflicts.filter((conflict) =>
			shouldRenderLink(side, conflict),
		);

		// 这些值用于在布局变化后重建几何缓存。
		void layoutKey;
		void paneEpoch;

		const redraw = () => {
			raf = 0;
			const gutterRect = gutter.getBoundingClientRect();
			const width = Math.max(gutter.clientWidth, gutterRect.width, 1);
			const height = Math.max(gutter.clientHeight, gutterRect.height, 1);
			const sideOffset = sidePane.getBoundingClientRect().top - gutterRect.top;
			const resultOffset =
				resultPane.getBoundingClientRect().top - gutterRect.top;
			if (
				sizeRef.current.width !== width ||
				sizeRef.current.height !== height
			) {
				sizeRef.current = { width, height };
				setSize({ width, height });
			}

			const lineHeight = readLineHeight(sidePane);

			linkConflicts.forEach((conflict, order) => {
				const measuredSide = measureVirtualConflictY(
					sidePane,
					sidePositions,
					conflict,
					sideOffset,
					lineHeight,
				);
				const sideBlock = measuredSide ?? {
					top: Math.min(height - lineHeight, 24 + order * lineHeight * 4),
					bottom: Math.min(
						height,
						24 + order * lineHeight * 4 + lineHeight * 3,
					),
				};
				const measuredResult = measureVirtualConflictY(
					resultPane,
					resultPositions,
					conflict,
					resultOffset,
					lineHeight,
				);
				const resultBlock =
					measuredResult ??
					measureResultY(
						resultPane,
						resultGeometry,
						resultOffset,
						conflict,
						{
							top: (sideBlock.top + sideBlock.bottom) / 2 - lineHeight / 2,
							bottom: (sideBlock.top + sideBlock.bottom) / 2 + lineHeight / 2,
						},
						lineHeight,
					);

				const sideTop = sideBlock.top;
				const sideBottom = Math.max(sideTop + 2, sideBlock.bottom);
				const { top: resultTop, bottom: resultBottom } = resultRibbonSpan(
					resultBlock.top,
					resultBlock.bottom,
					lineHeight,
					conflict.decision === "unresolved",
				);

				const pathElement = pathRefs.current.get(conflict.index);
				const isOutside =
					(sideBottom < -120 && resultBottom < -120) ||
					(sideTop > height + 120 && resultTop > height + 120);

				if (isOutside) {
					pathElement?.style.setProperty("display", "none");
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

				if (pathElement) {
					pathElement.setAttribute("d", path);
					pathElement.style.removeProperty("display");
				}
			});
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
		conflicts,
		layoutKey,
		paneEpoch,
		resultPaneRef,
		resultRows,
		side,
		sidePaneRef,
		sideRows,
	]);

	return (
		<div
			ref={gutterRef}
			className={`conflict-link-gutter gutter-${side}`}
			aria-label={side === "ours" ? "当前冲突连接" : "对方冲突连接"}
		>
			<svg
				className="conflict-link-svg"
				width={size.width}
				height={size.height}
				viewBox={`0 0 ${Math.max(size.width, 1)} ${Math.max(size.height, 1)}`}
			>
				{linkItems.map((link) => {
					const base = link.isChange
						? "change-link-path"
						: "conflict-link-path";
					return (
						<path
							key={link.index}
							ref={(element) => {
								if (element) {
									pathRefs.current.set(link.index, element);
								} else {
									pathRefs.current.delete(link.index);
								}
							}}
							d=""
							className={
								link.index === activeConflict ? `${base} is-active` : base
							}
							onClick={() => onSelectConflict(link.index)}
						/>
					);
				})}
			</svg>
		</div>
	);
}
