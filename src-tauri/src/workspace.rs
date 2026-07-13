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
    OursThenTheirs,
    TheirsThenOurs,
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
    /// 双方都有不同改动 → conflict（红）；仅一方改动 → change（绿）
    pub block_kind: ConflictBlockKind,
    pub ours: String,
    pub theirs: String,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum ConflictBlockKind {
    Conflict,
    Change,
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
    let marker_conflicts = parsed_marker_conflict_count(&parsed);
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
                push_marker_conflict_segments(
                    &ours_lines,
                    &theirs_lines,
                    &mut rows,
                    &mut conflicts,
                    &mut result_lines,
                    &mut ours_line_no,
                    &mut theirs_line_no,
                    &mut result_line_no,
                    &mut conflict_index,
                );
            }
        }
    }

    (rows, conflicts, result_lines)
}

fn push_marker_conflict_segments(
    marker_ours: &[String],
    marker_theirs: &[String],
    rows: &mut Vec<MergeRow>,
    conflicts: &mut Vec<ConflictRegion>,
    result_lines: &mut Vec<ResultLine>,
    ours_line_no: &mut usize,
    theirs_line_no: &mut usize,
    result_line_no: &mut usize,
    conflict_index: &mut usize,
) {
    // 外层 LCS 忽略空行；再对双方替换岛做含空行二次对齐，避免 PORT/中间件/注释被糊成一块
    let ops = refine_marker_change_islands(line_diff_ops(marker_ours, marker_theirs));
    let mut pending_ours = Vec::new();
    let mut pending_theirs = Vec::new();

    for (index, op) in ops.iter().enumerate() {
        match op {
            LineOp::Equal(line) => {
                // 单方连续插入中的空行并入当前块；双方替换段之间的空行当上下文打断
                if is_blank_line(line)
                    && (!pending_ours.is_empty() || !pending_theirs.is_empty())
                    && equal_blank_should_absorb(&ops, index)
                {
                    absorb_equal_blank(
                        &mut pending_ours,
                        &mut pending_theirs,
                        line.clone(),
                    );
                    continue;
                }
                flush_marker_conflict_segment(
                    &mut pending_ours,
                    &mut pending_theirs,
                    rows,
                    conflicts,
                    result_lines,
                    ours_line_no,
                    theirs_line_no,
                    result_line_no,
                    conflict_index,
                );
                push_context_row(
                    rows,
                    result_lines,
                    ours_line_no,
                    theirs_line_no,
                    result_line_no,
                    line.clone(),
                );
            }
            LineOp::OursOnly(line) => pending_ours.push(line.clone()),
            LineOp::TheirsOnly(line) => pending_theirs.push(line.clone()),
        }
    }

    flush_marker_conflict_segment(
        &mut pending_ours,
        &mut pending_theirs,
        rows,
        conflicts,
        result_lines,
        ours_line_no,
        theirs_line_no,
        result_line_no,
        conflict_index,
    );
}

/// 空行后到下一个非空 Equal 之间：仅单方差异 → 吸收；双方都有改动 → 打断。
fn equal_blank_should_absorb(ops: &[LineOp], blank_index: usize) -> bool {
    let mut saw_ours = false;
    let mut saw_theirs = false;
    let mut saw_diff = false;
    for op in ops.iter().skip(blank_index + 1) {
        match op {
            LineOp::Equal(line) if is_blank_line(line) => continue,
            LineOp::Equal(_) => break,
            LineOp::OursOnly(_) => {
                saw_ours = true;
                saw_diff = true;
            }
            LineOp::TheirsOnly(_) => {
                saw_theirs = true;
                saw_diff = true;
            }
        }
    }
    saw_diff && !(saw_ours && saw_theirs)
}

/// 将「先全左后全右」的替换岛用含空行 LCS 再对齐，让相同空行成为块边界。
fn refine_marker_change_islands(ops: Vec<LineOp>) -> Vec<LineOp> {
    let mut refined = Vec::with_capacity(ops.len());
    let mut index = 0usize;
    while index < ops.len() {
        match &ops[index] {
            LineOp::Equal(line) => {
                refined.push(LineOp::Equal(line.clone()));
                index += 1;
            }
            LineOp::OursOnly(_) | LineOp::TheirsOnly(_) => {
                let start = index;
                while index < ops.len() && !matches!(ops[index], LineOp::Equal(_)) {
                    index += 1;
                }
                let island = &ops[start..index];
                let ours: Vec<String> = island
                    .iter()
                    .filter_map(|op| match op {
                        LineOp::OursOnly(line) => Some(line.clone()),
                        _ => None,
                    })
                    .collect();
                let theirs: Vec<String> = island
                    .iter()
                    .filter_map(|op| match op {
                        LineOp::TheirsOnly(line) => Some(line.clone()),
                        _ => None,
                    })
                    .collect();
                if ours.is_empty() || theirs.is_empty() {
                    refined.extend(island.iter().cloned());
                } else {
                    refined.extend(line_diff_ops_including_blanks(&ours, &theirs));
                }
            }
        }
    }
    refined
}

fn is_blank_line(line: &str) -> bool {
    line.trim().is_empty()
}

fn side_has_substantive(lines: &[String]) -> bool {
    lines.iter().any(|line| !is_blank_line(line))
}

/// 相同空行并入当前段时两边都保留，避免一侧丢行导致错位；
/// 红/绿仍由 side_has_substantive 判定，仅空白不会把单方块抬成双方冲突。
fn absorb_equal_blank(
    pending_ours: &mut Vec<String>,
    pending_theirs: &mut Vec<String>,
    line: String,
) {
    pending_ours.push(line.clone());
    pending_theirs.push(line);
}

