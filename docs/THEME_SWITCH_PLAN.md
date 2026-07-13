# mergev 主题切换功能实现方案

## 📋 功能目标

- 支持亮色/暗色主题切换
- 持久化用户主题偏好
- 跟随系统主题（可选）
- 语法高亮主题联动
- 平滑的视觉过渡体验

---

## 🏗️ 技术架构

### 1. 主题存储方案

#### 方案 A：Tauri Store Plugin（推荐）

```bash
# 安装依赖
cargo add tauri-plugin-store --features=v2
```

**优点：**
- Tauri 官方插件，专为配置持久化设计
- 自动序列化/反序列化
- 跨平台存储路径（`~/.config/mergev/settings.json`）
- 支持加密
- 可扩展为通用设置管理

**缺点：**
- 需要额外依赖
- 增加打包体积（约 200KB）

#### 方案 B：LocalStorage（简单方案）

```typescript
// 前端直接用 localStorage
localStorage.setItem('mergev-theme', 'dark');
```

**优点：**
- 无需额外依赖
- 实现简单快速
- Web 标准 API

**缺点：**
- 不能从 Rust 侧读取（如需要在启动时应用主题）
- 跨平台路径不统一

**推荐：**
- MVP 阶段使用 **方案 B**（LocalStorage）
- 后续有更多配置项时迁移到 **方案 A**

---

### 2. CSS 主题变量设计

修改 `src/App.css`，定义主题变量系统：

```css
/* ========== 亮色主题（默认） ========== */
:root {
  /* 背景色 */
  --bg-primary: #f5f1ea;      /* 主背景 */
  --bg-secondary: #f7f3ec;    /* 次级背景 */
  --bg-tertiary: #efe8dc;     /* 三级背景 */
  --bg-surface: #fffaf3;      /* 卡片/按钮表面 */
  
  /* 文字色 */
  --text-primary: #1c1917;    /* 主文字 */
  --text-secondary: #6b6358;  /* 次级文字 */
  --text-muted: #8a8176;      /* 弱化文字 */
  
  /* 边框色 */
  --border-default: #c4b5a0;  /* 默认边框 */
  --border-hover: #8a6a43;    /* 悬停边框 */
  --border-focus: #245c4a;    /* 聚焦边框 */
  
  /* 强调色 */
  --accent-primary: #245c4a;  /* 主强调色（绿色） */
  --accent-hover: #1a4535;    /* 悬停状态 */
  --accent-light: #e8f3ef;    /* 浅色背景 */
  
  /* 状态色 */
  --error: #9b2c2c;           /* 错误 */
  --warning: #c4612f;         /* 警告 */
  --success: #245c4a;         /* 成功 */
  
  /* 效果 */
  --shadow-sm: 0 1px 2px rgba(0, 0, 0, 0.06);
  --shadow-md: 0 4px 6px rgba(0, 0, 0, 0.08);
  --overlay: rgba(0, 0, 0, 0.3);
}

/* ========== 暗色主题 ========== */
[data-theme="dark"] {
  /* 背景色 */
  --bg-primary: #1a1816;      /* 深木炭色，不是纯黑 */
  --bg-secondary: #252220;    /* 稍亮 */
  --bg-tertiary: #2f2c28;     /* 再亮一级 */
  --bg-surface: #3a3632;      /* 卡片/按钮表面 */
  
  /* 文字色 */
  --text-primary: #e8e4dc;    /* 暖米色 */
  --text-secondary: #b8b0a4;  /* 中性灰 */
  --text-muted: #8a8176;      /* 弱化 */
  
  /* 边框色 */
  --border-default: #4a443c;  /* 深色边框 */
  --border-hover: #6b6358;    /* 悬停提亮 */
  --border-focus: #3b9979;    /* 聚焦（绿色） */
  
  /* 强调色 */
  --accent-primary: #3b9979;  /* 提亮的绿色 */
  --accent-hover: #4db38c;    /* 悬停更亮 */
  --accent-light: #1f3a32;    /* 深色背景 */
  
  /* 状态色 */
  --error: #e85d5d;           /* 提亮红色 */
  --warning: #e07a4a;         /* 提亮橙色 */
  --success: #3b9979;         /* 绿色 */
  
  /* 效果 */
  --shadow-sm: 0 1px 2px rgba(0, 0, 0, 0.3);
  --shadow-md: 0 4px 6px rgba(0, 0, 0, 0.4);
  --overlay: rgba(0, 0, 0, 0.7);
}

/* ========== 应用变量到现有样式 ========== */
:root {
  color: var(--text-primary);
  background: var(--bg-primary);
}

button {
  border: 1px solid var(--border-default);
  background: var(--bg-surface);
  color: var(--text-primary);
}

button:hover:not(:disabled) {
  border-color: var(--border-hover);
}

button.primary {
  background: var(--accent-primary);
  border-color: var(--accent-primary);
  color: var(--bg-surface);
}

button.primary:hover:not(:disabled) {
  background: var(--accent-hover);
  border-color: var(--accent-hover);
}

.muted {
  color: var(--text-secondary);
}

.error {
  color: var(--error);
}

/* 平滑过渡 */
:root {
  transition: 
    background-color 0.2s ease,
    color 0.2s ease;
}

button, .merge-pane, .conflicts-header {
  transition: 
    background-color 0.2s ease,
    border-color 0.2s ease,
    color 0.2s ease;
}
```

