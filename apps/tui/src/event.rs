//! 键盘事件 → 状态转移。
//!
//! 所有分支只调 `App` / `MergeState` 的方法，不直接碰 Git 或磁盘，
//! 这样按键行为可以脱离终端单独测试。

use crossterm::event::{KeyCode, KeyEvent, KeyModifiers, MouseButton, MouseEvent, MouseEventKind};

use crate::app::{App, ClickAction, Confirm, Layout, View, MIN_THREE_PANE_WIDTH};
use crate::session::Side;

/// 视口高度由渲染层算出后传进来，滚动类按键需要它。
pub fn handle_key(app: &mut App, key: KeyEvent, viewport_height: usize, term_width: u16) {
    // 确认弹层和帮助层优先吃掉按键
    if let Some(pending) = app.pending {
        handle_confirm(app, key, pending);
        return;
    }
    if app.show_help {
        // 任意键关闭帮助，避免用户猜怎么退出
        app.show_help = false;
        return;
    }

    match app.view {
        View::Files => handle_files(app, key),
        View::Merge => handle_merge(app, key, viewport_height, term_width),
    }
}

/// 鼠标事件 → 点击命中区域 / 滚轮滚动。坐标基于终端全局位置。
pub fn handle_mouse(app: &mut App, mouse: MouseEvent, viewport_height: usize) {
    match mouse.kind {
        MouseEventKind::Down(MouseButton::Left) => {
            // 帮助层任意点击关闭；确认弹层只认键盘 y/n
            if app.show_help {
                app.show_help = false;
                return;
            }
            if app.pending.is_some() {
                return;
            }
            let position = ratatui::layout::Position { x: mouse.column, y: mouse.row };
            let hit = app
                .hit_zones
                .iter()
                .find(|zone| zone.rect.contains(position))
                .map(|zone| zone.action);
            if let Some(action) = hit {
                apply_click(app, action);
            }
        }
        MouseEventKind::ScrollUp => scroll(app, -3, viewport_height),
        MouseEventKind::ScrollDown => scroll(app, 3, viewport_height),
        _ => {}
    }
}

/// 滚轮：文件列表按条移动，合并视图按 3 行滚动。
fn scroll(app: &mut App, delta: isize, viewport_height: usize) {
    match app.view {
        View::Files => app.move_selection(delta.signum()),
        View::Merge => {
            if let Some(merge) = app.merge.as_mut() {
                merge.scroll_by(delta, viewport_height);
            }
        }
    }
}

fn apply_click(app: &mut App, action: ClickAction) {
    match action {
        ClickAction::SelectFile(index) => app.select_file(index),
        ClickAction::SelectConflict(index) => {
            if let Some(merge) = app.merge.as_mut() {
                merge.select(index);
            }
        }
        ClickAction::AcceptOurs => decision(app, |merge| merge.accept(Side::Ours)),
        ClickAction::AcceptTheirs => decision(app, |merge| merge.accept(Side::Theirs)),
        ClickAction::AcceptBoth => decision(app, |merge| merge.accept_both(Side::Ours)),
        ClickAction::DropBoth => decision(app, |merge| {
            merge.ignore(Side::Ours);
            merge.ignore(Side::Theirs)
        }),
        ClickAction::ResetBlock => decision(app, |merge| merge.reset()),
    }
}

/// 决策类点击，动作本身推 undo 栈，点击后把块拉回视野由外层做。
fn decision(app: &mut App, apply: impl FnOnce(&mut crate::app::MergeState) -> bool) {
    if let Some(merge) = app.merge.as_mut() {
        apply(merge);
    }
}

fn handle_confirm(app: &mut App, key: KeyEvent, pending: Confirm) {
    let confirmed = matches!(key.code, KeyCode::Char('y') | KeyCode::Char('Y'));
    let cancelled = matches!(
        key.code,
        KeyCode::Char('n') | KeyCode::Char('N') | KeyCode::Esc
    );

    if !confirmed && !cancelled {
        return;
    }
    app.pending = None;

    if cancelled {
        app.info("已取消");
        return;
    }

    match pending {
        Confirm::DiscardChanges => {
            app.close_merge();
            app.info("已放弃未保存的决策");
        }
        Confirm::QuitDirty => app.should_quit = true,
        Confirm::AcceptFile(side) => match app.accept_whole_file(side) {
            Ok(path) => app.success(format!("{path} 已整文件采用 {} 并入暂存区", side.label())),
            Err(err) => app.error(err),
        },
    }
}

fn handle_files(app: &mut App, key: KeyEvent) {
    match key.code {
        KeyCode::Char('q') => app.should_quit = true,
        KeyCode::Char('?') => app.show_help = true,

        KeyCode::Char('j') | KeyCode::Down => app.move_selection(1),
        KeyCode::Char('k') | KeyCode::Up => app.move_selection(-1),
        KeyCode::Char('g') | KeyCode::Home => app.select_file(0),
        KeyCode::Char('G') | KeyCode::End => {
            let last = app.files().len().saturating_sub(1);
            app.select_file(last);
        }

        KeyCode::Enter | KeyCode::Char('l') | KeyCode::Right => match app.open_selected() {
            Ok(()) => app.status = None,
            Err(err) => app.error(err),
        },

        // 整文件采用某一侧会覆盖工作区文件，先确认
        KeyCode::Char('y') => {
            if app.selected_path().is_some() {
                app.pending = Some(Confirm::AcceptFile(Side::Ours));
            }
        }
        KeyCode::Char('t') => {
            if app.selected_path().is_some() {
                app.pending = Some(Confirm::AcceptFile(Side::Theirs));
            }
        }

        KeyCode::Char('r') => match app.refresh() {
            Ok(()) => app.info("已刷新仓库状态"),
            Err(err) => app.error(err),
        },

        _ => {}
    }
}

