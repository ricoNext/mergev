//! 内嵌终端的 PTY 会话管理。
//!
//! 为什么不用 tauri-plugin-pty：其 `read` 命令在 async 上下文里直接调用
//! portable-pty 的阻塞式 `Read`，每个终端会永久占死一个 tokio worker 线程，
//! 开到 CPU 核数个终端后整个 runtime 饿死（spawn 永远排队）。
//! 这里改为：每个会话一条专属 `std::thread` 做阻塞读取，数据经
//! Tauri Channel 推送到前端，完全不占用 async runtime。
use portable_pty::{native_pty_system, CommandBuilder, PtySize};
use serde_json::json;
use std::collections::HashMap;
use std::io::{Read, Write};
use std::sync::atomic::{AtomicU32, Ordering};
use std::sync::{Arc, Mutex, RwLock};
use tauri::ipc::{Channel, InvokeResponseBody};
use tauri::State;

type PtyId = u32;

struct PtySession {
    writer: Mutex<Box<dyn Write + Send>>,
    master: Mutex<Box<dyn portable_pty::MasterPty + Send>>,
    child: Mutex<Box<dyn portable_pty::Child + Send + Sync>>,
}

#[derive(Default)]
pub struct PtyState {
    next_id: AtomicU32,
    sessions: RwLock<HashMap<PtyId, Arc<PtySession>>>,
}

#[tauri::command]
pub async fn pty_spawn(
    file: String,
    args: Vec<String>,
    cwd: Option<String>,
    cols: u16,
    rows: u16,
    env: HashMap<String, String>,
    channel: Channel<InvokeResponseBody>,
    state: State<'_, PtyState>,
) -> Result<PtyId, String> {
    let pair = native_pty_system()
        .openpty(PtySize {
            rows,
            cols,
            pixel_width: 0,
            pixel_height: 0,
        })
        .map_err(|e| e.to_string())?;

    let mut cmd = CommandBuilder::new(file);
    cmd.args(&args);
    if let Some(cwd) = cwd {
        cmd.cwd(cwd);
    }
    for (key, value) in &env {
        cmd.env(key, value);
    }

    let child = pair.slave.spawn_command(cmd).map_err(|e| e.to_string())?;
    let reader = pair.master.try_clone_reader().map_err(|e| e.to_string())?;
    let writer = pair.master.take_writer().map_err(|e| e.to_string())?;

    let id = state.next_id.fetch_add(1, Ordering::Relaxed);
    state
        .sessions
        .write()
        .unwrap()
        .insert(
            id,
            Arc::new(PtySession {
                writer: Mutex::new(writer),
                master: Mutex::new(pair.master),
                child: Mutex::new(child),
            }),
        );

    // 专属线程做阻塞读取：EOF（n==0）即会话退出，通知前端
    let exit_channel = channel.clone();
    std::thread::spawn(move || {
        let mut reader = reader;
        let mut buf = [0u8; 8192];
        loop {
            match reader.read(&mut buf) {
                Ok(0) => break,
                Ok(n) => {
                    if exit_channel
                        .send(InvokeResponseBody::Raw(buf[..n].to_vec()))
                        .is_err()
                    {
                        break;
                    }
                }
                Err(_) => break,
            }
        }
        let _ = exit_channel.send(InvokeResponseBody::Json(
            json!({ "event": "exit" }).to_string(),
        ));
    });

    Ok(id)
}

#[tauri::command]
pub async fn pty_write(
    pid: PtyId,
    data: String,
    state: State<'_, PtyState>,
) -> Result<(), String> {
    let session = state
        .sessions
        .read()
        .unwrap()
        .get(&pid)
        .ok_or("Unavailable pid")?
        .clone();
    let result = session
        .writer
        .lock()
        .unwrap()
        .write_all(data.as_bytes())
        .map_err(|e| e.to_string());
    result
}

#[tauri::command]
pub async fn pty_resize(
    pid: PtyId,
    cols: u16,
    rows: u16,
    state: State<'_, PtyState>,
) -> Result<(), String> {
    let session = state
        .sessions
        .read()
        .unwrap()
        .get(&pid)
        .ok_or("Unavailable pid")?
        .clone();
    let result = session
        .master
        .lock()
        .unwrap()
        .resize(PtySize {
            rows,
            cols,
            pixel_width: 0,
            pixel_height: 0,
        })
        .map_err(|e| e.to_string());
    result
}

#[tauri::command]
pub async fn pty_kill(pid: PtyId, state: State<'_, PtyState>) -> Result<(), String> {
    // 从会话表移除：session Arc 若无其他引用则随之释放，reader 端会读到 EOF
    let session = state
        .sessions
        .write()
        .unwrap()
        .remove(&pid)
        .ok_or("Unavailable pid")?;
    let _ = session.child.lock().unwrap().kill();
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::Write as _;

    /// 直接验证 portable-pty 用法：spawn zsh → 写命令 → 读回输出。
    /// 覆盖 pty_write / reader 线程所依赖的核心行为。
    #[test]
    fn zsh_echo_roundtrip() {
        let pair = native_pty_system()
            .openpty(PtySize {
                rows: 24,
                cols: 80,
                pixel_width: 0,
                pixel_height: 0,
            })
            .expect("openpty");

        let mut cmd = CommandBuilder::new("/bin/zsh");
        cmd.args(["-f"]); // 跳过 rc 文件，输出可控
        cmd.env("TERM", "xterm-256color");
        let mut child = pair.slave.spawn_command(cmd).expect("spawn zsh");

        let mut writer = pair.master.take_writer().expect("take_writer");
        let mut reader = pair.master.try_clone_reader().expect("clone_reader");

        // 写入 echo 命令并回车
        writer
            .write_all(b"echo MERGEV_PTY_OK\r")
            .expect("write command");

        // 阻塞读直到读到标记或超时
        let deadline = std::time::Instant::now() + std::time::Duration::from_secs(10);
        let mut collected: Vec<u8> = Vec::new();
        let mut buf = [0u8; 4096];
        loop {
            if std::time::Instant::now() > deadline {
                panic!("timeout waiting for echo output, got: {:?}", collected);
            }
            let n = reader.read(&mut buf).expect("read");
            if n == 0 {
                panic!("EOF before echo output, got: {:?}", collected);
            }
            collected.extend_from_slice(&buf[..n]);
            if collected.windows(13).any(|w| w == b"MERGEV_PTY_OK") {
                break;
            }
        }

        let _ = child.kill();
        let _ = child.wait();
    }
}
