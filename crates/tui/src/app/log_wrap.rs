use crate::app::state::{LogKind, LogLine, LogSpan, LogTone};
use crate::app::theme::ui_colors;
use crate::app::util::text::{
    char_width, detect_continuation_prefix, wrap_line, wrap_line_with_continuation,
};
use crate::app::{AppState, WrappedLogCache};
use ratatui::style::{Color, Modifier, Style};
use ratatui::text::{Line, Span};
use std::sync::OnceLock;
use std::time::Instant;

static TRUECOLOR_SUPPORT: OnceLock<bool> = OnceLock::new();

fn supports_truecolor() -> bool {
    if std::env::var("CODELIA_FORCE_ANSI_SYNTAX").ok().as_deref() == Some("1") {
        return false;
    }
    *TRUECOLOR_SUPPORT.get_or_init(|| {
        let colorterm = std::env::var("COLORTERM")
            .unwrap_or_default()
            .to_ascii_lowercase();
        if colorterm.contains("truecolor") || colorterm.contains("24bit") {
            return true;
        }
        let term = std::env::var("TERM")
            .unwrap_or_default()
            .to_ascii_lowercase();
        term.contains("direct") || term.contains("truecolor")
    })
}

fn to_indexed_component(value: u8) -> u8 {
    ((value as u16 * 5 + 127) / 255) as u8
}

fn xterm_level(component: u8) -> u8 {
    match component {
        0 => 0,
        1 => 95,
        2 => 135,
        3 => 175,
        4 => 215,
        _ => 255,
    }
}

fn nearest_xterm_256(r: u8, g: u8, b: u8) -> u8 {
    let ri = to_indexed_component(r);
    let gi = to_indexed_component(g);
    let bi = to_indexed_component(b);
    let cube_index = 16 + 36 * ri + 6 * gi + bi;

    let cr = xterm_level(ri) as i32;
    let cg = xterm_level(gi) as i32;
    let cb = xterm_level(bi) as i32;
    let dr = r as i32 - cr;
    let dg = g as i32 - cg;
    let db = b as i32 - cb;
    let cube_dist = dr * dr + dg * dg + db * db;

    let avg = (r as u16 + g as u16 + b as u16) / 3;
    let gray_step = (((avg as i32 - 8) + 5) / 10).clamp(0, 23) as u8;
    let gray_level = (8 + gray_step as i32 * 10) as i32;
    let gr = r as i32 - gray_level;
    let gg = g as i32 - gray_level;
    let gb = b as i32 - gray_level;
    let gray_dist = gr * gr + gg * gg + gb * gb;
    let gray_index = 232 + gray_step;

    if gray_dist < cube_dist {
        gray_index
    } else {
        cube_index
    }
}

fn syntax_color(r: u8, g: u8, b: u8) -> Color {
    if supports_truecolor() {
        Color::Rgb(r, g, b)
    } else {
        Color::Indexed(nearest_xterm_256(r, g, b))
    }
}

fn input_bg() -> Color {
    ui_colors().input_bg
}

fn style_for(span: &LogSpan) -> Style {
    let mut style = style_for_kind(span.kind, span.tone);
    if let Some(fg) = span.fg {
        style = style.fg(syntax_color(fg.r, fg.g, fg.b));
    }
    style
}

