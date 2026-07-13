import type { SideStatus } from "../types";

const SIDE_STATUS_LABEL: Record<SideStatus, string> = {
  modified: "Modified",
  deleted: "Deleted",
};

export function StatusCell({
  status,
  onOpen,
}: {
  status: SideStatus;
  onOpen: () => void;
}) {
  if (status === "deleted") {
    return <span>{SIDE_STATUS_LABEL[status]}</span>;
  }

  return (
    <button
      type="button"
      className="status-link"
      onClick={(event) => {
        event.stopPropagation();
        onOpen();
      }}
    >
      {SIDE_STATUS_LABEL[status]}
    </button>
  );
}
