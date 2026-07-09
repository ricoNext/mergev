import type { EolStyle } from "../text/index.js";

export type Decision =
  | { kind: "unresolved" }
  | { kind: "ours" }
  | { kind: "theirs" }
  | { kind: "both" }
  | { kind: "manual"; text: string };

export type StableRegion = {
  type: "stable";
  text: string;
};

export type ConflictRegion = {
  type: "conflict";
  id: number;
  base: string;
  ours: string;
  theirs: string;
  decision: Decision;
};

export type Region = StableRegion | ConflictRegion;

export type MergeFileInput = {
  base: string;
  ours: string;
  theirs: string;
  path: string;
};

export type MergeFileMetadata = {
  path: string;
  eol: EolStyle;
};
