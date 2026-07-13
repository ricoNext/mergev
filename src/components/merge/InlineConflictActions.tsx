import type { ConflictDecision, ConflictResolution } from "../../types";
import { decisionIncludesOurs, decisionIncludesTheirs } from "../../utils/conflictUtils";

export function InlineConflictActions({
  side,
  decision,
  resolution,
  onDecision,
}: {
  side: "ours" | "theirs";
  decision: ConflictDecision;
  resolution: ConflictResolution;
  onDecision: (
    decision: ConflictDecision | "ignoreOurs" | "ignoreTheirs",
  ) => void;
}) {
  const acceptTitle =
    side === "ours" ? "Accept Yours (1)" : "Accept Theirs (2)";
  const ignoreTitle =
    side === "ours" ? "Ignore Yours" : "Ignore Theirs";

  if (side === "ours") {
    return (
      <div className="inline-actions">
        <button
          type="button"
          className={
            resolution.ours === "ignored" ? "inline-btn active" : "inline-btn"
          }
          title={ignoreTitle}
          onClick={(event) => {
            event.stopPropagation();
            onDecision("ignoreOurs");
          }}
        >
          ×
        </button>
        <button
          type="button"
          className={
            decisionIncludesOurs(decision) ? "inline-btn active" : "inline-btn"
          }
          title={acceptTitle}
          onClick={(event) => {
            event.stopPropagation();
            onDecision("ours");
          }}
        >
          ≫
        </button>
      </div>
    );
  }

  return (
    <div className="inline-actions">
      <button
        type="button"
        className={
          decisionIncludesTheirs(decision) ? "inline-btn active" : "inline-btn"
        }
        title={acceptTitle}
        onClick={(event) => {
          event.stopPropagation();
          onDecision("theirs");
        }}
      >
        ≪
      </button>
      <button
        type="button"
        className={
          resolution.theirs === "ignored" ? "inline-btn active" : "inline-btn"
        }
        title={ignoreTitle}
        onClick={(event) => {
          event.stopPropagation();
          onDecision("ignoreTheirs");
        }}
      >
        ×
      </button>
    </div>
  );
}
