use crate::app::state::{LogKind, LogLine, LogSpan};
use crate::app::util::text::{char_width, wrap_line};
use crate::app::{AppState, WrappedLogCache};
use ratatui::text::{Line, Span};
use std::time::Instant;

use super::style::style_for;
use super::text::pad_to_width;

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

fn wrap_multi_span_line(line: &LogLine, width: usize) -> Vec<LogLine> {
    let mut remaining = line.spans().to_vec();
    let mut out = Vec::new();

    while !remaining.is_empty() {
        let (chunk, consumed_chars) = take_spans_until_width(&remaining, width);
        if chunk.is_empty() {
            break;
        }
        out.push(LogLine::new_with_spans(chunk));
        remaining = trim_spans_front(&remaining, consumed_chars);
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

fn background_padding_kind(line: &LogLine) -> Option<LogKind> {
    match line.kind() {
        LogKind::DiffAdded | LogKind::DiffRemoved => Some(line.kind()),
        LogKind::AssistantCode => line
            .spans()
            .iter()
            .find_map(|span| match span.kind {
                LogKind::DiffAdded | LogKind::DiffRemoved => Some(span.kind),
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

        if line.is_single_span() {
            for wrapped in wrap_line(&line.plain_text(), wrap_width) {
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

        let mut wrapped_multi = wrap_multi_span_line(line, wrap_width);
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

pub(super) fn cached_wrap_log_lines(app: &mut AppState, width: usize) -> &[LogLine] {
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

        assert_eq!(color, Some(Color::Rgb(86, 156, 214)));
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
}
