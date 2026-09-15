//! 渲染层。只读 `App` 状态，不做任何状态变更。
//!
//! 所有横向排布都走 `crate::text` 的列宽函数，不能用字符数，否则 CJK 会错位。

use mergev_core::{ConflictFileSummary, MergeRowKind, ResultSource, SideStatus};
use ratatui::layout::{Constraint, Direction, Layout as RLayout, Rect};
use ratatui::style::{Color, Modifier, Style};
use ratatui::text::{Line, Span};
use ratatui::widgets::{Block, Borders, Clear, Paragraph};
use ratatui::Frame;

use crate::app::{App, ClickAction, Confirm, HitZone, Layout, Level, MergeState, View, MIN_THREE_PANE_WIDTH};
use crate::session::{Pane, Resolution, Side, SideVerdict};
use crate::text::{display_width, slice_columns, truncate_columns, truncate_columns_start};

const GUTTER: usize = 5;

// 与 GUI 的配色对齐：Yours 偏蓝、Theirs 偏紫、冲突红、单方改动绿
const OURS_COLOR: Color = Color::Cyan;
const THEIRS_COLOR: Color = Color::Magenta;
const CONFLICT_COLOR: Color = Color::Red;
const CHANGE_COLOR: Color = Color::Green;
const DIM: Color = Color::DarkGray;

pub fn draw(frame: &mut Frame, app: &mut App) {
    let area = frame.area();
    let chunks = RLayout::default()
        .direction(Direction::Vertical)
        .constraints([
            Constraint::Length(1),
            Constraint::Min(1),
            Constraint::Length(1),
        ])
        .split(area);

    // 点击区域每次绘制重建；拿出去填，避免和 app 的只读借用打架
    let mut zones = std::mem::take(&mut app.hit_zones);

    draw_header(frame, app, chunks[0]);
    match app.view {
        View::Files => draw_files(frame, app, chunks[1], &mut zones),
        View::Merge => draw_merge(frame, app, chunks[1], &mut zones),
    }
    draw_footer(frame, app, chunks[2]);

    if app.show_help {
        draw_help(frame, area);
    }
    if let Some(pending) = app.pending {
        draw_confirm(frame, area, pending);
    }

    // 弹层盖住全屏时，下层元素不允许被点击命中
    if app.show_help || app.pending.is_some() {
        zones.clear();
    }
    app.hit_zones = zones;
}

fn draw_header(frame: &mut Frame, app: &App, area: Rect) {
    let snapshot = &app.snapshot;
    let mut spans = vec![
        Span::styled(
            format!(" {} ", snapshot.repo_name),
            Style::default().fg(Color::Black).bg(Color::Cyan).add_modifier(Modifier::BOLD),
        ),
        Span::raw(" "),
        Span::styled(snapshot.headline.clone(), Style::default().fg(Color::White)),
    ];

    if let Some(merge) = app.merge.as_ref() {
        let resolved = merge.total().saturating_sub(merge.unresolved());
        spans.push(Span::raw("  "));
        spans.push(Span::styled(
            format!("{}/{} 已解决", resolved, merge.total()),
            Style::default().fg(if merge.unresolved() == 0 {
                CHANGE_COLOR
            } else {
                Color::Yellow
            }),
        ));
        if merge.dirty {
            spans.push(Span::styled(" ●未保存", Style::default().fg(Color::Yellow)));
        }
    } else {
        spans.push(Span::raw("  "));
        spans.push(Span::styled(
            format!("{} 个冲突文件", snapshot.files.len()),
            Style::default().fg(DIM),
        ));
    }

    frame.render_widget(Paragraph::new(Line::from(spans)), area);
}

fn draw_footer(frame: &mut Frame, app: &App, area: Rect) {
    if let Some(status) = app.status.as_ref() {
        let color = match status.level {
            Level::Info => Color::White,
            Level::Success => CHANGE_COLOR,
            Level::Error => CONFLICT_COLOR,
        };
        let text = truncate_columns(&status.text, area.width as usize);
        frame.render_widget(
            Paragraph::new(Line::from(Span::styled(text, Style::default().fg(color)))),
            area,
        );
        return;
    }

    let hint = match app.view {
        View::Files => "j/k 选择  Enter 打开  y/t 整文件接受  r 刷新  ? 帮助  q 退出",
        View::Merge => {
            "1/2 接受  !/@ 忽略  b/B 都要  n/p 冲突  Tab 布局  u 撤销  s 保存  Esc 返回  ? 帮助"
        }
    };
    let text = truncate_columns(hint, area.width as usize);
    frame.render_widget(
        Paragraph::new(Line::from(Span::styled(text, Style::default().fg(DIM)))),
        area,
    );
}

