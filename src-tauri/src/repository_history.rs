use std::fs;
use std::path::{Path, PathBuf};

use serde::{Deserialize, Serialize};

use crate::git;
use crate::workspace;

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RepositoryItem {
    pub path: String,
    pub name: String,
    pub last_opened: String,
    pub branch: Option<String>,
    pub has_conflicts: Option<bool>,
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

pub fn add_repository(repo_path: &Path) -> Result<(), String> {
    let root = git::resolve_repo_root(repo_path).map_err(|e| e.to_string())?;
    let root_str = root.display().to_string();
    let name = root
        .file_name()
        .and_then(|n| n.to_str())
        .unwrap_or("unknown")
        .to_string();

    let branch = git::get_current_branch(&root).ok();
    let has_conflicts = workspace::load_workspace(repo_path)
        .ok()
        .map(|ws| !ws.files.is_empty());

    let mut history = load_history()?;

    // 移除已存在的相同路径
    history.repositories.retain(|item| item.path != root_str);

    // 添加到列表开头
    history.repositories.insert(
        0,
        RepositoryItem {
            path: root_str,
            name,
            last_opened: chrono::Local::now().to_rfc3339(),
            branch,
            has_conflicts,
        },
    );

    // 只保留最近 20 个
    if history.repositories.len() > 20 {
        history.repositories.truncate(20);
    }

    save_history(&history)
}

pub fn get_recent_repositories() -> Result<Vec<RepositoryItem>, String> {
    let history = load_history()?;

    // 更新每个仓库的状态（分支和冲突信息）
    let updated: Vec<RepositoryItem> = history
        .repositories
        .into_iter()
        .filter_map(|mut item| {
            let path = PathBuf::from(&item.path);
            if !path.exists() {
                return None; // 过滤掉不存在的仓库
            }

            // 尝试更新分支和冲突状态
            if let Ok(branch) = git::get_current_branch(&path) {
                item.branch = Some(branch);
            }

            if let Ok(ws) = workspace::load_workspace(&path) {
                item.has_conflicts = Some(!ws.files.is_empty());
            }

            Some(item)
        })
        .collect();

    Ok(updated)
}

pub fn remove_repository(repo_path: &str) -> Result<(), String> {
    let mut history = load_history()?;
    history.repositories.retain(|item| item.path != repo_path);
    save_history(&history)
}
