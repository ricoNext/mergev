//! 终端列宽计算。CJK / emoji / Tab 都会让「字符数」和「显示列数」脱节，
//! 三栏对齐一旦按字符数截断就会错位，所以所有渲染都必须走这里。

use unicode_width::{UnicodeWidthChar, UnicodeWidthStr};

pub const TAB_WIDTH: usize = 4;

/// 把 Tab 展开成空格，使后续列计算可以逐字符线性推进。
pub fn expand_tabs(text: &str) -> String {
    if !text.contains('\t') {
        return text.to_string();
    }
    let mut out = String::with_capacity(text.len() + TAB_WIDTH);
    let mut col = 0usize;
    for ch in text.chars() {
        if ch == '\t' {
            let advance = TAB_WIDTH - (col % TAB_WIDTH);
            for _ in 0..advance {
                out.push(' ');
            }
            col += advance;
        } else {
            col += UnicodeWidthChar::width(ch).unwrap_or(0);
            out.push(ch);
        }
    }
    out
}

/// 文本占用的终端列数（Tab 已展开）。
pub fn display_width(text: &str) -> usize {
    UnicodeWidthStr::width(expand_tabs(text).as_str())
}

/// 取 `[start, start + width)` 这一段显示列，右侧补空格到满宽。
///
/// 宽字符跨越窗口边界时用空格占位，保证返回值的显示宽度恰好是 `width`，
/// 否则相邻栏会被挤歪。
pub fn slice_columns(text: &str, start: usize, width: usize) -> String {
    if width == 0 {
        return String::new();
    }
    let expanded = expand_tabs(text);
    let mut out = String::with_capacity(width);
    let mut col = 0usize;
    let mut used = 0usize;

    for ch in expanded.chars() {
        if used >= width {
            break;
        }
        let ch_width = UnicodeWidthChar::width(ch).unwrap_or(0);

        // 尚未进入窗口
        if col + ch_width <= start {
            col += ch_width;
            continue;
        }

        // 宽字符跨越左边界：只显示落在窗口内的那部分，用空格替代
        if col < start {
            let visible = col + ch_width - start;
            for _ in 0..visible.min(width - used) {
                out.push(' ');
                used += 1;
            }
            col += ch_width;
            continue;
        }

        // 宽字符跨越右边界：补空格而不是截半个字
        if used + ch_width > width {
            while used < width {
                out.push(' ');
                used += 1;
            }
            break;
        }

        out.push(ch);
        used += ch_width;
        col += ch_width;
    }

    while used < width {
        out.push(' ');
        used += 1;
    }
    out
}

/// 按显示列截断，超出时以 `…` 结尾。用于路径、标签这类单行文本。
pub fn truncate_columns(text: &str, width: usize) -> String {
    if width == 0 {
        return String::new();
    }
    let expanded = expand_tabs(text);
    if UnicodeWidthStr::width(expanded.as_str()) <= width {
        return expanded;
    }
    let budget = width.saturating_sub(1);
    let mut out = String::new();
    let mut used = 0usize;
    for ch in expanded.chars() {
        let ch_width = UnicodeWidthChar::width(ch).unwrap_or(0);
        if used + ch_width > budget {
            break;
        }
        out.push(ch);
        used += ch_width;
    }
    out.push('…');
    out
}

/// 从右侧保留 `width` 列，左侧以 `…` 开头。路径这类前缀可省的文本更适合它。
pub fn truncate_columns_start(text: &str, width: usize) -> String {
    if width == 0 {
        return String::new();
    }
    let expanded = expand_tabs(text);
    if UnicodeWidthStr::width(expanded.as_str()) <= width {
        return expanded;
    }
    let budget = width.saturating_sub(1);
    let mut kept: Vec<char> = Vec::new();
    let mut used = 0usize;
    for ch in expanded.chars().rev() {
        let ch_width = UnicodeWidthChar::width(ch).unwrap_or(0);
        if used + ch_width > budget {
            break;
        }
        kept.push(ch);
        used += ch_width;
    }
    let mut out = String::from("…");
    out.extend(kept.into_iter().rev());
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn expands_tabs_to_next_stop() {
        assert_eq!(expand_tabs("a\tb"), "a   b");
        assert_eq!(expand_tabs("\tx"), "    x");
        assert_eq!(expand_tabs("abcd\te"), "abcd    e");
    }

    #[test]
    fn measures_wide_characters() {
        assert_eq!(display_width("abc"), 3);
        assert_eq!(display_width("中文"), 4);
        assert_eq!(display_width("中a"), 3);
    }

    #[test]
    fn slice_pads_to_exact_width() {
        assert_eq!(slice_columns("abc", 0, 5), "abc  ");
        assert_eq!(display_width(&slice_columns("中文字", 0, 5)), 5);
        assert_eq!(display_width(&slice_columns("中文字", 1, 4)), 4);
    }

    #[test]
    fn slice_never_splits_a_wide_char() {
        // 起点落在「中」的后半格，应该补一个空格而不是输出半个字符
        assert_eq!(slice_columns("中文", 1, 3), " 文");
        // 终点落在「文」的前半格
        assert_eq!(slice_columns("中文", 0, 3), "中 ");
    }

    #[test]
    fn slice_skips_leading_columns() {
        assert_eq!(slice_columns("abcdef", 2, 3), "cde");
        assert_eq!(slice_columns("abcdef", 10, 3), "   ");
    }

    #[test]
    fn truncates_with_ellipsis() {
        assert_eq!(truncate_columns("abcdef", 4), "abc…");
        assert_eq!(truncate_columns("abc", 4), "abc");
        assert_eq!(display_width(&truncate_columns("中文中文", 5)), 5);
    }

    #[test]
    fn truncates_from_start() {
        assert_eq!(truncate_columns_start("abcdef", 4), "…def");
        assert_eq!(truncate_columns_start("abc", 4), "abc");
    }
}
