use crate::app::markdown::highlight_code_line;
use crate::app::state::{LogColor, LogKind, LogLine, LogSpan, LogTone};
use serde_json::Value;
use similar::{ChangeTag, TextDiff};
use std::path::Path;

fn split_lines(value: &str) -> Vec<String> {
    value
        .split('\n')
        .map(|line| line.trim_end_matches('\r').to_string())
        .collect()
}

pub(super) const DETAIL_INDENT: &str = "  ";
const READ_PREVIEW_LINES: usize = 2;
const SKILL_LOAD_PREVIEW_LINES: usize = 3;
const BASH_ERROR_LINES: usize = 5;
const DEFAULT_PREVIEW_LINES: usize = 3;
const MAX_DIFF_LINES: usize = 200;
const MAX_WRITE_DIFF_LINES: usize = 30;
const MAX_ARG_LENGTH: usize = 160;
const MAX_HEADER_LENGTH: usize = 200;
pub(super) const DIFF_NUMBER_FG: LogColor = LogColor::rgb(143, 161, 179);
pub(super) const DIFF_ADDED_MARKER_FG: LogColor = LogColor::rgb(163, 190, 140);
pub(super) const DIFF_REMOVED_MARKER_FG: LogColor = LogColor::rgb(191, 97, 106);

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

pub(super) fn format_u64_with_commas(value: u64) -> String {
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

pub(super) fn format_percent(value: f64) -> String {
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

pub(super) fn limited_edit_diff_lines_with_hint(
    diff: &str,
    max_lines: usize,
    fallback_language: Option<&str>,
) -> (Vec<LogLine>, bool) {
    let lines = render_edit_diff_lines(diff, fallback_language);
    if lines.len() <= max_lines {
        return (lines, false);
    }
    if max_lines == 0 {
        return (Vec::new(), true);
    }
    if max_lines == 1 {
        return (
            vec![detail_line(
                LogKind::DiffMeta,
                format!(
                    "{DETAIL_INDENT}... ({} diff lines omitted) ...",
                    lines.len()
                ),
            )],
            true,
        );
    }
    // Keep total output bounded by max_lines while still showing an omission marker.
    let visible_budget = max_lines.saturating_sub(1);
    let head_count = visible_budget / 2;
    let tail_count = visible_budget.saturating_sub(head_count);
    let omitted = lines.len().saturating_sub(head_count + tail_count);
    let mut limited = Vec::with_capacity(head_count + tail_count + 1);
    limited.extend(lines.iter().take(head_count).cloned());
    limited.push(detail_line(
        LogKind::DiffMeta,
        format!("{DETAIL_INDENT}... ({omitted} diff lines omitted) ..."),
    ));
    limited.extend(
        lines
            .iter()
            .skip(lines.len().saturating_sub(tail_count))
            .cloned(),
    );
    (limited, true)
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

pub(super) fn permission_preview_lines(
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

pub(super) struct ToolCallSummary {
    pub(super) label: String,
    pub(super) detail: String,
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

pub(super) fn summarize_tool_call(tool: &str, args: &Value) -> ToolCallSummary {
    if tool == "web_search" {
        let queries = web_search_queries_from_value(args);
        return ToolCallSummary {
            label: "WebSearch:".to_string(),
            detail: web_search_summary_detail(&queries),
        };
    }
    let obj = args.as_object();
    if tool == "todo_read" {
        return ToolCallSummary {
            label: "TODO:".to_string(),
            detail: "Read plan".to_string(),
        };
    }
    if tool == "todo_write" {
        let mode = obj
            .and_then(|value| value.get("mode"))
            .and_then(|value| value.as_str())
            .unwrap_or("new");
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
            "patch" => format!("Update {updates_count} task(s)"),
            "append" => format!("Append {todos_count} task(s)"),
            "clear" => "Clear tasks".to_string(),
            _ => format!("Update {todos_count} task(s)"),
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

fn agents_resolve_tool_result_lines(
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
            lines.push(LogLine::new_with_tone(
                kind,
                LogTone::Detail,
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
        lines.push(LogLine::new_with_tone(
            kind,
            LogTone::Detail,
            format!(
                "{DETAIL_INDENT}target: {}",
                truncate_line(&relative_or_basename(path), MAX_HEADER_LENGTH)
            ),
        ));
    }

    if files.is_empty() {
        lines.push(LogLine::new_with_tone(
            kind,
            LogTone::Detail,
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
        lines.push(LogLine::new_with_tone(
            kind,
            LogTone::Detail,
            format!(
                "{DETAIL_INDENT}AGENTS: {} ({reason})",
                truncate_line(&relative_or_basename(path), MAX_HEADER_LENGTH)
            ),
        ));
    }

    Some(lines)
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
        details.push(LogLine::new_with_tone(
            detail_kind,
            LogTone::Detail,
            format!("{DETAIL_INDENT}{trimmed}"),
        ));
    }
    details
}

fn todo_write_summary(text: &str) -> Option<String> {
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

fn todo_tool_result_lines(
    tool: &str,
    raw: &str,
    icon: &str,
    kind: LogKind,
    error: bool,
) -> Option<Vec<LogLine>> {
    if !matches!(tool, "todo_read" | "todo_write") {
        return None;
    }
    let cleaned_text = todo_text_for_tui(raw);
    let cleaned_trim = cleaned_text.as_deref().unwrap_or("").trim();

    if tool == "todo_write" {
        let header = if error {
            "TODO: Update failed".to_string()
        } else {
            todo_write_summary(cleaned_trim).unwrap_or_else(|| "TODO: Updated plan".to_string())
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

pub(super) fn looks_like_error(tool: &str, text: &str, is_error: bool) -> bool {
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
    if tool == "todo_write" {
        return lower.starts_with("patch failed:")
            || lower.starts_with("invalid todo state:")
            || lower.starts_with("todo update failed");
    }
    if tool == "todo_read" {
        return lower.starts_with("todo read failed");
    }
    false
}

pub(super) fn normalize_diff_fingerprint(diff: &str) -> Option<String> {
    let normalized = diff.replace("\r\n", "\n");
    let trimmed = normalized.trim();
    if trimmed.is_empty() {
        return None;
    }
    Some(trimmed.to_string())
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

    if tool == "edit" || tool == "write" {
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
                    edit_diff_fingerprint: if tool == "edit" {
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

pub(super) fn prefix_block(
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
