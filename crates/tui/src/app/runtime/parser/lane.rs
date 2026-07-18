use crate::app::state::{LogKind, LogLine};
use serde_json::Value;

use super::common::{detail_line, relative_or_basename, short_id, summary_line, DETAIL_INDENT};

fn lane_summary_status(lane: &Value) -> String {
    lane.get("state")
        .and_then(|value| value.as_str())
        .unwrap_or("unknown")
        .to_string()
}

fn lane_details_lines(
    lane: &Value,
    hints: Option<&Value>,
    backend_alive: Option<bool>,
) -> Vec<String> {
    let mut details = Vec::new();
    let lane_id = lane
        .get("lane_id")
        .and_then(|value| value.as_str())
        .unwrap_or("");
    if !lane_id.is_empty() {
        details.push(format!("lane: {}", short_id(lane_id)));
    }
    if let Some(task_id) = lane.get("task_id").and_then(|value| value.as_str()) {
        if !task_id.is_empty() {
            details.push(format!("task: {task_id}"));
        }
    }
    let state = lane_summary_status(lane);
    if let Some(alive) = backend_alive {
        let alive_text = if alive { "alive" } else { "stopped" };
        details.push(format!("state: {state} ({alive_text})"));
    } else {
        details.push(format!("state: {state}"));
    }
    if let Some(path) = lane.get("worktree_path").and_then(|value| value.as_str()) {
        if !path.is_empty() {
            details.push(format!("worktree: {}", relative_or_basename(path)));
        }
    }
    if let Some(hints_obj) = hints.and_then(|value| value.as_object()) {
        if let Some(attach) = hints_obj
            .get("attach_command")
            .and_then(|value| value.as_str())
            .filter(|value| !value.trim().is_empty())
        {
            details.push(format!("attach: {attach}"));
        }
    }
    details
}

fn lane_list_counts(lines: &[Value]) -> (usize, usize, usize, usize) {
    let mut creating = 0usize;
    let mut running = 0usize;
    let mut finished_like = 0usize;
    let mut closed = 0usize;
    for lane in lines {
        let state = lane
            .get("state")
            .and_then(|value| value.as_str())
            .unwrap_or("unknown");
        match state {
            "creating" => creating += 1,
            "running" => running += 1,
            "finished" | "error" => finished_like += 1,
            "closed" => closed += 1,
            _ => {}
        }
    }
    (creating, running, finished_like, closed)
}

pub(super) fn tool_result_lines(
    tool: &str,
    raw: &str,
    icon: &str,
    kind: LogKind,
    error: bool,
) -> Option<Vec<LogLine>> {
    if !matches!(
        tool,
        "lane_create" | "lane_status" | "lane_close" | "lane_list" | "lane_gc"
    ) {
        return None;
    }
    let parsed = serde_json::from_str::<Value>(raw).ok()?;
    let mut lines = Vec::new();

    if error {
        lines.push(summary_line(icon, format!("{tool} failed"), kind));
        if let Some(message) = parsed.get("message").and_then(|value| value.as_str()) {
            lines.push(detail_line(kind, format!("{DETAIL_INDENT}{message}")));
        }
        return Some(lines);
    }

    match tool {
        "lane_create" => {
            let lane = parsed.get("lane")?;
            lines.push(summary_line(icon, "lane created", kind));
            let details = lane_details_lines(lane, parsed.get("hints"), None);
            for detail in details {
                lines.push(detail_line(kind, format!("{DETAIL_INDENT}{detail}")));
            }
        }
        "lane_status" => {
            let lane = parsed.get("lane")?;
            let state = lane_summary_status(lane);
            lines.push(summary_line(icon, format!("lane status: {state}"), kind));
            let backend_alive = parsed
                .get("backend_alive")
                .and_then(|value| value.as_bool());
            let details = lane_details_lines(lane, parsed.get("hints"), backend_alive);
            for detail in details {
                lines.push(detail_line(kind, format!("{DETAIL_INDENT}{detail}")));
            }
        }
        "lane_close" => {
            let lane = parsed.get("lane")?;
            lines.push(summary_line(icon, "lane closed", kind));
            let details = lane_details_lines(lane, parsed.get("hints"), None);
            for detail in details {
                lines.push(detail_line(kind, format!("{DETAIL_INDENT}{detail}")));
            }
        }
        "lane_list" => {
            let lanes = parsed
                .get("lanes")
                .and_then(|value| value.as_array())
                .cloned()
                .unwrap_or_default();
            let count = lanes.len();
            lines.push(summary_line(icon, format!("lanes: {count}"), kind));
            let (creating, running, finished_like, closed) = lane_list_counts(&lanes);
            lines.push(detail_line(
                kind,
                format!(
                    "{DETAIL_INDENT}creating={creating} running={running} finished/error={finished_like} closed={closed}"
                ),
            ));
        }
        "lane_gc" => {
            let checked = parsed
                .get("checked")
                .and_then(|value| value.as_u64())
                .unwrap_or(0);
            let closed = parsed
                .get("closed")
                .and_then(|value| value.as_u64())
                .unwrap_or(0);
            let skipped = parsed
                .get("skipped")
                .and_then(|value| value.as_u64())
                .unwrap_or(0);
            lines.push(summary_line(icon, "lane gc", kind));
            lines.push(detail_line(
                kind,
                format!("{DETAIL_INDENT}checked={checked} closed={closed} skipped={skipped}"),
            ));
            if let Some(errors) = parsed.get("errors").and_then(|value| value.as_array()) {
                if !errors.is_empty() {
                    lines.push(detail_line(
                        kind,
                        format!("{DETAIL_INDENT}errors={}", errors.len()),
                    ));
                }
            }
        }
        _ => return None,
    }

    Some(lines)
}
