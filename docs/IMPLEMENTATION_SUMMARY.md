# 仓库历史记录功能实现总结

## 功能需求
1. **直接打开应用**时，显示历史打开过的仓库列表
2. **通过 `mergev` 命令在 Git 仓库中打开**时，直接显示该仓库的冲突列表
3. **支持开发环境**通过 `MERGEV_CWD` 环境变量指定仓库路径

## 前端改动 (TypeScript/React)

### 1. `src/App.tsx`

#### 新增类型定义
```typescript
type RepositoryItem = {
  path: string;
  name: string;
  lastOpened: string;
  branch?: string;
  hasConflicts?: boolean;
};

type AppView = 
  | ... // 原有类型
  | { kind: "repositories"; repos: RepositoryItem[] }  // 新增
```

#### 新增/修改函数
- `loadInitial()`: 启动时判断是否在有效仓库中，决定显示冲突列表还是历史列表
- `openRepository(repoPath: string)`: 打开选中的历史仓库
- `RepositoriesScreen`: 新组件，显示历史仓库列表界面

#### 启动逻辑
```typescript
useEffect(() => {
  void loadInitial();  // 改为调用 loadInitial 而不是 loadConflicts
}, []);
```

### 2. `src/App.css`

新增样式类:
- `.repositories`: 仓库列表容器
- `.repositories-body`: 主体区域
- `.repositories-empty`: 空状态提示
- `.repositories-list`: 仓库列表
- `.repository-item`: 单个仓库卡片
- `.repository-info`, `.repository-name`, `.repository-path`, `.repository-branch`: 仓库信息显示
- `.repository-badge`: "有冲突"标签

## 后端改动 (Rust)

### 1. 新文件: `src-tauri/src/repository_history.rs`

核心功能模块，负责:
- 持久化历史仓库列表到 `~/.config/mergev/history.json`
- 最多保存 20 个最近访问的仓库
- 自动更新仓库的分支和冲突状态
- 过滤掉不存在的仓库路径

主要函数:
- `add_repository(repo_path: &Path)`: 添加仓库到历史记录
- `get_recent_repositories()`: 获取历史仓库列表并更新状态
- `load_history()` / `save_history()`: 读写历史文件

### 2. `src-tauri/src/git.rs`

新增函数:
```rust
pub fn get_current_branch(repo_root: &Path) -> Result<String, String>
```
获取仓库的当前分支名称。

### 3. `src-tauri/src/lib.rs`

#### 修改 `get_workspace` 命令
在成功加载工作区后，自动将仓库添加到历史记录:
```rust
if !snapshot.root.is_empty() && !snapshot.repo_name.is_empty() {
    let _ = repository_history::add_repository(&cwd);
}
```

#### 新增 Tauri 命令
- `get_recent_repositories()`: 返回历史仓库列表
- `open_repository(path: String)`: 切换到指定仓库

### 4. `src-tauri/Cargo.toml`

新增依赖:
```toml
chrono = { version = "0.4", features = ["serde"] }  # 时间戳
dirs = "5"  # 获取用户主目录
```

## 工作流程

### 场景 1: 直接打开应用
1. `loadInitial()` 调用 `get_workspace`
2. 后端返回空的 `root` 或 `repoName`
3. 前端调用 `get_recent_repositories()`
4. 显示 `RepositoriesScreen` 界面
5. 用户点击某个仓库
6. 调用 `open_repository(path)` 切换工作目录
7. 重新调用 `loadConflicts()` 显示冲突列表

### 场景 2: 通过 `mergev` 命令启动
1. `MERGEV_CWD` 环境变量已设置
2. `loadInitial()` 调用 `get_workspace`
3. 后端返回有效的 `WorkspaceSnapshot`
4. 直接显示冲突列表 (`kind: "conflicts"`) 或空状态 (`kind: "empty"`)
5. 仓库自动添加到历史记录

### 场景 3: 开发环境使用 `MERGEV_CWD`
与场景 2 相同，后端会优先读取 `MERGEV_CWD` 环境变量:
```rust
fn resolve_launch_cwd(app: &tauri::AppHandle) -> Result<PathBuf, String> {
    if let Some(state) = app.try_state::<LaunchCwd>() {
        return Ok(PathBuf::from(state.0.clone()));
    }
    std::env::var("MERGEV_CWD")
        .map(PathBuf::from)
        .or_else(|_| std::env::current_dir().map_err(|err| err.to_string()))
}
```

## 历史文件格式

`~/.config/mergev/history.json`:
```json
{
  "repositories": [
    {
      "path": "/Users/xxx/projects/myrepo",
      "name": "myrepo",
      "lastOpened": "2025-01-15T10:30:00+08:00",
      "branch": "main",
      "hasConflicts": true
    }
  ]
}
```

## 待测试项
1. ✅ 直接打开应用时显示历史列表
2. ✅ 点击历史仓库能正确切换
3. ✅ 通过 `mergev` 命令启动直接显示冲突列表
4. ✅ `MERGEV_CWD` 环境变量支持
5. ✅ 历史记录自动更新（分支、冲突状态）
6. ✅ 最多保存 20 条历史
7. ✅ 不存在的仓库路径自动过滤
