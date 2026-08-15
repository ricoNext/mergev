import { useEffect, useState, type RefObject } from "react";

type PaneScrollRef = RefObject<HTMLDivElement | null>;

export type PaneRowIndex = {
	rowIndex: number;
};

export type PaneVirtualRanges = {
	ours: { start: number; end: number };
	result: { start: number; end: number };
	theirs: { start: number; end: number };
};

const DEFAULT_LINE_HEIGHT = 24.8;
const OVERSCAN_ROWS = 80;

function readLineHeight(pane: HTMLElement): number {
	const raw = getComputedStyle(pane).getPropertyValue("--line-height").trim();
	if (raw.endsWith("rem")) {
		const rem = Number.parseFloat(raw);
		const root = Number.parseFloat(
			getComputedStyle(document.documentElement).fontSize,
		);
		if (!Number.isNaN(rem) && !Number.isNaN(root)) {
			return rem * root;
		}
	}
	const px = Number.parseFloat(raw);
	return Number.isNaN(px) ? DEFAULT_LINE_HEIGHT : px;
}

function rangeFor(
	pane: HTMLElement,
	rowCount: number,
	lineHeight: number,
): { start: number; end: number } {
	const visibleRows = Math.ceil(pane.clientHeight / lineHeight);
	const firstVisible = Math.floor(pane.scrollTop / lineHeight);
	return {
		start: Math.max(0, firstVisible - OVERSCAN_ROWS),
		end: Math.min(rowCount, firstVisible + visibleRows + OVERSCAN_ROWS),
	};
}

function rangesEqual(a: PaneVirtualRanges, b: PaneVirtualRanges): boolean {
	return (
		a.ours.start === b.ours.start &&
		a.ours.end === b.ours.end &&
		a.result.start === b.result.start &&
		a.result.end === b.result.end &&
		a.theirs.start === b.theirs.start &&
		a.theirs.end === b.theirs.end
	);
}

/**
 * 统一三栏滚动同步与虚拟渲染窗口。行高固定，因此滚动期间只需使用 row-index
 * 位置表，无需查询或测量每一个实际 DOM 行。
 */
export function useLinkedPaneScroll(
	oursPaneRef: PaneScrollRef,
	resultPaneRef: PaneScrollRef,
	theirsPaneRef: PaneScrollRef,
	paneRows: {
		ours: PaneRowIndex[];
		result: PaneRowIndex[];
		theirs: PaneRowIndex[];
	},
	layoutEpoch: number,
): PaneVirtualRanges {
	const [ranges, setRanges] = useState<PaneVirtualRanges>({
		ours: { start: 0, end: OVERSCAN_ROWS * 2 },
		result: { start: 0, end: OVERSCAN_ROWS * 2 },
		theirs: { start: 0, end: OVERSCAN_ROWS * 2 },
	});

	useEffect(() => {
		const entries = [
			{ key: "ours" as const, pane: oursPaneRef.current, rows: paneRows.ours },
			{
				key: "result" as const,
				pane: resultPaneRef.current,
				rows: paneRows.result,
			},
			{
				key: "theirs" as const,
				pane: theirsPaneRef.current,
				rows: paneRows.theirs,
			},
		].filter(
			(
				entry,
			): entry is {
				key: "ours" | "result" | "theirs";
				pane: HTMLDivElement;
				rows: PaneRowIndex[];
			} => entry.pane instanceof HTMLDivElement,
		);

		if (entries.length === 0) {
			return;
		}

		let lineHeight = readLineHeight(entries[0].pane);
		let syncing = false;
		let raf = 0;
		let leader: HTMLDivElement | null = null;

		const rowPositions = new Map<HTMLDivElement, Map<number, number>>();
		for (const entry of entries) {
			rowPositions.set(
				entry.pane,
				new Map(entry.rows.map((row, index) => [row.rowIndex, index])),
			);
		}

		const updateRanges = () => {
			const next = {
				ours: { start: 0, end: 0 },
				result: { start: 0, end: 0 },
				theirs: { start: 0, end: 0 },
			};
			for (const entry of entries) {
				next[entry.key] = rangeFor(entry.pane, entry.rows.length, lineHeight);
			}
			setRanges((current) => (rangesEqual(current, next) ? current : next));
		};

		const syncFrom = (source: HTMLDivElement) => {
			const sourceEntry = entries.find((entry) => entry.pane === source);
			if (!sourceEntry || sourceEntry.rows.length === 0) {
				return;
			}

			const probe = source.scrollTop + Math.min(48, source.clientHeight * 0.25);
			const sourcePosition = Math.min(
				sourceEntry.rows.length - 1,
				Math.max(0, Math.floor(probe / lineHeight)),
			);
			const anchor = sourceEntry.rows[sourcePosition];
			const offsetInViewport = sourcePosition * lineHeight - source.scrollTop;

			syncing = true;
			for (const entry of entries) {
				if (entry.pane === source) {
					continue;
				}
				const position = rowPositions.get(entry.pane)?.get(anchor.rowIndex);
				if (position == null) {
					continue;
				}
				const nextTop = position * lineHeight - offsetInViewport;
				const maxTop = Math.max(
					0,
					entry.pane.scrollHeight - entry.pane.clientHeight,
				);
				const clamped = Math.max(0, Math.min(maxTop, nextTop));
				if (Math.abs(entry.pane.scrollTop - clamped) > 0.5) {
					entry.pane.scrollTop = clamped;
				}
			}
		};

		const flush = () => {
			raf = 0;
			if (leader) {
				syncFrom(leader);
			}
			updateRanges();
			requestAnimationFrame(() => {
				syncing = false;
				leader = null;
			});
		};

		const schedule = () => {
			if (!raf) {
				raf = requestAnimationFrame(flush);
			}
		};

		const onScroll = (event: Event) => {
			const source = event.currentTarget;
			if (!(source instanceof HTMLDivElement)) {
				return;
			}
			if (syncing) {
				return;
			}
			if (!leader || leader === source) {
				leader = source;
			}
			schedule();
		};

		const refresh = () => {
			lineHeight = readLineHeight(entries[0].pane);
			updateRanges();
		};

		refresh();
		for (const entry of entries) {
			entry.pane.addEventListener("scroll", onScroll, { passive: true });
		}
		const observer = new ResizeObserver(refresh);
		for (const entry of entries) {
			observer.observe(entry.pane);
		}

		return () => {
			if (raf) {
				cancelAnimationFrame(raf);
			}
			observer.disconnect();
			for (const entry of entries) {
				entry.pane.removeEventListener("scroll", onScroll);
			}
		};
	}, [layoutEpoch, oursPaneRef, paneRows, resultPaneRef, theirsPaneRef]);

	return ranges;
}
