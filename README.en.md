# mergev

[English](README.en.md) | [中文](README.md)

A cross-platform desktop Git conflict resolver with a clear three-pane workflow for comparing Yours, Theirs, and the final Result.

<div align="center">

[![CI](https://github.com/ricoNext/mergev/actions/workflows/ci.yml/badge.svg)](https://github.com/ricoNext/mergev/actions/workflows/ci.yml)
[![GitHub release](https://img.shields.io/github/v/release/ricoNext/mergev?display_name=tag&sort=semver)](https://github.com/ricoNext/mergev/releases)
[![codecov](https://codecov.io/gh/ricoNext/mergev/branch/main/graph/badge.svg)](https://codecov.io/gh/ricoNext/mergev)
[![License: MIT](https://img.shields.io/badge/license-MIT-green.svg)](LICENSE)
[![Tauri](https://img.shields.io/badge/Tauri-2-24C8DB?logo=tauri&logoColor=white)](https://tauri.app/)
[![React](https://img.shields.io/badge/React-19-61DAFB?logo=react&logoColor=111)](https://react.dev/)
[![TypeScript](https://img.shields.io/badge/TypeScript-5-3178C6?logo=typescript&logoColor=white)](https://www.typescriptlang.org/)

</div>

![mergev conflict resolver](https://neptune-ipc.oss-cn-shenzhen.aliyuncs.com/img/20260714091840470.png)

## Overview

mergev focuses on the conflict-resolution part of a Git workflow. It turns hard-to-read conflict markers such as `<<<<<<<`, `=======`, and `>>>>>>>` into a visual merge interface where you can inspect both sides, make decisions block by block, and review the resulting file before saving it.

It works well with terminal-based workflows such as `merge`, `rebase`, and `cherry-pick`, without taking over the rest of your Git process.

## Features

- Three-pane comparison of Yours, Result, and Theirs.
- Block-by-block conflict resolution with inline actions.
- Live preview of the final merged file.
- File-level actions to accept the entire Yours or Theirs version.
- Save the resolved file and stage it with `git add`.
- Recent repository history and repository switching.
- Light, dark, and system themes.
- A global `mergev` command for launching the desktop app from any Git repository.

![mergev merge view](https://neptune-ipc.oss-cn-shenzhen.aliyuncs.com/img/20260714091213003.png)

## Installation

Download the latest installer for your platform from the [GitHub Releases](https://github.com/ricoNext/mergev/releases) page.

Available package formats include:

- macOS: `.dmg` for Intel (`x64`) and Apple Silicon (`aarch64`).
- Windows: 64-bit `.exe` installer.
- Linux: `.AppImage`, `.deb`, and `.rpm` packages.

On macOS, Gatekeeper may show a warning because the application is not notarized. Follow the instructions shown by macOS or consult [this troubleshooting guide](https://sysin.org/blog/macos-if-crashes-when-opening/) before opening the app.

## Usage

### 1. Install the command-line launcher

On first launch, mergev offers to install the `mergev` command. You can also install it later from the application menu:

```text
Tools -> Install mergev command to PATH
```

The launcher is installed at:

- macOS and Linux: `~/.local/bin/mergev`
- Windows: `%USERPROFILE%\\.local\\bin\\mergev.cmd`

If your shell cannot find the command, add the following directory to your `PATH` and restart the shell:

```bash
export PATH="$HOME/.local/bin:$PATH"
```

### 2. Start mergev in a conflicted repository

After a Git operation produces conflicts, run `mergev` from the repository root or any directory inside that repository:

```bash
cd /path/to/your/repository
mergev
```

mergev detects the repository, current branch, active Git operation, and conflicted files. If the current directory is not inside a Git repository, the command prints an error and exits without opening an empty window.

### 3. Resolve conflicts

Select a conflicted file and choose one of the following actions:

- **Accept Yours**: use the current branch version for the whole file.
- **Accept Theirs**: use the incoming branch version for the whole file.
- **Merge**: open the three-pane editor and resolve each block individually.

In the merge editor:

- **Yours** shows the current branch content.
- **Theirs** shows the incoming branch content.
- **Result** shows the content that will be written to the working tree.

When every conflict block has a decision, save the result. mergev writes the file and stages it automatically with `git add`.

### 4. Continue the Git operation

Return to the terminal after resolving all conflicted files:

```bash
git commit
```

For a rebase or cherry-pick, continue with the corresponding Git command:

```bash
git rebase --continue
git cherry-pick --continue
```

## Development

### Prerequisites

- Node.js and npm.
- Rust and Cargo.
- Git.
- The platform dependencies required by [Tauri 2](https://v2.tauri.app/start/prerequisites/).

### Install dependencies

```bash
npm install
```

### Run the desktop app in development mode

```bash
npm run tauri dev
```

### Build and test

```bash
npm run build
npm test
```

`npm run build` type-checks the frontend and creates the Vite production build. To create native installers, run:

```bash
npm run tauri:build
```

The frontend uses React and TypeScript. The native layer is written in Rust with Tauri 2.

## Typical workflow

```bash
git switch feature/login
git rebase main
# Resolve conflicts reported by Git

mergev
# Resolve and save each conflicted file in mergev

git rebase --continue
```

You remain in control of the Git workflow; mergev handles the visual conflict-resolution step.

## License

mergev is released under the [MIT License](LICENSE).
