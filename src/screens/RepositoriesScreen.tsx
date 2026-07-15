import type { AppView } from "../types";
import { RepositoryListContent } from "../components/RepositoryListContent";
import { useHomeDir } from "../hooks/useHomeDir";

export function RepositoriesScreen({
  view,
  onOpenRepository,
  onClose,
}: {
  view: Extract<AppView, { kind: "repositories" }>;
  onOpenRepository: (path: string) => void;
  onClose: () => void;
}) {
  const { repos } = view;
  const homeDir = useHomeDir();

  return (
    <div className="repositories">
      <header className="conflicts-header">
        <div>
          <h1>Recent Repositories</h1>
          <p className="muted">选择一个仓库查看冲突</p>
        </div>
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
