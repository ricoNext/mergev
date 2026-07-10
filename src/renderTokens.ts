export type DiffTokenKind = "equal" | "insert" | "delete" | "replace";

export type DiffToken = {
  kind: DiffTokenKind;
  text: string;
};

export type SyntaxToken = {
  text: string;
  color?: string;
  fontStyle?: number;
};

export type RenderToken = {
  text: string;
  color?: string;
  diffKind?: DiffTokenKind;
};

type Span = {
  start: number;
  end: number;
  color?: string;
  diffKind?: DiffTokenKind;
};

function toSpans(
  tokens: { text: string; color?: string; kind?: DiffTokenKind }[],
  mode: "syntax" | "diff",
): Span[] {
  const spans: Span[] = [];
  let offset = 0;
  for (const token of tokens) {
    const start = offset;
    const end = offset + token.text.length;
    if (mode === "syntax") {
      spans.push({ start, end, color: token.color });
    } else {
      spans.push({ start, end, diffKind: token.kind });
    }
    offset = end;
  }
  return spans;
}

function findCoveringSpan(spans: Span[], start: number, end: number): Span | undefined {
  return spans.find((span) => span.start <= start && end <= span.end);
}

/**
 * 将语法 token 与 diff token 按字符区间合并。
 * 合并后所有 token 文本拼接应等于原始行文本。
 */
export function mergeSyntaxAndDiffTokens(
  syntaxTokens: SyntaxToken[],
  diffTokens?: DiffToken[],
): RenderToken[] {
  if (!diffTokens || diffTokens.length === 0) {
    return syntaxTokens.map((token) => ({
      text: token.text,
      color: token.color,
    }));
  }

  if (syntaxTokens.length === 0) {
    return diffTokens.map((token) => ({
      text: token.text,
      diffKind: token.kind,
    }));
  }

  const original = syntaxTokens.map((token) => token.text).join("");
  const syntaxSpans = toSpans(syntaxTokens, "syntax");
  const diffSpans = toSpans(
    diffTokens.map((token) => ({ text: token.text, kind: token.kind })),
    "diff",
  );

  const points = new Set<number>([0, original.length]);
  for (const span of syntaxSpans) {
    points.add(span.start);
    points.add(span.end);
  }
  for (const span of diffSpans) {
    points.add(span.start);
    points.add(Math.min(span.end, original.length));
  }

  const sorted = [...points].sort((a, b) => a - b);
  const result: RenderToken[] = [];

  for (let i = 0; i < sorted.length - 1; i += 1) {
    const start = sorted[i];
    const end = sorted[i + 1];
    if (start >= end || start >= original.length) {
      continue;
    }
    const clippedEnd = Math.min(end, original.length);
    const text = original.slice(start, clippedEnd);
    if (text.length === 0) {
      continue;
    }
    const syntax = findCoveringSpan(syntaxSpans, start, clippedEnd);
    const diff = findCoveringSpan(diffSpans, start, clippedEnd);
    result.push({
      text,
      color: syntax?.color,
      diffKind: diff?.diffKind,
    });
  }

  return result;
}

export function buildRenderTokens(
  syntaxTokens?: SyntaxToken[],
  diffTokens?: DiffToken[],
): RenderToken[] | undefined {
  if ((!syntaxTokens || syntaxTokens.length === 0) && !diffTokens?.length) {
    return undefined;
  }
  if (!syntaxTokens || syntaxTokens.length === 0) {
    return diffTokens!.map((token) => ({
      text: token.text,
      diffKind: token.kind,
    }));
  }
  return mergeSyntaxAndDiffTokens(syntaxTokens, diffTokens);
}
