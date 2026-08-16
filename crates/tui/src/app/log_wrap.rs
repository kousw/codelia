use crate::app::state::{LogKind, LogLine, LogSpan, LogTone, SelectableFragment};
use crate::app::theme::ui_colors;
use crate::app::util::text::detect_continuation_prefix;
use crate::app::{AppState, SelectionProjectionId, SelectionRange, WrappedLogCache, WrappedLogRow};
use ratatui::style::{Color, Modifier, Style};
use ratatui::text::{Line, Span};
use std::ops::Range;
use std::sync::OnceLock;
use std::time::Instant;
use unicode_segmentation::UnicodeSegmentation;
use unicode_width::UnicodeWidthStr;

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
    let gray_level = 8 + gray_step as i32 * 10;
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
                .add_modifier(theme.low_emphasis_modifier),
        ),
        LogKind::User => (
            Style::default().fg(theme.surface_fg).bg(input_bg()),
            Style::default().fg(theme.surface_fg).bg(input_bg()),
        ),
        LogKind::Assistant => (
            Style::default().fg(theme.log_primary_fg),
            Style::default().fg(theme.log_primary_fg),
        ),
        LogKind::AssistantCode => (
            Style::default()
                .fg(theme.surface_fg)
                .bg(theme.code_block_bg),
            Style::default()
                .fg(theme.surface_fg)
                .bg(theme.code_block_bg),
        ),
        LogKind::Reasoning => (
            Style::default()
                .fg(theme.log_muted_fg)
                .add_modifier(Modifier::ITALIC),
            Style::default()
                .fg(theme.log_muted_fg)
                .add_modifier(Modifier::ITALIC)
                .add_modifier(theme.low_emphasis_modifier),
        ),
        LogKind::ToolCall => (
            Style::default().fg(theme.log_tool_call_fg),
            Style::default().fg(theme.log_primary_fg),
        ),
        LogKind::ToolResult => (
            Style::default().fg(theme.log_tool_result_fg),
            Style::default()
                .fg(theme.log_tool_result_fg)
                .add_modifier(theme.low_emphasis_modifier),
        ),
        LogKind::TodoPending => (
            Style::default().fg(theme.log_primary_fg),
            Style::default().fg(theme.log_primary_fg),
        ),
        LogKind::TodoInProgress => (
            Style::default()
                .fg(theme.log_status_fg)
                .add_modifier(Modifier::BOLD),
            Style::default()
                .fg(theme.log_status_fg)
                .add_modifier(Modifier::BOLD),
        ),
        LogKind::TodoCompleted => (
            Style::default()
                .fg(theme.log_muted_fg)
                .add_modifier(theme.low_emphasis_modifier),
            Style::default()
                .fg(theme.log_muted_fg)
                .add_modifier(theme.low_emphasis_modifier),
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
                .fg(theme.surface_fg)
                .bg(theme.diff_code_block_bg),
            Style::default()
                .fg(theme.surface_fg)
                .bg(theme.diff_code_block_bg),
        ),
        LogKind::Shell => (
            Style::default().fg(theme.log_muted_fg),
            Style::default()
                .fg(theme.log_muted_fg)
                .add_modifier(theme.low_emphasis_modifier),
        ),
        LogKind::DiffAdded => (
            Style::default()
                .fg(theme.surface_fg)
                .bg(theme.diff_added_bg),
            Style::default()
                .fg(theme.surface_fg)
                .bg(theme.diff_added_bg),
        ),
        LogKind::DiffRemoved => (
            Style::default()
                .fg(theme.surface_fg)
                .bg(theme.diff_removed_bg),
            Style::default()
                .fg(theme.surface_fg)
                .bg(theme.diff_removed_bg),
        ),
        LogKind::Status => (
            Style::default().fg(theme.log_status_fg),
            Style::default().fg(theme.log_status_fg),
        ),
        LogKind::Compaction => (
            Style::default()
                .fg(theme.log_status_fg)
                .add_modifier(Modifier::ITALIC),
            Style::default()
                .fg(theme.log_status_fg)
                .add_modifier(Modifier::ITALIC)
                .add_modifier(theme.low_emphasis_modifier),
        ),
        LogKind::Rpc => (
            Style::default()
                .fg(theme.log_muted_fg)
                .add_modifier(theme.low_emphasis_modifier),
            Style::default()
                .fg(theme.log_muted_fg)
                .add_modifier(theme.low_emphasis_modifier),
        ),
        LogKind::Runtime => (
            Style::default()
                .fg(theme.log_muted_fg)
                .add_modifier(theme.low_emphasis_modifier),
            Style::default()
                .fg(theme.log_muted_fg)
                .add_modifier(theme.low_emphasis_modifier),
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
                .add_modifier(theme.low_emphasis_modifier),
        ),
    };

    match tone {
        LogTone::Summary => summary,
        LogTone::Detail => detail,
    }
}