**设计原则：**
- 暗色主题使用深棕/木炭色而非纯黑，保持温暖感
- 暗色下强调色更亮（对比度足够）
- 避免冷蓝色调，延续整体暖色风格
- 所有颜色通过变量统一管理

---

### 3. 前端实现

#### 类型定义

在 `src/App.tsx` 添加：

```typescript
type Theme = "light" | "dark" | "system";
```

#### 核心逻辑

```typescript
function App() {
  const [theme, setTheme] = useState<Theme>("system");

  // 应用主题到 DOM
  const applyTheme = useCallback((newTheme: Theme) => {
    let resolvedTheme: "light" | "dark" = "light";
    
    if (newTheme === "system") {
      // 检测系统主题
      const isDark = window.matchMedia("(prefers-color-scheme: dark)").matches;
      resolvedTheme = isDark ? "dark" : "light";
    } else {
      resolvedTheme = newTheme;
    }
    
    // 应用到 DOM
    document.documentElement.setAttribute("data-theme", resolvedTheme);
    
    // 更新语法高亮主题（Phase 3）
    updateSyntaxTheme(resolvedTheme);
    
    // 保存偏好
    localStorage.setItem("mergev-theme", newTheme);
  }, []);

  // 初始化主题
  useEffect(() => {
    const savedTheme = (localStorage.getItem("mergev-theme") as Theme) || "system";
    setTheme(savedTheme);
    applyTheme(savedTheme);
    
    // 监听系统主题变化
    const mediaQuery = window.matchMedia("(prefers-color-scheme: dark)");
    const handleChange = () => {
      if (savedTheme === "system") {
        applyTheme("system");
      }
    };
    
    mediaQuery.addEventListener("change", handleChange);
    return () => mediaQuery.removeEventListener("change", handleChange);
  }, [applyTheme]);

  // 主题切换函数
  const toggleTheme = () => {
    const nextTheme: Theme = 
      theme === "light" ? "dark" : 
      theme === "dark" ? "system" : 
      "light";
    
    setTheme(nextTheme);
    applyTheme(nextTheme);
  };

  // ... 其余代码
}
```

---

### 4. 语法高亮主题联动

修改 `src/syntaxHighlight.ts`：

