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
  return (
    <>
      <RepositoryAvatar name={repo.name} />
      <div className="repository-details">
        <div className="repository-name-row">
          <span className="repository-name">{repo.name}</span>
          {repo.hasConflicts ? (
            <span className="repository-conflict-dot" title="有冲突" />
          ) : null}
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