/// 双方都有差异 → 红色冲突块；仅一方有内容 → 绿色链接块。均需手动 Accept，不自动合入。
/// 纯空行差异不形成冲突块（避免 C 后多出来的空行变成绿色块）。
fn flush_marker_conflict_segment(
    pending_ours: &mut Vec<String>,
    pending_theirs: &mut Vec<String>,
    rows: &mut Vec<MergeRow>,
    conflicts: &mut Vec<ConflictRegion>,
    result_lines: &mut Vec<ResultLine>,
    ours_line_no: &mut usize,
    theirs_line_no: &mut usize,
    result_line_no: &mut usize,
    conflict_index: &mut usize,
) {
    if pending_ours.is_empty() && pending_theirs.is_empty() {
        return;
    }

    // 两侧都没有实质内容：只是空行增减，按上下文展示，不进入冲突列表
    if !side_has_substantive(pending_ours) && !side_has_substantive(pending_theirs) {
        push_blank_only_rows(
            pending_ours,
            pending_theirs,
            rows,
            result_lines,
            ours_line_no,
            theirs_line_no,
            result_line_no,
        );
        pending_ours.clear();
        pending_theirs.clear();
        return;
    }

    // 单方绿块：把空侧前导空行剥成上下文，避免左侧 Express 下空行被吃进绿块后消失
    peel_leading_empty_side_blanks(
        pending_ours,
        pending_theirs,
        rows,
        ours_line_no,
        theirs_line_no,
    );

    if pending_ours.is_empty() && pending_theirs.is_empty() {
        return;
    }

    let block_kind = if side_has_substantive(pending_ours)
        && side_has_substantive(pending_theirs)
    {
        ConflictBlockKind::Conflict
    } else {
        ConflictBlockKind::Change
    };
    push_conflict_region(
        pending_ours,
        pending_theirs,
        rows,
        conflicts,
        ours_line_no,
        theirs_line_no,
        conflict_index,
        block_kind,
    );

    pending_ours.clear();
    pending_theirs.clear();
}

/// 仅一侧有实质内容时，把另一侧开头的占位空行提成普通上下文行。
fn peel_leading_empty_side_blanks(
    pending_ours: &mut Vec<String>,
    pending_theirs: &mut Vec<String>,
    rows: &mut Vec<MergeRow>,
    ours_line_no: &mut usize,
    theirs_line_no: &mut usize,
) {
    let ours_sub = side_has_substantive(pending_ours);
    let theirs_sub = side_has_substantive(pending_theirs);
    if ours_sub == theirs_sub {
        return;
    }

    if !ours_sub && theirs_sub {
        while pending_ours
            .first()
            .is_some_and(|line| is_blank_line(line))
        {
            let line = pending_ours.remove(0);
            // 若右侧也以空行开头，成对提成共享上下文；否则只保留左侧空行
            if pending_theirs
                .first()
                .is_some_and(|line| is_blank_line(line))
            {
                let _ = pending_theirs.remove(0);
                push_side_context_row(
                    rows,
                    ours_line_no,
                    theirs_line_no,
                    Some(line.clone()),
                    Some(line),
                );
            } else {
                push_side_context_row(
                    rows,
                    ours_line_no,
                    theirs_line_no,
                    Some(line),
                    None,
                );
            }
        }
    } else if ours_sub && !theirs_sub {
        while pending_theirs
            .first()
            .is_some_and(|line| is_blank_line(line))
        {
            let line = pending_theirs.remove(0);
            if pending_ours
                .first()
                .is_some_and(|line| is_blank_line(line))
            {
                let _ = pending_ours.remove(0);
                push_side_context_row(
                    rows,
                    ours_line_no,
                    theirs_line_no,
                    Some(line.clone()),
                    Some(line),
                );
            } else {
                push_side_context_row(
                    rows,
                    ours_line_no,
                    theirs_line_no,
                    None,
                    Some(line),
                );
            }
        }
    }
}

fn push_side_context_row(
    rows: &mut Vec<MergeRow>,
    ours_line_no: &mut usize,
    theirs_line_no: &mut usize,
    ours_text: Option<String>,
    theirs_text: Option<String>,
) {
    let ours_line = ours_text.map(|text| {
        let line = PaneLine {
            number: Some(*ours_line_no),
            text,
        };
        *ours_line_no += 1;
        line
    });
    let theirs_line = theirs_text.map(|text| {
        let line = PaneLine {
            number: Some(*theirs_line_no),
            text,
        };
        *theirs_line_no += 1;
        line
    });
    rows.push(MergeRow {
        id: format!("r{}", rows.len()),
        kind: MergeRowKind::Context,
        conflict_index: None,
        ours_line,
        result_line: None,
        theirs_line,
    });
}

