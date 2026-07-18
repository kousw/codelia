use crate::app::state::{LogKind, LogLine, LogTone};
use serde_json::Value;

use super::common::{
    prefix_block, split_lines, summary_line, truncate_line, ToolCallSummary, DETAIL_INDENT,
};

const MAX_ARG_LENGTH: usize = 160;
const MAX_HEADER_LENGTH: usize = 200;
const SHELL_PREVIEW_LINES: usize = 6;

fn preview_lines_head_tail(text: &str, max_lines: usize) -> (Vec<String>, bool) {
    let lines: Vec<String> = split_lines(text)
        .into_iter()
        .filter(|line| !line.trim().is_empty())
        .collect();
    if lines.len() <= max_lines {
        return (lines, false);
    }
    if max_lines == 0 {
        return (Vec::new(), true);
    }
    if max_lines == 1 {
        return (vec!["...".to_string()], true);
    }

    let visible_budget = max_lines.saturating_sub(1);
    let head_count = visible_budget.div_ceil(2);
    let tail_count = visible_budget.saturating_sub(head_count);
    let omitted = lines.len().saturating_sub(head_count + tail_count);
    let mut limited = Vec::with_capacity(head_count + tail_count + 1);
    limited.extend(lines.iter().take(head_count).cloned());
    limited.push(format!("... ({omitted} line(s) omitted) ..."));
    limited.extend(
        lines
            .iter()
            .skip(lines.len().saturating_sub(tail_count))
            .cloned(),
    );
    (limited, true)
}

fn shell_task_state(task: &Value) -> String {
    task.get("state")
        .and_then(|value| value.as_str())
        .unwrap_or("unknown")
        .to_string()
}

fn shell_task_ref_arg(args: Option<&serde_json::Map<String, Value>>) -> String {
    args.and_then(|value| value.get("key").and_then(|entry| entry.as_str()))
        .or_else(|| args.and_then(|value| value.get("task_id").and_then(|entry| entry.as_str())))
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .unwrap_or("(no task)")
        .to_string()
}

fn shell_task_title(task: &Value) -> Option<String> {
    task.get("title")
        .or_else(|| task.get("command"))
        .and_then(|value| value.as_str())
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(ToString::to_string)
}

fn shell_task_output(task: &Value, stream: &str) -> Option<String> {
    task.get(stream)
        .and_then(|value| value.as_str())
        .map(str::to_string)
}

fn shell_task_json_result_is_error(tool: &str, parsed: &Value) -> bool {
    if !matches!(
        tool,
        "shell" | "shell_status" | "shell_wait" | "shell_result" | "shell_cancel"
    ) {
        return false;
    }
    let task = parsed.get("task").unwrap_or(parsed);
    let still_running = parsed
        .get("still_running")
        .and_then(|value| value.as_bool())
        .unwrap_or(false);
    let aborted = parsed
        .get("aborted")
        .and_then(|value| value.as_bool())
        .unwrap_or(false);
    if tool == "shell_wait" && (still_running || aborted) {
        return false;
    }

    let state = shell_task_state(task);
    if matches!(state.as_str(), "failed" | "cancelled") {
        return true;
    }
    task.get("exit_code")
        .and_then(|value| value.as_i64())
        .is_some_and(|code| code != 0)
}

fn shell_summary_with_title(base: &str, task: &Value) -> String {
    let mut summary = if let Some(title) = shell_task_title(task) {
        let separator = if base.ends_with(':') {
            " "
        } else if base.starts_with("Shell") || base.contains(':') {
            " - "
        } else {
            ": "
        };
        format!(
            "{base}{separator}{}",
            truncate_line(&title, MAX_HEADER_LENGTH)
        )
    } else {
        base.to_string()
    };

    if let Some(duration_ms) = task.get("duration_ms").and_then(|value| value.as_i64()) {
        summary.push_str(&format!(" ({duration_ms} ms)"));
    }

    summary
}

