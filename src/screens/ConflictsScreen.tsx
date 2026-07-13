import type { AppView } from "../types";
import { StatusCell } from "../components/StatusCell";
import { fileNameOf, dirOf } from "../utils/stringUtils";

export function ConflictsScreen({
  view,
  onSelect,
  onRefresh,
  onAccept,
  onMerge,
  onOpenPath,
  onClose,
}: {
  view: Extract<AppView, { kind: "conflicts" }>;
  onSelect: (path: string) => void;
  onRefresh: () => void;
  onAccept: (side: "ours" | "theirs") => Promise<void>;
  onMerge: () => void;
  onOpenPath: (path: string) => void;
  onClose: () => void;
}) {
  const { workspace, selectedPath, busy, actionError } = view;
  const selected =
    workspace.files.find((file) => file.path === selectedPath) ??
    workspace.files[0];

  return (
    <div className="conflicts">
      <header className="conflicts-header">
        <div>
          <h1>Conflicts</h1>
          <p className="muted">{workspace.headline}</p>
        </div>
        <button type="button" className="ghost" onClick={onRefresh}>
          刷新
        </button>
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
                      file.path === selected.path ? "selected" : undefined
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
            disabled={busy || !selected}
            onClick={() => void onAccept("ours")}
          >
            Accept Yours
          </button>
          <button
            type="button"
            disabled={busy || !selected}
            onClick={() => void onAccept("theirs")}
          >
            Accept Theirs
          </button>
          <button
            type="button"
            className="primary"
            disabled={busy || !selected}
            onClick={onMerge}
          >
            Merge…
          </button>
          {actionError ? <p className="error">{actionError}</p> : null}
          {selected ? (
            <p className="muted action-hint">
              {selected.conflictCount} conflict block
              {selected.conflictCount === 1 ? "" : "s"}
            </p>
          ) : null}
          <button type="button" className="close-app-button" onClick={onClose}>
            Close
          </button>
        </aside>
      </div>
    </div>
  );
}
