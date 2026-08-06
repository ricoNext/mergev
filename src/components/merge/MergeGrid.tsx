import { useLayoutEffect, useMemo, useRef, useState } from "react";
import type { ConflictDecision, ConflictRegion, MergeRow } from "../../types";
import type { PaneHighlights } from "../../syntaxHighlight";
import { buildRenderTokens } from "../../renderTokens";
import { wordDiffTokens } from "../../utils/diffUtils";
import { emptyResolution, sideDecisionMerged } from "../../utils/conflictUtils";
import { sideRowKind } from "../../utils/rowKindUtils";
import {
	useLinkedPaneScroll,
	type PaneRowIndex,
} from "../../hooks/useLinkedPaneScroll";
import { ConflictLinkGutter } from "./ConflictLinkGutter";
import { MergeCell } from "./MergeCell";

const MAX_WORD_DIFF_LENGTH = 4_000;

type RenderItem = {
	row: MergeRow;
	index: number;
	conflict: ConflictRegion | null;
	showActions: boolean;
};

function sliceRange<T>(items: T[], range: { start: number; end: number }): T[] {
	return items.slice(range.start, range.end);
}

function readLineHeight(pane: HTMLElement): number {
	const raw = getComputedStyle(pane).getPropertyValue("--line-height").trim();
	if (raw.endsWith("rem")) {
		const rem = Number.parseFloat(raw);
		const root = Number.parseFloat(
			getComputedStyle(document.documentElement).fontSize,
		);
		if (!Number.isNaN(rem) && !Number.isNaN(root)) return rem * root;
	}
	const pixels = Number.parseFloat(raw);
	return Number.isNaN(pixels) ? 24.8 : pixels;
}

