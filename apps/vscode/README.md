# mergev

在 VS Code 里用三栏界面解决 Git 冲突：左侧是 Yours，中间是 Result，
右侧是 Theirs。按冲突块逐个选择，保存后自动 `git add`。

![](https://neptune-ipc.oss-cn-shenzhen.aliyuncs.com/img/20260817100604704.png)

## 功能

- 在 Activity Bar 列出当前工作区的冲突文件
- 从 Source Control 的 merge 分组打开冲突文件
- 三栏对照：Yours、Result、Theirs
- 逐块选择左侧、右侧，或两侧都保留
- 文件级 Accept Yours / Accept Theirs
- 保存后写回工作区并执行 `git add`

## 要求

- macOS（Apple Silicon 或 Intel）、Windows（x64 或 arm64）或 Linux（x64 或 arm64）
- Visual Studio Code 1.85 或更高版本
- Git 可通过 `PATH` 访问，或已配置 `mergev.gitPath`

支持 Remote SSH、WSL、Dev Container 等远程工作区：扩展运行在
远端 Extension Host，Linux 侧使用 musl 静态链接的 sidecar，
不依赖远端服务器的 glibc 版本。

## 怎么用

1. 在 Git 仓库中出现 merge、rebase 或 cherry-pick 冲突。
2. 打开 VS Code 工作区。
3. 点击 Activity Bar 中的 mergev 图标，展开仓库查看冲突文件。
4. 也可以在 Source Control 的 merge 分组中，右键选择
  「使用 mergev 打开」。
5. 在三栏界面中处理冲突块，或对整份文件执行 Accept Yours /
  Accept Theirs。
6. 所有冲突处理完成后点击保存。mergev 会写回文件并 `git add`，然后自动关闭 Tab。
7. 回到终端继续原来的 Git 操作，例如 `git commit` 或
  `git rebase --continue`。

Result 始终只读。关闭 Tab 后，尚未保存的冲突决策不会恢复。
三栏页面支持 `Cmd+Z` / `Ctrl+Z` 撤销冲突决策，支持
`Cmd+Shift+Z` / `Ctrl+Shift+Z` 恢复冲突决策。`Cmd+S` / `Ctrl+S`
不会保存结果。

## 配置

- `mergev.gitPath`：Git 不在 PATH 时填写可执行文件路径。
- `mergev.sidecarPath`：内部测试时覆盖内置 sidecar 路径。

## 许可证

MIT。详见 [LICENSE](./LICENSE)。
