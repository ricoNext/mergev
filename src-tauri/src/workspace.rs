use std::path::{Path, PathBuf};
use std::process::Command;

use serde::Serialize;

use crate::git::{resolve_repo_root, RepoError};

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct WorkspaceSnapshot {
    pub cwd: String,
    pub root: String,
    pub repo_name: String,
    pub branch: String,
    pub operation: GitOperation,
    pub ours_label: String,
    pub theirs_label: String,
    pub headline: String,
    pub files: Vec<ConflictFileSummary>,
    pub total_blocks: usize,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ConflictFileSummary {
    pub path: String,
    pub file_name: String,
    pub directory: String,
    pub conflict_count: usize,
    pub ours_status: SideStatus,
    pub theirs_status: SideStatus,
    pub staged: bool,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum SideStatus {
    Modified,
    Added,
    Deleted,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ConflictFileDetail {
    pub path: String,
    pub ours: String,
    pub theirs: String,
    pub base: Option<String>,
    pub blocks: Vec<ConflictBlock>,
    pub result: String,
    pub unresolved_count: usize,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ConflictBlock {
    pub index: usize,
    pub ours: String,
    pub theirs: String,
    pub decision: ConflictDecision,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum ConflictDecision {
    Unresolved,
    Ours,
    Theirs,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum GitOperation {
    None,
    Merge,
    Rebase,
    CherryPick,
    Revert,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct MergeDocument {
    pub path: String,
    pub labels: MergeLabels,
    pub base: Option<String>,
    pub ours: String,
    pub theirs: String,
    pub working: String,
    pub rows: Vec<MergeRow>,
    pub conflicts: Vec<ConflictRegion>,
    pub result: Vec<ResultLine>,
    pub unresolved_count: usize,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct MergeLabels {
    pub ours: String,
    pub theirs: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct MergeRow {
    pub id: String,
    pub kind: MergeRowKind,
    pub conflict_index: Option<usize>,
    pub ours_line: Option<PaneLine>,
    pub result_line: Option<PaneLine>,
    pub theirs_line: Option<PaneLine>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
#[allow(dead_code)]
pub enum MergeRowKind {
    Context,
    Conflict,
    Insert,
    Delete,
    Empty,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PaneLine {
    pub number: Option<usize>,
    pub text: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ConflictRegion {
    pub index: usize,
    pub row_start: usize,
    pub row_end: usize,
    pub decision: ConflictDecision,
    pub ours: String,
    pub theirs: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ResultLine {
    pub source: ResultSource,
    pub conflict_index: Option<usize>,
    pub text: String,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
#[allow(dead_code)]
pub enum ResultSource {
    Context,
    Ours,
    Theirs,
    Manual,
    Unresolved,
}

#[derive(Debug, Clone)]
struct ParsedFile {
    segments: Vec<Segment>,
}

#[derive(Debug, Clone)]
enum Segment {
    Text(String),
    Conflict { ours: String, theirs: String },
}

pub fn load_workspace(cwd: &Path) -> Result<WorkspaceSnapshot, String> {
    let root = resolve_repo_root(cwd).map_err(repo_error_to_string)?;
    let root_str = root.to_string_lossy().to_string();
    let repo_name = root
        .file_name()
        .map(|name| name.to_string_lossy().to_string())
        .unwrap_or_else(|| root_str.clone());

    let branch =
        git_stdout(&root, &["rev-parse", "--abbrev-ref", "HEAD"]).unwrap_or_else(|_| "HEAD".into());
    let operation = detect_operation(&root);
    let (ours_label, theirs_label) = side_labels(&root, operation, &branch);
    let headline = build_headline(operation, &ours_label, &theirs_label);
    let files = list_conflict_files(&root)?;
    let total_blocks = files.iter().map(|file| file.conflict_count).sum();

    Ok(WorkspaceSnapshot {
        cwd: cwd.display().to_string(),
        root: root_str,
        repo_name,
        branch,
        operation,
        ours_label,
        theirs_label,
        headline,
        files,
        total_blocks,
    })
}

/// Accept an entire conflicted file as ours or theirs, then stage it.
pub fn accept_file_side(root: &Path, path: &str, side: &str) -> Result<(), String> {
    let flag = match side {
        "ours" => "--ours",
        "theirs" => "--theirs",
        other => return Err(format!("未知侧: {other}")),
    };
    git_run(root, &["checkout", flag, "--", path])?;
    git_run(root, &["add", "--", path])?;
    Ok(())
}

pub fn load_conflict_file(root: &Path, path: &str) -> Result<ConflictFileDetail, String> {
    let ours = git_show_stage(root, 2, path).unwrap_or_default();
    let theirs = git_show_stage(root, 3, path).unwrap_or_default();
    let base = git_show_stage(root, 1, path).ok();
    let working = read_working_tree_file(root, path)?;
    let parsed = parse_conflict_file(&working)?;

    let blocks: Vec<ConflictBlock> = parsed
        .segments
        .iter()
        .filter_map(|segment| match segment {
            Segment::Conflict { ours, theirs } => Some((ours.clone(), theirs.clone())),
            Segment::Text(_) => None,
        })
        .enumerate()
        .map(|(index, (ours, theirs))| ConflictBlock {
            index,
            ours,
            theirs,
            decision: ConflictDecision::Unresolved,
        })
        .collect();

    let unresolved_count = blocks.len();
    let result = render_result(&parsed, &blocks);

    Ok(ConflictFileDetail {
        path: path.to_string(),
        ours,
        theirs,
        base,
        blocks,
        result,
        unresolved_count,
    })
}

pub fn apply_decisions_and_save(
    root: &Path,
    path: &str,
    decisions: &[ConflictDecision],
    stage: bool,
) -> Result<ConflictFileDetail, String> {
    let working = read_working_tree_file(root, path)?;
    let parsed = parse_conflict_file(&working)?;
    let conflict_count = parsed
        .segments
        .iter()
        .filter(|segment| matches!(segment, Segment::Conflict { .. }))
        .count();

    if decisions.len() != conflict_count {
        return Err(format!(
            "决策数量不匹配：期望 {conflict_count}，实际 {}",
            decisions.len()
        ));
    }

    if decisions
        .iter()
        .any(|decision| *decision == ConflictDecision::Unresolved)
    {
        return Err("仍有未解决的冲突块，无法保存".into());
    }

    let blocks: Vec<ConflictBlock> = parsed
        .segments
        .iter()
        .filter_map(|segment| match segment {
            Segment::Conflict { ours, theirs } => Some((ours.clone(), theirs.clone())),
            Segment::Text(_) => None,
        })
        .enumerate()
        .map(|(index, (ours, theirs))| ConflictBlock {
            index,
            ours,
            theirs,
            decision: decisions[index],
        })
        .collect();

    let result = render_result(&parsed, &blocks);
    let absolute = root.join(path);
    if let Some(parent) = absolute.parent() {
        std::fs::create_dir_all(parent).map_err(|err| format!("创建目录失败: {err}"))?;
    }
    std::fs::write(&absolute, &result).map_err(|err| format!("写入文件失败: {err}"))?;

    if stage {
        git_run(root, &["add", "--", path])?;
    }

    load_conflict_file(root, path).or_else(|_| {
        Ok(ConflictFileDetail {
            path: path.to_string(),
            ours: git_show_stage(root, 2, path).unwrap_or_default(),
            theirs: git_show_stage(root, 3, path).unwrap_or_default(),
            base: git_show_stage(root, 1, path).ok(),
            blocks: Vec::new(),
            result,
            unresolved_count: 0,
        })
    })
}

pub fn load_merge_document(root: &Path, path: &str) -> Result<MergeDocument, String> {
    let ours = git_show_stage(root, 2, path).unwrap_or_default();
    let theirs = git_show_stage(root, 3, path).unwrap_or_default();
    let base = git_show_stage(root, 1, path).ok();
    let working = read_working_tree_file(root, path)?;
    let branch =
        git_stdout(root, &["rev-parse", "--abbrev-ref", "HEAD"]).unwrap_or_else(|_| "HEAD".into());
    let operation = detect_operation(root);
    let (ours_label, theirs_label) = side_labels(root, operation, &branch);

    let parsed = parse_conflict_file(&working)?;
    let marker_conflicts = parsed_conflict_count(&parsed);
    let (rows, conflicts, result) = if marker_conflicts > 0 {
        build_marker_document(&parsed)
    } else if let Some(base) = base.as_deref() {
        build_three_way_document(base, &ours, &theirs)
    } else {
        build_marker_document(&parsed)
    };

    Ok(MergeDocument {
        path: path.to_string(),
        labels: MergeLabels {
            ours: ours_label,
            theirs: theirs_label,
        },
        base,
        ours,
        theirs,
        working,
        unresolved_count: conflicts.len(),
        rows,
        conflicts,
        result,
    })
}

pub fn save_merge_result(
    root: &Path,
    path: &str,
    result: &str,
    stage: bool,
) -> Result<ConflictFileDetail, String> {
    if result.lines().any(|line| {
        line.starts_with("<<<<<<<") || line.starts_with("=======") || line.starts_with(">>>>>>>")
    }) {
        return Err("结果仍包含冲突标记，无法保存".into());
    }

    let absolute = root.join(path);
    if let Some(parent) = absolute.parent() {
        std::fs::create_dir_all(parent).map_err(|err| format!("创建目录失败: {err}"))?;
    }
    std::fs::write(&absolute, result).map_err(|err| format!("写入文件失败: {err}"))?;

    if stage {
        git_run(root, &["add", "--", path])?;
    }

    load_conflict_file(root, path).or_else(|_| {
        Ok(ConflictFileDetail {
            path: path.to_string(),
            ours: git_show_stage(root, 2, path).unwrap_or_default(),
            theirs: git_show_stage(root, 3, path).unwrap_or_default(),
            base: git_show_stage(root, 1, path).ok(),
            blocks: Vec::new(),
            result: result.to_string(),
            unresolved_count: 0,
        })
    })
}

fn build_marker_document(
    parsed: &ParsedFile,
) -> (Vec<MergeRow>, Vec<ConflictRegion>, Vec<ResultLine>) {
    let mut rows = Vec::new();
    let mut conflicts = Vec::new();
    let mut result_lines = Vec::new();
    let mut ours_line_no = 1usize;
    let mut theirs_line_no = 1usize;
    let mut result_line_no = 1usize;
    let mut conflict_index = 0usize;

    for segment in &parsed.segments {
        match segment {
            Segment::Text(text) => {
                for line in split_content_lines(text) {
                    push_context_row(
                        &mut rows,
                        &mut result_lines,
                        &mut ours_line_no,
                        &mut theirs_line_no,
                        &mut result_line_no,
                        line,
                    );
                }
            }
            Segment::Conflict { ours, theirs } => {
                let ours_lines = split_content_lines(ours);
                let theirs_lines = split_content_lines(theirs);
                push_conflict_region(
                    &ours_lines,
                    &theirs_lines,
                    &mut rows,
                    &mut conflicts,
                    &mut ours_line_no,
                    &mut theirs_line_no,
                    &mut conflict_index,
                );
            }
        }
    }

    (rows, conflicts, result_lines)
}

fn build_three_way_document(
    base: &str,
    ours: &str,
    theirs: &str,
) -> (Vec<MergeRow>, Vec<ConflictRegion>, Vec<ResultLine>) {
    let base_lines = split_content_lines(base);
    let ours_lines = split_content_lines(ours);
    let theirs_lines = split_content_lines(theirs);
    let ours_changes = diff_change_hunks(&base_lines, &ours_lines);
    let theirs_changes = diff_change_hunks(&base_lines, &theirs_lines);

    let mut rows = Vec::new();
    let mut conflicts = Vec::new();
    let mut result_lines = Vec::new();
    let mut result_line_no = 1usize;
    let mut conflict_index = 0usize;

    let mut base_pos = 0usize;
    let mut ours_pos = 0usize;
    let mut theirs_pos = 0usize;
    let mut ours_hunk_index = 0usize;
    let mut theirs_hunk_index = 0usize;

    while ours_hunk_index < ours_changes.len() || theirs_hunk_index < theirs_changes.len() {
        let next_start = match (
            ours_changes.get(ours_hunk_index),
            theirs_changes.get(theirs_hunk_index),
        ) {
            (Some(ours_hunk), Some(theirs_hunk)) => {
                ours_hunk.base_start.min(theirs_hunk.base_start)
            }
            (Some(ours_hunk), None) => ours_hunk.base_start,
            (None, Some(theirs_hunk)) => theirs_hunk.base_start,
            (None, None) => break,
        };

        while base_pos < next_start {
            push_auto_row(
                &mut rows,
                &mut result_lines,
                MergeRowKind::Context,
                Some((ours_pos + 1, ours_lines[ours_pos].clone())),
                Some((result_line_no, base_lines[base_pos].clone())),
                Some((theirs_pos + 1, theirs_lines[theirs_pos].clone())),
                ResultSource::Context,
            );
            base_pos += 1;
            ours_pos += 1;
            theirs_pos += 1;
            result_line_no += 1;
        }

        let group = collect_change_group(
            &ours_changes,
            &mut ours_hunk_index,
            &theirs_changes,
            &mut theirs_hunk_index,
        );
        let base_len = group.base_end.saturating_sub(group.base_start);

        let (ours_changed, ours_start, ours_end) = match group.ours_span {
            Some((start, end)) => (true, start, end),
            None => (false, ours_pos, ours_pos + base_len),
        };
        let (theirs_changed, theirs_start, theirs_end) = match group.theirs_span {
            Some((start, end)) => (true, start, end),
            None => (false, theirs_pos, theirs_pos + base_len),
        };

        let ours_chunk = &ours_lines[ours_start..ours_end];
        let theirs_chunk = &theirs_lines[theirs_start..theirs_end];

        if ours_changed && theirs_changed && ours_chunk != theirs_chunk {
            let mut ours_line_no = ours_start + 1;
            let mut theirs_line_no = theirs_start + 1;
            push_conflict_region(
                ours_chunk,
                theirs_chunk,
                &mut rows,
                &mut conflicts,
                &mut ours_line_no,
                &mut theirs_line_no,
                &mut conflict_index,
            );
        } else {
            let (result_chunk, source) = if ours_changed {
                (ours_chunk, ResultSource::Ours)
            } else if theirs_changed {
                (theirs_chunk, ResultSource::Theirs)
            } else {
                (
                    &base_lines[group.base_start..group.base_end],
                    ResultSource::Context,
                )
            };
            push_auto_change_rows(
                &mut rows,
                &mut result_lines,
                &mut result_line_no,
                &ours_lines[ours_start..ours_end],
                ours_start,
                result_chunk,
                source,
                &theirs_lines[theirs_start..theirs_end],
                theirs_start,
                group.base_end == group.base_start,
            );
        }

        base_pos = group.base_end;
        ours_pos = ours_end;
        theirs_pos = theirs_end;
    }

    while base_pos < base_lines.len() {
        push_auto_row(
            &mut rows,
            &mut result_lines,
            MergeRowKind::Context,
            Some((ours_pos + 1, ours_lines[ours_pos].clone())),
            Some((result_line_no, base_lines[base_pos].clone())),
            Some((theirs_pos + 1, theirs_lines[theirs_pos].clone())),
            ResultSource::Context,
        );
        base_pos += 1;
        ours_pos += 1;
        theirs_pos += 1;
        result_line_no += 1;
    }

    (rows, conflicts, result_lines)
}

fn push_conflict_region(
    hunk_ours: &[String],
    hunk_theirs: &[String],
    rows: &mut Vec<MergeRow>,
    conflicts: &mut Vec<ConflictRegion>,
    ours_line_no: &mut usize,
    theirs_line_no: &mut usize,
    conflict_index: &mut usize,
) {
    if hunk_ours.is_empty() && hunk_theirs.is_empty() {
        return;
    }
    let row_start = rows.len();
    let row_count = hunk_ours.len().max(hunk_theirs.len()).max(1);
    for offset in 0..row_count {
        let ours_line = hunk_ours.get(offset).map(|text| {
            let line = PaneLine {
                number: Some(*ours_line_no),
                text: text.clone(),
            };
            *ours_line_no += 1;
            line
        });
        let theirs_line = hunk_theirs.get(offset).map(|text| {
            let line = PaneLine {
                number: Some(*theirs_line_no),
                text: text.clone(),
            };
            *theirs_line_no += 1;
            line
        });
        let kind = if ours_line.is_none() && theirs_line.is_none() {
            MergeRowKind::Empty
        } else {
            MergeRowKind::Conflict
        };
        rows.push(MergeRow {
            id: format!("r{}", rows.len()),
            kind,
            conflict_index: Some(*conflict_index),
            ours_line,
            result_line: None,
            theirs_line,
        });
    }
    conflicts.push(ConflictRegion {
        index: *conflict_index,
        row_start,
        row_end: rows.len().saturating_sub(1),
        decision: ConflictDecision::Unresolved,
        ours: join_content_lines(hunk_ours),
        theirs: join_content_lines(hunk_theirs),
    });
    *conflict_index += 1;
}

fn push_context_row(
    rows: &mut Vec<MergeRow>,
    result_lines: &mut Vec<ResultLine>,
    ours_line_no: &mut usize,
    theirs_line_no: &mut usize,
    result_line_no: &mut usize,
    line: String,
) {
    let pane = PaneLine {
        number: Some(*ours_line_no),
        text: line.clone(),
    };
    rows.push(MergeRow {
        id: format!("r{}", rows.len()),
        kind: MergeRowKind::Context,
        conflict_index: None,
        ours_line: Some(pane.clone()),
        result_line: Some(PaneLine {
            number: Some(*result_line_no),
            text: line.clone(),
        }),
        theirs_line: Some(PaneLine {
            number: Some(*theirs_line_no),
            text: line.clone(),
        }),
    });
    result_lines.push(ResultLine {
        source: ResultSource::Context,
        conflict_index: None,
        text: line,
    });
    *ours_line_no += 1;
    *theirs_line_no += 1;
    *result_line_no += 1;
}

fn push_auto_change_rows(
    rows: &mut Vec<MergeRow>,
    result_lines: &mut Vec<ResultLine>,
    result_line_no: &mut usize,
    ours_chunk: &[String],
    ours_start: usize,
    result_chunk: &[String],
    source: ResultSource,
    theirs_chunk: &[String],
    theirs_start: usize,
    is_insertion: bool,
) {
    let row_count = ours_chunk
        .len()
        .max(result_chunk.len())
        .max(theirs_chunk.len())
        .max(1);
    for offset in 0..row_count {
        let result_line = result_chunk.get(offset).map(|text| {
            let line = (*result_line_no, text.clone());
            *result_line_no += 1;
            line
        });
        let kind = if result_chunk.is_empty() {
            MergeRowKind::Delete
        } else if is_insertion || ours_chunk.is_empty() || theirs_chunk.is_empty() {
            MergeRowKind::Insert
        } else {
            MergeRowKind::Context
        };
        push_auto_row(
            rows,
            result_lines,
            kind,
            ours_chunk
                .get(offset)
                .map(|text| (ours_start + offset + 1, text.clone())),
            result_line,
            theirs_chunk
                .get(offset)
                .map(|text| (theirs_start + offset + 1, text.clone())),
            source,
        );
    }
}

fn push_auto_row(
    rows: &mut Vec<MergeRow>,
    result_lines: &mut Vec<ResultLine>,
    kind: MergeRowKind,
    ours_line: Option<(usize, String)>,
    result_line: Option<(usize, String)>,
    theirs_line: Option<(usize, String)>,
    source: ResultSource,
) {
    let result_text = result_line.as_ref().map(|(_, text)| text.clone());
    rows.push(MergeRow {
        id: format!("r{}", rows.len()),
        kind,
        conflict_index: None,
        ours_line: ours_line.map(|(number, text)| PaneLine {
            number: Some(number),
            text,
        }),
        result_line: result_line.map(|(number, text)| PaneLine {
            number: Some(number),
            text,
        }),
        theirs_line: theirs_line.map(|(number, text)| PaneLine {
            number: Some(number),
            text,
        }),
    });

    if let Some(text) = result_text {
        result_lines.push(ResultLine {
            source,
            conflict_index: None,
            text,
        });
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
enum LineOp {
    Equal(String),
    OursOnly(String),
    TheirsOnly(String),
}

#[derive(Debug, Clone, PartialEq, Eq)]
struct DiffChangeHunk {
    base_start: usize,
    base_end: usize,
    side_start: usize,
    side_end: usize,
}

#[derive(Debug, Clone)]
struct ChangeGroup {
    base_start: usize,
    base_end: usize,
    ours_span: Option<(usize, usize)>,
    theirs_span: Option<(usize, usize)>,
}

/// LCS 行级 diff：相同行打断冲突，连续差异合并为一个冲突块（类 WebStorm）。
fn line_diff_ops(ours: &[String], theirs: &[String]) -> Vec<LineOp> {
    let n = ours.len();
    let m = theirs.len();
    let mut dp = vec![vec![0usize; m + 1]; n + 1];
    for i in (0..n).rev() {
        for j in (0..m).rev() {
            if ours[i] == theirs[j] {
                dp[i][j] = dp[i + 1][j + 1] + 1;
            } else {
                dp[i][j] = dp[i + 1][j].max(dp[i][j + 1]);
            }
        }
    }

    let mut ops = Vec::new();
    let mut i = 0usize;
    let mut j = 0usize;
    while i < n && j < m {
        if ours[i] == theirs[j] && dp[i][j] == dp[i + 1][j + 1] + 1 {
            ops.push(LineOp::Equal(ours[i].clone()));
            i += 1;
            j += 1;
        } else if dp[i + 1][j] >= dp[i][j + 1] {
            ops.push(LineOp::OursOnly(ours[i].clone()));
            i += 1;
        } else {
            ops.push(LineOp::TheirsOnly(theirs[j].clone()));
            j += 1;
        }
    }
    while i < n {
        ops.push(LineOp::OursOnly(ours[i].clone()));
        i += 1;
    }
    while j < m {
        ops.push(LineOp::TheirsOnly(theirs[j].clone()));
        j += 1;
    }
    ops
}

fn diff_change_hunks(base: &[String], side: &[String]) -> Vec<DiffChangeHunk> {
    let ops = line_diff_ops(base, side);
    let mut hunks = Vec::new();
    let mut current: Option<DiffChangeHunk> = None;
    let mut base_pos = 0usize;
    let mut side_pos = 0usize;

    for op in ops {
        match op {
            LineOp::Equal(_) => {
                if let Some(hunk) = current.take() {
                    hunks.push(hunk);
                }
                base_pos += 1;
                side_pos += 1;
            }
            LineOp::OursOnly(_) => {
                let hunk = current.get_or_insert(DiffChangeHunk {
                    base_start: base_pos,
                    base_end: base_pos,
                    side_start: side_pos,
                    side_end: side_pos,
                });
                hunk.base_end = base_pos + 1;
                base_pos += 1;
            }
            LineOp::TheirsOnly(_) => {
                let hunk = current.get_or_insert(DiffChangeHunk {
                    base_start: base_pos,
                    base_end: base_pos,
                    side_start: side_pos,
                    side_end: side_pos,
                });
                hunk.side_end = side_pos + 1;
                side_pos += 1;
            }
        }
    }

    if let Some(hunk) = current {
        hunks.push(hunk);
    }

    hunks
}

fn collect_change_group(
    ours_changes: &[DiffChangeHunk],
    ours_index: &mut usize,
    theirs_changes: &[DiffChangeHunk],
    theirs_index: &mut usize,
) -> ChangeGroup {
    let start = match (
        ours_changes.get(*ours_index),
        theirs_changes.get(*theirs_index),
    ) {
        (Some(ours_hunk), Some(theirs_hunk)) => ours_hunk.base_start.min(theirs_hunk.base_start),
        (Some(ours_hunk), None) => ours_hunk.base_start,
        (None, Some(theirs_hunk)) => theirs_hunk.base_start,
        (None, None) => 0,
    };

    let mut group = ChangeGroup {
        base_start: start,
        base_end: start,
        ours_span: None,
        theirs_span: None,
    };

    loop {
        let mut changed = false;
        while let Some(hunk) = ours_changes.get(*ours_index) {
            if !hunk_belongs_to_group(hunk, group.base_start, group.base_end) {
                break;
            }
            add_hunk_to_group(&mut group, hunk, true);
            *ours_index += 1;
            changed = true;
        }
        while let Some(hunk) = theirs_changes.get(*theirs_index) {
            if !hunk_belongs_to_group(hunk, group.base_start, group.base_end) {
                break;
            }
            add_hunk_to_group(&mut group, hunk, false);
            *theirs_index += 1;
            changed = true;
        }
        if !changed {
            break;
        }
    }

    group
}

fn hunk_belongs_to_group(hunk: &DiffChangeHunk, group_start: usize, group_end: usize) -> bool {
    if group_start == group_end {
        return hunk.base_start == group_start;
    }
    if hunk.base_start == hunk.base_end {
        return hunk.base_start >= group_start && hunk.base_start < group_end;
    }
    hunk.base_start < group_end && hunk.base_end > group_start
}

fn add_hunk_to_group(group: &mut ChangeGroup, hunk: &DiffChangeHunk, is_ours: bool) {
    group.base_start = group.base_start.min(hunk.base_start);
    group.base_end = group.base_end.max(hunk.base_end);

    let span = if is_ours {
        &mut group.ours_span
    } else {
        &mut group.theirs_span
    };
    match span {
        Some((start, end)) => {
            *start = (*start).min(hunk.side_start);
            *end = (*end).max(hunk.side_end);
        }
        None => {
            *span = Some((hunk.side_start, hunk.side_end));
        }
    }
}

fn split_content_lines(text: &str) -> Vec<String> {
    if text.is_empty() {
        return Vec::new();
    }
    text.lines().map(str::to_string).collect()
}

fn join_content_lines(lines: &[String]) -> String {
    lines.join("\n")
}

fn count_conflict_blocks(content: &str) -> usize {
    match parse_conflict_file(content) {
        Ok(parsed) => {
            let (_, conflicts, _) = build_marker_document(&parsed);
            conflicts.len()
        }
        Err(_) => count_conflict_markers(content),
    }
}

fn parsed_conflict_count(parsed: &ParsedFile) -> usize {
    parsed
        .segments
        .iter()
        .filter(|segment| matches!(segment, Segment::Conflict { .. }))
        .count()
}

fn count_merge_conflicts(root: &Path, path: &str, working: &str) -> usize {
    if let Ok(parsed) = parse_conflict_file(working) {
        let marker_conflicts = parsed_conflict_count(&parsed);
        if marker_conflicts > 0 {
            return marker_conflicts;
        }
    }

    match (
        git_show_stage(root, 1, path),
        git_show_stage(root, 2, path),
        git_show_stage(root, 3, path),
    ) {
        (Ok(base), Ok(ours), Ok(theirs)) => {
            let (_, conflicts, _) = build_three_way_document(&base, &ours, &theirs);
            conflicts.len()
        }
        _ => count_conflict_blocks(working),
    }
}

fn list_conflict_files(root: &Path) -> Result<Vec<ConflictFileSummary>, String> {
    let output = git_stdout(root, &["diff", "--name-only", "--diff-filter=U"])?;
    if output.is_empty() {
        return Ok(Vec::new());
    }

    let stage_map = unmerged_stage_map(root)?;
    let mut files = Vec::new();
    for path in output.lines().filter(|line| !line.is_empty()) {
        let working = read_working_tree_file(root, path).unwrap_or_default();
        let conflict_count = count_merge_conflicts(root, path, &working);
        let stages = stage_map.get(path).copied().unwrap_or_default();
        let (file_name, directory) = split_path(path);
        files.push(ConflictFileSummary {
            path: path.to_string(),
            file_name,
            directory,
            conflict_count,
            ours_status: side_status(stages.has_base, stages.has_ours),
            theirs_status: side_status(stages.has_base, stages.has_theirs),
            staged: false,
        });
    }
    Ok(files)
}

#[derive(Debug, Clone, Copy, Default)]
struct StageFlags {
    has_base: bool,
    has_ours: bool,
    has_theirs: bool,
}

fn unmerged_stage_map(
    root: &Path,
) -> Result<std::collections::HashMap<String, StageFlags>, String> {
    let output = git_stdout(root, &["ls-files", "-u"])?;
    let mut map = std::collections::HashMap::new();
    for line in output.lines().filter(|line| !line.is_empty()) {
        // format: <mode> <sha> <stage>\t<path>
        let Some((meta, path)) = line.split_once('\t') else {
            continue;
        };
        let stage = meta.split_whitespace().nth(2).unwrap_or("0");
        let entry = map.entry(path.to_string()).or_insert(StageFlags::default());
        match stage {
            "1" => entry.has_base = true,
            "2" => entry.has_ours = true,
            "3" => entry.has_theirs = true,
            _ => {}
        }
    }
    Ok(map)
}

fn side_status(has_base: bool, has_side: bool) -> SideStatus {
    match (has_base, has_side) {
        (true, true) => SideStatus::Modified,
        (false, true) => SideStatus::Added,
        (_, false) => SideStatus::Deleted,
    }
}

fn split_path(path: &str) -> (String, String) {
    match path.rsplit_once('/') {
        Some((dir, name)) => (name.to_string(), dir.to_string()),
        None => (path.to_string(), String::new()),
    }
}

fn build_headline(operation: GitOperation, ours: &str, theirs: &str) -> String {
    match operation {
        GitOperation::Merge => format!("Merging branch {theirs} into branch {ours}"),
        GitOperation::Rebase => format!("Rebasing {ours} onto {theirs}"),
        GitOperation::CherryPick => format!("Cherry-picking into {ours}"),
        GitOperation::Revert => format!("Reverting in {ours}"),
        GitOperation::None => format!("Conflicts in {ours}"),
    }
}

fn detect_operation(root: &Path) -> GitOperation {
    let git_dir = PathBuf::from(
        git_stdout(root, &["rev-parse", "--git-dir"]).unwrap_or_else(|_| ".git".into()),
    );
    let git_dir = if git_dir.is_absolute() {
        git_dir
    } else {
        root.join(git_dir)
    };

    if git_dir.join("MERGE_HEAD").exists() {
        return GitOperation::Merge;
    }
    if git_dir.join("REVERT_HEAD").exists() {
        return GitOperation::Revert;
    }
    if git_dir.join("CHERRY_PICK_HEAD").exists() {
        return GitOperation::CherryPick;
    }
    if git_dir.join("rebase-merge").exists() || git_dir.join("rebase-apply").exists() {
        return GitOperation::Rebase;
    }
    GitOperation::None
}

fn side_labels(root: &Path, operation: GitOperation, branch: &str) -> (String, String) {
    let ours = match operation {
        GitOperation::Rebase => "onto".to_string(),
        _ => branch.to_string(),
    };

    let theirs = match operation {
        GitOperation::Merge => git_stdout(root, &["rev-parse", "--abbrev-ref", "MERGE_HEAD"])
            .or_else(|_| git_stdout(root, &["log", "-1", "--pretty=%s", "MERGE_HEAD"]))
            .unwrap_or_else(|_| "incoming".into()),
        GitOperation::Rebase => "rebasing".to_string(),
        GitOperation::CherryPick => "cherry-pick".to_string(),
        GitOperation::Revert => "revert".to_string(),
        GitOperation::None => "theirs".to_string(),
    };

    (ours, theirs)
}

fn git_show_stage(root: &Path, stage: u8, path: &str) -> Result<String, String> {
    let output = git_command(root, &["show", &format!(":{stage}:{path}")])?;
    if !output.status.success() {
        let stderr = String::from_utf8_lossy(&output.stderr).trim().to_string();
        return Err(if stderr.is_empty() {
            format!("无法读取 stage {stage}: {path}")
        } else {
            stderr
        });
    }
    Ok(String::from_utf8_lossy(&output.stdout).to_string())
}

fn read_working_tree_file(root: &Path, path: &str) -> Result<String, String> {
    let absolute = root.join(path);
    std::fs::read_to_string(&absolute)
        .map_err(|err| format!("读取工作区文件失败 {}: {err}", absolute.display()))
}

fn count_conflict_markers(content: &str) -> usize {
    content
        .lines()
        .filter(|line| line.starts_with("<<<<<<<"))
        .count()
}

fn parse_conflict_file(content: &str) -> Result<ParsedFile, String> {
    let mut segments = Vec::new();
    let mut text = String::new();
    let mut ours = String::new();
    let mut theirs = String::new();
    let mut state = ParseState::Text;
    let ends_with_newline = content.ends_with('\n');

    for line in content.lines() {
        match state {
            ParseState::Text => {
                if line.starts_with("<<<<<<<") {
                    if !text.is_empty() {
                        segments.push(Segment::Text(std::mem::take(&mut text)));
                    }
                    state = ParseState::Ours;
                } else {
                    push_line(&mut text, line);
                }
            }
            ParseState::Ours => {
                if line.starts_with("=======") {
                    state = ParseState::Theirs;
                } else {
                    push_line(&mut ours, line);
                }
            }
            ParseState::Theirs => {
                if line.starts_with(">>>>>>>") {
                    segments.push(Segment::Conflict {
                        ours: std::mem::take(&mut ours),
                        theirs: std::mem::take(&mut theirs),
                    });
                    state = ParseState::Text;
                } else {
                    push_line(&mut theirs, line);
                }
            }
        }
    }

    if state != ParseState::Text {
        return Err("冲突标记不完整，无法解析文件".into());
    }
    if !text.is_empty() {
        if ends_with_newline {
            text.push('\n');
        }
        segments.push(Segment::Text(text));
    } else if ends_with_newline {
        // File ended with a conflict marker line; still preserve final newline.
        if let Some(Segment::Text(last)) = segments.last_mut() {
            if !last.ends_with('\n') {
                last.push('\n');
            }
        }
    }

    Ok(ParsedFile { segments })
}

#[derive(PartialEq, Eq)]
enum ParseState {
    Text,
    Ours,
    Theirs,
}

fn push_line(buffer: &mut String, line: &str) {
    if !buffer.is_empty() {
        buffer.push('\n');
    }
    buffer.push_str(line);
}

fn render_result(parsed: &ParsedFile, blocks: &[ConflictBlock]) -> String {
    let mut result = String::new();
    let mut block_index = 0usize;

    for segment in &parsed.segments {
        match segment {
            Segment::Text(text) => {
                if !result.is_empty() && !text.is_empty() {
                    result.push('\n');
                }
                result.push_str(text);
            }
            Segment::Conflict { ours, theirs } => {
                let decision = blocks
                    .get(block_index)
                    .map(|block| block.decision)
                    .unwrap_or(ConflictDecision::Unresolved);
                let chunk = match decision {
                    ConflictDecision::Ours => ours.clone(),
                    ConflictDecision::Theirs => theirs.clone(),
                    ConflictDecision::Unresolved => {
                        format!("<<<<<<< ours\n{ours}\n=======\n{theirs}\n>>>>>>> theirs")
                    }
                };
                if !result.is_empty() && !chunk.is_empty() {
                    result.push('\n');
                }
                result.push_str(&chunk);
                block_index += 1;
            }
        }
    }

    if content_ends_with_newline(parsed) && !result.ends_with('\n') {
        result.push('\n');
    }
    result
}

fn content_ends_with_newline(parsed: &ParsedFile) -> bool {
    match parsed.segments.last() {
        Some(Segment::Text(text)) => text.ends_with('\n'),
        _ => false,
    }
}

fn git_stdout(root: &Path, args: &[&str]) -> Result<String, String> {
    let output = git_command(root, args)?;
    if !output.status.success() {
        let stderr = String::from_utf8_lossy(&output.stderr).trim().to_string();
        return Err(if stderr.is_empty() {
            format!("git {} 失败", args.join(" "))
        } else {
            stderr
        });
    }
    Ok(String::from_utf8_lossy(&output.stdout)
        .trim_end()
        .to_string())
}

fn git_run(root: &Path, args: &[&str]) -> Result<(), String> {
    let output = git_command(root, args)?;
    if !output.status.success() {
        let stderr = String::from_utf8_lossy(&output.stderr).trim().to_string();
        return Err(if stderr.is_empty() {
            format!("git {} 失败", args.join(" "))
        } else {
            stderr
        });
    }
    Ok(())
}

fn git_command(root: &Path, args: &[&str]) -> Result<std::process::Output, String> {
    Command::new("git")
        .args(args)
        .current_dir(root)
        .output()
        .map_err(|err| {
            if err.kind() == std::io::ErrorKind::NotFound {
                "未找到 git，请先安装 Git。".into()
            } else {
                err.to_string()
            }
        })
}

fn repo_error_to_string(err: RepoError) -> String {
    err.to_string()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_single_conflict_and_renders_ours() {
        let content = "head\n<<<<<<< ours\nA\n=======\nB\n>>>>>>> theirs\ntail\n";
        let parsed = parse_conflict_file(content).unwrap();
        let blocks = vec![ConflictBlock {
            index: 0,
            ours: "A".into(),
            theirs: "B".into(),
            decision: ConflictDecision::Ours,
        }];
        let result = render_result(&parsed, &blocks);
        assert_eq!(result, "head\nA\ntail\n");
    }

    #[test]
    fn counts_conflict_markers() {
        let content = "<<<<<<< a\nx\n=======\ny\n>>>>>>> b\n<<<<<<< c\n1\n=======\n2\n>>>>>>> d\n";
        assert_eq!(count_conflict_markers(content), 2);
    }

    #[test]
    fn builds_aligned_rows_for_uneven_conflict() {
        let content = "head\n<<<<<<< ours\nA\nB\n=======\nX\n>>>>>>> theirs\ntail\n";
        let parsed = parse_conflict_file(content).unwrap();
        let (rows, conflicts, result) = build_marker_document(&parsed);
        assert_eq!(conflicts.len(), 1);
        assert_eq!(conflicts[0].row_start, 1);
        assert!(conflicts[0].row_end >= conflicts[0].row_start);
        assert!(rows.iter().any(|row| row.kind == MergeRowKind::Conflict));
        assert!(rows
            .iter()
            .filter(|row| row.conflict_index == Some(0))
            .all(|row| row.result_line.is_none()));
        assert!(result
            .iter()
            .all(|line| line.source != ResultSource::Unresolved));
        assert_eq!(rows[0].kind, MergeRowKind::Context);
        assert_eq!(rows.last().map(|row| row.kind), Some(MergeRowKind::Context));
    }

    #[test]
    fn builds_multiple_conflicts_with_context() {
        let content = "a\n<<<<<<< ours\n1\n=======\n2\n>>>>>>> theirs\nb\n<<<<<<< ours\n3\n=======\n4\n>>>>>>> theirs\nc\n";
        let parsed = parse_conflict_file(content).unwrap();
        let (_rows, conflicts, _result) = build_marker_document(&parsed);
        assert_eq!(conflicts.len(), 2);
        assert_eq!(conflicts[0].ours, "1");
        assert_eq!(conflicts[1].theirs, "4");
    }

    #[test]
    fn keeps_marker_conflict_as_one_unresolved_region() {
        let content = "\
<<<<<<< ours
L1
L2
L3
L4
L5
L6
L7
L8
=======
X1
X2
L3
L4
L5
L6
Y7
L8
>>>>>>> theirs
";
        let parsed = parse_conflict_file(content).unwrap();
        let (rows, conflicts, result) = build_marker_document(&parsed);
        assert_eq!(conflicts.len(), 1);
        assert_eq!(conflicts[0].ours, "L1\nL2\nL3\nL4\nL5\nL6\nL7\nL8");
        assert_eq!(conflicts[0].theirs, "X1\nX2\nL3\nL4\nL5\nL6\nY7\nL8");
        assert!(rows.iter().all(|row| row.kind == MergeRowKind::Conflict));
        assert!(result.is_empty());
    }

    #[test]
    fn line_diff_groups_only_consecutive_changes() {
        let ours = vec!["a".into(), "b".into(), "c".into(), "d".into(), "e".into()];
        let theirs = vec!["a".into(), "B".into(), "c".into(), "D".into(), "e".into()];
        let ops = line_diff_ops(&ours, &theirs);
        assert_eq!(
            ops,
            vec![
                LineOp::Equal("a".into()),
                LineOp::OursOnly("b".into()),
                LineOp::TheirsOnly("B".into()),
                LineOp::Equal("c".into()),
                LineOp::OursOnly("d".into()),
                LineOp::TheirsOnly("D".into()),
                LineOp::Equal("e".into()),
            ]
        );
    }

    #[test]
    fn three_way_applies_non_overlapping_changes() {
        let base = "a\nb\nc\n";
        let ours = "a\nB\nc\n";
        let theirs = "a\nb\nC\n";
        let (rows, conflicts, result) = build_three_way_document(base, ours, theirs);

        assert!(conflicts.is_empty());
        assert_eq!(
            result
                .iter()
                .map(|line| line.text.as_str())
                .collect::<Vec<_>>(),
            vec!["a", "B", "C"]
        );
        assert!(rows.iter().all(|row| row.conflict_index.is_none()));
    }

    #[test]
    fn three_way_keeps_same_line_changes_unresolved() {
        let base = "a\nb\nc\n";
        let ours = "a\nours\nc\n";
        let theirs = "a\ntheirs\nc\n";
        let (_rows, conflicts, result) = build_three_way_document(base, ours, theirs);

        assert_eq!(conflicts.len(), 1);
        assert_eq!(conflicts[0].ours, "ours");
        assert_eq!(conflicts[0].theirs, "theirs");
        assert_eq!(
            result
                .iter()
                .map(|line| line.text.as_str())
                .collect::<Vec<_>>(),
            vec!["a", "c"]
        );
    }

    #[test]
    fn three_way_auto_applies_identical_changes() {
        let base = "a\nb\n";
        let ours = "a\nB\n";
        let theirs = "a\nB\n";
        let (_rows, conflicts, result) = build_three_way_document(base, ours, theirs);

        assert!(conflicts.is_empty());
        assert_eq!(
            result
                .iter()
                .map(|line| line.text.as_str())
                .collect::<Vec<_>>(),
            vec!["a", "B"]
        );
    }

    #[test]
    fn three_way_marks_delete_vs_modify_as_conflict() {
        let base = "a\nb\nc\n";
        let ours = "a\nc\n";
        let theirs = "a\nB\nc\n";
        let (_rows, conflicts, _result) = build_three_way_document(base, ours, theirs);

        assert_eq!(conflicts.len(), 1);
        assert_eq!(conflicts[0].ours, "");
        assert_eq!(conflicts[0].theirs, "B");
    }
}
