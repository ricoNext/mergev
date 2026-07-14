# Changelog

## [0.2.0](https://github.com/ricoNext/mergev/compare/v0.1.0...v0.2.0) (2026-07-14)


### 新功能

* **theme:** 支持亮色/暗色/跟随系统主题切换 ([48b85c0](https://github.com/ricoNext/mergev/commit/48b85c0c1758194a312e501fce4c49fadb845699))


### 文档

* update CHANGELOG for v0.2.0 ([dc06b14](https://github.com/ricoNext/mergev/commit/dc06b1453ed779427d8f9470aff78a463f83ff8e))


### 重构

* **ui:** 拆分 App 为屏幕与组件模块 ([0f7cbbb](https://github.com/ricoNext/mergev/commit/0f7cbbbdec1e73ef87cff0d19f8b30122de7b306))
* **ui:** 拆分 App 为屏幕与组件模块 ([d390b04](https://github.com/ricoNext/mergev/commit/d390b04faf7692adc76a45ada2aa77c3632d7263))

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
