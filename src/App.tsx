import {
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type RefObject,
} from "react";
import { invoke } from "@tauri-apps/api/core";
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
import "./App.css";

type GitOperation = "none" | "merge" | "rebase" | "cherryPick" | "revert";
type ConflictDecision =
  | "unresolved"
  | "ours"
  | "theirs"
  | "oursThenTheirs"
  | "theirsThenOurs";
type SideStatus = "modified" | "added" | "deleted";
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
  /** conflict=双方红；change=单方绿；均需手动 Accept */
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
  decisions: ConflictDecision[];
  rows: MergeRow[];
  resultLines: ResultLine[];
  conflicts: ConflictRegion[];
  activeConflict: number;
  dirty: boolean;
};

type MergeUndoEntry = {
  decisions: ConflictDecision[];
  activeConflict: number;
  dirty: boolean;
};

type AppView =
  | { kind: "loading" }
  | { kind: "error"; message: string }
  | { kind: "empty"; workspace: WorkspaceSnapshot }
  | {
      kind: "conflicts";
      workspace: WorkspaceSnapshot;
      selectedPath: string;
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
  added: "Added",
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

function isChangeBlock(conflict: ConflictRegion | null | undefined): boolean {
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

/** 单方绿块在无内容侧不着色，只留对齐空行；已合并到 Result 的一侧不再标成冲突 */
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
    if (side === "ours" && conflict && decisionIncludesOurs(conflict.decision)) {
      return "context";
    }
    if (
      side === "theirs" &&
      conflict &&
      decisionIncludesTheirs(conflict.decision)
    ) {
      return "context";
    }
  }
  return rowKind;
}

function sideHasConflictActions(
  side: "ours" | "theirs",
  conflict: ConflictRegion | null | undefined,
): boolean {
  if (!conflict) {
    return false;
  }
  if (side === "ours" && decisionIncludesOurs(conflict.decision)) {
    return false;
  }
  if (side === "theirs" && decisionIncludesTheirs(conflict.decision)) {
    return false;
  }
  if (!isChangeBlock(conflict)) {
    return true;
  }
  const sideText = side === "ours" ? conflict.ours : conflict.theirs;
  return sideHasSubstantive(sideText);
}

function sideDecisionMerged(
  side: "ours" | "theirs",
  conflict: ConflictRegion | null | undefined,
): boolean {
  if (!conflict) {
    return false;
  }
  return side === "ours"
    ? decisionIncludesOurs(conflict.decision)
    : decisionIncludesTheirs(conflict.decision);
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

/** 先接受一侧后再接受另一侧时，追加而不是替换。 */
function resolveNextDecision(
  current: ConflictDecision,
  incoming: ConflictDecision,
): ConflictDecision {
  if (incoming === "unresolved") {
    return "unresolved";
  }
  if (current === "unresolved") {
    return incoming;
  }
  if (current === incoming) {
    return current;
  }
  if (current === "ours" && incoming === "theirs") {
    return "oursThenTheirs";
  }
  if (current === "theirs" && incoming === "ours") {
    return "theirsThenOurs";
  }
  // 已是双方拼接时再点单侧 → 改为仅该侧
  return incoming;
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
    document.conflicts.map(() => "unresolved"),
    document.conflicts.length > 0 ? 0 : -1,
    false,
  );
}

function rebuildSession(
  document: MergeDocument,
  decisions: ConflictDecision[],
  activeConflict: number,
  dirty: boolean,
): MergeSession {
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
      blockKind,
      ours: oursText || region.ours,
      theirs: theirsText || region.theirs,
    });

    rowIndex += conflictDocRows.length;
    conflictCursor += 1;
  }

  const unresolvedCount = decisions.filter((d) => d === "unresolved").length;
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
  decisions: ConflictDecision[],
  from: number,
): number {
  if (decisions.length === 0) {
    return -1;
  }
  for (let offset = 1; offset <= decisions.length; offset += 1) {
    const index = (from + offset) % decisions.length;
    if (decisions[index] === "unresolved") {
      return index;
    }
  }
  return from;
}

