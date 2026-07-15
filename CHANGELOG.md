# Changelog

## 0.7.0 - 2026-07-15

### 新功能

- 缓存活跃仓库并按需加载冲突数

## 0.6.0 - 2026-07-14

### 修复

- 用 Unicode 控制台输出 CLI 错误并简化批处理脚本

## 0.5.0 - 2026-07-14

### 修复

- CLI 启动脚本设置 UTF-8 代码页

## 0.4.0 - 2026-07-14

### 修复

- 修复 Git 子进程控制台编码与闪窗问题

### 杂项

- 停止跟踪本地文档与技能配置目录
- 移除过期的内部规划文档
- 升级至 0.3.0 并更新 README 安装说明

### 变更

- Update README.md
- Update README.md
- Update README.md

## 0.3.0 - 2026-07-14

### 新功能

- 支持亮色/暗色/跟随系统主题切换

### 修复

- 补齐测试依赖并更新 README 安装说明

### 文档

- update README to remove duplicate image and improve clarity
- update CHANGELOG for v0.2.0

### 测试

- 补全 ConflictRegion 测试桩类型字段
- 补充工具函数单测并同步覆盖率配置与锁文件

### 杂项

- 移除 Release Please，新增发版脚本与 Vitest 覆盖率

### 变更

- Update README.md

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
