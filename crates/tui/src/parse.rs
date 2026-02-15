use crate::markdown::render_markdown_lines;
use crate::model::{LogKind, LogLine, LogSpan, LogTone};
use serde_json::Value;
use similar::{ChangeTag, TextDiff};
use std::path::Path;

pub struct ParsedOutput {
    pub lines: Vec<LogLine>,
    pub status: Option<String>,
    pub status_run_id: Option<String>,
    pub context_left_percent: Option<u8>,
    pub assistant_text: Option<String>,
    pub final_text: Option<String>,
    pub rpc_response: Option<RpcResponse>,
    pub confirm_request: Option<UiConfirmRequest>,
    pub prompt_request: Option<UiPromptRequest>,
    pub pick_request: Option<UiPickRequest>,
    pub tool_call_start_id: Option<String>,
    pub tool_call_result: Option<ToolCallResultUpdate>,
}

pub struct ToolCallResultUpdate {
    pub tool_call_id: String,
    pub is_error: bool,
    pub fallback_summary: LogLine,
}

impl ParsedOutput {
    fn empty() -> Self {
        Self {
            lines: Vec::new(),
            status: None,
            status_run_id: None,
            context_left_percent: None,
            assistant_text: None,
            final_text: None,
            rpc_response: None,
            confirm_request: None,
            prompt_request: None,
            pick_request: None,
            tool_call_start_id: None,
            tool_call_result: None,
        }
    }
}

pub struct RpcResponse {
    pub id: String,
    pub result: Option<Value>,
    pub error: Option<Value>,
}

pub struct UiConfirmRequest {
    pub id: String,
    pub title: String,
    pub message: String,
    pub danger_level: Option<String>,
    pub confirm_label: Option<String>,
    pub cancel_label: Option<String>,
    pub allow_remember: bool,
    pub allow_reason: bool,
}

pub struct UiPromptRequest {
    pub id: String,
    pub title: String,
    pub message: String,
    pub default_value: Option<String>,
    pub multiline: bool,
    pub secret: bool,
}

pub struct UiPickItem {
    pub id: String,
    pub label: String,
    pub detail: Option<String>,
}

pub struct UiPickRequest {
    pub id: String,
    pub title: String,
    pub items: Vec<UiPickItem>,
    pub multi: bool,
}

fn split_lines(value: &str) -> Vec<String> {
    value
        .split('\n')
        .map(|line| line.trim_end_matches('\r').to_string())
        .collect()
}

const DETAIL_INDENT: &str = "  ";
const READ_PREVIEW_LINES: usize = 2;
const SKILL_LOAD_PREVIEW_LINES: usize = 3;
const BASH_ERROR_LINES: usize = 5;
const DEFAULT_PREVIEW_LINES: usize = 3;
const MAX_DIFF_LINES: usize = 200;
const MAX_ARG_LENGTH: usize = 160;
const MAX_HEADER_LENGTH: usize = 200;