```typescript
// 新增主题映射
const LIGHT_THEMES = [
  "github-light",       // 推荐：GitHub 风格
  "catppuccin-latte",   // 备选：暖色调
  "one-light",          // 备选：简洁
] as const;

const DARK_THEMES = [
  "github-dark",        // 推荐：GitHub 暗色
  "catppuccin-mocha",   // 备选：暖色暗色
  "one-dark-pro",       // 备选：经典暗色
] as const;

let currentShikiTheme: string = LIGHT_THEMES[0];

/**
 * 更新语法高亮主题
 */
export function updateSyntaxTheme(theme: "light" | "dark") {
  currentShikiTheme = theme === "dark" ? DARK_THEMES[0] : LIGHT_THEMES[0];
  
  // TODO: 如果需要立即重新渲染已高亮的代码，触发重新高亮
  // 当前实现中，新主题会在下次加载文件时生效
}

/**
 * 获取当前主题名称
 */
export function getCurrentTheme(): string {
  return currentShikiTheme;
}

// 修改 highlightLines 函数，使用 currentShikiTheme
export async function highlightLines(
  lang: string,
  lines: string[]
): Promise<HighlightedLine[]> {
  const highlighter = await getHighlighter({
    themes: [currentShikiTheme],  // 使用当前主题
    langs: [lang],
  });
  
  // ... 其余代码
}
```

**优化方案：**
- Phase 1：主题切换后，只对新加载的文件生效
- Phase 2：主题切换时，重新高亮当前显示的文件（需触发 `loadConflicts`）

---

### 5. UI 控件设计

#### 方案 A：Header 按钮（MVP）

在 `Header` 组件添加主题切换按钮：

```typescript
function Header({ 
  headline, 
  operation, 
  branch, 
  theme,          // 新增
  onToggleTheme   // 新增
}: HeaderProps) {
  const getThemeIcon = () => {
    if (theme === "system") return "🌗";
    if (theme === "dark") return "🌙";
    return "☀️";
  };

  const getThemeLabel = () => {
    if (theme === "system") return "跟随系统";
    if (theme === "dark") return "暗色";
    return "亮色";
  };

  return (
    <header className="workspace-header">
      <div className="workspace-headline">
        {/* 现有标题内容 */}
      </div>
      
      <button
        className="theme-toggle"
        onClick={onToggleTheme}
        title={`主题: ${getThemeLabel()}\n点击切换`}
        aria-label={`切换主题 (当前: ${getThemeLabel()})`}
      >
        <span className="theme-icon">{getThemeIcon()}</span>
      </button>
    </header>
  );
}
```

对应 CSS：

```css
.theme-toggle {
  position: absolute;
  top: 1rem;
  right: 1rem;
  padding: 0.5rem;
  min-width: 2.5rem;
  border-radius: 8px;
  font-size: 1.2rem;
  display: flex;
  align-items: center;
  justify-content: center;
}

.theme-toggle:hover {
  transform: scale(1.05);
}
```

#### 方案 B：菜单项（更规范）

在 `src-tauri/src/lib.rs` 添加主题菜单：

```rust
const MENU_THEME_LIGHT: &str = "theme-light";
const MENU_THEME_DARK: &str = "theme-dark";
const MENU_THEME_SYSTEM: &str = "theme-system";

// 在 setup 函数中构建菜单
let theme_submenu = SubmenuBuilder::new(app, "主题")
    .item(&MenuItemBuilder::new("亮色").id(MENU_THEME_LIGHT).build(app)?)
    .item(&MenuItemBuilder::new("暗色").id(MENU_THEME_DARK).build(app)?)
    .separator()
    .item(&MenuItemBuilder::new("跟随系统").id(MENU_THEME_SYSTEM).build(app)?)
    .build()?;

let menu = MenuBuilder::new(app)
    .item(&tools_submenu)
    .item(&theme_submenu)  // 添加主题菜单
    .build()?;
```

前端监听菜单事件：