#[derive(Clone, Copy)]
struct ShellMetadataOptions {
    show_key: bool,
    show_state: bool,
    show_exit_code: bool,
}

fn shell_list_counts(tasks: &[Value]) -> (usize, usize) {
    let returned = tasks.len();
    let running = tasks
        .iter()
        .filter(|task| matches!(shell_task_state(task).as_str(), "queued" | "running"))
        .count();
    (returned, running)
}

fn shell_list_entry_text(task: &Value) -> String {
    let state = shell_task_state(task);
    let key = task
        .get("key")
        .and_then(|value| value.as_str())
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .unwrap_or("(no key)");
    let label = task
        .get("label")
        .and_then(|value| value.as_str())
        .map(str::trim)
        .filter(|value| !value.is_empty());
    let command = shell_task_title(task).unwrap_or_else(|| "(no command)".to_string());
    let mut parts = vec![state, key.to_string()];
    if let Some(label) = label {
        parts.push(label.to_string());
    }
    parts.push(command);
    truncate_line(&parts.join(" | "), MAX_HEADER_LENGTH)
}

fn shell_list_tool_result_lines(parsed: &Value) -> Vec<LogLine> {
    let tasks = parsed
        .get("tasks")
        .and_then(|value| value.as_array())
        .cloned()
        .unwrap_or_default();
    let (returned, running) = shell_list_counts(&tasks);
    let muted_kind = LogKind::Shell;
    let mut lines = vec![summary_line(
        "",
        format!("ShellList: {returned} task(s), running={running}"),
        muted_kind,
    )];

    if tasks.is_empty() {
        lines.push(LogLine::new_with_tone(
            muted_kind,
            LogTone::Detail,
            format!("{DETAIL_INDENT}no tasks"),
        ));
        return lines;
    }

    for task in tasks {
        lines.push(LogLine::new_with_tone(
            muted_kind,
            LogTone::Detail,
            format!("{DETAIL_INDENT}{}", shell_list_entry_text(&task)),
        ));
    }
    lines
}

fn shell_reason_lines(task: &Value, kind: LogKind) -> Vec<LogLine> {
    let mut lines = Vec::new();
    if let Some(reason) = task
        .get("failure_message")
        .and_then(|value| value.as_str())
        .map(str::trim)
        .filter(|value| !value.is_empty())
    {
        lines.push(LogLine::new_with_tone(
            kind,
            LogTone::Detail,
            format!("{DETAIL_INDENT}Failure: {reason}"),
        ));
    }
    if let Some(reason) = task
        .get("cancellation_reason")
        .and_then(|value| value.as_str())
        .map(str::trim)
        .filter(|value| !value.is_empty())
    {
        lines.push(LogLine::new_with_tone(
            kind,
            LogTone::Detail,
            format!("{DETAIL_INDENT}Cancellation: {reason}"),
        ));
    }
    lines
}

fn shell_metadata_lines(
    task: &Value,
    kind: LogKind,
    options: ShellMetadataOptions,
) -> Vec<LogLine> {
    let mut lines = Vec::new();
    if options.show_key {
        if let Some(key) = task
            .get("key")
            .and_then(|value| value.as_str())
            .map(str::trim)
            .filter(|value| !value.is_empty())
        {
            lines.push(LogLine::new_with_tone(
                kind,
                LogTone::Detail,
                format!("{DETAIL_INDENT}Key: {key}"),
            ));
        }
    }
    if options.show_state {
        let state = shell_task_state(task);
        lines.push(LogLine::new_with_tone(
            kind,
            LogTone::Detail,
            format!("{DETAIL_INDENT}State: {state}"),
        ));
    }
    if options.show_exit_code {
        if let Some(code) = task.get("exit_code").and_then(|value| value.as_i64()) {
            lines.push(LogLine::new_with_tone(
                kind,
                LogTone::Detail,
                format!("{DETAIL_INDENT}Exit code: {code}"),
            ));
        }
    }
    lines
}

