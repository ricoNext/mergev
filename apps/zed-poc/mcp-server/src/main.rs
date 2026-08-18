//! mergev-mcp：把 mergev-core 暴露为 MCP stdio 服务器的适配层。
//!
//! 背景（阶段 0 可行性结论）：
//! Zed 扩展运行在 WASM 沙箱中，无法直接 spawn 长驻的 JSON-Lines sidecar；
//! 但 Zed 会以 Context Server（MCP over stdio）的形式代为启动并托管一个
//! 原生二进制。本 crate 就是这个二进制：它把 mergev-core 的仓库扫描、
//! 冲突解析、Accept Yours/Theirs 和保存暂存能力包装为 MCP tools，
//! 供 Zed Agent Panel（或其他 MCP 客户端）调用。
//!
//! 协议实现刻意不依赖 MCP SDK：MCP stdio 传输 = 按行分隔的 JSON-RPC 2.0，
//! 这里只实现 initialize / notifications/* / ping / tools/list / tools/call。

use std::io::{self, BufRead, Write};
use std::path::{Path, PathBuf};

use mergev_core as core;
use serde_json::{json, Value};

const PROTOCOL_VERSION: &str = "2024-11-05";
const SERVER_NAME: &str = "mergev-mcp";

fn main() {
    let stdin = io::stdin();
    let mut stdout = io::BufWriter::new(io::stdout());
    for line in stdin.lock().lines() {
        let line = match line {
            Ok(line) if !line.trim().is_empty() => line,
            Ok(_) => continue,
            Err(_) => break,
        };
        let message: Value = match serde_json::from_str(&line) {
            Ok(value) => value,
            Err(err) => {
                let _ = writeln!(
                    stdout,
                    "{}",
                    json!({
                        "jsonrpc": "2.0",
                        "id": Value::Null,
                        "error": { "code": -32700, "message": format!("解析错误: {err}") }
                    })
                );
                let _ = stdout.flush();
                continue;
            }
        };
        // 通知（无 id）不产生响应。
        if message.get("id").is_some() {
            let response = handle_request(&message);
            let _ = writeln!(stdout, "{response}");
            let _ = stdout.flush();
        } else {
            handle_notification(&message);
        }
    }
}

fn handle_notification(message: &Value) {
    let _ = message;
    // notifications/initialized、notifications/cancelled 等均无需处理。
}

fn handle_request(message: &Value) -> Value {
    let id = message.get("id").cloned().unwrap_or(Value::Null);
    let method = message.get("method").and_then(Value::as_str).unwrap_or("");
    let params = message.get("params").cloned().unwrap_or(Value::Null);
    let result = match method {
        "initialize" => Some(initialize(&params)),
        "ping" => Some(json!({})),
        "tools/list" => Some(tools_list()),
        "tools/call" => Some(tools_call(&params)),
        "shutdown" => Some(json!({})),
        _ => None,
    };
    match result {
        Some(result) => json!({ "jsonrpc": "2.0", "id": id, "result": result }),
        None => json!({
            "jsonrpc": "2.0",
            "id": id,
            "error": { "code": -32601, "message": format!("未知方法: {method}") }
        }),
    }
}

fn initialize(params: &Value) -> Value {
    // 尽量回显客户端请求的协议版本。
    let requested = params
        .get("protocolVersion")
        .and_then(Value::as_str)
        .unwrap_or(PROTOCOL_VERSION);
    json!({
        "protocolVersion": requested,
        "capabilities": { "tools": {} },
        "serverInfo": { "name": SERVER_NAME, "version": env!("CARGO_PKG_VERSION") }
    })
}

fn tools_list() -> Value {
    json!({ "tools": [tool_workspace(), tool_get_merge_document(), tool_accept_file_side(), tool_save_merge_result()] })
}

fn tool_workspace() -> Value {
    json!({
        "name": "mergev_workspace",
        "description": "扫描一个本地 Git 仓库，返回分支、当前操作（merge/rebase/cherry-pick/revert）、冲突文件列表及每个文件的冲突块数量。",
        "inputSchema": {
            "type": "object",
            "properties": {
                "root": { "type": "string", "description": "仓库根目录的绝对路径" }
            },
            "required": ["root"]
        }
    })
}

