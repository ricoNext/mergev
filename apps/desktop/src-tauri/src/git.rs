use std::path::{Path, PathBuf};
use std::process::Command;
use serde::Serialize;

#[derive(Debug, Clone)]
pub struct RepoPaths {
    pub root: PathBuf,
    pub git_dir: PathBuf,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct WorktreeInfo {
    pub path: String,
    pub branch: Option<String>,
    pub is_main: bool,
    pub locked: bool,
}

#[derive(Debug, Clone)]
pub struct LaunchPathClassification {
    pub main_path: PathBuf,
    pub active_path: PathBuf,
    pub is_main: bool,
}

#[derive(Debug, Clone)]
pub enum RepoError {
    GitNotFound,
    NotARepository { cwd: PathBuf },
    Failed { message: String },
}

impl std::fmt::Display for RepoError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::GitNotFound => {
                write!(f, "错误: 未找到 git，请先安装 Git。")
            }
            Self::NotARepository { cwd } => {
                write!(
                    f,
                    "错误: 当前目录不是 Git 仓库: {}\n请在仓库根目录或子目录中执行 mergev。",
                    cwd.display()
                )
            }
            Self::Failed { message } => {
                write!(f, "错误: 无法检测 Git 仓库: {message}")
            }
        }
    }
}

pub fn resolve_repo_paths(cwd: &Path) -> Result<RepoPaths, RepoError> {
    let output = git_rev_parse(cwd, &["--show-toplevel", "--absolute-git-dir"])?;
    let mut lines = output.lines().map(str::trim).filter(|line| !line.is_empty());
    let root = lines.next().ok_or_else(|| RepoError::Failed {
        message: "git rev-parse 返回空仓库路径".into(),
    })?;
    let git_dir = lines.next().ok_or_else(|| RepoError::Failed {
        message: "git rev-parse 返回空 Git 目录".into(),
    })?;

    Ok(RepoPaths {
        root: PathBuf::from(root),
        git_dir: PathBuf::from(git_dir),
    })
}

/// Resolve the Git repository root for `cwd`.
pub fn resolve_repo_root(cwd: &Path) -> Result<PathBuf, RepoError> {
    resolve_repo_paths(cwd).map(|paths| paths.root)
}

fn git_rev_parse(cwd: &Path, args: &[&str]) -> Result<String, RepoError> {
    let cwd_str = cwd.to_string_lossy();
    let mut cmd = Command::new("git");
    cmd.args(["-C", cwd_str.as_ref(), "rev-parse"]);
    cmd.args(args);

    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        const CREATE_NO_WINDOW: u32 = 0x08000000;
        cmd.creation_flags(CREATE_NO_WINDOW);
    }

    let output = cmd.output();

    let output = match output {
        Ok(output) => output,
        Err(err) if err.kind() == std::io::ErrorKind::NotFound => {
            return Err(RepoError::GitNotFound);
        }
        Err(err) => {
            return Err(RepoError::Failed {
                message: err.to_string(),
            });
        }
    };

    if output.status.success() {
        let stdout = String::from_utf8_lossy(&output.stdout).trim().to_string();
        if stdout.is_empty() {
            return Err(RepoError::Failed {
                message: "git rev-parse 返回空路径".into(),
            });
        }
        return Ok(stdout);
    }

    let stderr = String::from_utf8_lossy(&output.stderr).to_ascii_lowercase();
    if stderr.contains("not a git repository") {
        return Err(RepoError::NotARepository {
            cwd: cwd.to_path_buf(),
        });
    }

    let detail = String::from_utf8_lossy(&output.stderr).trim().to_string();
    if detail.is_empty() {
        Err(RepoError::NotARepository {
            cwd: cwd.to_path_buf(),
        })
    } else {
        Err(RepoError::Failed { message: detail })
    }
}

/// When launched via the `mergev` CLI (`MERGEV_CWD` is set), require a Git repo
/// before the desktop UI starts. Dock / Finder launches skip this gate.
pub fn enforce_cli_repo_gate() {
    let Some(cwd) = std::env::var_os("MERGEV_CWD") else {
        return;
    };
    let cwd = PathBuf::from(cwd);

    if let Err(err) = resolve_repo_root(&cwd) {
        attach_cli_console();
        print_cli_error(&err.to_string());
        std::process::exit(1);
    }
}

#[cfg(windows)]
fn attach_cli_console() {
    // Release builds use the Windows subsystem (no console). Re-attach to the
    // parent terminal so CLI errors remain visible when launched via mergev.cmd.
    #[link(name = "kernel32")]
    extern "system" {
        fn AttachConsole(dw_process_id: u32) -> i32;
    }
    const ATTACH_PARENT_PROCESS: u32 = u32::MAX;
    unsafe {
        AttachConsole(ATTACH_PARENT_PROCESS);
    }
}

#[cfg(not(windows))]
fn attach_cli_console() {}