fn shell_compact_output_only(
    tool: &str,
    error: bool,
    detached_wait: bool,
    still_running: bool,
) -> bool {
    matches!(tool, "shell" | "shell_wait" | "shell_result")
        && !error
        && !detached_wait
        && !still_running
}

fn shell_metadata_options(
    tool: &str,
    error: bool,
    detached_wait: bool,
    still_running: bool,
) -> ShellMetadataOptions {
    if shell_compact_output_only(tool, error, detached_wait, still_running) {
        return ShellMetadataOptions {
            show_key: false,
            show_state: false,
            show_exit_code: false,
        };
    }

    ShellMetadataOptions {
        show_key: matches!(tool, "shell_status" | "shell_cancel"),
        show_state: matches!(tool, "shell_status" | "shell_wait" | "shell_cancel")
            || still_running
            || detached_wait,
        show_exit_code: !matches!(tool, "shell_status" | "shell_cancel") || error,
    }
}

fn shell_preview_plain_output(task: &Value, max_lines: usize) -> Option<String> {
    let stdout_value = shell_task_output(task, "stdout");
    let stdout = stdout_value
        .as_deref()
        .map(str::trim_end)
        .filter(|value| !value.trim().is_empty());
    let stderr_value = shell_task_output(task, "stderr");
    let stderr = stderr_value
        .as_deref()
        .map(str::trim_end)
        .filter(|value| !value.trim().is_empty());

    let combined = match (stdout, stderr) {
        (Some(stdout), Some(stderr)) => format!("{stdout}\n\nStderr:\n{stderr}"),
        (Some(stdout), None) => stdout.to_string(),
        (None, Some(stderr)) => stderr.to_string(),
        (None, None) => return None,
    };
    let (preview, _truncated) = preview_lines_head_tail(&combined, max_lines);
    if preview.is_empty() {
        None
    } else {
        Some(preview.join("\n"))
    }
}

fn shell_preview_output_only_lines(task: &Value, kind: LogKind, max_lines: usize) -> Vec<LogLine> {
    let Some(preview) = shell_preview_plain_output(task, max_lines) else {
        return Vec::new();
    };
    prefix_block(
        DETAIL_INDENT,
        DETAIL_INDENT,
        kind,
        LogTone::Detail,
        &preview,
    )
}

fn shell_preview_text(task: &Value, max_lines: usize) -> Option<String> {
    let stdout = shell_task_output(task, "stdout")
        .map(|value| value.trim_end().to_string())
        .filter(|value| !value.trim().is_empty());
    let stderr = shell_task_output(task, "stderr")
        .map(|value| value.trim_end().to_string())
        .filter(|value| !value.trim().is_empty());

    let combined = match (stdout, stderr) {
        (Some(stdout), Some(stderr)) => {
            format!("Output:\n{stdout}\n\nStderr:\n{stderr}")
        }
        (Some(stdout), None) => format!("Output:\n{stdout}"),
        (None, Some(stderr)) => format!("Stderr:\n{stderr}"),
        (None, None) => return None,
    };

    let (preview, _truncated) = preview_lines_head_tail(&combined, max_lines);
    if preview.is_empty() {
        None
    } else {
        Some(preview.join("\n"))
    }
}

fn shell_preview_lines(task: &Value, kind: LogKind, max_lines: usize) -> Vec<LogLine> {
    let Some(preview) = shell_preview_text(task, max_lines) else {
        return Vec::new();
    };
    prefix_block(
        DETAIL_INDENT,
        DETAIL_INDENT,
        kind,
        LogTone::Detail,
        &preview,
    )
}

struct TaggedShellBlock {
    tag: String,
    body_lines: Vec<String>,
    command: Option<String>,
    state: Option<String>,
    exit_code: Option<i64>,
    detached_wait: bool,
    output_label: Option<String>,
    output_lines: Vec<String>,
    trailing_lines: Vec<String>,
}

fn is_shell_meta_footer(line: &str) -> bool {
    line.starts_with("@@shell_meta ") || line.starts_with("Full log:")
}

