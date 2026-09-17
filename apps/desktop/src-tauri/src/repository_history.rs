use std::fs;
use std::path::{Path, PathBuf};

use serde::{Deserialize, Serialize};

use crate::git;

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RepositoryItem {
    pub path: String,
    pub name: String,
    pub last_opened: String,
    pub branch: Option<String>,
    pub has_conflicts: Option<bool>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub worktrees: Option<Vec<git::WorktreeInfo>>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
struct RepositoryHistory {
    repositories: Vec<RepositoryItem>,
}

impl Default for RepositoryHistory {
    fn default() -> Self {
        Self {
            repositories: Vec::new(),
        }
    }
}

fn history_file_path() -> Result<PathBuf, String> {
    let home = dirs::home_dir().ok_or("无法获取用户主目录")?;
    let config_dir = home.join(".config").join("mergev");
    fs::create_dir_all(&config_dir).map_err(|e| format!("无法创建配置目录: {}", e))?;
    Ok(config_dir.join("history.json"))
}

fn load_history() -> Result<RepositoryHistory, String> {
    let path = history_file_path()?;
    if !path.exists() {
        return Ok(RepositoryHistory::default());
    }

    let content = fs::read_to_string(&path).map_err(|e| format!("读取历史文件失败: {}", e))?;
    serde_json::from_str(&content).map_err(|e| format!("解析历史文件失败: {}", e))
}

fn save_history(history: &RepositoryHistory) -> Result<(), String> {
    let path = history_file_path()?;
    let content =
        serde_json::to_string_pretty(history).map_err(|e| format!("序列化历史失败: {}", e))?;
    fs::write(&path, content).map_err(|e| format!("写入历史文件失败: {}", e))
}

pub fn update_repository_status(
    repo_root: &Path,
    branch: Option<String>,
    has_conflicts: Option<bool>,
) -> Result<(), String> {
    // Normalize to main worktree path
    let main_path =
        git::resolve_main_worktree_path(repo_root).unwrap_or_else(|_| repo_root.to_path_buf());

    let root_str = main_path.display().to_string();
    let name = main_path
        .file_name()
        .and_then(|n| n.to_str())
        .unwrap_or("unknown")
        .to_string();

    let mut history = load_history()?;
    let last_opened = chrono::Local::now().to_rfc3339();
    // 每次激活仓库时刷新该仓库的 worktree 列表，供前端渲染展开箭头
    let worktrees = git::list_worktrees(&main_path).ok();
    let item = RepositoryItem {
        path: root_str.clone(),
        name,
        last_opened,
        branch,
        has_conflicts,
        worktrees,
    };

    if let Some(existing) = history
        .repositories
        .iter_mut()
        .find(|existing| existing.path == root_str)
    {
        *existing = item;
    } else {
        history.repositories.insert(0, item);
    }

    // 只保留最近 20 个
    if history.repositories.len() > 20 {
        history.repositories.truncate(20);
    }

    save_history(&history)
}

pub fn get_recent_repositories() -> Result<Vec<RepositoryItem>, String> {
    let mut history = load_history()?;
    let mut changed = false;

    let updated: Vec<RepositoryItem> = history
        .repositories
        .drain(..)
        .filter_map(|mut item| {
            let path = PathBuf::from(&item.path);
            if !path.exists() {
                changed = true;
                return None; // 过滤掉不存在的仓库
            }

            // Migrate old worktree paths to main repo paths
            if let Ok(main_path) = git::resolve_main_worktree_path(&path) {
                let main_str = main_path.display().to_string();
                if main_str != item.path {
                    // This was a linked worktree path, update it to main
                    item.path = main_str;
                    item.name = main_path
                        .file_name()
                        .and_then(|n| n.to_str())
                        .unwrap_or("unknown")
                        .to_string();
                    changed = true;
                }
            }

            // Fill in the worktree list for old entries (once, then persisted)
            // so the sidebar can render the expand arrow.
            if item.worktrees.is_none() {
                let scan_path = PathBuf::from(&item.path);
                match git::list_worktrees(&scan_path) {
                    Ok(worktrees) => {
                        item.worktrees = Some(worktrees);
                        changed = true;
                    }
                    Err(_) => {}
                }
            }

            Some(item)
        })
        .collect();

    // Deduplicate by path (in case migration created duplicates)
    let mut seen = std::collections::HashSet::new();
    let deduplicated: Vec<RepositoryItem> = updated
        .into_iter()
        .filter(|item| seen.insert(item.path.clone()))
        .collect();

    // Persist migration results and newly filled worktree lists so the next
    // startup does not repeat the scan.
    if changed {
        history.repositories = deduplicated.clone();
        save_history(&history)?;
    }

    Ok(deduplicated)
}

pub fn remove_repository(repo_path: &str) -> Result<(), String> {
    let mut history = load_history()?;
    history.repositories.retain(|item| item.path != repo_path);
    save_history(&history)
}