fn draw_files(frame: &mut Frame, app: &App, area: Rect, zones: &mut Vec<HitZone>) {
    let block = Block::default()
        .borders(Borders::ALL)
        .title(" 冲突文件 ")
        .border_style(Style::default().fg(DIM));
    let inner = block.inner(area);
    frame.render_widget(block, area);

    if app.files().is_empty() {
        let msg = if app.snapshot.operation == mergev_core::GitOperation::None {
            "当前没有进行中的合并操作。"
        } else {
            "没有冲突文件，可以继续 git commit 了。"
        };
        frame.render_widget(
            Paragraph::new(Line::from(Span::styled(msg, Style::default().fg(DIM)))),
            inner,
        );
        return;
    }

    let height = inner.height as usize;
    // 让选中项始终在视口内：以选中项为中心的简单窗口
    let offset = app
        .selected_file
        .saturating_sub(height / 2)
        .min(app.files().len().saturating_sub(height.max(1)));

    let lines: Vec<Line> = app
        .files()
        .iter()
        .enumerate()
        .skip(offset)
        .take(height)
        .map(|(index, file)| {
            // 文件行整体可点击，点击选中（不打开，与键盘 j/k 后 Enter 的节奏一致）
            zones.push(HitZone {
                rect: Rect {
                    x: inner.x,
                    y: inner.y + (index - offset) as u16,
                    width: inner.width,
                    height: 1,
                },
                action: ClickAction::SelectFile(index),
            });
            file_line(file, index == app.selected_file, inner.width as usize)
        })
        .collect();

    frame.render_widget(Paragraph::new(lines), inner);
}

fn file_line(file: &ConflictFileSummary, selected: bool, width: usize) -> Line<'static> {
    let marker = if selected { "▸ " } else { "  " };
    let count = match file.conflict_count {
        Some(count) => format!("{count} 块"),
        None => "?".to_string(),
    };
    let status = format!(
        "{}/{}",
        side_status_label(file.ours_status),
        side_status_label(file.theirs_status)
    );
    let staged = if file.staged { " ✓staged" } else { "" };
    let suffix = format!("  {count}  {status}{staged}");

    // 路径优先保右侧（文件名比目录更重要），所以从左侧省略
    let path_width = width.saturating_sub(display_width(marker) + display_width(&suffix));
    let path = truncate_columns_start(&file.path, path_width);

    let base = if selected {
        Style::default().fg(Color::White).add_modifier(Modifier::BOLD)
    } else {
        Style::default().fg(Color::Gray)
    };

    Line::from(vec![
        Span::styled(marker.to_string(), base),
        Span::styled(path, base),
        Span::styled(
            suffix,
            Style::default().fg(if file.staged { CHANGE_COLOR } else { DIM }),
        ),
    ])
}

fn side_status_label(status: SideStatus) -> &'static str {
    match status {
        SideStatus::Modified => "改",
        SideStatus::Deleted => "删",
    }
}

fn draw_merge(frame: &mut Frame, app: &App, area: Rect, zones: &mut Vec<HitZone>) {
    let Some(merge) = app.merge.as_ref() else {
        return;
    };

    let chunks = RLayout::default()
        .direction(Direction::Vertical)
        .constraints([Constraint::Min(1), Constraint::Length(2)])
        .split(area);

    // 窄终端下三栏每栏不足 30 列，强制降级到聚焦模式
    let effective = if area.width < MIN_THREE_PANE_WIDTH {
        Layout::Focus
    } else {
        app.layout
    };

    match effective {
        Layout::ThreePane => draw_three_pane(frame, merge, chunks[0], zones),
        Layout::Focus => draw_focus(frame, merge, chunks[0], zones),
    }
    draw_decision_bar(frame, merge, chunks[1], zones);
}

