import type {
  ConflictRegion,
  ConflictResolution,
  MergeDocument,
  MergeRow,
  MergeSession,
  PaneLine,
  ResultLine,
} from "../types";
import {
  decisionFromResolution,
  decisionResultLines,
  emptyResolution,
  isResolutionComplete,
  sideHasSubstantive,
} from "../utils/conflictUtils";

export function buildSessionFromDocument(document: MergeDocument): MergeSession {
  return rebuildSession(
    document,
    document.conflicts.map(() => emptyResolution()),
    document.conflicts.length > 0 ? 0 : -1,
    false,
  );
}

export function rebuildSession(
  document: MergeDocument,
  resolutions: ConflictResolution[],
  activeConflict: number,
  dirty: boolean,
): MergeSession {
  const decisions = resolutions.map(decisionFromResolution);
  const rows: MergeRow[] = [];
  const resultLines: ResultLine[] = [];
  const conflicts: ConflictRegion[] = [];

  let oursLineNo = 1;
  let theirsLineNo = 1;
  let resultLineNo = 1;
  let conflictCursor = 0;
  let rowIndex = 0;

  while (rowIndex < document.rows.length) {
    const row = document.rows[rowIndex];
    // 兼容 JSON null / 缺省 undefined
    if (row.conflictIndex == null) {
      const resultLine = row.resultLine
        ? {
            number: resultLineNo,
            text: row.resultLine.text,
          }
        : null;
      rows.push({
        id: `r${rows.length}`,
        kind: row.kind,
        conflictIndex: null,
        oursLine: row.oursLine,
        resultLine,
        theirsLine: row.theirsLine,
      });
      if (resultLine) {
        const source =
          document.result.find(
            (line) =>
              line.conflictIndex == null && line.text === resultLine.text,
          )?.source ?? "context";
        resultLines.push({
          source,
          conflictIndex: null,
          text: resultLine.text,
        });
        resultLineNo += 1;
      }
      if (row.oursLine?.number != null) {
        oursLineNo = row.oursLine.number + 1;
      }
      if (row.theirsLine?.number != null) {
        theirsLineNo = row.theirsLine.number + 1;
      }
      rowIndex += 1;
      continue;
    }

    const conflictIndex = row.conflictIndex;
    const region =
      document.conflicts.find((item) => item.index === conflictIndex) ??
      document.conflicts[conflictCursor];
    const decision = decisions[conflictIndex] ?? "unresolved";
    const resolution = resolutions[conflictIndex] ?? emptyResolution();
    const blockKind =
      region.blockKind ??
      (sideHasSubstantive(region.ours) && sideHasSubstantive(region.theirs)
        ? "conflict"
        : "change");
    const rowKind = blockKind === "change" ? "insert" : "conflict";

    // 从文档行重建，保留空行与两侧对齐（避免 join/splitLines 丢空行）
    const conflictDocRows: MergeRow[] = [];
    {
      let i = rowIndex;
      while (
        i < document.rows.length &&
        document.rows[i].conflictIndex === conflictIndex
      ) {
        conflictDocRows.push(document.rows[i]);
        i += 1;
      }
    }

    let docOffset = 0;
    // 单方绿块：空侧前导空行提成上下文（Express 下空行留在左侧）
    if (blockKind === "change") {
      while (docOffset < conflictDocRows.length) {
        const docRow = conflictDocRows[docOffset];
        const oursIsBlank =
          docRow.oursLine != null && docRow.oursLine.text.trim() === "";
        const theirsIsBlank =
          docRow.theirsLine != null && docRow.theirsLine.text.trim() === "";
        const peelLeft =
          !sideHasSubstantive(region.ours) &&
          oursIsBlank &&
          (docRow.theirsLine == null || !theirsIsBlank);
        const peelRight =
          !sideHasSubstantive(region.theirs) &&
          theirsIsBlank &&
          (docRow.oursLine == null || !oursIsBlank);
        if (!peelLeft && !peelRight) {
          break;
        }
        if (peelLeft) {
          rows.push({
            id: `r${rows.length}`,
            kind: "context",
            conflictIndex: null,
            oursLine: docRow.oursLine,
            resultLine: null,
            theirsLine: null,
          });
          if (docRow.oursLine?.number != null) {
            oursLineNo = docRow.oursLine.number + 1;
          }
          // 同一行还有右侧实质内容时，只剥左侧空行，右侧留在冲突块
          if (docRow.theirsLine != null && !theirsIsBlank) {
            conflictDocRows[docOffset] = {
              ...docRow,
              oursLine: null,
            };
            break;
          }
          docOffset += 1;
          continue;
        }
        rows.push({
          id: `r${rows.length}`,
          kind: "context",
          conflictIndex: null,
          oursLine: null,
          resultLine: null,
          theirsLine: docRow.theirsLine,
        });
        if (docRow.theirsLine?.number != null) {
          theirsLineNo = docRow.theirsLine.number + 1;
        }
        if (docRow.oursLine != null && !oursIsBlank) {
          conflictDocRows[docOffset] = {
            ...docRow,
            theirsLine: null,
          };
          break;
        }
        docOffset += 1;
      }
    }

    const remainingDocRows = conflictDocRows.slice(docOffset);
    const oursText = remainingDocRows
      .map((item) => item.oursLine?.text)
      .filter((text): text is string => text != null)
      .join("\n");
    const theirsText = remainingDocRows
      .map((item) => item.theirsLine?.text)
      .filter((text): text is string => text != null)
      .join("\n");

    const { source, lines: conflictResult } = decisionResultLines(
      decision,
      oursText || region.ours,
      theirsText || region.theirs,
    );
    const rowStart = rows.length;
    const rowCount = Math.max(
      remainingDocRows.length,
      conflictResult.length,
      1,
    );

    for (let offset = 0; offset < rowCount; offset += 1) {
      const docRow = remainingDocRows[offset];
      let oursLine: PaneLine | null = docRow?.oursLine ?? null;
      let theirsLine: PaneLine | null = docRow?.theirsLine ?? null;
      let resultLine: PaneLine | null = null;

      if (oursLine) {
        oursLineNo = (oursLine.number ?? oursLineNo) + 1;
      }
      if (theirsLine) {
        theirsLineNo = (theirsLine.number ?? theirsLineNo) + 1;
      }
      if (offset < conflictResult.length) {
        resultLine = { number: resultLineNo, text: conflictResult[offset] };
        resultLineNo += 1;
      }

      rows.push({
        id: `r${rows.length}`,
        kind: oursLine || theirsLine || resultLine ? rowKind : "empty",
        conflictIndex,
        oursLine,
        resultLine,
        theirsLine,
      });
    }

    for (const text of conflictResult) {
      resultLines.push({
        source,
        conflictIndex,
        text,
      });
    }

    conflicts.push({
      index: conflictIndex,
      rowStart,
      rowEnd: rows.length - 1,
      decision,
      resolution,
      blockKind,
      ours: oursText || region.ours,
      theirs: theirsText || region.theirs,
    });

    rowIndex += conflictDocRows.length;
    conflictCursor += 1;
  }

  const unresolvedCount = conflicts.filter(
    (conflict) => !isResolutionComplete(conflict.resolution, conflict),
  ).length;
  const nextActive =
    activeConflict >= 0 && activeConflict < conflicts.length
      ? activeConflict
      : conflicts.length > 0
        ? 0
        : -1;

  return {
    document: {
      ...document,
      unresolvedCount,
    },
    resolutions,
    decisions,
    rows,
    resultLines,
    conflicts,
    activeConflict: nextActive,
    dirty,
  };
}

export function serializeResult(resultLines: ResultLine[], endsWithNewline: boolean): string {
  const body = resultLines.map((line) => line.text).join("\n");
  if (endsWithNewline && body.length > 0 && !body.endsWith("\n")) {
    return `${body}\n`;
  }
  return body;
}

export function paneHighlightText(
  rows: MergeRow[],
  side: "ours" | "result" | "theirs",
): string {
  return rows
    .map((row) => {
      if (side === "ours") {
        return row.oursLine?.text ?? "";
      }
      if (side === "theirs") {
        return row.theirsLine?.text ?? "";
      }
      return row.resultLine?.text ?? "";
    })
    .join("\n");
}
