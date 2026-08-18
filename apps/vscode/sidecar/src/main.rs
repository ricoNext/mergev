use std::io::{self, BufRead, Write};
use std::path::{Path, PathBuf};
use std::process::Command;

use mergev_core as core;
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};

#[derive(Debug, Deserialize)]
struct Request {
    id: Value,
    method: String,
    #[serde(default)]
    params: Value,
}

#[derive(Debug, Serialize)]
struct Response {
    id: Value,
    ok: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    result: Option<Value>,
    #[serde(skip_serializing_if = "Option::is_none")]
    error: Option<String>,
}

fn main() {
    let stdin = io::stdin();
    let mut stdout = io::BufWriter::new(io::stdout());
    for line in stdin.lock().lines() {
        let line = match line {
            Ok(line) if !line.trim().is_empty() => line,
            Ok(_) => continue,
            Err(err) => {
                write_response(
                    &mut stdout,
                    Response {
                        id: Value::Null,
                        ok: false,
                        result: None,
                        error: Some(err.to_string()),
                    },
                );
                break;
            }
        };
        let response = match serde_json::from_str::<Request>(&line) {
            Ok(request) => dispatch(request),
            Err(err) => Response {
                id: Value::Null,
                ok: false,
                result: None,
                error: Some(format!("无效的 JSON 请求: {err}")),
            },
        };
        write_response(&mut stdout, response);
    }
}

fn write_response(stdout: &mut io::BufWriter<io::Stdout>, response: Response) {
    if let Ok(value) = serde_json::to_string(&response) {
        let _ = writeln!(stdout, "{value}");
        let _ = stdout.flush();
    }
}

fn dispatch(request: Request) -> Response {
    let id = request.id.clone();
    let result = dispatch_inner(&request.method, request.params);
    match result {
        Ok(value) => Response {
            id,
            ok: true,
            result: Some(value),
            error: None,
        },
        Err(error) => Response {
            id,
            ok: false,
            result: None,
            error: Some(error),
        },
    }
}

fn dispatch_inner(method: &str, params: Value) -> Result<Value, String> {
    match method {
        "ping" => Ok(json!({ "version": env!("CARGO_PKG_VERSION") })),
        "getRepositoryWorkspace" | "getWorkspace" => {
            let root = required_string(&params, "root")?;
            ensure_git_available()?;
            let snapshot = core::load_workspace_from_root(Path::new(&root))?;
            Ok(serde_json::to_value(snapshot).map_err(|err| err.to_string())?)
        }
        "getMergeDocument" => {
            let (root, path) = repo_and_path(&params)?;
            let document = core::load_merge_document(&root, &path)?;
            Ok(serde_json::to_value(document).map_err(|err| err.to_string())?)
        }
        "getConflictCount" => {
            let (root, path) = repo_and_path(&params)?;
            Ok(json!(core::count_conflicts_for_path(&root, &path)?))
        }
        "saveMergeResult" => {
            let (root, path) = repo_and_path(&params)?;
            let result = required_string(&params, "result")?;
            let stage = params.get("stage").and_then(Value::as_bool).unwrap_or(true);
            let detail = core::save_merge_result(&root, &path, &result, stage)?;
            Ok(serde_json::to_value(detail).map_err(|err| err.to_string())?)
        }
        "acceptFileSide" => {
            let (root, path) = repo_and_path(&params)?;
            let side = required_string(&params, "side")?;
            core::accept_file_side(&root, &path, &side)?;
            Ok(json!({ "accepted": side, "path": path }))
        }
        _ => Err(format!("未知 sidecar 方法: {method}")),
    }
}

fn required_string(params: &Value, key: &str) -> Result<String, String> {
    params
        .get(key)
        .and_then(Value::as_str)
        .map(ToOwned::to_owned)
        .ok_or_else(|| format!("缺少参数: {key}"))
}

fn repo_and_path(params: &Value) -> Result<(PathBuf, String), String> {
    let root = PathBuf::from(required_string(params, "repoRoot")?);
    let path = required_string(params, "path")?;
    let relative = Path::new(&path);
    if relative.is_absolute()
        || relative
            .components()
            .any(|component| matches!(component, std::path::Component::ParentDir))
    {
        return Err("文件路径必须是仓库内的相对路径".into());
    }
    Ok((root, path))
}

fn ensure_git_available() -> Result<(), String> {
    let executable = std::env::var_os("MERGEV_GIT_PATH").unwrap_or_else(|| "git".into());
    let mut cmd = Command::new(executable);
    cmd.arg("--version");

    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        const CREATE_NO_WINDOW: u32 = 0x08000000;
        cmd.creation_flags(CREATE_NO_WINDOW);
    }

    match cmd.output() {
        Ok(output) if output.status.success() => Ok(()),
        Ok(_) => Err("未找到可用的 Git，请先安装 Git 或在 mergev 设置中配置 Git 路径。".into()),
        Err(err) if err.kind() == io::ErrorKind::NotFound => {
            Err("未找到 Git，请先安装 Git 或在 mergev 设置中配置 Git 路径。".into())
        }
        Err(err) => Err(format!("无法启动 Git，请安装 Git 或配置 Git 路径: {err}")),
    }
}