fn parse_tagged_shell_block(raw: &str) -> Option<TaggedShellBlock> {
    let trimmed = raw.trim();
    let open_end = trimmed.find('>')?;
    let open = trimmed.get(..=open_end)?;
    if !open.starts_with("<shell") || !open.ends_with('>') {
        return None;
    }
    let tag = open.strip_prefix('<')?.strip_suffix('>')?.trim_matches('/');
    let close = format!("</{tag}>");
    if !trimmed.ends_with(&close) {
        return None;
    }
    let body = trimmed
        .get(open_end + 1..trimmed.len().saturating_sub(close.len()))?
        .trim_matches('\n');
    let body_lines = split_lines(body);
    let mut command = None;
    let mut state = None;
    let mut exit_code = None;
    let mut detached_wait = false;
    let mut output_label = None;
    let mut output_start = None;
    for (idx, line) in body_lines.iter().enumerate() {
        if *line == "Output:" || *line == "Stderr:" {
            output_label = Some(line.clone());
            output_start = Some(idx + 1);
            break;
        }
        if let Some(value) = line.strip_prefix("Command: ") {
            command = Some(value.to_string());
            continue;
        }
        if let Some(value) = line.strip_prefix("State: ") {
            state = Some(value.to_string());
            continue;
        }
        if let Some(value) = line.strip_prefix("Exit code: ") {
            exit_code = value.parse::<i64>().ok();
            continue;
        }
        if line == "Detached wait: true" {
            detached_wait = true;
        }
    }
    let (output_lines, trailing_lines) = if let Some(start) = output_start {
        let output = body_lines.iter().skip(start).cloned().collect::<Vec<_>>();
        let split = output
            .iter()
            .position(|line| is_shell_meta_footer(line))
            .unwrap_or(output.len());
        (output[..split].to_vec(), output[split..].to_vec())
    } else {
        (Vec::new(), Vec::new())
    };
    Some(TaggedShellBlock {
        tag: tag.to_string(),
        body_lines,
        command,
        state,
        exit_code,
        detached_wait,
        output_label,
        output_lines,
        trailing_lines,
    })
}

fn shell_tagged_summary(tool: &str, block: &TaggedShellBlock) -> String {
    let command_suffix = block
        .command
        .as_deref()
        .map(|value| format!(" - {value}"))
        .unwrap_or_default();
    match tool {
        "shell" if block.detached_wait => {
            format!("Shell started with detached wait{command_suffix}")
        }
        "shell" if block.exit_code == Some(0) => block
            .command
            .as_deref()
            .map(|value| format!("Shell: {value}"))
            .unwrap_or_else(|| "Shell".to_string()),
        "shell" if block.exit_code.is_some() => format!("Shell failed{command_suffix}"),
        "shell_status" => format!(
            "Shell status: {}{command_suffix}",
            block.state.as_deref().unwrap_or("unknown")
        ),
        "shell_wait" if matches!(block.state.as_deref(), Some("running" | "queued")) => {
            format!("Shell wait: still running{command_suffix}")
        }
        "shell_wait" => format!(
            "Shell wait: {}{command_suffix}",
            block.state.as_deref().unwrap_or("completed")
        ),
        "shell_result" => format!(
            "Shell result: {}{command_suffix}",
            block.state.as_deref().unwrap_or_else(|| {
                if block.exit_code == Some(0) {
                    "completed"
                } else {
                    "finished"
                }
            })
        ),
        "shell_cancel" if matches!(block.state.as_deref(), Some("cancelled")) => {
            format!("Shell cancelled{command_suffix}")
        }
        "shell_cancel" => format!(
            "Shell cancel: {}{command_suffix}",
            block.state.as_deref().unwrap_or("cancelled")
        ),
        _ => format!("Shell{command_suffix}"),
    }
}

