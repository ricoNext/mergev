# mergev Zed 扩展（阶段 0 可行性 PoC）

> 状态：可行性验证完成，结论见 [`docs/ZED_FEASIBILITY.md`](../../docs/ZED_FEASIBILITY.md)

## 组成

```
apps/zed-poc/
├── extension.toml        # Zed 扩展清单，注册 context_servers.mergev
├── Cargo.toml            # WASM 扩展（wasm32-wasip2）
├── src/lib.rs            # context_server_command：告诉 Zed 如何启动 mergev-mcp
├── mcp-server/           # 原生二进制 mergev-mcp：MCP over stdio，包装 mergev-core
├── scripts/test-mcp.mjs  # 端到端冒烟测试（无需安装 Zed）
└── README.md
```

## 架构

Zed 扩展运行在 WASM 沙箱中，无法 spawn 进程、无法创建自定义 UI。
因此采用 Zed 官方唯一支持的长驻二进制通道——Context Server（MCP）：

```
Zed（宿主，管理进程生命周期）
  └── mergev-mcp（原生二进制，MCP over stdio）
        └── mergev-core（仓库扫描 / 冲突解析 / 保存暂存）
```

在 Zed 的 Agent Panel 中即可完成：

- 查看仓库冲突列表（分支、merge/rebase/cherry-pick/revert 状态、逐文件冲突数）
- 读取三栏合并数据（ours / theirs / base / 逐块冲突）
- 整文件 Accept Yours / Accept Theirs（自动 `git add`）
- 写回解决结果并暂存

## 构建

```bash
# WASM 扩展（需 rustup target add wasm32-wasip2）
cargo build --target wasm32-wasip2 --release -p zed-mergev

# 原生 MCP 服务器
cargo build --release -p mergev-mcp
```

## 测试（无需安装 Zed）

```bash
node apps/zed-poc/scripts/test-mcp.mjs
```

脚本会创建一个真实的 merge 冲突仓库，模拟 MCP 客户端完成
initialize → tools/list → tools/call 全流程，并校验：

- 协议握手与 4 个工具注册
- 冲突识别（operation / files）
- 三栏数据读取
- accept ours 后 `git ls-files -u` 为空（已解决并暂存）
- `.git/MERGE_HEAD` 仍在（未越权提交）
- 路径越界（`../`）被拒绝

## 在 Zed 中试用（dev extension）

1. 构建上述两个产物。
2. 修改 `src/lib.rs` 中的 `DEV_BINARY` 为 `mergev-mcp` 的绝对路径
   （正式发布改走 GitHub Release 自动下载）。
3. Zed 中执行 `zed: install dev extension`，选择 `apps/zed-poc/` 目录。
4. 打开 Agent Panel，让 Agent 调用 `mergev_workspace` 等工具。

## 已知限制（阶段 0 结论）

Zed 扩展 API 不支持自定义面板 / 编辑器 Tab / WebView，
完整三栏合并界面无法以普通扩展形式内嵌，详见可行性报告。
