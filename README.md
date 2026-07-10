# Mergev

Mergev 是一个提供三栏可视化流程的 Git 冲突解决工具，让开发者像在 WebStorm 里一样逐块选择、编辑并校验最终合并结果。

当前仓库为 **Tauri 2 + React + TypeScript（Vite）** 桌面应用。安装客户端后，可通过菜单把 `mergev` 命令写入全局 PATH，以便在任意项目目录快速打开冲突解决界面。

## 开发

前置依赖：

- Node.js 18+
- [Rust](https://www.rust-lang.org/tools/install)（`rustup`）
- macOS：Xcode Command Line Tools

```bash
bun install
bun run dev
```

在 Git 仓库目录启动后，客户端会进入两步流程：

1. **Conflicts 文件列表**：Accept Yours / Accept Theirs / Merge…
2. **Merge 三栏**：逐块选择后 Save & Stage，可返回 Conflicts

无冲突时显示简洁空状态。通过已安装的 `mergev` 命令启动时，仍会先做仓库门禁（非仓库只在终端报错）。

## 安装命令行入口

1. 启动 Mergev 客户端
2. 打开菜单 **工具 → 安装 mergev 命令到 PATH**
3. 在任意 Git 仓库目录执行：

```bash
mergev
```

命令会安装到 `~/.local/bin/mergev`（Windows 为 `%USERPROFILE%\.local\bin\mergev.cmd`）。

在仓库目录执行 `mergev` 会打开客户端。若当前目录不是 Git 仓库，则只在终端报错并退出，不会打开窗口：

```text
错误: 当前目录不是 Git 仓库: /path/to/dir
请在仓库根目录或子目录中执行 mergev。
```

若提示 `~/.local/bin` 不在 PATH 中，把下面一行加入 shell 配置后重新打开终端：

```bash
export PATH="$HOME/.local/bin:$PATH"
```

需要移除时，使用 **工具 → 从 PATH 移除 mergev 命令**。

## 构建

```bash
bun run tauri:build
```

## 推荐 IDE

- [VS Code](https://code.visualstudio.com/) + [Tauri](https://marketplace.visualstudio.com/items?itemName=tauri-apps.tauri-vscode) + [rust-analyzer](https://marketplace.visualstudio.com/items?itemName=rust-analyzer.rust-analyzer)

## 文档

产品规划见 [`docs/PRODUCT.md`](docs/PRODUCT.md)。