fn shell_tagged_result_is_error(tool: &str, block: &TaggedShellBlock) -> bool {
    if !matches!(
        tool,
        "shell" | "shell_status" | "shell_wait" | "shell_result" | "shell_cancel"
    ) {
        return false;
    }
    if tool == "shell_wait" && matches!(block.state.as_deref(), Some("running" | "queued")) {
        return false;
    }
    if matches!(block.state.as_deref(), Some("failed" | "cancelled")) {
        return true;
    }
    block.exit_code.is_some_and(|code| code != 0)
}

fn shell_tool_result_is_error(tool: &str, text: &str) -> bool {
    if let Some(block) = parse_tagged_shell_block(text) {
        return shell_tagged_result_is_error(tool, &block);
    }
    serde_json::from_str::<Value>(text)
        .ok()
        .is_some_and(|parsed| shell_task_json_result_is_error(tool, &parsed))
}

fn shell_tagged_tool_result_lines(
    tool: &str,
    raw: &str,
    icon: &str,
    kind: LogKind,
    error: bool,
) -> Option<Vec<LogLine>> {
    let block = parse_tagged_shell_block(raw)?;
    if !matches!(
        block.tag.as_str(),
        "shell" | "shell_status" | "shell_result"
    ) {
        return None;
    }
    let summary_kind = if error { kind } else { LogKind::Shell };
    let mut lines = vec![summary_line(
        icon,
        shell_tagged_summary(tool, &block),
        summary_kind,
    )];

    let mut detail_lines = block
        .body_lines
        .iter()
        .map(String::as_str)
        .filter(|line| !line.is_empty())
        .collect::<Vec<_>>();
    if block.command.is_some()
        && matches!(detail_lines.first(), Some(line) if line.starts_with("Command: "))
    {
        detail_lines.remove(0);
    }

    if let Some(output_label) = block.output_label.as_deref() {
        let output_index = detail_lines
            .iter()
            .position(|line| *line == output_label)
            .unwrap_or(detail_lines.len());
        let mut metadata = detail_lines[..output_index].to_vec();
        let footer = block
            .trailing_lines
            .iter()
            .map(String::as_str)
            .collect::<Vec<_>>();
        let output_text = if block.output_lines.is_empty() {
            None
        } else {
            let (preview, _truncated) =
                preview_lines_head_tail(&block.output_lines.join("\n"), SHELL_PREVIEW_LINES);
            Some(preview.join("\n"))
        };
        metadata.push(output_label);
        let metadata_text = metadata.join("\n");
        if !metadata_text.trim().is_empty() {
            let mut body = prefix_block(
                DETAIL_INDENT,
                DETAIL_INDENT,
                summary_kind,
                LogTone::Detail,
                &metadata_text,
            );
            lines.append(&mut body);
        }
        if let Some(output_text) = output_text {
            let mut body = prefix_block(
                DETAIL_INDENT,
                DETAIL_INDENT,
                summary_kind,
                LogTone::Detail,
                &output_text,
            );
            lines.append(&mut body);
        }
        if !footer.is_empty() {
            let mut body = prefix_block(
                DETAIL_INDENT,
                DETAIL_INDENT,
                summary_kind,
                LogTone::Detail,
                &footer.join("\n"),
            );
            lines.append(&mut body);
        }
        return Some(lines);
    }

    let detail_text = detail_lines.join("\n");
    if !detail_text.trim().is_empty() {
        let mut body = prefix_block(
            DETAIL_INDENT,
            DETAIL_INDENT,
            summary_kind,
            LogTone::Detail,
            &detail_text,
        );
        lines.append(&mut body);
    }
    Some(lines)
}

