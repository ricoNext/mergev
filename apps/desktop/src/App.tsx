import { useEffect, useState, useCallback, useRef } from "react";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import type {
  ActiveRepositoryPayload,
  AppView,
  WorkspaceSnapshot,
  MergeDocument,
  RepositoryItem,
} from "@mergev/merge-ui/types";
import { FirstLaunchDialog } from "./FirstLaunchDialog";
import { RepositoriesScreen } from "./screens/RepositoriesScreen";
import { ConflictsScreen } from "./screens/ConflictsScreen";
import { CombinedScreen } from "./screens/CombinedScreen";
import { EmptyScreen, ErrorScreen, LoadingScreen } from "./screens/StatusScreens";
import { saveAcceptedResolution } from "./mergeActions";
import {
  MergeScreen,
  type MergeScreenRuntime,
} from "@mergev/merge-ui/screens/MergeScreen";
import { buildSessionFromDocument } from "@mergev/merge-ui/core/mergeSession";
import { fileNameOf } from "@mergev/merge-ui/utils/stringUtils";
import { confirm } from "@tauri-apps/plugin-dialog";
import { updateSyntaxTheme } from "@mergev/merge-ui/syntaxHighlight";
import {
  getSavedTheme,
  saveTheme,
  resolveTheme,
  applyThemeToDOM,
  type Theme,
} from "@mergev/merge-ui/theme";
import "@mergev/merge-ui/styles.css";

const desktopMergeRuntime: MergeScreenRuntime = {
  saveMergeResult: async (input) => {
    await invoke("save_merge_result", input);
  },
  confirm,
  subscribeToThemeChanges: (listener) =>
    listen<string>("theme-menu-selected", (event) => {
      listener(event.payload as Theme);
    }),
};

function sortWorkspaceFiles(workspace: WorkspaceSnapshot): WorkspaceSnapshot {
  if (workspace.files.length === 0) {
    return workspace;
  }

  const files = [...workspace.files].sort((a, b) => {
    const nameA = a.fileName || fileNameOf(a.path);
    const nameB = b.fileName || fileNameOf(b.path);
    return nameA.localeCompare(nameB);
  });

  return { ...workspace, files };
}

function firstConflictPath(workspace: WorkspaceSnapshot | null): string | null {
  return workspace?.files.length ? workspace.files[0].path : null;
}

// 侧边栏项目展开状态持久化：重启后恢复上次的展开情况
const EXPANDED_REPOS_KEY = "mergev.expanded-repos";

/** 读取保存的展开列表，并过滤掉已不在仓库列表中的路径（被移除的项目） */
function loadSavedExpandedRepos(repos: RepositoryItem[]): string[] {
  try {
    const raw = localStorage.getItem(EXPANDED_REPOS_KEY);
    if (!raw) {
      return [];
    }
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) {
      return [];
    }
    const known = new Set(repos.map((repo) => repo.path));
    return parsed.filter(
      (path): path is string => typeof path === "string" && known.has(path),
    );
  } catch {
    return [];
  }
}

function saveExpandedRepos(paths: string[]) {
  try {
    localStorage.setItem(EXPANDED_REPOS_KEY, JSON.stringify(paths));
  } catch {
    // localStorage 不可用时静默降级为不持久化
  }
}

function nextRepositoryPathAfterRemoval(
  previousRepos: RepositoryItem[],
  removedPath: string,
  remainingRepos: RepositoryItem[],
): string | null {
  if (remainingRepos.length === 0) {
    return null;
  }

  const removedIndex = previousRepos.findIndex((repo) => repo.path === removedPath);
  const nextIndex =
    removedIndex >= 0 ? Math.min(removedIndex, remainingRepos.length - 1) : 0;

  return remainingRepos[nextIndex]?.path ?? null;
}

function withConflictCount(
  workspace: WorkspaceSnapshot,
  path: string,
  conflictCount: number,
): WorkspaceSnapshot {
  const files = workspace.files.map((file) =>
    file.path === path ? { ...file, conflictCount } : file,
  );
  const knownCounts = files
    .map((file) => file.conflictCount)
    .filter((count): count is number => count !== null);

  return {
    ...workspace,
    files,
    totalBlocks:
      knownCounts.length === files.length
        ? knownCounts.reduce((sum, count) => sum + count, 0)
        : workspace.totalBlocks,
  };
}