/// 三栏并排，整文件纵向滚动，三栏共享同一个行索引（天然联动）。
fn draw_three_pane(frame: &mut Frame, merge: &MergeState, area: Rect, zones: &mut Vec<HitZone>) {
    let columns = RLayout::default()
        .direction(Direction::Horizontal)
        .constraints([
            Constraint::Ratio(1, 3),
            Constraint::Ratio(1, 3),
            Constraint::Ratio(1, 3),
        ])
        .split(area);

    let panes = [
        (Pane::Ours, merge.document.labels.ours.as_str(), OURS_COLOR),
        (Pane::Result, "Result", Color::Yellow),
        (Pane::Theirs, merge.document.labels.theirs.as_str(), THEIRS_COLOR),
    ];

    for (index, (pane, label, color)) in panes.iter().enumerate() {
        draw_pane(frame, merge, columns[index], *pane, label, *color, zones);
    }
}

fn draw_pane(
    frame: &mut Frame,
    merge: &MergeState,
    area: Rect,
    pane: Pane,
    label: &str,
    color: Color,
    zones: &mut Vec<HitZone>,
) {
    let block = Block::default()
        .borders(Borders::ALL)
        .title(format!(" {} ", truncate_columns(label, area.width.saturating_sub(4) as usize)))
        .border_style(Style::default().fg(DIM))
        .title_style(Style::default().fg(color).add_modifier(Modifier::BOLD));
    let inner = block.inner(area);
    frame.render_widget(block, area);

    if inner.width == 0 || inner.height == 0 {
        return;
    }

    let text_width = (inner.width as usize).saturating_sub(GUTTER);
    let active = merge.active_rows();
    let lines: Vec<Line> = (merge.scroll..merge.scroll + inner.height as usize)
        .filter_map(|index| merge.view.rows.get(index).map(|row| (index, row)))
        .map(|(index, row)| {
            // 冲突块所在行整行可点击，点哪一栏都选中该块
            if let Some(conflict_index) = row.conflict_index {
                zones.push(HitZone {
                    rect: Rect {
                        x: inner.x,
                        y: inner.y + (index - merge.scroll) as u16,
                        width: inner.width,
                        height: 1,
                    },
                    action: ClickAction::SelectConflict(conflict_index),
                });
            }
            let in_active = active
                .map(|(start, end)| index >= start && index <= end)
                .unwrap_or(false);
            pane_line(merge, row, pane, text_width, merge.h_scroll, in_active)
        })
        .collect();

    frame.render_widget(Paragraph::new(lines), inner);
}

fn pane_line(
    merge: &MergeState,
    row: &crate::session::ViewRow,
    pane: Pane,
    text_width: usize,
    h_scroll: usize,
    in_active: bool,
) -> Line<'static> {
    let number = match row.number(pane) {
        Some(number) => format!("{number:>4} "),
        None => " ".repeat(GUTTER),
    };

    // 占位行（对侧有内容、本侧没有）画成删除线底纹，视觉上和空行区分开
    if row.is_placeholder(pane) {
        return Line::from(vec![
            Span::styled(number, Style::default().fg(DIM)),
            Span::styled(
                "╱".repeat(text_width.min(80)),
                Style::default().fg(Color::Indexed(236)),
            ),
        ]);
    }

    let text = slice_columns(row.text(pane), h_scroll, text_width);
    let style = row_style(merge, row, pane, in_active);
    Line::from(vec![
        Span::styled(number, Style::default().fg(DIM)),
        Span::styled(text, style),
    ])
}

fn row_style(merge: &MergeState, row: &crate::session::ViewRow, pane: Pane, in_active: bool) -> Style {
    let mut style = Style::default().fg(Color::Gray);

    if let Some(index) = row.conflict_index {
        let kind = merge
            .conflicts()
            .get(index)
            .map(|region| region.block_kind)
            .unwrap_or(mergev_core::ConflictBlockKind::Conflict);
        let base = match kind {
            mergev_core::ConflictBlockKind::Change => CHANGE_COLOR,
            mergev_core::ConflictBlockKind::Conflict => CONFLICT_COLOR,
        };
        style = match pane {
            Pane::Ours | Pane::Theirs => Style::default().fg(base),
            // Result 栏按来源着色，能一眼看出这段是从哪侧来的
            Pane::Result => match row.result_source {
                Some(ResultSource::Ours) => Style::default().fg(OURS_COLOR),
                Some(ResultSource::Theirs) => Style::default().fg(THEIRS_COLOR),
                Some(ResultSource::Manual) => Style::default().fg(Color::Yellow),
                Some(ResultSource::Unresolved) => Style::default().fg(DIM),
                _ => Style::default().fg(base),
            },
        };
    } else if row.kind == MergeRowKind::Empty {
        style = Style::default().fg(DIM);
    }

    if in_active {
        style = style.add_modifier(Modifier::BOLD).bg(Color::Indexed(235));
    }
    style
}