fn tool_get_merge_document() -> Value {
    json!({
        "name": "mergev_get_merge_document",
        "description": "读取一个冲突文件的三栏合并数据（ours/theirs/base、逐块冲突、当前结果与未解决数量）。",
        "inputSchema": {
            "type": "object",
            "properties": {
                "repoRoot": { "type": "string", "description": "仓库根目录的绝对路径" },
                "path": { "type": "string", "description": "仓库内相对路径" }
            },
            "required": ["repoRoot", "path"]
        }
    })
}

fn tool_accept_file_side() -> Value {
    json!({
        "name": "mergev_accept_file_side",
        "description": "整文件接受一侧：ours 保留当前分支版本，theirs 保留对方版本；处理完成后自动暂存（git add）。",
        "inputSchema": {
            "type": "object",
            "properties": {
                "repoRoot": { "type": "string", "description": "仓库根目录的绝对路径" },
                "path": { "type": "string", "description": "仓库内相对路径" },
                "side": { "type": "string", "enum": ["ours", "theirs"] }
            },
            "required": ["repoRoot", "path", "side"]
        }
    })
}

fn tool_save_merge_result() -> Value {
    json!({
        "name": "mergev_save_merge_result",
        "description": "把解决冲突后的完整文件内容写回工作区，并默认执行 git add 暂存。",
        "inputSchema": {
            "type": "object",
            "properties": {
                "repoRoot": { "type": "string", "description": "仓库根目录的绝对路径" },
                "path": { "type": "string", "description": "仓库内相对路径" },
                "result": { "type": "string", "description": "解决后的完整文件内容" },
                "stage": { "type": "boolean", "description": "是否执行 git add，默认 true" }
            },
            "required": ["repoRoot", "path", "result"]
        }
    })
}

fn tools_call(params: &Value) -> Value {
    let name = params.get("name").and_then(Value::as_str).unwrap_or("");
    let arguments = params.get("arguments").cloned().unwrap_or(json!({}));
    let outcome = match name {
        "mergev_workspace" => call_workspace(&arguments),
        "mergev_get_merge_document" => call_get_merge_document(&arguments),
        "mergev_accept_file_side" => call_accept_file_side(&arguments),
        "mergev_save_merge_result" => call_save_merge_result(&arguments),
        _ => Err(format!("未知工具: {name}")),
    };
    match outcome {
        Ok(text) => json!({
            "content": [ { "type": "text", "text": text } ],
            "isError": false
        }),
        Err(error) => json!({
            "content": [ { "type": "text", "text": error } ],
            "isError": true
        }),
    }
}

fn call_workspace(arguments: &Value) -> Result<String, String> {
    let root = required_string(arguments, "root")?;
    let snapshot = core::load_workspace_from_root(Path::new(&root))?;
    serde_json::to_string_pretty(&snapshot).map_err(|err| err.to_string())
}

fn call_get_merge_document(arguments: &Value) -> Result<String, String> {
    let (root, path) = repo_and_path(arguments)?;
    let document = core::load_merge_document(&root, &path)?;
    serde_json::to_string_pretty(&document).map_err(|err| err.to_string())
}

fn call_accept_file_side(arguments: &Value) -> Result<String, String> {
    let (root, path) = repo_and_path(arguments)?;
    let side = required_string(arguments, "side")?;
    if side != "ours" && side != "theirs" {
        return Err("side 只能是 ours 或 theirs".into());
    }
    core::accept_file_side(&root, &path, &side)?;
    Ok(format!("已接受 {side} 并暂存: {path}"))
}

fn call_save_merge_result(arguments: &Value) -> Result<String, String> {
    let (root, path) = repo_and_path(arguments)?;
    let result = required_string(arguments, "result")?;
    let stage = arguments.get("stage").and_then(Value::as_bool).unwrap_or(true);
    let detail = core::save_merge_result(&root, &path, &result, stage)?;
    serde_json::to_string_pretty(&detail).map_err(|err| err.to_string())
}

fn required_string(value: &Value, key: &str) -> Result<String, String> {
    value
        .get(key)
        .and_then(Value::as_str)
        .map(ToOwned::to_owned)
        .ok_or_else(|| format!("缺少参数: {key}"))
}

/// 与 apps/vscode/sidecar 相同的路径安全策略：
/// 拒绝绝对路径和包含 `..` 的相对路径，防止越出仓库。
fn repo_and_path(value: &Value) -> Result<(PathBuf, String), String> {
    let root = PathBuf::from(required_string(value, "repoRoot")?);
    let path = required_string(value, "path")?;
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
