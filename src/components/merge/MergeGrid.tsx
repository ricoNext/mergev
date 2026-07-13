import { useLayoutEffect, useMemo, useRef, useState } from "react";
import type { ConflictRegion, MergeRow, ConflictDecision } from "../../types";
import type { PaneHighlights } from "../../syntaxHighlight";
import { buildRenderTokens } from "../../renderTokens";
import { wordDiffTokens } from "../../utils/diffUtils";
import { sideDecisionMerged, emptyResolution } from "../../utils/conflictUtils";
import { sideRowKind } from "../../utils/rowKindUtils";
import { useLinkedPaneScroll } from "../../hooks/useLinkedPaneScroll";
import { ConflictLinkGutter } from "./ConflictLinkGutter";
import { MergeCell } from "./MergeCell";

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

  // 三栏按同一 data-row-index / 冲突连接带对齐纵向滚动
  useLinkedPaneScroll(oursPaneRef, resultPaneRef, theirsPaneRef, paneEpoch);

  const actionRowByConflict = useMemo(() => {
    const map = new Map<number, number>();
    for (const conflict of conflicts) {
      map.set(conflict.index, conflict.rowStart);
    }
    return map;
  }, [conflicts]);

  // 某侧完全没有内容的冲突：红块仍要在首行留占位以便连接带定位；
  // 单方绿块只在有内容侧展示，空侧不占位（避免左侧出现绿色空块）。
  const emptySideConflicts = useMemo(() => {
    const ours = new Set<number>();
    const theirs = new Set<number>();
    for (const conflict of conflicts) {
      if (conflict.blockKind === "change") {
        continue;
      }
      ours.add(conflict.index);
      theirs.add(conflict.index);
    }
    for (const row of rows) {
      if (row.conflictIndex === null) {
        continue;
      }
      if (row.oursLine) {
        ours.delete(row.conflictIndex);
      }
      if (row.theirsLine) {
        theirs.delete(row.conflictIndex);
      }
    }
    return { ours, theirs };
  }, [conflicts, rows]);

  const renderedRows = rows.map((row, index) => {
    const isActive =
      row.conflictIndex !== null && row.conflictIndex === activeConflict;
    const showActions =
      row.conflictIndex !== null &&
      actionRowByConflict.get(row.conflictIndex) === index;
    const conflict =
      row.conflictIndex !== null
        ? conflicts.find((item) => item.index === row.conflictIndex)
        : null;

    const oursText = row.oursLine?.text ?? "";
    const theirsText = row.theirsLine?.text ?? "";
    const shouldDiff =
      (row.kind === "conflict" || row.kind === "insert") &&
      row.conflictIndex !== null &&
      row.oursLine !== null &&
      row.theirsLine !== null &&
      oursText !== theirsText;
    const sideTokens = shouldDiff ? wordDiffTokens(oursText, theirsText) : null;
    const oursMerged = sideDecisionMerged("ours", conflict);
    const theirsMerged = sideDecisionMerged("theirs", conflict);
    const resultDiffTokens =
      sideTokens && conflict
        ? conflict.decision === "ours"
          ? sideTokens.left
          : conflict.decision === "theirs"
            ? sideTokens.right
            : null
        : null;

    const highlightLine = index + 1;
    const oursSyntax =
      row.oursLine != null
        ? paneHighlights.ours.get(highlightLine)
        : undefined;
    const resultSyntax =
      row.resultLine != null
        ? paneHighlights.result.get(highlightLine)
        : undefined;
    const theirsSyntax =
      row.theirsLine != null
        ? paneHighlights.theirs.get(highlightLine)
        : undefined;

    return {
      row,
      index,
      isActive,
      showActions,
      conflict,
      oursTokens: buildRenderTokens(
        oursSyntax,
        oursMerged ? undefined : sideTokens?.left,
      ),
      resultTokens: buildRenderTokens(
        resultSyntax,
        resultDiffTokens ?? undefined,
      ),
      theirsTokens: buildRenderTokens(
        theirsSyntax,
        theirsMerged ? undefined : sideTokens?.right,
      ),
    };
  });

  const oursItems = renderedRows.filter(
    (item) =>
      item.row.oursLine !== null ||
      (item.showActions &&
        item.row.conflictIndex !== null &&
        emptySideConflicts.ours.has(item.row.conflictIndex) &&
        !sideDecisionMerged("ours", item.conflict)),
  );
  const theirsItems = renderedRows.filter(
    (item) =>
      item.row.theirsLine !== null ||
      (item.showActions &&
        item.row.conflictIndex !== null &&
        emptySideConflicts.theirs.has(item.row.conflictIndex) &&
        !sideDecisionMerged("theirs", item.conflict)),
  );
  // Result：只渲染有 resultLine 的行；未解决冲突仅一行细占位，连接带向中间收窄
  const resultItems = renderedRows.filter(
    (item) => item.row.resultLine !== null,
  );

  // 若 session.conflicts 异常为空，仍从 rows 恢复，保证 gutter 能画出操作块
  const linkConflicts = useMemo(() => {
    if (conflicts.length > 0) {
      return conflicts;
    }
    const map = new Map<number, ConflictRegion>();
    rows.forEach((row, index) => {
      if (row.conflictIndex == null) {
        return;
      }
      const existing = map.get(row.conflictIndex);
      if (existing) {
        existing.rowEnd = index;
        if (row.oursLine?.text) {
          existing.ours = existing.ours
            ? `${existing.ours}\n${row.oursLine.text}`
            : row.oursLine.text;
        }
        if (row.theirsLine?.text) {
          existing.theirs = existing.theirs
            ? `${existing.theirs}\n${row.theirsLine.text}`
            : row.theirsLine.text;
        }
        return;
      }
      map.set(row.conflictIndex, {
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
    return [...map.values()];
  }, [conflicts, rows]);

  const layoutKey = `${rows.length}:${linkConflicts
    .map(
      (item) =>
        `${item.index}:${item.decision}:${item.resolution.ours}:${item.resolution.theirs}:${item.blockKind ?? ""}:${item.rowStart}:${item.rowEnd}`,
    )
    .join("|")}`;

  return (
    <div className="merge-grid" role="table" aria-label="三栏合并视图">
      <div className="merge-pane pane-ours" ref={oursPaneRef}>
        <div className="merge-pane-scroll">
          <div className="merge-pane-lines">
            {oursItems.map((item) => (
              <MergeCell
                key={`${item.row.id}-ours`}
                side="ours"
                rowKind={sideRowKind("ours", item.row.kind, item.conflict)}
                isActive={item.isActive}
                rowIndex={item.index}
                conflictIndex={item.row.conflictIndex}
                line={item.row.oursLine}
                renderTokens={item.oursTokens}
                showActions={
                  item.showActions &&
                  item.conflict?.resolution.ours === "pending"
                }
                decision={item.conflict?.decision}
                resolution={item.conflict?.resolution}
                onSelectConflict={onSelectConflict}
                onDecision={onDecision}
              />
            ))}
          </div>
        </div>
      </div>

      <ConflictLinkGutter
        side="ours"
        conflicts={linkConflicts}
        activeConflict={activeConflict}
        layoutKey={layoutKey}
        paneEpoch={paneEpoch}
        sidePaneRef={oursPaneRef}
        resultPaneRef={resultPaneRef}
        onSelectConflict={onSelectConflict}
      />

      <div className="merge-pane pane-result" ref={resultPaneRef}>
        <div className="merge-pane-scroll">
          <div className="merge-pane-lines">
            {resultItems.map((item) => (
              <MergeCell
                key={`${item.row.id}-result`}
                side="result"
                rowKind={item.row.kind}
                isActive={item.isActive}
                rowIndex={item.index}
                conflictIndex={item.row.conflictIndex}
                line={item.row.resultLine}
                renderTokens={item.resultTokens}
                decision={item.conflict?.decision}
                onSelectConflict={onSelectConflict}
              />
            ))}
          </div>
        </div>
      </div>

      <ConflictLinkGutter
        side="theirs"
        conflicts={linkConflicts}
        activeConflict={activeConflict}
        layoutKey={layoutKey}
        paneEpoch={paneEpoch}
        sidePaneRef={theirsPaneRef}
        resultPaneRef={resultPaneRef}
        onSelectConflict={onSelectConflict}
      />

      <div className="merge-pane pane-theirs" ref={theirsPaneRef}>
        <div className="merge-pane-scroll">
          <div className="merge-pane-lines">
            {theirsItems.map((item) => (
              <MergeCell
                key={`${item.row.id}-theirs`}
                side="theirs"
                rowKind={sideRowKind("theirs", item.row.kind, item.conflict)}
                isActive={item.isActive}
                rowIndex={item.index}
                conflictIndex={item.row.conflictIndex}
                line={item.row.theirsLine}
                renderTokens={item.theirsTokens}
                showActions={
                  item.showActions &&
                  item.conflict?.resolution.theirs === "pending"
                }
                decision={item.conflict?.decision}
                resolution={item.conflict?.resolution}
                onSelectConflict={onSelectConflict}
                onDecision={onDecision}
              />
            ))}
          </div>
        </div>
      </div>
    </div>
  );
}
