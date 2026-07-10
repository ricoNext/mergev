import { createHighlighter, type Highlighter } from "shiki";

export type SyntaxToken = {
  text: string;
  color?: string;
  fontStyle?: number;
};

export type HighlightedLine = SyntaxToken[];

export type PaneHighlights = {
  ours: Map<number, HighlightedLine>;
  result: Map<number, HighlightedLine>;
  theirs: Map<number, HighlightedLine>;
};

const LANGUAGE_BY_EXTENSION: Record<string, string> = {
  ".ts": "typescript",
  ".tsx": "tsx",
  ".js": "javascript",
  ".jsx": "jsx",
  ".json": "json",
  ".jsonc": "jsonc",
  ".rs": "rust",
  ".md": "markdown",
  ".css": "css",
  ".scss": "scss",
  ".html": "html",
  ".vue": "vue",
  ".svelte": "svelte",
  ".yml": "yaml",
  ".yaml": "yaml",
  ".toml": "toml",
  ".sh": "bash",
  ".zsh": "bash",
  ".py": "python",
  ".go": "go",
  ".java": "java",
};

const LANGUAGE_BY_FILENAME: Record<string, string> = {
  "package-lock.json": "json",
  "bun.lock": "text",
  "Cargo.lock": "toml",
  Dockerfile: "docker",
};

const INITIAL_LANGUAGES = [
  "typescript",
  "tsx",
  "javascript",
  "jsx",
  "json",
  "jsonc",
  "rust",
  "markdown",
  "css",
  "html",
  "yaml",
  "toml",
  "bash",
] as const;

const THEME = "github-light";

/** 超过该行数时跳过语法高亮，避免大文件卡顿。 */
export const HIGHLIGHT_LINE_LIMIT = 3000;

let highlighterPromise: Promise<Highlighter> | null = null;

function getHighlighter(): Promise<Highlighter> {
  if (!highlighterPromise) {
    highlighterPromise = createHighlighter({
      themes: [THEME],
      langs: [...INITIAL_LANGUAGES],
    });
  }
  return highlighterPromise;
}

function fileNameOf(path: string): string {
  const parts = path.split(/[/\\]/);
  return parts[parts.length - 1] || path;
}

function extensionOf(fileName: string): string {
  const index = fileName.lastIndexOf(".");
  if (index <= 0) {
    return "";
  }
  return fileName.slice(index).toLowerCase();
}

export function languageFromPath(path: string): string {
  const fileName = fileNameOf(path);
  const byName = LANGUAGE_BY_FILENAME[fileName];
  if (byName) {
    return byName;
  }
  const byExt = LANGUAGE_BY_EXTENSION[extensionOf(fileName)];
  return byExt ?? "text";
}

function plainLines(text: string): HighlightedLine[] {
  if (text.length === 0) {
    return [];
  }
  return text.split("\n").map((line) => [{ text: line }]);
}

function toHighlightedLines(
  tokens: { content: string; color?: string; fontStyle?: number }[][],
): HighlightedLine[] {
  return tokens.map((line) =>
    line.map((token) => ({
      text: token.content,
      color: token.color,
      fontStyle: token.fontStyle,
    })),
  );
}

async function ensureLanguage(
  highlighter: Highlighter,
  language: string,
): Promise<boolean> {
  if (language === "text") {
    return false;
  }
  const loaded = highlighter.getLoadedLanguages();
  if (loaded.includes(language)) {
    return true;
  }
  try {
    await highlighter.loadLanguage(language as never);
    return true;
  } catch {
    return false;
  }
}

export async function highlightLines(
  text: string,
  language: string,
): Promise<HighlightedLine[]> {
  if (text.length === 0) {
    return [];
  }
  if (language === "text") {
    return plainLines(text);
  }

  try {
    const highlighter = await getHighlighter();
    const ready = await ensureLanguage(highlighter, language);
    if (!ready) {
      return plainLines(text);
    }
    const result = highlighter.codeToTokens(text, {
      lang: language as never,
      theme: THEME,
    });
    return toHighlightedLines(result.tokens);
  } catch {
    return plainLines(text);
  }
}

export function highlightedLinesToMap(
  lines: HighlightedLine[],
): Map<number, HighlightedLine> {
  const map = new Map<number, HighlightedLine>();
  lines.forEach((line, index) => {
    map.set(index + 1, line);
  });
  return map;
}

export function countHighlightLines(text: string): number {
  if (text.length === 0) {
    return 0;
  }
  let count = 1;
  for (let i = 0; i < text.length; i += 1) {
    if (text.charCodeAt(i) === 10) {
      count += 1;
    }
  }
  return count;
}

export function emptyPaneHighlights(): PaneHighlights {
  return {
    ours: new Map(),
    result: new Map(),
    theirs: new Map(),
  };
}
