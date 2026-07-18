use crate::app::state::{LogKind, LogLine};
use serde_json::Value;

use super::common::{
    detail_line, relative_or_basename, summary_line, truncate_line, DETAIL_INDENT,
};

const MAX_HEADER_LENGTH: usize = 200;

pub(super) fn tool_result_lines(
    tool: &str,
    raw: &str,
    icon: &str,
    kind: LogKind,
    error: bool,
) -> Option<Vec<LogLine>> {
    if tool != "agents_resolve" {
        return None;
    }

    if error {
        let mut lines = vec![summary_line(icon, "AgentsResolve failed", kind)];
        let message = serde_json::from_str::<Value>(raw)
            .ok()
            .and_then(|value| {
                value
                    .get("message")
                    .and_then(|value| value.as_str())
                    .map(str::to_string)
            })
            .unwrap_or_else(|| raw.trim().to_string());
        if !message.is_empty() {
            lines.push(detail_line(
                kind,
                format!(
                    "{DETAIL_INDENT}{}",
                    truncate_line(message.trim(), MAX_HEADER_LENGTH)
                ),
            ));
        }
        return Some(lines);
    }

    let parsed = serde_json::from_str::<Value>(raw).ok()?;
    let files = parsed
        .get("files")
        .and_then(|value| value.as_array())
        .cloned()
        .unwrap_or_default();
    let count = parsed
        .get("count")
        .and_then(|value| value.as_u64())
        .unwrap_or(files.len() as u64);

    let mut lines = vec![summary_line(
        icon,
        format!("AgentsResolve: {count} file(s)"),
        kind,
    )];

    if let Some(path) = parsed
        .get("target_path")
        .and_then(|value| value.as_str())
        .or_else(|| parsed.get("resolved_path").and_then(|value| value.as_str()))
        .filter(|value| !value.trim().is_empty())
    {
        lines.push(detail_line(
            kind,
            format!(
                "{DETAIL_INDENT}target: {}",
                truncate_line(&relative_or_basename(path), MAX_HEADER_LENGTH)
            ),
        ));
    }

    if files.is_empty() {
        lines.push(detail_line(
            kind,
            format!("{DETAIL_INDENT}no AGENTS.md changes"),
        ));
        return Some(lines);
    }

    for file in files {
        let Some(path) = file.get("path").and_then(|value| value.as_str()) else {
            continue;
        };
        let reason = file
            .get("reason")
            .and_then(|value| value.as_str())
            .unwrap_or("unknown");
        lines.push(detail_line(
            kind,
            format!(
                "{DETAIL_INDENT}AGENTS: {} ({reason})",
                truncate_line(&relative_or_basename(path), MAX_HEADER_LENGTH)
            ),
        ));
    }

    Some(lines)
}
