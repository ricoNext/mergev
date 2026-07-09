export type GitOperation = "merge" | "rebase" | "cherry-pick" | "revert" | "none";

export type UnmergedStage = 1 | 2 | 3;

export type StageEntry = {
  mode: string;
  oid: string;
  stage: UnmergedStage;
  path: string;
};

export type UnmergedFile = {
  path: string;
  stages: Partial<Record<UnmergedStage, StageEntry>>;
};

export type ConflictFile = UnmergedFile & {
  operation: GitOperation;
  supported: boolean;
  reason?: string;
  isLockfile: boolean;
  conflictCount?: number;
};

export type StageBlobs = {
  base: Uint8Array;
  ours: Uint8Array;
  theirs: Uint8Array;
  oids: {
    base: string;
    ours: string;
    theirs: string;
  };
};
