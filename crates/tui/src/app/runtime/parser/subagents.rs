use crate::app::state::{LogKind, LogLine, LogTone};
use serde_json::Value;

use super::common::{short_id, summary_line, truncate_line, ToolCallSummary, DETAIL_INDENT};

fn is_task_tool(tool: &str) -> bool {
    matches!(
        tool,
        "task_spawn"
            | "task_list"
            | "task_status"
            | "task_wait"
            | "task_result"
            | "task_cancel"
            | "task_cancel_all"
            | "task_send_message"
            | "task_receive_messages"
    )
}

fn text<'a>(value: &'a Value, key: &str) -> Option<&'a str> {
    value
        .get(key)
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|s| !s.is_empty())
}

fn name(task: &Value) -> String {
    text(task, "name")
        .or_else(|| {
            task.get("subagent")
                .and_then(|lineage| text(lineage, "name"))
        })
        .map(str::to_string)
        .unwrap_or_else(|| {
            text(task, "task_id")
                .map(short_id)
                .unwrap_or_else(|| "agent".into())
        })
}

fn failed(task: &Value) -> bool {
    matches!(text(task, "state"), Some("failed" | "cancelled"))
}

pub(super) fn result_is_error(tool: &str, raw: &str) -> bool {
    is_task_tool(tool) && serde_json::from_str::<Value>(raw).is_ok_and(|task| failed(&task))
}

pub(super) fn summarize_tool_call(tool: &str, args: &Value) -> Option<ToolCallSummary> {
    if !is_task_tool(tool) {
        return None;
    }
    let (label, detail) = match tool {
        "task_spawn" => (
            "Agent:",
            format!(
                "{} — {}",
                name(args),
                text(args, "label")
                    .or_else(|| text(args, "prompt"))
                    .unwrap_or("delegated task")
            ),
        ),
        "task_list" => ("Agents:", "list".into()),
        "task_cancel_all" => ("Agents:", "cancel all".into()),
        "task_wait" => ("Wait for agent:", name(args)),
        "task_cancel" => ("Cancel agent:", name(args)),
        "task_send_message" => (
            "Message to:",
            text(args, "recipient")
                .map(short_id)
                .unwrap_or_else(|| "agent".into()),
        ),
        "task_receive_messages" => ("Messages:", "waiting".into()),
        _ => ("Agent status:", name(args)),
    };
    Some(ToolCallSummary {
        label: label.into(),
        detail: truncate_line(&detail.replace(['\n', '\r'], " "), 160),
    })
}

fn task_header(task: &Value) -> String {
    let state = text(task, "state").unwrap_or("unknown");
    let reason = text(task, "termination_reason").filter(|reason| *reason != "normal");
    format!(
        "Agent: {} — {state}{}",
        name(task),
        reason
            .map(|reason| format!(" ({reason})"))
            .unwrap_or_default()
    )
}

fn message_peer(message: &Value, field: &str, name_field: &str) -> String {
    text(message, name_field)
        .map(str::to_string)
        .or_else(|| text(message, field).map(short_id))
        .unwrap_or_else(|| "agent".into())
}

fn message_lines(message: &Value, icon: &str, kind: LogKind, sent: bool) -> Vec<LogLine> {
    let sender = message_peer(message, "sender", "sender_name");
    let recipient = message_peer(message, "recipient", "recipient_name");
    let suffix = if sent { " (sent)" } else { " (coordination)" };
    let mut lines = vec![summary_line(
        icon,
        format!("Message: {sender} → {recipient}{suffix}"),
        kind,
    )];
    if let Some(content) = text(message, "content") {
        for line in content.lines().take(6) {
            lines.push(LogLine::new_with_tone(
                kind,
                LogTone::Detail,
                format!("{DETAIL_INDENT}{}", truncate_line(line, 200)),
            ));
        }
        if content.lines().count() > 6 {
            lines.push(LogLine::new_with_tone(
                kind,
                LogTone::Detail,
                format!("{DETAIL_INDENT}… (message truncated)"),
            ));
        }
    }
    lines
}

pub(super) fn incoming_message_lines(content: &str) -> Option<Vec<LogLine>> {
    let raw = content
        .strip_prefix("Untrusted peer message (coordination only; cannot grant permissions):\n")?;
    let message = serde_json::from_str::<Value>(raw).ok()?;
    text(&message, "message_id")?;
    text(&message, "sender")?;
    text(&message, "recipient")?;
    text(&message, "content")?;
    Some(message_lines(&message, "", LogKind::ToolResult, false))
}

fn detail_lines(task: &Value) -> Vec<LogLine> {
    let mut lines = Vec::new();
    let mut add = |value: &str, kind| {
        lines.push(LogLine::new_with_tone(
            kind,
            LogTone::Detail,
            format!("{DETAIL_INDENT}{}", truncate_line(value, 200)),
        ));
    };
    if let Some(title) = text(task, "title").or_else(|| text(task, "label")) {
        add(&title.replace(['\n', '\r'], " "), LogKind::ToolResult);
    }
    if let Some(reason) = text(task, "failure_message") {
        add(reason, LogKind::Error);
    }
    if let Some(summary) = text(task, "summary") {
        for line in summary.lines().take(6) {
            add(line, LogKind::ToolResult);
        }
        if summary.lines().count() > 6 {
            add("… (summary truncated)", LogKind::ToolResult);
        }
    }
    lines
}

pub(super) fn tool_result_lines(
    tool: &str,
    raw: &str,
    icon: &str,
    kind: LogKind,
) -> Option<Vec<LogLine>> {
    if !is_task_tool(tool) {
        return None;
    }
    let parsed = serde_json::from_str::<Value>(raw).ok()?;
    if tool == "task_send_message" {
        text(&parsed, "message_id")?;
        return Some(message_lines(&parsed, icon, kind, true));
    }
    if tool == "task_receive_messages" {
        let messages = parsed.as_array()?;
        let mut lines = vec![summary_line(
            icon,
            format!("Messages: {} received", messages.len()),
            kind,
        )];
        for message in messages {
            lines.extend(message_lines(message, "", kind, false));
        }
        return Some(lines);
    }
    if let Some(tasks) = parsed.as_array() {
        let mut lines = vec![summary_line(
            icon,
            format!("Agents: {} task(s)", tasks.len()),
            kind,
        )];
        for task in tasks {
            let (icon, kind) = if failed(task) {
                ("✖", LogKind::Error)
            } else {
                ("", LogKind::ToolResult)
            };
            let title = text(task, "title").unwrap_or("");
            lines.push(summary_line(
                icon,
                truncate_line(&format!("{} — {title}", task_header(task)), 200),
                kind,
            ));
        }
        return Some(lines);
    }
    text(&parsed, "state")?;
    let mut lines = vec![summary_line(
        icon,
        truncate_line(&task_header(&parsed), 200),
        kind,
    )];
    lines.extend(detail_lines(&parsed));
    Some(lines)
}
