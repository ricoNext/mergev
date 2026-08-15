# Changelog

## 0.0.3 - 2026-08-15

### 构建

- 接入 monorepo 共享 UI 与共享 Rust 核心，插件可独立构建和发布。
- 打包命令自动构建 Apple Silicon 与 Intel 的 sidecar，并生成可上传 Marketplace 的 VSIX。

## 0.0.2 - 2026-08-15

### 新功能

- 更新 mergev 的侧边栏图标

## 0.0.1 - 2026-08-15

### 新功能

- 在 VS Code 中用三栏界面解决 Git 冲突
- Activity Bar 冲突文件列表，展开仓库后再扫描
- 从 Source Control 的 merge 分组打开冲突文件
- 支持逐块选择，以及文件级 Accept Yours / Accept Theirs
- 保存后写回工作区并执行 `git add`

### 限制

- 仅支持本地 macOS（arm64 与 x64）
- 不支持 Windows、Linux 和远程 Extension Host
- Result 只读，关闭 Tab 后不恢复未保存决策
