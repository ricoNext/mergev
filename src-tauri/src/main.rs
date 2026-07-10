// Prevents additional console window on Windows in release, DO NOT REMOVE!!
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

fn main() {
    // Must run before any Tauri / AppKit initialization so a bad CLI cwd
    // never flashes a desktop window.
    mergev_lib::enforce_cli_repo_gate();
    mergev_lib::run();
}
