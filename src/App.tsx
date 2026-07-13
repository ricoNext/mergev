import { useEffect, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import type { AppView, WorkspaceSnapshot, MergeDocument } from "./types";
import { FirstLaunchDialog } from "./FirstLaunchDialog";
import { RepositoriesScreen } from "./screens/RepositoriesScreen";
import { ConflictsScreen } from "./screens/ConflictsScreen";
import { CombinedScreen } from "./screens/CombinedScreen";
import { MergeScreen } from "./screens/MergeScreen";
import { buildSessionFromDocument, rebuildSession, serializeResult } from "./core/mergeSession";
import { applyAccept, emptyResolution } from "./utils/conflictUtils";
import { fileNameOf } from "./utils/stringUtils";
import { confirm } from "@tauri-apps/plugin-dialog";
import "./App.css";

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
      const repos = await invoke<any[]>("get_recent_repositories");

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
        <p className="eyebrow">mergev</p>
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

export default App;
