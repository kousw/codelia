use crate::app::state::{LogKind, LogLine, LogTone};
use std::path::Path;

pub(super) const DETAIL_INDENT: &str = "  ";

pub(super) fn split_lines(value: &str) -> Vec<String> {
    value
        .split('\n')
        .map(|line| line.trim_end_matches('\r').to_string())
        .collect()
}

pub(super) fn truncate_line(text: &str, max: usize) -> String {
    if max == 0 {
        return String::new();
    }
    let count = text.chars().count();
    if count <= max {
        return text.to_string();
    }
    let take = max.saturating_sub(3);
    let truncated: String = text.chars().take(take).collect();
    format!("{truncated}...")
}

pub(super) fn short_id(value: &str) -> String {
    value.chars().take(8).collect()
}

pub(super) fn relative_or_basename(path: &str) -> String {
    let path_obj = Path::new(path);
    if !path_obj.is_absolute() {
        return path.replace('\\', "/");
    }
    if let Ok(cwd) = std::env::current_dir() {
        if let Ok(relative) = path_obj.strip_prefix(&cwd) {
            return relative.to_string_lossy().replace('\\', "/");
        }
    }
    path_obj
        .file_name()
        .and_then(|name| name.to_str())
        .unwrap_or(path)
        .to_string()
}

fn replace_marker(mut text: String, marker: &str, replacement: &str) -> String {
    loop {
        let start = match text.find(marker) {
            Some(value) => value,
            None => return text,
        };
        let end = match text[start..].find(']') {
            Some(value) => start + value,
            None => return text,
        };
        text.replace_range(start..=end, replacement);
    }
}

pub(super) fn redact_ref_markers(text: &str) -> String {
    let mut output = String::new();
    for line in split_lines(text) {
        if line.starts_with("ref:") {
            continue;
        }
        let mut cleaned = line.to_string();
        if cleaned.contains("[tool output truncated; ref=") {
            cleaned = replace_marker(
                cleaned,
                "[tool output truncated; ref=",
                "[tool output truncated]",
            );
        }
        if cleaned.contains("[tool output trimmed; ref=") {
            cleaned = replace_marker(
                cleaned,
                "[tool output trimmed; ref=",
                "[tool output trimmed]",
            );
        }
        output.push_str(&cleaned);
        output.push('\n');
    }
    output.trim_end_matches('\n').to_string()
}

pub(super) fn detail_line(kind: LogKind, text: impl Into<String>) -> LogLine {
    LogLine::new_with_tone(kind, LogTone::Detail, text)
}

pub(super) fn summary_line(icon: &str, label: impl AsRef<str>, kind: LogKind) -> LogLine {
    let label = label.as_ref();
    let text = if label.is_empty() {
        icon.to_string()
    } else if icon.is_empty() {
        label.to_string()
    } else {
        format!("{icon} {label}")
    };
    LogLine::new(kind, text)
}
