import {
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type RefObject,
} from "react";
import { invoke } from "@tauri-apps/api/core";
import { confirm } from "@tauri-apps/plugin-dialog";
import {
  buildRenderTokens,
  type DiffToken,
  type RenderToken,
} from "./renderTokens";
import {
  countHighlightLines,
  emptyPaneHighlights,
  highlightedLinesToMap,
  highlightLines,
  HIGHLIGHT_LINE_LIMIT,
  languageFromPath,
  type PaneHighlights,
} from "./syntaxHighlight";
import { FirstLaunchDialog } from "./FirstLaunchDialog";
import "./App.css";

type GitOperation = "none" | "merge" | "rebase" | "cherryPick" | "revert";
type ConflictDecision =
  | "unresolved"
  | "ours"
  | "theirs"
  | "oursThenTheirs"
  | "theirsThenOurs"
  | "empty";
/** 单侧裁决：pending 仍冲突；accepted 合入 Result；ignored 取消该侧冲突态且不合入 */
type SideVerdict = "pending" | "accepted" | "ignored";
type ConflictResolution = {
  ours: SideVerdict;
  theirs: SideVerdict;
  acceptOrder: Array<"ours" | "theirs">;
};
type SideStatus = "modified" | "deleted";
type MergeRowKind = "context" | "conflict" | "insert" | "delete" | "empty";
type ResultSource =
  | "context"
  | "ours"
  | "theirs"
  | "manual"
  | "unresolved";

