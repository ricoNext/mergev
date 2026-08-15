export function GitBranchIcon() {
  return (
    <svg
      className="repository-branch-icon"
      width="12"
      height="12"
      viewBox="0 0 16 16"
      aria-hidden="true"
    >
      <circle cx="4.5" cy="3.5" r="1.75" fill="currentColor" />
      <circle cx="4.5" cy="12.5" r="1.75" fill="currentColor" />
      <circle cx="11.5" cy="7.5" r="1.75" fill="currentColor" />
      <path
        d="M4.5 5.25v4.5M4.5 7.5h5.5"
        stroke="currentColor"
        strokeWidth="1.25"
        fill="none"
      />
    </svg>
  );
}
