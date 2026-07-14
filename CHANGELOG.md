# Changelog

## 0.2.0 - 2026-07-14

### 重构

- 拆分 App 为屏幕与组件模块，优化代码组织结构。

## 0.1.0 - 2026-07-13

### 新功能

- 发布 mergev 首个桌面端版本。
- 支持 Git 冲突文件列表、三栏合并视图、逐块选择和保存暂存。
- 支持安装 `mergev` 命令行入口，在任意 Git 仓库目录打开桌面端。
- 支持最近仓库历史、首次启动引导和仓库切换。

### 自动化

- 新增 GitHub Actions CI，用于校验前端构建和 Tauri 后端。
- 新增 tag 触发的桌面端发布流水线，自动构建 macOS、Windows、Linux 安装包并上传 GitHub Release。
- 新增 Release Please 配置，后续版本会自动维护发布 PR、版本号和 `CHANGELOG.md`。