fn handle_merge(app: &mut App, key: KeyEvent, viewport_height: usize, term_width: u16) {
    // 需要 MergeState 的分支统一在后面处理，先走不依赖它的
    match key.code {
        KeyCode::Char('?') => {
            app.show_help = true;
            return;
        }
        KeyCode::Esc | KeyCode::Char('h') | KeyCode::Left => {
            leave_merge(app);
            return;
        }
        KeyCode::Char('q') => {
            if app.merge.as_ref().is_some_and(|merge| merge.dirty) {
                app.pending = Some(Confirm::QuitDirty);
            } else {
                app.should_quit = true;
            }
            return;
        }
        KeyCode::Char('\t') | KeyCode::Tab => {
            toggle_layout(app, term_width);
            return;
        }
        KeyCode::Char('s') => {
            match app.save_merge() {
                Ok(path) => {
                    app.close_merge();
                    app.success(format!("{path} 已保存并加入暂存区"));
                }
                Err(err) => app.error(err),
            }
            return;
        }
        _ => {}
    }

    // Ctrl 组合键单独判断，避免和普通字符冲突
    if key.modifiers.contains(KeyModifiers::CONTROL) {
        handle_merge_ctrl(app, key, viewport_height);
        return;
    }

    let Some(merge) = app.merge.as_mut() else {
        return;
    };

    match key.code {
        // 决策
        KeyCode::Char('1') | KeyCode::Char('y') => {
            merge.accept(Side::Ours);
        }
        KeyCode::Char('2') | KeyCode::Char('t') => {
            merge.accept(Side::Theirs);
        }
        KeyCode::Char('b') => {
            merge.accept_both(Side::Ours);
        }
        KeyCode::Char('B') => {
            merge.accept_both(Side::Theirs);
        }
        KeyCode::Char('i') => {
            merge.ignore(Side::Ours);
        }
        KeyCode::Char('I') => {
            merge.ignore(Side::Theirs);
        }
        KeyCode::Char('x') => {
            // 两侧都丢弃 → Empty 决策
            merge.ignore(Side::Ours);
            merge.ignore(Side::Theirs);
        }
        KeyCode::Char('r') => {
            merge.reset();
        }

        // 块间移动
        KeyCode::Char('n') | KeyCode::Char('J') => merge.next_conflict(),
        KeyCode::Char('p') | KeyCode::Char('K') => merge.prev_conflict(),
        KeyCode::Char('N') => {
            if !merge.next_unresolved() {
                app.info("所有冲突块都已解决，按 s 保存");
                return;
            }
        }

        // 滚动
        KeyCode::Char('j') | KeyCode::Down => merge.scroll_by(1, viewport_height),
        KeyCode::Char('k') | KeyCode::Up => merge.scroll_by(-1, viewport_height),
        KeyCode::PageDown => merge.scroll_by(viewport_height as isize, viewport_height),
        KeyCode::PageUp => merge.scroll_by(-(viewport_height as isize), viewport_height),
        KeyCode::Char('g') | KeyCode::Home => merge.select(0),
        KeyCode::Char('G') | KeyCode::End => {
            let last = merge.total().saturating_sub(1);
            merge.select(last);
        }

        // 横向滚动，长行靠它
        KeyCode::Char('L') => merge.scroll_h_by(8),
        KeyCode::Char('H') => merge.scroll_h_by(-8),
        KeyCode::Char('0') => merge.h_scroll = 0,

        KeyCode::Char('u') => {
            if !merge.undo() {
                app.info("没有可撤销的操作");
                return;
            }
        }

        _ => return,
    }

    // 决策 / 移动后把当前块拉回视野
    if let Some(merge) = app.merge.as_mut() {
        merge.ensure_visible(viewport_height);
    }
}

fn handle_merge_ctrl(app: &mut App, key: KeyEvent, viewport_height: usize) {
    let Some(merge) = app.merge.as_mut() else {
        return;
    };
    match key.code {
        // vim 惯例：Ctrl+R 重做
        KeyCode::Char('r') => {
            if !merge.redo() {
                app.info("没有可重做的操作");
                return;
            }
        }
        KeyCode::Char('d') => merge.scroll_by(viewport_height as isize / 2, viewport_height),
        KeyCode::Char('u') => merge.scroll_by(-(viewport_height as isize) / 2, viewport_height),
        KeyCode::Char('c') => app.should_quit = true,
        _ => return,
    }
    if let Some(merge) = app.merge.as_mut() {
        merge.ensure_visible(viewport_height);
    }
}

fn leave_merge(app: &mut App) {
    if app.merge.as_ref().is_some_and(|merge| merge.dirty) {
        app.pending = Some(Confirm::DiscardChanges);
    } else {
        app.close_merge();
    }
}

fn toggle_layout(app: &mut App, term_width: u16) {
    // 窄终端下三栏每栏不足 30 列，不允许切过去
    if app.layout == Layout::Focus && term_width < MIN_THREE_PANE_WIDTH {
        app.info(format!(
            "终端宽度 {term_width} 列，三栏模式需要至少 {MIN_THREE_PANE_WIDTH} 列"
        ));
        return;
    }
    app.layout = app.layout.toggled();
    let label = match app.layout {
        Layout::ThreePane => "三栏模式",
        Layout::Focus => "单块聚焦模式",
    };
    app.info(format!("已切换到{label}"));
}
