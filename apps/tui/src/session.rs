//! 决策模型与 Result 栏重算。
//!
//! `mergev-core` 已经完成了三栏行对齐（含单方绿块的空行剥离），这一层只补
//! GUI 侧 `packages/merge-ui/src/core/mergeSession.ts` 独有的语义：
//! 按侧 Accept / Ignore、接受顺序、以及由此推导出的 Result 行。
//!
//! 与 TS 版的一个差异：core 的 `rows` 是固定的，ours / theirs 的行号不随决策
//! 变化，所以这里只重算 Result 的行号，不像 TS 那样整体重排。

use mergev_core::{ConflictBlockKind, ConflictRegion, MergeDocument, MergeRowKind, ResultSource};

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Side {
    Ours,
    Theirs,
}

impl Side {
    pub fn label(self) -> &'static str {
        match self {
            Self::Ours => "Yours",
            Self::Theirs => "Theirs",
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum SideVerdict {
    Pending,
    Accepted,
    Ignored,
}

/// 单个冲突块的解决状态。`accept_order` 决定两侧都接受时的拼接顺序。
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Resolution {
    pub ours: SideVerdict,
    pub theirs: SideVerdict,
    pub accept_order: Vec<Side>,
}

impl Default for Resolution {
    fn default() -> Self {
        Self {
            ours: SideVerdict::Pending,
            theirs: SideVerdict::Pending,
            accept_order: Vec::new(),
        }
    }
}

impl Resolution {
    pub fn verdict(&self, side: Side) -> SideVerdict {
        match side {
            Side::Ours => self.ours,
            Side::Theirs => self.theirs,
        }
    }

    fn set(&mut self, side: Side, verdict: SideVerdict) {
        match side {
            Side::Ours => self.ours = verdict,
            Side::Theirs => self.theirs = verdict,
        }
    }

    /// 接受某一侧。重复接受是幂等的；已忽略的一侧会转为接受并追加到顺序末尾。
    pub fn accept(&mut self, side: Side) {
        if self.verdict(side) == SideVerdict::Accepted {
            return;
        }
        self.set(side, SideVerdict::Accepted);
        self.accept_order.retain(|item| *item != side);
        self.accept_order.push(side);
    }

    pub fn ignore(&mut self, side: Side) {
        if self.verdict(side) == SideVerdict::Ignored {
            return;
        }
        self.set(side, SideVerdict::Ignored);
        self.accept_order.retain(|item| *item != side);
    }

    /// 在 pending → accepted → ignored 之间轮转，方便终端里单键操作。
    pub fn toggle(&mut self, side: Side) {
        match self.verdict(side) {
            SideVerdict::Accepted => self.ignore(side),
            _ => self.accept(side),
        }
    }

    pub fn decision(&self) -> Decision {
        let accepted: Vec<Side> = self
            .accept_order
            .iter()
            .copied()
            .filter(|side| self.verdict(*side) == SideVerdict::Accepted)
            .collect();

        match accepted.len() {
            0 => {
                // 两侧都明确忽略 → 该块最终为空，是一个有效决策
                if self.ours != SideVerdict::Pending && self.theirs != SideVerdict::Pending {
                    Decision::Empty
                } else {
                    Decision::Unresolved
                }
            }
            1 => match accepted[0] {
                Side::Ours => Decision::Ours,
                Side::Theirs => Decision::Theirs,
            },
            _ => match accepted[0] {
                Side::Ours => Decision::OursThenTheirs,
                Side::Theirs => Decision::TheirsThenOurs,
            },
        }
    }
}

/// 比 core 的 `ConflictDecision` 多一个 `Empty`（两侧都丢弃）。
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Decision {
    Unresolved,
    Ours,
    Theirs,
    OursThenTheirs,
    TheirsThenOurs,
    Empty,
}

impl Decision {
    pub fn label(self) -> &'static str {
        match self {
            Self::Unresolved => "未解决",
            Self::Ours => "Yours",
            Self::Theirs => "Theirs",
            Self::OursThenTheirs => "Yours → Theirs",
            Self::TheirsThenOurs => "Theirs → Yours",
            Self::Empty => "两侧都丢弃",
        }
    }
}

pub fn side_has_substantive(text: &str) -> bool {
    text.lines().any(|line| !line.trim().is_empty())
}

fn is_change_block(region: &ConflictRegion) -> bool {
    region.block_kind == ConflictBlockKind::Change
}

/// 绿色单方块里，没有内容的那一侧不需要用户表态。
fn side_needs_action(region: &ConflictRegion, side: Side) -> bool {
    if !is_change_block(region) {
        return true;
    }
    let text = match side {
        Side::Ours => &region.ours,
        Side::Theirs => &region.theirs,
    };
    side_has_substantive(text)
}

pub fn is_resolution_complete(resolution: &Resolution, region: &ConflictRegion) -> bool {
    let ours_ok = !side_needs_action(region, Side::Ours) || resolution.ours != SideVerdict::Pending;
    let theirs_ok =
        !side_needs_action(region, Side::Theirs) || resolution.theirs != SideVerdict::Pending;
    ours_ok && theirs_ok
}

fn split_lines(text: &str) -> Vec<String> {
    if text.is_empty() {
        Vec::new()
    } else {
        text.lines().map(str::to_string).collect()
    }
}

/// 决策对应的 Result 行。`Unresolved` 返回一行空占位，只用于渲染，不写盘。
fn decision_result_lines(decision: Decision, ours: &str, theirs: &str) -> (ResultSource, Vec<String>) {
    match decision {
        Decision::Ours => (ResultSource::Ours, split_lines(ours)),
        Decision::Theirs => (ResultSource::Theirs, split_lines(theirs)),
        Decision::OursThenTheirs => {
            let mut lines = split_lines(ours);
            lines.extend(split_lines(theirs));
            (ResultSource::Manual, lines)
        }
        Decision::TheirsThenOurs => {
            let mut lines = split_lines(theirs);
            lines.extend(split_lines(ours));
            (ResultSource::Manual, lines)
        }
        Decision::Empty => (ResultSource::Manual, Vec::new()),
        Decision::Unresolved => (ResultSource::Unresolved, vec![String::new()]),
    }
}

#[derive(Debug, Clone)]
pub struct Cell {
    pub number: Option<usize>,
    pub text: String,
}

#[derive(Debug, Clone)]
pub struct ViewRow {
    pub kind: MergeRowKind,
    pub conflict_index: Option<usize>,
    pub ours: Option<Cell>,
    pub result: Option<Cell>,
    pub theirs: Option<Cell>,
    pub result_source: Option<ResultSource>,
}

impl ViewRow {
    pub fn text(&self, side: Pane) -> &str {
        let cell = match side {
            Pane::Ours => self.ours.as_ref(),
            Pane::Result => self.result.as_ref(),
            Pane::Theirs => self.theirs.as_ref(),
        };
        cell.map(|cell| cell.text.as_str()).unwrap_or("")
    }

