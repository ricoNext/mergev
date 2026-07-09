import { diff3Merge } from "node-diff3";
import {
  applyEol,
  detectEol,
  joinWithBoundary,
  normalizeEol,
  splitLinesKeepEndings,
  unresolvedPlaceholder,
  type EolStyle
} from "../text/index.js";
import type { ConflictRegion, Decision, MergeFileInput, MergeFileMetadata, Region } from "./types.js";

type Diff3OkBlock = { ok: string[] };
type Diff3ConflictBlock = {
  conflict: {
    a: string[];
    o: string[];
    b: string[];
  };
};

type Diff3Block = Diff3OkBlock | Diff3ConflictBlock;

type UndoEntry = {
  conflictId: number;
  previous: Decision;
};

const UNDO_LIMIT = 100;

function decisionText(region: ConflictRegion): string {
  switch (region.decision.kind) {
    case "ours":
      return region.ours;
    case "theirs":
      return region.theirs;
    case "both":
      return joinWithBoundary(region.ours, region.theirs);
    case "manual":
      return region.decision.text;
    case "unresolved":
      return unresolvedPlaceholder(region.id);
  }
}

export function conflictDecisionText(region: ConflictRegion): string {
  return decisionText(region);
}

export class MergeFileModel {
  readonly metadata: MergeFileMetadata;
  readonly regions: Region[];
  revision = 0;
  currentConflictIndex = 0;
  private readonly undoStack: UndoEntry[] = [];

  constructor(input: MergeFileInput) {
    const eol = detectPreferredEol(input.ours, input.base);
    this.metadata = { path: input.path, eol };
    this.regions = buildRegions(input);
  }

  get conflicts(): ConflictRegion[] {
    return this.regions.filter((region): region is ConflictRegion => region.type === "conflict");
  }

  get currentConflict(): ConflictRegion | undefined {
    return this.conflicts[this.currentConflictIndex];
  }

  unresolvedCount(): number {
    return this.conflicts.filter((region) => region.decision.kind === "unresolved").length;
  }

  deriveResult(): string {
    return this.regions
      .map((region) => (region.type === "stable" ? region.text : decisionText(region)))
      .join("");
  }

  deriveWritableResult(): string {
    return applyEol(this.deriveResult(), this.metadata.eol);
  }

  setDecision(conflictId: number, decision: Decision): void {
    const conflict = this.findConflict(conflictId);
    this.pushUndo({ conflictId, previous: conflict.decision });
    conflict.decision = decision;
    this.revision++;
  }

  chooseCurrent(kind: "ours" | "theirs" | "both"): void {
    const current = this.currentConflict;
    if (current) {
      this.setDecision(current.id, { kind });
      this.goNext();
    }
  }

  /** Accept Left / Accept Right：将全部冲突块设为同一侧。 */
  chooseAll(kind: "ours" | "theirs"): void {
    for (const conflict of this.conflicts) {
      if (conflict.decision.kind !== kind) {
        this.setDecision(conflict.id, { kind });
      }
    }
  }

  setManual(conflictId: number, text: string): void {
    this.setDecision(conflictId, { kind: "manual", text: normalizeEol(text) });
  }

  resetCurrent(): void {
    const current = this.currentConflict;
    if (current) {
      this.setDecision(current.id, { kind: "unresolved" });
    }
  }

  undo(): boolean {
    const entry = this.undoStack.pop();
    if (!entry) {
      return false;
    }

    const conflict = this.findConflict(entry.conflictId);
    conflict.decision = entry.previous;
    this.revision++;
    return true;
  }

  goNext(): void {
    const conflicts = this.conflicts;
    if (conflicts.length === 0) {
      return;
    }

    this.currentConflictIndex = Math.min(this.currentConflictIndex + 1, conflicts.length - 1);
  }

  goPrevious(): void {
    this.currentConflictIndex = Math.max(this.currentConflictIndex - 1, 0);
  }

  goFirstUnresolved(): void {
    const index = this.conflicts.findIndex((region) => region.decision.kind === "unresolved");
    if (index >= 0) {
      this.currentConflictIndex = index;
    }
  }

  private findConflict(conflictId: number): ConflictRegion {
    const conflict = this.conflicts.find((region) => region.id === conflictId);
    if (!conflict) {
      throw new Error(`Unknown conflict id ${conflictId}.`);
    }

    return conflict;
  }

  private pushUndo(entry: UndoEntry): void {
    this.undoStack.push(entry);
    if (this.undoStack.length > UNDO_LIMIT) {
      this.undoStack.shift();
    }
  }
}

export function buildRegions(input: MergeFileInput): Region[] {
  const base = normalizeEol(input.base);
  const ours = normalizeEol(input.ours);
  const theirs = normalizeEol(input.theirs);
  const blocks = diff3Merge(
    splitLinesKeepEndings(ours),
    splitLinesKeepEndings(base),
    splitLinesKeepEndings(theirs),
    { excludeFalseConflicts: true }
  ) as Diff3Block[];

  let nextConflictId = 1;

  return blocks.map((block) => {
    if ("ok" in block) {
      return { type: "stable", text: block.ok.join("") };
    }

    return {
      type: "conflict",
      id: nextConflictId++,
      base: block.conflict.o.join(""),
      ours: block.conflict.a.join(""),
      theirs: block.conflict.b.join(""),
      decision: { kind: "unresolved" }
    };
  });
}

export function detectPreferredEol(ours: string, base: string): EolStyle {
  return detectEol(ours || base);
}