/// 聚焦模式：只显示当前块，三段纵向堆叠，每段占满宽度。
/// 终端里代码是宽而短的，纵向堆叠比横向切分更省空间。
fn draw_focus(frame: &mut Frame, merge: &MergeState, area: Rect, zones: &mut Vec<HitZone>) {
    let Some((start, end)) = merge.active_rows() else {
        frame.render_widget(
            Paragraph::new(Line::from(Span::styled(
                "没有冲突块",
                Style::default().fg(DIM),
            ))),
            area,
        );
        return;
    };

    let rows = &merge.view.rows;
    // 上下各带 3 行上下文，方便判断改动落在哪
    const CONTEXT: usize = 3;
    let ctx_before: Vec<usize> = (start.saturating_sub(CONTEXT)..start).collect();
    let ctx_after: Vec<usize> = (end + 1..(end + 1 + CONTEXT).min(rows.len())).collect();

    let sections = RLayout::default()
        .direction(Direction::Vertical)
        .constraints([
            Constraint::Ratio(1, 3),
            Constraint::Ratio(1, 3),
            Constraint::Ratio(1, 3),
        ])
        .split(area);

    let panes = [
        (Pane::Ours, merge.document.labels.ours.clone(), OURS_COLOR),
        (Pane::Result, "Result".to_string(), Color::Yellow),
        (Pane::Theirs, merge.document.labels.theirs.clone(), THEIRS_COLOR),
    ];

    for (index, (pane, label, color)) in panes.iter().enumerate() {
        draw_focus_section(
            frame,
            merge,
            sections[index],
            *pane,
            label,
            *color,
            start,
            end,
            &ctx_before,
            &ctx_after,
            zones,
        );
    }
}

#[allow(clippy::too_many_arguments)]
fn draw_focus_section(
    frame: &mut Frame,
    merge: &MergeState,
    area: Rect,
    pane: Pane,
    label: &str,
    color: Color,
    start: usize,
    end: usize,
    ctx_before: &[usize],
    ctx_after: &[usize],
    zones: &mut Vec<HitZone>,
) {
    let verdict_tag = match pane {
        Pane::Ours => verdict_label(&merge.active_resolution(), Side::Ours),
        Pane::Theirs => verdict_label(&merge.active_resolution(), Side::Theirs),
        Pane::Result => merge.active_decision().label().to_string(),
    };
    let title = format!(" {label} · {verdict_tag} ");

    let block = Block::default()
        .borders(Borders::ALL)
        .title(truncate_columns(&title, area.width.saturating_sub(2) as usize))
        .border_style(Style::default().fg(DIM))
        .title_style(Style::default().fg(color).add_modifier(Modifier::BOLD));
    let inner = block.inner(area);
    frame.render_widget(block, area);

    if inner.width == 0 || inner.height == 0 {
        return;
    }

    let text_width = (inner.width as usize).saturating_sub(GUTTER);
    let mut lines: Vec<Line> = Vec::new();

    for index in ctx_before {
        if let Some(row) = merge.view.rows.get(*index) {
            lines.push(pane_line(merge, row, pane, text_width, merge.h_scroll, false));
        }
    }
    for index in start..=end {
        if let Some(row) = merge.view.rows.get(index) {
            // 聚焦模式下当前块已选中，点击仍登记，保持与三栏一致的行为
            if let Some(conflict_index) = row.conflict_index {
                let line_y = inner.y + (ctx_before.len() + (index - start)) as u16;
                zones.push(HitZone {
                    rect: Rect { x: inner.x, y: line_y, width: inner.width, height: 1 },
                    action: ClickAction::SelectConflict(conflict_index),
                });
            }
            lines.push(pane_line(merge, row, pane, text_width, merge.h_scroll, true));
        }
    }
    for index in ctx_after {
        if let Some(row) = merge.view.rows.get(*index) {
            lines.push(pane_line(merge, row, pane, text_width, merge.h_scroll, false));
        }
    }

    // 块比视口高时截断并提示，避免默默看不到后半段
    let height = inner.height as usize;
    if lines.len() > height {
        lines.truncate(height.saturating_sub(1));
        lines.push(Line::from(Span::styled(
            "  … 块内容超出视口，按 Tab 切到三栏模式滚动查看",
            Style::default().fg(Color::Yellow),
        )));
    }

    frame.render_widget(Paragraph::new(lines), inner);
}