function App() {
  const [view, setView] = useState<AppView>({ kind: "loading" });

  async function loadConflicts(preferredPath?: string) {
    setView({ kind: "loading" });
    try {
      const workspace = await invoke<WorkspaceSnapshot>("get_workspace");
      if (workspace.files.length === 0) {
        setView({ kind: "empty", workspace });
        return;
      }

      const selectedPath =
        preferredPath &&
        workspace.files.some((file) => file.path === preferredPath)
          ? preferredPath
          : workspace.files[0].path;

      setView({
        kind: "conflicts",
        workspace,
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
    void loadConflicts();
  }, []);

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
            await invoke("accept_file_side", {
              path: view.selectedPath,
              side,
            });
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
      onBack={() => void loadConflicts(view.selectedPath)}
      onChangeView={setView}
      onSaved={() => void loadConflicts()}
    />
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
  const unresolved = session
    ? session.decisions.filter((d) => d === "unresolved").length
    : 0;
  const canSave = session !== null && session.conflicts.length > 0 && unresolved === 0;
  const canUndo = undoStack.length > 0;

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
        decisions: [...session.decisions],
        activeConflict: session.activeConflict,
        dirty: session.dirty,
      },
    ]);
  }

  function setDecision(decision: ConflictDecision, conflictIndex?: number) {
    if (!session || session.conflicts.length === 0) {
      return;
    }
    const index = conflictIndex ?? session.activeConflict;
    if (index < 0 || index >= session.decisions.length) {
      return;
    }
    const next = resolveNextDecision(session.decisions[index], decision);
    if (next === session.decisions[index]) {
      return;
    }
    pushUndoSnapshot();
    const decisions = [...session.decisions];
    decisions[index] = next;
    const jumpTo =
      next === "unresolved" ? index : nextUnresolvedIndex(decisions, index);
    updateSession(
      rebuildSession(session.document, decisions, jumpTo, true),
    );
  }

  function undoDecision() {
    if (!session || undoStack.length === 0) {
      return;
    }
    const previous = undoStack[undoStack.length - 1];
    setUndoStack((stack) => stack.slice(0, -1));
    updateSession(
      rebuildSession(
        session.document,
        previous.decisions,
        previous.activeConflict,
        previous.dirty,
      ),
    );
  }

  function goConflict(delta: number) {
    if (!session || session.conflicts.length === 0) {
      return;
    }
    const next =
      (session.activeConflict + delta + session.conflicts.length) %
      session.conflicts.length;
    updateSession({ ...session, activeConflict: next });
  }

  function setActiveConflict(index: number) {
    if (!session) {
      return;
    }
    updateSession({ ...session, activeConflict: index });
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

  useEffect(() => {
    if (!session || session.activeConflict < 0) {
      return;
    }
    const region = session.conflicts[session.activeConflict];
    if (!region || !scrollRef.current) {
      return;
    }
    const panes = scrollRef.current.querySelectorAll(".merge-pane");
    panes.forEach((pane) => {
      if (!(pane instanceof HTMLElement)) {
        return;
      }
      const target = pane.querySelector(
        `[data-row-index="${region.rowStart}"]`,
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
          <button type="button" className="ghost" onClick={onBack}>
            ← Conflicts
          </button>
          <strong>{fileNameOf(view.selectedPath)}</strong>
          <span className="muted">{view.selectedPath}</span>
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
                  disabled={session.activeConflict < 0}
                  onClick={() => setDecision("ours")}
                >
                  Accept Left
                </button>
                <button
                  type="button"
                  disabled={session.activeConflict < 0}
                  onClick={() => setDecision("theirs")}
                >
                  Accept Right
                </button>
              </div>
              <div className="bottombar-status">
                {session.document.path}
                {session.conflicts.length > 0 ? (
                  <>
                    {" · "}
                    Conflict {session.activeConflict + 1}/
                    {session.conflicts.length}
                    {" · "}
                    unresolved {unresolved}
                  </>
                ) : (
                  " · 无冲突块"
                )}
                {view.saveError ? (
                  <span className="error"> · {view.saveError}</span>
                ) : null}
              </div>
              <div className="bottombar-actions">
                <button
                  type="button"
                  className="ghost"
                  disabled={session.activeConflict < 0}
                  onClick={() => setDecision("unresolved")}
                >
                  Reset
                </button>
                <button
                  type="button"
                  className="ghost"
                  disabled={!canUndo}
                  title="Ctrl/⌘ + Z"
                  onClick={() => undoDecision()}
                >
                  撤销
                </button>
                <button
                  type="button"
                  className="ghost"
                  disabled={!session.conflicts.length}
                  onClick={() => goConflict(-1)}
                >
                  上一块
                </button>
                <button
                  type="button"
                  className="ghost"
                  disabled={!session.conflicts.length}
                  onClick={() => goConflict(1)}
                >
                  下一块
                </button>
                <button
                  type="button"
                  className="primary"
                  disabled={!canSave || view.saving}
                  onClick={() => void saveFile()}
                >
                  {view.saving ? "保存中…" : "Save & Stage"}
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
  onDecision: (decision: ConflictDecision, conflictIndex: number) => void;
}) {
  const oursPaneRef = useRef<HTMLDivElement>(null);
  const resultPaneRef = useRef<HTMLDivElement>(null);
  const theirsPaneRef = useRef<HTMLDivElement>(null);
  const [paneEpoch, setPaneEpoch] = useState(0);

  useLayoutEffect(() => {
    setPaneEpoch((value) => value + 1);
  }, [rows, conflicts]);

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
        `${item.index}:${item.decision}:${item.blockKind ?? ""}:${item.rowStart}:${item.rowEnd}`,
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
  onSelectConflict: (index: number) => void;
  onDecision?: (decision: ConflictDecision, conflictIndex: number) => void;
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
  onDecision,
}: {
  side: "ours" | "theirs";
  decision: ConflictDecision;
  onDecision: (decision: ConflictDecision) => void;
}) {
  const acceptTitle =
    side === "ours" ? "Accept Yours (1)" : "Accept Theirs (2)";

  if (side === "ours") {
    return (
      <div className="inline-actions">
        <button
          type="button"
          className={
            decision === "unresolved" ? "inline-btn active" : "inline-btn"
          }
          title="Reset (r)"
          onClick={(event) => {
            event.stopPropagation();
            onDecision("unresolved");
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
          decision === "unresolved" ? "inline-btn active" : "inline-btn"
        }
        title="Reset (r)"
        onClick={(event) => {
          event.stopPropagation();
          onDecision("unresolved");
        }}
      >
        ×
      </button>
    </div>
  );
}

export default App;