#[cfg(windows)]
fn print_cli_error(message: &str) {
    use std::ffi::c_void;
    use std::ptr::null_mut;

    #[link(name = "kernel32")]
    extern "system" {
        fn GetStdHandle(n_std_handle: u32) -> *mut c_void;
        fn WriteConsoleW(
            h_console_output: *mut c_void,
            lp_buffer: *const u16,
            n_number_of_chars_to_write: u32,
            lp_number_of_chars_written: *mut u32,
            lp_reserved: *mut c_void,
        ) -> i32;
    }

    const STD_ERROR_HANDLE: u32 = (-12i32) as u32;
    let mut text: Vec<u16> = format!("{message}\n").encode_utf16().collect();
    let mut written = 0u32;
    let ok = unsafe {
        WriteConsoleW(
            GetStdHandle(STD_ERROR_HANDLE),
            text.as_mut_ptr(),
            text.len() as u32,
            &mut written,
            null_mut(),
        )
    };

    if ok == 0 {
        eprintln!("{message}");
        let _ = std::io::Write::flush(&mut std::io::stderr());
    }
}

#[cfg(not(windows))]
fn print_cli_error(message: &str) {
    eprintln!("{message}");
    let _ = std::io::Write::flush(&mut std::io::stderr());
}

/// List all worktrees for a given repository
pub fn list_worktrees(repo_path: &Path) -> Result<Vec<WorktreeInfo>, RepoError> {
    let mut cmd = Command::new("git");
    cmd.args(["-C", &repo_path.to_string_lossy(), "worktree", "list", "--porcelain"]);

    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        const CREATE_NO_WINDOW: u32 = 0x08000000;
        cmd.creation_flags(CREATE_NO_WINDOW);
    }

    let output = cmd.output().map_err(|err| {
        if err.kind() == std::io::ErrorKind::NotFound {
            RepoError::GitNotFound
        } else {
            RepoError::Failed {
                message: err.to_string(),
            }
        }
    })?;

    if !output.status.success() {
        let stderr = String::from_utf8_lossy(&output.stderr);
        return Err(RepoError::Failed {
            message: format!("git worktree list 失败: {}", stderr),
        });
    }

    let stdout = String::from_utf8_lossy(&output.stdout);
    parse_worktree_list_porcelain(&stdout)
}

fn parse_worktree_list_porcelain(output: &str) -> Result<Vec<WorktreeInfo>, RepoError> {
    let mut worktrees = Vec::new();
    let mut current_path: Option<String> = None;
    let mut current_branch: Option<String> = None;
    let mut current_locked = false;
    let mut is_first = true;

    for line in output.lines() {
        let line = line.trim();
        if line.is_empty() {
            // 空行表示一个 worktree 条目结束
            if let Some(path) = current_path.take() {
                worktrees.push(WorktreeInfo {
                    path,
                    branch: current_branch.take(),
                    is_main: is_first,
                    locked: current_locked,
                });
                is_first = false;
                current_locked = false;
            }
        } else if let Some(path) = line.strip_prefix("worktree ") {
            current_path = Some(path.to_string());
        } else if let Some(branch_ref) = line.strip_prefix("branch ") {
            // branch refs/heads/main -> main
            let branch_name = branch_ref
                .strip_prefix("refs/heads/")
                .unwrap_or(branch_ref);
            current_branch = Some(branch_name.to_string());
        } else if line.starts_with("locked") {
            current_locked = true;
        }
        // 忽略其他字段如 HEAD, bare, detached
    }

    // 处理最后一个 worktree（如果没有尾随空行）
    if let Some(path) = current_path {
        worktrees.push(WorktreeInfo {
            path,
            branch: current_branch,
            is_main: is_first,
            locked: current_locked,
        });
    }

    Ok(worktrees)
}

/// Resolve the main worktree path from any path within a repository
pub fn resolve_main_worktree_path(path: &Path) -> Result<PathBuf, RepoError> {
    let worktrees = list_worktrees(path)?;
    worktrees
        .into_iter()
        .find(|w| w.is_main)
        .map(|w| PathBuf::from(w.path))
        .ok_or_else(|| RepoError::Failed {
            message: "未找到主工作树".to_string(),
        })
}

/// Classify a launch path: determine main repo path, active worktree path, and whether it's the main worktree
pub fn classify_launch_path(path: &Path) -> Result<LaunchPathClassification, RepoError> {
    let repo_paths = resolve_repo_paths(path)?;
    let active_path = repo_paths.root.clone();
    
    // List all worktrees to find the main one
    let worktrees = list_worktrees(&active_path)?;
    
    let main_worktree = worktrees
        .iter()
        .find(|w| w.is_main)
        .ok_or_else(|| RepoError::Failed {
            message: "未找到主工作树".to_string(),
        })?;
    
    let main_path = PathBuf::from(&main_worktree.path);
    let is_main = main_path == active_path;
    
    Ok(LaunchPathClassification {
        main_path,
        active_path,
        is_main,
    })
}