fn verdict_label(resolution: &Resolution, side: Side) -> String {
    match resolution.verdict(side) {
        SideVerdict::Pending => "待定".to_string(),
        SideVerdict::Accepted => {
            let order = resolution
                .accept_order
                .iter()
                .position(|item| *item == side)
                .map(|index| format!("#{}", index + 1))
                .unwrap_or_default();
            format!("已接受{order}")
        }
        SideVerdict::Ignored => "已忽略".to_string(),
    }
}

/// 当前块的编号、类型、两侧表态和最终决策；第二行是可点击的决策按钮。
fn draw_decision_bar(frame: &mut Frame, merge: &MergeState, area: Rect, zones: &mut Vec<HitZone>) {
    let Some(region) = merge.active_region() else {
        return;
    };
    let resolution = merge.active_resolution();
    let kind_span = match region.block_kind {
        mergev_core::ConflictBlockKind::Conflict => {
            Span::styled(" 冲突 ", Style::default().fg(Color::Black).bg(CONFLICT_COLOR))
        }
        mergev_core::ConflictBlockKind::Change => {
            Span::styled(" 单方改动 ", Style::default().fg(Color::Black).bg(CHANGE_COLOR))
        }
    };

    let line = Line::from(vec![
        Span::styled(
            format!(" 块 {}/{} ", merge.active + 1, merge.total()),
            Style::default().fg(Color::White).add_modifier(Modifier::BOLD),
        ),
        kind_span,
        Span::raw("  "),
        Span::styled(
            format!("{}: {}", Side::Ours.label(), verdict_label(&resolution, Side::Ours)),
            Style::default().fg(OURS_COLOR),
        ),
        Span::raw("  "),
        Span::styled(
            format!("{}: {}", Side::Theirs.label(), verdict_label(&resolution, Side::Theirs)),
            Style::default().fg(THEIRS_COLOR),
        ),
        Span::raw("  →  "),
        Span::styled(
            merge.active_decision().label().to_string(),
            Style::default().fg(if merge.active_is_complete() {
                CHANGE_COLOR
            } else {
                Color::Yellow
            }),
        ),
    ]);

    // 区域共 2 行：第一行状态，第二行按钮
    let (status_area, button_area) = if area.height >= 2 {
        (Rect { height: 1, ..area }, Rect { y: area.y + 1, height: 1, ..area })
    } else {
        (area, Rect::default())
    };
    frame.render_widget(Paragraph::new(line), status_area);
    draw_decision_buttons(frame, button_area, zones);
}

struct DecisionButton {
    label: &'static str,
    action: ClickAction,
    color: Color,
}

fn draw_decision_buttons(frame: &mut Frame, area: Rect, zones: &mut Vec<HitZone>) {
    if area.width == 0 || area.height == 0 {
        return;
    }
    let buttons = [
        DecisionButton { label: "1 Yours", action: ClickAction::AcceptOurs, color: OURS_COLOR },
        DecisionButton { label: "2 Theirs", action: ClickAction::AcceptTheirs, color: THEIRS_COLOR },
        DecisionButton { label: "b 都要", action: ClickAction::AcceptBoth, color: Color::Yellow },
        DecisionButton { label: "x 丢弃", action: ClickAction::DropBoth, color: CONFLICT_COLOR },
        DecisionButton { label: "r 重置", action: ClickAction::ResetBlock, color: DIM },
    ];

    // 依次拼接按钮，超出视口宽度的不再画也不登记点击
    let mut cursor = area.x + 1;
    let right = area.x + area.width;
    let mut spans: Vec<Span> = Vec::new();
    for button in &buttons {
        let text = format!(" {} ", button.label);
        let width = display_width(&text) as u16;
        if cursor + width > right {
            break;
        }
        spans.push(Span::styled(
            text.clone(),
            Style::default().fg(Color::Black).bg(button.color).add_modifier(Modifier::BOLD),
        ));
        spans.push(Span::raw(" "));
        zones.push(HitZone {
            rect: Rect { x: cursor, y: area.y, width, height: 1 },
            action: button.action,
        });
        cursor += width + 1;
    }

    frame.render_widget(Paragraph::new(Line::from(spans)), area);
}