fn shell_logs_tool_result_lines(parsed: &Value, icon: &str, kind: LogKind) -> Vec<LogLine> {
    let stream = parsed
        .get("stream")
        .and_then(|value| value.as_str())
        .unwrap_or("stdout");
    let source = if parsed.get("live").and_then(|value| value.as_bool()) == Some(true) {
        "live"
    } else if parsed
        .get("cache_id")
        .and_then(|value| value.as_str())
        .is_some()
    {
        "cached"
    } else {
        "retained"
    };
    let summary_kind = if kind == LogKind::Error {
        kind
    } else {
        LogKind::Shell
    };
    let mut lines = vec![summary_line(
        icon,
        format!("Shell logs: {stream} ({source})"),
        summary_kind,
    )];
    if let Some(content) = parsed.get("content").and_then(|value| value.as_str()) {
        if !content.is_empty() {
            let mut body = prefix_block(
                DETAIL_INDENT,
                DETAIL_INDENT,
                summary_kind,
                LogTone::Detail,
                content,
            );
            lines.append(&mut body);
        }
    }
    lines
}

fn shell_task_tool_result_lines(
    tool: &str,
    parsed: &Value,
    icon: &str,
    kind: LogKind,
    error: bool,
) -> Option<Vec<LogLine>> {
    let has_request_error_message = parsed
        .get("message")
        .and_then(|value| value.as_str())
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .is_some();
    if error && has_request_error_message {
        let message = parsed
            .get("message")
            .and_then(|value| value.as_str())
            .map(str::trim)
            .filter(|value| !value.is_empty())
            .unwrap_or("shell request failed");
        let header = match tool {
            "shell_status" => "Shell status failed",
            "shell_logs" => "Shell logs failed",
            "shell_wait" => "Shell wait failed",
            "shell_result" => "Shell result failed",
            "shell_cancel" => "Shell cancel failed",
            _ => "Shell failed",
        };
        return Some(vec![
            summary_line(icon, header, kind),
            LogLine::new_with_tone(kind, LogTone::Detail, format!("{DETAIL_INDENT}{message}")),
        ]);
    }

    if tool == "shell_logs" {
        return Some(shell_logs_tool_result_lines(parsed, icon, kind));
    }
    if tool == "shell_list" {
        return Some(shell_list_tool_result_lines(parsed));
    }

    let task = parsed.get("task").unwrap_or(parsed);
    let state = shell_task_state(task);
    let detached_wait = parsed
        .get("detached_wait")
        .and_then(|value| value.as_bool())
        .unwrap_or(false);
    let aborted = parsed
        .get("aborted")
        .and_then(|value| value.as_bool())
        .unwrap_or(false);
    let still_running = parsed
        .get("still_running")
        .and_then(|value| value.as_bool())
        .unwrap_or(false);

    let header = match tool {
        "shell" if detached_wait => {
            shell_summary_with_title("Shell started with detached wait", task)
        }
        "shell" if state == "completed" => shell_summary_with_title("Shell:", task),
        "shell" => shell_summary_with_title(&format!("Shell {state}"), task),
        "shell_status" => shell_summary_with_title(&format!("Shell status: {state}"), task),
        "shell_wait" if aborted => shell_summary_with_title("Shell wait aborted", task),
        "shell_wait" if still_running => {
            shell_summary_with_title("Shell wait: still running", task)
        }
        "shell_wait" => shell_summary_with_title(&format!("Shell wait: {state}"), task),
        "shell_result" => shell_summary_with_title(&format!("Shell result: {state}"), task),
        "shell_cancel" if state == "cancelled" => shell_summary_with_title("Shell cancelled", task),
        "shell_cancel" => shell_summary_with_title(&format!("Shell cancel: {state}"), task),
        _ => shell_summary_with_title(&format!("Shell {state}"), task),
    };

    let muted_kind = LogKind::Shell;
    let summary_kind = if error || tool == "shell_logs" {
        kind
    } else {
        muted_kind
    };

    let mut lines = vec![summary_line(icon, header, summary_kind)];
    lines.extend(shell_metadata_lines(
        task,
        summary_kind,
        shell_metadata_options(tool, error, detached_wait, still_running),
    ));
    lines.extend(shell_reason_lines(task, summary_kind));

    if matches!(tool, "shell" | "shell_wait" | "shell_result") && !detached_wait && !still_running {
        if shell_compact_output_only(tool, error, detached_wait, still_running) {
            lines.extend(shell_preview_output_only_lines(
                task,
                summary_kind,
                SHELL_PREVIEW_LINES,
            ));
        } else {
            lines.extend(shell_preview_lines(task, summary_kind, SHELL_PREVIEW_LINES));
        }
    }

    Some(lines)
}