    pub fn number(&self, side: Pane) -> Option<usize> {
        match side {
            Pane::Ours => self.ours.as_ref().and_then(|cell| cell.number),
            Pane::Result => self.result.as_ref().and_then(|cell| cell.number),
            Pane::Theirs => self.theirs.as_ref().and_then(|cell| cell.number),
        }
    }

    pub fn is_placeholder(&self, side: Pane) -> bool {
        match side {
            Pane::Ours => self.ours.is_none(),
            Pane::Result => self.result.is_none(),
            Pane::Theirs => self.theirs.is_none(),
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Pane {
    Ours,
    Result,
    Theirs,
}

/// 一次重算的产物：渲染用的行、每个冲突块占据的行区间、写盘用的 Result 文本。
#[derive(Debug, Clone)]
pub struct SessionView {
    pub rows: Vec<ViewRow>,
    /// 与 `document.conflicts` 同序，值为 `rows` 上的闭区间 `(start, end)`。
    pub conflict_rows: Vec<(usize, usize)>,
    pub result_lines: Vec<String>,
    pub unresolved: usize,
}

impl SessionView {
    /// 拼成写盘文本。仅在 `unresolved == 0` 时有意义。
    pub fn serialize(&self, ends_with_newline: bool) -> String {
        let mut out = self.result_lines.join("\n");
        if ends_with_newline && !out.ends_with('\n') {
            out.push('\n');
        }
        out
    }
}

pub fn build_view(document: &MergeDocument, resolutions: &[Resolution]) -> SessionView {
    let mut rows: Vec<ViewRow> = Vec::with_capacity(document.rows.len());
    let mut result_lines: Vec<String> = Vec::new();
    let mut conflict_rows = vec![(0usize, 0usize); document.conflicts.len()];
    let mut result_no = 1usize;
    let mut unresolved = 0usize;

    let mut index = 0usize;
    while index < document.rows.len() {
        let row = &document.rows[index];

        let Some(conflict_index) = row.conflict_index else {
            // 上下文行：ours / theirs 直接沿用 core 的编号，只重算 Result
            let result = row.result_line.as_ref().map(|line| {
                let cell = Cell {
                    number: Some(result_no),
                    text: line.text.clone(),
                };
                result_lines.push(line.text.clone());
                result_no += 1;
                cell
            });
            let has_result = result.is_some();
            rows.push(ViewRow {
                kind: row.kind,
                conflict_index: None,
                ours: row.ours_line.as_ref().map(|line| Cell {
                    number: line.number,
                    text: line.text.clone(),
                }),
                result,
                theirs: row.theirs_line.as_ref().map(|line| Cell {
                    number: line.number,
                    text: line.text.clone(),
                }),
                result_source: has_result.then_some(ResultSource::Context),
            });
            index += 1;
            continue;
        };

        // 收拢同属一个冲突块的连续行
        let start = index;
        while index < document.rows.len()
            && document.rows[index].conflict_index == Some(conflict_index)
        {
            index += 1;
        }
        let doc_rows = &document.rows[start..index];

        let Some(region) = document.conflicts.get(conflict_index) else {
            continue;
        };
        let resolution = resolutions.get(conflict_index).cloned().unwrap_or_default();
        let decision = resolution.decision();

        if !is_resolution_complete(&resolution, region) {
            unresolved += 1;
        }

        // 用行文本而不是 region.ours / region.theirs 重新拼接，以保留块内空行。
        // 空块（例如整块都是占位行）回退到 region 的原始文本。
        let ours_text = join_side(doc_rows, Pane::Ours);
        let theirs_text = join_side(doc_rows, Pane::Theirs);
        let ours_text = if ours_text.is_empty() {
            region.ours.clone()
        } else {
            ours_text
        };
        let theirs_text = if theirs_text.is_empty() {
            region.theirs.clone()
        } else {
            theirs_text
        };

        let (source, lines) = decision_result_lines(decision, &ours_text, &theirs_text);
        let is_placeholder = decision == Decision::Unresolved;
        let row_count = doc_rows.len().max(lines.len()).max(1);
        let row_start = rows.len();

        for offset in 0..row_count {
            let result = lines.get(offset).map(|text| {
                let cell = Cell {
                    number: (!is_placeholder).then_some(result_no),
                    text: text.clone(),
                };
                if !is_placeholder {
                    result_lines.push(text.clone());
                    result_no += 1;
                }
                cell
            });
            let has_result = result.is_some();
            let doc_row = doc_rows.get(offset);
            rows.push(ViewRow {
                kind: doc_row.map(|row| row.kind).unwrap_or(MergeRowKind::Empty),
                conflict_index: Some(conflict_index),
                ours: doc_row.and_then(|row| row.ours_line.as_ref()).map(|line| Cell {
                    number: line.number,
                    text: line.text.clone(),
                }),
                result,
                theirs: doc_row
                    .and_then(|row| row.theirs_line.as_ref())
                    .map(|line| Cell {
                        number: line.number,
                        text: line.text.clone(),
                    }),
                result_source: has_result.then_some(source),
            });
        }

        conflict_rows[conflict_index] = (row_start, rows.len().saturating_sub(1));
    }

    SessionView {
        rows,
        conflict_rows,
        result_lines,
        unresolved,
    }
}

fn join_side(rows: &[mergev_core::MergeRow], pane: Pane) -> String {
    let texts: Vec<&str> = rows
        .iter()
        .filter_map(|row| match pane {
            Pane::Ours => row.ours_line.as_ref(),
            Pane::Theirs => row.theirs_line.as_ref(),
            Pane::Result => row.result_line.as_ref(),
        })
        .map(|line| line.text.as_str())
        .collect();
    texts.join("\n")
}

/// 从当前位置向后找下一个未解决的块，找不到就返回原位。
pub fn next_incomplete(
    resolutions: &[Resolution],
    conflicts: &[ConflictRegion],
    from: usize,
) -> Option<usize> {
    if resolutions.is_empty() {
        return None;
    }
    for offset in 1..=resolutions.len() {
        let index = (from + offset) % resolutions.len();
        let region = conflicts.get(index)?;
        if !is_resolution_complete(&resolutions[index], region) {
            return Some(index);
        }
    }
    None
}

#[cfg(test)]
mod tests {
    use super::*;

    fn region(ours: &str, theirs: &str, kind: ConflictBlockKind) -> ConflictRegion {
        ConflictRegion {
            index: 0,
            row_start: 0,
            row_end: 0,
            decision: mergev_core::ConflictDecision::Unresolved,
            block_kind: kind,
            ours: ours.into(),
            theirs: theirs.into(),
        }
    }

    #[test]
    fn accept_one_side_yields_that_side() {
        let mut resolution = Resolution::default();
        resolution.accept(Side::Ours);
        assert_eq!(resolution.decision(), Decision::Ours);
    }

    #[test]
    fn accept_order_drives_concatenation() {
        let mut resolution = Resolution::default();
        resolution.accept(Side::Theirs);
        resolution.accept(Side::Ours);
        assert_eq!(resolution.decision(), Decision::TheirsThenOurs);

        let mut resolution = Resolution::default();
        resolution.accept(Side::Ours);
        resolution.accept(Side::Theirs);
        assert_eq!(resolution.decision(), Decision::OursThenTheirs);
    }

    #[test]
    fn accept_is_idempotent() {
        let mut resolution = Resolution::default();
        resolution.accept(Side::Ours);
        resolution.accept(Side::Ours);
        assert_eq!(resolution.accept_order.len(), 1);
        assert_eq!(resolution.decision(), Decision::Ours);
    }

    #[test]
    fn ignoring_both_sides_is_a_valid_empty_decision() {
        let mut resolution = Resolution::default();
        resolution.ignore(Side::Ours);
        assert_eq!(resolution.decision(), Decision::Unresolved);
        resolution.ignore(Side::Theirs);
        assert_eq!(resolution.decision(), Decision::Empty);
    }

    #[test]
    fn ignore_removes_a_previously_accepted_side() {
        let mut resolution = Resolution::default();
        resolution.accept(Side::Ours);
        resolution.accept(Side::Theirs);
        resolution.ignore(Side::Ours);
        assert_eq!(resolution.decision(), Decision::Theirs);
    }

    #[test]
    fn toggle_cycles_accept_then_ignore() {
        let mut resolution = Resolution::default();
        resolution.toggle(Side::Ours);
        assert_eq!(resolution.ours, SideVerdict::Accepted);
        resolution.toggle(Side::Ours);
        assert_eq!(resolution.ours, SideVerdict::Ignored);
        resolution.toggle(Side::Ours);
        assert_eq!(resolution.ours, SideVerdict::Accepted);
    }

    #[test]
    fn change_block_only_needs_the_substantive_side() {
        let region = region("added line", "", ConflictBlockKind::Change);
        let mut resolution = Resolution::default();
        assert!(!is_resolution_complete(&resolution, &region));
        resolution.accept(Side::Ours);
        assert!(is_resolution_complete(&resolution, &region));
    }

    #[test]
    fn conflict_block_needs_both_sides() {
        let region = region("a", "b", ConflictBlockKind::Conflict);
        let mut resolution = Resolution::default();
        resolution.accept(Side::Ours);
        assert!(!is_resolution_complete(&resolution, &region));
        resolution.ignore(Side::Theirs);
        assert!(is_resolution_complete(&resolution, &region));
    }

    #[test]
    fn result_lines_follow_the_decision() {
        assert_eq!(
            decision_result_lines(Decision::OursThenTheirs, "a", "b").1,
            vec!["a".to_string(), "b".to_string()]
        );
        assert_eq!(
            decision_result_lines(Decision::TheirsThenOurs, "a", "b").1,
            vec!["b".to_string(), "a".to_string()]
        );
        assert!(decision_result_lines(Decision::Empty, "a", "b").1.is_empty());
        assert_eq!(
            decision_result_lines(Decision::Unresolved, "a", "b").1,
            vec![String::new()]
        );
    }
}
