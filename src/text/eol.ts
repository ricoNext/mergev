export type EolStyle = "lf" | "crlf";

export function detectEol(text: string): EolStyle {
  return text.includes("\r\n") ? "crlf" : "lf";
}

export function normalizeEol(text: string): string {
  return text.replace(/\r\n/g, "\n").replace(/\r/g, "\n");
}

export function applyEol(text: string, style: EolStyle): string {
  return style === "crlf" ? text.replace(/\n/g, "\r\n") : text;
}

export function splitLinesKeepEndings(text: string): string[] {
  if (text.length === 0) {
    return [];
  }

  const matches = text.match(/[^\n]*\n|[^\n]+/g);
  return matches ?? [];
}

export function joinWithBoundary(first: string, second: string): string {
  if (first.length === 0) {
    return second;
  }

  if (second.length === 0) {
    return first;
  }

  return first.endsWith("\n") ? `${first}${second}` : `${first}\n${second}`;
}
