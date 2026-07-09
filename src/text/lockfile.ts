import path from "node:path";

const LOCKFILE_NAMES = new Set([
  "bun.lock",
  "bun.lockb",
  "composer.lock",
  "Gemfile.lock",
  "go.sum",
  "package-lock.json",
  "pnpm-lock.yaml",
  "poetry.lock",
  "Cargo.lock",
  "yarn.lock"
]);

export function isLockfile(filePath: string): boolean {
  return LOCKFILE_NAMES.has(path.basename(filePath));
}
