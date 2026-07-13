export function fileNameOf(path: string): string {
  const parts = path.split("/");
  return parts[parts.length - 1] || path;
}

export function dirOf(path: string): string {
  const index = path.lastIndexOf("/");
  return index >= 0 ? path.slice(0, index) : "";
}

export function hashString(value: string): number {
  let hash = 0;
  for (let i = 0; i < value.length; i += 1) {
    hash = (hash * 31 + value.charCodeAt(i)) | 0;
  }
  return Math.abs(hash);
}

export function formatDisplayPath(path: string, homeDir?: string | null): string {
  if (homeDir && path.startsWith(homeDir)) {
    return `~${path.slice(homeDir.length)}`;
  }
  const match = path.match(/^(\/Users\/[^/]+|\/home\/[^/]+)(\/.*)?$/);
  if (match) {
    return `~${match[2] || ""}`;
  }
  return path;
}

export function splitLines(text: string): string[] {
  if (text.length === 0) {
    return [];
  }
  const lines = text.split("\n");
  if (text.endsWith("\n")) {
    lines.pop();
  }
  return lines;
}
