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
type ConflictDecision = "unresolved" | "ours" | "theirs";
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
    const oursLines = splitLines(region.ours);
    const theirsLines = splitLines(region.theirs);
    const { source, lines: conflictResult } = decisionResultLines(
      decision,
      region.ours,
      region.theirs,
    );
    const rowStart = rows.length;
    const rowCount = Math.max(
      oursLines.length,
      theirsLines.length,
      conflictResult.length,
      1,
    );

    for (let offset = 0; offset < rowCount; offset += 1) {
      let oursLine: PaneLine | null = null;
      let theirsLine: PaneLine | null = null;
      let resultLine: PaneLine | null = null;

      if (offset < oursLines.length) {
        oursLine = { number: oursLineNo, text: oursLines[offset] };
        oursLineNo += 1;
      }
      if (offset < theirsLines.length) {
        theirsLine = { number: theirsLineNo, text: theirsLines[offset] };
        theirsLineNo += 1;
      }
      if (offset < conflictResult.length) {
        resultLine = { number: resultLineNo, text: conflictResult[offset] };
        resultLineNo += 1;
      }

      rows.push({
        id: `r${rows.length}`,
        kind:
          oursLine || theirsLine || resultLine ? "conflict" : "empty",
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
      ours: region.ours,
      theirs: region.theirs,
    });

    while (
      rowIndex < document.rows.length &&
      document.rows[rowIndex].conflictIndex === conflictIndex
    ) {
      rowIndex += 1;
    }
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
  const unresolved = session
    ? session.decisions.filter((d) => d === "unresolved").length
    : 0;
  const canSave = session !== null && session.conflicts.length > 0 && unresolved === 0;

  const oursLabel = session?.document.labels.ours ?? workspace.oursLabel;
  const theirsLabel = session?.document.labels.theirs ?? workspace.theirsLabel;

  const oursHighlightText = session
    ? splitLines(session.document.ours).join("\n")
    : "";
  const theirsHighlightText = session
    ? splitLines(session.document.theirs).join("\n")
    : "";
  const resultHighlightText = session
    ? session.resultLines.map((line) => line.text).join("\n")
    : "";

  function updateSession(next: MergeSession) {
    onChangeView({ ...view, session: next, saveError: null });
  }

  function setDecision(decision: ConflictDecision, conflictIndex?: number) {
    if (!session || session.conflicts.length === 0) {
      return;
    }
    const index = conflictIndex ?? session.activeConflict;
    if (index < 0 || index >= session.decisions.length) {
      return;
    }
    const decisions = [...session.decisions];
    decisions[index] = decision;
    const jumpTo =
      decision === "unresolved"
        ? index
        : nextUnresolvedIndex(decisions, index);
    updateSession(
      rebuildSession(session.document, decisions, jumpTo, true),
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
      if (key === "escape") {
        event.preventDefault();
        onBack();
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
                  disabled={session.activeConflict < 0}
                  onClick={() => setDecision("ours")}
                >
                  Yours
                </button>
                <button
                  type="button"
                  disabled={session.activeConflict < 0}
                  onClick={() => setDecision("theirs")}
                >
                  Theirs
                </button>
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

type ConflictLinkGeometry = {
  index: number;
  path: string;
  buttonTop: number;
  isActive: boolean;
  decision: ConflictDecision;
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
  onDecision,
}: {
  side: "ours" | "theirs";
  conflicts: ConflictRegion[];
  activeConflict: number;
  layoutKey: string;
  paneEpoch: number;
  sidePaneRef: RefObject<HTMLDivElement | null>;
  resultPaneRef: RefObject<HTMLDivElement | null>;
  onSelectConflict: (index: number) => void;
  onDecision: (decision: ConflictDecision, conflictIndex: number) => void;
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
        const resultTop = resultBlock.top;
        const resultBottom = Math.max(resultTop + 2, resultBlock.bottom);

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

        const visibleTop = Math.max(0, Math.min(sideTop, sideBottom));
        const visibleBottom = Math.min(height, Math.max(sideTop, sideBottom));
        const buttonTop =
          visibleBottom > visibleTop
            ? (visibleTop + visibleBottom) / 2
            : Math.max(8, Math.min(height - 8, (sideTop + sideBottom) / 2));

        next.push({
          index: conflict.index,
          path,
          buttonTop,
          isActive: conflict.index === activeConflict,
          decision: conflict.decision,
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
        {links.map((link) => (
          <path
            key={link.index}
            d={link.path}
            className={
              link.isActive
                ? "conflict-link-path is-active"
                : "conflict-link-path"
            }
            onClick={() => onSelectConflict(link.index)}
          />
        ))}
      </svg>
      {links.map((link) => (
        <div
          key={`action-${link.index}`}
          className={
            link.isActive
              ? "conflict-link-actions is-active"
              : "conflict-link-actions"
          }
          style={{ top: link.buttonTop }}
        >
          <InlineConflictActions
            side={side}
            decision={link.decision}
            onDecision={(decision) => onDecision(decision, link.index)}
          />
        </div>
      ))}
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

  // 某侧完全没有内容的冲突：仍要在首行留占位，否则连接带/操作块无法定位
  const emptySideConflicts = useMemo(() => {
    const ours = new Set<number>();
    const theirs = new Set<number>();
    for (const conflict of conflicts) {
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
      row.kind === "conflict" &&
      row.oursLine !== null &&
      row.theirsLine !== null &&
      oursText !== theirsText;
    const sideTokens = shouldDiff ? wordDiffTokens(oursText, theirsText) : null;
    const resultDiffTokens =
      sideTokens && conflict
        ? conflict.decision === "ours"
          ? sideTokens.left
          : conflict.decision === "theirs"
            ? sideTokens.right
            : null
        : null;

    const oursSyntax =
      row.oursLine?.number != null
        ? paneHighlights.ours.get(row.oursLine.number)
        : undefined;
    const resultSyntax =
      row.resultLine?.number != null
        ? paneHighlights.result.get(row.resultLine.number)
        : undefined;
    const theirsSyntax =
      row.theirsLine?.number != null
        ? paneHighlights.theirs.get(row.theirsLine.number)
        : undefined;

    return {
      row,
      index,
      isActive,
      showActions,
      conflict,
      oursTokens: buildRenderTokens(oursSyntax, sideTokens?.left),
      resultTokens: buildRenderTokens(
        resultSyntax,
        resultDiffTokens ?? undefined,
      ),
      theirsTokens: buildRenderTokens(theirsSyntax, sideTokens?.right),
    };
  });

  const oursItems = renderedRows.filter(
    (item) =>
      item.row.oursLine !== null ||
      (item.showActions &&
        item.row.conflictIndex !== null &&
        emptySideConflicts.ours.has(item.row.conflictIndex)),
  );
  const theirsItems = renderedRows.filter(
    (item) =>
      item.row.theirsLine !== null ||
      (item.showActions &&
        item.row.conflictIndex !== null &&
        emptySideConflicts.theirs.has(item.row.conflictIndex)),
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
        return;
      }
      map.set(row.conflictIndex, {
        index: row.conflictIndex,
        rowStart: index,
        rowEnd: index,
        decision: "unresolved",
        ours: row.oursLine?.text ?? "",
        theirs: row.theirsLine?.text ?? "",
      });
    });
    return [...map.values()];
  }, [conflicts, rows]);

  const layoutKey = `${rows.length}:${linkConflicts
    .map(
      (item) =>
        `${item.index}:${item.decision}:${item.rowStart}:${item.rowEnd}`,
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
                rowKind={item.row.kind}
                isActive={item.isActive}
                rowIndex={item.index}
                conflictIndex={item.row.conflictIndex}
                line={item.row.oursLine}
                renderTokens={item.oursTokens}
                onSelectConflict={onSelectConflict}
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
        onDecision={onDecision}
      />

      <div className="merge-pane pane-result" ref={resultPaneRef}>
        <div className="merge-pane-scroll">
          <div className="merge-pane-lines">
            {resultItems.map((item) => (
              <MergeCell
                key={`${item.row.id}-result`}
                side="result"
                rowKind={
                  item.row.conflictIndex != null ? "conflict" : item.row.kind
                }
                isActive={item.isActive}
                rowIndex={item.index}
                conflictIndex={item.row.conflictIndex}
                line={item.row.resultLine}
                renderTokens={item.resultTokens}
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
        onDecision={onDecision}
      />

      <div className="merge-pane pane-theirs" ref={theirsPaneRef}>
        <div className="merge-pane-scroll">
          <div className="merge-pane-lines">
            {theirsItems.map((item) => (
              <MergeCell
                key={`${item.row.id}-theirs`}
                side="theirs"
                rowKind={item.row.kind}
                isActive={item.isActive}
                rowIndex={item.index}
                conflictIndex={item.row.conflictIndex}
                line={item.row.theirsLine}
                renderTokens={item.theirsTokens}
                onSelectConflict={onSelectConflict}
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
  onSelectConflict,
}: {
  side: "ours" | "result" | "theirs";
  rowKind: MergeRowKind;
  isActive: boolean;
  rowIndex: number;
  conflictIndex: number | null;
  line: PaneLine | null;
  renderTokens?: RenderToken[];
  onSelectConflict: (index: number) => void;
}) {
  return (
    <div
      className={[
        "merge-cell",
        `side-${side}`,
        `row-${rowKind}`,
        line ? "" : "is-empty",
        conflictIndex !== null ? "is-conflict" : "",
        isActive ? "row-active-conflict" : "",
      ]
        .filter(Boolean)
        .join(" ")}
      data-row-index={rowIndex}
      data-conflict-index={
        conflictIndex != null ? String(conflictIndex) : undefined
      }
      onClick={() => {
        if (conflictIndex != null) {
          onSelectConflict(conflictIndex);
        }
      }}
    >
      <span className="line-number">{line?.number ?? ""}</span>
      <code className="line-text">
        {renderTokens && renderTokens.length > 0
          ? renderTokens.map((token, index) => (
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
          : (line?.text ?? "")}
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
  const acceptDecision = side === "ours" ? "ours" : "theirs";
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
            decision === acceptDecision ? "inline-btn active" : "inline-btn"
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
          decision === acceptDecision ? "inline-btn active" : "inline-btn"
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
