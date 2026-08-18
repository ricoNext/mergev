# Changelog

## 0.0.7 - 2026-08-18

### 改进

- 启动后自动激活插件，Activity Bar 显示待解决冲突文件数量
- 监听 VS Code Git 冲突状态变化，自动刷新冲突列表

## 0.0.6 - 2026-08-17

### 新功能

- 支持本地 Windows（x64 与 arm64）

### 改进

- 将 Marketplace publisher 更新为 ricoNext

## 0.0.5 - 2026-08-17

### 文档

- 更新 Visual Studio Marketplace 的 README 展示内容，并补充三栏界面截图。

## 0.0.4 - 2026-08-17

### 改进

- 扩展激活或冲突视图可见时，主动预加载当前工作区根目录的仓库快照。
- 三栏页面支持与桌面端一致的撤销、恢复冲突决策快捷键。
- 使用官方 `vsce` 生成符合 Visual Studio Marketplace 规范的 VSIX。

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