fn style_for_kind(kind: LogKind, tone: LogTone) -> Style {
    let theme = ui_colors();
    let (summary, detail) = match kind {
        LogKind::System => (
            Style::default().fg(theme.log_system_fg),
            Style::default()
                .fg(theme.log_system_fg)
                .add_modifier(Modifier::DIM),
        ),
        LogKind::User => (
            Style::default().fg(theme.log_primary_fg).bg(input_bg()),
            Style::default().fg(theme.log_primary_fg).bg(input_bg()),
        ),
        LogKind::Assistant => (
            Style::default().fg(theme.log_primary_fg),
            Style::default().fg(theme.log_primary_fg),
        ),
        LogKind::AssistantCode => (
            Style::default()
                .fg(theme.log_primary_fg)
                .bg(theme.code_block_bg),
            Style::default()
                .fg(theme.log_primary_fg)
                .bg(theme.code_block_bg),
        ),
        LogKind::Reasoning => (
            Style::default()
                .fg(theme.log_muted_fg)
                .add_modifier(Modifier::ITALIC),
            Style::default()
                .fg(theme.log_muted_fg)
                .add_modifier(Modifier::ITALIC)
                .add_modifier(Modifier::DIM),
        ),
        LogKind::ToolCall => (
            Style::default().fg(theme.log_tool_call_fg),
            Style::default().fg(theme.log_primary_fg),
        ),
        LogKind::ToolResult => (
            Style::default().fg(theme.log_tool_result_fg),
            Style::default()
                .fg(theme.log_tool_result_fg)
                .add_modifier(Modifier::DIM),
        ),
        LogKind::TodoPending => (
            Style::default().fg(theme.log_primary_fg),
            Style::default().fg(theme.log_primary_fg),
        ),
        LogKind::TodoInProgress => (
            Style::default()
                .fg(theme.log_status_fg)
                .bg(theme.code_block_bg)
                .add_modifier(Modifier::BOLD),
            Style::default()
                .fg(theme.log_status_fg)
                .bg(theme.code_block_bg)
                .add_modifier(Modifier::BOLD),
        ),
        LogKind::TodoCompleted => (
            Style::default()
                .fg(theme.log_muted_fg)
                .add_modifier(Modifier::CROSSED_OUT)
                .add_modifier(Modifier::DIM),
            Style::default()
                .fg(theme.log_muted_fg)
                .add_modifier(Modifier::CROSSED_OUT)
                .add_modifier(Modifier::DIM),
        ),
        LogKind::DiffMeta => (
            Style::default().fg(theme.panel_divider_fg),
            Style::default().fg(theme.panel_divider_fg),
        ),
        LogKind::DiffContext => (
            Style::default().fg(theme.log_muted_fg),
            Style::default().fg(theme.log_muted_fg),
        ),
        LogKind::DiffCode => (
            Style::default()
                .fg(theme.log_primary_fg)
                .bg(theme.diff_code_block_bg),
            Style::default()
                .fg(theme.log_primary_fg)
                .bg(theme.diff_code_block_bg),
        ),
        LogKind::DiffAdded => (
            Style::default()
                .fg(theme.log_primary_fg)
                .bg(theme.diff_added_bg),
            Style::default()
                .fg(theme.log_primary_fg)
                .bg(theme.diff_added_bg),
        ),
        LogKind::DiffRemoved => (
            Style::default()
                .fg(theme.log_primary_fg)
                .bg(theme.diff_removed_bg),
            Style::default()
                .fg(theme.log_primary_fg)
                .bg(theme.diff_removed_bg),
        ),
        LogKind::Status => (
            Style::default().fg(theme.log_status_fg),
            Style::default().fg(theme.log_status_fg),
        ),
        LogKind::Rpc => (
            Style::default().add_modifier(Modifier::DIM),
            Style::default().add_modifier(Modifier::DIM),
        ),
        LogKind::Runtime => (
            Style::default().add_modifier(Modifier::DIM),
            Style::default().add_modifier(Modifier::DIM),
        ),
        LogKind::Space => (
            Style::default().fg(theme.log_space_fg),
            Style::default().fg(theme.log_space_fg),
        ),
        LogKind::Error => (
            Style::default()
                .fg(theme.log_error_fg)
                .add_modifier(Modifier::BOLD),
            Style::default()
                .fg(theme.log_error_fg)
                .add_modifier(Modifier::BOLD)
                .add_modifier(Modifier::DIM),
        ),
    };

    match tone {
        LogTone::Summary => summary,
        LogTone::Detail => detail,
    }
}

fn visual_width(text: &str) -> usize {
    text.chars().map(char_width).sum()
}

fn pad_to_width(mut text: String, width: usize) -> String {
    let current = visual_width(&text);
    if current >= width {
        return text;
    }
    text.push_str(&" ".repeat(width - current));
    text
}