fn truncate_line(text: &str, max: usize) -> String {
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

fn limit_lines(lines: Vec<String>, max: usize) -> (Vec<String>, bool) {
    if lines.len() <= max {
        return (lines, false);
    }
    (lines.into_iter().take(max).collect(), true)
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

fn redact_ref_markers(text: &str) -> String {
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

fn preview_lines(text: &str, max_lines: usize) -> (Vec<String>, bool) {
    let lines: Vec<String> = split_lines(text)
        .into_iter()
        .filter(|line| !line.trim().is_empty())
        .collect();
    limit_lines(lines, max_lines)
}

fn format_preview_text(lines: Vec<String>, truncated: bool) -> Option<String> {
    if lines.is_empty() {
        return None;
    }
    let mut output = lines;
    if truncated {
        output.push("...".to_string());
    }
    Some(output.join("\n"))
}

fn detail_line(kind: LogKind, text: impl Into<String>) -> LogLine {
    LogLine::new_with_tone(kind, LogTone::Detail, text)
}

fn format_line_number(value: Option<usize>) -> String {
    value.map_or_else(|| "    ".to_string(), |n| format!("{n:>4}"))
}

fn diff_content_line(kind: LogKind, marker: &str, text: &str, line_no: Option<usize>) -> LogLine {
    let number_prefix = format!("{DETAIL_INDENT}{} ", format_line_number(line_no));
    let content = format!("{marker}{text}");
    LogLine::new_with_spans(vec![
        LogSpan::new(kind, LogTone::Detail, ""),
        LogSpan::new(LogKind::DiffMeta, LogTone::Detail, number_prefix),
        LogSpan::new(kind, LogTone::Detail, content),
    ])
}

fn parse_hunk_start(line: &str) -> Option<(usize, usize)> {
    if !line.starts_with("@@") {
        return None;
    }
    let mut parts = line.split_whitespace();
    let _ = parts.next();
    let old_part = parts.next()?;
    let new_part = parts.next()?;

    let parse_start = |value: &str, prefix: char| -> Option<usize> {
        let rest = value.strip_prefix(prefix)?;
        let start = rest.split(',').next()?;
        start.parse::<usize>().ok()
    };

    Some((parse_start(old_part, '-')?, parse_start(new_part, '+')?))
}

fn render_edit_diff_lines(diff: &str) -> Vec<LogLine> {
    let mut rendered = Vec::new();
    let mut pending_removed: Vec<String> = Vec::new();
    let mut pending_added: Vec<String> = Vec::new();
    let mut old_line: Option<usize> = None;
    let mut new_line: Option<usize> = None;

    let flush_pending = |rendered: &mut Vec<LogLine>,
                         removed: &mut Vec<String>,
                         added: &mut Vec<String>,
                         old_line: &mut Option<usize>,
                         new_line: &mut Option<usize>| {
        if removed.is_empty() && added.is_empty() {
            return;
        }

        if !removed.is_empty() && !added.is_empty() {
            let before = format!("{}\n", removed.join("\n"));
            let after = format!("{}\n", added.join("\n"));
            let diff = TextDiff::from_lines(&before, &after);
            for change in diff.iter_all_changes() {
                let mut text = change.to_string();
                text = text
                    .trim_end_matches('\n')
                    .trim_end_matches('\r')
                    .to_string();
                match change.tag() {
                    ChangeTag::Delete => {
                        rendered.push(diff_content_line(
                            LogKind::DiffRemoved,
                            "-",
                            &text,
                            *old_line,
                        ));
                        *old_line = old_line.map(|n| n + 1);
                    }
                    ChangeTag::Insert => {
                        rendered.push(diff_content_line(LogKind::DiffAdded, "+", &text, *new_line));
                        *new_line = new_line.map(|n| n + 1);
                    }
                    ChangeTag::Equal => {
                        *old_line = old_line.map(|n| n + 1);
                        *new_line = new_line.map(|n| n + 1);
                    }
                }
            }
        } else {
            for line in removed.iter() {
                rendered.push(diff_content_line(
                    LogKind::DiffRemoved,
                    "-",
                    line,
                    *old_line,
                ));
                *old_line = old_line.map(|n| n + 1);
            }
            for line in added.iter() {
                rendered.push(diff_content_line(LogKind::DiffAdded, "+", line, *new_line));
                *new_line = new_line.map(|n| n + 1);
            }
        }

        removed.clear();
        added.clear();
    };

    for line in split_lines(diff) {
        if let Some(text) = line.strip_prefix('-') {
            if line.starts_with("--- ") {
                flush_pending(
                    &mut rendered,
                    &mut pending_removed,
                    &mut pending_added,
                    &mut old_line,
                    &mut new_line,
                );
            } else {
                pending_removed.push(text.to_string());
            }
            continue;
        }

        if let Some(text) = line.strip_prefix('+') {
            if line.starts_with("+++ ") {
                flush_pending(
                    &mut rendered,
                    &mut pending_removed,
                    &mut pending_added,
                    &mut old_line,
                    &mut new_line,
                );
            } else {
                pending_added.push(text.to_string());
            }
            continue;
        }

        flush_pending(
            &mut rendered,
            &mut pending_removed,
            &mut pending_added,
            &mut old_line,
            &mut new_line,
        );

        if line.starts_with("@@") {
            if let Some((old_start, new_start)) = parse_hunk_start(&line) {
                old_line = Some(old_start);
                new_line = Some(new_start);
            }
            continue;
        }

        if let Some(text) = line.strip_prefix(' ') {
            rendered.push(diff_content_line(LogKind::DiffContext, " ", text, new_line));
            old_line = old_line.map(|n| n + 1);
            new_line = new_line.map(|n| n + 1);
            continue;
        }

        rendered.push(detail_line(
            LogKind::DiffMeta,
            format!("{DETAIL_INDENT}{line}"),
        ));
    }

    flush_pending(
        &mut rendered,
        &mut pending_removed,
        &mut pending_added,
        &mut old_line,
        &mut new_line,
    );
    rendered
}

fn limited_edit_diff_lines(diff: &str, max_lines: usize) -> (Vec<LogLine>, bool) {
    let mut lines = render_edit_diff_lines(diff);
    if lines.len() <= max_lines {
        return (lines, false);
    }
    lines.truncate(max_lines);
    (lines, true)
}

fn parse_planned_diff_preview(content: &str) -> Option<(String, String)> {
    let mut lines = content.lines();
    let first = lines.next()?.trim();
    let prefix = "Planned ";
    let suffix = " diff preview:";
    if !first.starts_with(prefix) || !first.ends_with(suffix) {
        return None;
    }
    let tool = first[prefix.len()..first.len().saturating_sub(suffix.len())].trim();
    if tool.is_empty() {
        return None;
    }
    let preview = lines.collect::<Vec<_>>().join("\n");
    Some((tool.to_string(), preview))
}

fn parse_permission_preflight_ready(content: &str) -> Option<String> {
    let line = content.trim();
    let prefix = "Permission preflight ready for ";
    let Some(rest) = line.strip_prefix(prefix) else {
        return None;
    };
    let tool = rest.strip_suffix('.').unwrap_or(rest).trim();
    if tool.is_empty() {
        return None;
    }
    Some(tool.to_string())
}

fn looks_like_unified_diff(value: &str) -> bool {
    let mut has_old_header = false;
    let mut has_new_header = false;
    let mut has_hunk = false;
    for line in split_lines(value) {
        if line.starts_with("--- ") {
            has_old_header = true;
        } else if line.starts_with("+++ ") {
            has_new_header = true;
        } else if line.starts_with("@@") {
            has_hunk = true;
        }
    }
    (has_old_header && has_new_header) || has_hunk
}

fn planned_diff_preview_lines(tool: &str, preview: &str) -> Vec<LogLine> {
    let mut lines = vec![
        LogLine::new(LogKind::Space, ""),
        summary_line(
            "",
            format!("Proposed {tool} changes (preview)"),
            LogKind::Status,
        ),
    ];
    if preview.trim().is_empty() {
        lines.push(detail_line(
            LogKind::DiffMeta,
            format!("{DETAIL_INDENT}Preview: no diff content"),
        ));
        return lines;
    }
    if looks_like_unified_diff(preview) {
        let (mut diff_lines, truncated) = limited_edit_diff_lines(preview, MAX_DIFF_LINES);
        if truncated {
            diff_lines.push(detail_line(
                LogKind::DiffMeta,
                format!("{DETAIL_INDENT}..."),
            ));
        }
        lines.append(&mut diff_lines);
        return lines;
    }

    let mut body = prefix_block(
        DETAIL_INDENT,
        DETAIL_INDENT,
        LogKind::DiffMeta,
        LogTone::Detail,
        preview,
    );
    lines.append(&mut body);
    lines
}

fn permission_preflight_ready_lines(tool: &str) -> Vec<LogLine> {
    vec![
        LogLine::new(LogKind::Space, ""),
        summary_line(
            "",
            format!("Review {tool} changes, then choose Allow or Deny"),
            LogKind::Status,
        ),
    ]
}

struct ToolCallSummary {
    label: String,
    detail: String,
}

fn is_builtin_tool(tool: &str) -> bool {
    matches!(
        tool,
        "read"
            | "write"
            | "edit"
            | "bash"
            | "agents_resolve"
            | "glob_search"
            | "grep"
            | "todo_read"
            | "todo_write"
            | "done"
            | "skill_search"
            | "skill_load"
            | "tool_output_cache"
            | "tool_output_cache_grep"
            | "lane_create"
            | "lane_list"
            | "lane_status"
            | "lane_close"
            | "lane_gc"
    )
}

fn tool_display_name(tool: &str) -> String {
    if is_builtin_tool(tool) {
        match tool {
            "agents_resolve" => "AgentsResolve".to_string(),
            "glob_search" => "GlobSearch".to_string(),
            "todo_read" => "TodoRead".to_string(),
            "todo_write" => "TodoWrite".to_string(),
            "skill_search" => "SkillSearch".to_string(),
            "skill_load" => "SkillLoad".to_string(),
            "tool_output_cache" => "ToolOutputCache".to_string(),
            "tool_output_cache_grep" => "ToolOutputCacheGrep".to_string(),
            "lane_create" => "LaneCreate".to_string(),
            "lane_list" => "LaneList".to_string(),
            "lane_status" => "LaneStatus".to_string(),
            "lane_close" => "LaneClose".to_string(),
            "lane_gc" => "LaneGc".to_string(),
            _ => {
                let mut chars = tool.chars();
                if let Some(first) = chars.next() {
                    format!("{}{}", first.to_uppercase(), chars.as_str())
                } else {
                    tool.to_string()
                }
            }
        }
    } else {
        tool.to_string()
    }
}

fn relative_or_basename(path: &str) -> String {
    let path_obj = Path::new(path);
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

fn summarize_tool_call(tool: &str, args: &Value) -> ToolCallSummary {
    let obj = args.as_object();
    if tool == "lane_create" {
        let task_id = obj
            .and_then(|value| value.get("task_id"))
            .and_then(|value| value.as_str())
            .unwrap_or("(no task)");
        let backend = obj
            .and_then(|value| value.get("mux_backend"))
            .and_then(|value| value.as_str())
            .unwrap_or("tmux");
        let has_seed = obj
            .and_then(|value| value.get("seed_context"))
            .and_then(|value| value.as_str())
            .map(|value| !value.trim().is_empty())
            .unwrap_or(false);
        let seed_suffix = if has_seed { " +seed" } else { "" };
        return ToolCallSummary {
            label: "LaneCreate:".to_string(),
            detail: format!("task={task_id} backend={backend}{seed_suffix}"),
        };
    }
    if tool == "lane_status" {
        let lane_id = obj
            .and_then(|value| value.get("lane_id"))
            .and_then(|value| value.as_str())
            .unwrap_or("");
        return ToolCallSummary {
            label: "LaneStatus:".to_string(),
            detail: format!("lane={}", short_id(lane_id)),
        };
    }
    if tool == "lane_close" {
        let lane_id = obj
            .and_then(|value| value.get("lane_id"))
            .and_then(|value| value.as_str())
            .unwrap_or("");
        return ToolCallSummary {
            label: "LaneClose:".to_string(),
            detail: format!("lane={}", short_id(lane_id)),
        };
    }
    if tool == "lane_list" {
        return ToolCallSummary {
            label: "LaneList:".to_string(),
            detail: String::new(),
        };
    }
    if tool == "lane_gc" {
        let ttl = obj
            .and_then(|value| value.get("idle_ttl_minutes"))
            .and_then(|value| value.as_u64())
            .map(|value| value.to_string())
            .unwrap_or_else(|| "?".to_string());
        return ToolCallSummary {
            label: "LaneGc:".to_string(),
            detail: format!("ttl={ttl}m"),
        };
    }
    if tool == "read" {
        let path = obj
            .and_then(|value| value.get("file_path"))
            .and_then(|value| value.as_str())
            .unwrap_or("");
        let file_name = path.split('/').last().unwrap_or("");
        let mut parts = Vec::new();
        if let Some(offset) = obj
            .and_then(|value| value.get("offset"))
            .and_then(|value| value.as_i64())
        {
            parts.push(format!("offset={offset}"));
        }
        if let Some(limit) = obj
            .and_then(|value| value.get("limit"))
            .and_then(|value| value.as_i64())
        {
            parts.push(format!("limit={limit}"));
        }
        let detail = if parts.is_empty() {
            file_name.to_string()
        } else {
            format!("{file_name} ({})", parts.join(", "))
        };
        return ToolCallSummary {
            label: "Read:".to_string(),
            detail,
        };
    }
    if tool == "write" || tool == "edit" {
        let label = if tool == "write" { "Write:" } else { "Edit:" };
        let path = obj
            .and_then(|value| value.get("file_path"))
            .and_then(|value| value.as_str())
            .unwrap_or("");
        let file_name = path.split('/').last().unwrap_or("");
        return ToolCallSummary {
            label: label.to_string(),
            detail: file_name.to_string(),
        };
    }
    if tool == "bash" {
        let command = obj
            .and_then(|value| value.get("command"))
            .and_then(|value| value.as_str())
            .unwrap_or("");
        return ToolCallSummary {
            label: "Bash:".to_string(),
            detail: truncate_line(command, MAX_ARG_LENGTH),
        };
    }
    if tool == "grep" {
        let path = obj
            .and_then(|value| value.get("path"))
            .and_then(|value| value.as_str())
            .unwrap_or("");
        let pattern = obj
            .and_then(|value| value.get("pattern"))
            .and_then(|value| value.as_str())
            .unwrap_or("");
        let path_display = relative_or_basename(path);
        let detail = if pattern.is_empty() {
            path_display
        } else {
            format!(
                "{path_display} pattern={}",
                truncate_line(pattern, MAX_ARG_LENGTH)
            )
        };
        return ToolCallSummary {
            label: "Grep:".to_string(),
            detail,
        };
    }
    if tool == "skill_load" {
        let name = obj
            .and_then(|value| value.get("name"))
            .and_then(|value| value.as_str())
            .unwrap_or("");
        return ToolCallSummary {
            label: "SkillLoad:".to_string(),
            detail: name.to_string(),
        };
    }
    if tool == "tool_output_cache_grep" {
        let pattern = obj
            .and_then(|value| value.get("pattern"))
            .and_then(|value| value.as_str())
            .unwrap_or("");
        return ToolCallSummary {
            label: "Tool Output Cache Grep:".to_string(),
            detail: truncate_line(pattern, MAX_ARG_LENGTH),
        };
    }
    if tool == "tool_output_cache" {
        return ToolCallSummary {
            label: "Tool Output Cache:".to_string(),
            detail: String::new(),
        };
    }
    let args_text = if let Some(text) = args.as_str() {
        text.to_string()
    } else {
        args.to_string()
    };
    ToolCallSummary {
        label: format!("{}:", tool_display_name(tool)),
        detail: truncate_line(&args_text, MAX_ARG_LENGTH),
    }
}

fn short_id(value: &str) -> String {
    value.chars().take(8).collect()
}

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

fn lane_tool_result_lines(
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
            lines.push(LogLine::new_with_tone(
                kind,
                LogTone::Detail,
                format!("{DETAIL_INDENT}{message}"),
            ));
        }
        return Some(lines);
    }

    match tool {
        "lane_create" => {
            let lane = parsed.get("lane")?;
            lines.push(summary_line(icon, "lane created", kind));
            let details = lane_details_lines(lane, parsed.get("hints"), None);
            for detail in details {
                lines.push(LogLine::new_with_tone(
                    kind,
                    LogTone::Detail,
                    format!("{DETAIL_INDENT}{detail}"),
                ));
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
                lines.push(LogLine::new_with_tone(
                    kind,
                    LogTone::Detail,
                    format!("{DETAIL_INDENT}{detail}"),
                ));
            }
        }
        "lane_close" => {
            let lane = parsed.get("lane")?;
            lines.push(summary_line(icon, "lane closed", kind));
            let details = lane_details_lines(lane, parsed.get("hints"), None);
            for detail in details {
                lines.push(LogLine::new_with_tone(
                    kind,
                    LogTone::Detail,
                    format!("{DETAIL_INDENT}{detail}"),
                ));
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
            lines.push(LogLine::new_with_tone(
                kind,
                LogTone::Detail,
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
            lines.push(LogLine::new_with_tone(
                kind,
                LogTone::Detail,
                format!("{DETAIL_INDENT}checked={checked} closed={closed} skipped={skipped}"),
            ));
            if let Some(errors) = parsed.get("errors").and_then(|value| value.as_array()) {
                if !errors.is_empty() {
                    lines.push(LogLine::new_with_tone(
                        kind,
                        LogTone::Detail,
                        format!("{DETAIL_INDENT}errors={}", errors.len()),
                    ));
                }
            }
        }
        _ => return None,
    }

    Some(lines)
}

fn looks_like_error(tool: &str, text: &str, is_error: bool) -> bool {
    if is_error {
        return true;
    }
    let lower = text.to_lowercase();
    if lower.starts_with("error:") {
        return true;
    }
    if lower.starts_with("security error") {
        return true;
    }
    if lower.starts_with("command timed out") {
        return true;
    }
    if tool == "read" {
        return lower.starts_with("file not found")
            || lower.starts_with("path is a directory")
            || lower.starts_with("offset exceeds")
            || lower.starts_with("error reading");
    }
    false
}

fn tool_result_lines(tool: &str, raw: &str, is_error: bool) -> Vec<LogLine> {
    let cleaned = redact_ref_markers(raw);
    let cleaned_trim = cleaned.trim();
    let error = looks_like_error(tool, cleaned_trim, is_error);
    let (icon, kind) = if error {
        ("✖", LogKind::Error)
    } else {
        ("✔", LogKind::ToolResult)
    };

    if let Some(lines) = lane_tool_result_lines(tool, raw, icon, kind, error) {
        return lines;
    }

    if tool == "edit" {
        if let Ok(parsed) = serde_json::from_str::<Value>(raw) {
            if let Some(summary) = parsed.get("summary").and_then(|value| value.as_str()) {
                let header = truncate_line(summary, MAX_HEADER_LENGTH);
                return vec![summary_line(icon, format!("edit {header}"), kind)];
            }
        }
    }

    if tool == "bash" {
        let header = if error { "Bash failed" } else { "Bash done" };
        let mut lines = vec![summary_line(icon, header, kind)];
        if !error || cleaned_trim.is_empty() || cleaned_trim == "(no output)" {
            return lines;
        }
        let (preview_lines, truncated) = preview_lines(cleaned_trim, BASH_ERROR_LINES);
        if let Some(preview) = format_preview_text(preview_lines, truncated) {
            let mut body = prefix_block(
                DETAIL_INDENT,
                DETAIL_INDENT,
                kind,
                LogTone::Detail,
                &preview,
            );
            lines.append(&mut body);
        }
        return lines;
    }

    if tool == "read" {
        let header = if error { "Read failed" } else { "Read done" };
        let mut lines = vec![summary_line(icon, header, kind)];
        if !error || cleaned_trim.is_empty() {
            return lines;
        }
        let (preview_lines, truncated) = preview_lines(cleaned_trim, READ_PREVIEW_LINES);
        if let Some(preview) = format_preview_text(preview_lines, truncated) {
            let mut body = prefix_block(
                DETAIL_INDENT,
                DETAIL_INDENT,
                kind,
                LogTone::Detail,
                &preview,
            );
            lines.append(&mut body);
        }
        return lines;
    }

    if tool == "skill_load" {
        let header = if error {
            "SkillLoad failed"
        } else {
            "SkillLoad done"
        };
        let mut lines = vec![summary_line(icon, header, kind)];
        if !error || cleaned_trim.is_empty() {
            return lines;
        }
        let (preview_lines, truncated) = preview_lines(cleaned_trim, SKILL_LOAD_PREVIEW_LINES);
        if let Some(preview) = format_preview_text(preview_lines, truncated) {
            let mut body = prefix_block(
                DETAIL_INDENT,
                DETAIL_INDENT,
                kind,
                LogTone::Detail,
                &preview,
            );
            lines.append(&mut body);
        }
        return lines;
    }

    if tool == "tool_output_cache_grep" {
        let match_count = split_lines(raw)
            .iter()
            .filter(|line| line.starts_with("ref:"))
            .count();
        let label = if cleaned_trim.starts_with("No matches for:") {
            truncate_line(cleaned_trim, MAX_HEADER_LENGTH)
        } else {
            format!("tool_output_cache_grep matches: {match_count}")
        };
        let mut lines = vec![summary_line(icon, label, kind)];
        if cleaned_trim.starts_with("No matches for:") {
            return lines;
        }
        let (preview_lines, truncated) = preview_lines(cleaned_trim, DEFAULT_PREVIEW_LINES);
        if let Some(preview) = format_preview_text(preview_lines, truncated) {
            let mut body = prefix_block(
                DETAIL_INDENT,
                DETAIL_INDENT,
                kind,
                LogTone::Detail,
                &preview,
            );
            lines.append(&mut body);
        }
        return lines;
    }

    if tool == "tool_output_cache" {
        let mut lines = vec![summary_line(icon, "tool_output_cache", kind)];
        if cleaned_trim.is_empty() {
            return lines;
        }
        let (preview_lines, truncated) = preview_lines(cleaned_trim, DEFAULT_PREVIEW_LINES);
        if let Some(preview) = format_preview_text(preview_lines, truncated) {
            let mut body = prefix_block(
                DETAIL_INDENT,
                DETAIL_INDENT,
                kind,
                LogTone::Detail,
                &preview,
            );
            lines.append(&mut body);
        }
        return lines;
    }

    let header = if !cleaned_trim.is_empty() {
        let first_line = split_lines(cleaned_trim)
            .first()
            .cloned()
            .unwrap_or_default();
        truncate_line(&first_line, MAX_HEADER_LENGTH)
    } else if error {
        "error".to_string()
    } else {
        "result".to_string()
    };
    let mut lines = vec![summary_line(icon, format!("{tool} {header}"), kind)];
    if cleaned_trim.is_empty() {
        return lines;
    }
    let (preview_lines, truncated) = preview_lines(cleaned_trim, DEFAULT_PREVIEW_LINES);
    if let Some(preview) = format_preview_text(preview_lines, truncated) {
        let mut body = prefix_block(
            DETAIL_INDENT,
            DETAIL_INDENT,
            kind,
            LogTone::Detail,
            &preview,
        );
        lines.append(&mut body);
    }
    lines
}

fn prefix_block(
    prefix: &str,
    indent: &str,
    kind: LogKind,
    tone: LogTone,
    content: &str,
) -> Vec<LogLine> {
    let lines = split_lines(content);
    if lines.is_empty() {
        return vec![LogLine::new_with_tone(
            kind,
            tone,
            prefix.trim_end().to_string(),
        )];
    }
    let mut out = Vec::new();
    for (idx, line) in lines.into_iter().enumerate() {
        let full = if idx == 0 {
            format!("{prefix}{line}")
        } else {
            format!("{indent}{line}")
        };
        out.push(LogLine::new_with_tone(kind, tone, full));
    }
    out
}

fn prefix_rendered(
    prefix: &str,
    indent: &str,
    rendered: Vec<LogLine>,
    tone: LogTone,
) -> Vec<LogLine> {
    let mut out = Vec::new();
    for (idx, line) in rendered.into_iter().enumerate() {
        let full = if idx == 0 {
            format!("{prefix}{}", line.plain_text())
        } else {
            format!("{indent}{}", line.plain_text())
        };
        out.push(LogLine::new_with_tone(line.kind(), tone, full));
    }
    out
}

fn summary_line(icon: &str, label: impl AsRef<str>, kind: LogKind) -> LogLine {
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

// icon + label + detailを1行で表示する。
fn summary_and_detail_line(
    icon: &str,
    label: &str,
    detail: &str,
    summary_kind: LogKind,
    detail_kind: LogKind,
) -> Vec<LogLine> {
    let mut spans = Vec::new();
    if !icon.is_empty() {
        spans.push(LogSpan::new(summary_kind, LogTone::Summary, icon));
        if !label.is_empty() || !detail.trim().is_empty() {
            spans.push(LogSpan::new(summary_kind, LogTone::Summary, " "));
        }
    }
    if !label.is_empty() {
        spans.push(LogSpan::new(summary_kind, LogTone::Summary, label));
    }
    if !detail.trim().is_empty() {
        if !label.is_empty() {
            spans.push(LogSpan::new(summary_kind, LogTone::Summary, " "));
        }
        spans.push(LogSpan::new(detail_kind, LogTone::Detail, detail.trim()));
    }

    if spans.is_empty() {
        vec![LogLine::new(summary_kind, "")]
    } else {
        vec![LogLine::new_with_spans(spans)]
    }
}

fn looks_like_runtime_error(body: &str) -> bool {
    let lower = body.to_ascii_lowercase();
    lower.starts_with("error:")
        || lower.contains("panic")
        || lower.contains("exception")
        || lower.contains("traceback")
        || lower.contains("fatal")
        || lower.contains("segmentation fault")
        || lower.contains("cannot find module")
        || lower.contains("module_not_found")
        || lower.contains("enoent")
        || lower.contains("eacces")
        || lower.contains("syntaxerror")
        || lower.contains("typeerror")
        || lower.contains("referenceerror")
}

fn parse_runtime_log_line(trimmed: &str) -> Option<LogLine> {
    if !trimmed.starts_with("[runtime]") {
        return None;
    }
    let body = trimmed
        .strip_prefix("[runtime]")
        .map(str::trim_start)
        .unwrap_or(trimmed);
    if body.starts_with("mcp:") || body.contains("mcp[") {
        let lower = body.to_lowercase();
        let kind = if lower.contains("error") || lower.contains("failed") {
            LogKind::Error
        } else {
            LogKind::Status
        };
        return Some(summary_line("", body, kind));
    }
    if looks_like_runtime_error(body) {
        return Some(summary_line("", body, LogKind::Error));
    }
    None
}

pub fn parse_runtime_output(raw: &str) -> ParsedOutput {
    let trimmed = raw.trim_end();
    if trimmed.is_empty() {
        return ParsedOutput::empty();
    }

    if let Some(line) = parse_runtime_log_line(trimmed) {
        return ParsedOutput {
            lines: vec![line],
            ..ParsedOutput::empty()
        };
    }

    if trimmed.starts_with("[runtime]") {
        return ParsedOutput {
            lines: vec![LogLine::new(LogKind::Runtime, trimmed.to_string())],
            ..ParsedOutput::empty()
        };
    }

    let parsed: Result<Value, _> = serde_json::from_str(trimmed);
    let value = match parsed {
        Ok(value) => value,
        Err(_) => {
            return ParsedOutput {
                lines: vec![LogLine::new(LogKind::Runtime, trimmed.to_string())],
                ..ParsedOutput::empty()
            };
        }
    };

    if let Some(method) = value.get("method").and_then(|m| m.as_str()) {
        if method == "ui.confirm.request" {
            let id = value
                .get("id")
                .and_then(|v| v.as_str())
                .unwrap_or("")
                .to_string();
            let params = value.get("params").and_then(|v| v.as_object());
            let title = params
                .and_then(|p| p.get("title"))
                .and_then(|v| v.as_str())
                .unwrap_or("Confirm")
                .to_string();
            let message = params
                .and_then(|p| p.get("message"))
                .and_then(|v| v.as_str())
                .unwrap_or("")
                .to_string();
            let danger_level = params
                .and_then(|p| p.get("danger_level"))
                .and_then(|v| v.as_str())
                .map(|v| v.to_string());
            let confirm_label = params
                .and_then(|p| p.get("confirm_label"))
                .and_then(|v| v.as_str())
                .map(|v| v.to_string());
            let cancel_label = params
                .and_then(|p| p.get("cancel_label"))
                .and_then(|v| v.as_str())
                .map(|v| v.to_string());
            let allow_remember = params
                .and_then(|p| p.get("allow_remember"))
                .and_then(|v| v.as_bool())
                .unwrap_or(false);
            let allow_reason = params
                .and_then(|p| p.get("allow_reason"))
                .and_then(|v| v.as_bool())
                .unwrap_or(false);
            return ParsedOutput {
                confirm_request: Some(UiConfirmRequest {
                    id,
                    title,
                    message,
                    danger_level,
                    confirm_label,
                    cancel_label,
                    allow_remember,
                    allow_reason,
                }),
                ..ParsedOutput::empty()
            };
        }

        if method == "ui.prompt.request" {
            let id = value
                .get("id")
                .and_then(|v| v.as_str())
                .unwrap_or("")
                .to_string();
            let params = value.get("params").and_then(|v| v.as_object());
            let title = params
                .and_then(|p| p.get("title"))
                .and_then(|v| v.as_str())
                .unwrap_or("Prompt")
                .to_string();
            let message = params
                .and_then(|p| p.get("message"))
                .and_then(|v| v.as_str())
                .unwrap_or("")
                .to_string();
            let default_value = params
                .and_then(|p| p.get("default_value"))
                .and_then(|v| v.as_str())
                .map(|v| v.to_string());
            let multiline = params
                .and_then(|p| p.get("multiline"))
                .and_then(|v| v.as_bool())
                .unwrap_or(false);
            let secret = params
                .and_then(|p| p.get("secret"))
                .and_then(|v| v.as_bool())
                .unwrap_or(false);
            return ParsedOutput {
                prompt_request: Some(UiPromptRequest {
                    id,
                    title,
                    message,
                    default_value,
                    multiline,
                    secret,
                }),
                ..ParsedOutput::empty()
            };
        }

        if method == "ui.pick.request" {
            let id = value
                .get("id")
                .and_then(|v| v.as_str())
                .unwrap_or("")
                .to_string();
            let params = value.get("params").and_then(|v| v.as_object());
            let title = params
                .and_then(|p| p.get("title"))
                .and_then(|v| v.as_str())
                .unwrap_or("Pick")
                .to_string();
            let items = params
                .and_then(|p| p.get("items"))
                .and_then(|v| v.as_array())
                .map(|items| {
                    items
                        .iter()
                        .filter_map(|item| item.as_object())
                        .map(|item| UiPickItem {
                            id: item
                                .get("id")
                                .and_then(|v| v.as_str())
                                .unwrap_or("")
                                .to_string(),
                            label: item
                                .get("label")
                                .and_then(|v| v.as_str())
                                .unwrap_or("")
                                .to_string(),
                            detail: item
                                .get("detail")
                                .and_then(|v| v.as_str())
                                .map(|v| v.to_string()),
                        })
                        .collect::<Vec<_>>()
                })
                .unwrap_or_default();
            let multi = params
                .and_then(|p| p.get("multi"))
                .and_then(|v| v.as_bool())
                .unwrap_or(false);
            return ParsedOutput {
                pick_request: Some(UiPickRequest {
                    id,
                    title,
                    items,
                    multi,
                }),
                ..ParsedOutput::empty()
            };
        }

        if method == "agent.event" {
            let event = &value["params"]["event"];
            let event_type = event
                .get("type")
                .and_then(|v| v.as_str())
                .unwrap_or("event");
            match event_type {
                "text" => {
                    let content = event.get("content").and_then(|v| v.as_str()).unwrap_or("");
                    if let Some((tool, preview)) = parse_planned_diff_preview(content) {
                        return ParsedOutput {
                            lines: planned_diff_preview_lines(&tool, &preview),
                            assistant_text: Some(content.to_string()),
                            ..ParsedOutput::empty()
                        };
                    }
                    if let Some(tool) = parse_permission_preflight_ready(content) {
                        return ParsedOutput {
                            lines: permission_preflight_ready_lines(&tool),
                            assistant_text: Some(content.to_string()),
                            ..ParsedOutput::empty()
                        };
                    }
                    let rendered = render_markdown_lines(content);
                    let lines = if content.trim().is_empty() {
                        Vec::new()
                    } else {
                        let mut lines = vec![LogLine::new(LogKind::Space, "")];
                        let mut body = prefix_rendered(
                            DETAIL_INDENT,
                            DETAIL_INDENT,
                            rendered,
                            LogTone::Detail,
                        );
                        lines.append(&mut body);
                        lines
                    };
                    return ParsedOutput {
                        lines,
                        assistant_text: Some(content.to_string()),
                        ..ParsedOutput::empty()
                    };
                }
                "reasoning" => {
                    let content = event.get("content").and_then(|v| v.as_str()).unwrap_or("");
                    if content.trim().is_empty() {
                        return ParsedOutput::empty();
                    }
                    let mut lines = vec![LogLine::new(LogKind::Space, "")];
                    let mut body =
                        prefix_block("", "", LogKind::Reasoning, LogTone::Detail, content);
                    lines.append(&mut body);
                    return ParsedOutput {
                        lines,
                        ..ParsedOutput::empty()
                    };
                }
                "step_start" | "step_complete" => {
                    return ParsedOutput::empty();
                }
                "compaction_start" => {
                    let lines = vec![summary_line("", "compaction started", LogKind::Runtime)];
                    return ParsedOutput {
                        lines,
                        ..ParsedOutput::empty()
                    };
                }
                "compaction_complete" => {
                    let compacted = event
                        .get("compacted")
                        .and_then(|v| v.as_bool())
                        .unwrap_or(false);
                    let label = if compacted {
                        "compaction completed"
                    } else {
                        "compaction skipped"
                    };
                    let lines = vec![summary_line("", label, LogKind::Runtime)];
                    return ParsedOutput {
                        lines,
                        ..ParsedOutput::empty()
                    };
                }
                "tool_call" => {
                    let tool = event.get("tool").and_then(|v| v.as_str()).unwrap_or("tool");
                    let args = event.get("args").cloned().unwrap_or(Value::Null);
                    let tool_call_id = event
                        .get("tool_call_id")
                        .and_then(|v| v.as_str())
                        .map(|v| v.to_string());
                    let summary = summarize_tool_call(tool, &args);
                    let mut spans = vec![LogSpan::new(
                        LogKind::ToolCall,
                        LogTone::Summary,
                        summary.label,
                    )];
                    if !summary.detail.is_empty() {
                        spans.push(LogSpan::new(LogKind::ToolCall, LogTone::Summary, " "));
                        spans.push(LogSpan::new(
                            LogKind::Assistant,
                            LogTone::Summary,
                            summary.detail,
                        ));
                    }
                    let lines = vec![LogLine::new_with_spans(spans)];
                    return ParsedOutput {
                        lines,
                        tool_call_start_id: tool_call_id,
                        ..ParsedOutput::empty()
                    };
                }
                "tool_result" => {
                    let tool = event.get("tool").and_then(|v| v.as_str()).unwrap_or("tool");
                    let tool_call_id = event
                        .get("tool_call_id")
                        .and_then(|v| v.as_str())
                        .map(|v| v.to_string());
                    let result = event.get("result").cloned().unwrap_or(Value::Null);
                    let is_error = event
                        .get("is_error")
                        .and_then(|v| v.as_bool())
                        .unwrap_or(false);
                    let content = if let Some(text) = result.as_str() {
                        text.to_string()
                    } else {
                        result.to_string()
                    };
                    let mut lines = tool_result_lines(tool, &content, is_error);
                    let is_error_result = is_error || looks_like_error(tool, &content, is_error);
                    let fallback_summary = if let Some(line) = lines.first().cloned() {
                        line
                    } else {
                        LogLine::new(LogKind::ToolResult, "")
                    };
                    let tool_call_result = tool_call_id.map(|id| ToolCallResultUpdate {
                        tool_call_id: id,
                        is_error: is_error_result,
                        fallback_summary,
                    });
                    if tool_call_result.is_some() && !lines.is_empty() {
                        lines.remove(0);
                    }
                    return ParsedOutput {
                        lines,
                        tool_call_result,
                        ..ParsedOutput::empty()
                    };
                }
                "final" => {
                    let content = event.get("content").and_then(|v| v.as_str()).unwrap_or("");
                    let rendered = render_markdown_lines(content);
                    let lines = if content.trim().is_empty() {
                        Vec::new()
                    } else {
                        let mut lines = vec![LogLine::new(LogKind::Space, "")];
                        let mut body = prefix_rendered(
                            DETAIL_INDENT,
                            DETAIL_INDENT,
                            rendered,
                            LogTone::Detail,
                        );
                        lines.append(&mut body);
                        lines
                    };
                    return ParsedOutput {
                        lines,
                        final_text: Some(content.to_string()),
                        ..ParsedOutput::empty()
                    };
                }
                "hidden_user_message" => {
                    let content = event.get("content").and_then(|v| v.as_str()).unwrap_or("");
                    let line = format!("> {}", content);
                    let lines = vec![LogLine::new(LogKind::User, line)];
                    return ParsedOutput {
                        lines,
                        ..ParsedOutput::empty()
                    };
                }
                _ => {
                    return ParsedOutput {
                        lines: vec![LogLine::new(
                            LogKind::Runtime,
                            format!("event: {event_type}"),
                        )],
                        ..ParsedOutput::empty()
                    };
                }
            }
        }

        if method == "run.context" {
            let percent = value["params"]
                .get("context_left_percent")
                .and_then(|v| v.as_u64())
                .map(|value| value.min(100) as u8);
            return ParsedOutput {
                context_left_percent: percent,
                ..ParsedOutput::empty()
            };
        }

        if method == "run.status" {
            let status = value["params"]
                .get("status")
                .and_then(|v| v.as_str())
                .unwrap_or("unknown");
            let message = value["params"]
                .get("message")
                .and_then(|v| v.as_str())
                .unwrap_or("");
            let run_id = value["params"]
                .get("run_id")
                .and_then(|v| v.as_str())
                .map(|id| id.to_string());
            let lines = if message.is_empty() {
                vec![LogLine::new(
                    LogKind::Runtime,
                    format!("runtime status: {status}"),
                )]
            } else {
                summary_and_detail_line(
                    "",
                    &format!("runtime status: {status} -"),
                    message,
                    LogKind::Runtime,
                    LogKind::Status,
                )
            };
            return ParsedOutput {
                lines,
                status: Some(status.to_string()),
                status_run_id: run_id,
                ..ParsedOutput::empty()
            };
        }
    }

    if value.get("result").is_some() && value.get("id").is_some() {
        let id = value
            .get("id")
            .and_then(|id| id.as_str())
            .unwrap_or("")
            .to_string();
        return ParsedOutput {
            rpc_response: Some(RpcResponse {
                id,
                result: value.get("result").cloned(),
                error: value.get("error").cloned(),
            }),
            ..ParsedOutput::empty()
        };
    }

    if value.get("error").is_some() && value.get("id").is_some() {
        let id = value
            .get("id")
            .and_then(|id| id.as_str())
            .unwrap_or("")
            .to_string();
        return ParsedOutput {
            rpc_response: Some(RpcResponse {
                id,
                result: None,
                error: value.get("error").cloned(),
            }),
            ..ParsedOutput::empty()
        };
    }

    ParsedOutput {
        lines: vec![LogLine::new(LogKind::Runtime, trimmed.to_string())],
        ..ParsedOutput::empty()
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn parse_runtime_output_surfaces_runtime_error_lines() {
        let parsed = parse_runtime_output("[runtime] Error: Cannot find module '@codelia/logger'");
        assert_eq!(parsed.lines.len(), 1);
        assert_eq!(parsed.lines[0].kind(), LogKind::Error);
        assert_eq!(
            parsed.lines[0].plain_text(),
            "Error: Cannot find module '@codelia/logger'"
        );
    }

    #[test]
    fn parse_runtime_output_keeps_non_error_runtime_lines_as_runtime() {
        let parsed = parse_runtime_output("[runtime] runtime started");
        assert_eq!(parsed.lines.len(), 1);
        assert_eq!(parsed.lines[0].kind(), LogKind::Runtime);
        assert_eq!(parsed.lines[0].plain_text(), "[runtime] runtime started");
    }

    #[test]
    fn lane_create_tool_call_is_summarized_without_seed_body() {
        let payload = json!({
            "jsonrpc": "2.0",
            "method": "agent.event",
            "params": {
                "event": {
                    "type": "tool_call",
                    "tool": "lane_create",
                    "tool_call_id": "tool-1",
                    "args": {
                        "task_id": "tui-diff-display-enhancement",
                        "mux_backend": "tmux",
                        "seed_context": "Very long initial text that should not be displayed in full"
                    }
                }
            }
        })
        .to_string();
        let parsed = parse_runtime_output(&payload);
        assert_eq!(parsed.lines.len(), 1);
        let line = parsed.lines[0].plain_text();
        assert!(line.contains("LaneCreate:"));
        assert!(line.contains("task=tui-diff-display-enhancement"));
        assert!(line.contains("+seed"));
        assert!(!line.contains("Very long initial text"));
    }

    #[test]
    fn lane_create_tool_result_shows_compact_hints() {
        let payload = json!({
            "jsonrpc": "2.0",
            "method": "agent.event",
            "params": {
                "event": {
                    "type": "tool_result",
                    "tool": "lane_create",
                    "tool_call_id": "tool-1",
                    "is_error": false,
                    "result": {
                        "ok": true,
                        "lane": {
                            "lane_id": "bf5735ae-58c9-4a7e-af6f-25f7f97e1b7e",
                            "task_id": "tui-diff-display-enhancement",
                            "state": "running",
                            "worktree_path": "/home/kousw/cospace/codelia/.codelia/worktrees/tui-diff-display-enhancement-bf5735ae"
                        },
                        "hints": {
                            "attach_command": "tmux attach -t 'codelia-lane-bf5735ae'"
                        }
                    }
                }
            }
        })
        .to_string();
        let parsed = parse_runtime_output(&payload);
        assert!(parsed.tool_call_result.is_some());
        let texts = parsed
            .lines
            .iter()
            .map(LogLine::plain_text)
            .collect::<Vec<_>>();
        assert!(texts.iter().any(|line| line.contains("lane: bf5735ae")));
        assert!(texts
            .iter()
            .any(|line| line.contains("task: tui-diff-display-enhancement")));
        assert!(texts.iter().any(|line| line.contains("state: running")));
        assert!(texts
            .iter()
            .any(|line| line.contains("attach: tmux attach -t")));
        assert!(!texts.iter().any(|line| line.contains("\"ok\":true")));
    }

    #[test]
    fn parse_runtime_output_formats_edit_tool_result_as_summary_only() {
        let raw = r#"{"method":"agent.event","params":{"event":{"type":"tool_result","tool":"edit","result":{"summary":"updated file","diff":"--- a/demo.txt\n+++ b/demo.txt\n@@ -1,2 +1,2 @@\n-old line\n+new line\n context line"}}}}"#;
        let parsed = parse_runtime_output(raw);

        assert_eq!(parsed.lines[0].kind(), LogKind::ToolResult);
        assert_eq!(parsed.lines.len(), 1);
        assert!(parsed.lines[0].plain_text().contains("edit updated file"));
    }

    #[test]
    fn parse_runtime_output_formats_planned_edit_diff_preview_with_diff_kinds() {
        let raw = r#"{"method":"agent.event","params":{"event":{"type":"text","content":"Planned edit diff preview:\n--- a/demo.txt\n+++ b/demo.txt\n@@ -1 +1 @@\n-old line\n+new line"}}}"#;
        let parsed = parse_runtime_output(raw);
        assert_eq!(parsed.lines[0].kind(), LogKind::Space);
        assert_eq!(parsed.lines[1].kind(), LogKind::Status);
        assert!(parsed.lines[1]
            .plain_text()
            .contains("Proposed edit changes (preview)"));
        assert_eq!(parsed.lines[2].kind(), LogKind::DiffRemoved);
        assert_eq!(parsed.lines[3].kind(), LogKind::DiffAdded);
    }

    #[test]
    fn parse_runtime_output_formats_planned_write_diff_preview_with_diff_kinds() {
        let raw = r#"{"method":"agent.event","params":{"event":{"type":"text","content":"Planned write diff preview:\n--- a/demo.txt\n+++ b/demo.txt\n@@ -1 +1 @@\n-old line\n+new line"}}}"#;
        let parsed = parse_runtime_output(raw);
        assert_eq!(parsed.lines[0].kind(), LogKind::Space);
        assert_eq!(parsed.lines[1].kind(), LogKind::Status);
        assert!(parsed.lines[1]
            .plain_text()
            .contains("Proposed write changes (preview)"));
        assert_eq!(parsed.lines[2].kind(), LogKind::DiffRemoved);
        assert_eq!(parsed.lines[3].kind(), LogKind::DiffAdded);
    }

    #[test]
    fn parse_runtime_output_formats_permission_preflight_ready_as_status_summary() {
        let raw = r#"{"method":"agent.event","params":{"event":{"type":"text","content":"Permission preflight ready for edit."}}}"#;
        let parsed = parse_runtime_output(raw);
        assert_eq!(parsed.lines[0].kind(), LogKind::Space);
        assert_eq!(parsed.lines[1].kind(), LogKind::Status);
        assert_eq!(
            parsed.lines[1].plain_text(),
            "Review edit changes, then choose Allow or Deny"
        );
    }

    #[test]
    fn limited_edit_diff_lines_truncates_output() {
        let diff = "--- a.txt\n+++ b.txt\n@@ -1 +1 @@\n-old\n+new";
        let (lines, truncated) = limited_edit_diff_lines(diff, 1);
        assert!(truncated);
        assert_eq!(lines.len(), 1);
    }
}
