import type { ConflictRegion, MergeRowKind } from "../types";
import { isChangeBlock, sideHasSubstantive, sideIsSettled } from "./conflictUtils";

/** 单方绿块在无内容侧不着色，只留对齐空行；已 Accept/Ignore 的一侧不再标成冲突 */
export function sideRowKind(
  side: "ours" | "theirs",
  rowKind: MergeRowKind,
  conflict: ConflictRegion | null | undefined,
): MergeRowKind {
  if (
    (rowKind === "insert" || rowKind === "conflict") &&
    isChangeBlock(conflict)
  ) {
    const sideText = side === "ours" ? conflict?.ours ?? "" : conflict?.theirs ?? "";
    if (!sideHasSubstantive(sideText)) {
      return "empty";
    }
  }
  if (rowKind === "insert" || rowKind === "conflict" || rowKind === "delete") {
    if (sideIsSettled(side, conflict)) {
      return "context";
    }
  }
  return rowKind;
}
