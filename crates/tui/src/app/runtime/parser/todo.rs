use crate::app::state::{LogKind, LogLine, LogSpan, LogTone};
use serde_json::Value;

use super::common::{
    detail_line, redact_ref_markers, split_lines, summary_line, truncate_line, DETAIL_INDENT,
};

const MAX_HEADER_LENGTH: usize = 200;

pub(super) fn is_todo_mutation_tool(tool: &str) -> bool {
    matches!(
        tool,
        "todo_new" | "todo_append" | "todo_patch" | "todo_clear"
    )
}

pub(super) fn result_is_error(tool: &str, lower: &str) -> bool {
    if is_todo_mutation_tool(tool) {
        return lower.starts_with("patch failed:")
            || lower.starts_with("invalid todo state:")
            || lower.starts_with("todo update failed")
            || lower.starts_with("tool input validation failed for todo_new:")
            || lower.starts_with("tool input validation failed for todo_append:")
            || lower.starts_with("tool input validation failed for todo_patch:")
            || lower.starts_with("tool input validation failed for todo_clear:")
            || lower.starts_with("error: tool input validation failed for todo_new:")
            || lower.starts_with("error: tool input validation failed for todo_append:")
            || lower.starts_with("error: tool input validation failed for todo_patch:")
            || lower.starts_with("error: tool input validation failed for todo_clear:");
    }
    tool == "todo_read" && lower.starts_with("todo read failed")
}

fn todo_text_for_tui(raw: &str) -> Option<String> {
    let cleaned = redact_ref_markers(raw);
    let trimmed = cleaned.trim();
    if trimmed.is_empty() {
        return Some(String::new());
    }

    let parsed = serde_json::from_str::<Value>(trimmed).ok();
    if let Some(value) = parsed {
        if let Some(text) = value
            .as_str()
            .map(str::trim)
            .filter(|text| !text.is_empty())
        {
            return Some(text.to_string());
        }
        for key in ["summary", "message", "text"] {
            if let Some(text) = value
                .get(key)
                .and_then(Value::as_str)
                .map(str::trim)
                .filter(|text| !text.is_empty())
            {
                return Some(text.to_string());
            }
        }
        return None;
    }

    Some(trimmed.to_string())
}

fn parse_todo_task_line(line: &str) -> Option<LogLine> {
    let trimmed = line.trim();
    let number_len = trimmed.chars().take_while(|ch| ch.is_ascii_digit()).count();
    if number_len == 0 {
        return None;
    }
    let rest = trimmed.get(number_len..)?;
    let rest = rest.strip_prefix(". ")?;
    let checkbox_body = rest.strip_prefix('[')?;
    let closing_idx = checkbox_body.find(']')?;
    let checkbox_marker = checkbox_body.get(..closing_idx)?;
    if checkbox_marker.chars().count() != 1 {
        return None;
    }
    let marker = checkbox_marker.chars().next()?;
    let todo_kind = match marker {
        ' ' => LogKind::TodoPending,
        '>' => LogKind::TodoInProgress,
        'x' | 'X' => LogKind::TodoCompleted,
        _ => return None,
    };
    if todo_kind == LogKind::TodoCompleted {
        return Some(LogLine::new_with_spans(vec![
            LogSpan::new(LogKind::TodoCompleted, LogTone::Detail, ""),
            LogSpan::new(LogKind::Status, LogTone::Detail, DETAIL_INDENT),
            LogSpan::new(LogKind::TodoCompleted, LogTone::Detail, trimmed),
        ]));
    }
    Some(LogLine::new_with_tone(
        todo_kind,
        LogTone::Detail,
        format!("{DETAIL_INDENT}{trimmed}"),
    ))
}

fn todo_read_detail_lines(text: &str) -> Vec<LogLine> {
    let mut details = Vec::new();
    for line in split_lines(text) {
        let trimmed = line.trim();
        if trimmed.is_empty()
            || trimmed.starts_with("Todo plan:")
            || trimmed.starts_with("Summary:")
            || trimmed.starts_with("note:")
        {
            continue;
        }
        if let Some(task_line) = parse_todo_task_line(trimmed) {
            details.push(task_line);
            continue;
        }
        let detail_kind = if trimmed.starts_with("Next:") {
            LogKind::ToolResult
        } else {
            LogKind::Status
        };
        details.push(detail_line(
            detail_kind,
            format!("{DETAIL_INDENT}{trimmed}"),
        ));
    }
    details
}

fn todo_mutation_summary(text: &str) -> Option<String> {
    if text.is_empty() {
        return None;
    }
    if !text.starts_with("Updated todos") {
        return Some(truncate_line(text, MAX_HEADER_LENGTH));
    }
    let mut stats_text = text
        .split_once(':')
        .map(|(_, value)| value.trim())
        .unwrap_or(text)
        .trim();
    if let Some((before_next, _)) = stats_text.split_once(" Next:") {
        stats_text = before_next.trim();
    }
    let stats_text = stats_text.trim_end_matches('.').trim();
    if stats_text.is_empty() {
        return Some("TODO: Updated plan".to_string());
    }
    Some(format!("TODO: Updated {stats_text}"))
}

