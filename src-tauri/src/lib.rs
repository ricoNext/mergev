mod cli;

use tauri::menu::{MenuBuilder, MenuItemBuilder, SubmenuBuilder};
use tauri::Manager;
use tauri_plugin_dialog::{DialogExt, MessageDialogKind};

const MENU_INSTALL_CLI: &str = "install-cli";
const MENU_UNINSTALL_CLI: &str = "uninstall-cli";

#[tauri::command]
fn greet(name: &str) -> String {
    format!("Hello, {}! You've been greeted from Rust!", name)
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_dialog::init())
        .invoke_handler(tauri::generate_handler![greet])
        .setup(|app| {
            let install_cli =
                MenuItemBuilder::with_id(MENU_INSTALL_CLI, "安装 mergev 命令到 PATH").build(app)?;
            let uninstall_cli =
                MenuItemBuilder::with_id(MENU_UNINSTALL_CLI, "从 PATH 移除 mergev 命令")
                    .build(app)?;

            let tools_menu = SubmenuBuilder::new(app, "工具")
                .item(&install_cli)
                .item(&uninstall_cli)
                .build()?;

            #[cfg(target_os = "macos")]
            let menu = {
                let app_menu = SubmenuBuilder::new(app, "Mergev")
                    .about(None)
                    .separator()
                    .services()
                    .separator()
                    .hide()
                    .hide_others()
                    .show_all()
                    .separator()
                    .quit()
                    .build()?;

                let edit_menu = SubmenuBuilder::new(app, "编辑")
                    .undo()
                    .redo()
                    .separator()
                    .cut()
                    .copy()
                    .paste()
                    .select_all()
                    .build()?;

                MenuBuilder::new(app)
                    .item(&app_menu)
                    .item(&edit_menu)
                    .item(&tools_menu)
                    .build()?
            };

            #[cfg(not(target_os = "macos"))]
            let menu = {
                let file_menu = SubmenuBuilder::new(app, "文件").quit().build()?;
                MenuBuilder::new(app)
                    .item(&file_menu)
                    .item(&tools_menu)
                    .build()?
            };

            app.set_menu(menu)?;

            let handle = app.handle().clone();
            app.on_menu_event(move |_app, event| match event.id().as_ref() {
                MENU_INSTALL_CLI => handle_install_cli(&handle),
                MENU_UNINSTALL_CLI => handle_uninstall_cli(&handle),
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

/// Working directory from which Mergev was launched (e.g. via the `mergev` CLI).
#[derive(Clone)]
#[allow(dead_code)]
struct LaunchCwd(String);

fn handle_install_cli(app: &tauri::AppHandle) {
    match cli::install() {
        Ok(status) => {
            let mut message = format!(
                "已安装命令：\n{}\n\n之后可在任意 Git 仓库目录执行：\n  mergev",
                status.link_path.display()
            );
            if !status.path_ready {
                message.push_str(
                    "\n\n注意：~/.local/bin 当前不在 PATH 中。\n请把它加入 shell 配置后再开新终端，例如：\n  export PATH=\"$HOME/.local/bin:$PATH\"",
                );
            }
            app.dialog()
                .message(message)
                .kind(MessageDialogKind::Info)
                .title("安装 mergev 命令")
                .show(|_| {});
        }
        Err(error) => {
            app.dialog()
                .message(error)
                .kind(MessageDialogKind::Error)
                .title("安装失败")
                .show(|_| {});
        }
    }
}

fn handle_uninstall_cli(app: &tauri::AppHandle) {
    match cli::uninstall() {
        Ok(status) => {
            let message = if status.installed {
                format!("未能完全移除：{}", status.link_path.display())
            } else {
                format!("已从 PATH 移除：\n{}", status.link_path.display())
            };
            app.dialog()
                .message(message)
                .kind(MessageDialogKind::Info)
                .title("移除 mergev 命令")
                .show(|_| {});
        }
        Err(error) => {
            app.dialog()
                .message(error)
                .kind(MessageDialogKind::Error)
                .title("移除失败")
                .show(|_| {});
        }
    }
}
