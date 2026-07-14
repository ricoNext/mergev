use std::env;
use std::fs;
use std::path::{Path, PathBuf};

#[derive(Debug, Clone)]
pub struct CliStatus {
    pub link_path: PathBuf,
    pub path_ready: bool,
}

pub fn link_path() -> Result<PathBuf, String> {
    let home = dirs_home().ok_or_else(|| "无法解析用户主目录".to_string())?;
    Ok(home.join(".local").join("bin").join(cli_name()))
}

pub fn status() -> Result<CliStatus, String> {
    let link = link_path()?;
    Ok(CliStatus {
        link_path: link,
        path_ready: is_local_bin_on_path(),
    })
}

pub fn install() -> Result<CliStatus, String> {
    let exe = current_app_exe()?;
    let link = link_path()?;
    let bin_dir = link
        .parent()
        .ok_or_else(|| "无法解析 CLI 安装目录".to_string())?;

    fs::create_dir_all(bin_dir).map_err(|e| format!("创建 {} 失败: {e}", bin_dir.display()))?;

    if path_exists(&link) {
        if !is_mergev_cli(&link)? {
            return Err(format!(
                "{} 已存在且不是 mergev 安装的命令，请先手动处理该文件",
                link.display()
            ));
        }
        fs::remove_file(&link).map_err(|e| format!("移除旧命令失败: {e}"))?;
    }

    create_cli_entry(&exe, &link)?;
    status()
}

fn cli_name() -> &'static str {
    if cfg!(windows) {
        "mergev.cmd"
    } else {
        "mergev"
    }
}

fn dirs_home() -> Option<PathBuf> {
    env::var_os("HOME")
        .or_else(|| env::var_os("USERPROFILE"))
        .map(PathBuf::from)
}

fn current_app_exe() -> Result<PathBuf, String> {
    env::current_exe().map_err(|e| format!("无法定位当前应用: {e}"))
}

fn is_local_bin_on_path() -> bool {
    let Ok(link) = link_path() else {
        return false;
    };
    let Some(bin_dir) = link.parent() else {
        return false;
    };
    let Ok(path_var) = env::var("PATH") else {
        return false;
    };

    env::split_paths(&path_var).any(|entry| entry == bin_dir)
}

fn path_exists(path: &Path) -> bool {
    path.symlink_metadata().is_ok()
}

fn is_mergev_cli(link: &Path) -> Result<bool, String> {
    match link.symlink_metadata() {
        Ok(_) => {}
        Err(err) if err.kind() == std::io::ErrorKind::NotFound => return Ok(false),
        Err(err) => return Err(format!("读取 {} 失败: {err}", link.display())),
    }

    #[cfg(unix)]
    {
        if let Ok(target) = fs::read_link(link) {
            return Ok(target
                .to_string_lossy()
                .to_ascii_lowercase()
                .contains("mergev"));
        }
    }

    let content = fs::read_to_string(link).unwrap_or_default();
    Ok(content.contains("MERGEV_CWD") && content.to_ascii_lowercase().contains("mergev"))
}

#[cfg(unix)]
fn create_cli_entry(exe: &Path, link: &Path) -> Result<(), String> {
    // Thin launcher: capture cwd, then hand off to the app binary.
    // The binary enforces the Git-repo gate and prints terminal errors.
    let script = format!(
        concat!(
            "#!/bin/sh\n",
            "export MERGEV_CWD=\"$(pwd)\"\n",
            "exec \"{}\" \"$@\"\n"
        ),
        escape_for_double_quotes(&exe.display().to_string())
    );
    fs::write(link, script).map_err(|e| format!("写入 {} 失败: {e}", link.display()))?;

    use std::os::unix::fs::PermissionsExt;
    let mut perms = fs::metadata(link)
        .map_err(|e| format!("读取权限失败: {e}"))?
        .permissions();
    perms.set_mode(0o755);
    fs::set_permissions(link, perms).map_err(|e| format!("设置可执行权限失败: {e}"))?;
    Ok(())
}

#[cfg(windows)]
fn create_cli_entry(exe: &Path, link: &Path) -> Result<(), String> {
    // Pre-check in the .cmd so errors show even when the GUI binary has no console.
    let script = format!(
        concat!(
            "@echo off\r\n",
            "set MERGEV_CWD=%CD%\r\n",
            "where git >nul 2>&1\r\n",
            "if errorlevel 1 (\r\n",
            "  echo 错误: 未找到 git，请先安装 Git。\r\n",
            "  exit /b 1\r\n",
            ")\r\n",
            "git -C \"%MERGEV_CWD%\" rev-parse --show-toplevel >nul 2>&1\r\n",
            "if errorlevel 1 (\r\n",
            "  echo 错误: 当前目录不是 Git 仓库: %MERGEV_CWD%\r\n",
            "  echo 请在仓库根目录或子目录中执行 mergev。\r\n",
            "  exit /b 1\r\n",
            ")\r\n",
            "\"{}\" %*\r\n"
        ),
        exe.display()
    );
    fs::write(link, script).map_err(|e| format!("写入 {} 失败: {e}", link.display()))
}

#[cfg(not(any(unix, windows)))]
fn create_cli_entry(_exe: &Path, _link: &Path) -> Result<(), String> {
    Err("当前平台暂不支持安装 CLI".into())
}

#[cfg(unix)]
fn escape_for_double_quotes(value: &str) -> String {
    value.replace('\\', "\\\\").replace('"', "\\\"")
}
