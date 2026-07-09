import React, { useCallback, useEffect, useMemo, useState } from "react";
import { Box, Text, useApp, useInput, useStdout } from "ink";
import type { CliOptions } from "../config/index.js";
import { editText } from "../editor/index.js";
import { nextCommandForOperation, type ConflictFile } from "../git/index.js";
import { openMergeFile, saveResolvedFile, type OpenedMergeFile } from "../app/index.js";
import { conflictDecisionText } from "../merge/index.js";
import { validateBuiltIn } from "../validation/index.js";
import {
  clampScrollX,
  clampScrollY,
  maxLineWidth,
  resolveLayoutMode,
  resolvePaneContentRows,
  resolvePaneContentWidth,
  resolvePanesHeight,
  resolveShellInnerWidth,
  splitPaneLines,
  windowPaneText
} from "./layout.js";
import { isMouseInput, useMouseWheel } from "./mouse.js";
import { renderPaneText } from "./renderText.js";

type Props = {
  repoRoot: string;
  files: ConflictFile[];
  initialPath?: string;
  options: CliOptions;
};

type Screen = "list" | "merge" | "help" | "done";

export function MergevApp({ repoRoot, files: initialFiles, initialPath, options }: Props) {
  const { exit } = useApp();
  const { stdout } = useStdout();
  const [files, setFiles] = useState(initialFiles);
  const [screen, setScreen] = useState<Screen>(initialPath ? "merge" : "list");
  const [selected, setSelected] = useState(Math.max(0, initialFiles.findIndex((file) => file.path === initialPath)));
  const [opened, setOpened] = useState<OpenedMergeFile>();
  const [message, setMessage] = useState<string>("");
  const [revision, setRevision] = useState(0);
  const [side, setSide] = useState<"ours" | "theirs">("ours");
  const [busy, setBusy] = useState(false);
  const [confirmQuit, setConfirmQuit] = useState(false);
  const [scrollY, setScrollY] = useState(0);
  const [scrollX, setScrollX] = useState(0);

  const selectedFile = files[selected];

  useEffect(() => {
    if (initialPath && selectedFile && !opened) {
      void openSelected(selectedFile);
    }
  }, [initialPath, opened, selectedFile]);

  async function openSelected(file: ConflictFile | undefined) {
    if (!file) {
      return;
    }

    if (!file.supported) {
      setMessage(file.reason ?? "Unsupported conflict file.");
      return;
    }

    setBusy(true);
    try {
      setOpened(await openMergeFile(repoRoot, file));
      setScrollY(0);
      setScrollX(0);
      setScreen("merge");
      setMessage(file.isLockfile ? "Lockfile warning: review carefully; regeneration is not automated." : "");
    } catch (error) {
      setMessage(error instanceof Error ? error.message : String(error));
    } finally {
      setBusy(false);
    }
  }

  async function save(forceAdd: boolean) {
    if (!opened) {
      return;
    }

    setBusy(true);
    const result = await saveResolvedFile(repoRoot, opened.file, opened.model, {
      noAdd: options.noAdd,
      check: options.check,
      forceAdd
    });

    if (!result.ok) {
      const detail = result.validation && !result.validation.ok ? ` ${result.validation.issues.map((issue) => issue.message).join("; ")}` : "";
      setMessage(`${result.reason}${detail}`);
      setBusy(false);
      return;
    }

    const remaining = files.filter((file) => file.path !== opened.file.path);
    setFiles(remaining);
    setOpened(undefined);
    setBusy(false);

    if (remaining.length === 0) {
      setScreen("done");
      const command = nextCommandForOperation(opened.file.operation);
      setMessage(command ? `All conflicts resolved. Next: ${command}` : "All conflicts resolved.");
      return;
    }

    const nextIndex = Math.min(selected, remaining.length - 1);
    setSelected(nextIndex);
    if (options.all) {
      await openSelected(remaining[nextIndex]);
    } else {
      setScreen("list");
      setMessage(`Saved ${opened.file.path}${result.added ? " and staged it" : ""}.`);
    }
  }

  function requestCancel() {
    const model = opened?.model;
    if (!model) {
      setScreen("list");
      return;
    }

    if (model.revision > 0) {
      setConfirmQuit(true);
      setMessage("Unsaved decisions. Cancel? y/N");
      return;
    }

    setScreen("list");
    setOpened(undefined);
    setMessage("Cancelled.");
  }

  function acceptAll(kind: "ours" | "theirs") {
    const model = opened?.model;
    if (!model) {
      return;
    }

    model.chooseAll(kind);
    setRevision(model.revision);
    setMessage(kind === "ours" ? "Accepted Left (ours) for all conflicts." : "Accepted Right (theirs) for all conflicts.");
  }

  useMouseWheel(
    useCallback((delta) => {
      if (delta.dy !== 0) {
        setScrollY((value) => Math.max(0, value + delta.dy));
      }
      if (delta.dx !== 0) {
        setScrollX((value) => Math.max(0, value + delta.dx));
      }
    }, []),
    screen === "merge" && !busy && !confirmQuit
  );

  useInput((input, key) => {
    if (busy) {
      return;
    }

    if (isMouseInput(input)) {
      return;
    }

    if (key.ctrl && input === "c") {
      process.exitCode = 130;
      exit();
      return;
    }

    if (confirmQuit) {
      if (input.toLowerCase() === "y") {
        setConfirmQuit(false);
        setOpened(undefined);
        setScreen("list");
        setMessage("Cancelled.");
      } else {
        setConfirmQuit(false);
        setMessage("Cancel aborted.");
      }
      return;
    }

    if (screen === "help") {
      setScreen(opened ? "merge" : "list");
      return;
    }

    if (input === "?") {
      setScreen("help");
      return;
    }

    if (screen === "done") {
      if (input === "q" || key.return) {
        exit();
      }
      return;
    }

    if (screen === "list") {
      if (input === "q") {
        exit();
      } else if (key.upArrow || input === "k") {
        setSelected((value) => Math.max(0, value - 1));
      } else if (key.downArrow || input === "j") {
        setSelected((value) => Math.min(files.length - 1, value + 1));
      } else if (key.return) {
        void openSelected(selectedFile);
      }
      return;
    }

    const model = opened?.model;
    if (!model) {
      return;
    }

    if (input === "q") {
      requestCancel();
    } else if (input === "f") {
      setScreen("list");
    } else if (input === "n") {
      model.goNext();
      setScrollY(0);
      setScrollX(0);
      setRevision(model.revision + model.currentConflictIndex);
    } else if (input === "p") {
      model.goPrevious();
      setScrollY(0);
      setScrollX(0);
      setRevision(model.revision + model.currentConflictIndex);
    } else if (input === "g") {
      model.goFirstUnresolved();
      setScrollY(0);
      setScrollX(0);
      setRevision(model.revision + model.currentConflictIndex);
    } else if (input === "h") {
      model.chooseCurrent("ours");
      setRevision(model.revision);
    } else if (input === "l") {
      model.chooseCurrent("theirs");
      setRevision(model.revision);
    } else if (input === "b") {
      model.chooseCurrent("both");
      setRevision(model.revision);
    } else if (input === "H") {
      acceptAll("ours");
    } else if (input === "L") {
      acceptAll("theirs");
    } else if (input === "u") {
      model.undo();
      setRevision(model.revision);
    } else if (input === "r") {
      model.resetCurrent();
      setRevision(model.revision);
    } else if (input === "s") {
      void save(false);
    } else if (input === "a") {
      void save(true);
    } else if (input === "c") {
      const result = validateBuiltIn(opened.file.path, model.deriveWritableResult());
      setMessage(result.ok ? "Validation passed." : result.issues.map((issue) => issue.message).join("; "));
    } else if (input === "e") {
      const current = model.currentConflict;
      if (current) {
        setBusy(true);
        void editText(conflictDecisionText(current), options.editor)
          .then((text) => {
            model.setManual(current.id, text);
            setRevision(model.revision);
            setMessage("Manual edit applied to current conflict.");
          })
          .catch((error) => setMessage(error instanceof Error ? error.message : String(error)))
          .finally(() => setBusy(false));
      }
    } else if (key.tab) {
      setSide((value) => (value === "ours" ? "theirs" : "ours"));
    }
  });

  const syncScrollBounds = useCallback((nextY: number, nextX: number) => {
    setScrollY((current) => (current === nextY ? current : nextY));
    setScrollX((current) => (current === nextX ? current : nextX));
  }, []);

  if (screen === "help") {
    return <Help message={message} />;
  }

  if (screen === "done") {
    return (
      <Box flexDirection="column">
        <Text color="green">{message}</Text>
        <Text dimColor>Press q to exit.</Text>
      </Box>
    );
  }

  if (screen === "list") {
    return <FileList files={files} selected={selected} message={message} busy={busy} />;
  }

  return (
    <MergeView
      opened={opened}
      columns={stdout.columns ?? 100}
      rows={stdout.rows ?? 24}
      forcedMode={options.mode}
      side={side}
      message={message}
      busy={busy}
      revision={revision}
      scrollY={scrollY}
      scrollX={scrollX}
      onScrollBounds={syncScrollBounds}
    />
  );
}

