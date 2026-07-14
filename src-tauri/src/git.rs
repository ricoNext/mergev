use std::path::{Path, PathBuf};
use std::process::Command;

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

/// Resolve the Git repository root for `cwd`.
pub fn resolve_repo_root(cwd: &Path) -> Result<PathBuf, RepoError> {
    let cwd_str = cwd.to_string_lossy();
    let mut cmd = Command::new("git");
    cmd.args(["-C", cwd_str.as_ref(), "rev-parse", "--show-toplevel"]);

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
        let root = String::from_utf8_lossy(&output.stdout).trim().to_string();
        if root.is_empty() {
            return Err(RepoError::Failed {
                message: "git rev-parse 返回空路径".into(),
            });
        }
        return Ok(PathBuf::from(root));
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

/// Get the current branch name for the given repository.
pub fn get_current_branch(repo_root: &Path) -> Result<String, String> {
    let mut cmd = Command::new("git");
    cmd.args([
        "-C",
        &repo_root.to_string_lossy(),
        "rev-parse",
        "--abbrev-ref",
        "HEAD",
    ]);

    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        const CREATE_NO_WINDOW: u32 = 0x08000000;
        cmd.creation_flags(CREATE_NO_WINDOW);
    }

    let output = cmd
        .output()
        .map_err(|e| format!("无法执行 git 命令: {}", e))?;

    if output.status.success() {
        let branch = String::from_utf8_lossy(&output.stdout).trim().to_string();
        Ok(branch)
    } else {
        Err("无法获取当前分支".to_string())
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