/// 纯空行差异：两边一致则写入 Result；不一致则只占位展示，不要求 Accept。
fn push_blank_only_rows(
    hunk_ours: &[String],
    hunk_theirs: &[String],
    rows: &mut Vec<MergeRow>,
    result_lines: &mut Vec<ResultLine>,
    ours_line_no: &mut usize,
    theirs_line_no: &mut usize,
    result_line_no: &mut usize,
) {
    if hunk_ours.is_empty() && hunk_theirs.is_empty() {
        return;
    }

    let both_agree = hunk_ours == hunk_theirs;
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
        let result_line = if both_agree {
            hunk_ours.get(offset).map(|text| {
                let line = PaneLine {
                    number: Some(*result_line_no),
                    text: text.clone(),
                };
                result_lines.push(ResultLine {
                    source: ResultSource::Context,
                    conflict_index: None,
                    text: text.clone(),
                });
                *result_line_no += 1;
                line
            })
        } else {
            None
        };
        rows.push(MergeRow {
            id: format!("r{}", rows.len()),
            kind: MergeRowKind::Context,
            conflict_index: None,
            ours_line,
            result_line,
            theirs_line,
        });
    }
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

        // 任何相对 base 的改动都进入可操作块，不自动合入 Result；
        // 纯空行差异除外，避免多出来的空行变成绿色冲突块。
        if ours_changed || theirs_changed {
            if !side_has_substantive(ours_chunk) && !side_has_substantive(theirs_chunk) {
                let mut ours_line_no = ours_start + 1;
                let mut theirs_line_no = theirs_start + 1;
                push_blank_only_rows(
                    ours_chunk,
                    theirs_chunk,
                    &mut rows,
                    &mut result_lines,
                    &mut ours_line_no,
                    &mut theirs_line_no,
                    &mut result_line_no,
                );
            } else {
                let block_kind = if ours_changed && theirs_changed && ours_chunk != theirs_chunk
                {
                    ConflictBlockKind::Conflict
                } else {
                    ConflictBlockKind::Change
                };
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
                    block_kind,
                );
            }
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
    block_kind: ConflictBlockKind,
) {
    if hunk_ours.is_empty() && hunk_theirs.is_empty() {
        return;
    }
    let row_start = rows.len();
    let row_count = hunk_ours.len().max(hunk_theirs.len()).max(1);
    // 绿色链接块用 Insert，红色冲突块用 Conflict
    let row_kind = match block_kind {
        ConflictBlockKind::Change => MergeRowKind::Insert,
        ConflictBlockKind::Conflict => MergeRowKind::Conflict,
    };
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
            row_kind
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
        block_kind,
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

/// LCS 行级 diff：相同非空行打断冲突；空行不参与 LCS 匹配，按两侧空隙重新挂载，
/// 避免把「Express 后空行」错误对齐到「Go 后空行」从而拆坏/吃掉上下文。
fn line_diff_ops(ours: &[String], theirs: &[String]) -> Vec<LineOp> {
    line_diff_ops_impl(ours, theirs, false)
}

/// 替换岛二次对齐：空行参与 LCS，相同空行可把 PORT / 中间件 / 注释拆成独立块。
fn line_diff_ops_including_blanks(ours: &[String], theirs: &[String]) -> Vec<LineOp> {
    line_diff_ops_impl(ours, theirs, true)
}

fn line_diff_ops_impl(ours: &[String], theirs: &[String], match_blanks: bool) -> Vec<LineOp> {
    let ours_nb: Vec<usize> = if match_blanks {
        (0..ours.len()).collect()
    } else {
        (0..ours.len())
            .filter(|&i| !is_blank_line(&ours[i]))
            .collect()
    };
    let theirs_nb: Vec<usize> = if match_blanks {
        (0..theirs.len()).collect()
    } else {
        (0..theirs.len())
            .filter(|&j| !is_blank_line(&theirs[j]))
            .collect()
    };
    let n = ours_nb.len();
    let m = theirs_nb.len();

    let mut dp = vec![vec![0usize; m + 1]; n + 1];
    for a in (0..n).rev() {
        for b in (0..m).rev() {
            if ours[ours_nb[a]] == theirs[theirs_nb[b]] {
                dp[a][b] = dp[a + 1][b + 1] + 1;
            } else {
                dp[a][b] = dp[a + 1][b].max(dp[a][b + 1]);
            }
        }
    }

    enum NbOp {
        Equal(usize, usize),
        Ours(usize),
        Theirs(usize),
    }

    let mut nb_ops = Vec::new();
    let mut a = 0usize;
    let mut b = 0usize;
    while a < n && b < m {
        if ours[ours_nb[a]] == theirs[theirs_nb[b]] && dp[a][b] == dp[a + 1][b + 1] + 1 {
            nb_ops.push(NbOp::Equal(a, b));
            a += 1;
            b += 1;
        } else if dp[a + 1][b] >= dp[a][b + 1] {
            nb_ops.push(NbOp::Ours(a));
            a += 1;
        } else {
            nb_ops.push(NbOp::Theirs(b));
            b += 1;
        }
    }
    while a < n {
        nb_ops.push(NbOp::Ours(a));
        a += 1;
    }
    while b < m {
        nb_ops.push(NbOp::Theirs(b));
        b += 1;
    }

    // 含空行匹配时下标已覆盖全文件，无需再挂载空隙
    if match_blanks {
        return nb_ops
            .into_iter()
            .map(|op| match op {
                NbOp::Equal(a, _) => LineOp::Equal(ours[ours_nb[a]].clone()),
                NbOp::Ours(a) => LineOp::OursOnly(ours[ours_nb[a]].clone()),
                NbOp::Theirs(b) => LineOp::TheirsOnly(theirs[theirs_nb[b]].clone()),
            })
            .collect();
    }

    let mut ops = Vec::new();
    let mut oi = 0usize;
    let mut tj = 0usize;
    let mut next_ours_nb = 0usize;
    let mut next_theirs_nb = 0usize;
    for nb in nb_ops {
        match nb {
            NbOp::Equal(a, b) => {
                let o_target = ours_nb[a];
                let t_target = theirs_nb[b];
                drain_blank_gap(
                    ours,
                    theirs,
                    &mut oi,
                    o_target,
                    &mut tj,
                    t_target,
                    &mut ops,
                );
                ops.push(LineOp::Equal(ours[o_target].clone()));
                oi = o_target + 1;
                tj = t_target + 1;
                next_ours_nb = a + 1;
                next_theirs_nb = b + 1;
            }
            NbOp::Ours(a) => {
                let o_target = ours_nb[a];
                let t_limit = if next_theirs_nb < theirs_nb.len() {
                    theirs_nb[next_theirs_nb]
                } else {
                    theirs.len()
                };
                // 两侧空隙里成对的空行先当 Equal，避免把「技术栈后空行」吃进 React 冲突
                drain_shared_blanks(
                    ours,
                    theirs,
                    &mut oi,
                    o_target,
                    &mut tj,
                    t_limit,
                    &mut ops,
                );
                while oi < o_target {
                    ops.push(LineOp::OursOnly(ours[oi].clone()));
                    oi += 1;
                }
                ops.push(LineOp::OursOnly(ours[o_target].clone()));
                oi = o_target + 1;
                next_ours_nb = a + 1;
            }
            NbOp::Theirs(b) => {
                let t_target = theirs_nb[b];
                let o_limit = if next_ours_nb < ours_nb.len() {
                    ours_nb[next_ours_nb]
                } else {
                    ours.len()
                };
                drain_shared_blanks(
                    ours,
                    theirs,
                    &mut oi,
                    o_limit,
                    &mut tj,
                    t_target,
                    &mut ops,
                );
                while tj < t_target {
                    ops.push(LineOp::TheirsOnly(theirs[tj].clone()));
                    tj += 1;
                }
                ops.push(LineOp::TheirsOnly(theirs[t_target].clone()));
                tj = t_target + 1;
                next_theirs_nb = b + 1;
            }
        }
    }
    drain_blank_gap(
        ours,
        theirs,
        &mut oi,
        ours.len(),
        &mut tj,
        theirs.len(),
        &mut ops,
    );
    ops
}

fn drain_shared_blanks(
    ours: &[String],
    theirs: &[String],
    oi: &mut usize,
    o_end: usize,
    tj: &mut usize,
    t_end: usize,
    ops: &mut Vec<LineOp>,
) {
    while *oi < o_end
        && *tj < t_end
        && is_blank_line(&ours[*oi])
        && is_blank_line(&theirs[*tj])
    {
        ops.push(LineOp::Equal(ours[*oi].clone()));
        *oi += 1;
        *tj += 1;
    }
}

fn drain_blank_gap(
    ours: &[String],
    theirs: &[String],
    oi: &mut usize,
    o_end: usize,
    tj: &mut usize,
    t_end: usize,
    ops: &mut Vec<LineOp>,
) {
    while *oi < o_end || *tj < t_end {
        let o_blank = *oi < o_end;
        let t_blank = *tj < t_end;
        if o_blank && t_blank {
            ops.push(LineOp::Equal(ours[*oi].clone()));
            *oi += 1;
            *tj += 1;
        } else if o_blank {
            ops.push(LineOp::OursOnly(ours[*oi].clone()));
            *oi += 1;
        } else if t_blank {
            ops.push(LineOp::TheirsOnly(theirs[*tj].clone()));
            *tj += 1;
        } else {
            break;
        }
    }
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

fn join_decision_sides(first: &str, second: &str) -> String {
    if first.is_empty() {
        second.to_string()
    } else if second.is_empty() {
        first.to_string()
    } else {
        format!("{first}\n{second}")
    }
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
    let (_, conflicts, _) = build_marker_document(parsed);
    conflicts.len()
}

fn parsed_marker_conflict_count(parsed: &ParsedFile) -> usize {
    parsed
        .segments
        .iter()
        .filter(|segment| matches!(segment, Segment::Conflict { .. }))
        .count()
}

fn count_merge_conflicts(root: &Path, path: &str, working: &str) -> usize {
    if let Ok(parsed) = parse_conflict_file(working) {
        let marker_conflicts = parsed_marker_conflict_count(&parsed);
        if marker_conflicts > 0 {
            return parsed_conflict_count(&parsed);
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

fn resolve_git_dir(root: &Path) -> PathBuf {
    let git_dir = PathBuf::from(
        git_stdout(root, &["rev-parse", "--git-dir"]).unwrap_or_else(|_| ".git".into()),
    );
    if git_dir.is_absolute() {
        git_dir
    } else {
        root.join(git_dir)
    }
}

fn detect_operation(root: &Path) -> GitOperation {
    let git_dir = resolve_git_dir(root);

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

fn is_opaque_ref_label(label: &str) -> bool {
    matches!(
        label,
        "HEAD"
            | "MERGE_HEAD"
            | "CHERRY_PICK_HEAD"
            | "REVERT_HEAD"
            | "FETCH_HEAD"
            | "ORIG_HEAD"
            | "onto"
            | "rebasing"
            | "incoming"
            | "theirs"
            | "undefined"
    )
}

fn clean_name_rev(name: &str) -> String {
    let mut cleaned = name.trim().to_string();
    if let Some(stripped) = cleaned.strip_prefix("remotes/") {
        cleaned = stripped.to_string();
    }
    if let Some(idx) = cleaned.find(['~', '^', ':']) {
        cleaned.truncate(idx);
    }
    cleaned
}

fn parse_merge_msg_subject(line: &str) -> Option<String> {
    let line = line.trim();
    for prefix in ["Merge remote-tracking branch '", "Merge branch '"] {
        if let Some(rest) = line.strip_prefix(prefix) {
            if let Some(end) = rest.find('\'') {
                let name = rest[..end].trim();
                if !name.is_empty() {
                    return Some(name.to_string());
                }
            }
        }
    }
    if let Some(rest) = line.strip_prefix("Merge pull request ") {
        if let Some(from) = rest.find(" from ") {
            let name = rest[from + 6..].trim().split_whitespace().next().unwrap_or("");
            if !name.is_empty() {
                return Some(name.to_string());
            }
        }
    }
    None
}

fn branch_from_merge_msg(root: &Path) -> Option<String> {
    let msg = std::fs::read_to_string(resolve_git_dir(root).join("MERGE_MSG")).ok()?;
    let first = msg.lines().next()?;
    parse_merge_msg_subject(first)
}

fn refs_pointing_at(root: &Path, rev: &str) -> Option<String> {
    let output = git_stdout(
        root,
        &[
            "for-each-ref",
            "--format=%(refname:short)",
            &format!("--points-at={rev}"),
            "refs/heads",
            "refs/remotes",
        ],
    )
    .ok()?;

    let mut remote = None;
    for line in output.lines() {
        let name = clean_name_rev(line);
        if name.is_empty() || is_opaque_ref_label(&name) {
            continue;
        }
        // 优先本地分支名
        if !name.contains('/') {
            return Some(name);
        }
        if remote.is_none() {
            remote = Some(name);
        }
    }
    remote
}

fn name_rev_label(root: &Path, rev: &str) -> Option<String> {
    let raw = git_stdout(
        root,
        &[
            "name-rev",
            "--name-only",
            "--no-undefined",
            "--exclude=tags/*",
            rev,
        ],
    )
    .ok()?;
    let cleaned = clean_name_rev(&raw);
    if cleaned.is_empty() || is_opaque_ref_label(&cleaned) {
        None
    } else {
        Some(cleaned)
    }
}

fn short_commit(root: &Path, rev: &str) -> Option<String> {
    git_stdout(root, &["rev-parse", "--short", rev])
        .ok()
        .map(|sha| sha.trim().to_string())
        .filter(|sha| !sha.is_empty())
}

fn read_git_dir_text(root: &Path, relative: &str) -> Option<String> {
    std::fs::read_to_string(resolve_git_dir(root).join(relative))
        .ok()
        .map(|text| text.trim().to_string())
        .filter(|text| !text.is_empty())
}

fn shorten_ref_name(name: &str) -> String {
    name.trim()
        .trim_start_matches("refs/heads/")
        .trim_start_matches("refs/remotes/")
        .to_string()
}

fn resolve_merge_theirs_label(root: &Path) -> String {
    if let Some(name) = branch_from_merge_msg(root) {
        return name;
    }
    if let Some(name) = refs_pointing_at(root, "MERGE_HEAD") {
        return name;
    }
    if let Some(name) = name_rev_label(root, "MERGE_HEAD") {
        return name;
    }
    short_commit(root, "MERGE_HEAD").unwrap_or_else(|| "incoming".into())
}

fn resolve_rebase_onto_label(root: &Path) -> Option<String> {
    if let Some(name) = read_git_dir_text(root, "rebase-merge/onto") {
        if let Some(label) = name_rev_label(root, &name).or_else(|| refs_pointing_at(root, &name))
        {
            return Some(label);
        }
        return short_commit(root, &name).or(Some(name));
    }
    if let Some(name) = read_git_dir_text(root, "rebase-apply/onto") {
        if let Some(label) = name_rev_label(root, &name).or_else(|| refs_pointing_at(root, &name))
        {
            return Some(label);
        }
        return short_commit(root, &name).or(Some(name));
    }
    None
}

fn resolve_rebase_head_label(root: &Path) -> Option<String> {
    read_git_dir_text(root, "rebase-merge/head-name")
        .or_else(|| read_git_dir_text(root, "rebase-apply/head-name"))
        .map(|name| shorten_ref_name(&name))
        .filter(|name| !name.is_empty() && !is_opaque_ref_label(name))
}

fn side_labels(root: &Path, operation: GitOperation, branch: &str) -> (String, String) {
    let ours = match operation {
        GitOperation::Rebase => resolve_rebase_onto_label(root)
            .unwrap_or_else(|| "onto".to_string()),
        _ if is_opaque_ref_label(branch) => name_rev_label(root, "HEAD")
            .or_else(|| short_commit(root, "HEAD"))
            .unwrap_or_else(|| branch.to_string()),
        _ => branch.to_string(),
    };

    let theirs = match operation {
        GitOperation::Merge => resolve_merge_theirs_label(root),
        GitOperation::Rebase => resolve_rebase_head_label(root)
            .unwrap_or_else(|| "rebasing".to_string()),
        GitOperation::CherryPick => name_rev_label(root, "CHERRY_PICK_HEAD")
            .or_else(|| short_commit(root, "CHERRY_PICK_HEAD"))
            .unwrap_or_else(|| "cherry-pick".into()),
        GitOperation::Revert => name_rev_label(root, "REVERT_HEAD")
            .or_else(|| short_commit(root, "REVERT_HEAD"))
            .unwrap_or_else(|| "revert".into()),
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
                    ConflictDecision::OursThenTheirs => join_decision_sides(ours, theirs),
                    ConflictDecision::TheirsThenOurs => join_decision_sides(theirs, ours),
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
    fn splits_marker_conflict_on_equal_lines() {
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
X3
X4
X5
L6
Y7
L8
>>>>>>> theirs
";
        let parsed = parse_conflict_file(content).unwrap();
        let (rows, conflicts, result) = build_marker_document(&parsed);
        assert_eq!(conflicts.len(), 2);
        assert_eq!(conflicts[0].block_kind, ConflictBlockKind::Conflict);
        assert_eq!(conflicts[0].ours, "L1\nL2\nL3\nL4\nL5");
        assert_eq!(conflicts[0].theirs, "X1\nX2\nX3\nX4\nX5");
        assert_eq!(conflicts[1].block_kind, ConflictBlockKind::Conflict);
        assert_eq!(conflicts[1].ours, "L7");
        assert_eq!(conflicts[1].theirs, "Y7");
        assert_eq!(rows[0].conflict_index, Some(0));
        assert_eq!(rows[4].conflict_index, Some(0));
        assert_eq!(rows[5].conflict_index, None);
        assert_eq!(rows[5].kind, MergeRowKind::Context);
        assert_eq!(rows[6].conflict_index, Some(1));
        assert_eq!(rows[7].conflict_index, None);
        assert_eq!(rows[7].kind, MergeRowKind::Context);
        assert_eq!(
            result
                .iter()
                .map(|line| line.text.as_str())
                .collect::<Vec<_>>(),
            vec!["L6", "L8"]
        );
        assert_eq!(count_conflict_blocks(content), 2);
    }

    #[test]
    fn marker_one_sided_segment_is_green_change_requiring_accept() {
        let content = "\
<<<<<<< ours
same
only-ours
same-tail
=======
same
same-tail
>>>>>>> theirs
";
        let parsed = parse_conflict_file(content).unwrap();
        let (rows, conflicts, result) = build_marker_document(&parsed);
        assert_eq!(conflicts.len(), 1);
        assert_eq!(conflicts[0].block_kind, ConflictBlockKind::Change);
        assert_eq!(conflicts[0].ours, "only-ours");
        assert_eq!(conflicts[0].theirs, "");
        assert!(rows.iter().any(|row| {
            row.conflict_index == Some(0) && row.kind == MergeRowKind::Insert
        }));
        // 未 Accept 前 Result 只有相同上下文，不自动合入
        assert_eq!(
            result
                .iter()
                .map(|line| line.text.as_str())
                .collect::<Vec<_>>(),
            vec!["same", "same-tail"]
        );
        assert_eq!(count_conflict_blocks(content), 1);
    }

    #[test]
    fn blank_line_between_replace_regions_splits_blocks() {
        // 双方替换段之间的相同空行应打断，而不是糊成一块
        let content = "\
<<<<<<< ours
A

B
C
=======
X

Y
Z
>>>>>>> theirs
";
        let parsed = parse_conflict_file(content).unwrap();
        let (_rows, conflicts, result) = build_marker_document(&parsed);
        assert_eq!(conflicts.len(), 2);
        assert_eq!(conflicts[0].block_kind, ConflictBlockKind::Conflict);
        assert_eq!(conflicts[0].ours, "A");
        assert_eq!(conflicts[0].theirs, "X");
        assert_eq!(conflicts[1].block_kind, ConflictBlockKind::Conflict);
        assert_eq!(conflicts[1].ours, "B\nC");
        assert_eq!(conflicts[1].theirs, "Y\nZ");
        assert_eq!(
            result
                .iter()
                .map(|line| line.text.as_str())
                .collect::<Vec<_>>(),
            vec![""]
        );
        assert_eq!(count_conflict_blocks(content), 2);
    }

    #[test]
    fn one_sided_with_blank_stays_green_change() {
        let content = "\
<<<<<<< ours
A

B
=======

>>>>>>> theirs
";
        let parsed = parse_conflict_file(content).unwrap();
        let (_rows, conflicts, _result) = build_marker_document(&parsed);
        assert_eq!(conflicts.len(), 1);
        assert_eq!(conflicts[0].block_kind, ConflictBlockKind::Change);
        assert!(side_has_substantive(split_content_lines(&conflicts[0].ours).as_slice()));
        assert!(!side_has_substantive(
            split_content_lines(&conflicts[0].theirs).as_slice()
        ));
    }

    #[test]
    fn one_sided_prefix_with_shared_blank_is_single_change() {
        // 左侧多出 A，其余（含 C 后空行）两边相同 → 只有 A 一个块
        let content = "\
<<<<<<< ours
A
B
C

D
=======
B
C

D
>>>>>>> theirs
";
        let parsed = parse_conflict_file(content).unwrap();
        let (_rows, conflicts, result) = build_marker_document(&parsed);
        assert_eq!(conflicts.len(), 1);
        assert_eq!(conflicts[0].block_kind, ConflictBlockKind::Change);
        assert_eq!(conflicts[0].ours, "A");
        assert_eq!(conflicts[0].theirs, "");
        assert_eq!(
            result
                .iter()
                .map(|line| line.text.as_str())
                .collect::<Vec<_>>(),
            vec!["B", "C", "", "D"]
        );
    }

    #[test]
    fn blank_only_mismatch_after_shared_lines_is_not_a_block() {
        // 仅一侧多空行时，不应再出现绿色空行冲突块
        let content = "\
<<<<<<< ours
A
B
C

D
=======
B
C
D
>>>>>>> theirs
";
        let parsed = parse_conflict_file(content).unwrap();
        let (_rows, conflicts, result) = build_marker_document(&parsed);
        assert_eq!(conflicts.len(), 1);
        assert_eq!(conflicts[0].block_kind, ConflictBlockKind::Change);
        assert_eq!(conflicts[0].ours, "A");
        assert_eq!(conflicts[0].theirs, "");
        assert_eq!(
            result
                .iter()
                .map(|line| line.text.as_str())
                .collect::<Vec<_>>(),
            vec!["B", "C", "D"]
        );
    }

    #[test]
    fn three_way_blank_only_insert_is_not_a_block() {
        let base = "B\nC\nD\n";
        let ours = "A\nB\nC\n\nD\n";
        let theirs = "B\nC\n\nD\n";
        let (_rows, conflicts, result) = build_three_way_document(base, ours, theirs);

        assert_eq!(conflicts.len(), 1);
        assert_eq!(conflicts[0].block_kind, ConflictBlockKind::Change);
        assert_eq!(conflicts[0].ours, "A");
        assert_eq!(conflicts[0].theirs, "");
        assert_eq!(
            result
                .iter()
                .map(|line| line.text.as_str())
                .collect::<Vec<_>>(),
            vec!["B", "C", "", "D"]
        );
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
    fn three_way_non_overlapping_changes_require_accept() {
        let base = "a\nb\nc\n";
        let ours = "a\nB\nc\n";
        let theirs = "a\nb\nC\n";
        let (rows, conflicts, result) = build_three_way_document(base, ours, theirs);

        assert_eq!(conflicts.len(), 2);
        assert_eq!(conflicts[0].block_kind, ConflictBlockKind::Change);
        assert_eq!(conflicts[1].block_kind, ConflictBlockKind::Change);
        assert_eq!(
            result
                .iter()
                .map(|line| line.text.as_str())
                .collect::<Vec<_>>(),
            vec!["a"]
        );
        assert!(rows
            .iter()
            .filter(|row| row.conflict_index.is_some())
            .all(|row| row.kind == MergeRowKind::Insert));
    }

    #[test]
    fn three_way_keeps_same_line_changes_unresolved() {
        let base = "a\nb\nc\n";
        let ours = "a\nours\nc\n";
        let theirs = "a\ntheirs\nc\n";
        let (_rows, conflicts, result) = build_three_way_document(base, ours, theirs);

        assert_eq!(conflicts.len(), 1);
        assert_eq!(conflicts[0].block_kind, ConflictBlockKind::Conflict);
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
    fn three_way_identical_changes_still_require_accept() {
        let base = "a\nb\n";
        let ours = "a\nB\n";
        let theirs = "a\nB\n";
        let (_rows, conflicts, result) = build_three_way_document(base, ours, theirs);

        assert_eq!(conflicts.len(), 1);
        assert_eq!(conflicts[0].block_kind, ConflictBlockKind::Change);
        assert_eq!(conflicts[0].ours, "B");
        assert_eq!(conflicts[0].theirs, "B");
        assert_eq!(
            result
                .iter()
                .map(|line| line.text.as_str())
                .collect::<Vec<_>>(),
            vec!["a"]
        );
    }

    #[test]
    fn three_way_marks_delete_vs_modify_as_conflict() {
        let base = "a\nb\nc\n";
        let ours = "a\nc\n";
        let theirs = "a\nB\nc\n";
        let (_rows, conflicts, _result) = build_three_way_document(base, ours, theirs);

        assert_eq!(conflicts.len(), 1);
        assert_eq!(conflicts[0].block_kind, ConflictBlockKind::Conflict);
        assert_eq!(conflicts[0].ours, "");
        assert_eq!(conflicts[0].theirs, "B");
    }

    #[test]
    fn parses_merge_msg_branch_names() {
        assert_eq!(
            parse_merge_msg_subject("Merge branch 'feature-x' into main"),
            Some("feature-x".into())
        );
        assert_eq!(
            parse_merge_msg_subject("Merge remote-tracking branch 'origin/feature-x'"),
            Some("origin/feature-x".into())
        );
        assert_eq!(
            parse_merge_msg_subject("Merge pull request #12 from alice/fix-login"),
            Some("alice/fix-login".into())
        );
        assert_eq!(parse_merge_msg_subject("Not a merge message"), None);
    }

    #[test]
    fn cleans_name_rev_output() {
        assert_eq!(clean_name_rev("remotes/origin/feature~2"), "origin/feature");
        assert_eq!(clean_name_rev("main^0"), "main");
        assert_eq!(clean_name_rev("  feature  "), "feature");
    }

    #[test]
    fn webstorm_style_markdown_conflict() {
        let content = "\
<<<<<<< HEAD
3. 点击导出按钮复制格式

## 技术栈

- React
- Node.js
- Express

## 作者

Feature Team 1
=======
3. 支持暗色/亮色主题切换
4. 点击导出按钮保存到服务器

## 技术栈

- React 18
- Node.js
- Express
- Python 3.9+
- Go 1.20+

## 高级功能

### 自动保存
编辑器会自动保存你的工作到本地存储。

### 代码块支持
支持多种编程语言的语法高亮。

## 作者

Feature Team 2
>>>>>>> feature-branch-2
";
        let parsed = parse_conflict_file(content).unwrap();
        let (rows, conflicts, result) = build_marker_document(&parsed);

        assert_eq!(conflicts.len(), 4);

        assert_eq!(conflicts[0].block_kind, ConflictBlockKind::Conflict);
        assert_eq!(conflicts[0].ours, "3. 点击导出按钮复制格式");
        assert_eq!(
            conflicts[0].theirs,
            "3. 支持暗色/亮色主题切换\n4. 点击导出按钮保存到服务器"
        );

        assert_eq!(conflicts[1].block_kind, ConflictBlockKind::Conflict);
        assert_eq!(conflicts[1].ours, "- React");
        assert_eq!(conflicts[1].theirs, "- React 18");

        let express_idx = rows
            .iter()
            .position(|row| {
                row.kind == MergeRowKind::Context
                    && row.ours_line.as_ref().is_some_and(|l| l.text == "- Express")
            })
            .expect("Express context row");
        assert!(
            matches!(
                &rows[express_idx + 1],
                MergeRow {
                    kind: MergeRowKind::Context,
                    conflict_index: None,
                    ours_line: Some(PaneLine { text, .. }),
                    ..
                } if text.is_empty()
            ),
            "Express 下方应保留左侧空行上下文，不能被绿块吃掉: {:?}",
            rows[express_idx + 1]
        );

        assert_eq!(conflicts[2].block_kind, ConflictBlockKind::Change);
        assert_eq!(conflicts[2].ours, "");
        assert!(conflicts[2].theirs.starts_with("- Python 3.9+\n- Go 1.20+"));
        assert!(conflicts[2].theirs.contains("## 高级功能"));
        assert!(conflicts[2].theirs.contains("### 代码块支持"));

        assert_eq!(conflicts[3].block_kind, ConflictBlockKind::Conflict);
        assert_eq!(conflicts[3].ours, "Feature Team 1");
        assert_eq!(conflicts[3].theirs, "Feature Team 2");

        assert_eq!(
            result
                .iter()
                .map(|line| line.text.as_str())
                .collect::<Vec<_>>(),
            vec!["", "## 技术栈", "", "- Node.js", "- Express", "## 作者", ""]
        );
        assert_eq!(count_conflict_blocks(content), 4);
    }

    #[test]
    fn webstorm_style_express_conflict_splits_replace_islands() {
        let content = "\
<<<<<<< HEAD
// JavaScript 文件 - Feature Branch 1 版本
const express = require('express');
const app = express();
const PORT = 3000;

// 配置中间件
app.use(express.json());
app.use(express.static('public'));

// 路由处理
app.get('/', (req, res) => {
  res.send('Welcome to Feature Branch 1');
});

app.get('/api/users', (req, res) => {
  res.json({ users: ['Alice', 'Bob'] });
});

// 启动服务器
app.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
=======
// JavaScript 文件 - Feature Branch 2 版本
const express = require('express');
const cors = require('cors');
const app = express();
const PORT = 8000;

// 配置中间件 - 不同的顺序和选项
app.use(cors());
app.use(express.json({ limit: '50mb' }));
app.use(express.urlencoded({ extended: true }));

// 路由处理 - 完全不同的实现
app.get('/', (req, res) => {
  res.json({ message: 'Feature Branch 2 API' });
});

app.get('/api/users', (req, res) => {
  res.json({
    users: ['Charlie', 'David', 'Eve'],
    total: 3
  });
});

app.post('/api/render', (req, res) => {
  res.json({ status: 'success' });
});

// 启动服务器 - 不同的消息
app.listen(PORT, () => {
  console.log(`Feature 2 server is running on ${PORT}`);
>>>>>>> feature-branch-2
});
";
        let parsed = parse_conflict_file(content).unwrap();
        let (_rows, conflicts, result) = build_marker_document(&parsed);

        assert_eq!(conflicts.len(), 9);
        assert_eq!(
            conflicts[0].ours,
            "// JavaScript 文件 - Feature Branch 1 版本"
        );
        assert_eq!(
            conflicts[0].theirs,
            "// JavaScript 文件 - Feature Branch 2 版本"
        );
        assert_eq!(conflicts[1].ours, "");
        assert_eq!(conflicts[1].theirs, "const cors = require('cors');");
        assert_eq!(conflicts[2].ours, "const PORT = 3000;");
        assert_eq!(conflicts[2].theirs, "const PORT = 8000;");
        assert_eq!(
            conflicts[3].ours,
            "// 配置中间件\napp.use(express.json());\napp.use(express.static('public'));"
        );
        assert!(conflicts[3].theirs.contains("app.use(cors());"));
        assert_eq!(conflicts[4].ours, "// 路由处理");
        assert_eq!(conflicts[4].theirs, "// 路由处理 - 完全不同的实现");
        assert_eq!(
            conflicts[5].ours,
            "  res.send('Welcome to Feature Branch 1');"
        );
        assert_eq!(
            conflicts[6].ours,
            "  res.json({ users: ['Alice', 'Bob'] });"
        );
        assert_eq!(conflicts[7].ours, "// 启动服务器");
        assert!(conflicts[7].theirs.contains("app.post('/api/render'"));
        assert_eq!(
            conflicts[8].ours,
            "  console.log(`Server running on port ${PORT}`);"
        );
        assert_eq!(
            conflicts[8].theirs,
            "  console.log(`Feature 2 server is running on ${PORT}`);"
        );
        assert!(result.iter().any(|line| line.text.contains("app.get('/'")));
        assert!(result
            .iter()
            .any(|line| line.text.contains("app.listen(PORT")));
    }
}