fn visual_width(text: &str) -> usize {
    UnicodeWidthStr::width(text)
}

fn pad_to_width(mut text: String, width: usize) -> String {
    let current = visual_width(&text);
    if current >= width {
        return text;
    }
    text.push_str(&" ".repeat(width - current));
    text
}

#[derive(Clone, Debug)]
struct StyledGrapheme {
    render_span: LogSpan,
    width: usize,
    selectable: bool,
}

struct WrappedLinePart {
    line: LogLine,
    selectable_fragments: Vec<SelectableFragment>,
}

fn styled_graphemes(line: &LogLine) -> Vec<StyledGrapheme> {
    let plain = line.plain_text();
    let gutter_end = diff_gutter_prefix(line).map_or(0, |gutter| gutter.len());
    let mut span_offsets = Vec::with_capacity(line.spans().len());
    let mut offset = 0usize;
    for span in line.spans() {
        let end = offset.saturating_add(span.text.len());
        span_offsets.push((span, offset, end));
        offset = end;
    }

    UnicodeSegmentation::grapheme_indices(plain.as_str(), true)
        .map(|(start, grapheme)| {
            let end = start.saturating_add(grapheme.len());
            let mut render_span = span_offsets
                .iter()
                .find(|(_, span_start, span_end)| start >= *span_start && start < *span_end)
                .or_else(|| {
                    span_offsets
                        .iter()
                        .find(|(_, span_start, span_end)| start < *span_end && end > *span_start)
                })
                .map(|(span, _, _)| (*span).clone())
                .unwrap_or_else(|| LogSpan::new(line.kind(), line.tone(), ""));
            // Ratatui segments each Span independently. Keep a grapheme that
            // crosses source style spans in one render span so ZWJ/combining
            // sequences retain their terminal width and cannot split visually.
            render_span.text = grapheme.to_string();
            StyledGrapheme {
                render_span,
                width: UnicodeWidthStr::width(grapheme).max(1),
                selectable: start >= gutter_end,
            }
        })
        .collect()
}

fn push_render_span(spans: &mut Vec<LogSpan>, next: &LogSpan) {
    if let Some(last) = spans.last_mut() {
        if last.kind == next.kind && last.tone == next.tone && last.fg == next.fg {
            last.text.push_str(&next.text);
            return;
        }
    }
    spans.push(next.clone());
}

fn grapheme_chunk_len(graphemes: &[StyledGrapheme], width: usize) -> usize {
    let mut count = 0usize;
    let mut used = 0usize;
    for grapheme in graphemes {
        if used.saturating_add(grapheme.width) > width && count > 0 {
            break;
        }
        used = used.saturating_add(grapheme.width);
        count += 1;
        if used >= width {
            break;
        }
    }
    count
}

fn wrapped_part_from_graphemes(
    line: &LogLine,
    continuation_prefix: &str,
    graphemes: &[StyledGrapheme],
) -> WrappedLinePart {
    let prefix_width = UnicodeWidthStr::width(continuation_prefix);
    let mut rendered_spans = Vec::new();
    if prefix_width > 0 {
        let (kind, tone) = line.first_style();
        rendered_spans.push(LogSpan::new(kind, tone, continuation_prefix));
    }
    for grapheme in graphemes {
        push_render_span(&mut rendered_spans, &grapheme.render_span);
    }

    let mut cell = prefix_width;
    let mut selectable_fragments = Vec::new();
    for grapheme in graphemes {
        let next_cell = cell.saturating_add(grapheme.width);
        if grapheme.selectable {
            selectable_fragments.push(SelectableFragment {
                cell_start: cell,
                cell_end: next_cell,
                text: grapheme.render_span.text.clone(),
            });
        }
        cell = next_cell;
    }

    WrappedLinePart {
        line: LogLine::new_with_spans(rendered_spans),
        selectable_fragments,
    }
}

