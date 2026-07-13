/** Git 操作类型 */
export type GitOperation = "none" | "merge" | "rebase" | "cherryPick" | "revert";

/** 冲突决策 */
export type ConflictDecision =
  | "unresolved"
  | "ours"
  | "theirs"
  | "oursThenTheirs"
  | "theirsThenOurs"
  | "empty";

/** 单侧裁决：pending 仍冲突；accepted 合入 Result；ignored 取消该侧冲突态且不合入 */
export type SideVerdict = "pending" | "accepted" | "ignored";

export type ConflictResolution = {
  ours: SideVerdict;
  theirs: SideVerdict;
  acceptOrder: Array<"ours" | "theirs">;
};

export type SideStatus = "modified" | "deleted";
export type MergeRowKind = "context" | "conflict" | "insert" | "delete" | "empty";
export type ResultSource =
  | "context"
  | "ours"
  | "theirs"
  | "manual"
  | "unresolved";

export type WorkspaceSnapshot = {
  cwd: string;
  root: string;
  repoName: string;
  branch: string;
  operation: GitOperation;
  oursLabel: string;
  theirsLabel: string;
  headline: string;
  files: ConflictFileSummary[];
  totalBlocks: number;
};

export type ConflictFileSummary = {
  path: string;
  fileName: string;
  directory: string;
  conflictCount: number;
  oursStatus: SideStatus;
  theirsStatus: SideStatus;
  staged: boolean;
};

export type PaneLine = {
  number: number | null;
  text: string;
};

export type MergeRow = {
  id: string;
  kind: MergeRowKind;
  conflictIndex: number | null;
  oursLine: PaneLine | null;
  resultLine: PaneLine | null;
  theirsLine: PaneLine | null;
};

export type ConflictRegion = {
  index: number;
  rowStart: number;
  rowEnd: number;
  decision: ConflictDecision;
  /** 会话内按侧 Accept/Ignore；文档加载时可能缺失 */
  resolution: ConflictResolution;
  /** conflict=双方红；change=单方绿；均需手动 Accept / Ignore */
  blockKind?: "conflict" | "change";
  ours: string;
  theirs: string;
};

export type ResultLine = {
  source: ResultSource;
  conflictIndex: number | null;
  text: string;
};

export type MergeDocument = {
  path: string;
  labels: { ours: string; theirs: string };
  base: string | null;
  ours: string;
  theirs: string;
  working: string;
  rows: MergeRow[];
  conflicts: ConflictRegion[];
  result: ResultLine[];
  unresolvedCount: number;
};

export type MergeSession = {
  document: MergeDocument;
  resolutions: ConflictResolution[];
  decisions: ConflictDecision[];
  rows: MergeRow[];
  resultLines: ResultLine[];
  conflicts: ConflictRegion[];
  activeConflict: number;
  dirty: boolean;
};

export type MergeUndoEntry = {
  resolutions: ConflictResolution[];
  activeConflict: number;
  dirty: boolean;
};

export type RepositoryItem = {
  path: string;
  name: string;
  lastOpened: string;
  branch?: string;
  hasConflicts?: boolean;
};

export type AppView =
  | { kind: "loading" }
  | { kind: "error"; message: string }
  | { kind: "repositories"; repos: RepositoryItem[] }
  | { kind: "empty"; workspace: WorkspaceSnapshot }
  | {
      kind: "conflicts";
      workspace: WorkspaceSnapshot;
      selectedPath: string;
      busy: boolean;
      actionError: string | null;
    }
  | {
      kind: "combined";
      repos: RepositoryItem[];
      activeRepoPath: string | null;
      workspace: WorkspaceSnapshot | null;
      selectedFilePath: string | null;
      busy: boolean;
      actionError: string | null;
    }
  | {
      kind: "merge";
      workspace: WorkspaceSnapshot;
      selectedPath: string;
      session: MergeSession | null;
      detailError: string | null;
      saving: boolean;
      saveError: string | null;
    };
