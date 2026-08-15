// 懒加载 Shiki，延迟到真正需要语法高亮时才加载
type Highlighter = any;

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

// 主题配置
const LIGHT_THEME = "github-light";
const DARK_THEME = "github-dark";

let currentTheme: "light" | "dark" = "light";

/**
 * 更新语法高亮主题
 */
export function updateSyntaxTheme(theme: "light" | "dark") {
  currentTheme = theme;
  // 清除高亮器缓存，强制重新创建
  cachedHighlighter = null;
}

/**
 * 获取当前主题名称
 */
function getCurrentThemeId(): string {
  return currentTheme === "dark" ? DARK_THEME : LIGHT_THEME;
}

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

/** 超过该行数时跳过语法高亮，避免大文件卡顿。 */
export const HIGHLIGHT_LINE_LIMIT = 3000;

let cachedHighlighter: Highlighter | null = null;

async function getHighlighter(): Promise<Highlighter> {
  if (!cachedHighlighter) {
    const [core, engine, lightTheme, darkTheme, ...languages] = await Promise.all([
      import("@shikijs/core"),
      import("@shikijs/engine-javascript"),
      import("@shikijs/themes/github-light").then((module) => module.default),
      import("@shikijs/themes/github-dark").then((module) => module.default),
      import("@shikijs/langs/typescript").then((module) => module.default),
      import("@shikijs/langs/tsx").then((module) => module.default),
      import("@shikijs/langs/javascript").then((module) => module.default),
      import("@shikijs/langs/jsx").then((module) => module.default),
      import("@shikijs/langs/json").then((module) => module.default),
      import("@shikijs/langs/jsonc").then((module) => module.default),
      import("@shikijs/langs/rust").then((module) => module.default),
      import("@shikijs/langs/markdown").then((module) => module.default),
      import("@shikijs/langs/css").then((module) => module.default),
      import("@shikijs/langs/scss").then((module) => module.default),
      import("@shikijs/langs/html").then((module) => module.default),
      import("@shikijs/langs/vue").then((module) => module.default),
      import("@shikijs/langs/svelte").then((module) => module.default),
      import("@shikijs/langs/yaml").then((module) => module.default),
      import("@shikijs/langs/toml").then((module) => module.default),
      import("@shikijs/langs/bash").then((module) => module.default),
      import("@shikijs/langs/python").then((module) => module.default),
      import("@shikijs/langs/go").then((module) => module.default),
      import("@shikijs/langs/java").then((module) => module.default),
      import("@shikijs/langs/docker").then((module) => module.default),
    ]);
    cachedHighlighter = await core.createHighlighterCore({
      themes: [lightTheme, darkTheme],
      langs: languages,
      engine: engine.createJavaScriptRegexEngine(),
    });
  }
  return cachedHighlighter;
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
  return loaded.includes(language);
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
    const themeId = getCurrentThemeId();
    const result = highlighter.codeToTokens(text, {
      lang: language as never,
      theme: themeId,
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
