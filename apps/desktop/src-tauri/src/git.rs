use serde::{Deserialize, Serialize};
use std::path::{Path, PathBuf};
use std::process::Command;

#[derive(Debug, Clone)]
pub struct RepoPaths {
    pub root: PathBuf,
    pub git_dir: PathBuf,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
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
    let mut lines = output
        .lines()
        .map(str::trim)
        .filter(|line| !line.is_empty());
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
    cmd.args([
        "-C",
        &repo_path.to_string_lossy(),
        "worktree",
        "list",
        "--porcelain",
    ]);

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

/// Run a git command in `cwd` and return trimmed stdout on success.
fn run_git(cwd: &Path, args: &[&str], label: &str) -> Result<String, RepoError> {
    let mut cmd = Command::new("git");
    cmd.arg("-C").arg(cwd).args(args);

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
        let stderr = String::from_utf8_lossy(&output.stderr).trim().to_string();
        return Err(RepoError::Failed {
            message: format!("{label} 失败: {stderr}"),
        });
    }

    Ok(String::from_utf8_lossy(&output.stdout).trim().to_string())
}

/// Canonicalize a path for comparison; fall back to the original path when the
/// target does not exist. Avoids false negatives from symlinks
/// (e.g. macOS `/var` vs `/private/var`) and trailing separators.
pub fn normalize_path(path: &Path) -> PathBuf {
    path.canonicalize().unwrap_or_else(|_| path.to_path_buf())
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
            let branch_name = branch_ref.strip_prefix("refs/heads/").unwrap_or(branch_ref);
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

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct WorktreeStatus {
    #[serde(skip_serializing_if = "Option::is_none")]
    pub branch: Option<String>,
    /// 未提交的修改数（含未跟踪文件）
    pub uncommitted_changes: usize,
    /// 仅存在于当前分支、未合并到任何其他分支/远程的提交数
    #[serde(skip_serializing_if = "Option::is_none")]
    pub unmerged_commits: Option<usize>,
}

/// Check a worktree's branch state before removal:
/// uncommitted changes and commits unique to its branch.
pub fn worktree_status(worktree_path: &Path) -> Result<WorktreeStatus, RepoError> {
    let branch = run_git(
        worktree_path,
        &["rev-parse", "--abbrev-ref", "HEAD"],
        "git rev-parse",
    )
    .ok()
    .filter(|name| name != "HEAD");

    let porcelain = run_git(worktree_path, &["status", "--porcelain"], "git status")?;
    let uncommitted_changes = porcelain.lines().filter(|l| !l.trim().is_empty()).count();

    let unmerged_commits = branch.as_ref().and_then(|branch| {
        let args = [
            "rev-list".to_string(),
            "--count".to_string(),
            "--exclude".to_string(),
            format!("refs/heads/{branch}"),
            "--branches".to_string(),
            "--remotes".to_string(),
            "HEAD".to_string(),
        ];
        let arg_refs: Vec<&str> = args.iter().map(String::as_str).collect();
        run_git(worktree_path, &arg_refs, "git rev-list")
            .ok()
            .and_then(|out| out.trim().parse::<usize>().ok())
    });

    Ok(WorktreeStatus {
        branch,
        uncommitted_changes,
        unmerged_commits,
    })
}

/// Remove a worktree. The path is validated against the repo's worktree list
/// before running the removal.
pub fn remove_worktree(
    repo_root: &Path,
    worktree_path: &Path,
    force: bool,
) -> Result<(), RepoError> {
    let worktrees = list_worktrees(repo_root)?;
    let is_known = worktrees
        .iter()
        .any(|w| normalize_path(Path::new(&w.path)) == normalize_path(worktree_path));
    if !is_known {
        return Err(RepoError::Failed {
            message: format!(
                "指定的路径不是该仓库的 worktree: {}",
                worktree_path.display()
            ),
        });
    }

    let mut args = vec!["worktree".to_string(), "remove".to_string()];
    if force {
        args.push("--force".to_string());
    }
    args.push(worktree_path.display().to_string());
    let arg_refs: Vec<&str> = args.iter().map(String::as_str).collect();
    run_git(repo_root, &arg_refs, "git worktree remove")?;
    Ok(())
}

/// Check whether a local branch exists in the repository.
fn branch_exists(repo_root: &Path, branch: &str) -> Result<bool, RepoError> {
    let mut cmd = Command::new("git");
    cmd.arg("-C").arg(repo_root).args([
        "show-ref",
        "--verify",
        "--quiet",
        &format!("refs/heads/{branch}"),
    ]);

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
    Ok(output.status.success())
}

/// List all local branch names (`refs/heads`), short form.
pub fn list_local_branches(repo_root: &Path) -> Result<Vec<String>, RepoError> {
    let output = run_git(
        repo_root,
        &[
            "for-each-ref",
            "refs/heads",
            "--format=%(refname:short)",
            "--sort=refname",
        ],
        "git for-each-ref",
    )?;
    Ok(output
        .lines()
        .map(str::trim)
        .filter(|line| !line.is_empty())
        .map(ToString::to_string)
        .collect())
}

/// Create a worktree for `branch`. If the branch already exists it is checked
/// out, otherwise a new branch is created at `base` (or HEAD when omitted).
/// The worktree directory is placed under `parent_dir` (created if missing),
/// or as a sibling of the main worktree when omitted, named `<repo>-<branch>`.
pub fn add_worktree(
    repo_root: &Path,
    branch: &str,
    base: Option<&str>,
    parent_dir: Option<&Path>,
) -> Result<WorktreeInfo, RepoError> {
    let branch = branch.trim();
    if branch.is_empty()
        || branch.contains(char::is_whitespace)
        || branch.starts_with('-')
        || branch.contains("..")
    {
        return Err(RepoError::Failed {
            message: format!("无效的分支名: {branch}"),
        });
    }

    let main = resolve_main_worktree_path(repo_root)?;
    let repo_name = main
        .file_name()
        .and_then(|n| n.to_str())
        .ok_or_else(|| RepoError::Failed {
            message: "无法解析仓库名称".to_string(),
        })?;
    // 存放目录：优先使用调用方指定的（不存在则创建），否则主 worktree 的兄弟目录
    let parent: PathBuf = match parent_dir {
        Some(dir) => {
            std::fs::create_dir_all(dir).map_err(|err| RepoError::Failed {
                message: format!("无法创建存放目录 {}: {err}", dir.display()),
            })?;
            dir.to_path_buf()
        }
        None => main.parent().ok_or_else(|| RepoError::Failed {
            message: "无法解析仓库父目录".to_string(),
        })?.to_path_buf(),
    };

    // 目录名中不允许出现 /，用 - 代替；目标目录已存在时追加序号
    let safe_branch = branch.replace('/', "-");
    let base_name = format!("{repo_name}-{safe_branch}");
    let mut target = parent.join(&base_name);
    let mut n = 2;
    while target.exists() {
        target = parent.join(format!("{base_name}-{n}"));
        n += 1;
        if n > 100 {
            return Err(RepoError::Failed {
                message: "无法找到可用的工作树目录名".to_string(),
            });
        }
    }

    let exists = branch_exists(repo_root, branch)?;
    let mut args = vec!["worktree".to_string(), "add".to_string()];
    if !exists {
        args.push("-b".to_string());
        args.push(branch.to_string());
    }
    args.push(target.display().to_string());
    if exists {
        // 已有分支：直接检出（忽略 base）
        args.push(branch.to_string());
    } else if let Some(base) = base.map(str::trim).filter(|b| !b.is_empty()) {
        // 新建分支：基于指定基点
        args.push(base.to_string());
    }
    let arg_refs: Vec<&str> = args.iter().map(String::as_str).collect();
    run_git(repo_root, &arg_refs, "git worktree add")?;

    Ok(WorktreeInfo {
        path: target.display().to_string(),
        branch: Some(branch.to_string()),
        is_main: false,
        locked: false,
    })
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

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;
    use std::process::Command;

    struct TempRepo {
        main: PathBuf,
    }

    impl TempRepo {
        fn new() -> Self {
            let unique = std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_nanos();
            let main = std::env::temp_dir().join(format!(
                "mergev-git-rs-test-{}-{unique}",
                std::process::id()
            ));
            fs::create_dir_all(&main).unwrap();
            let git = |cwd: &Path, args: &[&str]| {
                let out = Command::new("git")
                    .arg("-C")
                    .arg(cwd)
                    .args(args)
                    .output()
                    .unwrap();
                assert!(
                    out.status.success(),
                    "git {args:?} failed: {}",
                    String::from_utf8_lossy(&out.stderr)
                );
            };
            git(&main, &["init", "-q"]);
            git(&main, &["config", "user.name", "t"]);
            git(&main, &["config", "user.email", "t@t.test"]);
            fs::write(main.join("a.txt"), "base\n").unwrap();
            git(&main, &["add", "."]);
            git(&main, &["commit", "-q", "-m", "base"]);
            Self { main }
        }

        fn git(&self, args: &[&str]) {
            let out = Command::new("git")
                .arg("-C")
                .arg(&self.main)
                .args(args)
                .output()
                .unwrap();
            assert!(
                out.status.success(),
                "git {args:?} failed: {}",
                String::from_utf8_lossy(&out.stderr)
            );
        }

        fn write_and_commit_conflict_pair(&self, file: &str, ours: &str, theirs: &str, base: &str) {
            // theirs 分支
            self.git(&["checkout", "-q", "-b", &format!("{file}-theirs")]);
            fs::write(self.main.join(file), format!("{theirs}\n")).unwrap();
            self.git(&["commit", "-q", "-am", "theirs"]);
            self.git(&["checkout", "-q", "-b", &format!("{file}-ours"), "HEAD~1"]);
            fs::write(self.main.join(file), format!("{ours}\n")).unwrap();
            self.git(&["commit", "-q", "-am", "ours"]);
            assert!(!Command::new("git")
                .arg("-C")
                .arg(&self.main)
                .arg("merge")
                .arg(format!("{file}-theirs"))
                .output()
                .unwrap()
                .status
                .success());
            let _ = base;
        }
    }

    impl Drop for TempRepo {
        fn drop(&mut self) {
            let _ = Command::new("git")
                .arg("-C")
                .arg(&self.main)
                .args(["worktree", "remove", "--force", "."])
                .output();
            let _ = fs::remove_dir_all(&self.main);
        }
    }

    #[test]
    fn classify_and_workspace_reflect_linked_worktree_conflicts() {
        let repo = TempRepo::new();

        // 主 worktree：a.txt 冲突
        repo.write_and_commit_conflict_pair("a.txt", "ours-a", "theirs-a", "base-a");

        // linked worktree：b.txt 冲突
        let linked = repo.main.parent().unwrap().join(format!(
            "{}-wt-side",
            repo.main.file_name().unwrap().to_string_lossy()
        ));
        repo.git(&["worktree", "add", linked.to_str().unwrap(), "-b", "side"]);
        let linked_git = |args: &[&str]| {
            let out = Command::new("git")
                .arg("-C")
                .arg(&linked)
                .args(args)
                .output()
                .unwrap();
            assert!(
                out.status.success(),
                "git {args:?} failed: {}",
                String::from_utf8_lossy(&out.stderr)
            );
        };
        fs::write(linked.join("b.txt"), "base-b\n").unwrap();
        linked_git(&["add", "b.txt"]);
        linked_git(&["commit", "-q", "-m", "base b"]);
        linked_git(&["checkout", "-q", "-b", "side-theirs"]);
        fs::write(linked.join("b.txt"), "theirs-b\n").unwrap();
        linked_git(&["commit", "-q", "-am", "theirs"]);
        linked_git(&["checkout", "-q", "side"]);
        fs::write(linked.join("b.txt"), "ours-b\n").unwrap();
        linked_git(&["commit", "-q", "-am", "ours"]);
        let merge = Command::new("git")
            .arg("-C")
            .arg(&linked)
            .arg("merge")
            .arg("side-theirs")
            .output()
            .unwrap();
        assert!(
            !merge.status.success(),
            "expected conflict in linked worktree"
        );

        // 模拟 activate_repository 对 linked worktree 的处理
        let classification = classify_launch_path(&linked).unwrap();
        assert!(!classification.is_main);
        assert_eq!(
            normalize_path(&classification.active_path),
            normalize_path(&linked)
        );
        let ws = mergev_core::load_workspace_from_root(&classification.active_path).unwrap();
        assert_eq!(ws.branch, "side");
        assert_eq!(ws.files.len(), 1, "linked workspace should only see b.txt");
        assert_eq!(ws.files[0].path, "b.txt");

        // 模拟 activate_repository 对主 worktree 的处理
        let cm = classify_launch_path(&repo.main).unwrap();
        assert!(cm.is_main);
        let ws2 = mergev_core::load_workspace_from_root(&cm.active_path).unwrap();
        assert_eq!(ws2.files.len(), 1, "main workspace should only see a.txt");
        assert_eq!(ws2.files[0].path, "a.txt");
    }
}
