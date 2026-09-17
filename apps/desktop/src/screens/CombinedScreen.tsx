import { useEffect, useRef, useState } from "react";
import type { PointerEvent as ReactPointerEvent } from "react";
import { invoke } from "@tauri-apps/api/core";
import type { AppView, WorktreeItem, WorktreeStatus } from "@mergev/merge-ui/types";
import type { Theme } from "@mergev/merge-ui/theme";
import { GitBranchIcon } from "../components/GitBranchIcon";
import { StatusCell } from "../components/StatusCell";
import { fileNameOf, dirOf } from "@mergev/merge-ui/utils/stringUtils";
import { listen } from "@tauri-apps/api/event";
import { confirm, open } from "@tauri-apps/plugin-dialog";
import { useHomeDir } from "../hooks/useHomeDir";
import { TerminalPane } from "./TerminalPane";

export function CombinedScreen({
  view,
  theme,
  onToggleTheme,
  onSwitchRepository,
  onToggleExpanded,
  onSelect,
  onRemoveRepository,
  onAddRepository,
  onAccept,
  onMerge,
  onOpenPath,
  onClose: _onClose,
}: {
  view: Extract<AppView, { kind: "combined" }>;
  theme: Theme;
  onToggleTheme: (theme: Theme) => void;
  onSwitchRepository: (path: string) => void;
  onToggleExpanded: (path: string) => void;
  onSelect: (path: string) => void;
  onRemoveRepository: (path: string) => void;
  onAddRepository: () => void;
  onAccept: (side: "ours" | "theirs") => Promise<void>;
  onMerge: () => void;
  onOpenPath: (path: string) => void;
  onClose: () => void;
}) {
  const { repos, activeRepoPath, activeWorktreePath, expandedRepoPaths, workspace, selectedFilePath, busy, actionError } = view;
  const selectedFile = workspace?.files.find((f) => f.path === selectedFilePath);
  // 当前激活的分支路径：主分支 = 主仓库路径，linked = worktree 路径
  const activePath = activeWorktreePath ?? activeRepoPath;
  // 激活分支存在冲突文件时，右侧冲突面板固定占 50%，中间面板吃剩余空间
  const hasActiveConflicts = (workspace?.files.length ?? 0) > 0;
  const [menuOpen, setMenuOpen] = useState<string | null>(null);
  const [worktreeMenu, setWorktreeMenu] = useState<{ repoPath: string; path: string; isMain: boolean; x: number; y: number } | null>(null);
  const [worktreesCache, setWorktreesCache] = useState<Record<string, WorktreeItem[]>>({});
  // 弹窗：记录「新建 worktree」弹窗针对哪个项目，内容暂留空待后续实现
  const [addModalRepo, setAddModalRepo] = useState<string | null>(null);
  // 已失效（分支被删/worktree 目录不存在）的 worktree 路径，渲染时过滤掉
  const [staleWorktrees, setStaleWorktrees] = useState<Set<string>>(new Set());
  // 中间面板 tabs：每个分支（worktree 路径）独立管理自己的 tab 组，
  // 激活某分支时中间区域只展示该分支的 tabs；每个分支至少保留一个 tab
  const [tabsByPath, setTabsByPath] = useState<
    Record<
      string,
      { repoPath: string; tabs: { id: string; title: string }[]; activeTabId: string }
    >
  >({});
  const tabSeqRef = useRef(0);
  // tab 右键菜单：批量关闭操作（关闭/关闭其他/关闭左侧/关闭右侧）
  const [tabMenu, setTabMenu] = useState<{ tabId: string; x: number; y: number } | null>(null);
  // 「新建 worktree」表单：基点分支 / 分支名 / 存放地址，三者均必填
  const homeDir = useHomeDir();
  const [branches, setBranches] = useState<string[]>([]);
  const [baseBranch, setBaseBranch] = useState("");
  const [branchName, setBranchName] = useState("");
  const [storageDir, setStorageDir] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [formError, setFormError] = useState<string | null>(null);
  // 左侧栏 / 中间面板宽度（占窗口宽度百分比）：均可拖拽分隔条调整，
  // 持久化到 localStorage；默认比例 左 20% / 中 60% / 右 20%（右为剩余弹性区）
  const SIDEBAR_PCT_KEY = "mergev.sidebar-pct";
  const SIDEBAR_DEFAULT_PCT = 20;
  const SIDEBAR_MIN_PCT = 5;
  const SIDEBAR_MAX_PCT = 40;
  const MIDDLE_PCT_KEY = "mergev.middle-pct";
  const MIDDLE_DEFAULT_PCT = 60;
  const MIDDLE_MIN_PCT = 20;
  const MIDDLE_MAX_PCT = 85;
  const [sidebarPct, setSidebarPct] = useState(() => {
    const stored = Number(localStorage.getItem(SIDEBAR_PCT_KEY));
    if (Number.isFinite(stored) && stored >= SIDEBAR_MIN_PCT && stored <= SIDEBAR_MAX_PCT) {
      return stored;
    }
    return SIDEBAR_DEFAULT_PCT;
  });
  // 中间面板当前为预留占位
  const [middlePct, setMiddlePct] = useState(() => {
    const stored = Number(localStorage.getItem(MIDDLE_PCT_KEY));
    if (Number.isFinite(stored) && stored >= MIDDLE_MIN_PCT && stored <= MIDDLE_MAX_PCT) {
      return stored;
    }
    return MIDDLE_DEFAULT_PCT;
  });
  const [resizingPanel, setResizingPanel] = useState<"sidebar" | "middle" | null>(null);
  // 有冲突模式下右侧冲突面板宽度（独立持久化，不影响无冲突布局），默认 50%
  const CONFLICT_RIGHT_PCT_KEY = "mergev.conflict-right-pct";
  const CONFLICT_RIGHT_DEFAULT_PCT = 50;
  const CONFLICT_RIGHT_MIN_PCT = 20;
  const CONFLICT_RIGHT_MAX_PCT = 70;
  const [conflictRightPct, setConflictRightPct] = useState(() => {
    const stored = Number(localStorage.getItem(CONFLICT_RIGHT_PCT_KEY));
    if (Number.isFinite(stored) && stored >= CONFLICT_RIGHT_MIN_PCT && stored <= CONFLICT_RIGHT_MAX_PCT) {
      return stored;
    }
    return CONFLICT_RIGHT_DEFAULT_PCT;
  });

  useEffect(() => {
    const handleClick = () => {
      setMenuOpen(null);
      setWorktreeMenu(null);
      setTabMenu(null);
    };
    if (menuOpen || worktreeMenu || tabMenu) {
      window.addEventListener("click", handleClick);
      return () => window.removeEventListener("click", handleClick);
    }
  }, [menuOpen, worktreeMenu, tabMenu]);

  // 拖拽分隔条调整左侧栏 / 中间面板宽度（按窗口宽度换算百分比）：
  // pointerdown 后全局监听移动/抬起，拖拽中给容器加 is-resizing 类禁用文本选中
  function startPanelResize(
    e: ReactPointerEvent<HTMLDivElement>,
    target: "sidebar" | "middle",
  ) {
    e.preventDefault();
    setResizingPanel(target);
    const startX = e.clientX;
    // 有冲突模式：中间自适应、右侧 = conflictRightPct，拖中间分隔条改为反向调右侧宽度
    const startPct =
      target === "sidebar"
        ? sidebarPct
        : hasActiveConflicts
          ? conflictRightPct
          : middlePct;
    const minPct =
      target === "sidebar"
        ? SIDEBAR_MIN_PCT
        : hasActiveConflicts
          ? CONFLICT_RIGHT_MIN_PCT
          : MIDDLE_MIN_PCT;
    const maxPct =
      target === "sidebar"
        ? SIDEBAR_MAX_PCT
        : hasActiveConflicts
          ? CONFLICT_RIGHT_MAX_PCT
          : MIDDLE_MAX_PCT;

    const handleMove = (moveEvent: PointerEvent) => {
      const deltaPct = ((moveEvent.clientX - startX) / window.innerWidth) * 100;
      if (target === "sidebar") {
        setSidebarPct(Math.min(maxPct, Math.max(minPct, startPct + deltaPct)));
      } else if (hasActiveConflicts) {
        // 分隔条右移 → 右侧变窄，方向取反
        setConflictRightPct(Math.min(maxPct, Math.max(minPct, startPct - deltaPct)));
      } else {
        setMiddlePct(Math.min(maxPct, Math.max(minPct, startPct + deltaPct)));
      }
    };
    const handleUp = () => {
      setResizingPanel(null);
      window.removeEventListener("pointermove", handleMove);
      window.removeEventListener("pointerup", handleUp);
    };
    window.addEventListener("pointermove", handleMove);
    window.addEventListener("pointerup", handleUp);
  }

  // 宽度变化时持久化（拖拽过程中由 pointerup 收尾后统一触发）
  useEffect(() => {
    if (!resizingPanel) {
      localStorage.setItem(SIDEBAR_PCT_KEY, String(sidebarPct));
      localStorage.setItem(MIDDLE_PCT_KEY, String(middlePct));
      localStorage.setItem(CONFLICT_RIGHT_PCT_KEY, String(conflictRightPct));
    }
  }, [sidebarPct, middlePct, conflictRightPct, resizingPanel]);

  // 激活当前分支组内的某个 tab（纯 UI 状态，内容暂为占位）
  function activateTab(tabId: string) {
    if (!activePath) {
      return;
    }
    setTabsByPath((prev) => {
      const group = prev[activePath];
      if (!group || group.activeTabId === tabId) {
        return prev;
      }
      return { ...prev, [activePath]: { ...group, activeTabId: tabId } };
    });
  }

  // 关闭当前分支组内的一个 tab；每个分支至少保留一个 tab，
  // 关闭激活项时自动激活相邻 tab
  function closeTab(tabId: string) {
    if (!activePath) {
      return;
    }
    setTabsByPath((prev) => {
      const group = prev[activePath];
      if (!group || group.tabs.length <= 1) {
        return prev;
      }
      const idx = group.tabs.findIndex((tab) => tab.id === tabId);
      if (idx === -1) {
        return prev;
      }
      const nextTabs = group.tabs.filter((tab) => tab.id !== tabId);
      const activeTabId =
        group.activeTabId === tabId
          ? nextTabs[Math.min(idx, nextTabs.length - 1)].id
          : group.activeTabId;
      return { ...prev, [activePath]: { ...group, tabs: nextTabs, activeTabId } };
    });
  }

  // 在当前分支的 tab 组末尾新建一个 tab 并激活
  function addTab() {
    if (!activePath) {
      return;
    }
    setTabsByPath((prev) => {
      const group = prev[activePath];
      if (!group) {
        return prev;
      }
      tabSeqRef.current += 1;
      const id = `tab-${tabSeqRef.current}`;
      return {
        ...prev,
        [activePath]: {
          ...group,
          tabs: [...group.tabs, { id, title: `终端 ${group.tabs.length + 1}` }],
          activeTabId: id,
        },
      };
    });
  }

  // 批量关闭：others=关闭其他，left=关闭左侧，right=关闭右侧；
  // 点击的 tab 始终保留，若激活 tab 被关闭则激活点击的 tab
  function closeTabsBatch(tabId: string, scope: "others" | "left" | "right") {
    if (!activePath) {
      return;
    }
    setTabsByPath((prev) => {
      const group = prev[activePath];
      if (!group) {
        return prev;
      }
      const idx = group.tabs.findIndex((tab) => tab.id === tabId);
      if (idx === -1) {
        return prev;
      }
      const kept =
        scope === "others"
          ? [group.tabs[idx]]
          : scope === "left"
            ? group.tabs.slice(idx)
            : group.tabs.slice(0, idx + 1);
      const activeTabId = kept.some((tab) => tab.id === group.activeTabId)
        ? group.activeTabId
        : tabId;
      return { ...prev, [activePath]: { ...group, tabs: kept, activeTabId } };
    });
  }

  // 清理分支的 tab 组：入参可以是分支路径（分支失效/删除 worktree）
  // 或主仓库路径（移除项目时，其所有分支的 tab 组一并清理）
  function pruneBranchTabs(doomedPaths: string[]) {
    const doomed = new Set(doomedPaths);
    setTabsByPath((prev) => {
      const next: typeof prev = {};
      for (const [path, group] of Object.entries(prev)) {
        if (!doomed.has(path) && !doomed.has(group.repoPath)) {
          next[path] = group;
        }
      }
      return next;
    });
  }

  // 点击分支行：先校验 worktree/分支仍然存在，
  // 已失效则提示并从列表中移除，有效才切换仓库
  async function handleWorktreeClick(repoPath: string, worktree: WorktreeItem) {
    let stale = false;
    try {
      const status = await invoke<WorktreeStatus>("worktree_status", {
        worktreePath: worktree.path,
      });
      // worktree 目录还在但分支被删除时，git 会进入 detached HEAD（branch 为空）
      stale = Boolean(worktree.branch) && !status.branch;
    } catch {
      // worktree_status 失败：目录已不存在或 git 无法访问
      stale = true;
    }

    if (!stale) {
      onSwitchRepository(worktree.path);
      return;
    }

    const ok = await confirm(
      `分支 ${worktree.branch ?? "（未知分支）"} 已不存在（可能已被删除，或对应的 worktree 目录已不存在）。\n是否从列表中移除该记录？`,
      {
        title: "分支已删除",
        kind: "warning",
        okLabel: "移除",
        cancelLabel: "保留",
      },
    );
    if (!ok) {
      return;
    }

    setStaleWorktrees((prev) => new Set(prev).add(worktree.path));
    // 对应分支的 tab 组一并清理
    pruneBranchTabs([worktree.path]);
    // 使缓存失效，副作用 effect 会重新拉取最新的 worktree 列表
    setWorktreesCache((prev) => {
      const next = { ...prev };
      delete next[repoPath];
      return next;
    });
    // 删除的是当前激活的 worktree 时，切回主仓库
    if (worktree.path === activeWorktreePath) {
      onSwitchRepository(repoPath);
    }
  }

  // 删除 worktree：先检查分支状态，再按结果弹出确认，最后执行删除并刷新列表
  async function handleRemoveWorktree(repoPath: string, worktreePath: string) {
    setWorktreeMenu(null);
    try {
      const status = await invoke<WorktreeStatus>("worktree_status", {
        worktreePath,
      });

      const warnings: string[] = [];
      if (status.uncommittedChanges > 0) {
        warnings.push(`有 ${status.uncommittedChanges} 个未提交的修改`);
      }
      if (status.unmergedCommits && status.unmergedCommits > 0) {
        warnings.push(
          `分支 ${status.branch ?? "HEAD"} 上有 ${status.unmergedCommits} 个未合并的提交`,
        );
      }

      const message = warnings.length
        ? `该 worktree ${warnings.join("，")}。\n删除后这些改动将无法恢复，确定要删除吗？`
        : "该 worktree 工作区是干净的，分支状态正常。\n确定要删除吗？（分支本身不会被删除）";

      const ok = await confirm(message, {
        title: "删除 worktree",
        kind: "warning",
        okLabel: "删除",
        cancelLabel: "取消",
      });
      if (!ok) {
        return;
      }

      // 工作区不干净时 git worktree remove 需要 --force
      const force = status.uncommittedChanges > 0;
      await invoke("remove_worktree", { repoRoot: repoPath, worktreePath, force });

      // 使缓存失效，副作用effect会重新拉取最新的 worktree 列表
      setWorktreesCache((prev) => {
        const next = { ...prev };
        delete next[repoPath];
        return next;
      });
      // 该 worktree 的 tab 组一并清理
      pruneBranchTabs([worktreePath]);

      // 删除的是当前激活的 worktree 时，切回主仓库
      if (worktreePath === activeWorktreePath) {
        onSwitchRepository(repoPath);
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      await confirm(message, {
        title: "删除 worktree 失败",
        kind: "error",
        okLabel: "确定",
        cancelLabel: "",
      });
    }
  }

  // 创建 worktree：基于所选分支 + 分支名 + 存放地址（三者必填）；
  // 失败时在弹窗内提示，成功后关闭弹窗、刷新列表并切换到新 worktree
  async function submitCreateWorktree() {
    if (!addModalRepo || submitting) {
      return;
    }
    const branch = branchName.trim();
    const dir = storageDir.trim();
    if (!baseBranch || !branch || !dir) {
      setFormError("请填写完整：基点分支、分支名和存放地址均为必填项");
      return;
    }
    if (branch.startsWith("-") || branch.includes("..") || /\s/.test(branch)) {
      setFormError(`无效的分支名: ${branch}`);
      return;
    }
    setFormError(null);
    setSubmitting(true);
    try {
      const created = await invoke<{ path: string }>("add_worktree", {
        repoRoot: addModalRepo,
        branch,
        base: baseBranch,
        parentDir: dir,
      });
      setAddModalRepo(null);
      // 使缓存失效，副作用 effect 会重新拉取最新的 worktree 列表
      setWorktreesCache((prev) => {
        const next = { ...prev };
        delete next[addModalRepo];
        return next;
      });
      onSwitchRepository(created.path);
    } catch (error) {
      setFormError(error instanceof Error ? error.message : String(error));
    } finally {
      setSubmitting(false);
    }
  }

  // 手动刷新指定仓库的 worktree 状态：强制重新拉取列表并清除失效误标记；
  // 与 effect 的懒加载不同，这里无论是否展开都直接请求
  async function refreshRepoWorktrees(repoPath: string) {
    try {
      const worktrees = await invoke<WorktreeItem[]>("list_worktrees", {
        path: repoPath,
      });
      // git 实际返回的 worktree 不是失效的，清掉误标记
      setStaleWorktrees((prev) => {
        const next = new Set(prev);
        for (const worktree of worktrees) {
          next.delete(worktree.path);
        }
        return next;
      });
      setWorktreesCache((prev) => ({ ...prev, [repoPath]: worktrees }));
    } catch (error) {
      console.error("Failed to refresh worktrees for", repoPath, error);
    }
  }

  // Load worktrees for expanded repos
  useEffect(() => {
    async function loadWorktrees() {
      for (const repoPath of expandedRepoPaths) {
        if (!worktreesCache[repoPath]) {
          try {
            const worktrees = await invoke<WorktreeItem[]>("list_worktrees", {
              path: repoPath,
            });
            // git 实际返回的 worktree 不是失效的，清掉误标记
            setStaleWorktrees((prev) => {
              const next = new Set(prev);
              for (const worktree of worktrees) {
                next.delete(worktree.path);
              }
              return next;
            });
            setWorktreesCache((prev) => ({ ...prev, [repoPath]: worktrees }));
          } catch (error) {
            console.error("Failed to load worktrees for", repoPath, error);
          }
        }
      }
    }
    void loadWorktrees();
  }, [expandedRepoPaths, worktreesCache]);

  // 激活某个分支时，自动保证该分支有自己的 tab 组（至少一个 tab）；
  // 切换分支时中间面板只展示当前分支的 tabs，各组互不影响。
  // 注意：激活 linked worktree 时后端 workspace.root 是 worktree 路径，
  // activeRepoPath 也会随之变成 worktree 路径，因此不能要求
  // activePath 精确等于某个一级项目路径，只需归属到某个项目（本身或其 worktree）即可
  useEffect(() => {
    if (!activePath || !activeRepoPath) {
      return;
    }
    const ownerRepoPath = repos.find(
      (item) =>
        item.path === activePath ||
        worktreesCache[item.path]?.some((w) => w.path === activePath),
    )?.path;
    if (!ownerRepoPath) {
      return;
    }
    setTabsByPath((prev) => {
      if (prev[activePath]) {
        return prev;
      }
      tabSeqRef.current += 1;
      const id = `tab-${tabSeqRef.current}`;
      return {
        ...prev,
        [activePath]: {
          // repoPath 归属到一级项目路径，移除项目时 pruneBranchTabs([repo.path]) 能一并清掉其 worktree 的 tab 组
          repoPath: ownerRepoPath,
          tabs: [{ id, title: "终端" }],
          activeTabId: id,
        },
      };
    });
  }, [activePath, activeRepoPath, repos, worktreesCache]);

  // 监听来自菜单的主题切换事件
  useEffect(() => {
    const unlisten = listen<string>("theme-menu-selected", (event) => {
      const selectedTheme = event.payload as Theme;
      onToggleTheme(selectedTheme);
    });

    return () => {
      unlisten.then((fn) => fn());
    };
  }, [onToggleTheme]);

  return (
    <div className={`combined-view${resizingPanel ? " is-resizing" : ""}`} style={{ gridTemplateColumns: hasActiveConflicts ? `${sidebarPct}% 6px minmax(0, 1fr) 6px ${conflictRightPct}%` : `${sidebarPct}% 6px ${middlePct}% 6px 1fr` }}>
      <aside className="repository-sidebar">
        <header className="sidebar-brand" data-tauri-drag-region>
          {/* data-tauri-drag-region 只认事件 target 自身，内部文字元素必须同样带上，否则点在文字上拖不动 */}
          <span className="sidebar-brand-title" data-tauri-drag-region>mergev</span>
        </header>
        <div className="sidebar-section-header" data-tauri-drag-region>
          <span className="sidebar-section-title" data-tauri-drag-region>项目</span>
          <div className="sidebar-header-actions">
            <button
              type="button"
              className="sidebar-icon-button"
              title="添加项目"
              aria-label="添加项目"
              onClick={onAddRepository}
            >
              <svg width="16" height="16" viewBox="0 0 16 16" aria-hidden="true">
                <path
                  d="M8 3v10M3 8h10"
                  stroke="currentColor"
                  strokeWidth="1.5"
                  strokeLinecap="round"
                  fill="none"
                />
              </svg>
            </button>
          </div>
        </div>
        <div className="repository-list">
          {repos.length === 0 ? (
            <div className="empty-state">
              <p className="muted">暂无历史仓库</p>
            </div>
          ) : (
            repos.map((repo) => {
              const isExpanded = expandedRepoPaths.includes(repo.path);
              // 优先用展开时拉取的最新数据，否则回退到历史记录里持久化的
              // worktree 列表，保证箭头在未展开时也能正确渲染。
              // 列表包含主 worktree（porcelain 输出中排第一），二级按分支展示；
              // 已确认失效（分支被删/目录不存在）的记录被过滤掉。
              const worktrees = (worktreesCache[repo.path] ?? repo.worktrees ?? [])
                .filter((worktree) => !staleWorktrees.has(worktree.path));
              const hasWorktrees = worktrees.length > 0;

              return (
                <div key={repo.path} className="repository-group">
                  <div
                    className="project-row"
                    onClick={() => {
                      if (hasWorktrees) {
                        onToggleExpanded(repo.path);
                      } else {
                        // 没有分支数据可展开时，退回为直接打开该仓库
                        onSwitchRepository(repo.path);
                      }
                    }}
                  >
                    <div className="project-info">
                      <svg
                        className="project-folder-icon"
                        width="16"
                        height="16"
                        viewBox="0 0 16 16"
                        aria-hidden="true"
                      >
                        <path
                          d="M1.75 3.5A1.5 1.5 0 013.25 2h3l1.5 2h5A1.5 1.5 0 0114.25 5.5v7a1.5 1.5 0 01-1.5 1.5h-9.5a1.5 1.5 0 01-1.5-1.5v-9z"
                          stroke="currentColor"
                          strokeWidth="1.25"
                          fill="none"
                          strokeLinejoin="round"
                        />
                      </svg>
                      <span className="project-name">{repo.name}</span>
                    </div>
                    <div className="repository-actions">
                      <button
                        type="button"
                        className={
                          hasWorktrees
                            ? "project-chevron"
                            : "project-chevron is-hidden"
                        }
                        aria-expanded={isExpanded}
                        aria-label={isExpanded ? "折叠项目" : "展开项目"}
                        disabled={!hasWorktrees}
                        onClick={(e) => {
                          e.stopPropagation();
                          onToggleExpanded(repo.path);
                        }}
                      >
                        <svg width="12" height="12" viewBox="0 0 16 16" aria-hidden="true">
                          <path
                            d="M6 3.5L10.5 8L6 12.5"
                            stroke="currentColor"
                            strokeWidth="1.5"
                            strokeLinecap="round"
                            strokeLinejoin="round"
                            fill="none"
                          />
                        </svg>
                      </button>
                      <button
                        type="button"
                        className={
                          menuOpen === repo.path
                            ? "repository-menu-trigger is-open"
                            : "repository-menu-trigger"
                        }
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
                              void refreshRepoWorktrees(repo.path);
                              setMenuOpen(null);
                            }}
                          >
                            刷新
                          </button>
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
                          <button
                            type="button"
                            className="repository-menu-item danger"
                            onClick={(e) => {
                              e.stopPropagation();
                              onRemoveRepository(repo.path);
                              // 该项目所有分支的 tab 组一并清理
                              pruneBranchTabs([repo.path]);
                              setMenuOpen(null);
                            }}
                          >
                            从列表中移除
                          </button>
                        </div>
                      )}
                      <button
                        type="button"
                        className="project-add-button"
                        title="新建 worktree"
                        aria-label="新建 worktree"
                        onClick={(e) => {
                          e.stopPropagation();
                          setMenuOpen(null);
                          // 表单默认值：基点/分支名取主仓库当前分支，存放地址取 ~/.mergev/worktree/
                          setBranches([]);
                          setBaseBranch(repo.branch ?? "");
                          setBranchName(repo.branch ?? "");
                          setStorageDir(homeDir ? `${homeDir}/.mergev/worktree/` : "");
                          setFormError(null);
                          setSubmitting(false);
                          setAddModalRepo(repo.path);
                          void invoke<string[]>("list_local_branches", {
                            repoRoot: repo.path,
                          })
                            .then((list) => {
                              setBranches(list);
                              const current = repo.branch ?? "";
                              if (!current || !list.includes(current)) {
                                const fallback = list[0] ?? "";
                                setBaseBranch(fallback);
                                setBranchName(fallback);
                              }
                            })
                            .catch((error) => {
                              setFormError(
                                error instanceof Error
                                  ? error.message
                                  : String(error),
                              );
                            });
                        }}
                      >
                        <svg width="12" height="12" viewBox="0 0 16 16" aria-hidden="true">
                          <path
                            d="M8 3v10M3 8h10"
                            stroke="currentColor"
                            strokeWidth="1.5"
                            strokeLinecap="round"
                            fill="none"
                          />
                        </svg>
                      </button>
                    </div>
                  </div>

                  {isExpanded &&
                    worktrees.map((worktree) => (
                      <div
                        key={worktree.path}
                        className={
                          worktree.path === activeWorktreePath
                            ? "worktree-item active"
                            : "worktree-item"
                        }
                        onClick={() =>
                          void handleWorktreeClick(repo.path, worktree)
                        }
                        onContextMenu={(e) => {
                          e.preventDefault();
                          e.stopPropagation();
                          setWorktreeMenu({
                            repoPath: repo.path,
                            path: worktree.path,
                            isMain: worktree.isMain,
                            x: e.clientX,
                            y: e.clientY,
                          });
                        }}
                      >
                        <GitBranchIcon />
                        <span className="worktree-branch-name">
                          {worktree.branch ?? "(detached HEAD)"}
                        </span>
                        <span
                          className={
                            worktree.isMain
                              ? "worktree-tag main"
                              : "worktree-tag"
                          }
                        >
                          {worktree.isMain ? "主 worktree" : "Linked"}
                        </span>
                        {worktree.hasConflicts && (
                          <span
                            className="worktree-conflict-indicator"
                            title="有冲突"
                          >
                            ●
                          </span>
                        )}
                      </div>
                    ))}
                </div>
              );
            })
          )}
        </div>
      </aside>

      {/* 分隔条 1：调整左侧项目列表宽度 */}
      <div
        className="sidebar-resizer"
        role="separator"
        aria-orientation="vertical"
        aria-label="调整项目列表宽度"
        onPointerDown={(e) => startPanelResize(e, "sidebar")}
        onDoubleClick={() => setSidebarPct(SIDEBAR_DEFAULT_PCT)}
      />

      {/* 中间面板：每个分支独立管理自己的 tabs，内容暂为预留占位 */}
      <section className="middle-panel">
        {(() => {
          const group = activePath ? tabsByPath[activePath] : undefined;
          if (!group) {
            return (
              <div className="middle-tab-body">
                <div className="empty-state">
                  <p className="muted">预留区域</p>
                  <p className="muted middle-tab-hint">
                    从左侧选择一个项目分支开始
                  </p>
                </div>
              </div>
            );
          }
          return (
            <>
              <div
                className="tab-bar"
                role="tablist"
                aria-label="当前分支的标签页"
                data-tauri-drag-region
              >
                <div className="tab-bar-scroll" data-tauri-drag-region>
                  {group.tabs.map((tab) => {
                  const isActive = tab.id === group.activeTabId;
                  return (
                    <div
                      key={tab.id}
                      role="tab"
                      aria-selected={isActive}
                      className={isActive ? "middle-tab active" : "middle-tab"}
                      onClick={() => activateTab(tab.id)}
                      onContextMenu={(e) => {
                        e.preventDefault();
                        e.stopPropagation();
                        setTabMenu({ tabId: tab.id, x: e.clientX, y: e.clientY });
                      }}
                    >
                      <span className="middle-tab-title">{tab.title}</span>
                      {group.tabs.length > 1 && (
                        <button
                          type="button"
                          className="middle-tab-close"
                          aria-label={`关闭 ${tab.title}`}
                          onClick={(e) => {
                            e.stopPropagation();
                            closeTab(tab.id);
                          }}
                        >
                          <svg
                            width="9"
                            height="9"
                            viewBox="0 0 16 16"
                            aria-hidden="true"
                          >
                            <path
                              d="M4 4l8 8M12 4l-8 8"
                              stroke="currentColor"
                              strokeWidth="2"
                              strokeLinecap="round"
                              fill="none"
                            />
                          </svg>
                        </button>
                      )}
                    </div>
                  );
                })}
                </div>
                <button
                  type="button"
                  className="middle-tab-add"
                  title="新建标签页"
                  aria-label="新建标签页"
                  onClick={addTab}
                >
                  <svg width="12" height="12" viewBox="0 0 16 16" aria-hidden="true">
                    <path
                      d="M8 3v10M3 8h10"
                      stroke="currentColor"
                      strokeWidth="1.5"
                      strokeLinecap="round"
                      fill="none"
                    />
                  </svg>
                </button>
              </div>
              <div className="middle-tab-body">
                {!activePath || !tabsByPath[activePath] ? (
                  <div className="empty-state">
                    <p className="muted">预留区域</p>
                  </div>
                ) : (
                  // 每个分支组各占一层：切分支只切显隐，已打开的终端会话保持常驻
                  Object.entries(tabsByPath).map(([groupPath, grp]) => (
                    <div
                      key={groupPath}
                      className="terminal-layer"
                      data-active={groupPath === activePath ? "true" : "false"}
                    >
                      {grp.tabs.map((tab) => (
                        <TerminalPane
                          key={tab.id}
                          cwd={groupPath}
                          visible={
                            groupPath === activePath &&
                            tab.id === grp.activeTabId
                          }
                          theme={theme}
                        />
                      ))}
                    </div>
                  ))
                )}
              </div>
            </>
          );
        })()}
      </section>

      {/* 分隔条 2：调整中间面板宽度 */}
      <div
        className="sidebar-resizer"
        role="separator"
        aria-orientation="vertical"
        aria-label="调整中间面板宽度"
        onPointerDown={(e) => startPanelResize(e, "middle")}
        onDoubleClick={() => setMiddlePct(MIDDLE_DEFAULT_PCT)}
      />

      <main className="conflict-main">
        {!workspace ? (
          <div className="empty-state" data-tauri-drag-region>
            <p className="muted" data-tauri-drag-region>选择一个仓库查看冲突文件</p>
          </div>
        ) : workspace.files.length === 0 ? (
          <div className="empty-state" data-tauri-drag-region>
            <p className="eyebrow" data-tauri-drag-region>mergev</p>
            <h1 data-tauri-drag-region>
              {workspace.repoName}
              <span className="muted" data-tauri-drag-region> · {workspace.branch}</span>
            </h1>
            <p data-tauri-drag-region>当前没有需要解决的合并冲突。</p>
            <p className="muted" data-tauri-drag-region>
              在产生冲突的 merge / rebase 后，再于仓库目录执行 mergev。
            </p>
          </div>
        ) : (
          <>
            <header className="conflicts-header" data-tauri-drag-region>
              <div data-tauri-drag-region>
                <h1 data-tauri-drag-region>
                  {workspace.repoName}
                  <span className="muted" data-tauri-drag-region> · {workspace.branch}</span>
                </h1>
                <p className="muted" data-tauri-drag-region>{workspace.headline}</p>
              </div>
            </header>

            <div className="conflicts-body">
              <div className="conflicts-table-wrap">
                <table className="conflicts-table">
                  <thead>
                    <tr>
                      <th>文件名</th>
                      <th>当前 ({workspace.oursLabel})</th>
                      <th>对方 ({workspace.theirsLabel})</th>
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
                  disabled={busy || !selectedFile}
                  onClick={() => void onAccept("ours")}
                >
                  接受当前
                </button>
                <button
                  type="button"
                  disabled={busy || !selectedFile}
                  onClick={() => void onAccept("theirs")}
                >
                  接受对方
                </button>
                <button
                  type="button"
                  className="primary"
                  disabled={busy || !selectedFile}
                  onClick={onMerge}
                >
                  开始合并
                </button>
                {actionError ? <p className="error">{actionError}</p> : null}
                {selectedFile ? (
                  <p className="muted action-hint">
                    {selectedFile.conflictCount === null
                      ? "正在计算冲突块…"
                      : `${selectedFile.conflictCount} 个冲突块`}
                  </p>
                ) : null}
              </aside>
            </div>
          </>
        )}
      </main>

      {worktreeMenu && (
        <div
          className="context-menu"
          style={{ left: worktreeMenu.x, top: worktreeMenu.y }}
          onClick={(e) => e.stopPropagation()}
          onContextMenu={(e) => e.preventDefault()}
        >
          <button
            type="button"
            className="context-menu-item"
            onClick={() => {
              navigator.clipboard.writeText(worktreeMenu.path);
              setWorktreeMenu(null);
            }}
          >
            复制路径
          </button>
          {!worktreeMenu.isMain && (
            <button
              type="button"
              className="context-menu-item danger"
              onClick={() =>
                void handleRemoveWorktree(worktreeMenu.repoPath, worktreeMenu.path)
              }
            >
              删除 worktree
            </button>
          )}
        </div>
      )}

      {tabMenu && activePath && tabsByPath[activePath] && (
        <div
          className="context-menu"
          style={{ left: tabMenu.x, top: tabMenu.y }}
          onClick={(e) => e.stopPropagation()}
          onContextMenu={(e) => e.preventDefault()}
        >
          {(() => {
            const group = tabsByPath[activePath];
            const idx = group.tabs.findIndex((tab) => tab.id === tabMenu.tabId);
            const closeDisabled = group.tabs.length <= 1;
            return (
              <>
                <button
                  type="button"
                  className="context-menu-item"
                  disabled={closeDisabled}
                  onClick={() => {
                    closeTab(tabMenu.tabId);
                    setTabMenu(null);
                  }}
                >
                  关闭
                </button>
                <button
                  type="button"
                  className="context-menu-item"
                  disabled={closeDisabled}
                  onClick={() => {
                    closeTabsBatch(tabMenu.tabId, "others");
                    setTabMenu(null);
                  }}
                >
                  关闭其他
                </button>
                <button
                  type="button"
                  className="context-menu-item"
                  disabled={idx <= 0}
                  onClick={() => {
                    closeTabsBatch(tabMenu.tabId, "left");
                    setTabMenu(null);
                  }}
                >
                  关闭左侧
                </button>
                <button
                  type="button"
                  className="context-menu-item"
                  disabled={idx === -1 || idx >= group.tabs.length - 1}
                  onClick={() => {
                    closeTabsBatch(tabMenu.tabId, "right");
                    setTabMenu(null);
                  }}
                >
                  关闭右侧
                </button>
              </>
            );
          })()}
        </div>
      )}

      {addModalRepo && (
        <div
          className="modal-overlay"
          onClick={() => setAddModalRepo(null)}
          role="presentation"
        >
          <div
            className="modal"
            role="dialog"
            aria-modal="true"
            aria-label="新建 worktree"
            onClick={(e) => e.stopPropagation()}
          >
            <header className="modal-header">
              <h3>新建 worktree</h3>
              <button
                type="button"
                className="modal-close"
                aria-label="关闭"
                onClick={() => setAddModalRepo(null)}
              >
                <svg width="12" height="12" viewBox="0 0 16 16" aria-hidden="true">
                  <path
                    d="M4 4l8 8M12 4l-8 8"
                    stroke="currentColor"
                    strokeWidth="1.5"
                    strokeLinecap="round"
                    fill="none"
                  />
                </svg>
              </button>
            </header>
            <div className="modal-body">
              <div className="form-field">
                <label className="form-label" htmlFor="wt-base">
                  基于分支 <span className="form-required">*</span>
                </label>
                <select
                  id="wt-base"
                  className="form-select"
                  value={baseBranch}
                  onChange={(e) => {
                    // 切换基点时，分支名默认跟随所选分支，仍可手动调整
                    const value = e.target.value;
                    setBaseBranch(value);
                    setBranchName(value);
                  }}
                >
                  {branches.length === 0 && <option value="">加载中…</option>}
                  {branches.map((name) => (
                    <option key={name} value={name}>
                      {name}
                    </option>
                  ))}
                </select>
              </div>

              <div className="form-field">
                <label className="form-label" htmlFor="wt-branch">
                  分支名 <span className="form-required">*</span>
                </label>
                <input
                  id="wt-branch"
                  className="form-input"
                  value={branchName}
                  placeholder="已存在则检出，否则基于所选分支新建"
                  onChange={(e) => setBranchName(e.target.value)}
                />
              </div>

              <div className="form-field">
                <label className="form-label" htmlFor="wt-dir">
                  存放地址 <span className="form-required">*</span>
                </label>
                <div className="form-row">
                  <input
                    id="wt-dir"
                    className="form-input"
                    value={storageDir}
                    placeholder="/Users/you/.mergev/worktree/"
                    onChange={(e) => setStorageDir(e.target.value)}
                  />
                  <button
                    type="button"
                    className="form-browse"
                    onClick={() => {
                      void open({
                        directory: true,
                        multiple: false,
                        defaultPath: storageDir || undefined,
                      }).then((picked) => {
                        if (typeof picked === "string") {
                          setStorageDir(picked);
                        }
                      });
                    }}
                  >
                    选择…
                  </button>
                </div>
              </div>

              {formError && <p className="form-error">{formError}</p>}
            </div>
            <footer className="modal-footer">
              <button
                type="button"
                className="modal-cancel"
                onClick={() => setAddModalRepo(null)}
              >
                取消
              </button>
              <button
                type="button"
                className="modal-submit"
                disabled={
                  submitting || !baseBranch || !branchName.trim() || !storageDir.trim()
                }
                onClick={() => void submitCreateWorktree()}
              >
                {submitting ? "创建中…" : "创建"}
              </button>
            </footer>
          </div>
        </div>
      )}
    </div>
  );
}