```typescript
import { getCurrentWindow } from "@tauri-apps/api/window";

useEffect(() => {
  const appWindow = getCurrentWindow();
  
  const unlisten = appWindow.onMenuClicked(({ id }) => {
    if (id === "theme-light") {
      setTheme("light");
      applyTheme("light");
    } else if (id === "theme-dark") {
      setTheme("dark");
      applyTheme("dark");
    } else if (id === "theme-system") {
      setTheme("system");
      applyTheme("system");
    }
  });
  
  return () => {
    unlisten.then(fn => fn());
  };
}, [applyTheme]);
```

**推荐：**
- MVP 使用 **方案 A**（Header 按钮）
- 正式版使用 **方案 B**（菜单）+ 快捷键（`Cmd+Shift+T`）

---

## 📦 实现步骤

### Phase 1: 基础主题切换（1-2h）

**目标：** 实现亮色/暗色手动切换

1. ✅ 定义 CSS 变量（亮色/暗色）
   - 修改 `src/App.css`
   - 添加 `:root` 和 `[data-theme="dark"]` 变量定义

2. ✅ 替换所有硬编码颜色为 CSS 变量
   - 全局搜索 `#` 开头的颜色值
   - 替换为对应的 CSS 变量
   - 重点文件：`App.css`、`FirstLaunchDialog.css`

3. ✅ 实现 `applyTheme` 函数
   - 在 `App.tsx` 添加主题状态
   - 实现 `applyTheme` 和 `toggleTheme`

4. ✅ 添加 LocalStorage 持久化
   - 保存用户偏好
   - 启动时恢复

5. ✅ 添加 Header 按钮
   - 修改 `Header` 组件
   - 添加切换按钮和图标

**验收标准：**
- 点击按钮能切换亮色/暗色
- 刷新后主题保持
- 所有 UI 元素颜色正确

---

### Phase 2: 系统主题跟随（1h）

**目标：** 支持"跟随系统"选项

6. ✅ 监听 `prefers-color-scheme`
   - 使用 `window.matchMedia`
   - 系统主题变化时自动更新

7. ✅ 实现三态切换
   - `light` → `dark` → `system` → `light`
   - 更新按钮图标和提示

**验收标准：**
- 系统主题变化时自动切换
- "跟随系统"模式工作正常
- 按钮图标正确显示

---

### Phase 3: 语法高亮联动（1-2h）

**目标：** 代码高亮跟随主题

8. ✅ 配置 Shiki 亮色/暗色主题
   - 修改 `src/syntaxHighlight.ts`
   - 定义 `LIGHT_THEMES` 和 `DARK_THEMES`

9. ✅ 主题切换时触发重新高亮
   - 方案 1：只对新加载文件生效（简单）
   - 方案 2：重新渲染当前文件（完整）

10. ✅ 优化：按需加载主题
    - 初始只加载当前主题
    - 切换时动态加载另一主题

**验收标准：**
- 代码高亮颜色与主题匹配
- 切换流畅无闪烁

---

### Phase 4: UI 优化（1h）

**目标：** 提升用户体验

11. ✅ 移至菜单
    - 从 Header 按钮迁移到菜单项
    - 添加快捷键（`Cmd+Shift+T`）

12. ✅ 平滑过渡动画
    - 添加 CSS `transition`
    - 避免闪烁

13. ✅ 优化按钮样式
    - 更精致的图标
    - 悬停效果

**验收标准：**
- 菜单项工作正常
- 动画流畅自然
- 跨平台一致

---

### Phase 5: 高级功能（可选，2-3h）

14. ⚠️ 迁移到 Tauri Store Plugin
    - 安装 `tauri-plugin-store`
    - 替换 LocalStorage

15. ⚠️ 自定义主题颜色
    - 允许用户自定义色板
    - 提供预设主题（Solarized、Dracula 等）

16. ⚠️ 导入/导出主题配置
    - JSON 格式配置文件
    - 社区主题分享

---

## 🎨 暗色主题设计指南