fn take_spans_until_width(spans: &[LogSpan], width: usize) -> (Vec<LogSpan>, usize) {
    let mut taken = Vec::new();
    let mut consumed = 0usize;
    let mut consumed_width = 0usize;

    for span in spans {
        if consumed_width >= width {
            break;
        }
        let mut part = String::new();
        let mut part_width = 0usize;

        for ch in span.text.chars() {
            let ch_width = char_width(ch);
            if consumed_width + part_width + ch_width > width {
                break;
            }
            part.push(ch);
            part_width += ch_width;
        }

        if part.is_empty() {
            if span.text.is_empty() {
                continue;
            }
            break;
        }

        let taken_chars = part.chars().count();
        let span_chars = span.text.chars().count();
        consumed += taken_chars;
        consumed_width += part_width;

        let mut next = span.clone();
        next.text = part;
        taken.push(next);

        if taken_chars < span_chars {
            break;
        }
    }

    (taken, consumed)
}

fn trim_spans_front(spans: &[LogSpan], chars_to_trim: usize) -> Vec<LogSpan> {
    if chars_to_trim == 0 {
        return spans.to_vec();
    }

    let mut remaining_trim = chars_to_trim;
    let mut out = Vec::new();

    for span in spans {
        if remaining_trim == 0 {
            out.push(span.clone());
            continue;
        }

        let span_chars = span.text.chars().count();
        if remaining_trim >= span_chars {
            remaining_trim -= span_chars;
            continue;
        }

        let tail: String = span.text.chars().skip(remaining_trim).collect();
        remaining_trim = 0;
        let mut next = span.clone();
        next.text = tail;
        out.push(next);
    }

    out
}

fn wrap_multi_span_line(
    line: &LogLine,
    width: usize,
    continuation_prefix: Option<&str>,
) -> Vec<LogLine> {
    let mut remaining = line.spans().to_vec();
    let mut out = Vec::new();
    let mut first_line = true;

    let continuation_prefix = continuation_prefix.unwrap_or("");
    let continuation_prefix_width = continuation_prefix.chars().map(char_width).sum::<usize>();
    let can_use_continuation = !continuation_prefix.is_empty() && width > continuation_prefix_width;

    while !remaining.is_empty() {
        let chunk_width = if first_line || !can_use_continuation {
            width
        } else {
            width - continuation_prefix_width
        };
        let (chunk, consumed_chars) = take_spans_until_width(&remaining, chunk_width);
        if chunk.is_empty() {
            break;
        }

        if !first_line && can_use_continuation {
            let (kind, tone) = line.first_style();
            let mut prefixed = Vec::with_capacity(chunk.len() + 1);
            prefixed.push(LogSpan::new(kind, tone, continuation_prefix));
            prefixed.extend(chunk);
            out.push(LogLine::new_with_spans(prefixed));
        } else {
            out.push(LogLine::new_with_spans(chunk));
        }

        remaining = trim_spans_front(&remaining, consumed_chars);
        first_line = false;
    }

    if out.is_empty() {
        out.push(LogLine::new(line.kind(), line.plain_text()));
    }

    out
}

fn span_text_width(text: &str) -> usize {
    text.chars().map(char_width).sum()
}

fn line_text_width(line: &LogLine) -> usize {
    line.spans()
        .iter()
        .map(|span| span_text_width(&span.text))
        .sum()
}

fn parse_diff_gutter_prefix(text: &str) -> Option<String> {
    if text.is_empty() {
        return None;
    }

    let mut chars = text.chars().peekable();
    let mut end = 0usize;

    while chars.peek().copied() == Some(' ') {
        end += ' '.len_utf8();
        chars.next();
    }

    while chars.peek().copied().is_some_and(|ch| ch.is_ascii_digit()) {
        end += 1;
        chars.next();
    }

    while chars.peek().copied() == Some(' ') {
        end += ' '.len_utf8();
        chars.next();
    }

    let marker = chars.next()?;
    if !matches!(marker, '+' | '-' | '|') {
        return None;
    }
    end += marker.len_utf8();

    if chars.peek().copied() == Some(' ') {
        end += ' '.len_utf8();
    }

    Some(text[..end].to_string())
}

fn diff_continuation_prefix(line: &LogLine) -> Option<String> {
    if !matches!(
        line.kind(),
        LogKind::DiffAdded | LogKind::DiffRemoved | LogKind::DiffContext
    ) {
        return None;
    }
    let gutter = parse_diff_gutter_prefix(&line.plain_text())?;
    let width = span_text_width(&gutter);
    (width > 0).then(|| " ".repeat(width))
}