type WorkspaceSnapshot = {
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

type ConflictFileSummary = {
  path: string;
  fileName: string;
  directory: string;
  conflictCount: number;
  oursStatus: SideStatus;
  theirsStatus: SideStatus;
  staged: boolean;
};

type PaneLine = {
  number: number | null;
  text: string;
};

type MergeRow = {
  id: string;
  kind: MergeRowKind;
  conflictIndex: number | null;
  oursLine: PaneLine | null;
  resultLine: PaneLine | null;
  theirsLine: PaneLine | null;
};

type ConflictRegion = {
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

type ResultLine = {
  source: ResultSource;
  conflictIndex: number | null;
  text: string;
};

type MergeDocument = {
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

type MergeSession = {
  document: MergeDocument;
  resolutions: ConflictResolution[];
  decisions: ConflictDecision[];
  rows: MergeRow[];
  resultLines: ResultLine[];
  conflicts: ConflictRegion[];
  activeConflict: number;
  dirty: boolean;
};

type MergeUndoEntry = {
  resolutions: ConflictResolution[];
  activeConflict: number;
  dirty: boolean;
};

type RepositoryItem = {
  path: string;
  name: string;
  lastOpened: string;
  branch?: string;
  hasConflicts?: boolean;
};

type AppView =
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

const SIDE_STATUS_LABEL: Record<SideStatus, string> = {
  modified: "Modified",
  deleted: "Deleted",
};

function fileNameOf(path: string): string {
  const parts = path.split("/");
  return parts[parts.length - 1] || path;
}

function dirOf(path: string): string {
  const index = path.lastIndexOf("/");
  return index >= 0 ? path.slice(0, index) : "";
}

const REPO_AVATAR_COLORS = [
  "#4e9a51",
  "#2aa198",
  "#d33682",
  "#6c71c4",
  "#268bd2",
  "#c678dd",
  "#e5a03c",
];

function hashString(value: string): number {
  let hash = 0;
  for (let i = 0; i < value.length; i += 1) {
    hash = (hash * 31 + value.charCodeAt(i)) | 0;
  }
  return Math.abs(hash);
}

function getRepoInitials(name: string): string {
  const parts = name.split(/[-_\s.]+/).filter(Boolean);
  if (parts.length >= 2) {
    return parts
      .slice(0, 2)
      .map((part) => part[0])
      .join("")
      .toUpperCase();
  }
  const word = parts[0] || name;
  return word.length <= 3 ? word[0].toUpperCase() : word.slice(0, 2).toUpperCase();
}

function getRepoAvatarColor(name: string): string {
  return REPO_AVATAR_COLORS[hashString(name) % REPO_AVATAR_COLORS.length];
}

function formatDisplayPath(path: string, homeDir?: string | null): string {
  if (homeDir && path.startsWith(homeDir)) {
    return `~${path.slice(homeDir.length)}`;
  }
  const match = path.match(/^(\/Users\/[^/]+|\/home\/[^/]+)(\/.*)?$/);
  if (match) {
    return `~${match[2] || ""}`;
  }
  return path;
}

function GitBranchIcon() {
  return (
    <svg
      className="repository-branch-icon"
      width="12"
      height="12"
      viewBox="0 0 16 16"
      aria-hidden="true"
    >
      <circle cx="4.5" cy="3.5" r="1.75" fill="currentColor" />
      <circle cx="4.5" cy="12.5" r="1.75" fill="currentColor" />
      <circle cx="11.5" cy="7.5" r="1.75" fill="currentColor" />
      <path
        d="M4.5 5.25v4.5M4.5 7.5h5.5"
        stroke="currentColor"
        strokeWidth="1.25"
        fill="none"
      />
    </svg>
  );
}

function RepositoryAvatar({ name }: { name: string }) {
  return (
    <div
      className="repository-avatar"
      style={{ backgroundColor: getRepoAvatarColor(name) }}
      aria-hidden="true"
    >
      {getRepoInitials(name)}
    </div>
  );
}

function RepositoryListContent({
  repo,
  homeDir,
}: {
  repo: RepositoryItem;
  homeDir?: string | null;
}) {
  return (
    <>
      <RepositoryAvatar name={repo.name} />
      <div className="repository-details">
        <div className="repository-name-row">
          <span className="repository-name">{repo.name}</span>
          {repo.hasConflicts ? (
            <span className="repository-conflict-dot" title="有冲突" />
          ) : null}
        </div>
        <span className="repository-path">
          {formatDisplayPath(repo.path, homeDir)}
        </span>
        {repo.branch ? (
          <span className="repository-branch-row">
            <GitBranchIcon />
            <span className="repository-branch">{repo.branch}</span>
          </span>
        ) : null}
      </div>
    </>
  );
}

function splitLines(text: string): string[] {
  if (text.length === 0) {
    return [];
  }
  const lines = text.split("\n");
  if (text.endsWith("\n")) {
    lines.pop();
  }
  return lines;
}

function sideHasSubstantive(text: string): boolean {
  return splitLines(text).some((line) => line.trim().length > 0);
}

function isChangeBlock(
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

/** 单方绿块在无内容侧不着色，只留对齐空行；已 Accept/Ignore 的一侧不再标成冲突 */
function sideRowKind(
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

function sideNeedsAction(
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

function sideIsSettled(
  side: "ours" | "theirs",
  conflict: ConflictRegion | null | undefined,
): boolean {
  if (!conflict) {
    return false;
  }
  const resolution = conflict.resolution ?? emptyResolution();
  return resolution[side] !== "pending";
}

function sideHasConflictActions(
  side: "ours" | "theirs",
  conflict: ConflictRegion | null | undefined,
): boolean {
  if (!conflict || !sideNeedsAction(side, conflict)) {
    return false;
  }
  return !sideIsSettled(side, conflict);
}

function sideDecisionMerged(
  side: "ours" | "theirs",
  conflict: ConflictRegion | null | undefined,
): boolean {
  return sideIsSettled(side, conflict);
}

function paneHighlightText(
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

function emptyResolution(): ConflictResolution {
  return { ours: "pending", theirs: "pending", acceptOrder: [] };
}

function applyAccept(
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

function applyIgnore(
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

function decisionFromResolution(resolution: ConflictResolution): ConflictDecision {
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

function isResolutionComplete(
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

function resolutionsEqual(
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

function decisionIncludesOurs(decision: ConflictDecision): boolean {
  return (
    decision === "ours" ||
    decision === "oursThenTheirs" ||
    decision === "theirsThenOurs"
  );
}

function decisionIncludesTheirs(decision: ConflictDecision): boolean {
  return (
    decision === "theirs" ||
    decision === "oursThenTheirs" ||
    decision === "theirsThenOurs"
  );
}

function decisionResultLines(
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

function buildSessionFromDocument(document: MergeDocument): MergeSession {
  return rebuildSession(
    document,
    document.conflicts.map(() => emptyResolution()),
    document.conflicts.length > 0 ? 0 : -1,
    false,
  );
}

function rebuildSession(
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
    const rowKind: MergeRowKind =
      blockKind === "change" ? "insert" : "conflict";

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

function serializeResult(resultLines: ResultLine[], endsWithNewline: boolean): string {
  const body = resultLines.map((line) => line.text).join("\n");
  if (endsWithNewline && body.length > 0 && !body.endsWith("\n")) {
    return `${body}\n`;
  }
  return body;
}

function tokenizeWords(text: string): string[] {
  return text.match(/\s+|[^\s]+/g) ?? [text];
}

function wordDiffTokens(left: string, right: string): {
  left: DiffToken[];
  right: DiffToken[];
} {
  const a = tokenizeWords(left);
  const b = tokenizeWords(right);
  const n = a.length;
  const m = b.length;
  const dp: number[][] = Array.from({ length: n + 1 }, () =>
    Array.from({ length: m + 1 }, () => 0),
  );

  for (let i = n - 1; i >= 0; i -= 1) {
    for (let j = m - 1; j >= 0; j -= 1) {
      if (a[i] === b[j]) {
        dp[i][j] = dp[i + 1][j + 1] + 1;
      } else {
        dp[i][j] = Math.max(dp[i + 1][j], dp[i][j + 1]);
      }
    }
  }

  const leftTokens: DiffToken[] = [];
  const rightTokens: DiffToken[] = [];
  let i = 0;
  let j = 0;
  while (i < n && j < m) {
    if (a[i] === b[j]) {
      leftTokens.push({ kind: "equal", text: a[i] });
      rightTokens.push({ kind: "equal", text: b[j] });
      i += 1;
      j += 1;
    } else if (dp[i + 1][j] >= dp[i][j + 1]) {
      leftTokens.push({ kind: "delete", text: a[i] });
      i += 1;
    } else {
      rightTokens.push({ kind: "insert", text: b[j] });
      j += 1;
    }
  }
  while (i < n) {
    leftTokens.push({ kind: "delete", text: a[i] });
    i += 1;
  }
  while (j < m) {
    rightTokens.push({ kind: "insert", text: b[j] });
    j += 1;
  }

  return { left: leftTokens, right: rightTokens };
}

function nextUnresolvedIndex(
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

function App() {
  const [view, setView] = useState<AppView>({ kind: "loading" });
  const [showFirstLaunchDialog, setShowFirstLaunchDialog] = useState(false);

  async function checkFirstLaunch() {
    try {
      const isFirstLaunch = await invoke<boolean>("is_first_launch");
      setShowFirstLaunchDialog(isFirstLaunch);
    } catch (error) {
      console.error("Failed to check first launch:", error);
      setShowFirstLaunchDialog(false);
    }
  }

  async function loadInitial() {
    setView({ kind: "loading" });
    try {
      // 判断激活仓库：MERGEV_CWD > 第一个仓库
      let activeRepoPath: string | null = null;
      const mergev_cwd = await invoke<string | null>("get_mergev_cwd");

      if (mergev_cwd) {
        // 有 MERGEV_CWD 环境变量，直接使用它（CLI 启动场景）
        activeRepoPath = mergev_cwd;
      }

      // 如果有激活仓库，加载其冲突列表
      let workspace: WorkspaceSnapshot | null = null;
      if (activeRepoPath) {
        try {
          await invoke("open_repository", { path: activeRepoPath });
          workspace = await invoke<WorkspaceSnapshot>("get_workspace");

          // 按文件名字母排序
          if (workspace.files.length > 0) {
            const sortedFiles = [...workspace.files].sort((a, b) => {
              const nameA = a.fileName || fileNameOf(a.path);
              const nameB = b.fileName || fileNameOf(b.path);
              return nameA.localeCompare(nameB);
            });
            workspace = { ...workspace, files: sortedFiles };
          }
        } catch (error) {
          console.error("Failed to load repository:", error);
          workspace = null;
        }
      }

      // 加载仓库列表（在 open_repository 之后，确保新仓库已加入历史）
      const repos = await invoke<RepositoryItem[]>("get_recent_repositories");

      // 如果没有 MERGEV_CWD，使用最近打开的仓库
      if (!activeRepoPath && repos.length > 0) {
        activeRepoPath = repos[0].path;
        try {
          await invoke("open_repository", { path: activeRepoPath });
          workspace = await invoke<WorkspaceSnapshot>("get_workspace");

          if (workspace.files.length > 0) {
            const sortedFiles = [...workspace.files].sort((a, b) => {
              const nameA = a.fileName || fileNameOf(a.path);
              const nameB = b.fileName || fileNameOf(b.path);
              return nameA.localeCompare(nameB);
            });
            workspace = { ...workspace, files: sortedFiles };
          }
        } catch (error) {
          console.error("Failed to load repository:", error);
          workspace = null;
        }
      }

      const selectedFilePath = workspace?.files && workspace.files.length > 0
        ? workspace.files[0].path
        : null;

      setView({
        kind: "combined",
        repos,
        activeRepoPath,
        workspace,
        selectedFilePath,
        busy: false,
        actionError: null,
      });
    } catch (error) {
      setView({
        kind: "error",
        message: error instanceof Error ? error.message : String(error),
      });
    }
  }

  async function removeRepository(repoPath: string) {
    const confirmed = await confirm(
      "此操作只会从历史列表中移除该仓库，不会删除仓库本身。",
      {
        title: "确认从列表中移除",
        kind: "warning",
        okLabel: "移除",
        cancelLabel: "取消",
      }
    );

    if (!confirmed) {
      return;
    }

    try {
      await invoke("remove_repository", { path: repoPath });
      await loadInitial();
    } catch (error) {
      console.error("Failed to remove repository:", error);
    }
  }

  async function addRepository() {
    try {
      const { open } = await import("@tauri-apps/plugin-dialog");
      const selected = await open({
        directory: true,
        multiple: false,
        title: "选择 Git 仓库目录",
      });

      if (!selected || Array.isArray(selected)) {
        return;
      }

      const path = selected;

      try {
        await invoke("open_repository", { path });
        await loadInitial();
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        await confirm(message, {
          title: "添加仓库失败",
          kind: "error",
          okLabel: "确定",
          cancelLabel: "",
        });
      }
    } catch (error) {
      console.error("Failed to add repository:", error);
    }
  }

  async function loadConflicts(preferredPath?: string) {
    setView({ kind: "loading" });
    try {
      const workspace = await invoke<WorkspaceSnapshot>("get_workspace");
      if (workspace.files.length === 0) {
        setView({ kind: "empty", workspace });
        return;
      }

      // 按文件名字母排序
      const sortedFiles = [...workspace.files].sort((a, b) => {
        const nameA = a.fileName || fileNameOf(a.path);
        const nameB = b.fileName || fileNameOf(b.path);
        return nameA.localeCompare(nameB);
      });

      const selectedPath =
        preferredPath &&
        sortedFiles.some((file) => file.path === preferredPath)
          ? preferredPath
          : sortedFiles[0].path;

      setView({
        kind: "conflicts",
        workspace: { ...workspace, files: sortedFiles },
        selectedPath,
        busy: false,
        actionError: null,
      });
    } catch (error) {
      setView({
        kind: "error",
        message: error instanceof Error ? error.message : String(error),
      });
    }
  }

  async function switchRepository(repoPath: string) {
    if (view.kind !== "combined") {
      return;
    }

    setView({ ...view, activeRepoPath: repoPath, busy: true, actionError: null });

    try {
      await invoke("open_repository", { path: repoPath });
      const workspace = await invoke<WorkspaceSnapshot>("get_workspace");

      // 按文件名字母排序
      const sortedFiles = workspace.files.length > 0
        ? [...workspace.files].sort((a, b) => {
            const nameA = a.fileName || fileNameOf(a.path);
            const nameB = b.fileName || fileNameOf(b.path);
            return nameA.localeCompare(nameB);
          })
        : [];

      const selectedFilePath = sortedFiles.length > 0 ? sortedFiles[0].path : null;

      setView({
        ...view,
        activeRepoPath: repoPath,
        workspace: { ...workspace, files: sortedFiles },
        selectedFilePath,
        busy: false,
        actionError: null,
      });
    } catch (error) {
      setView({
        ...view,
        busy: false,
        actionError: error instanceof Error ? error.message : String(error),
      });
    }
  }

  async function openRepository(repoPath: string) {
    setView({ kind: "loading" });
    try {
      await invoke("open_repository", { path: repoPath });
      await loadConflicts();
    } catch (error) {
      setView({
        kind: "error",
        message: error instanceof Error ? error.message : String(error),
      });
    }
  }

  async function openMergeFromCombined(path: string) {
    if (view.kind !== "combined" || !view.workspace) {
      return;
    }
    await openMerge(path, view.workspace);
  }

  async function openMerge(path: string, workspace: WorkspaceSnapshot) {
    setView({
      kind: "merge",
      workspace,
      selectedPath: path,
      session: null,
      detailError: null,
      saving: false,
      saveError: null,
    });

    try {
      const document = await invoke<MergeDocument>("get_merge_document", {
        path,
      });
      setView({
        kind: "merge",
        workspace,
        selectedPath: path,
        session: buildSessionFromDocument(document),
        detailError: null,
        saving: false,
        saveError: null,
      });
    } catch (error) {
      setView({
        kind: "merge",
        workspace,
        selectedPath: path,
        session: null,
        detailError: error instanceof Error ? error.message : String(error),
        saving: false,
        saveError: null,
      });
    }
  }

  useEffect(() => {
    void checkFirstLaunch();
    void loadInitial();
  }, []);

  if (showFirstLaunchDialog) {
    return (
      <FirstLaunchDialog
        onClose={() => {
          setShowFirstLaunchDialog(false);
        }}
      />
    );
  }

  if (view.kind === "loading") {
    return (
      <main className="screen">
        <p className="muted">正在检测仓库与冲突…</p>
      </main>
    );
  }

  if (view.kind === "error") {
    return (
      <main className="screen">
        <h1>无法打开工作区</h1>
        <p className="error">{view.message}</p>
        <button type="button" onClick={() => void loadConflicts()}>
          重试
        </button>
      </main>
    );
  }

  if (view.kind === "repositories") {
    return (
      <RepositoriesScreen
        view={view}
        onOpenRepository={(path) => void openRepository(path)}
        onRefresh={() => void loadInitial()}
        onClose={() => void invoke("close_app")}
      />
    );
  }

  if (view.kind === "empty") {
    return (
      <main className="screen empty">
        <p className="eyebrow">Mergev</p>
        <h1>
          {view.workspace.repoName}
          <span className="muted"> · {view.workspace.branch}</span>
        </h1>
        <p>当前没有需要解决的合并冲突。</p>
        <p className="muted">
          在产生冲突的 merge / rebase 后，再于仓库目录执行 mergev。
        </p>
        <button type="button" onClick={() => void loadConflicts()}>
          刷新
        </button>
      </main>
    );
  }

  if (view.kind === "combined") {
    return (
      <CombinedScreen
        view={view}
        onSelectRepository={(path) => void switchRepository(path)}
        onSelectFile={(path) =>
          setView({ ...view, selectedFilePath: path, actionError: null })
        }
        onRefresh={() => void loadInitial()}
        onRemoveRepository={(path) => void removeRepository(path)}
        onAddRepository={() => void addRepository()}
        onAccept={async (side) => {
          if (!view.workspace || !view.selectedFilePath) {
            return;
          }
          setView({ ...view, busy: true, actionError: null });
          try {
            const document = await invoke<MergeDocument>("get_merge_document", {
              path: view.selectedFilePath,
            });
            const session = buildSessionFromDocument(document);

            const resolutions = session.conflicts.map(() =>
              applyAccept(emptyResolution(), side),
            );

            const updatedSession = rebuildSession(
              session.document,
              resolutions,
              session.activeConflict,
              true,
            );

            const endsWithNewline = updatedSession.document.working.endsWith("\n");
            const result = serializeResult(
              updatedSession.resultLines,
              endsWithNewline,
            );
            await invoke("save_merge_result", {
              path: updatedSession.document.path,
              result,
              stage: true,
            });

            await switchRepository(view.activeRepoPath!);
          } catch (error) {
            setView({
              ...view,
              busy: false,
              actionError:
                error instanceof Error ? error.message : String(error),
            });
          }
        }}
        onMerge={() => void openMergeFromCombined(view.selectedFilePath!)}
        onOpenPath={(path) => void openMergeFromCombined(path)}
        onClose={() => void invoke("close_app")}
      />
    );
  }

  if (view.kind === "conflicts") {
    return (
      <ConflictsScreen
        view={view}
        onSelect={(path) =>
          setView({ ...view, selectedPath: path, actionError: null })
        }
        onRefresh={() => void loadConflicts(view.selectedPath)}
        onAccept={async (side) => {
          setView({ ...view, busy: true, actionError: null });
          try {
            // 1. 加载合并文档
            const document = await invoke<MergeDocument>("get_merge_document", {
              path: view.selectedPath,
            });
            const session = buildSessionFromDocument(document);

            // 2. 对所有冲突块应用该侧的决策
            const resolutions = session.conflicts.map(() =>
              applyAccept(emptyResolution(), side),
            );

            const updatedSession = rebuildSession(
              session.document,
              resolutions,
              session.activeConflict,
              true,
            );

            // 3. 保存合并结果
            const endsWithNewline = updatedSession.document.working.endsWith("\n");
            const result = serializeResult(
              updatedSession.resultLines,
              endsWithNewline,
            );
            await invoke("save_merge_result", {
              path: updatedSession.document.path,
              result,
              stage: true,
            });

            // 4. 刷新列表
            await loadConflicts();
          } catch (error) {
            setView({
              ...view,
              busy: false,
              actionError:
                error instanceof Error ? error.message : String(error),
            });
          }
        }}
        onMerge={() => void openMerge(view.selectedPath, view.workspace)}
        onOpenPath={(path) => void openMerge(path, view.workspace)}
        onClose={() => void invoke("close_app")}
      />
    );
  }

  return (
    <MergeScreen
      view={view}
      onBack={() => {
        if (view.kind === "merge") {
          // 尝试返回到 combined 视图
          void loadInitial();
        }
      }}
      onChangeView={setView}
      onSaved={() => void loadInitial()}
    />
  );
}

function CombinedScreen({
  view,
  onSelectRepository,
  onSelectFile,
  onRefresh,
  onRemoveRepository,
  onAddRepository,
  onAccept,
  onMerge,
  onOpenPath,
  onClose: _onClose,
}: {
  view: Extract<AppView, { kind: "combined" }>;
  onSelectRepository: (path: string) => void;
  onSelectFile: (path: string) => void;
  onRefresh: () => void;
  onRemoveRepository: (path: string) => void;
  onAddRepository: () => void;
  onAccept: (side: "ours" | "theirs") => Promise<void>;
  onMerge: () => void;
  onOpenPath: (path: string) => void;
  onClose: () => void;
}) {
  const { repos, activeRepoPath, workspace, selectedFilePath, busy, actionError } = view;
  const selectedFile = workspace?.files.find((f) => f.path === selectedFilePath);
  const [menuOpen, setMenuOpen] = useState<string | null>(null);
  const [homeDir, setHomeDir] = useState<string | null>(null);

  useEffect(() => {
    void import("@tauri-apps/api/path")
      .then(({ homeDir: resolveHomeDir }) => resolveHomeDir())
      .then(setHomeDir)
      .catch(() => setHomeDir(null));
  }, []);

  useEffect(() => {
    const handleClick = () => setMenuOpen(null);
    if (menuOpen) {
      window.addEventListener("click", handleClick);
      return () => window.removeEventListener("click", handleClick);
    }
  }, [menuOpen]);

  return (
    <div className="combined-view">
      <aside className="repository-sidebar">
        <header className="sidebar-header">
          <h2>Repositories</h2>
          <div className="sidebar-header-actions">
            <button type="button" className="ghost" onClick={onAddRepository}>
              新增项目
            </button>
            <button type="button" className="ghost" onClick={onRefresh}>
              刷新
            </button>
          </div>
        </header>
        <div className="repository-list">
          {repos.length === 0 ? (
            <div className="empty-state">
              <p className="muted">暂无历史仓库</p>
            </div>
          ) : (
            repos.map((repo) => (
              <div
                key={repo.path}
                className={
                  repo.path === activeRepoPath
                    ? "repository-item active"
                    : "repository-item"
                }
              >
                <div
                  className="repository-info"
                  onClick={() => onSelectRepository(repo.path)}
                >
                  <RepositoryListContent repo={repo} homeDir={homeDir} />
                </div>
                <div className="repository-actions">
                  <button
                    type="button"
                    className="repository-menu-trigger"
                    onClick={(e) => {
                      e.stopPropagation();
                      setMenuOpen(menuOpen === repo.path ? null : repo.path);
                    }}
                  >
                    ⋯
                  </button>
                  {menuOpen === repo.path && (
                    <div className="repository-menu">
                      <button
                        type="button"
                        className="repository-menu-item"
                        onClick={(e) => {
                          e.stopPropagation();
                          navigator.clipboard.writeText(repo.path);
                          setMenuOpen(null);
                        }}
                      >
                        复制路径
                      </button>
                      {repo.branch && (
                        <button
                          type="button"
                          className="repository-menu-item"
                          onClick={(e) => {
                            e.stopPropagation();
                            navigator.clipboard.writeText(repo.branch!);
                            setMenuOpen(null);
                          }}
                        >
                          复制分支
                        </button>
                      )}
                      <button
                        type="button"
                        className="repository-menu-item danger"
                        onClick={(e) => {
                          e.stopPropagation();
                          onRemoveRepository(repo.path);
                          setMenuOpen(null);
                        }}
                      >
                        从列表中移除
                      </button>
                    </div>
                  )}
                </div>
              </div>
            ))
          )}
        </div>
      </aside>

      <main className="conflict-main">
        {!workspace ? (
          <div className="empty-state">
            <p className="muted">选择一个仓库查看冲突文件</p>
          </div>
        ) : workspace.files.length === 0 ? (
          <div className="empty-state">
            <p className="eyebrow">Mergev</p>
            <h1>
              {workspace.repoName}
              <span className="muted"> · {workspace.branch}</span>
            </h1>
            <p>当前没有需要解决的合并冲突。</p>
            <p className="muted">
              在产生冲突的 merge / rebase 后，再于仓库目录执行 mergev。
            </p>
          </div>
        ) : (
          <>
            <header className="conflicts-header">
              <div>
                <h1>
                  {workspace.repoName}
                  <span className="muted"> · {workspace.branch}</span>
                </h1>
                <p className="muted">{workspace.headline}</p>
              </div>
            </header>

            <div className="conflicts-body">
              <div className="conflicts-table-wrap">
                <table className="conflicts-table">
                  <thead>
                    <tr>
                      <th>Name</th>
                      <th>Yours ({workspace.oursLabel})</th>
                      <th>Theirs ({workspace.theirsLabel})</th>
                    </tr>
                  </thead>
                  <tbody>
                    {workspace.files.map((file) => {
                      const name = file.fileName || fileNameOf(file.path);
                      const directory = file.directory || dirOf(file.path);
                      return (
                        <tr
                          key={file.path}
                          className={
                            file.path === selectedFilePath ? "selected" : undefined
                          }
                          onClick={() => onSelectFile(file.path)}
                        >
                          <td>
                            <div className="name-cell">
                              <span className="name-file">{name}</span>
                              {directory ? (
                                <span className="name-dir">{directory}</span>
                              ) : null}
                            </div>
                          </td>
                          <td>
                            <StatusCell
                              status={file.oursStatus}
                              onOpen={() => onOpenPath(file.path)}
                            />
                          </td>
                          <td>
                            <StatusCell
                              status={file.theirsStatus}
                              onOpen={() => onOpenPath(file.path)}
                            />
                          </td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>

              <aside className="conflicts-actions">
                <button
                  type="button"
                  disabled={busy || !selectedFile}
                  onClick={() => void onAccept("ours")}
                >
                  Accept Yours
                </button>
                <button
                  type="button"
                  disabled={busy || !selectedFile}
                  onClick={() => void onAccept("theirs")}
                >
                  Accept Theirs
                </button>
                <button
                  type="button"
                  className="primary"
                  disabled={busy || !selectedFile}
                  onClick={onMerge}
                >
                  Merge…
                </button>
                {actionError ? <p className="error">{actionError}</p> : null}
                {selectedFile ? (
                  <p className="muted action-hint">
                    {selectedFile.conflictCount} conflict block
                    {selectedFile.conflictCount === 1 ? "" : "s"}
                  </p>
                ) : null}
              </aside>
            </div>
          </>
        )}
      </main>
    </div>
  );
}

function RepositoriesScreen({
  view,
  onOpenRepository,
  onRefresh,
  onClose,
}: {
  view: Extract<AppView, { kind: "repositories" }>;
  onOpenRepository: (path: string) => void;
  onRefresh: () => void;
  onClose: () => void;
}) {
  const { repos } = view;
  const [homeDir, setHomeDir] = useState<string | null>(null);

  useEffect(() => {
    void import("@tauri-apps/api/path")
      .then(({ homeDir: resolveHomeDir }) => resolveHomeDir())
      .then(setHomeDir)
      .catch(() => setHomeDir(null));
  }, []);

  return (
    <div className="repositories">
      <header className="conflicts-header">
        <div>
          <h1>Recent Repositories</h1>
          <p className="muted">选择一个仓库查看冲突</p>
        </div>
        <button type="button" className="ghost" onClick={onRefresh}>
          刷新
        </button>
      </header>

      <div className="repositories-body">
        {repos.length === 0 ? (
          <div className="repositories-empty">
            <p className="muted">暂无历史仓库</p>
            <p className="muted">
              在 Git 仓库目录中执行 <code>mergev</code> 命令以开始使用
            </p>
          </div>
        ) : (
          <div className="repositories-list">
            {repos.map((repo) => (
              <div
                key={repo.path}
                className="repository-item"
                onClick={() => onOpenRepository(repo.path)}
              >
                <RepositoryListContent repo={repo} homeDir={homeDir} />
              </div>
            ))}
          </div>
        )}
        <button
          type="button"
          className="close-app-button"
          onClick={onClose}
        >
          Close
        </button>
      </div>
    </div>
  );
}

function ConflictsScreen({
  view,
  onSelect,
  onRefresh,
  onAccept,
  onMerge,
  onOpenPath,
  onClose,
}: {
  view: Extract<AppView, { kind: "conflicts" }>;
  onSelect: (path: string) => void;
  onRefresh: () => void;
  onAccept: (side: "ours" | "theirs") => Promise<void>;
  onMerge: () => void;
  onOpenPath: (path: string) => void;
  onClose: () => void;
}) {
  const { workspace, selectedPath, busy, actionError } = view;
  const selected =
    workspace.files.find((file) => file.path === selectedPath) ??
    workspace.files[0];

  return (
    <div className="conflicts">
      <header className="conflicts-header">
        <div>
          <h1>Conflicts</h1>
          <p className="muted">{workspace.headline}</p>
        </div>
        <button type="button" className="ghost" onClick={onRefresh}>
          刷新
        </button>
      </header>

      <div className="conflicts-body">
        <div className="conflicts-table-wrap">
          <table className="conflicts-table">
            <thead>
              <tr>
                <th>Name</th>
                <th>Yours ({workspace.oursLabel})</th>
                <th>Theirs ({workspace.theirsLabel})</th>
              </tr>
            </thead>
            <tbody>
              {workspace.files.map((file) => {
                const name = file.fileName || fileNameOf(file.path);
                const directory = file.directory || dirOf(file.path);
                return (
                  <tr
                    key={file.path}
                    className={
                      file.path === selected.path ? "selected" : undefined
                    }
                    onClick={() => onSelect(file.path)}
                  >
                    <td>
                      <div className="name-cell">
                        <span className="name-file">{name}</span>
                        {directory ? (
                          <span className="name-dir">{directory}</span>
                        ) : null}
                      </div>
                    </td>
                    <td>
                      <StatusCell
                        status={file.oursStatus}
                        onOpen={() => onOpenPath(file.path)}
                      />
                    </td>
                    <td>
                      <StatusCell
                        status={file.theirsStatus}
                        onOpen={() => onOpenPath(file.path)}
                      />
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>

        <aside className="conflicts-actions">
          <button
            type="button"
            disabled={busy || !selected}
            onClick={() => void onAccept("ours")}
          >
            Accept Yours
          </button>
          <button
            type="button"
            disabled={busy || !selected}
            onClick={() => void onAccept("theirs")}
          >
            Accept Theirs
          </button>
          <button
            type="button"
            className="primary"
            disabled={busy || !selected}
            onClick={onMerge}
          >
            Merge…
          </button>
          {actionError ? <p className="error">{actionError}</p> : null}
          {selected ? (
            <p className="muted action-hint">
              {selected.conflictCount} conflict block
              {selected.conflictCount === 1 ? "" : "s"}
            </p>
          ) : null}
          <button type="button" className="close-app-button" onClick={onClose}>
            Close
          </button>
        </aside>
      </div>
    </div>
  );
}

function StatusCell({
  status,
  onOpen,
}: {
  status: SideStatus;
  onOpen: () => void;
}) {
  if (status === "deleted") {
    return <span>{SIDE_STATUS_LABEL[status]}</span>;
  }

  return (
    <button
      type="button"
      className="status-link"
      onClick={(event) => {
        event.stopPropagation();
        onOpen();
      }}
    >
      {SIDE_STATUS_LABEL[status]}
    </button>
  );
}

function MergeScreen({
  view,
  onBack,
  onChangeView,
  onSaved,
}: {
  view: Extract<AppView, { kind: "merge" }>;
  onBack: () => void;
  onChangeView: (view: AppView) => void;
  onSaved: () => void;
}) {
  const { workspace, session } = view;
  const scrollRef = useRef<HTMLDivElement>(null);
  const highlightRequestRef = useRef(0);
  const [paneHighlights, setPaneHighlights] = useState<PaneHighlights>(
    emptyPaneHighlights,
  );
  const [undoStack, setUndoStack] = useState<MergeUndoEntry[]>([]);
  const [redoStack, setRedoStack] = useState<MergeUndoEntry[]>([]);
  const unresolvedConflicts = session
    ? session.conflicts.filter(
        (conflict) => !isResolutionComplete(conflict.resolution, conflict),
      )
    : [];
  const unresolvedChanges = unresolvedConflicts.filter((conflict) =>
    isChangeBlock(conflict)
  ).length;
  const unresolvedConflictBlocks = unresolvedConflicts.length - unresolvedChanges;
  const canSave = session !== null && session.conflicts.length > 0 && unresolvedConflicts.length === 0;
  const canUndo = undoStack.length > 0;
  const canRedo = redoStack.length > 0;
  const canGoPrev = hasUnresolvedInDirection(-1);
  const canGoNext = hasUnresolvedInDirection(1);

  const oursLabel = session?.document.labels.ours ?? workspace.oursLabel;
  const theirsLabel = session?.document.labels.theirs ?? workspace.theirsLabel;

  const oursHighlightText = session
    ? paneHighlightText(session.rows, "ours")
    : "";
  const theirsHighlightText = session
    ? paneHighlightText(session.rows, "theirs")
    : "";
  const resultHighlightText = session
    ? paneHighlightText(session.rows, "result")
    : "";

  function updateSession(next: MergeSession) {
    onChangeView({ ...view, session: next, saveError: null });
  }

  function pushUndoSnapshot() {
    if (!session) {
      return;
    }
    setUndoStack((stack) => [
      ...stack,
      {
        resolutions: session.resolutions.map((item) => ({
          ...item,
          acceptOrder: [...item.acceptOrder],
        })),
        activeConflict: session.activeConflict,
        dirty: session.dirty,
      },
    ]);
    // 任何新操作都会清空 redo 栈
    setRedoStack([]);
  }

  function setDecision(
    decision: ConflictDecision | "ignoreOurs" | "ignoreTheirs",
    conflictIndex?: number,
  ) {
    if (!session || session.conflicts.length === 0) {
      return;
    }
    const index = conflictIndex ?? session.activeConflict;
    if (index < 0 || index >= session.resolutions.length) {
      return;
    }
    const current = session.resolutions[index] ?? emptyResolution();
    let next: ConflictResolution;
    if (decision === "unresolved" || decision === "empty") {
      next = emptyResolution();
    } else if (decision === "ignoreOurs") {
      next = applyIgnore(current, "ours");
    } else if (decision === "ignoreTheirs") {
      next = applyIgnore(current, "theirs");
    } else if (decision === "ours") {
      next = applyAccept(current, "ours");
    } else if (decision === "theirs") {
      next = applyAccept(current, "theirs");
    } else if (decision === "oursThenTheirs") {
      next = applyAccept(applyAccept(emptyResolution(), "ours"), "theirs");
    } else if (decision === "theirsThenOurs") {
      next = applyAccept(applyAccept(emptyResolution(), "theirs"), "ours");
    } else {
      return;
    }
    if (resolutionsEqual(next, current)) {
      return;
    }
    pushUndoSnapshot();
    const resolutions = [...session.resolutions];
    resolutions[index] = next;
    const region =
      session.conflicts.find((item) => item.index === index) ??
      session.conflicts[index];
    const jumpTo =
      region && isResolutionComplete(next, region)
        ? nextUnresolvedIndex(resolutions, session.conflicts, index)
        : index;
    updateSession(
      rebuildSession(session.document, resolutions, jumpTo, true),
    );
  }

  function undoDecision() {
    if (!session || undoStack.length === 0) {
      return;
    }
    const previous = undoStack[undoStack.length - 1];
    setUndoStack((stack) => stack.slice(0, -1));
    // 将当前状态推入 redo 栈
    setRedoStack((stack) => [
      ...stack,
      {
        resolutions: session.resolutions.map((item) => ({
          ...item,
          acceptOrder: [...item.acceptOrder],
        })),
        activeConflict: session.activeConflict,
        dirty: session.dirty,
      },
    ]);
    updateSession(
      rebuildSession(
        session.document,
        previous.resolutions,
        previous.activeConflict,
        previous.dirty,
      ),
    );
  }

  function redoDecision() {
    if (!session || redoStack.length === 0) {
      return;
    }
    const next = redoStack[redoStack.length - 1];
    setRedoStack((stack) => stack.slice(0, -1));
    // 将当前状态推入 undo 栈
    setUndoStack((stack) => [
      ...stack,
      {
        resolutions: session.resolutions.map((item) => ({
          ...item,
          acceptOrder: [...item.acceptOrder],
        })),
        activeConflict: session.activeConflict,
        dirty: session.dirty,
      },
    ]);
    updateSession(
      rebuildSession(
        session.document,
        next.resolutions,
        next.activeConflict,
        next.dirty,
      ),
    );
  }

  function hasUnresolvedInDirection(direction: number): boolean {
    if (!session || session.conflicts.length === 0) {
      return false;
    }

    const delta = direction > 0 ? 1 : -1;
    const start = session.activeConflict;
    let current = start + delta;

    // 不循环，只在指定方向上查找
    while (current >= 0 && current < session.conflicts.length) {
      const conflict = session.conflicts[current];
      const resolution = session.resolutions[current] ?? emptyResolution();

      if (conflict && !isResolutionComplete(resolution, conflict)) {
        return true;
      }

      current += delta;
    }

    return false;
  }

  function goConflict(delta: number) {
    if (!session || session.conflicts.length === 0) {
      return;
    }

    const direction = delta > 0 ? 1 : -1;
    let current = session.activeConflict + direction;

    // 不循环，只在指定方向上查找
    while (current >= 0 && current < session.conflicts.length) {
      const conflict = session.conflicts[current];
      const resolution = session.resolutions[current] ?? emptyResolution();

      // 找到第一个未完全解决的冲突块
      if (conflict && !isResolutionComplete(resolution, conflict)) {
        updateSession({ ...session, activeConflict: current });
        return;
      }

      current += direction;
    }

    // 到达边界或所有冲突都已解决，保持在当前位置
  }

  function setActiveConflict(index: number) {
    if (!session) {
      return;
    }
    updateSession({ ...session, activeConflict: index });
  }

  async function acceptAllSide(side: "ours" | "theirs") {
    if (!session || session.conflicts.length === 0) {
      return;
    }

    const sideLabel = side === "ours" ? oursLabel : theirsLabel;
    const confirmed = await confirm(
      `这将对当前文件的 ${session.conflicts.length} 个冲突块全部使用 ${sideLabel} 的内容。`,
      {
        title: `确认要全部接受 ${sideLabel} 吗？`,
        kind: "warning",
        okLabel: "确认",
        cancelLabel: "取消",
      }
    );

    if (!confirmed) {
      return;
    }

    pushUndoSnapshot();

    // 对所有冲突块应用决策
    const resolutions = session.conflicts.map(() =>
      applyAccept(emptyResolution(), side)
    );

    const updatedSession = rebuildSession(
      session.document,
      resolutions,
      session.activeConflict,
      true
    );

    updateSession(updatedSession);

    // 自动保存并返回列表
    onChangeView({ ...view, session: updatedSession, saving: true, saveError: null });
    try {
      const endsWithNewline = updatedSession.document.working.endsWith("\n");
      const result = serializeResult(updatedSession.resultLines, endsWithNewline);
      await invoke("save_merge_result", {
        path: updatedSession.document.path,
        result,
        stage: true,
      });
      onSaved();
    } catch (error) {
      onChangeView({
        ...view,
        session: updatedSession,
        saving: false,
        saveError: error instanceof Error ? error.message : String(error),
      });
    }
  }

  async function saveFile() {
    if (!session || !canSave) {
      return;
    }
    onChangeView({ ...view, saving: true, saveError: null });
    try {
      const endsWithNewline = session.document.working.endsWith("\n");
      const result = serializeResult(session.resultLines, endsWithNewline);
      await invoke("save_merge_result", {
        path: session.document.path,
        result,
        stage: true,
      });
      onSaved();
    } catch (error) {
      onChangeView({
        ...view,
        saving: false,
        saveError: error instanceof Error ? error.message : String(error),
      });
    }
  }

  async function handleSaveAndFinish() {
    if (!session) {
      return;
    }
    onChangeView({ ...view, saving: true, saveError: null });
    try {
      const endsWithNewline = session.document.working.endsWith("\n");
      const result = serializeResult(session.resultLines, endsWithNewline);
      await invoke("save_merge_result", {
        path: session.document.path,
        result,
        stage: true,
      });
      onSaved();
    } catch (error) {
      onChangeView({
        ...view,
        saving: false,
        saveError: error instanceof Error ? error.message : String(error),
      });
    }
  }

  async function handleCancel() {
    if (!session) {
      onBack();
      return;
    }

    // 如果有任何操作（undo stack 不为空）或者标记为 dirty，弹出确认对话框
    if (session.dirty || undoStack.length > 0) {
      const confirmed = await confirm(
        "当前有未保存的更改，确定要取消合并操作吗？",
        {
          title: "确认取消",
          kind: "warning",
          okLabel: "取消已改动内容，并取消合并",
          cancelLabel: "继续合并",
        }
      );

      if (confirmed) {
        onBack();
      }
    } else {
      // 没有任何更改，直接返回
      onBack();
    }
  }

  useEffect(() => {
    if (!session || session.activeConflict < 0) {
      return;
    }
    const region = session.conflicts[session.activeConflict];
    if (!region || !scrollRef.current) {
      return;
    }

    // 三栏都滚动到激活的冲突块
    const panes = [
      scrollRef.current.querySelector(".pane-ours"),
      scrollRef.current.querySelector(".pane-result"),
      scrollRef.current.querySelector(".pane-theirs"),
    ];

    panes.forEach((pane) => {
      if (!(pane instanceof HTMLElement)) {
        return;
      }
      const target = pane.querySelector(
        `[data-conflict-index="${region.index}"]`,
      );
      if (!(target instanceof HTMLElement)) {
        return;
      }
      const top =
        target.getBoundingClientRect().top -
        pane.getBoundingClientRect().top +
        pane.scrollTop -
        pane.clientHeight / 2 +
        target.offsetHeight / 2;
      pane.scrollTo({
        top: Math.max(0, top),
        behavior: "smooth",
      });
    });
  }, [session?.activeConflict, session?.conflicts]);

  useEffect(() => {
    setPaneHighlights(emptyPaneHighlights());
    setUndoStack([]);
    setRedoStack([]);
  }, [view.selectedPath]);

  useEffect(() => {
    if (!session) {
      setPaneHighlights(emptyPaneHighlights());
      return;
    }

    const requestId = highlightRequestRef.current + 1;
    highlightRequestRef.current = requestId;

    const language = languageFromPath(view.selectedPath);
    const lineCount = Math.max(
      countHighlightLines(oursHighlightText),
      countHighlightLines(theirsHighlightText),
      countHighlightLines(resultHighlightText),
    );

    if (lineCount > HIGHLIGHT_LINE_LIMIT) {
      setPaneHighlights(emptyPaneHighlights());
      return;
    }

    let cancelled = false;

    void (async () => {
      try {
        const [oursLines, theirsLines, resultLines] = await Promise.all([
          highlightLines(oursHighlightText, language),
          highlightLines(theirsHighlightText, language),
          highlightLines(resultHighlightText, language),
        ]);
        if (cancelled || highlightRequestRef.current !== requestId) {
          return;
        }
        setPaneHighlights({
          ours: highlightedLinesToMap(oursLines),
          theirs: highlightedLinesToMap(theirsLines),
          result: highlightedLinesToMap(resultLines),
        });
      } catch {
        if (cancelled || highlightRequestRef.current !== requestId) {
          return;
        }
        setPaneHighlights(emptyPaneHighlights());
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [
    view.selectedPath,
    session == null,
    oursHighlightText,
    theirsHighlightText,
    resultHighlightText,
  ]);

  useEffect(() => {
    function onKeyDown(event: KeyboardEvent) {
      if (!session) {
        return;
      }
      const target = event.target as HTMLElement | null;
      if (
        target &&
        (target.tagName === "INPUT" ||
          target.tagName === "TEXTAREA" ||
          target.isContentEditable)
      ) {
        return;
      }

      const key = event.key.toLowerCase();
      const hasMod = event.metaKey || event.ctrlKey;
      if (hasMod && key === "z" && event.shiftKey) {
        if (!canRedo) {
          return;
        }
        event.preventDefault();
        redoDecision();
        return;
      }
      if (hasMod && key === "z" && !event.shiftKey) {
        if (!canUndo) {
          return;
        }
        event.preventDefault();
        undoDecision();
        return;
      }
      if (hasMod && key === "s" && canSave && !view.saving) {
        event.preventDefault();
        void saveFile();
        return;
      }
      if (key === "escape") {
        event.preventDefault();
        onBack();
        return;
      }
      if (hasMod) {
        return;
      }
      if (key === "n") {
        event.preventDefault();
        goConflict(1);
        return;
      }
      if (key === "p") {
        event.preventDefault();
        goConflict(-1);
        return;
      }
      if (key === "1") {
        event.preventDefault();
        setDecision("ours");
        return;
      }
      if (key === "2") {
        event.preventDefault();
        setDecision("theirs");
        return;
      }
      if (key === "r") {
        event.preventDefault();
        setDecision("unresolved");
        return;
      }
      if (key === "s" && canSave && !view.saving) {
        event.preventDefault();
        void saveFile();
      }
    }

    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  });

  return (
    <div className="workspace">
      <header className="topbar">
        <div className="topbar-main">
          <div className="topbar-navigation">
            <button
              type="button"
              className="ghost"
              disabled={!canGoPrev}
              onClick={() => goConflict(-1)}
            >
              上一块
            </button>
            <button
              type="button"
              className="ghost"
              disabled={!canGoNext}
              onClick={() => goConflict(1)}
            >
              下一块
            </button>
          </div>
          {session ? (
            <>
              <span className="muted">{session.document.path}</span>
              <span className="topbar-stats">
                {unresolvedChanges === 0
                  ? "No changes"
                  : `${unresolvedChanges} change${unresolvedChanges !== 1 ? "s" : ""}`}
                {" · "}
                {unresolvedConflictBlocks === 0
                  ? "No conflicts"
                  : `${unresolvedConflictBlocks} conflict${unresolvedConflictBlocks !== 1 ? "s" : ""}`}
              </span>
            </>
          ) : null}
          {session && unresolvedConflicts.length === 0 && session.conflicts.length > 0 ? (
            <span className="topbar-success">
              ✓ All changes have been processed
              <button
                type="button"
                className="topbar-success-action"
                onClick={handleSaveAndFinish}
                disabled={view.saving}
              >
                保存改动并完成合并
              </button>
            </span>
          ) : null}
        </div>
        <div className="topbar-meta">
          {oursLabel} ← {theirsLabel}
        </div>
      </header>

      <div className="merge-only">
        {view.detailError ? (
          <p className="error pad">{view.detailError}</p>
        ) : !session ? (
          <p className="muted pad">正在加载文件…</p>
        ) : (
          <>
            <div className="merge-shell">
              <div className="merge-headers">
                <div className="pane-title">Yours · {oursLabel}</div>
                <div className="pane-title-gutter" aria-hidden="true" />
                <div className="pane-title">Result</div>
                <div className="pane-title-gutter" aria-hidden="true" />
                <div className="pane-title">Theirs · {theirsLabel}</div>
              </div>
              <div className="merge-scroll" ref={scrollRef}>
                <MergeGrid
                  rows={session.rows}
                  conflicts={session.conflicts}
                  activeConflict={session.activeConflict}
                  paneHighlights={paneHighlights}
                  onSelectConflict={setActiveConflict}
                  onDecision={setDecision}
                />
              </div>
            </div>

            <footer className="bottombar">
              <div className="bottombar-actions bottombar-actions-left">
                <button
                  type="button"
                  disabled={session.conflicts.length === 0 || view.saving}
                  onClick={() => void acceptAllSide("ours")}
                >
                  Accept Left
                </button>
                <button
                  type="button"
                  disabled={session.conflicts.length === 0 || view.saving}
                  onClick={() => void acceptAllSide("theirs")}
                >
                  Accept Right
                </button>
              </div>
              <div className="bottombar-status">
                {view.saveError ? (
                  <span className="error">{view.saveError}</span>
                ) : null}
              </div>
              <div className="bottombar-actions">
                <button type="button" className="ghost" onClick={handleCancel}>
                  取消
                </button>
                <button
                  type="button"
                  className="primary"
                  disabled={!canSave || view.saving}
                  onClick={() => void saveFile()}
                >
                  {view.saving ? "保存中…" : "应用"}
                </button>
              </div>
            </footer>
          </>
        )}
      </div>
    </div>
  );
}

function readLineHeight(el: HTMLElement): number {
  const raw = getComputedStyle(el).getPropertyValue("--line-height").trim();
  if (raw.endsWith("rem")) {
    const rem = Number.parseFloat(raw);
    if (!Number.isNaN(rem)) {
      const root = Number.parseFloat(
        getComputedStyle(document.documentElement).fontSize,
      );
      return rem * (Number.isNaN(root) ? 14 : root);
    }
  }
  const px = Number.parseFloat(raw);
  return Number.isNaN(px) ? 24 : px;
}

/** 相对 gutter 顶边的冲突块 Y 区间（pane 与 gutter 同列对齐） */
function measureConflictY(
  pane: HTMLElement,
  gutterTop: number,
  conflictIndex: number,
): { top: number; bottom: number } | null {
  const cells = pane.querySelectorAll(
    `[data-conflict-index="${conflictIndex}"]`,
  );
  if (cells.length === 0) {
    return null;
  }
  const lineHeight = readLineHeight(pane);
  const first = cells[0].getBoundingClientRect();
  const last = cells[cells.length - 1].getBoundingClientRect();
  const top = first.top - gutterTop;
  const bottom = Math.max(last.bottom - gutterTop, top + lineHeight);
  return { top, bottom };
}

function measureResultY(
  resultPane: HTMLElement,
  gutterTop: number,
  conflict: ConflictRegion,
  fallback: { top: number; bottom: number },
): { top: number; bottom: number } {
  const direct = measureConflictY(resultPane, gutterTop, conflict.index);
  if (direct) {
    return direct;
  }

  const lineHeight = readLineHeight(resultPane);
  const cells = resultPane.querySelectorAll("[data-row-index]");
  let before: Element | null = null;
  let after: Element | null = null;
  for (const cell of cells) {
    const rowIndex = Number(cell.getAttribute("data-row-index"));
    if (Number.isNaN(rowIndex)) {
      continue;
    }
    if (rowIndex < conflict.rowStart) {
      before = cell;
    } else if (rowIndex > conflict.rowEnd && after === null) {
      after = cell;
    }
  }

  if (before) {
    const y = before.getBoundingClientRect().bottom - gutterTop;
    return { top: y, bottom: y + lineHeight };
  }
  if (after) {
    const y = after.getBoundingClientRect().top - gutterTop;
    return { top: y - lineHeight, bottom: y };
  }
  return fallback;
}

function ribbonPath(
  x0: number,
  x1: number,
  y0a: number,
  y0b: number,
  y1a: number,
  y1b: number,
): string {
  const cx = (x0 + x1) / 2;
  return [
    `M ${x0} ${y0a}`,
    `C ${cx} ${y0a}, ${cx} ${y1a}, ${x1} ${y1a}`,
    `L ${x1} ${y1b}`,
    `C ${cx} ${y1b}, ${cx} ${y0b}, ${x0} ${y0b}`,
    "Z",
  ].join(" ");
}

/** Result 端连接带高度：未解决时收成细条，两侧块高度不变 */
function resultRibbonSpan(
  top: number,
  bottom: number,
  lineHeight: number,
  unresolved: boolean,
): { top: number; bottom: number } {
  const safeBottom = Math.max(top + 2, bottom);
  if (!unresolved) {
    return { top, bottom: safeBottom };
  }
  const mid = (top + safeBottom) / 2;
  // 与 .is-result-strip::before 的 5px 细条对齐
  const half = Math.max(2, Math.min(lineHeight * 0.18, 2.5));
  return { top: mid - half, bottom: mid + half };
}

type PaneScrollRef = RefObject<HTMLDivElement | null>;

/**
 * 任一栏纵向滚动时，按共享 row-index（连接带两端同一冲突行）同步其余两栏，
 * 使冲突连接线在滚动中保持水平对齐。
 */
function useLinkedPaneScroll(
  oursPaneRef: PaneScrollRef,
  resultPaneRef: PaneScrollRef,
  theirsPaneRef: PaneScrollRef,
  layoutEpoch: number,
) {
  useEffect(() => {
    const panes = [oursPaneRef.current, resultPaneRef.current, theirsPaneRef.current].filter(
      (el): el is HTMLDivElement => el instanceof HTMLDivElement,
    );
    if (panes.length < 2) {
      return;
    }

    let syncing = false;
    let raf = 0;
    let leader: HTMLDivElement | null = null;

    const cellContentTop = (pane: HTMLElement, cell: HTMLElement) =>
      cell.getBoundingClientRect().top -
      pane.getBoundingClientRect().top +
      pane.scrollTop;

    const findAnchor = (
      pane: HTMLDivElement,
    ): { rowIndex: number; offsetInViewport: number } | null => {
      const lines = pane.querySelector(".merge-pane-lines");
      if (!(lines instanceof HTMLElement) || lines.children.length === 0) {
        return null;
      }
      const children = lines.children;
      const probe = pane.scrollTop + Math.min(48, pane.clientHeight * 0.25);
      let lo = 0;
      let hi = children.length - 1;
      let ans = children.length - 1;
      while (lo <= hi) {
        const mid = (lo + hi) >> 1;
        const el = children[mid];
        if (!(el instanceof HTMLElement)) {
          break;
        }
        const top = cellContentTop(pane, el);
        if (top + el.offsetHeight > probe) {
          ans = mid;
          hi = mid - 1;
        } else {
          lo = mid + 1;
        }
      }
      const cell = children[ans];
      if (!(cell instanceof HTMLElement)) {
        return null;
      }
      const rowIndex = Number(cell.getAttribute("data-row-index"));
      if (Number.isNaN(rowIndex)) {
        return null;
      }
      return {
        rowIndex,
        offsetInViewport: cellContentTop(pane, cell) - pane.scrollTop,
      };
    };

    const syncFrom = (source: HTMLDivElement) => {
      const anchor = findAnchor(source);
      if (!anchor) {
        return;
      }
      syncing = true;
      for (const pane of panes) {
        if (pane === source) {
          continue;
        }
        const cell = pane.querySelector<HTMLElement>(
          `[data-row-index="${anchor.rowIndex}"]`,
        );
        if (!cell) {
          continue;
        }
        const nextTop = cellContentTop(pane, cell) - anchor.offsetInViewport;
        const maxTop = Math.max(0, pane.scrollHeight - pane.clientHeight);
        const clamped = Math.max(0, Math.min(maxTop, nextTop));
        if (Math.abs(pane.scrollTop - clamped) > 0.5) {
          pane.scrollTop = clamped;
        }
      }
      requestAnimationFrame(() => {
        syncing = false;
        leader = null;
      });
    };

    const onScroll = (event: Event) => {
      const source = event.currentTarget;
      if (!(source instanceof HTMLDivElement) || syncing) {
        return;
      }
      if (leader && leader !== source) {
        return;
      }
      leader = source;
      if (raf) {
        cancelAnimationFrame(raf);
      }
      raf = requestAnimationFrame(() => {
        raf = 0;
        syncFrom(source);
      });
    };

    for (const pane of panes) {
      pane.addEventListener("scroll", onScroll, { passive: true });
    }

    return () => {
      if (raf) {
        cancelAnimationFrame(raf);
      }
      for (const pane of panes) {
        pane.removeEventListener("scroll", onScroll);
      }
    };
  }, [layoutEpoch, oursPaneRef, resultPaneRef, theirsPaneRef]);
}

type ConflictLinkGeometry = {
  index: number;
  path: string;
  isActive: boolean;
  isChange: boolean;
};

function ConflictLinkGutter({
  side,
  conflicts,
  activeConflict,
  layoutKey,
  paneEpoch,
  sidePaneRef,
  resultPaneRef,
  onSelectConflict,
}: {
  side: "ours" | "theirs";
  conflicts: ConflictRegion[];
  activeConflict: number;
  layoutKey: string;
  paneEpoch: number;
  sidePaneRef: RefObject<HTMLDivElement | null>;
  resultPaneRef: RefObject<HTMLDivElement | null>;
  onSelectConflict: (index: number) => void;
}) {
  const gutterRef = useRef<HTMLDivElement>(null);
  const [links, setLinks] = useState<ConflictLinkGeometry[]>([]);
  const [size, setSize] = useState({ width: 0, height: 0 });

  useLayoutEffect(() => {
    const gutter = gutterRef.current;
    const sidePane = sidePaneRef.current;
    const resultPane = resultPaneRef.current;
    if (!gutter || !sidePane || !resultPane) {
      return;
    }

    let raf = 0;

    const redraw = () => {
      raf = 0;
      const gutterRect = gutter.getBoundingClientRect();
      const width = Math.max(gutter.clientWidth, gutterRect.width, 1);
      const height = Math.max(gutter.clientHeight, gutterRect.height, 1);
      setSize((prev) =>
        prev.width === width && prev.height === height
          ? prev
          : { width, height },
      );

      const lineHeight = readLineHeight(sidePane);
      const next: ConflictLinkGeometry[] = [];

      conflicts.forEach((conflict, order) => {
        // 已合并到 Result 的一侧：不再画连接带
        if (sideDecisionMerged(side, conflict)) {
          return;
        }
        // 单方绿色变更：只在有内容的一侧画连接带（WebStorm：左侧不出现右侧独有绿块）
        if (isChangeBlock(conflict)) {
          const sideText = side === "ours" ? conflict.ours : conflict.theirs;
          if (!sideHasSubstantive(sideText)) {
            return;
          }
        }

        const measured = measureConflictY(
          sidePane,
          gutterRect.top,
          conflict.index,
        );
        // 测量失败也不丢操作块：按序号给一个可见落点
        const sideBlock = measured ?? {
          top: Math.min(height - lineHeight, 24 + order * lineHeight * 4),
          bottom: Math.min(height, 24 + order * lineHeight * 4 + lineHeight * 3),
        };
        const resultBlock = measureResultY(
          resultPane,
          gutterRect.top,
          conflict,
          {
            top: (sideBlock.top + sideBlock.bottom) / 2 - lineHeight / 2,
            bottom: (sideBlock.top + sideBlock.bottom) / 2 + lineHeight / 2,
          },
        );

        const sideTop = sideBlock.top;
        const sideBottom = Math.max(sideTop + 2, sideBlock.bottom);
        const { top: resultTop, bottom: resultBottom } = resultRibbonSpan(
          resultBlock.top,
          resultBlock.bottom,
          lineHeight,
          conflict.decision === "unresolved",
        );

        if (
          (sideBottom < -120 && resultBottom < -120) ||
          (sideTop > height + 120 && resultTop > height + 120)
        ) {
          return;
        }

        const path =
          side === "ours"
            ? ribbonPath(0, width, sideTop, sideBottom, resultTop, resultBottom)
            : ribbonPath(
                0,
                width,
                resultTop,
                resultBottom,
                sideTop,
                sideBottom,
              );

        const isChange = isChangeBlock(conflict);

        next.push({
          index: conflict.index,
          path,
          isActive: conflict.index === activeConflict,
          isChange,
        });
      });

      setLinks(next);
    };

    const schedule = () => {
      if (raf) {
        return;
      }
      raf = requestAnimationFrame(redraw);
    };

    redraw();
    // 首帧布局有时尚未完成，再补两次
    const t1 = window.setTimeout(schedule, 50);
    const t2 = window.setTimeout(schedule, 200);

    sidePane.addEventListener("scroll", schedule, { passive: true });
    resultPane.addEventListener("scroll", schedule, { passive: true });
    window.addEventListener("resize", schedule);

    const observer = new ResizeObserver(schedule);
    observer.observe(gutter);
    observer.observe(sidePane);
    observer.observe(resultPane);
    const sideLines = sidePane.querySelector(".merge-pane-lines");
    const resultLines = resultPane.querySelector(".merge-pane-lines");
    if (sideLines) {
      observer.observe(sideLines);
    }
    if (resultLines) {
      observer.observe(resultLines);
    }

    return () => {
      if (raf) {
        cancelAnimationFrame(raf);
      }
      window.clearTimeout(t1);
      window.clearTimeout(t2);
      sidePane.removeEventListener("scroll", schedule);
      resultPane.removeEventListener("scroll", schedule);
      window.removeEventListener("resize", schedule);
      observer.disconnect();
    };
  }, [
    activeConflict,
    conflicts,
    layoutKey,
    paneEpoch,
    resultPaneRef,
    side,
    sidePaneRef,
  ]);

  return (
    <div
      ref={gutterRef}
      className={`conflict-link-gutter gutter-${side}`}
      aria-label={side === "ours" ? "Yours 冲突连接" : "Theirs 冲突连接"}
    >
      <svg
        className="conflict-link-svg"
        width={size.width}
        height={size.height}
        viewBox={`0 0 ${Math.max(size.width, 1)} ${Math.max(size.height, 1)}`}
      >
        {links.map((link) => {
          const base = link.isChange
            ? "change-link-path"
            : "conflict-link-path";
          return (
            <path
              key={link.index}
              d={link.path}
              className={link.isActive ? `${base} is-active` : base}
              onClick={() => onSelectConflict(link.index)}
            />
          );
        })}
      </svg>
    </div>
  );
}

function MergeGrid({
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
      if (isChangeBlock(conflict)) {
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
                  sideHasConflictActions("ours", item.conflict)
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
                  sideHasConflictActions("theirs", item.conflict)
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

function MergeCell({
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
            ? "\u00a0"
            : lineText}
      </code>
    </div>
  );
}

function InlineConflictActions({
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

export default App;