function App() {
  const [view, setView] = useState<AppView>({ kind: "loading" });
  const [showFirstLaunchDialog, setShowFirstLaunchDialog] = useState(false);
  const [theme, setTheme] = useState<Theme>("system");

  // 仓库导航请求序号：切换/刷新/移除/新增等异步流程共用。
  // 每次流程开始自增并捕获 id，落地前校验仍是最新请求，
  // 避免先发后到的旧请求用过期状态覆盖较新的仓库视图。
  const repoRequestRef = useRef(0);

  // 应用主题到 DOM
  const applyTheme = useCallback((newTheme: Theme) => {
    const resolved = resolveTheme(newTheme);
    applyThemeToDOM(resolved);
    updateSyntaxTheme(resolved);
    saveTheme(newTheme);
  }, []);

  // 切换主题
  const toggleTheme = useCallback((newTheme: Theme) => {
    setTheme(newTheme);
    applyTheme(newTheme);
  }, [applyTheme]);

  // 初始化主题
  useEffect(() => {
    const savedTheme = getSavedTheme();
    setTheme(savedTheme);
    applyTheme(savedTheme);
  }, [applyTheme]);

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
    const requestId = ++repoRequestRef.current;
    setView({ kind: "loading" });
    try {
      // 判断激活仓库：MERGEV_CWD > 第一个仓库
      let activeRepoPath: string | null = null;
      let activeWorktreePath: string | null = null;
      let expandedRepoPaths: string[] = [];
      const mergev_cwd = await invoke<string | null>("get_mergev_cwd");
      let workspace: WorkspaceSnapshot | null = null;
      let repos: RepositoryItem[] = [];

      if (mergev_cwd) {
        try {
          const activated = await invoke<ActiveRepositoryPayload>("activate_repository", {
            path: mergev_cwd,
          });
          workspace = sortWorkspaceFiles(activated.workspace);
          repos = activated.repos;
          activeRepoPath = workspace.root || mergev_cwd;
          activeWorktreePath = activated.activeWorktreePath || activeRepoPath;
          expandedRepoPaths = activated.expandedRepoPaths || [];
        } catch (error) {
          console.error("Failed to load repository:", error);
          workspace = null;
          activeRepoPath = null;
          activeWorktreePath = null;
        }
      }

      // 如果没有 MERGEV_CWD，使用最近打开的仓库
      if (!activeRepoPath) {
        repos = await invoke<RepositoryItem[]>("get_recent_repositories");
      }

      if (!activeRepoPath && repos.length > 0) {
        activeRepoPath = repos[0].path;
        try {
          const activated = await invoke<ActiveRepositoryPayload>("activate_repository", {
            path: activeRepoPath,
          });
          workspace = sortWorkspaceFiles(activated.workspace);
          repos = activated.repos;
          activeRepoPath = workspace.root || activeRepoPath;
          activeWorktreePath = activated.activeWorktreePath || activeRepoPath;
          expandedRepoPaths = activated.expandedRepoPaths || [];
        } catch (error) {
          console.error("Failed to load repository:", error);
          workspace = null;
        }
      }

      const selectedFilePath = firstConflictPath(workspace);

      // 恢复上次会话的展开状态；与后端提示合并（CLI 启动仍自动展开激活仓库）
      expandedRepoPaths = Array.from(
        new Set([...loadSavedExpandedRepos(repos), ...expandedRepoPaths]),
      );

      if (repoRequestRef.current !== requestId) {
        return;
      }
      setView({
        kind: "combined",
        repos,
        activeRepoPath,
        activeWorktreePath: activeWorktreePath || activeRepoPath,
        expandedRepoPaths,
        workspace,
        selectedFilePath,
        busy: false,
        actionError: null,
      });
      if (workspace && selectedFilePath) {
        void loadConflictCount(selectedFilePath, workspace.root);
      }
    } catch (error) {
      if (repoRequestRef.current !== requestId) {
        return;
      }
      setView({
        kind: "error",
        message: error instanceof Error ? error.message : String(error),
      });
    }
  }

  async function refreshActiveRepository(preferredPath?: string) {
    const requestId = ++repoRequestRef.current;
    try {
      const refreshed = await invoke<ActiveRepositoryPayload>(
        "refresh_active_repository",
      );
      const workspace = sortWorkspaceFiles(refreshed.workspace);
      const selectedFilePath =
        preferredPath &&
        workspace.files.some((file) => file.path === preferredPath)
          ? preferredPath
          : firstConflictPath(workspace);

      if (repoRequestRef.current !== requestId) {
        return;
      }

      setView({
        kind: "combined",
        repos: refreshed.repos,
        activeRepoPath: workspace.root,
        activeWorktreePath: workspace.root,
        expandedRepoPaths: [],
        workspace,
        selectedFilePath,
        busy: false,
        actionError: null,
      });

      if (selectedFilePath) {
        void loadConflictCount(selectedFilePath, workspace.root);
      }
    } catch (error) {
      if (repoRequestRef.current !== requestId) {
        return;
      }
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

    const previousView = view.kind === "combined" ? view : null;
    const removedActive =
      previousView?.activeRepoPath === repoPath ||
      previousView?.workspace?.root === repoPath;

    // 只有删的是当前激活仓库才会换 workspace，此时才竞争“激活意图”；
    // 删无关仓库只更新列表，不占用序号，避免误伤同时进行的切仓库。
    const requestId = removedActive ? ++repoRequestRef.current : null;
    const isCurrent = () =>
      requestId === null || repoRequestRef.current === requestId;

    if (previousView) {
      setView((current) =>
        current.kind === "combined"
          ? { ...current, busy: true, actionError: null }
          : current,
      );
    }

    try {
      await invoke("remove_repository", { path: repoPath });
      const repos = await invoke<RepositoryItem[]>("get_recent_repositories");

      if (!removedActive) {
        // 纯列表更新：不 gate，删除结果必须落地
        setView((current) => {
          if (current.kind !== "combined") {
            return current;
          }

          return {
            ...current,
            repos,
            busy: false,
            actionError: null,
          };
        });
        return;
      }

      const nextRepoPath = nextRepositoryPathAfterRemoval(
        previousView?.repos ?? [],
        repoPath,
        repos,
      );

      if (!nextRepoPath) {
        setView((current) => {
          if (current.kind !== "combined" || !isCurrent()) {
            return current;
          }

          return {
            ...current,
            repos,
            activeRepoPath: null,
            activeWorktreePath: null,
            expandedRepoPaths: [],
            workspace: null,
            selectedFilePath: null,
            busy: false,
            actionError: null,
          };
        });
        return;
      }

      try {
        const activated = await invoke<ActiveRepositoryPayload>("activate_repository", {
          path: nextRepoPath,
        });
        const workspace = sortWorkspaceFiles(activated.workspace);
        const selectedFilePath = firstConflictPath(workspace);

        if (!isCurrent()) {
          return;
        }
        setView((current) => {
          if (current.kind !== "combined" || !isCurrent()) {
            return current;
          }

          return {
            ...current,
            repos: activated.repos,
            activeRepoPath: workspace.root || nextRepoPath,
            activeWorktreePath: workspace.root || nextRepoPath,
            expandedRepoPaths: loadSavedExpandedRepos(activated.repos),
            workspace,
            selectedFilePath,
            busy: false,
            actionError: null,
          };
        });

        if (selectedFilePath) {
          void loadConflictCount(selectedFilePath, workspace.root);
        }
      } catch (activationError) {
        console.error("Failed to activate next repository:", activationError);
        setView((current) => {
          if (current.kind !== "combined" || !isCurrent()) {
            return current;
          }

          return {
            ...current,
            repos,
            activeRepoPath: null,
            activeWorktreePath: null,
            expandedRepoPaths: [],
            workspace: null,
            selectedFilePath: null,
            busy: false,
            actionError:
              activationError instanceof Error
                ? activationError.message
                : String(activationError),
          };
        });
      }
    } catch (error) {
      console.error("Failed to remove repository:", error);
      setView((current) => {
        if (current.kind !== "combined" || !isCurrent()) {
          return current;
        }

        return {
          ...current,
          busy: false,
          actionError: error instanceof Error ? error.message : String(error),
        };
      });
    }
  }

  async function addRepository() {
    try {
      // 动态导入对话框插件
      const dialogModule = await import("@tauri-apps/plugin-dialog");
      const selected = await dialogModule.open({
        directory: true,
        multiple: false,
        title: "选择 Git 仓库目录",
      });

      if (!selected || Array.isArray(selected)) {
        return;
      }

      const path = selected;
      const requestId = ++repoRequestRef.current;

      try {
        const activated = await invoke<ActiveRepositoryPayload>("activate_repository", {
          path,
        });
        if (repoRequestRef.current !== requestId) {
          return;
        }
        const workspace = sortWorkspaceFiles(activated.workspace);
        setView({
          kind: "combined",
          repos: activated.repos,
          activeRepoPath: workspace.root || path,
          activeWorktreePath: workspace.root || path,
          expandedRepoPaths: [],
          workspace,
          selectedFilePath: firstConflictPath(workspace),
          busy: false,
          actionError: null,
        });
        const selectedFilePath = firstConflictPath(workspace);
        if (selectedFilePath) {
          void loadConflictCount(selectedFilePath, workspace.root);
        }
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

  async function loadConflictCount(path: string, workspaceRoot: string) {
    try {
      const conflictCount = await invoke<number>("get_conflict_count", {
        repoRoot: workspaceRoot,
        path,
      });
      setView((current) => {
        if (
          current.kind === "combined" &&
          current.workspace?.root === workspaceRoot
        ) {
          return {
            ...current,
            workspace: withConflictCount(current.workspace, path, conflictCount),
          };
        }

        if (
          current.kind === "conflicts" &&
          current.workspace.root === workspaceRoot
        ) {
          return {
            ...current,
            workspace: withConflictCount(current.workspace, path, conflictCount),
          };
        }

        if (
          current.kind === "merge" &&
          current.workspace.root === workspaceRoot
        ) {
          return {
            ...current,
            workspace: withConflictCount(current.workspace, path, conflictCount),
          };
        }

        return current;
      });
    } catch (error) {
      console.error("Failed to load conflict count:", error);
    }
  }

  function selectCombinedFile(path: string) {
    if (view.kind !== "combined") {
      return;
    }

    setView({ ...view, selectedFilePath: path, actionError: null });
    if (view.workspace) {
      void loadConflictCount(path, view.workspace.root);
    }
  }

  function toggleRepoExpanded(repoPath: string) {
    if (view.kind !== "combined") {
      return;
    }

    const expanded = view.expandedRepoPaths;
    const isExpanded = expanded.includes(repoPath);
    const newExpanded = isExpanded
      ? expanded.filter((p) => p !== repoPath)
      : [...expanded, repoPath];

    saveExpandedRepos(newExpanded);
    setView({ ...view, expandedRepoPaths: newExpanded });
  }

  function selectConflictFile(path: string) {
    if (view.kind !== "conflicts") {
      return;
    }

    setView({ ...view, selectedPath: path, actionError: null });
    void loadConflictCount(path, view.workspace.root);
  }

  async function loadConflicts(preferredPath?: string) {
    setView({ kind: "loading" });
    try {
      const workspace = await invoke<WorkspaceSnapshot>("get_workspace");
      if (workspace.files.length === 0) {
        setView({ kind: "empty", workspace });
        return;
      }

      const sortedWorkspace = sortWorkspaceFiles(workspace);

      const selectedPath =
        preferredPath &&
        sortedWorkspace.files.some((file) => file.path === preferredPath)
          ? preferredPath
          : sortedWorkspace.files[0].path;

      setView({
        kind: "conflicts",
        workspace: sortedWorkspace,
        selectedPath,
        busy: false,
        actionError: null,
      });
      void loadConflictCount(selectedPath, sortedWorkspace.root);
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

    const requestId = ++repoRequestRef.current;
    setView((current) =>
      current.kind === "combined"
        ? { ...current, activeRepoPath: repoPath, activeWorktreePath: repoPath, busy: true, actionError: null }
        : current,
    );

    try {
      const activated = await invoke<ActiveRepositoryPayload>("activate_repository", {
        path: repoPath,
      });
      if (repoRequestRef.current !== requestId) {
        return;
      }
      const workspace = sortWorkspaceFiles(activated.workspace);
      const selectedFilePath = firstConflictPath(workspace);
      const activeRepoPath = workspace.root || repoPath;
      const activeWorktreePath = activated.activeWorktreePath || activeRepoPath;

      setView((current) =>
        current.kind === "combined"
          ? {
              ...current,
              repos: activated.repos,
              activeRepoPath,
              activeWorktreePath,
              // 后端仅在需要自动展开时返回（如激活 linked worktree）；
              // 未指定时保留当前展开状态，避免切到主分支时折叠整个项目组
              expandedRepoPaths:
                activated.expandedRepoPaths ?? current.expandedRepoPaths,
              workspace,
              selectedFilePath,
              busy: false,
              actionError: null,
            }
          : current,
      );
      if (selectedFilePath) {
        void loadConflictCount(selectedFilePath, workspace.root);
      }
    } catch (error) {
      if (repoRequestRef.current !== requestId) {
        return;
      }
      setView((current) =>
        current.kind === "combined"
          ? {
              ...current,
              busy: false,
              actionError: error instanceof Error ? error.message : String(error),
            }
          : current,
      );
    }
  }

  async function openRepository(repoPath: string) {
    const requestId = ++repoRequestRef.current;
    setView({ kind: "loading" });
    try {
      const activated = await invoke<ActiveRepositoryPayload>("activate_repository", {
        path: repoPath,
      });
      if (repoRequestRef.current !== requestId) {
        return;
      }
      const workspace = sortWorkspaceFiles(activated.workspace);
      const selectedFilePath = firstConflictPath(workspace);
      setView({
        kind: "combined",
        repos: activated.repos,
        activeRepoPath: workspace.root || repoPath,
        activeWorktreePath: workspace.root || repoPath,
        expandedRepoPaths: loadSavedExpandedRepos(activated.repos),
        workspace,
        selectedFilePath,
        busy: false,
        actionError: null,
      });
      if (selectedFilePath) {
        void loadConflictCount(selectedFilePath, workspace.root);
      }
    } catch (error) {
      if (repoRequestRef.current !== requestId) {
        return;
      }
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
        repoRoot: workspace.root,
      });
      const workspaceWithCount = withConflictCount(
        workspace,
        path,
        document.unresolvedCount,
      );
      setView({
        kind: "merge",
        workspace: workspaceWithCount,
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

  // 整文件采纳单侧：combined 视图入口（保存后刷新工作区）
  async function acceptSideInCombined(side: "ours" | "theirs") {
    if (view.kind !== "combined" || !view.workspace || !view.selectedFilePath) {
      return;
    }
    const repoRoot = view.workspace.root;
    const path = view.selectedFilePath;
    setView({ ...view, busy: true, actionError: null });
    try {
      await saveAcceptedResolution(side, path, repoRoot);
      await refreshActiveRepository(path);
    } catch (error) {
      setView({
        ...view,
        busy: false,
        actionError: error instanceof Error ? error.message : String(error),
      });
    }
  }

  // 整文件采纳单侧：conflicts 视图入口（保存后刷新冲突列表）
  async function acceptSideInConflicts(side: "ours" | "theirs") {
    if (view.kind !== "conflicts") {
      return;
    }
    const repoRoot = view.workspace.root;
    const path = view.selectedPath;
    setView({ ...view, busy: true, actionError: null });
    try {
      await saveAcceptedResolution(side, path, repoRoot);
      await loadConflicts();
    } catch (error) {
      setView({
        ...view,
        busy: false,
        actionError: error instanceof Error ? error.message : String(error),
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
    return <LoadingScreen />;
  }

  if (view.kind === "error") {
    return (
      <ErrorScreen
        message={view.message}
        onRetry={() => void loadConflicts()}
      />
    );
  }

  if (view.kind === "repositories") {
    return (
      <RepositoriesScreen
        view={view}
        onOpenRepository={(path) => void openRepository(path)}
        onClose={() => void invoke("close_app")}
      />
    );
  }

  if (view.kind === "empty") {
    return (
      <EmptyScreen
        workspace={view.workspace}
        onRefresh={() => void loadConflicts()}
      />
    );
  }

  if (view.kind === "combined") {
    return (
      <CombinedScreen
        view={view}
        theme={theme}
        onToggleTheme={toggleTheme}
        onSwitchRepository={(path) => void switchRepository(path)}
        onToggleExpanded={toggleRepoExpanded}
        onSelect={selectCombinedFile}
        onRemoveRepository={(path) => void removeRepository(path)}
        onAddRepository={() => void addRepository()}
        onAccept={(side) => acceptSideInCombined(side)}
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
        onSelect={selectConflictFile}
        onRefresh={() => void loadConflicts(view.selectedPath)}
        onAccept={(side) => acceptSideInConflicts(side)}
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
          void refreshActiveRepository(view.selectedPath);
        }
      }}
      onChangeView={setView}
      onSaved={() => void refreshActiveRepository(view.selectedPath)}
      runtime={desktopMergeRuntime}
    />
  );
}

export default App;
