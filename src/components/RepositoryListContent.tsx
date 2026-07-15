import { GitBranchIcon } from "./GitBranchIcon";
import { RepositoryAvatar } from "./RepositoryAvatar";
import type { RepositoryItem } from "../types";
import { formatDisplayPath } from "../utils/stringUtils";

export function RepositoryListContent({
  repo,
  homeDir,
}: {
  repo: RepositoryItem;
  homeDir?: string | null;
}) {
  const conflictStatus =
    repo.hasConflicts === undefined
      ? { className: "unknown", label: "冲突状态未知" }
      : repo.hasConflicts
        ? { className: "has-conflicts", label: "有冲突" }
        : { className: "clean", label: "无冲突" };

  return (
    <>
      <RepositoryAvatar name={repo.name} />
      <div className="repository-details">
        <div className="repository-name-row">
          <span className="repository-name">{repo.name}</span>
          <span
            className={`repository-conflict-status ${conflictStatus.className}`}
            title={conflictStatus.label}
            aria-label={conflictStatus.label}
          />
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
