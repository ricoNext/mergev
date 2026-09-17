import type { WorkspaceSnapshot } from "@mergev/merge-ui/types";

export function LoadingScreen() {
  return (
    <main className="screen">
      <p className="muted">正在检测仓库与冲突…</p>
    </main>
  );
}

type ErrorScreenProps = {
  message: string;
  onRetry: () => void;
};

export function ErrorScreen({ message, onRetry }: ErrorScreenProps) {
  return (
    <main className="screen">
      <h1>无法打开工作区</h1>
      <p className="error">{message}</p>
      <button type="button" onClick={onRetry}>
        重试
      </button>
    </main>
  );
}

type EmptyScreenProps = {
  workspace: WorkspaceSnapshot;
  onRefresh: () => void;
};

export function EmptyScreen({ workspace, onRefresh }: EmptyScreenProps) {
  return (
    <main className="screen empty">
      <p className="eyebrow">mergev</p>
      <h1>
        {workspace.repoName}
        <span className="muted"> · {workspace.branch}</span>
      </h1>
      <p>当前没有需要解决的合并冲突。</p>
      <p className="muted">
        在产生冲突的 merge / rebase 后，再于仓库目录执行 mergev。
      </p>
      <button type="button" onClick={onRefresh}>
        刷新
      </button>
    </main>
  );
}