fn wrap_styled_line(
    line: &LogLine,
    width: usize,
    continuation_prefix: Option<&str>,
) -> Vec<WrappedLinePart> {
    let graphemes = styled_graphemes(line);
    let mut out = Vec::new();
    let mut next_grapheme = 0usize;
    let mut first_line = true;

    let continuation_prefix = continuation_prefix.unwrap_or("");
    let continuation_prefix_width = UnicodeWidthStr::width(continuation_prefix);
    let can_use_continuation = !continuation_prefix.is_empty() && width > continuation_prefix_width;

    while next_grapheme < graphemes.len() {
        let chunk_width = if first_line || !can_use_continuation {
            width
        } else {
            width - continuation_prefix_width
        };
        let consumed = grapheme_chunk_len(&graphemes[next_grapheme..], chunk_width);
        if consumed == 0 {
            break;
        }
        let chunk = &graphemes[next_grapheme..next_grapheme + consumed];
        let rendered_prefix = if !first_line && can_use_continuation {
            continuation_prefix
        } else {
            ""
        };
        out.push(wrapped_part_from_graphemes(line, rendered_prefix, chunk));
        next_grapheme += consumed;
        first_line = false;
    }

    if out.is_empty() {
        out.push(WrappedLinePart {
            line: LogLine::new(line.kind(), line.plain_text()),
            selectable_fragments: Vec::new(),
        });
    }

    out
}

fn span_text_width(text: &str) -> usize {
    UnicodeWidthStr::width(text)
}

