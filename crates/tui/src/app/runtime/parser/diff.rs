use crate::app::markdown::highlight_code_line;
use crate::app::state::{LogColor, LogKind, LogLine, LogSpan, LogTone};
use similar::{ChangeTag, TextDiff};
use std::path::Path;

use super::common::{detail_line, prefix_block, split_lines, summary_line, DETAIL_INDENT};

pub(super) const MAX_DIFF_LINES: usize = 200;

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

pub(super) fn normalize_language_hint(value: &str) -> Option<String> {
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

pub(super) fn language_from_path(path: &str) -> Option<String> {
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

pub(super) fn looks_like_unified_diff(value: &str) -> bool {
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

pub(super) fn normalize_diff_fingerprint(diff: &str) -> Option<String> {
    let normalized = diff.replace("\r\n", "\n");
    let trimmed = normalized.trim();
    if trimmed.is_empty() {
        return None;
    }
    Some(trimmed.to_string())
}