function FileList({ files, selected, message, busy }: { files: ConflictFile[]; selected: number; message: string; busy: boolean }) {
  return (
    <Box flexDirection="column">
      <Text bold>Mergev conflicts</Text>
      {files.map((file, index) => (
        <Text key={file.path} color={index === selected ? "cyan" : undefined}>
          {index === selected ? ">" : " "} {file.path} {file.supported ? "" : `[unsupported: ${file.reason}]`} {file.isLockfile ? "[lockfile]" : ""}
        </Text>
      ))}
      <Text dimColor>{busy ? "Working..." : "Enter open  j/k move  ? help  q quit"}</Text>
      {message ? <Text color="yellow">{message}</Text> : null}
    </Box>
  );
}

function MergeView({
  opened,
  columns,
  rows,
  forcedMode,
  side,
  message,
  busy,
  revision,
  scrollY,
  scrollX,
  onScrollBounds
}: {
  opened?: OpenedMergeFile;
  columns: number;
  rows: number;
  forcedMode?: CliOptions["mode"];
  side: "ours" | "theirs";
  message: string;
  busy: boolean;
  revision: number;
  scrollY: number;
  scrollX: number;
  onScrollBounds: (scrollY: number, scrollX: number) => void;
}) {
  const model = opened?.model;
  const mode = resolveLayoutMode(columns, forcedMode);
  const innerWidth = resolveShellInnerWidth(columns);
  const panesHeight = resolvePanesHeight(rows);
  const paneCount = mode === "three-pane" ? 3 : mode === "two-pane" ? 2 : 1;
  const visibleRows = resolvePaneContentRows(panesHeight);
  const visibleCols = resolvePaneContentWidth(innerWidth, paneCount);

  const rawPanes = useMemo(() => {
    if (!model) {
      return { ours: "", result: "", theirs: "" };
    }
    return renderPaneText(model);
  }, [model, revision]);

  const contentWidth = Math.max(maxLineWidth(rawPanes.ours), maxLineWidth(rawPanes.result), maxLineWidth(rawPanes.theirs));
  const contentLines = Math.max(
    splitPaneLines(rawPanes.ours).length,
    splitPaneLines(rawPanes.result).length,
    splitPaneLines(rawPanes.theirs).length
  );

  const clampedY = clampScrollY(scrollY, contentLines, visibleRows);
  const clampedX = clampScrollX(scrollX, contentWidth, visibleCols);

  useEffect(() => {
    onScrollBounds(clampedY, clampedX);
  }, [clampedY, clampedX, onScrollBounds]);

  const window = { scrollY: clampedY, scrollX: clampedX, visibleRows, visibleCols };
  const panes = {
    ours: windowPaneText(rawPanes.ours, window),
    result: windowPaneText(rawPanes.result, window),
    theirs: windowPaneText(rawPanes.theirs, window)
  };

  if (!opened || !model) {
    return <Text>Opening...</Text>;
  }

  const title = `Merge Revisions for ${opened.file.path}`;
  const status = `${opened.file.operation}  conflict ${model.currentConflictIndex + 1}/${model.conflicts.length}  unresolved ${model.unresolvedCount()}`;
  const scrollHint = `scroll ${clampedY + 1}-${Math.min(contentLines, clampedY + visibleRows)}/${Math.max(contentLines, 1)}  col ${clampedX + 1}`;

  return (
    <Box
      flexDirection="column"
      width={columns}
      height={rows}
      borderStyle="round"
      borderColor="cyan"
      paddingX={1}
      paddingY={0}
      overflow="hidden"
    >
      <Section width={innerWidth}>
        <Text bold>{title}</Text>
        <Text dimColor>
          {status}  {scrollHint}
        </Text>
        {opened.file.isLockfile ? <Text color="yellow">Lockfile warning: review carefully.</Text> : null}
      </Section>

      <Box width={innerWidth} height={panesHeight} flexShrink={0} overflow="hidden">
        {mode === "three-pane" ? (
          <Box height={panesHeight} width="100%">
            <Pane title="Ours (Left)" text={panes.ours} height={panesHeight} />
            <Pane title="Result" text={panes.result} height={panesHeight} />
            <Pane title="Theirs (Right)" text={panes.theirs} height={panesHeight} />
          </Box>
        ) : mode === "two-pane" ? (
          <Box height={panesHeight} width="100%">
            <Pane title="Result" text={panes.result} height={panesHeight} />
            <Pane
              title={side === "ours" ? "Ours (Left)" : "Theirs (Right)"}
              text={side === "ours" ? panes.ours : panes.theirs}
              height={panesHeight}
            />
          </Box>
        ) : (
          <Pane title="Result" text={panes.result} height={panesHeight} />
        )}
      </Box>

      <Section width={innerWidth}>
        <Box justifyContent="space-between">
          <Text>
            <Text inverse color="cyan">
              {" H "}
            </Text>
            <Text> Accept Left </Text>
            <Text inverse color="cyan">
              {" L "}
            </Text>
            <Text> Accept Right</Text>
          </Text>
          <Text>
            <Text inverse>
              {" q "}
            </Text>
            <Text> Cancel </Text>
            <Text inverse color="green">
              {" s "}
            </Text>
            <Text> Apply</Text>
          </Text>
        </Box>
        <Text dimColor>
          {busy
            ? "Working..."
            : "mouse wheel scroll  shift+wheel pan  h/l/b block  H/L all  n/p nav  e edit  u undo  r reset  ? help"}
        </Text>
        {message ? <Text color="yellow">{message}</Text> : <Text dimColor> </Text>}
      </Section>
    </Box>
  );
}