pub(super) fn summarize_tool_call(tool: &str, args: &Value) -> Option<ToolCallSummary> {
    let obj = args.as_object();
    let summary = match tool {
        "shell" => {
            let command = obj
                .and_then(|value| value.get("command"))
                .and_then(|value| value.as_str())
                .map(|value| truncate_line(value.trim(), MAX_ARG_LENGTH))
                .filter(|value| !value.is_empty())
                .unwrap_or_else(|| "(no command)".to_string());
            let detached_wait = obj
                .and_then(|value| value.get("detached_wait"))
                .and_then(|value| value.as_bool())
                .unwrap_or(false);
            ToolCallSummary {
                label: "Shell:".to_string(),
                detail: if detached_wait {
                    format!("{command} (detached wait)")
                } else {
                    command
                },
            }
        }
        "shell_status" => ToolCallSummary {
            label: "ShellStatus:".to_string(),
            detail: shell_task_ref_arg(obj),
        },
        "shell_logs" => {
            let task_ref = shell_task_ref_arg(obj);
            let stream = obj
                .and_then(|value| value.get("stream"))
                .and_then(|value| value.as_str())
                .unwrap_or("stdout");
            ToolCallSummary {
                label: "ShellLogs:".to_string(),
                detail: format!("{task_ref} ({stream})"),
            }
        }
        "shell_wait" => ToolCallSummary {
            label: "ShellWait:".to_string(),
            detail: shell_task_ref_arg(obj),
        },
        "shell_result" => ToolCallSummary {
            label: "ShellResult:".to_string(),
            detail: shell_task_ref_arg(obj),
        },
        "shell_cancel" => ToolCallSummary {
            label: "ShellCancel:".to_string(),
            detail: shell_task_ref_arg(obj),
        },
        "shell_list" => {
            let mut parts = Vec::new();
            if let Some(state) = obj
                .and_then(|value| value.get("state"))
                .and_then(|value| value.as_str())
                .map(str::trim)
                .filter(|value| !value.is_empty())
            {
                parts.push(format!("state={state}"));
            }
            if obj
                .and_then(|value| value.get("include_terminal"))
                .and_then(|value| value.as_bool())
                .unwrap_or(false)
            {
                parts.push("include_terminal=true".to_string());
            }
            if let Some(limit) = obj
                .and_then(|value| value.get("limit"))
                .and_then(|value| value.as_u64())
            {
                parts.push(format!("limit={limit}"));
            }
            ToolCallSummary {
                label: "ShellList:".to_string(),
                detail: if parts.is_empty() {
                    "active tasks".to_string()
                } else {
                    parts.join(" ")
                },
            }
        }
        _ => return None,
    };
    Some(summary)
}

pub(super) fn result_is_error(tool: &str, text: &str) -> bool {
    shell_tool_result_is_error(tool, text)
}

pub(super) fn tool_result_lines(
    tool: &str,
    raw: &str,
    cleaned: &str,
    icon: &str,
    kind: LogKind,
    error: bool,
) -> Option<Vec<LogLine>> {
    if !matches!(
        tool,
        "shell"
            | "shell_status"
            | "shell_logs"
            | "shell_wait"
            | "shell_result"
            | "shell_cancel"
            | "shell_list"
    ) {
        return None;
    }
    if let Some(lines) = shell_tagged_tool_result_lines(tool, cleaned, icon, kind, error) {
        return Some(lines);
    }
    let parsed = serde_json::from_str::<Value>(raw).ok()?;
    shell_task_tool_result_lines(tool, &parsed, icon, kind, error)
}