export function MergeGrid({
	rows,
	conflicts,
	activeConflict,
	paneHighlights,
	onSelectConflict,
	onDecision,
}: {
	rows: MergeRow[];
	conflicts: ConflictRegion[];
	activeConflict: number;
	paneHighlights: PaneHighlights;
	onSelectConflict: (index: number) => void;
	onDecision: (
		decision: ConflictDecision | "ignoreOurs" | "ignoreTheirs",
		conflictIndex: number,
	) => void;
}) {
	const oursPaneRef = useRef<HTMLDivElement>(null);
	const resultPaneRef = useRef<HTMLDivElement>(null);
	const theirsPaneRef = useRef<HTMLDivElement>(null);
	const [paneEpoch, setPaneEpoch] = useState(0);

	useLayoutEffect(() => {
		setPaneEpoch((value) => value + 1);
	}, [rows, conflicts]);

	const conflictByIndex = useMemo(
		() => new Map(conflicts.map((conflict) => [conflict.index, conflict])),
		[conflicts],
	);

	const actionRowByConflict = useMemo(
		() =>
			new Map(conflicts.map((conflict) => [conflict.index, conflict.rowStart])),
		[conflicts],
	);

	const emptySideConflicts = useMemo(() => {
		const ours = new Set<number>();
		const theirs = new Set<number>();
		for (const conflict of conflicts) {
			if (conflict.blockKind !== "change") {
				ours.add(conflict.index);
				theirs.add(conflict.index);
			}
		}
		for (const row of rows) {
			if (row.conflictIndex == null) continue;
			if (row.oursLine) ours.delete(row.conflictIndex);
			if (row.theirsLine) theirs.delete(row.conflictIndex);
		}
		return { ours, theirs };
	}, [conflicts, rows]);

	const paneItems = useMemo(() => {
		const ours: RenderItem[] = [];
		const result: RenderItem[] = [];
		const theirs: RenderItem[] = [];

		rows.forEach((row, index) => {
			const conflict =
				row.conflictIndex == null
					? null
					: (conflictByIndex.get(row.conflictIndex) ?? null);
			const item: RenderItem = {
				row,
				index,
				conflict,
				showActions:
					row.conflictIndex != null &&
					actionRowByConflict.get(row.conflictIndex) === index,
			};
			if (
				row.oursLine ||
				(item.showActions &&
					row.conflictIndex != null &&
					emptySideConflicts.ours.has(row.conflictIndex) &&
					!sideDecisionMerged("ours", conflict))
			) {
				ours.push(item);
			}
			if (row.resultLine) result.push(item);
			if (
				row.theirsLine ||
				(item.showActions &&
					row.conflictIndex != null &&
					emptySideConflicts.theirs.has(row.conflictIndex) &&
					!sideDecisionMerged("theirs", conflict))
			) {
				theirs.push(item);
			}
		});
		return { ours, result, theirs };
	}, [actionRowByConflict, conflictByIndex, emptySideConflicts, rows]);

	const paneRows = useMemo(
		() => ({
			ours: paneItems.ours.map(
				({ index }): PaneRowIndex => ({ rowIndex: index }),
			),
			result: paneItems.result.map(
				({ index }): PaneRowIndex => ({ rowIndex: index }),
			),
			theirs: paneItems.theirs.map(
				({ index }): PaneRowIndex => ({ rowIndex: index }),
			),
		}),
		[paneItems],
	);

	const ranges = useLinkedPaneScroll(
		oursPaneRef,
		resultPaneRef,
		theirsPaneRef,
		paneRows,
		paneEpoch,
	);

	const linkConflicts = useMemo(() => {
		if (conflicts.length > 0) return conflicts;
		const recovered = new Map<number, ConflictRegion>();
		rows.forEach((row, index) => {
			if (row.conflictIndex == null) return;
			const existing = recovered.get(row.conflictIndex);
			if (existing) {
				existing.rowEnd = index;
				return;
			}
			recovered.set(row.conflictIndex, {
				index: row.conflictIndex,
				rowStart: index,
				rowEnd: index,
				decision: "unresolved",
				resolution: emptyResolution(),
				blockKind: row.kind === "insert" ? "change" : "conflict",
				ours: row.oursLine?.text ?? "",
				theirs: row.theirsLine?.text ?? "",
			});
		});
		return [...recovered.values()];
	}, [conflicts, rows]);

	const layoutKey = `${rows.length}:${linkConflicts.map((item) => `${item.index}:${item.decision}:${item.rowStart}:${item.rowEnd}`).join("|")}`;

	useLayoutEffect(() => {
		const positions = [
			{ pane: oursPaneRef.current, items: paneItems.ours },
			{ pane: resultPaneRef.current, items: paneItems.result },
			{ pane: theirsPaneRef.current, items: paneItems.theirs },
		];
		for (const { pane, items } of positions) {
			if (!pane) continue;
			const position = items.findIndex(
				(item) => item.row.conflictIndex === activeConflict,
			);
			if (position < 0) continue;
			const safeLineHeight = readLineHeight(pane);
			const target =
				position * safeLineHeight - pane.clientHeight / 2 + safeLineHeight / 2;
			pane.scrollTo({ top: Math.max(0, target), behavior: "smooth" });
		}
	}, [activeConflict, paneItems]);

	const renderPane = (
		side: "ours" | "result" | "theirs",
		items: RenderItem[],
		range: { start: number; end: number },
	) => {
		const visibleItems = sliceRange(items, range);
		return (
			<div
				className="merge-pane-lines is-virtualized"
				style={{ height: `calc(${items.length} * var(--line-height))` }}
			>
				{visibleItems.map((item, visibleIndex) => {
					const { row, conflict } = item;
					const oursText = row.oursLine?.text ?? "";
					const theirsText = row.theirsLine?.text ?? "";
					const shouldDiff =
						(row.kind === "conflict" || row.kind === "insert") &&
						row.conflictIndex != null &&
						row.oursLine != null &&
						row.theirsLine != null &&
						oursText !== theirsText &&
						oursText.length + theirsText.length <= MAX_WORD_DIFF_LENGTH;
					const diffTokens = shouldDiff
						? wordDiffTokens(oursText, theirsText)
						: null;
					const merged =
						side === "ours"
							? sideDecisionMerged("ours", conflict)
							: side === "theirs"
								? sideDecisionMerged("theirs", conflict)
								: false;
					const selectedDiff =
						side === "ours"
							? diffTokens?.left
							: side === "theirs"
								? diffTokens?.right
								: conflict?.decision === "ours"
									? diffTokens?.left
									: conflict?.decision === "theirs"
										? diffTokens?.right
										: undefined;
					const syntax = paneHighlights[side].get(item.index + 1);
					const line =
						side === "ours"
							? row.oursLine
							: side === "theirs"
								? row.theirsLine
								: row.resultLine;
					const rowKind =
						side === "result"
							? row.kind
							: sideRowKind(side, row.kind, conflict);
					const position = range.start + visibleIndex;
					return (
						<MergeCell
							key={`${row.id}-${side}`}
							side={side}
							rowKind={rowKind}
							isActive={item.row.conflictIndex === activeConflict}
							rowIndex={item.index}
							conflictIndex={row.conflictIndex}
							line={line}
							renderTokens={buildRenderTokens(
								syntax,
								merged ? undefined : selectedDiff,
							)}
							showActions={
								item.showActions &&
								side !== "result" &&
								conflict?.resolution[side] === "pending"
							}
							decision={conflict?.decision}
							resolution={conflict?.resolution}
							onSelectConflict={onSelectConflict}
							onDecision={onDecision}
							style={{ top: `calc(${position} * var(--line-height))` }}
						/>
					);
				})}
			</div>
		);
	};

	return (
		<div className="merge-grid" role="table" aria-label="三栏合并视图">
			<div className="merge-pane pane-ours" ref={oursPaneRef}>
				<div className="merge-pane-scroll">
					{renderPane("ours", paneItems.ours, ranges.ours)}
				</div>
			</div>
			<ConflictLinkGutter
				side="ours"
				conflicts={linkConflicts}
				activeConflict={activeConflict}
				layoutKey={layoutKey}
				paneEpoch={paneEpoch}
				sideRows={paneRows.ours}
				resultRows={paneRows.result}
				sidePaneRef={oursPaneRef}
				resultPaneRef={resultPaneRef}
				onSelectConflict={onSelectConflict}
			/>
			<div className="merge-pane pane-result" ref={resultPaneRef}>
				<div className="merge-pane-scroll">
					{renderPane("result", paneItems.result, ranges.result)}
				</div>
			</div>
			<ConflictLinkGutter
				side="theirs"
				conflicts={linkConflicts}
				activeConflict={activeConflict}
				layoutKey={layoutKey}
				paneEpoch={paneEpoch}
				sideRows={paneRows.theirs}
				resultRows={paneRows.result}
				sidePaneRef={theirsPaneRef}
				resultPaneRef={resultPaneRef}
				onSelectConflict={onSelectConflict}
			/>
			<div className="merge-pane pane-theirs" ref={theirsPaneRef}>
				<div className="merge-pane-scroll">
					{renderPane("theirs", paneItems.theirs, ranges.theirs)}
				</div>
			</div>
		</div>
	);
}