fn background_padding_kind(line: &LogLine) -> Option<LogKind> {
    match line.kind() {
        LogKind::DiffAdded | LogKind::DiffRemoved | LogKind::DiffCode => Some(line.kind()),
        LogKind::AssistantCode => line
            .spans()
            .iter()
            .find_map(|span| match span.kind {
                LogKind::DiffAdded | LogKind::DiffRemoved | LogKind::DiffCode => Some(span.kind),
                _ => None,
            })
            .or(Some(LogKind::AssistantCode)),
        _ => None,
    }
}

fn pad_background_line(mut line: LogLine, width: usize) -> LogLine {
    let Some(kind) = background_padding_kind(&line) else {
        return line;
    };

    let used = line_text_width(&line);
    if used >= width {
        return line;
    }

    let padding = " ".repeat(width - used);
    let tone = line.tone();
    line.spans.push(LogSpan::new(kind, tone, padding));
    line
}

fn wrap_log_lines(lines: &[LogLine], width: usize) -> Vec<LogLine> {
    let mut out = Vec::new();
    for line in lines {
        if line.plain_text().is_empty() {
            out.push(line.clone());
            continue;
        }
        let is_user = line.kind() == LogKind::User;
        let wrap_width = if is_user {
            width.saturating_sub(4).max(1)
        } else {
            width
        };
        let continuation_prefix = if is_user {
            None
        } else {
            diff_continuation_prefix(line)
                .or_else(|| detect_continuation_prefix(&line.plain_text()))
        };

        if line.is_single_span() {
            let wrapped_rows = if let Some(prefix) = continuation_prefix.as_deref() {
                wrap_line_with_continuation(&line.plain_text(), wrap_width, prefix)
            } else {
                wrap_line(&line.plain_text(), wrap_width)
            };
            for wrapped in wrapped_rows {
                let wrapped = if is_user {
                    pad_to_width(format!(" {wrapped} "), width)
                } else {
                    wrapped
                };
                let wrapped_line = line.with_text(wrapped);
                out.push(pad_background_line(wrapped_line, width));
            }
            continue;
        }

        let mut wrapped_multi =
            wrap_multi_span_line(line, wrap_width, continuation_prefix.as_deref());
        if is_user {
            wrapped_multi = wrapped_multi
                .into_iter()
                .map(|wrapped| {
                    let padded = pad_to_width(format!(" {} ", wrapped.plain_text()), width);
                    LogLine::new_with_spans(vec![LogSpan::new(line.kind(), line.tone(), padded)])
                })
                .collect();
        }
        out.extend(
            wrapped_multi
                .into_iter()
                .map(|wrapped| pad_background_line(wrapped, width)),
        );
    }
    out
}

pub(crate) fn cached_wrap_log_lines(app: &mut AppState, width: usize) -> &[LogLine] {
    if width == 0 {
        return &[];
    }
    let cache_hit = matches!(
        app.wrapped_log_cache.as_ref(),
        Some(cache) if cache.width == width && cache.log_version == app.log_version
    );
    if !cache_hit {
        let started = Instant::now();
        let wrapped = wrap_log_lines(&app.log, width);
        let wrapped_total = wrapped.len();
        app.wrapped_log_cache = Some(WrappedLogCache {
            width,
            log_version: app.log_version,
            wrapped,
        });
        app.record_wrap_cache_miss(started.elapsed(), wrapped_total);
    } else if let Some(wrapped_total) = app
        .wrapped_log_cache
        .as_ref()
        .map(|cache| cache.wrapped.len())
    {
        app.record_wrap_cache_hit(wrapped_total);
    }
    app.wrapped_log_cache
        .as_ref()
        .map(|cache| cache.wrapped.as_slice())
        .unwrap_or(&[])
}

pub(crate) fn log_lines_to_lines(lines: &[LogLine]) -> Vec<Line<'static>> {
    lines
        .iter()
        .map(|line| {
            let styled = line
                .spans()
                .iter()
                .map(|span| Span::styled(span.text.clone(), style_for(span)))
                .collect::<Vec<_>>();
            Line::from(styled)
        })
        .collect()
}