### 背景色层级
```
深 → 浅
#1a1816 (主背景)
#252220 (次级)
#2f2c28 (卡片)
#3a3632 (按钮/输入框)
```

### 文字对比度
- 主文字：WCAG AA 标准（对比度 ≥ 4.5:1）
- 次级文字：对比度 ≥ 3:1
- 弱化文字：对比度 ≥ 2:1

### 避免的设计
- ❌ 纯黑背景 `#000000`（过于刺眼）
- ❌ 纯白文字 `#ffffff`（对比度过高）
- ❌ 冷蓝色调（与整体风格不符）
- ❌ 高饱和度色彩（长时间使用疲劳）

### 推荐的设计
- ✅ 深棕/木炭色背景
- ✅ 暖米色文字
- ✅ 提亮但不刺眼的强调色
- ✅ 适度的阴影增强层次

---

## 🧪 测试清单

### 功能测试
- [ ] 亮色主题显示正常
- [ ] 暗色主题显示正常
- [ ] 系统主题跟随工作
- [ ] 刷新后保持主题
- [ ] 切换主题平滑无闪烁
- [ ] 语法高亮主题联动

### UI 测试
- [ ] 所有按钮颜色正确
- [ ] 边框/阴影显示正常
- [ ] 文字对比度足够
- [ ] Header/菜单显示正常
- [ ] 弹窗/提示颜色正确

### 兼容性测试
- [ ] macOS 正常
- [ ] Windows 正常
- [ ] Linux 正常
- [ ] 系统主题切换响应及时
- [ ] 不同分辨率显示正常

### 性能测试
- [ ] 切换主题无卡顿
- [ ] 语法高亮加载流畅
- [ ] 内存占用正常

---

## 🚀 快速启动方案（最小 MVP）

如果只有 **2 小时**，建议实现：

### 最小可行版本
1. **只做 light/dark 切换**（不做 system）
2. **用 LocalStorage**（不装 Tauri Store）
3. **Header 按钮**（不做菜单）
4. **固定语法高亮主题**（暂不联动）

### 核心改动
- `src/App.css`（30 分钟）：定义变量 + 替换颜色
- `src/App.tsx`（60 分钟）：状态管理 + 切换逻辑
- 测试（30 分钟）：验证亮色/暗色正常

### 代码量估计
- 新增：~150 行（CSS 变量 + 主题逻辑）
- 修改：~50 行（替换硬编码颜色）

---

## 📚 参考资料

### CSS Variables
- [MDN: Using CSS custom properties](https://developer.mozilla.org/en-US/docs/Web/CSS/Using_CSS_custom_properties)

### 主题设计
- [Material Design Dark Theme](https://material.io/design/color/dark-theme.html)
- [macOS Human Interface Guidelines - Dark Mode](https://developer.apple.com/design/human-interface-guidelines/macos/visual-design/dark-mode/)

### Tauri
- [Tauri Plugin Store](https://v2.tauri.app/plugin/store/)
- [Tauri Menu API](https://v2.tauri.app/reference/javascript/api/menu/)

### Shiki Themes
- [Shiki Theme Gallery](https://shiki.style/themes)
- [GitHub Dark Theme Colors](https://github.com/primer/primitives)

---

## 📝 后续扩展

完成基础主题切换后，可以考虑：

1. **自定义主题编辑器**
   - 可视化调色板
   - 实时预览
   - 导出为 JSON

2. **社区主题库**
   - 预设热门主题（Solarized、Dracula、Nord）
   - 用户上传分享
   - 一键安装

3. **智能主题**
   - 根据时间自动切换（白天亮色/夜晚暗色）
   - 根据环境光传感器（需硬件支持）

4. **高级配置**
   - 独立设置语法高亮主题
   - 自定义字体
   - 行高/间距调整

---

**预计总工时：** 5-8 小时（含测试）  
**MVP 工时：** 2 小时  
**推荐优先级：** Phase 1 → Phase 2 → Phase 3
