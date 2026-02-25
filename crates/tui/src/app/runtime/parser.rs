use crate::app::state::{LogColor, LogKind, LogLine, LogSpan, LogTone};
use crate::app::view::markdown::{highlight_code_line, render_markdown_lines};
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
    pub permission_preview_update: Option<PermissionPreviewUpdate>,
}

pub struct ToolCallResultUpdate {
    pub tool_call_id: String,
    pub tool: String,
    pub is_error: bool,
    pub fallback_summary: LogLine,
    pub edit_diff_fingerprint: Option<String>,
}

pub struct PermissionPreviewUpdate {
    pub tool_call_id: String,
    pub has_diff: bool,
    pub truncated: bool,
    pub diff_fingerprint: Option<String>,
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
            permission_preview_update: None,
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
const DIFF_NUMBER_FG: LogColor = LogColor::rgb(143, 161, 179);
const DIFF_ADDED_MARKER_FG: LogColor = LogColor::rgb(163, 190, 140);
const DIFF_REMOVED_MARKER_FG: LogColor = LogColor::rgb(191, 97, 106);

fn env_flag(name: &str) -> bool {
    matches!(
        std::env::var(name).ok().as_deref(),
        Some("1" | "true" | "TRUE" | "True" | "yes" | "YES" | "on" | "ON")
    )
}

fn append_permission_preview_debug_line(
    lines: &mut Vec<LogLine>,
    resolved_language: Option<&str>,
    file_path: Option<&str>,
) {
    if !env_flag("CODELIA_DEBUG_DIFF_HIGHLIGHT") {
        return;
    }
    let diff_rows = lines
        .iter()
        .filter(|line| {
            matches!(
                line.kind(),
                LogKind::DiffAdded | LogKind::DiffRemoved | LogKind::DiffContext
            )
        })
        .count();
    let colored_rows = lines
        .iter()
        .filter(|line| {
            matches!(
                line.kind(),
                LogKind::DiffAdded | LogKind::DiffRemoved | LogKind::DiffContext
            ) && line.spans().iter().any(|span| span.fg.is_some())
        })
        .count();
    let mut colored_spans = 0usize;
    let mut colored_non_ws_spans = 0usize;
    let mut sample_tokens: Vec<String> = Vec::new();
    let mut distinct_colors: Vec<(u8, u8, u8)> = Vec::new();
    for line in lines.iter().filter(|line| {
        matches!(
            line.kind(),
            LogKind::DiffAdded | LogKind::DiffRemoved | LogKind::DiffContext
        )
    }) {
        for span in line.spans() {
            let Some(color) = span.fg else {
                continue;
            };
            colored_spans += 1;
            if !span.text.trim().is_empty() {
                colored_non_ws_spans += 1;
                if sample_tokens.len() < 4 {
                    sample_tokens.push(span.text.trim().chars().take(16).collect());
                }
            }
            let rgb = (color.r, color.g, color.b);
            if !distinct_colors.contains(&rgb) {
                distinct_colors.push(rgb);
            }
        }
    }
    let color_preview = distinct_colors
        .iter()
        .take(4)
        .map(|(r, g, b)| format!("{r},{g},{b}"))
        .collect::<Vec<_>>()
        .join("|");
    let token_preview = if sample_tokens.is_empty() {
        "-".to_string()
    } else {
        sample_tokens.join("|")
    };
    let language = resolved_language.unwrap_or("-");
    let path = file_path.unwrap_or("-");
    lines.push(detail_line(
        LogKind::DiffMeta,
        format!(
            "{DETAIL_INDENT}[debug] lang={language} file={path} colored_rows={colored_rows}/{diff_rows} colored_spans={colored_spans} non_ws_colored_spans={colored_non_ws_spans} distinct_fg={} sample_rgb={} sample_tokens={token_preview}",
            distinct_colors.len(),
            if color_preview.is_empty() { "-" } else { &color_preview }
        ),
    ));
}

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

fn format_u64_with_commas(value: u64) -> String {
    let mut out = String::new();
    let text = value.to_string();
    for (idx, ch) in text.chars().rev().enumerate() {
        if idx > 0 && idx % 3 == 0 {
            out.push(',');
        }
        out.push(ch);
    }
    out.chars().rev().collect()
}

fn format_percent(value: f64) -> String {
    format!("{value:.1}%")
}

fn format_line_number(value: Option<usize>) -> String {
    value.map_or_else(|| "    ".to_string(), |n| format!("{n:>4}"))
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

#[derive(Clone)]
struct PendingDiffLine {
    text: String,
    in_code_block: bool,
    code_language: Option<String>,
}

fn parse_fence_language(text: &str) -> Option<String> {
    let rest = text.trim_start().strip_prefix("```")?.trim();
    if rest.is_empty() {
        return None;
    }
    rest.split_whitespace().next().map(str::to_string)
}

fn normalize_language_hint(value: &str) -> Option<String> {
    let normalized = value.trim().to_ascii_lowercase();
    if normalized.is_empty() {
        return None;
    }
    Some(match normalized.as_str() {
        "yml" => "yaml".to_string(),
        "mjs" | "cjs" | "node" => "javascript".to_string(),
        "mts" | "cts" | "ts-node" | "deno" => "typescript".to_string(),
        "py" | "python3" => "python".to_string(),
        "rb" => "ruby".to_string(),
        "zsh" | "sh" => "bash".to_string(),
        "ps1" => "powershell".to_string(),
        _ => normalized,
    })
}

fn language_from_path(path: &str) -> Option<String> {
    let raw_path = path.trim_matches('"');
    if raw_path == "/dev/null" {
        return None;
    }

    let normalized_path = raw_path
        .strip_prefix("a/")
        .or_else(|| raw_path.strip_prefix("b/"))
        .unwrap_or(raw_path);

    let ext = Path::new(normalized_path)
        .extension()
        .and_then(|ext| ext.to_str())?
        .to_ascii_lowercase();

    normalize_language_hint(&ext)
}

fn language_from_diff_header_line(line: &str) -> Option<String> {
    let raw_path = line
        .strip_prefix("--- ")
        .or_else(|| line.strip_prefix("+++ "))?
        .split_whitespace()
        .next()?;
    language_from_path(raw_path)
}

fn update_fenced_code_state(
    in_code_block: &mut bool,
    code_language: &mut Option<String>,
    text: &str,
) -> bool {
    let trimmed = text.trim_start();
    let is_fence = trimmed.starts_with("```");
    let line_in_code = *in_code_block || is_fence;
    if is_fence {
        if *in_code_block {
            *in_code_block = false;
            *code_language = None;
        } else {
            *in_code_block = true;
            *code_language = parse_fence_language(trimmed);
        }
    }
    line_in_code
}

fn diff_content_line(
    kind: LogKind,
    marker: &str,
    text: &str,
    line_no: Option<usize>,
    in_code_block: bool,
    code_language: Option<&str>,
) -> LogLine {
    let number_prefix = format!("{DETAIL_INDENT}{} ", format_line_number(line_no));
    let should_highlight = in_code_block || code_language.is_some();
    let marker_text = if text.is_empty() {
        marker.to_string()
    } else {
        format!("{marker} ")
    };
    let marker_fg = match kind {
        LogKind::DiffAdded => Some(DIFF_ADDED_MARKER_FG),
        LogKind::DiffRemoved => Some(DIFF_REMOVED_MARKER_FG),
        _ => None,
    };

    if !should_highlight {
        let number_kind = match kind {
            LogKind::DiffAdded | LogKind::DiffRemoved => kind,
            _ => LogKind::DiffMeta,
        };
        return LogLine::new_with_spans(vec![
            LogSpan::new(kind, LogTone::Detail, ""),
            LogSpan::new_with_fg(
                number_kind,
                LogTone::Detail,
                number_prefix,
                Some(DIFF_NUMBER_FG),
            ),
            LogSpan::new_with_fg(kind, LogTone::Detail, marker_text, marker_fg),
            LogSpan::new(kind, LogTone::Detail, text),
        ]);
    }

    let row_kind = match kind {
        LogKind::DiffAdded | LogKind::DiffRemoved => kind,
        _ => LogKind::DiffCode,
    };
    let mut spans = vec![
        LogSpan::new(row_kind, LogTone::Detail, ""),
        LogSpan::new_with_fg(
            row_kind,
            LogTone::Detail,
            number_prefix,
            Some(DIFF_NUMBER_FG),
        ),
        LogSpan::new_with_fg(row_kind, LogTone::Detail, marker_text, marker_fg),
    ];

    let highlight_kind = if kind == LogKind::DiffContext {
        LogKind::DiffCode
    } else {
        kind
    };
    let mut content_spans =
        highlight_code_line(code_language, text, highlight_kind, LogTone::Detail)
            .unwrap_or_else(|| vec![LogSpan::new(highlight_kind, LogTone::Detail, text)]);
    spans.append(&mut content_spans);

    LogLine::new_with_spans(spans)
}

fn render_edit_diff_lines(diff: &str, fallback_language: Option<&str>) -> Vec<LogLine> {
    let mut rendered = Vec::new();
    let mut pending_removed: Vec<PendingDiffLine> = Vec::new();
    let mut pending_added: Vec<PendingDiffLine> = Vec::new();
    let mut old_line: Option<usize> = None;
    let mut new_line: Option<usize> = None;
    let mut old_in_code_block = false;
    let mut new_in_code_block = false;
    let mut old_code_language: Option<String> = None;
    let mut new_code_language: Option<String> = None;
    let mut old_header_language: Option<String> = fallback_language.map(str::to_string);
    let mut new_header_language: Option<String> = fallback_language.map(str::to_string);

    let flush_pending = |rendered: &mut Vec<LogLine>,
                         removed: &mut Vec<PendingDiffLine>,
                         added: &mut Vec<PendingDiffLine>,
                         old_line: &mut Option<usize>,
                         new_line: &mut Option<usize>| {
        if removed.is_empty() && added.is_empty() {
            return;
        }

        let contains_code_block = removed.iter().any(|line| line.in_code_block)
            || added.iter().any(|line| line.in_code_block);
        let contains_language_hint = removed.iter().any(|line| line.code_language.is_some())
            || added.iter().any(|line| line.code_language.is_some());

        if !removed.is_empty()
            && !added.is_empty()
            && !contains_code_block
            && !contains_language_hint
        {
            let before = format!(
                "{}\n",
                removed
                    .iter()
                    .map(|line| line.text.as_str())
                    .collect::<Vec<_>>()
                    .join("\n")
            );
            let after = format!(
                "{}\n",
                added
                    .iter()
                    .map(|line| line.text.as_str())
                    .collect::<Vec<_>>()
                    .join("\n")
            );
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
                            false,
                            None,
                        ));
                        *old_line = old_line.map(|n| n + 1);
                    }
                    ChangeTag::Insert => {
                        rendered.push(diff_content_line(
                            LogKind::DiffAdded,
                            "+",
                            &text,
                            *new_line,
                            false,
                            None,
                        ));
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
                    &line.text,
                    *old_line,
                    line.in_code_block,
                    line.code_language.as_deref(),
                ));
                *old_line = old_line.map(|n| n + 1);
            }
            for line in added.iter() {
                rendered.push(diff_content_line(
                    LogKind::DiffAdded,
                    "+",
                    &line.text,
                    *new_line,
                    line.in_code_block,
                    line.code_language.as_deref(),
                ));
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
                if let Some(language) = language_from_diff_header_line(&line) {
                    old_header_language = Some(language);
                }
            } else {
                let in_code =
                    update_fenced_code_state(&mut old_in_code_block, &mut old_code_language, text);
                pending_removed.push(PendingDiffLine {
                    text: text.to_string(),
                    in_code_block: in_code,
                    code_language: old_code_language
                        .clone()
                        .or_else(|| old_header_language.clone()),
                });
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
                if let Some(language) = language_from_diff_header_line(&line) {
                    new_header_language = Some(language);
                }
            } else {
                let in_code =
                    update_fenced_code_state(&mut new_in_code_block, &mut new_code_language, text);
                pending_added.push(PendingDiffLine {
                    text: text.to_string(),
                    in_code_block: in_code,
                    code_language: new_code_language
                        .clone()
                        .or_else(|| new_header_language.clone()),
                });
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
            let in_old_code =
                update_fenced_code_state(&mut old_in_code_block, &mut old_code_language, text);
            let in_new_code =
                update_fenced_code_state(&mut new_in_code_block, &mut new_code_language, text);
            let context_language = new_code_language
                .as_deref()
                .or(old_code_language.as_deref())
                .or(new_header_language.as_deref())
                .or(old_header_language.as_deref());
            rendered.push(diff_content_line(
                LogKind::DiffContext,
                " ",
                text,
                new_line,
                in_old_code || in_new_code,
                context_language,
            ));
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

fn limited_edit_diff_lines_with_hint(
    diff: &str,
    max_lines: usize,
    fallback_language: Option<&str>,
) -> (Vec<LogLine>, bool) {
    let mut lines = render_edit_diff_lines(diff, fallback_language);
    if lines.len() <= max_lines {
        return (lines, false);
    }
    lines.truncate(max_lines);
    (lines, true)
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

fn permission_preview_lines(
    tool: &str,
    diff: Option<&str>,
    summary: Option<&str>,
    truncated_hint: bool,
    file_path: Option<&str>,
    language: Option<&str>,
) -> Vec<LogLine> {
    let mut lines = vec![
        LogLine::new(LogKind::Space, ""),
        summary_line(
            "",
            format!("Proposed {tool} changes (preview)"),
            LogKind::Status,
        ),
    ];
    let diff_text = diff.unwrap_or_default();
    let summary_text = summary.unwrap_or_default();
    if diff_text.trim().is_empty() && summary_text.trim().is_empty() {
        lines.push(detail_line(
            LogKind::DiffMeta,
            format!("{DETAIL_INDENT}Preview: no diff content"),
        ));
        append_permission_preview_debug_line(&mut lines, None, file_path);
        return lines;
    }
    let resolved_language = language
        .and_then(normalize_language_hint)
        .or_else(|| file_path.and_then(language_from_path));
    if !diff_text.trim().is_empty() && looks_like_unified_diff(diff_text) {
        let (mut diff_lines, truncated) = limited_edit_diff_lines_with_hint(
            diff_text,
            MAX_DIFF_LINES,
            resolved_language.as_deref(),
        );
        append_permission_preview_debug_line(
            &mut diff_lines,
            resolved_language.as_deref(),
            file_path,
        );
        if truncated || truncated_hint {
            diff_lines.push(detail_line(
                LogKind::DiffMeta,
                format!("{DETAIL_INDENT}..."),
            ));
        }
        lines.append(&mut diff_lines);
        return lines;
    }

    let body_text = if !summary_text.trim().is_empty() {
        summary_text
    } else {
        diff_text
    };
    let mut body = prefix_block(
        DETAIL_INDENT,
        DETAIL_INDENT,
        LogKind::DiffMeta,
        LogTone::Detail,
        body_text,
    );
    if truncated_hint {
        body.push(detail_line(
            LogKind::DiffMeta,
            format!("{DETAIL_INDENT}..."),
        ));
    }
    lines.append(&mut body);
    append_permission_preview_debug_line(&mut lines, resolved_language.as_deref(), file_path);
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
            | "search"
            | "web_search"
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

fn json_string_array(value: Option<&Value>) -> Vec<String> {
    value
        .and_then(Value::as_array)
        .map(|entries| {
            entries
                .iter()
                .filter_map(Value::as_str)
                .map(str::trim)
                .filter(|entry| !entry.is_empty())
                .map(ToString::to_string)
                .collect()
        })
        .unwrap_or_default()
}

fn web_search_queries_from_value(value: &Value) -> Vec<String> {
    let direct = json_string_array(value.get("queries"));
    if !direct.is_empty() {
        return direct;
    }
    value
        .get("action")
        .map(|action| json_string_array(action.get("queries")))
        .unwrap_or_default()
}

fn web_search_queries_from_text(raw: &str) -> Vec<String> {
    let Some(start) = raw.find("queries=") else {
        return Vec::new();
    };
    let mut queries_part = &raw[start + "queries=".len()..];
    for marker in [
        " | sources=",
        " | source_count=",
        " | status=",
        " | engine=",
    ] {
        if let Some(index) = queries_part.find(marker) {
            queries_part = &queries_part[..index];
            break;
        }
    }
    queries_part
        .split(" | ")
        .map(str::trim)
        .filter(|entry| !entry.is_empty())
        .map(ToString::to_string)
        .collect()
}

fn web_search_summary_detail(queries: &[String]) -> String {
    if queries.is_empty() {
        return "Summary".to_string();
    }
    truncate_line(&queries.join(" | "), MAX_ARG_LENGTH)
}

fn web_search_summary_from_result(raw: &str, is_error: bool) -> String {
    let queries = if let Ok(value) = serde_json::from_str::<Value>(raw) {
        web_search_queries_from_value(&value)
    } else {
        web_search_queries_from_text(raw)
    };
    if queries.is_empty() {
        return if is_error {
            "WebSearch: Failed".to_string()
        } else {
            "WebSearch: Summary".to_string()
        };
    }
    format!("WebSearch: {}", web_search_summary_detail(&queries))
}

fn summarize_tool_call(tool: &str, args: &Value) -> ToolCallSummary {
    if tool == "web_search" {
        let queries = web_search_queries_from_value(args);
        return ToolCallSummary {
            label: "WebSearch:".to_string(),
            detail: web_search_summary_detail(&queries),
        };
    }
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

fn normalize_diff_fingerprint(diff: &str) -> Option<String> {
    let normalized = diff.replace("\r\n", "\n");
    let trimmed = normalized.trim();
    if trimmed.is_empty() {
        return None;
    }
    Some(trimmed.to_string())
}

struct ToolResultRender {
    lines: Vec<LogLine>,
    edit_diff_fingerprint: Option<String>,
}

fn tool_result_lines(tool: &str, raw: &str, is_error: bool) -> ToolResultRender {
    let cleaned = redact_ref_markers(raw);
    let cleaned_trim = cleaned.trim();
    let error = looks_like_error(tool, cleaned_trim, is_error);
    let (icon, kind) = if error {
        ("✖", LogKind::Error)
    } else {
        ("✔", LogKind::ToolResult)
    };

    if let Some(lines) = lane_tool_result_lines(tool, raw, icon, kind, error) {
        return ToolResultRender {
            lines,
            edit_diff_fingerprint: None,
        };
    }

    if tool == "edit" {
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
                    format!("edit {}", truncate_line(header, MAX_HEADER_LENGTH)),
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
                        let (mut diff_lines, truncated) = limited_edit_diff_lines_with_hint(
                            diff_text,
                            MAX_DIFF_LINES,
                            resolved_language.as_deref(),
                        );
                        if truncated || truncated_hint {
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
                    edit_diff_fingerprint: diff_fingerprint,
                };
            }
            if let Some(summary) = summary {
                let header = truncate_line(summary, MAX_HEADER_LENGTH);
                return ToolResultRender {
                    lines: vec![summary_line(icon, format!("edit {header}"), kind)],
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

fn is_legacy_permission_raw_args_message(content: &str) -> bool {
    content.starts_with("Permission request raw args (")
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
                "permission.preview" => {
                    let tool = event.get("tool").and_then(|v| v.as_str()).unwrap_or("tool");
                    let tool_call_id = event
                        .get("tool_call_id")
                        .and_then(|v| v.as_str())
                        .map(|v| v.to_string());
                    let file_path = event.get("file_path").and_then(|v| v.as_str());
                    let language = event.get("language").and_then(|v| v.as_str());
                    let diff = event.get("diff").and_then(|v| v.as_str());
                    let summary = event.get("summary").and_then(|v| v.as_str());
                    let truncated = event
                        .get("truncated")
                        .and_then(|v| v.as_bool())
                        .unwrap_or(false);
                    let diff_fingerprint = diff.and_then(normalize_diff_fingerprint);
                    return ParsedOutput {
                        lines: permission_preview_lines(
                            tool, diff, summary, truncated, file_path, language,
                        ),
                        permission_preview_update: tool_call_id.map(|id| PermissionPreviewUpdate {
                            tool_call_id: id,
                            has_diff: diff_fingerprint.is_some(),
                            truncated,
                            diff_fingerprint,
                        }),
                        ..ParsedOutput::empty()
                    };
                }
                "permission.ready" => {
                    let tool = event.get("tool").and_then(|v| v.as_str()).unwrap_or("tool");
                    return ParsedOutput {
                        lines: permission_preflight_ready_lines(tool),
                        ..ParsedOutput::empty()
                    };
                }
                "text" => {
                    let content = event.get("content").and_then(|v| v.as_str()).unwrap_or("");
                    if is_legacy_permission_raw_args_message(content) {
                        return ParsedOutput::empty();
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
                    let mut rendered = tool_result_lines(tool, &content, is_error);
                    let mut lines = rendered.lines;
                    let is_error_result = is_error || looks_like_error(tool, &content, is_error);
                    let fallback_summary = if let Some(line) = lines.first().cloned() {
                        line
                    } else {
                        LogLine::new(LogKind::ToolResult, "")
                    };
                    let tool_call_result = tool_call_id.map(|id| ToolCallResultUpdate {
                        tool_call_id: id,
                        tool: tool.to_string(),
                        is_error: is_error_result,
                        fallback_summary,
                        edit_diff_fingerprint: rendered.edit_diff_fingerprint.take(),
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

        if method == "run.diagnostics" {
            let params = value.get("params").cloned().unwrap_or(Value::Null);
            let kind = params
                .get("kind")
                .and_then(|v| v.as_str())
                .unwrap_or("unknown");
            if kind == "llm_call" {
                let call = params.get("call").cloned().unwrap_or(Value::Null);
                let seq = call.get("seq").and_then(|v| v.as_u64()).unwrap_or(0);
                let model = call
                    .get("model")
                    .and_then(|v| v.as_str())
                    .unwrap_or("unknown");
                let provider = call.get("provider").and_then(|v| v.as_str()).unwrap_or("-");
                let latency_ms = call.get("latency_ms").and_then(|v| v.as_u64()).unwrap_or(0);
                let stop_reason = call
                    .get("stop_reason")
                    .and_then(|v| v.as_str())
                    .unwrap_or("-");
                let usage = call.get("usage").cloned().unwrap_or(Value::Null);
                let input_tokens = usage
                    .get("input_tokens")
                    .and_then(|v| v.as_u64())
                    .unwrap_or(0);
                let output_tokens = usage
                    .get("output_tokens")
                    .and_then(|v| v.as_u64())
                    .unwrap_or(0);
                let total_tokens = usage
                    .get("total_tokens")
                    .and_then(|v| v.as_u64())
                    .unwrap_or(0);
                let cache = call.get("cache").cloned().unwrap_or(Value::Null);
                let hit_state = cache
                    .get("hit_state")
                    .and_then(|v| v.as_str())
                    .unwrap_or("unknown");
                let cache_read = cache
                    .get("cache_read_tokens")
                    .and_then(|v| v.as_u64())
                    .unwrap_or(0);
                let cache_creation = cache
                    .get("cache_creation_tokens")
                    .and_then(|v| v.as_u64())
                    .unwrap_or(0);
                let cache_read_ratio = if input_tokens == 0 {
                    0.0
                } else {
                    (cache_read as f64 / input_tokens as f64) * 100.0
                };
                let label = format!("diag llm#{seq} {model}");
                let detail = format!(
                    "provider={provider} latency={}ms stop={} tok(in/out/total)={}/{}/{} cache={} read={} ({}) create={}",
                    latency_ms,
                    stop_reason,
                    format_u64_with_commas(input_tokens),
                    format_u64_with_commas(output_tokens),
                    format_u64_with_commas(total_tokens),
                    hit_state,
                    format_u64_with_commas(cache_read),
                    format_percent(cache_read_ratio),
                    format_u64_with_commas(cache_creation),
                );
                let detail = if let Some(provider_meta_summary) = call
                    .get("provider_meta_summary")
                    .and_then(|v| v.as_str())
                    .filter(|v| !v.is_empty())
                {
                    format!("{detail} meta={provider_meta_summary}")
                } else {
                    detail
                };
                return ParsedOutput {
                    lines: summary_and_detail_line(
                        "",
                        &label,
                        &detail,
                        LogKind::Status,
                        LogKind::Status,
                    ),
                    ..ParsedOutput::empty()
                };
            }
            if kind == "run_summary" {
                let summary = params.get("summary").cloned().unwrap_or(Value::Null);
                let total_calls = summary
                    .get("total_calls")
                    .and_then(|v| v.as_u64())
                    .unwrap_or(0);
                let total_input = summary
                    .get("total_input_tokens")
                    .and_then(|v| v.as_u64())
                    .unwrap_or(0);
                let total_output = summary
                    .get("total_output_tokens")
                    .and_then(|v| v.as_u64())
                    .unwrap_or(0);
                let total_tokens = summary
                    .get("total_tokens")
                    .and_then(|v| v.as_u64())
                    .unwrap_or(0);
                let total_cached = summary
                    .get("total_cached_input_tokens")
                    .and_then(|v| v.as_u64())
                    .unwrap_or(0);
                let total_cache_creation = summary
                    .get("total_cache_creation_tokens")
                    .and_then(|v| v.as_u64())
                    .unwrap_or(0);
                let cache_read_ratio = if total_input == 0 {
                    0.0
                } else {
                    (total_cached as f64 / total_input as f64) * 100.0
                };
                let by_model = summary
                    .get("by_model")
                    .and_then(|v| v.as_object())
                    .cloned()
                    .unwrap_or_default();
                let mut hit_calls = 0_u64;
                let mut miss_calls = 0_u64;
                let mut unknown_calls = 0_u64;
                for model_stats in by_model.values() {
                    let calls = model_stats
                        .get("calls")
                        .and_then(|v| v.as_u64())
                        .unwrap_or(0);
                    let cached_input_tokens = model_stats
                        .get("cached_input_tokens")
                        .and_then(|v| v.as_u64())
                        .unwrap_or(0);
                    let input_tokens = model_stats
                        .get("input_tokens")
                        .and_then(|v| v.as_u64())
                        .unwrap_or(0);
                    if calls == 0 {
                        continue;
                    }
                    if cached_input_tokens > 0 {
                        hit_calls += calls;
                    } else if input_tokens > 0 {
                        miss_calls += calls;
                    } else {
                        unknown_calls += calls;
                    }
                }
                if hit_calls + miss_calls + unknown_calls < total_calls {
                    unknown_calls += total_calls - (hit_calls + miss_calls + unknown_calls);
                }
                let label = "diag run summary";
                let detail = format!(
                    "calls={} tok(in/out/total)={}/{}/{} cache(read/create)={}/{} ({}) calls(hit/miss/unknown)={}/{}/{}",
                    total_calls,
                    format_u64_with_commas(total_input),
                    format_u64_with_commas(total_output),
                    format_u64_with_commas(total_tokens),
                    format_u64_with_commas(total_cached),
                    format_u64_with_commas(total_cache_creation),
                    format_percent(cache_read_ratio),
                    hit_calls,
                    miss_calls,
                    unknown_calls,
                );
                return ParsedOutput {
                    lines: summary_and_detail_line(
                        "",
                        label,
                        &detail,
                        LogKind::Status,
                        LogKind::Status,
                    ),
                    ..ParsedOutput::empty()
                };
            }
            return ParsedOutput::empty();
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
            let is_error_status = status == "error";
            let summary_kind = if is_error_status {
                LogKind::Error
            } else {
                LogKind::Runtime
            };
            let detail_kind = if is_error_status {
                LogKind::Error
            } else {
                LogKind::Status
            };
            let lines = if message.is_empty() {
                vec![LogLine::new(
                    summary_kind,
                    format!("runtime status: {status}"),
                )]
            } else {
                summary_and_detail_line(
                    "",
                    &format!("runtime status: {status} -"),
                    message,
                    summary_kind,
                    detail_kind,
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
    fn parse_run_status_error_is_rendered_as_error_line() {
        let payload = json!({
            "jsonrpc": "2.0",
            "method": "run.status",
            "params": {
                "status": "error",
                "message": "400 {\"type\":\"error\",\"error\":{\"message\":\"credit too low\"}}"
            }
        })
        .to_string();

        let parsed = parse_runtime_output(&payload);
        assert_eq!(parsed.lines.len(), 1);
        assert_eq!(parsed.lines[0].kind(), LogKind::Error);
        assert!(parsed.lines[0]
            .plain_text()
            .contains("runtime status: error -"));
        assert!(parsed.lines[0].plain_text().contains("credit too low"));
    }

    #[test]
    fn parse_run_diagnostics_llm_call_as_status_line() {
        let payload = json!({
            "jsonrpc": "2.0",
            "method": "run.diagnostics",
            "params": {
                "run_id": "run-1",
                "kind": "llm_call",
                "call": {
                    "run_id": "run-1",
                    "seq": 2,
                    "provider": "openai",
                    "model": "gpt-5-mini",
                    "request_ts": "2026-02-19T12:00:00.000Z",
                    "response_ts": "2026-02-19T12:00:00.321Z",
                    "latency_ms": 321,
                    "stop_reason": "tool_use",
                    "usage": {
                        "input_tokens": 100,
                        "output_tokens": 30,
                        "total_tokens": 130,
                        "input_cached_tokens": 40,
                        "input_cache_creation_tokens": 0
                    },
                    "cache": {
                        "hit_state": "hit",
                        "cache_read_tokens": 40,
                        "cache_creation_tokens": 0
                    },
                    "provider_meta_summary": "transport=ws_mode websocket_mode=on chain_reset=true ws_input_mode=full_regenerated"
                }
            }
        })
        .to_string();
        let parsed = parse_runtime_output(&payload);
        assert_eq!(parsed.lines.len(), 1);
        assert_eq!(parsed.lines[0].kind(), LogKind::Status);
        let line = parsed.lines[0].plain_text();
        assert!(line.contains("diag llm#2 gpt-5-mini"));
        assert!(line.contains("cache=hit read=40 (40.0%) create=0"));
        assert!(line.contains("meta=transport=ws_mode websocket_mode=on"));
        assert!(line.contains("ws_input_mode=full_regenerated"));
    }

    #[test]
    fn parse_run_diagnostics_summary_as_status_line() {
        let payload = json!({
            "jsonrpc": "2.0",
            "method": "run.diagnostics",
            "params": {
                "run_id": "run-1",
                "kind": "run_summary",
                "summary": {
                    "total_calls": 3,
                    "total_tokens": 300,
                    "total_input_tokens": 210,
                    "total_output_tokens": 90,
                    "total_cached_input_tokens": 50,
                    "total_cache_creation_tokens": 10,
                    "by_model": {}
                }
            }
        })
        .to_string();
        let parsed = parse_runtime_output(&payload);
        assert_eq!(parsed.lines.len(), 1);
        assert_eq!(parsed.lines[0].kind(), LogKind::Status);
        let line = parsed.lines[0].plain_text();
        assert!(line.contains("diag run summary"));
        assert!(line.contains("calls=3"));
        assert!(line.contains("cache(read/create)=50/10 (23.8%)"));
        assert!(line.contains("calls(hit/miss/unknown)=0/0/3"));
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
    fn web_search_tool_call_is_rendered_as_compact_summary() {
        let payload = json!({
            "jsonrpc": "2.0",
            "method": "agent.event",
            "params": {
                "event": {
                    "type": "tool_call",
                    "tool": "web_search",
                    "tool_call_id": "ws-1",
                    "args": {
                        "queries": ["latest ai news", "openai"],
                        "sources_count": 9
                    }
                }
            }
        })
        .to_string();
        let parsed = parse_runtime_output(&payload);
        assert_eq!(parsed.lines.len(), 1);
        assert_eq!(
            parsed.lines[0].plain_text(),
            "WebSearch: latest ai news | openai"
        );
        assert_eq!(parsed.tool_call_start_id.as_deref(), Some("ws-1"));
    }

    #[test]
    fn web_search_tool_result_uses_single_summary_line() {
        let payload = json!({
            "jsonrpc": "2.0",
            "method": "agent.event",
            "params": {
                "event": {
                    "type": "tool_result",
                    "tool": "web_search",
                    "tool_call_id": "ws-1",
                    "is_error": false,
                    "result": "WebSearch status=completed | queries=latest ai news | openai | sources=9"
                }
            }
        })
        .to_string();
        let parsed = parse_runtime_output(&payload);
        assert!(parsed.lines.is_empty());
        let update = parsed.tool_call_result.expect("tool result update");
        assert_eq!(update.tool_call_id, "ws-1");
        assert_eq!(
            update.fallback_summary.plain_text(),
            "✔ WebSearch: latest ai news | openai"
        );
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
                            "worktree_path": "/home/user/project/.codelia/worktrees/tui-diff-display-enhancement-bf5735ae"
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
    fn parse_runtime_output_formats_edit_tool_result_with_diff_body() {
        let raw = r#"{"method":"agent.event","params":{"event":{"type":"tool_result","tool":"edit","result":{"summary":"updated file","diff":"--- a/demo.txt\n+++ b/demo.txt\n@@ -1,2 +1,2 @@\n-old line\n+new line\n context line"}}}}"#;
        let parsed = parse_runtime_output(raw);

        assert_eq!(parsed.lines[0].kind(), LogKind::ToolResult);
        assert!(parsed.lines[0].plain_text().contains("edit updated file"));
        assert!(parsed
            .lines
            .iter()
            .any(|line| line.plain_text().contains("- old line")));
        assert!(parsed
            .lines
            .iter()
            .any(|line| line.plain_text().contains("+ new line")));
    }

    #[test]
    fn parse_runtime_output_permission_preview_tracks_tool_call_diff_metadata() {
        let raw = r#"{"method":"agent.event","params":{"event":{"type":"permission.preview","tool":"edit","tool_call_id":"tool-1","diff":"--- a/demo.txt\n+++ b/demo.txt\n@@ -1 +1 @@\n-old line\n+new line"}}}"#;
        let parsed = parse_runtime_output(raw);
        let update = parsed
            .permission_preview_update
            .expect("permission preview update");
        assert_eq!(update.tool_call_id, "tool-1");
        assert!(update.has_diff);
        assert!(!update.truncated);
        let fingerprint = update.diff_fingerprint.expect("diff fingerprint");
        assert!(fingerprint.contains("--- a/demo.txt"));
        assert!(fingerprint.contains("+new line"));
    }

    #[test]
    fn parse_runtime_output_edit_tool_result_tracks_diff_metadata_by_tool_call() {
        let raw = r#"{"method":"agent.event","params":{"event":{"type":"tool_result","tool":"edit","tool_call_id":"tool-1","result":{"summary":"updated file","diff":"--- a/demo.txt\n+++ b/demo.txt\n@@ -1 +1 @@\n-old line\n+new line"}}}}"#;
        let parsed = parse_runtime_output(raw);
        let update = parsed.tool_call_result.expect("tool result update");
        assert_eq!(update.tool_call_id, "tool-1");
        assert_eq!(update.tool, "edit");
        let fingerprint = update.edit_diff_fingerprint.expect("edit diff fingerprint");
        assert!(fingerprint.contains("--- a/demo.txt"));
        assert!(fingerprint.contains("+new line"));
        assert!(parsed
            .lines
            .iter()
            .any(|line| line.plain_text().contains("+ new line")));
    }

    #[test]
    fn parse_runtime_output_formats_structured_permission_preview_with_diff() {
        let raw = r#"{"method":"agent.event","params":{"event":{"type":"permission.preview","tool":"edit","diff":"--- a/demo.txt\n+++ b/demo.txt\n@@ -1 +1 @@\n-old line\n+new line","truncated":true}}}"#;
        let parsed = parse_runtime_output(raw);
        assert_eq!(parsed.lines[0].kind(), LogKind::Space);
        assert_eq!(parsed.lines[1].kind(), LogKind::Status);
        assert!(parsed.lines[1]
            .plain_text()
            .contains("Proposed edit changes (preview)"));
        assert_eq!(parsed.lines[2].kind(), LogKind::DiffRemoved);
        assert_eq!(parsed.lines[3].kind(), LogKind::DiffAdded);
        assert_eq!(
            parsed.lines.last().map(LogLine::plain_text),
            Some("  ...".to_string())
        );
    }

    #[test]
    fn parse_runtime_output_formats_structured_permission_preview_with_summary() {
        let raw = r#"{"method":"agent.event","params":{"event":{"type":"permission.preview","tool":"write","summary":"Preview unavailable: dry-run failed"}}}"#;
        let parsed = parse_runtime_output(raw);
        assert_eq!(parsed.lines[0].kind(), LogKind::Space);
        assert_eq!(parsed.lines[1].kind(), LogKind::Status);
        assert!(parsed.lines[1]
            .plain_text()
            .contains("Proposed write changes (preview)"));
        assert_eq!(parsed.lines[2].kind(), LogKind::DiffMeta);
        assert_eq!(
            parsed.lines[2].plain_text(),
            "  Preview unavailable: dry-run failed"
        );
    }

    #[test]
    fn parse_runtime_output_formats_structured_permission_ready_as_status_summary() {
        let raw = r#"{"method":"agent.event","params":{"event":{"type":"permission.ready","tool":"edit"}}}"#;
        let parsed = parse_runtime_output(raw);
        assert_eq!(parsed.lines[0].kind(), LogKind::Space);
        assert_eq!(parsed.lines[1].kind(), LogKind::Status);
        assert_eq!(
            parsed.lines[1].plain_text(),
            "Review edit changes, then choose Allow or Deny"
        );
    }

    #[test]
    fn parse_runtime_output_hides_legacy_permission_raw_args_text_event() {
        let raw = r#"{"method":"agent.event","params":{"event":{"type":"text","content":"Permission request raw args (lane_create):\n{\"task_id\":\"t1\"}"}}}"#;
        let parsed = parse_runtime_output(raw);
        assert!(parsed.lines.is_empty());
        assert!(parsed.assistant_text.is_none());
    }

    #[test]
    fn parse_runtime_output_preserves_code_block_syntax_spans_after_prefix() {
        let raw = r#"{"method":"agent.event","params":{"event":{"type":"text","content":"```rust\nfn main() {}\n```"}}}"#;
        let parsed = parse_runtime_output(raw);

        assert_eq!(parsed.lines.len(), 2);
        let code = &parsed.lines[1];
        assert_eq!(code.kind(), LogKind::AssistantCode);
        assert_eq!(code.spans()[0].text, "  ");
        assert!(code.spans().iter().skip(1).any(|span| span.fg.is_some()));
    }

    #[test]
    fn parse_runtime_output_preserves_typescript_fence_language_hint() {
        let raw = r#"{"method":"agent.event","params":{"event":{"type":"text","content":"```typescript\nconst value: number = 1;\n```"}}}"#;
        let parsed = parse_runtime_output(raw);

        assert_eq!(parsed.lines.len(), 2);
        let code = &parsed.lines[1];
        assert_eq!(code.kind(), LogKind::AssistantCode);
        assert_eq!(code.spans()[0].text, "  ");
        assert!(code.spans().iter().skip(1).any(|span| span.fg.is_some()));
    }

    #[test]
    fn permission_preview_diff_fenced_code_uses_code_block_background_with_diff_overlay() {
        let raw = r#"{"method":"agent.event","params":{"event":{"type":"permission.preview","tool":"write","diff":"--- a/demo.md\n+++ b/demo.md\n@@ -1,4 +1,4 @@\n ```ts\n-const value = 1;\n+const value = 2;\n ```"}}}"#;
        let parsed = parse_runtime_output(raw);

        let added_line = parsed
            .lines
            .iter()
            .find(|line| line.plain_text().contains("+ const value = 2;"))
            .expect("added diff line");
        assert_eq!(added_line.kind(), LogKind::DiffAdded);
        assert!(added_line
            .spans()
            .iter()
            .any(|span| span.kind == LogKind::DiffAdded));
    }

    #[test]
    fn permission_preview_diff_uses_file_extension_for_non_fenced_syntax_highlight() {
        let raw = r#"{"method":"agent.event","params":{"event":{"type":"permission.preview","tool":"edit","diff":"--- a/demo-write-edit.ts\n+++ b/demo-write-edit.ts\n@@ -1,2 +1,2 @@\n-const retries = 1;\n+const retries = 3;"}}}"#;
        let parsed = parse_runtime_output(raw);

        let added_line = parsed
            .lines
            .iter()
            .find(|line| line.plain_text().contains("+ const retries = 3;"))
            .expect("added ts line");
        assert_eq!(added_line.kind(), LogKind::DiffAdded);
        assert!(added_line.spans().iter().any(|span| span.fg.is_some()));
    }

    #[test]
    fn permission_preview_diff_uses_file_path_hint_when_headers_are_missing() {
        let raw = r#"{"method":"agent.event","params":{"event":{"type":"permission.preview","tool":"write","file_path":"demo-write-edit.ts","diff":"@@ -1 +1 @@\n-const retries = 1;\n+const retries = 3;"}}}"#;
        let parsed = parse_runtime_output(raw);

        let added_line = parsed
            .lines
            .iter()
            .find(|line| line.plain_text().contains("+ const retries = 3;"))
            .expect("added ts line");
        assert_eq!(added_line.kind(), LogKind::DiffAdded);
        assert!(added_line.spans().iter().any(|span| span.fg.is_some()));
    }

    #[test]
    fn permission_preview_diff_ts_write_case_emits_colored_spans() {
        let raw = r#"{"method":"agent.event","params":{"event":{"type":"permission.preview","tool":"write","file_path":"demo-write-edit-4.ts","diff":"--- demo-write-edit-4.ts\n+++ demo-write-edit-4.ts\n@@ -0,0 +1,3 @@\n+export type Item = {\n+  id: string;\n+  score: number;"}}}"#;
        let parsed = parse_runtime_output(raw);

        let added_line = parsed
            .lines
            .iter()
            .find(|line| line.plain_text().contains("+ export type Item"))
            .expect("added write line");
        assert_eq!(added_line.kind(), LogKind::DiffAdded);
        assert!(added_line.spans().iter().any(|span| span.fg.is_some()));
    }

    #[test]
    fn permission_preview_diff_uses_explicit_language_hint() {
        let raw = r#"{"method":"agent.event","params":{"event":{"type":"permission.preview","tool":"edit","file_path":"notes.unknown","language":"rust","diff":"@@ -1 +1 @@\n-fn old() {}\n+fn new() {}"}}}"#;
        let parsed = parse_runtime_output(raw);

        let added_line = parsed
            .lines
            .iter()
            .find(|line| line.plain_text().contains("+ fn new() {}"))
            .expect("added rust line");
        assert_eq!(added_line.kind(), LogKind::DiffAdded);
        assert!(added_line.spans().iter().any(|span| span.fg.is_some()));
    }

    #[test]
    fn permission_preview_diff_styles_line_numbers_and_markers() {
        let raw = r#"{"method":"agent.event","params":{"event":{"type":"permission.preview","tool":"edit","diff":"--- a/demo.txt\n+++ b/demo.txt\n@@ -1 +1 @@\n-old line\n+new line"}}}"#;
        let parsed = parse_runtime_output(raw);

        let removed_line = parsed
            .lines
            .iter()
            .find(|line| line.plain_text().contains("- old line"))
            .expect("removed line");
        let added_line = parsed
            .lines
            .iter()
            .find(|line| line.plain_text().contains("+ new line"))
            .expect("added line");

        assert_eq!(removed_line.spans()[1].fg, Some(DIFF_NUMBER_FG));
        assert_eq!(added_line.spans()[1].fg, Some(DIFF_NUMBER_FG));
        assert_eq!(removed_line.spans()[2].fg, Some(DIFF_REMOVED_MARKER_FG));
        assert_eq!(added_line.spans()[2].fg, Some(DIFF_ADDED_MARKER_FG));
    }

    #[test]
    fn limited_edit_diff_lines_truncates_output() {
        let diff = "--- a.txt\n+++ b.txt\n@@ -1 +1 @@\n-old\n+new";
        let (lines, truncated) = limited_edit_diff_lines_with_hint(diff, 1, None);
        assert!(truncated);
        assert_eq!(lines.len(), 1);
    }
}
