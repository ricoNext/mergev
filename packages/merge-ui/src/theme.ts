/**
 * 主题管理模块
 */

export type Theme = "light" | "dark" | "system";

const STORAGE_KEY = "mergev-theme";

/**
 * 获取保存的主题偏好
 */
export function getSavedTheme(): Theme {
  try {
    const saved = localStorage.getItem(STORAGE_KEY);
    if (saved === "light" || saved === "dark" || saved === "system") {
      return saved;
    }
  } catch (error) {
    console.error("Failed to read theme from localStorage:", error);
  }
  return "system";
}

/**
 * 保存主题偏好
 */
export function saveTheme(theme: Theme): void {
  try {
    localStorage.setItem(STORAGE_KEY, theme);
  } catch (error) {
    console.error("Failed to save theme to localStorage:", error);
  }
}

/**
 * 解析主题为实际的亮色/暗色
 */
export function resolveTheme(theme: Theme): "light" | "dark" {
  if (theme === "system") {
    const isDark = window.matchMedia("(prefers-color-scheme: dark)").matches;
    return isDark ? "dark" : "light";
  }
  return theme;
}

/**
 * 应用主题到 DOM
 */
export function applyThemeToDOM(theme: "light" | "dark"): void {
  document.documentElement.setAttribute("data-theme", theme);
}

/**
 * 获取主题图标
 */
export function getThemeIcon(theme: Theme): string {
  if (theme === "system") return "🌗";
  if (theme === "dark") return "🌙";
  return "☀️";
}

/**
 * 获取主题标签
 */
export function getThemeLabel(theme: Theme): string {
  if (theme === "system") return "跟随系统";
  if (theme === "dark") return "暗色";
  return "亮色";
}

/**
 * 切换到下一个主题
 */
export function getNextTheme(current: Theme): Theme {
  if (current === "light") return "dark";
  if (current === "dark") return "system";
  return "light";
}
