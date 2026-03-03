use crate::app::state::{LogKind, LogLine, LogSpan, LogTone};
use crate::app::AppState;
use serde_json::Value;
use std::time::Duration;

const BANG_PREVIEW_MAX_LINES_PER_STREAM: usize = 8;
const BANG_PREVIEW_MAX_LINE_CHARS: usize = 240;

pub(super) fn format_duration(duration: Duration) -> String {
    let total_secs = duration.as_secs();
    if total_secs >= 60 {
        let minutes = total_secs / 60;
        let seconds = total_secs % 60;
        return format!("{minutes}m{seconds:02}s");
    }
    format!("{:.1}s", duration.as_secs_f64())
}

pub(super) fn truncate_text(text: &str, max: usize) -> String {
    let count = text.chars().count();
    if count <= max {
        return text.to_string();
    }
    let take = max.saturating_sub(3);
    let truncated: String = text.chars().take(take).collect();
    format!("{truncated}...")
}

fn rpc_error_message(error: &Value) -> String {
    if let Some(message) = error
        .get("message")
        .and_then(|value| value.as_str())
        .map(str::trim)
        .filter(|value| !value.is_empty())
    {
        return message.to_string();
    }
    if let Some(message) = error
        .as_str()
        .map(str::trim)
        .filter(|value| !value.is_empty())
    {
        return message.to_string();
    }
    truncate_text(&error.to_string(), 180)
}

fn rpc_error_detail(error: &Value) -> String {
    match error {
        Value::Object(_) | Value::Array(_) => {
            serde_json::to_string_pretty(error).unwrap_or_else(|_| error.to_string())
        }
        Value::String(text) => text.clone(),
        _ => error.to_string(),
    }
}

pub(super) fn push_rpc_error(app: &mut AppState, scope: &str, error: &Value) {
    let message = rpc_error_message(error);
    let summary = match error.get("code").and_then(|value| value.as_i64()) {
        Some(code) => format!("{scope} error: {message} (code {code})"),
        None => format!("{scope} error: {message}"),
    };
    app.push_error_report(summary, rpc_error_detail(error));
}

fn is_spacing_kind(kind: LogKind, enable_debug_print: bool) -> bool {
    match kind {
        LogKind::Space => false,
        LogKind::Runtime | LogKind::Rpc => enable_debug_print,
        _ => true,
    }
}

pub(super) fn last_summary_kind(lines: &[LogLine], enable_debug_print: bool) -> Option<LogKind> {
    lines
        .iter()
        .rev()
        .find(|line| {
            line.tone() == LogTone::Summary && is_spacing_kind(line.kind(), enable_debug_print)
        })
        .map(LogLine::kind)
}

pub(super) fn add_kind_spacing(
    lines: Vec<LogLine>,
    prev_summary_kind: Option<LogKind>,
    enable_debug_print: bool,
) -> Vec<LogLine> {
    let mut out = Vec::with_capacity(lines.len().saturating_mul(2));
    let mut last_summary = prev_summary_kind;

    for line in lines {
        if line.kind() == LogKind::Space {
            if !matches!(out.last().map(LogLine::kind), Some(LogKind::Space)) {
                out.push(line);
            }
            continue;
        }

        if line.tone() == LogTone::Summary && is_spacing_kind(line.kind(), enable_debug_print) {
            if let Some(prev_kind) = last_summary {
                if prev_kind != line.kind()
                    && !matches!(out.last().map(LogLine::kind), Some(LogKind::Space))
                {
                    out.push(LogLine::new(LogKind::Space, ""));
                }
            }
            last_summary = Some(line.kind());
        }

        out.push(line);
    }

    out
}

pub(super) fn tool_call_with_status_icon(line: &LogLine, is_error: bool) -> LogLine {
    let icon_kind = if is_error {
        LogKind::Error
    } else {
        LogKind::ToolResult
    };
    let icon = if is_error { "✖" } else { "✔" };
    let mut spans = Vec::with_capacity(line.spans().len() + 2);
    spans.push(LogSpan::new(icon_kind, LogTone::Summary, icon));
    spans.push(LogSpan::new(LogKind::ToolCall, LogTone::Summary, " "));
    spans.extend(line.spans().iter().cloned());
    LogLine::new_with_spans(spans)
}

pub(crate) fn truncate_bang_preview_line(value: &str) -> String {
    let char_count = value.chars().count();
    if char_count <= BANG_PREVIEW_MAX_LINE_CHARS {
        return value.to_string();
    }
    let head = value
        .chars()
        .take(BANG_PREVIEW_MAX_LINE_CHARS)
        .collect::<String>();
    format!("{head}...[truncated]")
}

pub(crate) fn push_bang_stream_preview(
    app: &mut AppState,
    stream_label: &str,
    output: Option<&str>,
    truncated: bool,
    cache_id: Option<&str>,
) {
    let Some(raw) = output else {
        return;
    };
    if raw.trim().is_empty() {
        return;
    }

    app.push_line(LogKind::Status, format!("bang {stream_label}:"));

    let mut line_count = 0usize;
    for line in raw.lines().take(BANG_PREVIEW_MAX_LINES_PER_STREAM) {
        line_count += 1;
        app.push_line(
            LogKind::Runtime,
            format!("  {}", truncate_bang_preview_line(line)),
        );
    }

    let total_lines = raw.lines().count();
    if total_lines > line_count {
        app.push_line(
            LogKind::Status,
            format!(
                "  ...[{} more lines]",
                total_lines.saturating_sub(line_count)
            ),
        );
    }

    if truncated {
        if let Some(cache_id) = cache_id {
            app.push_line(
                LogKind::Status,
                format!("  (truncated; full output: tool_output_cache ref `{cache_id}`)"),
            );
        } else {
            app.push_line(LogKind::Status, "  (truncated output)");
        }
    }
}