fn todo_read_summary(text: &str) -> Option<String> {
    if text.is_empty() {
        return None;
    }
    if text == "Todo list is empty" {
        return Some("TODO: Plan empty".to_string());
    }
    let summary_line = split_lines(text)
        .into_iter()
        .find(|line| line.starts_with("Summary:"))?;
    let summary = summary_line.trim_start_matches("Summary:").trim();
    if summary.is_empty() {
        return Some("TODO: Read plan".to_string());
    }
    Some(format!("TODO: {summary}"))
}

fn todo_mutation_error_summary(tool: &str, text: &str) -> String {
    let normalized = text
        .strip_prefix("Error: ")
        .map(str::trim)
        .unwrap_or(text)
        .trim();
    if let Some(details) = normalized.strip_prefix("Patch failed:") {
        return format!("TODO: Patch failed - {}", details.trim());
    }
    if let Some(details) = normalized.strip_prefix("Invalid todo state:") {
        return format!("TODO: Invalid plan state - {}", details.trim());
    }
    if let Some(details) = normalized.strip_prefix("Todo update failed:") {
        return format!("TODO: Todo update failed - {}", details.trim());
    }
    let validation_prefix = format!("Tool input validation failed for {tool}:");
    let validation_prefix_error = format!("Error: Tool input validation failed for {tool}:");
    if normalized.starts_with(&validation_prefix) || text.starts_with(&validation_prefix_error) {
        let lower = normalized.to_lowercase();
        let missing_updates = lower.contains("updates")
            && (lower.contains("at least 1")
                || lower.contains("at least one")
                || lower.contains("too_small"));
        let missing_todos = lower.contains("todos")
            && (lower.contains("at least 1")
                || lower.contains("at least one")
                || lower.contains("too_small"));
        let extra_todos = lower.contains("unrecognized key") && lower.contains("todos");
        let extra_updates = lower.contains("unrecognized key") && lower.contains("updates");
        match tool {
            "todo_patch" => {
                if missing_updates {
                    return "TODO: Invalid patch request - add at least one updates item"
                        .to_string();
                }
                if lower.contains("updates only") || extra_todos {
                    return "TODO: Invalid patch request - use updates, not todos".to_string();
                }
            }
            "todo_clear" => {
                if extra_todos || extra_updates {
                    return "TODO: Invalid clear request - omit todos and updates".to_string();
                }
            }
            "todo_append" => {
                if missing_todos {
                    return "TODO: Invalid append request - add at least one todos item"
                        .to_string();
                }
                if lower.contains("todos only") || extra_updates {
                    return "TODO: Invalid append request - use todos, not updates".to_string();
                }
            }
            "todo_new" => {
                if missing_todos {
                    return "TODO: Invalid new request - add at least one todos item".to_string();
                }
                if lower.contains("todos only") || extra_updates {
                    return "TODO: Invalid new request - use todos, not updates".to_string();
                }
            }
            _ => {}
        }
        return "TODO: Invalid todo request".to_string();
    }
    "TODO: Todo update failed".to_string()
}

pub(super) fn tool_result_lines(
    tool: &str,
    raw: &str,
    icon: &str,
    kind: LogKind,
    error: bool,
) -> Option<Vec<LogLine>> {
    if !(tool == "todo_read" || is_todo_mutation_tool(tool)) {
        return None;
    }
    let cleaned_text = todo_text_for_tui(raw);
    let cleaned_trim = cleaned_text.as_deref().unwrap_or("").trim();

    if is_todo_mutation_tool(tool) {
        let header = if error {
            todo_mutation_error_summary(tool, cleaned_trim)
        } else {
            todo_mutation_summary(cleaned_trim).unwrap_or_else(|| "TODO: Updated plan".to_string())
        };
        let mut lines = vec![summary_line(
            icon,
            truncate_line(&header, MAX_HEADER_LENGTH),
            kind,
        )];
        if !error && !cleaned_trim.is_empty() {
            lines.extend(todo_read_detail_lines(cleaned_trim));
        }
        return Some(lines);
    }

    let header = if error {
        "TODO: Read failed".to_string()
    } else {
        todo_read_summary(cleaned_trim).unwrap_or_else(|| "TODO: Read plan".to_string())
    };
    let mut lines = vec![summary_line(
        icon,
        truncate_line(&header, MAX_HEADER_LENGTH),
        kind,
    )];
    if !error && !cleaned_trim.is_empty() {
        lines.extend(todo_read_detail_lines(cleaned_trim));
    }
    Some(lines)
}
