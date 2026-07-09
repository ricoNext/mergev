export type LayoutMode = "three-pane" | "two-pane" | "result";

export type CliOptions = {
  list?: boolean;
  porcelain?: boolean;
  noAdd?: boolean;
  all?: boolean;
  check?: string;
  mode?: LayoutMode;
  editor?: string;
  debug?: boolean;
};

export function normalizeMode(mode: unknown): LayoutMode | undefined {
  if (mode === "three-pane" || mode === "two-pane" || mode === "result") {
    return mode;
  }

  return undefined;
}