fn line_text_width(line: &LogLine) -> usize {
    UnicodeWidthStr::width(line.plain_text().as_str())
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

fn diff_gutter_prefix(line: &LogLine) -> Option<String> {
    if !matches!(
        line.kind(),
        LogKind::DiffAdded | LogKind::DiffRemoved | LogKind::DiffContext | LogKind::DiffCode
    ) {
        return None;
    }
    parse_diff_gutter_prefix(&line.plain_text())
}

fn diff_continuation_prefix(line: &LogLine) -> Option<String> {
    let gutter = diff_gutter_prefix(line)?;
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

fn wrap_log_lines(lines: &[LogLine], width: usize) -> Vec<WrappedLogRow> {
    let mut out = Vec::new();
    for line in lines {
        if line.plain_text().is_empty() {
            out.push(WrappedLogRow {
                line: line.clone(),
                selectable_fragments: Vec::new(),
                soft_wrap_after: false,
            });
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

        let mut wrapped_multi = wrap_styled_line(line, wrap_width, continuation_prefix.as_deref());
        if is_user {
            wrapped_multi = wrapped_multi
                .into_iter()
                .map(|mut wrapped| {
                    let padded = pad_to_width(format!(" {} ", wrapped.line.plain_text()), width);
                    wrapped.line = LogLine::new_with_spans(vec![LogSpan::new(
                        line.kind(),
                        line.tone(),
                        padded,
                    )]);
                    for fragment in &mut wrapped.selectable_fragments {
                        fragment.cell_start = fragment.cell_start.saturating_add(1);
                        fragment.cell_end = fragment.cell_end.saturating_add(1);
                    }
                    wrapped
                })
                .collect();
        }
        let wrapped_count = wrapped_multi.len();
        out.extend(
            wrapped_multi
                .into_iter()
                .enumerate()
                .map(|(index, wrapped)| WrappedLogRow {
                    line: pad_background_line(wrapped.line, width),
                    selectable_fragments: wrapped.selectable_fragments,
                    soft_wrap_after: index + 1 < wrapped_count,
                }),
        );
    }
    out
}

pub(crate) fn cached_wrap_log_lines(app: &mut AppState, width: usize) -> &[WrappedLogRow] {
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
    let lines = wrapped[clamped_start..clamped_end]
        .iter()
        .map(|row| row.line.clone())
        .collect::<Vec<_>>();
    log_lines_to_lines(&lines)
}

fn requested_cell_range(range: SelectionRange, wrapped_row: usize) -> Option<Range<usize>> {
    if wrapped_row < range.start.wrapped_row || wrapped_row > range.end.wrapped_row {
        return None;
    }
    let start = if wrapped_row == range.start.wrapped_row {
        range.start.cell
    } else {
        0
    };
    let end = if wrapped_row == range.end.wrapped_row {
        range.end.cell.saturating_add(1)
    } else {
        usize::MAX
    };
    (start < end).then_some(start..end)
}

fn fragment_intersects(fragment: &SelectableFragment, cells: &Range<usize>) -> bool {
    fragment.cell_end > cells.start && fragment.cell_start < cells.end
}

fn selected_fragments_for_row(
    range: SelectionRange,
    wrapped_row: usize,
    row: &WrappedLogRow,
) -> impl Iterator<Item = &SelectableFragment> {
    let requested = requested_cell_range(range, wrapped_row);
    row.selectable_fragments.iter().filter(move |fragment| {
        requested
            .as_ref()
            .is_some_and(|cells| fragment_intersects(fragment, cells))
    })
}

pub(crate) fn selected_cell_ranges_for_row(
    range: SelectionRange,
    wrapped_row: usize,
    row: &WrappedLogRow,
) -> Vec<Range<usize>> {
    let mut selected: Vec<Range<usize>> = Vec::new();
    for fragment in selected_fragments_for_row(range, wrapped_row, row) {
        if let Some(last) = selected.last_mut() {
            if last.end == fragment.cell_start {
                last.end = fragment.cell_end;
                continue;
            }
        }
        selected.push(fragment.cell_start..fragment.cell_end);
    }
    selected
}

pub(crate) fn selected_text_for_range(
    app: &AppState,
    range: SelectionRange,
    projection: SelectionProjectionId,
) -> Option<String> {
    let cache = app.wrapped_log_cache.as_ref()?;
    if cache.log_version != projection.log_version || cache.width != projection.wrap_width {
        return None;
    }
    let end_row = range
        .end
        .wrapped_row
        .min(cache.wrapped.len().saturating_sub(1));
    if range.start.wrapped_row > end_row {
        return None;
    }
    let mut output = String::new();
    for wrapped_row in range.start.wrapped_row..=end_row {
        let row = &cache.wrapped[wrapped_row];
        for fragment in selected_fragments_for_row(range, wrapped_row, row) {
            output.push_str(&fragment.text);
        }
        if wrapped_row < end_row && !row.soft_wrap_after {
            output.push('\n');
        }
    }
    (!output.is_empty()).then_some(output)
}

#[cfg(test)]
mod tests {
    use super::{log_lines_to_lines, selected_text_for_range, wrap_log_lines};
    use crate::app::state::selection::SelectionPoint;
    use crate::app::state::{
        LogColor, LogKind, LogLine, LogSpan, LogTone, SelectionProjectionId, SelectionRange,
        WrappedLogCache,
    };
    use crate::app::theme::ui_colors;
    use crate::app::AppState;
    use ratatui::style::{Color, Modifier};

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

    fn app_with_wrapped_rows(lines: Vec<LogLine>, width: usize) -> AppState {
        let mut app = AppState::default();
        app.log_version = 7;
        app.wrapped_log_cache = Some(WrappedLogCache {
            width,
            log_version: app.log_version,
            wrapped: wrap_log_lines(&lines, width),
        });
        app
    }

    fn entire_range(app: &AppState) -> SelectionRange {
        let rows = &app.wrapped_log_cache.as_ref().unwrap().wrapped;
        SelectionRange {
            start: SelectionPoint {
                wrapped_row: 0,
                cell: 0,
            },
            end: SelectionPoint {
                wrapped_row: rows.len() - 1,
                cell: usize::MAX - 1,
            },
        }
    }

    #[test]
    fn selection_excludes_user_bubble_and_code_background_padding() {
        let app = app_with_wrapped_rows(
            vec![
                LogLine::new(LogKind::User, " keep spaces "),
                LogLine::new(LogKind::AssistantCode, "code"),
            ],
            20,
        );
        let projection = SelectionProjectionId {
            log_version: app.log_version,
            wrap_width: 20,
        };

        assert_eq!(
            selected_text_for_range(&app, entire_range(&app), projection).as_deref(),
            Some(" keep spaces \ncode")
        );
    }

    #[test]
    fn selection_removes_soft_wrap_and_synthetic_continuation_indent() {
        let app = app_with_wrapped_rows(vec![LogLine::new(LogKind::Assistant, "- abcdefghij")], 8);
        let projection = SelectionProjectionId {
            log_version: app.log_version,
            wrap_width: 8,
        };

        assert_eq!(
            selected_text_for_range(&app, entire_range(&app), projection).as_deref(),
            Some("- abcdefghij")
        );
    }

    #[test]
    fn selection_preserves_hard_breaks_and_whole_unicode_graphemes() {
        let app = app_with_wrapped_rows(
            vec![
                LogLine::new(LogKind::Assistant, "A界👩‍💻Z"),
                LogLine::new(LogKind::Assistant, "次"),
            ],
            20,
        );
        let projection = SelectionProjectionId {
            log_version: app.log_version,
            wrap_width: 20,
        };
        let range = SelectionRange {
            start: SelectionPoint {
                wrapped_row: 0,
                cell: 2,
            },
            end: SelectionPoint {
                wrapped_row: 1,
                cell: 1,
            },
        };

        assert_eq!(
            selected_text_for_range(&app, range, projection).as_deref(),
            Some("界👩‍💻Z\n次")
        );
    }

    #[test]
    fn selection_excludes_permission_diff_gutter_and_rejoins_wrapped_code() {
        let line = LogLine::new_with_spans(vec![
            LogSpan::new(LogKind::DiffAdded, LogTone::Detail, ""),
            LogSpan::new(LogKind::DiffAdded, LogTone::Detail, "  12 "),
            LogSpan::new(LogKind::DiffAdded, LogTone::Detail, "+ "),
            LogSpan::new_with_fg(
                LogKind::DiffAdded,
                LogTone::Detail,
                "const selectedValue = 7;",
                Some(LogColor::rgb(220, 220, 220)),
            ),
        ]);
        let app = app_with_wrapped_rows(vec![line], 12);
        let projection = SelectionProjectionId {
            log_version: app.log_version,
            wrap_width: 12,
        };

        assert_eq!(
            selected_text_for_range(&app, entire_range(&app), projection).as_deref(),
            Some("const selectedValue = 7;")
        );
        assert!(app.wrapped_log_cache.as_ref().unwrap().wrapped[0]
            .selectable_fragments
            .iter()
            .all(|fragment| fragment.cell_start >= 7));
    }

    #[test]
    fn grapheme_wrap_keeps_combining_sequence_together_across_style_spans() {
        let line = LogLine::new_with_spans(vec![
            LogSpan::new(LogKind::Assistant, LogTone::Summary, "e"),
            LogSpan::new_with_fg(
                LogKind::Assistant,
                LogTone::Summary,
                "\u{301}",
                Some(LogColor::rgb(220, 220, 220)),
            ),
            LogSpan::new(LogKind::Assistant, LogTone::Summary, "X"),
        ]);
        let app = app_with_wrapped_rows(vec![line], 1);
        let rows = &app.wrapped_log_cache.as_ref().unwrap().wrapped;
        let projection = SelectionProjectionId {
            log_version: app.log_version,
            wrap_width: 1,
        };

        assert_eq!(rows.len(), 2);
        assert_eq!(rows[0].plain_text(), "e\u{301}");
        assert_eq!(rows[0].selectable_fragments[0].text, "e\u{301}");
        assert_eq!(
            selected_text_for_range(&app, entire_range(&app), projection).as_deref(),
            Some("e\u{301}X")
        );
    }

    #[test]
    fn grapheme_wrap_keeps_zwj_emoji_together_across_style_spans() {
        let line = LogLine::new_with_spans(vec![
            LogSpan::new(LogKind::Assistant, LogTone::Summary, "👩"),
            LogSpan::new_with_fg(
                LogKind::Assistant,
                LogTone::Summary,
                "\u{200d}",
                Some(LogColor::rgb(220, 220, 220)),
            ),
            LogSpan::new(LogKind::Assistant, LogTone::Summary, "💻X"),
        ]);
        let app = app_with_wrapped_rows(vec![line], 2);
        let rows = &app.wrapped_log_cache.as_ref().unwrap().wrapped;
        let projection = SelectionProjectionId {
            log_version: app.log_version,
            wrap_width: 2,
        };

        assert_eq!(rows.len(), 2);
        assert_eq!(rows[0].plain_text(), "👩‍💻");
        assert_eq!(rows[0].selectable_fragments[0].text, "👩‍💻");
        assert_eq!(
            selected_text_for_range(&app, entire_range(&app), projection).as_deref(),
            Some("👩‍💻X")
        );
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
    fn todo_completed_lines_use_muted_color_without_strikethrough() {
        let line = LogLine::new_with_spans(vec![
            LogSpan::new(LogKind::TodoCompleted, LogTone::Summary, "1. [x] done"),
            LogSpan::new(LogKind::TodoCompleted, LogTone::Detail, " detail"),
        ]);
        let rendered = log_lines_to_lines(&[line]);

        for span in &rendered[0].spans {
            assert_eq!(span.style.fg, Some(ui_colors().log_muted_fg));
            assert!(!span.style.add_modifier.contains(Modifier::CROSSED_OUT));
        }
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
