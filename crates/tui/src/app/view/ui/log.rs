use crate::app::state::{LogKind, LogLine};
use crate::app::util::text::wrap_line;
use crate::app::{AppState, WrappedLogCache};
use ratatui::text::{Line, Span};
use std::time::Instant;

use super::style::style_for;
use super::text::pad_to_width;

fn wrap_log_lines(lines: &[LogLine], width: usize) -> Vec<LogLine> {
    let mut out = Vec::new();
    for line in lines {
        if line.plain_text().is_empty() {
            out.push(line.clone());
            continue;
        }
        if !line.is_single_span() {
            out.push(line.clone());
            continue;
        }
        let is_user = line.kind() == LogKind::User;
        let wrap_width = if is_user {
            width.saturating_sub(4).max(1)
        } else {
            width
        };
        for wrapped in wrap_line(&line.plain_text(), wrap_width) {
            let wrapped = if is_user {
                pad_to_width(format!(" {wrapped} "), width)
            } else {
                wrapped
            };
            out.push(line.with_text(wrapped));
        }
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
                .map(|span| Span::styled(span.text.clone(), style_for(span.kind, span.tone)))
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
