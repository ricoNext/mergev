//! 应用状态与状态转移。所有 Git / 磁盘操作都委托给 `mergev-core`。
//!
//! 渲染层只读这里的状态，事件层只调这里的方法，两边互不感知。

use std::path::{Path, PathBuf};

use ratatui::layout::Rect;

use mergev_core::{
    accept_file_side, load_merge_document, load_workspace_from_root, save_merge_result,
    ConflictRegion, MergeDocument, WorkspaceSnapshot,
};

use crate::session::{
    build_view, is_resolution_complete, next_incomplete, Decision, Pane, Resolution, SessionView,
    Side,
};

/// 三栏并排在窄终端里每栏不足 30 列，低于这个宽度自动改用纵向堆叠。
pub const MIN_THREE_PANE_WIDTH: u16 = 100;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum View {
    Files,
    Merge,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Layout {
    /// 三栏并排，整文件纵向滚动。
    ThreePane,
    /// 单块聚焦，三段纵向堆叠，各占满宽。
    Focus,
}

impl Layout {
    pub fn toggled(self) -> Self {
        match self {
            Self::ThreePane => Self::Focus,
            Self::Focus => Self::ThreePane,
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Level {
    Info,
    Success,
    Error,
}

#[derive(Debug, Clone)]
pub struct Status {
    pub text: String,
    pub level: Level,
}

/// 鼠标点击命中的动作，由渲染层在画可点击元素时登记。
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ClickAction {
    /// 文件列表：选中第 index 个文件。
    SelectFile(usize),
    /// 合并视图：选中第 index 个冲突块。
    SelectConflict(usize),
    /// 决策栏按钮，与对应按键行为一致。
    AcceptOurs,
    AcceptTheirs,
    AcceptBoth,
    DropBoth,
    ResetBlock,
}

#[derive(Debug, Clone, Copy)]
pub struct HitZone {
    pub rect: Rect,
    pub action: ClickAction,
}

/// 打开的合并文档 + 用户在上面累积的决策。
pub struct MergeState {
    pub path: String,
    pub document: MergeDocument,
    pub resolutions: Vec<Resolution>,
    pub view: SessionView,
    pub active: usize,
    /// 三栏模式的首个可见行。
    pub scroll: usize,
    /// 横向滚动的起始列，长行靠它查看。
    pub h_scroll: usize,
    pub dirty: bool,
    ends_with_newline: bool,
    undo: Vec<Vec<Resolution>>,
    redo: Vec<Vec<Resolution>>,
}

impl MergeState {
    fn new(path: String, document: MergeDocument) -> Self {
        let resolutions = vec![Resolution::default(); document.conflicts.len()];
        let view = build_view(&document, &resolutions);
        let ends_with_newline = document.working.ends_with('\n');
        Self {
            path,
            document,
            resolutions,
            view,
            active: 0,
            scroll: 0,
            h_scroll: 0,
            dirty: false,
            ends_with_newline,
            undo: Vec::new(),
            redo: Vec::new(),
        }
    }

    pub fn conflicts(&self) -> &[ConflictRegion] {
        &self.document.conflicts
    }

    pub fn active_region(&self) -> Option<&ConflictRegion> {
        self.document.conflicts.get(self.active)
    }

    pub fn active_resolution(&self) -> Resolution {
        self.resolutions.get(self.active).cloned().unwrap_or_default()
    }

    pub fn unresolved(&self) -> usize {
        self.view.unresolved
    }

    pub fn total(&self) -> usize {
        self.document.conflicts.len()
    }

    /// 当前块在 `view.rows` 上的闭区间。
    pub fn active_rows(&self) -> Option<(usize, usize)> {
        self.view.conflict_rows.get(self.active).copied()
    }

    fn rebuild(&mut self) {
        self.view = build_view(&self.document, &self.resolutions);
    }

    fn push_undo(&mut self) {
        self.undo.push(self.resolutions.clone());
        self.redo.clear();
    }

    fn mutate(&mut self, apply: impl FnOnce(&mut Resolution)) -> bool {
        let Some(current) = self.resolutions.get(self.active) else {
            return false;
        };
        let mut next = current.clone();
        apply(&mut next);
        if next == *current {
            return false;
        }
        self.push_undo();
        self.resolutions[self.active] = next;
        self.dirty = true;
        self.rebuild();
        true
    }

    pub fn accept(&mut self, side: Side) -> bool {
        self.mutate(|resolution| resolution.accept(side))
    }

    pub fn ignore(&mut self, side: Side) -> bool {
        self.mutate(|resolution| resolution.ignore(side))
    }

    pub fn toggle(&mut self, side: Side) -> bool {
        self.mutate(|resolution| resolution.toggle(side))
    }

    /// 两侧都接受，`first` 决定拼接顺序。
    pub fn accept_both(&mut self, first: Side) -> bool {
        let second = match first {
            Side::Ours => Side::Theirs,
            Side::Theirs => Side::Ours,
        };
        self.mutate(|resolution| {
            *resolution = Resolution::default();
            resolution.accept(first);
            resolution.accept(second);
        })
    }

    pub fn reset(&mut self) -> bool {
        self.mutate(|resolution| *resolution = Resolution::default())
    }

    pub fn undo(&mut self) -> bool {
        let Some(previous) = self.undo.pop() else {
            return false;
        };
        self.redo.push(self.resolutions.clone());
        self.resolutions = previous;
        self.dirty = true;
        self.rebuild();
        true
    }

    pub fn redo(&mut self) -> bool {
        let Some(next) = self.redo.pop() else {
            return false;
        };
        self.undo.push(self.resolutions.clone());
        self.resolutions = next;
        self.dirty = true;
        self.rebuild();
        true
    }

    pub fn select(&mut self, index: usize) {
        if index < self.total() {
            self.active = index;
            self.h_scroll = 0;
        }
    }

    pub fn next_conflict(&mut self) {
        if self.total() > 0 {
            self.select((self.active + 1) % self.total());
        }
    }

    pub fn prev_conflict(&mut self) {
        if self.total() > 0 {
            self.select((self.active + self.total() - 1) % self.total());
        }
    }

    /// 跳到下一个未解决的块；全部解决时返回 false。
    pub fn next_unresolved(&mut self) -> bool {
        match next_incomplete(&self.resolutions, self.conflicts(), self.active) {
            Some(index) => {
                self.select(index);
                true
            }
            None => false,
        }
    }

    pub fn active_is_complete(&self) -> bool {
        match self.active_region() {
            Some(region) => is_resolution_complete(&self.active_resolution(), region),
            None => true,
        }
    }

    pub fn active_decision(&self) -> Decision {
        self.active_resolution().decision()
    }

    /// 让当前块在 `height` 行的视口内可见，优先把块顶部对齐到视口上方留一行。
    pub fn ensure_visible(&mut self, height: usize) {
        let Some((start, end)) = self.active_rows() else {
            return;
        };
        if height == 0 {
            return;
        }
        let margin = 2usize;
        if start < self.scroll + margin {
            self.scroll = start.saturating_sub(margin);
        } else if end >= self.scroll + height {
            let target = end + 1 + margin;
            self.scroll = target.saturating_sub(height);
        }
        let max_scroll = self.view.rows.len().saturating_sub(height);
        self.scroll = self.scroll.min(max_scroll);
    }

    pub fn scroll_by(&mut self, delta: isize, height: usize) {
        let max_scroll = self.view.rows.len().saturating_sub(height);
        let next = self.scroll as isize + delta;
        self.scroll = next.clamp(0, max_scroll as isize) as usize;
    }

    pub fn scroll_h_by(&mut self, delta: isize) {
        let next = self.h_scroll as isize + delta;
        self.h_scroll = next.max(0) as usize;
    }

    /// 最长行的显示宽度，用于判断是否需要横向滚动。
    pub fn max_line_width(&self) -> usize {
        self.view
            .rows
            .iter()
            .map(|row| {
                [Pane::Ours, Pane::Result, Pane::Theirs]
                    .iter()
                    .map(|pane| crate::text::display_width(row.text(*pane)))
                    .max()
                    .unwrap_or(0)
            })
            .max()
            .unwrap_or(0)
    }
}

pub struct App {
    pub root: PathBuf,
    pub snapshot: WorkspaceSnapshot,
    pub view: View,
    pub layout: Layout,
    pub selected_file: usize,
    pub merge: Option<MergeState>,
    pub status: Option<Status>,
    pub show_help: bool,
    /// 待确认的动作，非 None 时界面显示确认提示。
    pub pending: Option<Confirm>,
    /// 渲染层每次绘制时重建的鼠标点击区域，事件层据此分发点击。
    pub hit_zones: Vec<HitZone>,
    pub should_quit: bool,
}

/// 需要二次确认的动作。
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Confirm {
    /// 有未保存决策时离开合并视图。
    DiscardChanges,
    /// 有未保存决策时退出程序。
    QuitDirty,
    /// 整文件接受某一侧（会覆盖工作区文件）。
    AcceptFile(Side),
}

impl App {
    pub fn new(root: PathBuf) -> Result<Self, String> {
        let snapshot = load_workspace_from_root(&root)?;
        Ok(Self {
            root,
            snapshot,
            view: View::Files,
            layout: Layout::ThreePane,
            selected_file: 0,
            merge: None,
            status: None,
            show_help: false,
            pending: None,
            hit_zones: Vec::new(),
            should_quit: false,
        })
    }

    pub fn info(&mut self, text: impl Into<String>) {
        self.status = Some(Status {
            text: text.into(),
            level: Level::Info,
        });
    }

    pub fn success(&mut self, text: impl Into<String>) {
        self.status = Some(Status {
            text: text.into(),
            level: Level::Success,
        });
    }

    pub fn error(&mut self, text: impl Into<String>) {
        self.status = Some(Status {
            text: text.into(),
            level: Level::Error,
        });
    }

    pub fn files(&self) -> &[mergev_core::ConflictFileSummary] {
        &self.snapshot.files
    }

    pub fn selected_path(&self) -> Option<String> {
        self.snapshot
            .files
            .get(self.selected_file)
            .map(|file| file.path.clone())
    }

    pub fn select_file(&mut self, index: usize) {
        if !self.snapshot.files.is_empty() {
            self.selected_file = index.min(self.snapshot.files.len() - 1);
        }
    }

    pub fn move_selection(&mut self, delta: isize) {
        if self.snapshot.files.is_empty() {
            return;
        }
        let len = self.snapshot.files.len() as isize;
        let next = (self.selected_file as isize + delta).clamp(0, len - 1);
        self.selected_file = next as usize;
    }

    /// 重新读取仓库状态。会丢弃未保存的决策，调用方需自行确认。
    pub fn refresh(&mut self) -> Result<(), String> {
        let snapshot = load_workspace_from_root(&self.root)?;
        self.snapshot = snapshot;
        if self.selected_file >= self.snapshot.files.len() {
            self.selected_file = self.snapshot.files.len().saturating_sub(1);
        }
        Ok(())
    }

    pub fn open_selected(&mut self) -> Result<(), String> {
        let Some(path) = self.selected_path() else {
            return Err("没有可打开的冲突文件".into());
        };
        let document = load_merge_document(&self.root, &path)?;
        if document.conflicts.is_empty() {
            return Err(format!("{path} 没有检测到冲突块"));
        }
        let mut merge = MergeState::new(path, document);
        // 直接落在第一个待处理的块上，省一次跳转
        if let Some(index) = next_incomplete(&merge.resolutions, merge.conflicts(), usize::MAX - 1) {
            merge.select(index);
        }
        self.merge = Some(merge);
        self.view = View::Merge;
        Ok(())
    }

    pub fn close_merge(&mut self) {
        self.merge = None;
        self.view = View::Files;
    }

    /// 写回 Result 并 stage。仍有未解决块时拒绝。
    pub fn save_merge(&mut self) -> Result<String, String> {
        let Some(merge) = self.merge.as_ref() else {
            return Err("当前没有打开的文件".into());
        };
        if merge.unresolved() > 0 {
            return Err(format!("还有 {} 个冲突块未解决", merge.unresolved()));
        }
        let path = merge.path.clone();
        let content = merge.view.serialize(merge.ends_with_newline);
        save_merge_result(&self.root, &path, &content, true)?;
        if let Some(merge) = self.merge.as_mut() {
            merge.dirty = false;
        }
        self.refresh()?;
        Ok(path)
    }

    /// 整文件接受某一侧并 stage。
    pub fn accept_whole_file(&mut self, side: Side) -> Result<String, String> {
        let Some(path) = self.selected_path() else {
            return Err("没有选中的文件".into());
        };
        let side_arg = match side {
            Side::Ours => "ours",
            Side::Theirs => "theirs",
        };
        accept_file_side(&self.root, &path, side_arg)?;
        self.refresh()?;
        Ok(path)
    }
}

/// 从 cwd 定位仓库根。
pub fn discover_root(cwd: &Path) -> Result<PathBuf, String> {
    mergev_core::resolve_repo_root(cwd)
}