pub(crate) fn wrapped_log_range_to_lines(
    app: &mut AppState,
    width: usize,
    start: usize,
    end: usize,
) -> Vec<Line<'static>> {
    if width == 0 || start >= end {
        return Vec::new();
    }
    let wrapped = cached_wrap_log_lines(app, width);
    let clamped_end = end.min(wrapped.len());
    let clamped_start = start.min(clamped_end);
    if clamped_start >= clamped_end {
        return Vec::new();
    }
    log_lines_to_lines(&wrapped[clamped_start..clamped_end])
}

#[cfg(test)]
mod tests {
    use super::{log_lines_to_lines, wrap_log_lines};
    use crate::app::state::{LogColor, LogKind, LogLine, LogSpan, LogTone};
    use ratatui::style::Color;

    #[test]
    fn wraps_multi_span_code_lines_preserving_foreground_spans() {
        let line = LogLine::new_with_spans(vec![
            LogSpan::new_with_fg(
                LogKind::AssistantCode,
                LogTone::Detail,
                "fn main",
                Some(LogColor::rgb(200, 10, 10)),
            ),
            LogSpan::new_with_fg(
                LogKind::AssistantCode,
                LogTone::Detail,
                "() {}",
                Some(LogColor::rgb(10, 200, 10)),
            ),
        ]);

        let wrapped = wrap_log_lines(&[line], 5);
        assert!(wrapped.len() >= 2);
        assert!(wrapped[0].spans().iter().any(|span| span.fg.is_some()));
        assert!(wrapped[1].spans().iter().any(|span| span.fg.is_some()));
    }

    #[test]
    fn assistant_code_lines_are_padded_to_full_width() {
        let line = LogLine::new(LogKind::AssistantCode, "abc");
        let wrapped = wrap_log_lines(&[line], 8);

        assert_eq!(wrapped.len(), 1);
        assert_eq!(wrapped[0].plain_text().chars().count(), 8);
        assert_eq!(wrapped[0].kind(), LogKind::AssistantCode);
    }

    #[test]
    fn diff_code_lines_pad_with_diff_background_kind() {
        let line = LogLine::new_with_spans(vec![
            LogSpan::new(LogKind::DiffAdded, LogTone::Detail, "  12 +"),
            LogSpan::new_with_fg(
                LogKind::DiffAdded,
                LogTone::Detail,
                "const value = 7;",
                Some(LogColor::rgb(220, 220, 220)),
            ),
        ]);
        let wrapped = wrap_log_lines(&[line], 30);

        assert_eq!(wrapped.len(), 1);
        let last = wrapped[0].spans().last().expect("padding span");
        assert_eq!(last.kind, LogKind::DiffAdded);
        assert_eq!(wrapped[0].plain_text().chars().count(), 30);
    }

    #[test]
    fn log_lines_to_lines_preserves_token_foreground_color() {
        let line = LogLine::new_with_spans(vec![
            LogSpan::new(LogKind::DiffAdded, LogTone::Detail, "  1 +"),
            LogSpan::new_with_fg(
                LogKind::DiffAdded,
                LogTone::Detail,
                "export",
                Some(LogColor::rgb(86, 156, 214)),
            ),
        ]);
        let rendered = log_lines_to_lines(&[line]);
        let color = rendered[0].spans[1].style.fg;

        assert!(matches!(
            color,
            Some(Color::Rgb(86, 156, 214)) | Some(Color::Indexed(_))
        ));
    }

    #[test]
    fn wrap_multi_span_line_ignores_empty_leading_span_and_keeps_token_colors() {
        let line = LogLine::new_with_spans(vec![
            LogSpan::new(LogKind::DiffAdded, LogTone::Detail, ""),
            LogSpan::new(LogKind::DiffAdded, LogTone::Detail, "  1 +"),
            LogSpan::new_with_fg(
                LogKind::DiffAdded,
                LogTone::Detail,
                "type Session = {",
                Some(LogColor::rgb(180, 142, 173)),
            ),
        ]);

        let wrapped = wrap_log_lines(&[line], 40);
        assert_eq!(wrapped.len(), 1);
        assert!(wrapped[0].spans().iter().any(|span| span.fg.is_some()));
    }

