import { getRepoAvatarColor, getRepoInitials } from "../utils/repositoryUtils";

export function RepositoryAvatar({ name }: { name: string }) {
  return (
    <div
      className="repository-avatar"
      style={{ backgroundColor: getRepoAvatarColor(name) }}
      aria-hidden="true"
    >
      {getRepoInitials(name)}
    </div>
  );
}
