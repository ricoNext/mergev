# mergev

一个从终端启动的跨平台 Git 冲突解决器，用三栏界面直观看 Yours、Theirs 和最终 Result。

<div align="center">

[![CI](https://github.com/ricoNext/mergev/actions/workflows/ci.yml/badge.svg)](https://github.com/ricoNext/mergev/actions/workflows/ci.yml)
[![GitHub release](https://img.shields.io/github/v/release/ricoNext/mergev?display_name=tag&sort=semver)](https://github.com/ricoNext/mergev/releases)
[![codecov](https://codecov.io/gh/ricoNext/mergev/branch/main/graph/badge.svg)](https://codecov.io/gh/ricoNext/mergev)
[![License: MIT](https://img.shields.io/badge/license-MIT-green.svg)](LICENSE)
[![Tauri](https://img.shields.io/badge/Tauri-2-24C8DB?logo=tauri&logoColor=white)](https://tauri.app/)
[![React](https://img.shields.io/badge/React-19-61DAFB?logo=react&logoColor=111)](https://react.dev/)
[![TypeScript](https://img.shields.io/badge/TypeScript-5-3178C6?logo=typescript&logoColor=white)](https://www.typescriptlang.org/)

</div>

![](https://neptune-ipc.oss-cn-shenzhen.aliyuncs.com/img/20260714091840470.png)

mergev 是一个专注于 Git 冲突解决的桌面工具。它把难读的冲突标记变成清晰的三栏可视化界面，让你像在专业 IDE 的合并窗口里一样，对比 Yours、Theirs 和最终 Result，逐块决定保留哪一边，最后一键保存并加入暂存区。

如果你习惯在终端里 `merge`、`rebase`、`cherry-pick`，但不想在冲突出现时靠肉眼编辑 `<<<<<<<`、`=======`、`>>>>>>>`，mergev 就是为这个时刻准备的。

## 为什么用 mergev

![](https://neptune-ipc.oss-cn-shenzhen.aliyuncs.com/img/20260714091213003.png)

Git 冲突本质上不是“文本问题”，而是“决策问题”：这一段该保留当前分支，还是传入分支？能不能两边都要？最终文件会长什么样？还有没有冲突没处理完？

mergev 把这些问题拆成一个更稳的流程：

- **三栏对照**：左侧是 Yours，中间是最终结果，右侧是 Theirs。
- **逐块处理**：不用在文件里搜索冲突标记，按冲突块逐个判断。
- **随时预览结果**：你做出的每一次选择都会反映到 Result。
- **文件级快速决策**：确定整份文件使用某一侧时，可以直接 Accept Yours / Accept Theirs。
- **保存即 Stage**：解决完成后保存文件，并自动 `git add`。
- **适合终端工作流**：安装 `mergev` 命令后，在任意 Git 仓库目录执行即可打开。

mergev 不想替代你的 IDE，也不想接管完整 Git 工作流。它只把“解决冲突”这一段做得更清楚、更可控。

## 适合谁

- 经常在终端里处理 Git 的开发者
- 习惯 JetBrains 工具的合并体验，但不想每次打开完整 IDE 的用户
- 在 rebase、cherry-pick、依赖升级时频繁处理冲突的维护者
- 想在提交前更直观看到最终合并结果的团队
- 使用 AI 编码工具后，需要人工确认合并结果的开发者

## 怎么用

![](https://neptune-ipc.oss-cn-shenzhen.aliyuncs.com/img/20260714091547137.png)

### 0. 安装
在[release](https://github.com/ricoNext/mergev/releases)中找到最新的版本和合适的系统（macOS、Windows、Linux），下载对应的安装包。

```text
macOS: Intel 芯片: x64.dmg     Apple M 芯片: aarch64.dmg 

Linux: AppImage: amd64.AppImage   DEB: amd64.deb    RPM: x86_64.rpm

Windows: 64 位: x64-setup.exe
```


mac 系统安装时， 可能会遇到损坏提示， 是因为应用没有进行开发者验证， 导致macOS 无法验证此 App 不包含恶意软件。

![](https://neptune-ipc.oss-cn-shenzhen.aliyuncs.com/img/20260714161538885.png)

解决方案参考： [macOS 提示：“应用程序” 已损坏，无法打开的解决方法总结](https://sysin.org/blog/macos-if-crashes-when-opening/)

Intel: Intel：打开"系统偏好设置 > 安全性与隐私"，允许"来自未知开发者"的应用

Silicon: Silicon：打开终端并运行以下命令：

```bash
sudo xattr -dr com.apple.quarantine /Applications/mergev.app
```
如果提示错误 option -r not recognized，请改为运行以下两条命令：

```bash
sudo xattr -d com.apple.quarantine /Applications/mergev.app
sudo xattr -d com.apple.quarantine /Applications/mergev.app/Contents/MacOS/*
```

### 1. 打开 Mergev

安装桌面应用后，首次启动会提示安装全局命令。推荐安装，这样之后可以在任何 Git 仓库目录运行：

```bash
mergev
```

也可以稍后在应用菜单中选择：

```text
工具 → 安装 mergev 命令到 PATH
```

命令默认安装到：

- macOS / Linux：`~/.local/bin/mergev`
- Windows：`%USERPROFILE%\.local\bin\mergev.cmd`

如果终端提示 `~/.local/bin` 不在 PATH 中，把下面一行加入你的 shell 配置后重新打开终端：

```bash
export PATH="$HOME/.local/bin:$PATH"
```

### 2. 在冲突仓库中启动

当 Git 操作产生冲突后，进入仓库目录或任意子目录：

```bash
cd /path/to/your/repo
mergev
```

mergev 会检测当前 Git 仓库、当前分支、正在进行的操作，并列出所有冲突文件。

如果当前目录不是 Git 仓库，命令会在终端中提示错误并退出，不会打开空窗口。

### 3. 选择冲突文件

在 Conflicts 列表中，你可以看到每个冲突文件的路径、冲突块数量和状态。

常见操作：

- **Accept Yours**：整份文件使用当前分支版本
- **Accept Theirs**：整份文件使用传入分支版本
- **Merge...**：进入三栏合并界面，逐块处理

### 4. 在三栏界面里解决冲突

进入 Merge 界面后，你会看到：

- **Yours**：当前分支内容
- **Result**：最终将写回工作区的内容
- **Theirs**：传入分支内容

你可以对每个冲突块选择左侧、右侧、两侧都保留，或忽略某一侧。处理过程中，Result 会一直展示最终文件的样子。

当所有冲突块都处理完成后，点击保存，mergev 会写回文件并执行 `git add`。

### 5. 回到 Git 流程

所有冲突都解决后，回到终端继续原来的 Git 操作：

```bash
git commit
```

如果你正在 rebase 或 cherry-pick：

```bash
git rebase --continue
git cherry-pick --continue
```

## 一个典型场景

```bash
git checkout feature/login
git rebase main
# 出现冲突

mergev
# 在 mergev 中逐个解决冲突并保存

git rebase --continue
```

整个过程中，你仍然掌控 Git 命令；mergev 只负责把冲突解决这一步变得可视、可检查、可重复。

## 项目状态

mergev 当前是一个基于 Tauri 2、React 和 TypeScript 的桌面应用，核心目标是提供轻量、清晰、可靠的 Git 冲突解决体验。

友情链接： [linux](https://linux.do)