    #[test]
    fn wraps_unordered_list_with_continuation_indent() {
        let line = LogLine::new(
            LogKind::Assistant,
            "- continuation indent should stay readable",
        );
        let wrapped = wrap_log_lines(&[line], 18);

        assert!(wrapped.len() >= 2);
        assert!(wrapped[1].plain_text().starts_with("  "));
    }

    #[test]
    fn wraps_ordered_list_with_marker_aligned_continuation() {
        let line = LogLine::new(LogKind::Assistant, "12. continuation indent should align");
        let wrapped = wrap_log_lines(&[line], 16);

        assert!(wrapped.len() >= 2);
        assert!(wrapped[1].plain_text().starts_with("    "));
    }

    #[test]
    fn wraps_task_list_with_checkbox_aligned_continuation() {
        let line = LogLine::new(LogKind::Assistant, "- [x] continuation stays aligned");
        let wrapped = wrap_log_lines(&[line], 16);

        assert!(wrapped.len() >= 2);
        assert!(wrapped[1].plain_text().starts_with("      "));
    }

    #[test]
    fn wraps_diff_multi_span_line_with_prefix_width_alignment() {
        let line = LogLine::new_with_spans(vec![
            LogSpan::new(LogKind::DiffAdded, LogTone::Detail, "  12 +"),
            LogSpan::new_with_fg(
                LogKind::DiffAdded,
                LogTone::Detail,
                "veryLongDiffCodeSegment",
                Some(LogColor::rgb(220, 220, 220)),
            ),
        ]);
        let wrapped = wrap_log_lines(&[line], 12);

        assert!(wrapped.len() >= 2);
        assert!(wrapped[1].plain_text().starts_with("      "));
    }

    #[test]
    fn wraps_diff_multi_span_line_with_empty_leading_span_and_gutter_split() {
        let line = LogLine::new_with_spans(vec![
            LogSpan::new(LogKind::DiffAdded, LogTone::Detail, ""),
            LogSpan::new(LogKind::DiffAdded, LogTone::Detail, "  12 "),
            LogSpan::new(LogKind::DiffAdded, LogTone::Detail, "+"),
            LogSpan::new_with_fg(
                LogKind::DiffAdded,
                LogTone::Detail,
                "veryLongDiffCodeSegment",
                Some(LogColor::rgb(220, 220, 220)),
            ),
        ]);
        let wrapped = wrap_log_lines(&[line], 12);

        assert!(wrapped.len() >= 2);
        assert!(wrapped[1].plain_text().starts_with("      "));
    }

    #[test]
    fn wraps_diff_numeric_token_without_over_indenting_continuation() {
        let line = LogLine::new_with_spans(vec![
            LogSpan::new(LogKind::DiffAdded, LogTone::Detail, "  8 +"),
            LogSpan::new_with_fg(
                LogKind::DiffAdded,
                LogTone::Detail,
                "123",
                Some(LogColor::rgb(220, 220, 220)),
            ),
            LogSpan::new_with_fg(
                LogKind::DiffAdded,
                LogTone::Detail,
                "abcdefghi",
                Some(LogColor::rgb(180, 180, 180)),
            ),
        ]);
        let wrapped = wrap_log_lines(&[line], 10);

        assert!(wrapped.len() >= 2);
        assert!(wrapped[1].plain_text().starts_with("     "));
        assert!(!wrapped[1].plain_text().starts_with("        "));
    }

    #[test]
    fn wraps_multi_span_quote_with_continuation_and_keeps_token_color() {
        let line = LogLine::new_with_spans(vec![
            LogSpan::new(LogKind::AssistantCode, LogTone::Detail, "> "),
            LogSpan::new_with_fg(
                LogKind::AssistantCode,
                LogTone::Detail,
                "let highlighted = veryLongIdentifier;",
                Some(LogColor::rgb(86, 156, 214)),
            ),
        ]);
        let wrapped = wrap_log_lines(&[line], 14);

        assert!(wrapped.len() >= 2);
        assert!(wrapped[1].plain_text().starts_with("> "));
        assert!(wrapped[1].spans().iter().any(|span| span.fg.is_some()));
    }
}
