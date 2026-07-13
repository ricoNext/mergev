import type {
  ConflictDecision,
  ConflictRegion,
  ConflictResolution,
  ResultSource,
} from "../types";
import { splitLines } from "./stringUtils";

export function sideHasSubstantive(text: string): boolean {
  return splitLines(text).some((line) => line.trim().length > 0);
}

export function isChangeBlock(
  conflict:
    | Pick<ConflictRegion, "ours" | "theirs" | "blockKind">
    | null
    | undefined,
): boolean {
  if (!conflict) {
    return false;
  }
  if (conflict.blockKind) {
    return conflict.blockKind === "change";
  }
  return (
    !sideHasSubstantive(conflict.ours) || !sideHasSubstantive(conflict.theirs)
  );
}

export function sideIsSettled(
  side: "ours" | "theirs",
  conflict: ConflictRegion | null | undefined,
): boolean {
  if (!conflict) {
    return false;
  }
  const resolution = conflict.resolution ?? emptyResolution();
  return resolution[side] !== "pending";
}

export function sideNeedsAction(
  side: "ours" | "theirs",
  conflict: ConflictRegion | null | undefined,
): boolean {
  if (!conflict) {
    return false;
  }
  if (!isChangeBlock(conflict)) {
    return true;
  }
  const sideText = side === "ours" ? conflict.ours : conflict.theirs;
  return sideHasSubstantive(sideText);
}

export function sideHasConflictActions(
  side: "ours" | "theirs",
  conflict: ConflictRegion | null | undefined,
): boolean {
  if (!conflict || !sideNeedsAction(side, conflict)) {
    return false;
  }
  return !sideIsSettled(side, conflict);
}

export function sideDecisionMerged(
  side: "ours" | "theirs",
  conflict: ConflictRegion | null | undefined,
): boolean {
  return sideIsSettled(side, conflict);
}

export function emptyResolution(): ConflictResolution {
  return { ours: "pending", theirs: "pending", acceptOrder: [] };
}

export function applyAccept(
  current: ConflictResolution,
  side: "ours" | "theirs",
): ConflictResolution {
  if (current[side] === "accepted") {
    return current;
  }
  return {
    ours: side === "ours" ? "accepted" : current.ours,
    theirs: side === "theirs" ? "accepted" : current.theirs,
    acceptOrder: [...current.acceptOrder.filter((item) => item !== side), side],
  };
}

export function applyIgnore(
  current: ConflictResolution,
  side: "ours" | "theirs",
): ConflictResolution {
  if (current[side] === "ignored") {
    return current;
  }
  return {
    ours: side === "ours" ? "ignored" : current.ours,
    theirs: side === "theirs" ? "ignored" : current.theirs,
    acceptOrder: current.acceptOrder.filter((item) => item !== side),
  };
}

export function decisionFromResolution(resolution: ConflictResolution): ConflictDecision {
  const accepted = resolution.acceptOrder.filter(
    (side) => resolution[side] === "accepted",
  );
  if (accepted.length === 0) {
    if (resolution.ours !== "pending" && resolution.theirs !== "pending") {
      return "empty";
    }
    return "unresolved";
  }
  if (accepted.length === 1) {
    return accepted[0];
  }
  return accepted[0] === "ours" ? "oursThenTheirs" : "theirsThenOurs";
}

export function isResolutionComplete(
  resolution: ConflictResolution,
  conflict: Pick<ConflictRegion, "ours" | "theirs" | "blockKind">,
): boolean {
  const needsOurs =
    !isChangeBlock(conflict) || sideHasSubstantive(conflict.ours);
  const needsTheirs =
    !isChangeBlock(conflict) || sideHasSubstantive(conflict.theirs);
  return (
    (!needsOurs || resolution.ours !== "pending") &&
    (!needsTheirs || resolution.theirs !== "pending")
  );
}

export function resolutionsEqual(
  a: ConflictResolution,
  b: ConflictResolution,
): boolean {
  return (
    a.ours === b.ours &&
    a.theirs === b.theirs &&
    a.acceptOrder.length === b.acceptOrder.length &&
    a.acceptOrder.every((side, index) => side === b.acceptOrder[index])
  );
}

export function decisionIncludesOurs(decision: ConflictDecision): boolean {
  return (
    decision === "ours" ||
    decision === "oursThenTheirs" ||
    decision === "theirsThenOurs"
  );
}

export function decisionIncludesTheirs(decision: ConflictDecision): boolean {
  return (
    decision === "theirs" ||
    decision === "oursThenTheirs" ||
    decision === "theirsThenOurs"
  );
}

export function decisionResultLines(
  decision: ConflictDecision,
  ours: string,
  theirs: string,
): { source: ResultSource; lines: string[] } {
  switch (decision) {
    case "ours":
      return { source: "ours", lines: splitLines(ours) };
    case "theirs":
      return { source: "theirs", lines: splitLines(theirs) };
    case "oursThenTheirs":
      return {
        source: "manual",
        lines: [...splitLines(ours), ...splitLines(theirs)],
      };
    case "theirsThenOurs":
      return {
        source: "manual",
        lines: [...splitLines(theirs), ...splitLines(ours)],
      };
    case "empty":
      return { source: "manual", lines: [] };
    case "unresolved":
    default:
      // 中间只留一行细占位，连接带向 Result 收窄（避免中间块过粗）
      return {
        source: "unresolved",
        lines: [""],
      };
  }
}

export function nextUnresolvedIndex(
  resolutions: ConflictResolution[],
  conflicts: Array<Pick<ConflictRegion, "ours" | "theirs" | "blockKind">>,
  from: number,
): number {
  if (resolutions.length === 0) {
    return -1;
  }
  for (let offset = 1; offset <= resolutions.length; offset += 1) {
    const index = (from + offset) % resolutions.length;
    const conflict = conflicts[index];
    if (
      conflict &&
      !isResolutionComplete(resolutions[index] ?? emptyResolution(), conflict)
    ) {
      return index;
    }
  }
  return from;
}
