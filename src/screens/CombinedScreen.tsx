import { useEffect, useState } from "react";
import type { AppView } from "../types";
import type { Theme } from "../theme";
import { RepositoryListContent } from "../components/RepositoryListContent";
import { StatusCell } from "../components/StatusCell";
import { useHomeDir } from "../hooks/useHomeDir";
import { fileNameOf, dirOf } from "../utils/stringUtils";
import { listen } from "@tauri-apps/api/event";

export function CombinedScreen({
  view,
  theme: _theme,
  onToggleTheme,
  onSwitchRepository,
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
  onSelect: (path: string) => void;
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
  const homeDir = useHomeDir();

  useEffect(() => {
    const handleClick = () => setMenuOpen(null);
    if (menuOpen) {
      window.addEventListener("click", handleClick);
      return () => window.removeEventListener("click", handleClick);
    }
  }, [menuOpen]);

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
    <div className="combined-view">
      <aside className="repository-sidebar">
        <header className="sidebar-header">
          <h2>Repositories</h2>
          <div className="sidebar-header-actions">
            <button type="button" className="ghost" onClick={onAddRepository}>
              新增项目
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
                  onClick={() => onSwitchRepository(repo.path)}
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
            <p className="eyebrow">mergev</p>
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
                    {selectedFile.conflictCount === null
                      ? "正在计算冲突块…"
                      : `${selectedFile.conflictCount} conflict block${
                          selectedFile.conflictCount === 1 ? "" : "s"
                        }`}
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
