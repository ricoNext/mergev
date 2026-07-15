import { useEffect, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { confirm } from "@tauri-apps/plugin-dialog";
import { listen } from "@tauri-apps/api/event";
import type { AppView, MergeSession, MergeUndoEntry, ConflictDecision } from "../types";
import type { Theme } from "../theme";
import type { PaneHighlights } from "../syntaxHighlight";
import {
  emptyPaneHighlights,
  highlightedLinesToMap,
  highlightLines,
  HIGHLIGHT_LINE_LIMIT,
  languageFromPath,
  countHighlightLines,
} from "../syntaxHighlight";
import {
  rebuildSession,
  serializeResult,
  paneHighlightText,
} from "../core/mergeSession";
import {
  applyAccept,
  applyIgnore,
  emptyResolution,
  isResolutionComplete,
  nextUnresolvedIndex,
  resolutionsEqual,
} from "../utils/conflictUtils";
import { isChangeBlock } from "../utils/conflictUtils";
import { MergeGrid } from "../components/merge/MergeGrid";
import { saveTheme, applyThemeToDOM, resolveTheme } from "../theme";
import { updateSyntaxTheme } from "../syntaxHighlight";

export function MergeScreen({
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
    let next = current;
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
        repoRoot: workspace.root,
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
        repoRoot: workspace.root,
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
        repoRoot: workspace.root,
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

  // 监听来自菜单的主题切换事件
  useEffect(() => {
    const unlisten = listen<string>("theme-menu-selected", (event) => {
      const selectedTheme = event.payload as Theme;
      const resolved = resolveTheme(selectedTheme);
      applyThemeToDOM(resolved);
      updateSyntaxTheme(resolved);
      saveTheme(selectedTheme);
    });

    return () => {
      unlisten.then((fn) => fn());
    };
  }, []);

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
