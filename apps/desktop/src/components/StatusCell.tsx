import type { SideStatus } from "@mergev/merge-ui/types";

const SIDE_STATUS_LABEL: Record<SideStatus, string> = {
  modified: "已修改",
  deleted: "已删除",
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
