import type { DiffToken } from "../renderTokens";

export function tokenizeWords(text: string): string[] {
  return text.match(/\s+|[^\s]+/g) ?? [text];
}

export function wordDiffTokens(left: string, right: string): {
  left: DiffToken[];
  right: DiffToken[];
} {
  const a = tokenizeWords(left);
  const b = tokenizeWords(right);
  const n = a.length;
  const m = b.length;
  const dp: number[][] = Array.from({ length: n + 1 }, () =>
    Array.from({ length: m + 1 }, () => 0),
  );

  for (let i = n - 1; i >= 0; i -= 1) {
    for (let j = m - 1; j >= 0; j -= 1) {
      if (a[i] === b[j]) {
        dp[i][j] = dp[i + 1][j + 1] + 1;
      } else {
        dp[i][j] = Math.max(dp[i + 1][j], dp[i][j + 1]);
      }
    }
  }

  const leftTokens: DiffToken[] = [];
  const rightTokens: DiffToken[] = [];
  let i = 0;
  let j = 0;
  while (i < n && j < m) {
    if (a[i] === b[j]) {
      leftTokens.push({ kind: "equal", text: a[i] });
      rightTokens.push({ kind: "equal", text: b[j] });
      i += 1;
      j += 1;
    } else if (dp[i + 1][j] >= dp[i][j + 1]) {
      leftTokens.push({ kind: "delete", text: a[i] });
      i += 1;
    } else {
      rightTokens.push({ kind: "insert", text: b[j] });
      j += 1;
    }
  }
  while (i < n) {
    leftTokens.push({ kind: "delete", text: a[i] });
    i += 1;
  }
  while (j < m) {
    rightTokens.push({ kind: "insert", text: b[j] });
    j += 1;
  }

  return { left: leftTokens, right: rightTokens };
}
