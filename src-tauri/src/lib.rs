mod cli;
mod first_launch;
mod git;
mod repository_history;
mod workspace;

use std::path::PathBuf;

use tauri::menu::{MenuBuilder, MenuItemBuilder, SubmenuBuilder};
use tauri::{Emitter, Manager};

use workspace::{ConflictDecision, ConflictFileDetail, MergeDocument, WorkspaceSnapshot};
use repository_history::RepositoryItem;

const MENU_THEME_LIGHT: &str = "theme-light";
const MENU_THEME_DARK: &str = "theme-dark";
const MENU_THEME_SYSTEM: &str = "theme-system";
const THEME_MENU_EVENT: &str = "theme-menu-selected";

/// CLI repository gate used by `main` before the UI starts.
pub use git::enforce_cli_repo_gate;

#[derive(Clone)]
struct LaunchCwd(String);

#[allow(dead_code)]
impl LaunchCwd {
    fn get(&self) -> &str {
        &self.0
    }
}

#[tauri::command]
fn get_workspace(_app: tauri::AppHandle) -> Result<WorkspaceSnapshot, String> {
    // 简化逻辑：只看 MERGEV_CWD 环境变量
    // 有 MERGEV_CWD → 加载该目录的冲突列表
    // 无 MERGEV_CWD → 显示仓库列表
    match std::env::var("MERGEV_CWD") {
        Ok(cwd_str) => {
            // 有 MERGEV_CWD，加载该目录
            let cwd = PathBuf::from(cwd_str);
            let mut snapshot = workspace::load_workspace(&cwd)?;
            snapshot.is_cli_launch = true;

            // 添加到历史记录
            if !snapshot.root.is_empty() && !snapshot.repo_name.is_empty() {
                let _ = repository_history::add_repository(&cwd);
            }

            Ok(snapshot)
        }
        Err(_) => {
            // 无 MERGEV_CWD，返回空 workspace (前端显示历史列表)
            Ok(WorkspaceSnapshot {
                cwd: String::new(),
                root: String::new(),
                repo_name: String::new(),
                branch: String::new(),
                operation: workspace::GitOperation::None,
                ours_label: String::new(),
                theirs_label: String::new(),
                headline: String::new(),
                files: Vec::new(),
                total_blocks: 0,
                is_cli_launch: false,
            })
        }
    }
}

#[tauri::command]
fn get_mergev_cwd() -> Result<Option<String>, String> {
    Ok(std::env::var("MERGEV_CWD").ok())
}

#[tauri::command]
fn get_recent_repositories() -> Result<Vec<RepositoryItem>, String> {
    repository_history::get_recent_repositories()
}

#[tauri::command]
fn open_repository(_app: tauri::AppHandle, path: String) -> Result<(), String> {
    let repo_path = PathBuf::from(&path);

    // 验证是否为有效的 Git 仓库
    git::resolve_repo_root(&repo_path).map_err(|e| e.to_string())?;

    // 设置 MERGEV_CWD 环境变量
    std::env::set_var("MERGEV_CWD", &path);

    // 添加到历史记录
    repository_history::add_repository(&repo_path)?;

    Ok(())
}

#[tauri::command]
fn get_conflict_file(_app: tauri::AppHandle, path: String) -> Result<ConflictFileDetail, String> {
    let cwd = std::env::var("MERGEV_CWD")
        .map(PathBuf::from)
        .map_err(|_| "MERGEV_CWD 未设置".to_string())?;
    let root = git::resolve_repo_root(&cwd).map_err(|err| err.to_string())?;
    workspace::load_conflict_file(&root, &path)
}

#[tauri::command]
fn save_conflict_file(
    _app: tauri::AppHandle,
    path: String,
    decisions: Vec<String>,
    stage: bool,
) -> Result<ConflictFileDetail, String> {
    let cwd = std::env::var("MERGEV_CWD")
        .map(PathBuf::from)
        .map_err(|_| "MERGEV_CWD 未设置".to_string())?;
    let root = git::resolve_repo_root(&cwd).map_err(|err| err.to_string())?;
    let parsed = decisions
        .into_iter()
        .map(|value| parse_decision(&value))
        .collect::<Result<Vec<_>, _>>()?;
    workspace::apply_decisions_and_save(&root, &path, &parsed, stage)
}

#[tauri::command]
fn accept_file_side(_app: tauri::AppHandle, path: String, side: String) -> Result<(), String> {
    let cwd = std::env::var("MERGEV_CWD")
        .map(PathBuf::from)
        .map_err(|_| "MERGEV_CWD 未设置".to_string())?;
    let root = git::resolve_repo_root(&cwd).map_err(|err| err.to_string())?;
    workspace::accept_file_side(&root, &path, &side)
}

#[tauri::command]
fn get_merge_document(_app: tauri::AppHandle, path: String) -> Result<MergeDocument, String> {
    let cwd = std::env::var("MERGEV_CWD")
        .map(PathBuf::from)
        .map_err(|_| "MERGEV_CWD 未设置".to_string())?;
    let root = git::resolve_repo_root(&cwd).map_err(|err| err.to_string())?;
    workspace::load_merge_document(&root, &path)
}

