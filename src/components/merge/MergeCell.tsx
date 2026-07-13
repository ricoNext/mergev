import type { ConflictDecision, ConflictResolution, MergeRowKind, PaneLine } from "../../types";
import type { RenderToken } from "../../renderTokens";
import { InlineConflictActions } from "./InlineConflictActions";
import { emptyResolution } from "../../utils/conflictUtils";

export function MergeCell({
  side,
  rowKind,
  isActive,
  rowIndex,
  conflictIndex,
  line,
  renderTokens,
  showActions = false,
  decision,
  resolution,
  onSelectConflict,
  onDecision,
}: {
  side: "ours" | "result" | "theirs";
  rowKind: MergeRowKind;
  isActive: boolean;
  rowIndex: number;
  conflictIndex: number | null;
  line: PaneLine | null;
  renderTokens?: RenderToken[];
  showActions?: boolean;
  decision?: ConflictDecision;
  resolution?: ConflictResolution;
  onSelectConflict: (index: number) => void;
  onDecision?: (
    decision: ConflictDecision | "ignoreOurs" | "ignoreTheirs",
    conflictIndex: number,
  ) => void;
}) {
  const lineText = line?.text ?? "";
  const safeRenderTokens =
    renderTokens &&
    renderTokens.length > 0 &&
    renderTokens.map((token) => token.text).join("") === lineText
      ? renderTokens
      : undefined;
  const isResultStrip =
    side === "result" &&
    conflictIndex != null &&
    decision === "unresolved" &&
    (rowKind === "conflict" || rowKind === "insert" || rowKind === "delete");
  const isConflictChrome =
    rowKind === "conflict" || rowKind === "insert" || rowKind === "delete";

  const actions =
    showActions &&
    side !== "result" &&
    conflictIndex != null &&
    decision != null &&
    onDecision ? (
      <span
        className={
          isActive ? "cell-actions is-active" : "cell-actions"
        }
      >
        <InlineConflictActions
          side={side}
          decision={decision}
          resolution={resolution ?? emptyResolution()}
          onDecision={(next) => onDecision(next, conflictIndex)}
        />
      </span>
    ) : side !== "result" ? (
      <span className="cell-actions" aria-hidden="true" />
    ) : null;

  return (
    <div
      className={[
        "merge-cell",
        `side-${side}`,
        `row-${rowKind}`,
        line ? "" : "is-empty",
        conflictIndex !== null && isConflictChrome ? "is-conflict" : "",
        isActive && isConflictChrome ? "row-active-conflict" : "",
        isResultStrip ? "is-result-strip" : "",
      ]
        .filter(Boolean)
        .join(" ")}
      data-row-index={rowIndex}
      data-conflict-index={
        conflictIndex != null && isConflictChrome
          ? String(conflictIndex)
          : undefined
      }
      onClick={() => {
        if (conflictIndex != null) {
          onSelectConflict(conflictIndex);
        }
      }}
    >
      <span className="line-number">{line?.number ?? ""}</span>
      {actions}
      <code className="line-text">
        {safeRenderTokens
          ? safeRenderTokens.map((token, index) => (
              <span
                key={index}
                className={
                  token.diffKind
                    ? `token token-${token.diffKind}`
                    : "syntax-token"
                }
                style={token.color ? { color: token.color } : undefined}
              >
                {token.text}
              </span>
            ))
          : lineText.length === 0
            ? " "
            : lineText}
      </code>
    </div>
  );
}
