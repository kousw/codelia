use crate::app::state::{LogKind, LogLine, LogSpan, LogTone};
use serde_json::Value;

use super::agents::tool_result_lines as agents_resolve_tool_result_lines;
use super::common::{
    detail_line, prefix_block, redact_ref_markers, relative_or_basename, short_id, split_lines,
    summary_line, truncate_line, ToolCallSummary, DETAIL_INDENT,
};
use super::diff::{
    language_from_path, limited_edit_diff_lines_with_hint, looks_like_unified_diff,
    normalize_diff_fingerprint, normalize_language_hint, MAX_DIFF_LINES,
};
use super::lane::tool_result_lines as lane_tool_result_lines;
use super::shell::{
    result_is_error as shell_result_is_error, summarize_tool_call as summarize_shell_tool_call,
    tool_result_lines as shell_tool_result_lines,
};
use super::todo::{
    is_todo_mutation_tool, result_is_error as todo_result_is_error,
    tool_result_lines as todo_tool_result_lines,
};
use super::web::{
    web_search_queries_from_value, web_search_summary_detail, web_search_summary_from_result,
    webfetch_summary_detail, webfetch_summary_from_result,
};

const READ_PREVIEW_LINES: usize = 2;
const SKILL_LOAD_PREVIEW_LINES: usize = 3;
const BASH_ERROR_LINES: usize = 5;
const DEFAULT_PREVIEW_LINES: usize = 3;
const MAX_WRITE_DIFF_LINES: usize = 30;
const MAX_ARG_LENGTH: usize = 160;
const MAX_HEADER_LENGTH: usize = 200;
fn limit_lines(lines: Vec<String>, max: usize) -> (Vec<String>, bool) {
    if lines.len() <= max {
        return (lines, false);
    }
    (lines.into_iter().take(max).collect(), true)
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

pub(super) fn permission_preflight_ready_lines(tool: &str) -> Vec<LogLine> {
    vec![
        LogLine::new(LogKind::Space, ""),
        summary_line(
            "",
            format!("Review {tool} changes, then choose Allow or Deny"),
            LogKind::Status,
        ),
    ]
}

fn is_builtin_tool(tool: &str) -> bool {
    matches!(
        tool,
        "read"
            | "write"
            | "edit"
            | "bash"
            | "shell"
            | "shell_status"
            | "shell_logs"
            | "shell_wait"
            | "shell_result"
            | "shell_cancel"
            | "shell_list"
            | "agents_resolve"
            | "todo_read"
            | "todo_new"
            | "todo_append"
            | "todo_patch"
            | "todo_clear"
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
            | "search"
            | "web_search"
    )
}

fn tool_display_name(tool: &str) -> String {
    if is_builtin_tool(tool) {
        match tool {
            "agents_resolve" => "AgentsResolve".to_string(),
            "todo_read" => "TodoRead".to_string(),
            "shell" => "Shell".to_string(),
            "shell_status" => "ShellStatus".to_string(),
            "shell_logs" => "ShellLogs".to_string(),
            "shell_wait" => "ShellWait".to_string(),
            "shell_result" => "ShellResult".to_string(),
            "shell_cancel" => "ShellCancel".to_string(),
            "shell_list" => "ShellList".to_string(),
            "todo_new" => "TodoNew".to_string(),
            "todo_append" => "TodoAppend".to_string(),
            "todo_patch" => "TodoPatch".to_string(),
            "todo_clear" => "TodoClear".to_string(),
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

fn apply_patch_file_count(patch: &str) -> usize {
    split_lines(patch)
        .into_iter()
        .filter(|line| {
            line.starts_with("*** Update File: ")
                || line.starts_with("*** Add File: ")
                || line.starts_with("*** Delete File: ")
        })
        .count()
}

pub(super) fn summarize_tool_call(tool: &str, args: &Value) -> ToolCallSummary {
    if tool == "web_search" {
        let queries = web_search_queries_from_value(args);
        return ToolCallSummary {
            label: "WebSearch:".to_string(),
            detail: web_search_summary_detail(&queries),
        };
    }
    if tool == "webfetch" {
        let detail = args
            .as_object()
            .and_then(|value| value.get("url"))
            .and_then(|value| value.as_str())
            .map(webfetch_summary_detail)
            .unwrap_or_else(|| "(no url)".to_string());
        return ToolCallSummary {
            label: "WebFetch:".to_string(),
            detail,
        };
    }
    if let Some(summary) = summarize_shell_tool_call(tool, args) {
        return summary;
    }
    let obj = args.as_object();
    if tool == "todo_read" {
        return ToolCallSummary {
            label: "TODO:".to_string(),
            detail: "Read plan".to_string(),
        };
    }
    if is_todo_mutation_tool(tool) {
        let mode = obj
            .and_then(|value| value.get("mode"))
            .and_then(|value| value.as_str())
            .unwrap_or(match tool {
                "todo_append" => "append",
                "todo_patch" => "patch",
                "todo_clear" => "clear",
                _ => "new",
            });
        let todos_count = obj
            .and_then(|value| value.get("todos"))
            .and_then(|value| value.as_array())
            .map(|items| items.len())
            .unwrap_or(0);
        let updates_count = obj
            .and_then(|value| value.get("updates"))
            .and_then(|value| value.as_array())
            .map(|items| items.len())
            .unwrap_or(0);
        let detail = match mode {
            "patch" => format!("Patch {updates_count} task(s)"),
            "append" => format!("Append {todos_count} task(s)"),
            "clear" => "Clear tasks".to_string(),
            "new" => format!("Set {todos_count} task(s)"),
            _ => format!("Set {todos_count} task(s)"),
        };
        return ToolCallSummary {
            label: "TODO:".to_string(),
            detail,
        };
    }
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
    if tool == "agents_resolve" {
        let path = obj
            .and_then(|value| value.get("path"))
            .and_then(|value| value.as_str())
            .unwrap_or("");
        return ToolCallSummary {
            label: "AgentsResolve:".to_string(),
            detail: truncate_line(&relative_or_basename(path), MAX_ARG_LENGTH),
        };
    }
    if tool == "read" {
        let path = obj
            .and_then(|value| value.get("file_path"))
            .and_then(|value| value.as_str())
            .unwrap_or("");
        let file_name = path.split('/').next_back().unwrap_or("");
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
        let file_name = path.split('/').next_back().unwrap_or("");
        return ToolCallSummary {
            label: label.to_string(),
            detail: file_name.to_string(),
        };
    }
    if tool == "apply_patch" {
        let file_count = obj
            .and_then(|value| value.get("patch"))
            .and_then(|value| value.as_str())
            .map(apply_patch_file_count)
            .unwrap_or(0);
        let dry_run = obj
            .and_then(|value| value.get("dry_run"))
            .and_then(|value| value.as_bool())
            .unwrap_or(false);
        let mut detail = if file_count == 0 {
            "patch".to_string()
        } else {
            format!("{file_count} file(s)")
        };
        if dry_run {
            detail.push_str(" (preview)");
        }
        return ToolCallSummary {
            label: "ApplyPatch:".to_string(),
            detail,
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

pub(super) fn looks_like_error(tool: &str, text: &str, is_error: bool) -> bool {
    if is_error {
        return true;
    }
    if shell_result_is_error(tool, text) {
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
    if todo_result_is_error(tool, &lower) {
        return true;
    }
    false
}

pub(super) struct ToolResultRender {
    pub(super) lines: Vec<LogLine>,
    pub(super) edit_diff_fingerprint: Option<String>,
}

pub(super) fn tool_result_lines(tool: &str, raw: &str, is_error: bool) -> ToolResultRender {
    let cleaned = redact_ref_markers(raw);
    let cleaned_trim = cleaned.trim();
    let error = looks_like_error(tool, cleaned_trim, is_error);
    let (icon, kind) = if error {
        ("✖", LogKind::Error)
    } else {
        ("✔", LogKind::ToolResult)
    };

    if let Some(lines) = agents_resolve_tool_result_lines(tool, cleaned_trim, icon, kind, error) {
        return ToolResultRender {
            lines,
            edit_diff_fingerprint: None,
        };
    }

    if let Some(lines) = lane_tool_result_lines(tool, raw, icon, kind, error) {
        return ToolResultRender {
            lines,
            edit_diff_fingerprint: None,
        };
    }

    if let Some(lines) = todo_tool_result_lines(tool, raw, icon, kind, error) {
        return ToolResultRender {
            lines,
            edit_diff_fingerprint: None,
        };
    }

    if let Some(lines) = shell_tool_result_lines(tool, raw, cleaned_trim, icon, kind, error) {
        return ToolResultRender {
            lines,
            edit_diff_fingerprint: None,
        };
    }

    if tool == "edit" || tool == "write" || tool == "apply_patch" {
        if let Ok(parsed) = serde_json::from_str::<Value>(raw) {
            let summary = parsed
                .get("summary")
                .and_then(|value| value.as_str())
                .map(|value| value.trim())
                .filter(|value| !value.is_empty());
            let diff = parsed.get("diff").and_then(|value| value.as_str());
            let diff_fingerprint = diff.and_then(normalize_diff_fingerprint);
            if summary.is_some() || diff_fingerprint.is_some() {
                let header = summary.unwrap_or("updated");
                let mut lines = vec![summary_line(
                    icon,
                    format!("{tool} {}", truncate_line(header, MAX_HEADER_LENGTH)),
                    kind,
                )];
                let truncated_hint = parsed
                    .get("truncated")
                    .and_then(|value| value.as_bool())
                    .unwrap_or(false);
                let file_path = parsed.get("file_path").and_then(|value| value.as_str());
                let language = parsed.get("language").and_then(|value| value.as_str());
                let resolved_language = language
                    .and_then(normalize_language_hint)
                    .or_else(|| file_path.and_then(language_from_path));
                if let Some(diff_text) = diff_fingerprint.as_deref() {
                    if looks_like_unified_diff(diff_text) {
                        let max_diff_lines = if tool == "write" {
                            MAX_WRITE_DIFF_LINES
                        } else {
                            MAX_DIFF_LINES
                        };
                        let (mut diff_lines, _truncated) = limited_edit_diff_lines_with_hint(
                            diff_text,
                            max_diff_lines,
                            resolved_language.as_deref(),
                        );
                        if truncated_hint {
                            diff_lines.push(detail_line(
                                LogKind::DiffMeta,
                                format!("{DETAIL_INDENT}..."),
                            ));
                        }
                        lines.append(&mut diff_lines);
                    } else {
                        let mut body = prefix_block(
                            DETAIL_INDENT,
                            DETAIL_INDENT,
                            LogKind::DiffMeta,
                            LogTone::Detail,
                            diff_text,
                        );
                        if truncated_hint {
                            body.push(detail_line(
                                LogKind::DiffMeta,
                                format!("{DETAIL_INDENT}..."),
                            ));
                        }
                        lines.append(&mut body);
                    }
                }
                return ToolResultRender {
                    lines,
                    edit_diff_fingerprint: if matches!(tool, "edit" | "apply_patch") {
                        diff_fingerprint
                    } else {
                        None
                    },
                };
            }
            if let Some(summary) = summary {
                let header = truncate_line(summary, MAX_HEADER_LENGTH);
                return ToolResultRender {
                    lines: vec![summary_line(icon, format!("{tool} {header}"), kind)],
                    edit_diff_fingerprint: None,
                };
            }
        }
    }

    if tool == "bash" {
        let header = if error { "Bash failed" } else { "Bash done" };
        let mut lines = vec![summary_line(icon, header, kind)];
        if !error || cleaned_trim.is_empty() || cleaned_trim == "(no output)" {
            return ToolResultRender {
                lines,
                edit_diff_fingerprint: None,
            };
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
        return ToolResultRender {
            lines,
            edit_diff_fingerprint: None,
        };
    }

    if tool == "read" {
        let header = if error { "Read failed" } else { "Read done" };
        let mut lines = vec![summary_line(icon, header, kind)];
        if !error || cleaned_trim.is_empty() {
            return ToolResultRender {
                lines,
                edit_diff_fingerprint: None,
            };
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
        return ToolResultRender {
            lines,
            edit_diff_fingerprint: None,
        };
    }

    if tool == "skill_load" {
        let header = if error {
            "SkillLoad failed"
        } else {
            "SkillLoad done"
        };
        let mut lines = vec![summary_line(icon, header, kind)];
        if !error || cleaned_trim.is_empty() {
            return ToolResultRender {
                lines,
                edit_diff_fingerprint: None,
            };
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
        return ToolResultRender {
            lines,
            edit_diff_fingerprint: None,
        };
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
            return ToolResultRender {
                lines,
                edit_diff_fingerprint: None,
            };
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
        return ToolResultRender {
            lines,
            edit_diff_fingerprint: None,
        };
    }

    if tool == "tool_output_cache" {
        let mut lines = vec![summary_line(icon, "tool_output_cache", kind)];
        if cleaned_trim.is_empty() {
            return ToolResultRender {
                lines,
                edit_diff_fingerprint: None,
            };
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
        return ToolResultRender {
            lines,
            edit_diff_fingerprint: None,
        };
    }

    if tool == "web_search" {
        let label = web_search_summary_from_result(cleaned_trim, error);
        return ToolResultRender {
            lines: vec![summary_line(icon, label, kind)],
            edit_diff_fingerprint: None,
        };
    }

    if tool == "webfetch" {
        if let Ok(parsed) = serde_json::from_str::<Value>(raw) {
            if let Some(label) = webfetch_summary_from_result(&parsed) {
                return ToolResultRender {
                    lines: vec![summary_line(icon, label, kind)],
                    edit_diff_fingerprint: None,
                };
            }
        }
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
        return ToolResultRender {
            lines,
            edit_diff_fingerprint: None,
        };
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
    ToolResultRender {
        lines,
        edit_diff_fingerprint: None,
    }
}

pub(super) fn prefix_rendered(
    prefix: &str,
    indent: &str,
    rendered: Vec<LogLine>,
    tone: LogTone,
) -> Vec<LogLine> {
    let mut out = Vec::new();
    for (idx, line) in rendered.into_iter().enumerate() {
        let leader = if idx == 0 { prefix } else { indent };
        let mut spans = Vec::new();
        spans.push(LogSpan::new(line.kind(), tone, leader));
        for span in line.spans() {
            spans.push(span.with_tone(tone));
        }
        out.push(LogLine::new_with_spans(spans));
    }
    out
}

// icon + label + detailを1行で表示する。
pub(super) fn summary_and_detail_line(
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

pub(super) fn parse_runtime_log_line(trimmed: &str) -> Option<LogLine> {
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

pub(super) fn is_legacy_permission_raw_args_message(content: &str) -> bool {
    content.starts_with("Permission request raw args (")
}