#[tauri::command]
fn save_merge_result(
    _app: tauri::AppHandle,
    path: String,
    result: String,
    stage: bool,
) -> Result<ConflictFileDetail, String> {
    let cwd = std::env::var("MERGEV_CWD")
        .map(PathBuf::from)
        .map_err(|_| "MERGEV_CWD 未设置".to_string())?;
    let root = git::resolve_repo_root(&cwd).map_err(|err| err.to_string())?;
    workspace::save_merge_result(&root, &path, &result, stage)
}

#[tauri::command]
fn close_app(app: tauri::AppHandle) {
    app.exit(0);
}

#[tauri::command]
fn remove_repository(_app: tauri::AppHandle, path: String) -> Result<(), String> {
    repository_history::remove_repository(&path)
}

#[tauri::command]
fn is_first_launch() -> Result<bool, String> {
    first_launch::is_first_launch()
}

#[tauri::command]
fn mark_first_launch_done() -> Result<(), String> {
    first_launch::mark_first_launch_done()
}

#[tauri::command]
fn install_cli_command() -> Result<String, String> {
    cli::install().map(|status| {
        let mut message = format!(
            "已安装命令：\n{}\n\n之后可在任意 Git 仓库目录执行：\n  mergev",
            status.link_path.display()
        );
        if !status.path_ready {
            message.push_str(
                "\n\n注意：~/.local/bin 当前不在 PATH 中。\n请把它加入 shell 配置后再开新终端，例如：\n  export PATH=\"$HOME/.local/bin:$PATH\"",
            );
        }
        message
    })
}

fn parse_decision(value: &str) -> Result<ConflictDecision, String> {
    match value {
        "unresolved" => Ok(ConflictDecision::Unresolved),
        "ours" => Ok(ConflictDecision::Ours),
        "theirs" => Ok(ConflictDecision::Theirs),
        "oursThenTheirs" => Ok(ConflictDecision::OursThenTheirs),
        "theirsThenOurs" => Ok(ConflictDecision::TheirsThenOurs),
        other => Err(format!("未知决策: {other}")),
    }
}

#[allow(dead_code)]
fn resolve_launch_cwd(_app: &tauri::AppHandle) -> Result<PathBuf, String> {
    if let Some(state) = _app.try_state::<LaunchCwd>() {
        return Ok(PathBuf::from(state.0.clone()));
    }
    std::env::var("MERGEV_CWD")
        .map(PathBuf::from)
        .or_else(|_| std::env::current_dir().map_err(|err| err.to_string()))
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_dialog::init())
        .invoke_handler(tauri::generate_handler![
            get_workspace,
            get_mergev_cwd,
            get_recent_repositories,
            open_repository,
            get_conflict_file,
            save_conflict_file,
            accept_file_side,
            get_merge_document,
            save_merge_result,
            close_app,
            remove_repository,
            is_first_launch,
            mark_first_launch_done,
            install_cli_command
        ])
        .setup(|app| {
            // 简化菜单构建 - 移除非核心的 CLI 工具菜单，仅保留主题切换
            let theme_light = MenuItemBuilder::with_id(MENU_THEME_LIGHT, "亮色").build(app)?;
            let theme_dark = MenuItemBuilder::with_id(MENU_THEME_DARK, "暗色").build(app)?;
            let theme_system =
                MenuItemBuilder::with_id(MENU_THEME_SYSTEM, "跟随系统").build(app)?;

            let theme_menu = SubmenuBuilder::new(app, "主题")
                .item(&theme_light)
                .item(&theme_dark)
                .item(&theme_system)
                .build()?;

            #[cfg(target_os = "macos")]
            let menu = {
                let app_menu = SubmenuBuilder::new(app, "mergev")
                    .about(None)
                    .separator()
                    .hide()
                    .hide_others()
                    .show_all()
                    .separator()
                    .quit()
                    .build()?;

                let edit_menu = SubmenuBuilder::new(app, "编辑")
                    .cut()
                    .copy()
                    .paste()
                    .select_all()
                    .build()?;

                MenuBuilder::new(app)
                    .item(&app_menu)
                    .item(&edit_menu)
                    .item(&theme_menu)
                    .build()?
            };

            #[cfg(not(target_os = "macos"))]
            let menu = {
                let file_menu = SubmenuBuilder::new(app, "文件").quit().build()?;
                MenuBuilder::new(app)
                    .item(&file_menu)
                    .item(&theme_menu)
                    .build()?
            };

            app.set_menu(menu)?;

            let handle = app.handle().clone();
            app.on_menu_event(move |_app, event| match event.id().as_ref() {
                MENU_THEME_LIGHT => emit_theme_menu_selection(&handle, "light"),
                MENU_THEME_DARK => emit_theme_menu_selection(&handle, "dark"),
                MENU_THEME_SYSTEM => emit_theme_menu_selection(&handle, "system"),
                _ => {}
            });

            let cwd = std::env::var("MERGEV_CWD").ok().or_else(|| {
                std::env::current_dir()
                    .ok()
                    .map(|path| path.display().to_string())
            });
            if let Some(cwd) = cwd {
                app.manage(LaunchCwd(cwd));
            }

            Ok(())
        })
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}

fn emit_theme_menu_selection(app: &tauri::AppHandle, theme: &str) {
    if let Err(e) = app.emit(THEME_MENU_EVENT, theme) {
        eprintln!("Failed to emit theme-menu-selected event: {}", e);
    }
}