const HELP: &[(&str, &str)] = &[
    ("j / k / ↓ / ↑", "上下移动"),
    ("Enter / l", "打开选中文件"),
    ("y / t", "整文件接受 Yours / Theirs（会覆盖工作区）"),
    ("r", "刷新仓库状态"),
    ("", ""),
    ("1 / 2", "接受 Yours / Theirs（再按一次改为忽略）"),
    ("! / @", "忽略 Yours / Theirs"),
    ("b / B", "两侧都要：Yours→Theirs / Theirs→Yours"),
    ("x", "两侧都丢弃"),
    ("c", "重置当前块为未解决"),
    ("n / p", "下一个 / 上一个冲突块"),
    ("N", "下一个未解决的块"),
    ("g / G", "第一个 / 最后一个块"),
    ("Tab", "切换三栏模式 / 聚焦模式"),
    ("鼠标点击", "选中文件 / 冲突块 / 决策按钮"),
    ("鼠标滚轮", "滚动文件列表或合并内容"),
    ("h / L", "横向滚动（长行）"),
    ("Ctrl+D / Ctrl+U", "翻页（三栏模式）"),
    ("u / Ctrl+R", "撤销 / 重做"),
    ("s", "保存并 stage"),
    ("Esc", "返回文件列表"),
    ("? ", "开关本帮助"),
    ("q", "退出"),
];

fn draw_help(frame: &mut Frame, area: Rect) {
    let width = 62u16.min(area.width.saturating_sub(4));
    let height = (HELP.len() as u16 + 2).min(area.height.saturating_sub(2));
    let rect = centered(area, width, height);

    frame.render_widget(Clear, rect);
    let block = Block::default()
        .borders(Borders::ALL)
        .title(" 快捷键 ")
        .border_style(Style::default().fg(Color::Cyan));
    let inner = block.inner(rect);
    frame.render_widget(block, rect);

    let lines: Vec<Line> = HELP
        .iter()
        .map(|(key, desc)| {
            if key.is_empty() {
                return Line::from("");
            }
            Line::from(vec![
                Span::styled(
                    format!("{:<16}", key),
                    Style::default().fg(Color::Cyan).add_modifier(Modifier::BOLD),
                ),
                Span::styled(desc.to_string(), Style::default().fg(Color::Gray)),
            ])
        })
        .collect();

    frame.render_widget(Paragraph::new(lines), inner);
}

fn draw_confirm(frame: &mut Frame, area: Rect, pending: Confirm) {
    let text = match pending {
        Confirm::DiscardChanges => "有未保存的决策，确认返回文件列表？(y/n)".to_string(),
        Confirm::QuitDirty => "有未保存的决策，确认退出？(y/n)".to_string(),
        Confirm::AcceptFile(side) => format!(
            "整文件接受 {} 会覆盖工作区文件，确认？(y/n)",
            side.label()
        ),
    };

    let width = (display_width(&text) as u16 + 4).min(area.width.saturating_sub(2));
    let rect = centered(area, width, 3);

    frame.render_widget(Clear, rect);
    let block = Block::default()
        .borders(Borders::ALL)
        .border_style(Style::default().fg(Color::Yellow));
    let inner = block.inner(rect);
    frame.render_widget(block, rect);
    frame.render_widget(
        Paragraph::new(Line::from(Span::styled(
            text,
            Style::default().fg(Color::White),
        ))),
        inner,
    );
}

fn centered(area: Rect, width: u16, height: u16) -> Rect {
    let x = area.x + (area.width.saturating_sub(width)) / 2;
    let y = area.y + (area.height.saturating_sub(height)) / 2;
    Rect {
        x,
        y,
        width: width.min(area.width),
        height: height.min(area.height),
    }
}