function Section({
  children,
  width,
  height
}: {
  children: React.ReactNode;
  width: number;
  height?: number;
}) {
  return (
    <Box
      flexDirection="column"
      width={width}
      height={height}
      borderStyle="single"
      borderColor="gray"
      paddingX={1}
      flexShrink={0}
      overflow="hidden"
    >
      {children}
    </Box>
  );
}

function Pane({ title, text, height }: { title: string; text: string; height: number }) {
  return (
    <Box
      flexDirection="column"
      borderStyle="single"
      borderColor="gray"
      paddingX={1}
      flexGrow={1}
      minWidth={20}
      height={height}
      overflow="hidden"
    >
      <Text bold color="cyan">
        {title}
      </Text>
      <Text>{text.trimEnd() || "(empty)"}</Text>
    </Box>
  );
}

function Help({ message }: { message: string }) {
  return (
    <Box flexDirection="column">
      <Text bold>Mergev keys</Text>
      <Text>Mouse wheel: scroll panes vertically</Text>
      <Text>Shift+wheel / horizontal wheel: pan horizontally</Text>
      <Text>n/p next/previous conflict, g first unresolved</Text>
      <Text>h/l/b choose ours/theirs/both for current block</Text>
      <Text>H/L Accept Left/Right for all conflicts</Text>
      <Text>e edit, u undo, r reset</Text>
      <Text>s Apply (save), a save and force add, q Cancel</Text>
      <Text>c validate, f file list</Text>
      <Text dimColor>Press any key to return.</Text>
      {message ? <Text color="yellow">{message}</Text> : null}
    </Box>
  );
}
