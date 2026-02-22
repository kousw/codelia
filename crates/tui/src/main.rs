mod app;

use crate::app::handlers::confirm::{
    activate_pending_confirm_dialog, handle_confirm_key, handle_confirm_request,
};
use crate::app::render::inline::{apply_terminal_effects, compute_inline_area};
use crate::app::state::{parse_theme_name, InputState, LogKind, LogLine, LogSpan, LogTone};
use crate::app::util::{
    make_attachment_token, read_clipboard_image_attachment, sanitize_paste, ClipboardImageError,
};
use crate::app::{
    AppState, ContextPanelState, LaneListItem, LaneListPanelState, ModelListMode,
    ModelListPanelState, ModelListSubmitAction, ModelListViewMode, ModelPickerState,
    PickDialogItem, PickDialogState, PromptDialogState, SessionListPanelState, SkillsListItemState,
    SkillsListPanelState, SkillsScopeFilter,
};

use crate::app::runtime::{
    parse_runtime_output, send_initialize, send_model_list, send_pick_response,
    send_prompt_response, send_run_cancel, send_session_list, send_tool_call, spawn_runtime,
    ParsedOutput, RpcResponse, ToolCallResultUpdate, UiClipboardReadRequest, UiPickRequest,
    UiPromptRequest,
};
use crate::app::view::theme::apply_theme_name;
use crate::app::view::{desired_height, draw_ui};
use crossterm::cursor::Show;
use crossterm::event::{
    self, DisableBracketedPaste, DisableMouseCapture, EnableBracketedPaste, EnableMouseCapture,
    Event, KeyCode, KeyEventKind, KeyModifiers, KeyboardEnhancementFlags, MouseEventKind,
    PopKeyboardEnhancementFlags, PushKeyboardEnhancementFlags,
};
use crossterm::terminal::{
    disable_raw_mode, enable_raw_mode, EnterAlternateScreen, LeaveAlternateScreen,
};
use crossterm::ExecutableCommand;
use ratatui::backend::Backend;
use ratatui::backend::CrosstermBackend;
use ratatui::layout::{Position, Rect, Size};
use serde_json::{json, Value};
use std::env;
use std::fmt;
use std::io::{BufWriter, Write};
use std::process::ChildStdin;
use std::sync::mpsc::{Receiver, TryRecvError};
use std::time::{Duration, Instant};

const LOGO_LINES: [&str; 7] = [
    "┌─────────────────────────────────────┐",
    "│                                     │",
    "│     █▀▀ █▀█ █▀▄ █▀▀ █░░ █ ▄▀█       │",
    "│     █▄▄ █▄█ █▄▀ ██▄ █▄▄ █ █▀█       │",
    "│                                     │",
    "│       Your Coding Companion         │",
    "└─────────────────────────────────────┘",
];
const SHIFT_ENTER_BACKSLASH_WINDOW: Duration = Duration::from_millis(80);
const CTRL_C_FORCE_QUIT_WINDOW: Duration = Duration::from_secs(2);
const MAX_RUNTIME_LINES_PER_TICK: usize = 300;
const MAX_CLIPBOARD_IMAGE_BYTES: usize = 5 * 1024 * 1024;
const MAX_CLIPBOARD_IMAGES_PER_MESSAGE: usize = 3;
const BANG_PREVIEW_MAX_LINES_PER_STREAM: usize = 8;
const BANG_PREVIEW_MAX_LINE_CHARS: usize = 240;

fn env_truthy(key: &str) -> bool {
    std::env::var(key)
        .ok()
        .as_deref()
        .map(|value| value == "1" || value.eq_ignore_ascii_case("true"))
        .unwrap_or(false)
}

#[derive(Clone, Copy, Debug)]
struct KeyDebugLog {
    code: KeyCode,
    modifiers: KeyModifiers,
    kind: KeyEventKind,
}

impl KeyDebugLog {
    fn from_event(event: &crossterm::event::KeyEvent) -> Self {
        Self {
            code: event.code,
            modifiers: event.modifiers,
            kind: event.kind,
        }
    }
}

impl fmt::Display for KeyDebugLog {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(
            f,
            "code={:?} mods={:?} kind={:?}",
            self.code, self.modifiers, self.kind
        )
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
enum ResumeMode {
    None,
    Picker,
    Id(String),
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum BasicCliMode {
    Run,
    Help,
    Version,
}

fn parse_basic_cli_mode() -> BasicCliMode {
    parse_basic_cli_mode_from_args(env::args().skip(1))
}

fn parse_basic_cli_mode_from_args(args: impl IntoIterator<Item = impl AsRef<str>>) -> BasicCliMode {
    for arg in args {
        let value = arg.as_ref();
        if value == "-h" || value == "--help" {
            return BasicCliMode::Help;
        }
        if value == "-V" || value == "-v" || value == "--version" {
            return BasicCliMode::Version;
        }
    }
    BasicCliMode::Run
}

fn resolve_version_label() -> String {
    let tui_version = env!("CARGO_PKG_VERSION");
    let cli_version = env::var("CODELIA_CLI_VERSION").ok();
    resolve_version_label_from_versions(cli_version.as_deref(), tui_version)
}

fn resolve_version_label_from_versions(cli_version: Option<&str>, _tui_version: &str) -> String {
    let normalized = cli_version.map(str::trim).filter(|value| !value.is_empty());
    match normalized {
        Some(cli) => format!("codelia {cli}"),
        None => "codelia".to_string(),
    }
}

fn print_basic_help() {
    println!("usage: codelia-tui [options]");
    println!();
    println!("options:");
    println!("  -h, --help                       Show this help");
    println!("  -V, -v, --version                Show version");
    println!("  --debug[=true|false]             Enable debug runtime/RPC log lines");
    println!("  --diagnostics[=true|false]       Enable per-call LLM diagnostics");
    println!("  -r, --resume [session_id]        Resume latest/session picker/session id");
    println!("  --initial-message <text>         Queue initial prompt");
    println!("  --initial-user-message <text>    Alias of --initial-message");
    println!("  --debug-perf[=true|false]        Enable perf panel");
    println!("  --ssh <user@host>                Use SSH remote runtime host");
    println!("  --ssh-port <port>                SSH port");
    println!("  --ssh-identity <path>            SSH private key path (-i)");
    println!("  --ssh-option <key=value>         Additional SSH option (-o), repeatable");
    println!("  --remote-command <cmd>           Remote runtime command");
    println!("  --remote-cwd <path>              Remote runtime working directory");
}

fn parse_resume_mode() -> ResumeMode {
    parse_resume_mode_from_args(env::args().skip(1))
}

fn parse_resume_mode_from_args(args: impl IntoIterator<Item = impl AsRef<str>>) -> ResumeMode {
    let mut args = args
        .into_iter()
        .map(|arg| arg.as_ref().to_string())
        .peekable();
    let mut mode = ResumeMode::None;
    while let Some(arg) = args.next() {
        if let Some(value) = arg.strip_prefix("--resume=") {
            mode = ResumeMode::Id(value.to_string());
            continue;
        }
        if arg == "-r" || arg == "--resume" {
            match args.peek() {
                Some(next) if !next.starts_with('-') => {
                    mode = ResumeMode::Id(next.to_string());
                    let _ = args.next();
                }
                _ => {
                    mode = ResumeMode::Picker;
                }
            }
        }
    }
    mode
}

fn parse_initial_message() -> Option<String> {
    parse_initial_message_from_args(env::args().skip(1))
}

fn parse_initial_message_from_args(
    args: impl IntoIterator<Item = impl AsRef<str>>,
) -> Option<String> {
    let mut args = args
        .into_iter()
        .map(|arg| arg.as_ref().to_string())
        .peekable();
    let mut message: Option<String> = None;
    while let Some(arg) = args.next() {
        if let Some(value) = arg.strip_prefix("--initial-message=") {
            message = Some(value.to_string());
            continue;
        }
        if let Some(value) = arg.strip_prefix("--initial-user-message=") {
            message = Some(value.to_string());
            continue;
        }
        if arg == "--initial-message" || arg == "--initial-user-message" {
            if let Some(next) = args.peek() {
                if !next.starts_with('-') {
                    message = Some(next.to_string());
                    let _ = args.next();
                }
            }
        }
    }
    message.filter(|value| !value.trim().is_empty())
}

fn take_next_cli_value<I>(args: &mut std::iter::Peekable<I>) -> Option<String>
where
    I: Iterator<Item = String>,
{
    if let Some(next) = args.peek() {
        if next.starts_with('-') {
            return None;
        }
    }
    args.next()
}

fn parse_runtime_cli_overrides_from_args(
    args: impl IntoIterator<Item = impl AsRef<str>>,
) -> Vec<(&'static str, String)> {
    let mut args = args
        .into_iter()
        .map(|arg| arg.as_ref().to_string())
        .peekable();
    let mut overrides = Vec::new();
    let mut ssh_parts: Vec<String> = Vec::new();
    let mut ssh_mode = false;

    while let Some(arg) = args.next() {
        if let Some(value) = arg.strip_prefix("--ssh=") {
            if !value.trim().is_empty() {
                overrides.push(("CODELIA_RUNTIME_SSH_HOST", value.to_string()));
                ssh_mode = true;
            }
            continue;
        }
        if arg == "--ssh" {
            if let Some(value) = take_next_cli_value(&mut args) {
                overrides.push(("CODELIA_RUNTIME_SSH_HOST", value));
                ssh_mode = true;
            }
            continue;
        }
        if let Some(value) = arg.strip_prefix("--ssh-port=") {
            if !value.trim().is_empty() {
                ssh_parts.push("-p".to_string());
                ssh_parts.push(value.to_string());
                ssh_mode = true;
            }
            continue;
        }
        if arg == "--ssh-port" {
            if let Some(value) = take_next_cli_value(&mut args) {
                ssh_parts.push("-p".to_string());
                ssh_parts.push(value);
                ssh_mode = true;
            }
            continue;
        }
        if let Some(value) = arg.strip_prefix("--ssh-identity=") {
            if !value.trim().is_empty() {
                ssh_parts.push("-i".to_string());
                ssh_parts.push(value.to_string());
                ssh_mode = true;
            }
            continue;
        }
        if arg == "--ssh-identity" {
            if let Some(value) = take_next_cli_value(&mut args) {
                ssh_parts.push("-i".to_string());
                ssh_parts.push(value);
                ssh_mode = true;
            }
            continue;
        }
        if let Some(value) = arg.strip_prefix("--ssh-option=") {
            if !value.trim().is_empty() {
                ssh_parts.push("-o".to_string());
                ssh_parts.push(value.to_string());
                ssh_mode = true;
            }
            continue;
        }
        if arg == "--ssh-option" {
            if let Some(value) = take_next_cli_value(&mut args) {
                ssh_parts.push("-o".to_string());
                ssh_parts.push(value);
                ssh_mode = true;
            }
            continue;
        }
        if let Some(value) = arg.strip_prefix("--remote-command=") {
            overrides.push(("CODELIA_RUNTIME_REMOTE_CMD", value.to_string()));
            ssh_mode = true;
            continue;
        }
        if arg == "--remote-command" {
            if let Some(value) = take_next_cli_value(&mut args) {
                overrides.push(("CODELIA_RUNTIME_REMOTE_CMD", value));
                ssh_mode = true;
            }
            continue;
        }
        if let Some(value) = arg.strip_prefix("--remote-cwd=") {
            overrides.push(("CODELIA_RUNTIME_REMOTE_CWD", value.to_string()));
            ssh_mode = true;
            continue;
        }
        if arg == "--remote-cwd" {
            if let Some(value) = take_next_cli_value(&mut args) {
                overrides.push(("CODELIA_RUNTIME_REMOTE_CWD", value));
                ssh_mode = true;
            }
        }
    }

    if ssh_mode {
        overrides.push(("CODELIA_RUNTIME_TRANSPORT", "ssh".to_string()));
    }
    if !ssh_parts.is_empty() {
        let defaults = vec![
            "-o".to_string(),
            "BatchMode=yes".to_string(),
            "-o".to_string(),
            "StrictHostKeyChecking=yes".to_string(),
            "-o".to_string(),
            "ServerAliveInterval=15".to_string(),
            "-o".to_string(),
            "ServerAliveCountMax=3".to_string(),
        ];
        let joined = defaults
            .into_iter()
            .chain(ssh_parts)
            .map(|part| shell_words::quote(&part).to_string())
            .collect::<Vec<_>>()
            .join(" ");
        overrides.push(("CODELIA_RUNTIME_SSH_OPTS", joined));
    }

    overrides
}

fn parse_runtime_cli_overrides() {
    for (key, value) in parse_runtime_cli_overrides_from_args(env::args().skip(1)) {
        unsafe {
            env::set_var(key, value);
        }
    }
}

fn parse_bool_like(value: &str) -> Option<bool> {
    match value.trim().to_ascii_lowercase().as_str() {
        "1" | "true" | "yes" | "on" => Some(true),
        "0" | "false" | "no" | "off" => Some(false),
        _ => None,
    }
}

fn cli_flag_enabled_from_args(flag: &str, args: impl IntoIterator<Item = impl AsRef<str>>) -> bool {
    args.into_iter().any(|arg| {
        let value = arg.as_ref();
        if value == flag {
            return true;
        }
        let prefix = format!("{flag}=");
        if let Some(raw) = value.strip_prefix(&prefix) {
            return parse_bool_like(raw).unwrap_or(false);
        }
        false
    })
}

fn cli_flag_enabled(flag: &str) -> bool {
    cli_flag_enabled_from_args(flag, env::args().skip(1))
}

fn can_auto_start_initial_message(app: &AppState) -> bool {
    if app.pending_model_list_id.is_some()
        || app.pending_model_set_id.is_some()
        || app.pending_theme_set_id.is_some()
        || app.pending_run_start_id.is_some()
        || app.pending_run_cancel_id.is_some()
        || app.pending_session_list_id.is_some()
        || app.pending_session_history_id.is_some()
        || app.pending_mcp_list_id.is_some()
        || app.pending_context_inspect_id.is_some()
        || app.pending_skills_list_id.is_some()
        || app.pending_lane_list_id.is_some()
        || app.pending_lane_status_id.is_some()
        || app.pending_lane_close_id.is_some()
        || app.pending_lane_create_id.is_some()
        || app.pending_logout_id.is_some()
        || app.pending_shell_exec_id.is_some()
    {
        return false;
    }
    if app.is_running() {
        return false;
    }
    app.confirm_dialog.is_none()
        && app.pending_confirm_dialog.is_none()
        && app.prompt_dialog.is_none()
        && app.pick_dialog.is_none()
        && app.provider_picker.is_none()
        && app.model_picker.is_none()
        && app.model_list_panel.is_none()
        && app.session_list_panel.is_none()
        && app.lane_list_panel.is_none()
}

type RuntimeStdin = BufWriter<ChildStdin>;
type RuntimeReceiver = Receiver<String>;

fn process_runtime_messages(
    app: &mut AppState,
    rx: &RuntimeReceiver,
    child_stdin: &mut RuntimeStdin,
    next_id: &mut impl FnMut() -> String,
) -> bool {
    let mut needs_redraw = false;
    let mut processed = 0usize;
    while processed < MAX_RUNTIME_LINES_PER_TICK {
        match rx.try_recv() {
            Ok(line) => {
                processed += 1;
                let parsed = parse_runtime_output(&line);
                if apply_parsed_output(app, parsed, child_stdin, next_id) {
                    needs_redraw = true;
                }
            }
            Err(TryRecvError::Empty) | Err(TryRecvError::Disconnected) => break,
        }
    }
    if processed == MAX_RUNTIME_LINES_PER_TICK {
        // Keep the UI responsive under heavy runtime output by yielding each tick.
        needs_redraw = true;
    }
    needs_redraw
}

fn format_duration(duration: Duration) -> String {
    let total_secs = duration.as_secs();
    if total_secs >= 60 {
        let minutes = total_secs / 60;
        let seconds = total_secs % 60;
        return format!("{minutes}m{seconds:02}s");
    }
    format!("{:.1}s", duration.as_secs_f64())
}

fn truncate_text(text: &str, max: usize) -> String {
    let count = text.chars().count();
    if count <= max {
        return text.to_string();
    }
    let take = max.saturating_sub(3);
    let truncated: String = text.chars().take(take).collect();
    format!("{truncated}...")
}

fn rpc_error_message(error: &Value) -> String {
    if let Some(message) = error
        .get("message")
        .and_then(|value| value.as_str())
        .map(str::trim)
        .filter(|value| !value.is_empty())
    {
        return message.to_string();
    }
    if let Some(message) = error
        .as_str()
        .map(str::trim)
        .filter(|value| !value.is_empty())
    {
        return message.to_string();
    }
    truncate_text(&error.to_string(), 180)
}

fn rpc_error_detail(error: &Value) -> String {
    match error {
        Value::Object(_) | Value::Array(_) => {
            serde_json::to_string_pretty(error).unwrap_or_else(|_| error.to_string())
        }
        Value::String(text) => text.clone(),
        _ => error.to_string(),
    }
}

fn push_rpc_error(app: &mut AppState, scope: &str, error: &Value) {
    let message = rpc_error_message(error);
    let summary = match error.get("code").and_then(|value| value.as_i64()) {
        Some(code) => format!("{scope} error: {message} (code {code})"),
        None => format!("{scope} error: {message}"),
    };
    app.push_error_report(summary, rpc_error_detail(error));
}

fn is_spacing_kind(kind: LogKind, enable_debug_print: bool) -> bool {
    match kind {
        LogKind::Space => false,
        LogKind::Runtime | LogKind::Rpc => enable_debug_print,
        _ => true,
    }
}

fn last_summary_kind(lines: &[LogLine], enable_debug_print: bool) -> Option<LogKind> {
    lines
        .iter()
        .rev()
        .find(|line| {
            line.tone() == LogTone::Summary && is_spacing_kind(line.kind(), enable_debug_print)
        })
        .map(LogLine::kind)
}

fn add_kind_spacing(
    lines: Vec<LogLine>,
    prev_summary_kind: Option<LogKind>,
    enable_debug_print: bool,
) -> Vec<LogLine> {
    let mut out = Vec::with_capacity(lines.len().saturating_mul(2));
    let mut last_summary = prev_summary_kind;

    for line in lines {
        if line.kind() == LogKind::Space {
            if !matches!(out.last().map(LogLine::kind), Some(LogKind::Space)) {
                out.push(line);
            }
            continue;
        }

        if line.tone() == LogTone::Summary && is_spacing_kind(line.kind(), enable_debug_print) {
            if let Some(prev_kind) = last_summary {
                if prev_kind != line.kind()
                    && !matches!(out.last().map(LogLine::kind), Some(LogKind::Space))
                {
                    out.push(LogLine::new(LogKind::Space, ""));
                }
            }
            last_summary = Some(line.kind());
        }

        out.push(line);
    }

    out
}

fn tool_call_with_status_icon(line: &LogLine, is_error: bool) -> LogLine {
    let icon_kind = if is_error {
        LogKind::Error
    } else {
        LogKind::ToolResult
    };
    let icon = if is_error { "✖" } else { "✔" };
    let mut spans = Vec::with_capacity(line.spans().len() + 2);
    spans.push(LogSpan::new(icon_kind, LogTone::Summary, icon));
    spans.push(LogSpan::new(LogKind::ToolCall, LogTone::Summary, " "));
    spans.extend(line.spans().iter().cloned());
    LogLine::new_with_spans(spans)
}

fn apply_parsed_output(
    app: &mut AppState,
    parsed: ParsedOutput,
    child_stdin: &mut RuntimeStdin,
    next_id: &mut impl FnMut() -> String,
) -> bool {
    let ParsedOutput {
        lines,
        status,
        status_run_id,
        context_left_percent,
        assistant_text,
        final_text,
        rpc_response,
        confirm_request,
        prompt_request,
        pick_request,
        clipboard_read_request,
        tool_call_start_id,
        tool_call_result,
        permission_preview_update,
    } = parsed;

    if let Some(status) = status {
        let terminal = matches!(status.as_str(), "completed" | "error" | "cancelled");
        if terminal {
            app.pending_run_start_id = None;
            app.pending_run_cancel_id = None;
            app.active_run_id = None;
            app.permission_preview_by_tool_call.clear();
        } else if let Some(run_id) = status_run_id {
            app.active_run_id = Some(run_id);
        }
        app.update_run_status(status);
    }
    if let Some(percent) = context_left_percent {
        app.context_left_percent = Some(percent);
    }
    if let Some(text) = assistant_text {
        app.last_assistant_text = Some(text);
    }

    let mut lines = lines;
    if let Some(update) = permission_preview_update {
        app.permission_preview_by_tool_call.insert(
            update.tool_call_id,
            crate::app::PermissionPreviewRecord {
                has_diff: update.has_diff,
                truncated: update.truncated,
                diff_fingerprint: update.diff_fingerprint,
            },
        );
    }
    if let Some(ToolCallResultUpdate {
        tool_call_id,
        tool,
        is_error,
        fallback_summary,
        edit_diff_fingerprint,
    }) = tool_call_result
    {
        let preview = app.permission_preview_by_tool_call.remove(&tool_call_id);
        let suppress_edit_diff_lines = tool == "edit"
            && preview.as_ref().is_some_and(|record| {
                record.has_diff
                    && !record.truncated
                    && record.diff_fingerprint.as_deref() == edit_diff_fingerprint.as_deref()
            });
        let mut inserted_fallback_summary = false;
        if let Some(index) = app.pending_tool_lines.remove(&tool_call_id) {
            if let Some(existing) = app.log.get(index).cloned() {
                let updated = tool_call_with_status_icon(&existing, is_error);
                app.replace_log_line(index, updated);
            } else {
                lines.insert(0, fallback_summary);
                inserted_fallback_summary = true;
            }
        } else {
            let fallback = match fallback_summary.plain_text().as_str() {
                "✔ Bash done" => LogLine::new(LogKind::ToolResult, "✔ Bash finished"),
                "✖ Bash failed" => LogLine::new(LogKind::Error, "✖ Bash failed"),
                "✔ Read done" => LogLine::new(LogKind::ToolResult, "✔ Read finished"),
                "✖ Read failed" => LogLine::new(LogKind::Error, "✖ Read failed"),
                _ => fallback_summary,
            };
            lines.insert(0, fallback);
            inserted_fallback_summary = true;
        }
        if suppress_edit_diff_lines {
            if inserted_fallback_summary {
                lines.truncate(1);
            } else {
                lines.clear();
            }
        }
    }
    let has_final = final_text.is_some();
    if let Some(final_text) = final_text {
        if app.last_assistant_text.as_deref() == Some(final_text.as_str()) {
            lines.clear();
        } else {
            app.last_assistant_text = Some(final_text);
        }
    }

    if has_final {
        if let Some(duration) = app.run_duration() {
            if !matches!(lines.last().map(LogLine::kind), Some(LogKind::Space)) {
                lines.push(LogLine::new(LogKind::Space, ""));
            }
            lines.push(LogLine::new_with_tone(
                LogKind::Status,
                LogTone::Detail,
                format!("⏱ Run duration: {}", format_duration(duration)),
            ));
        }
    }

    // Filter out debug print lines if debug print is disabled
    lines.retain(|line| {
        if app.enable_debug_print {
            return true;
        }
        !matches!(line.kind(), LogKind::Runtime | LogKind::Rpc)
    });

    let prev_summary = last_summary_kind(&app.log, app.enable_debug_print);
    let mut lines = add_kind_spacing(lines, prev_summary, app.enable_debug_print);
    if has_final && !matches!(lines.last().map(LogLine::kind), Some(LogKind::Space)) {
        lines.push(LogLine::new(LogKind::Space, ""));
    }
    let appended_from = app.log.len();
    app.extend_lines(lines);
    if let Some(tool_call_id) = tool_call_start_id {
        let tool_line_index = app
            .log
            .iter()
            .enumerate()
            .skip(appended_from)
            .find(|(_, line)| line.kind() == LogKind::ToolCall)
            .map(|(index, _)| index);
        if let Some(index) = tool_line_index {
            app.pending_tool_lines.insert(tool_call_id, index);
        }
    }

    let mut needs_redraw = true;
    if let Some(response) = rpc_response {
        if handle_rpc_response(app, response, child_stdin, next_id) {
            needs_redraw = true;
        }
    }
    if let Some(request) = confirm_request {
        handle_confirm_request(app, request);
        needs_redraw = true;
    }
    if let Some(request) = prompt_request {
        handle_prompt_request(app, request);
        needs_redraw = true;
    }
    if let Some(request) = pick_request {
        handle_pick_request(app, request);
        needs_redraw = true;
    }
    if let Some(request) = clipboard_read_request {
        handle_clipboard_read_request(app, request, child_stdin);
        needs_redraw = true;
    }
    needs_redraw
}

fn handle_prompt_request(app: &mut AppState, request: UiPromptRequest) {
    app.prompt_input.clear();
    if let Some(default_value) = request.default_value.as_deref() {
        app.prompt_input.set_from(default_value);
    }
    app.prompt_dialog = Some(PromptDialogState {
        id: request.id,
        title: request.title,
        message: request.message,
        multiline: request.multiline,
        secret: request.secret,
    });
}

fn handle_clipboard_read_request(
    app: &mut AppState,
    request: UiClipboardReadRequest,
    child_stdin: &mut RuntimeStdin,
) {
    let UiClipboardReadRequest {
        id,
        run_id,
        purpose,
        formats,
        max_bytes,
        prompt,
    } = request;
    let supports_image = formats.iter().any(|format| format == "image/png");
    if !supports_image {
        let msg = json!({
            "jsonrpc": "2.0",
            "id": id,
            "result": {
                "ok": false,
                "cancelled": false,
                "error": "unsupported clipboard format"
            }
        });
        if writeln!(child_stdin, "{}", msg)
            .and_then(|_| child_stdin.flush())
            .is_err()
        {
            app.push_line(
                LogKind::Error,
                "clipboard response error: failed to send unsupported format result",
            );
        }
        return;
    }

    let max_bytes = max_bytes.unwrap_or(MAX_CLIPBOARD_IMAGE_BYTES);
    if let Some(prompt) = prompt.filter(|value| !value.trim().is_empty()) {
        app.push_line(LogKind::Status, format!("Clipboard request: {prompt}"));
    }
    let _ = (run_id, purpose);
    let result = match read_clipboard_image_attachment(max_bytes) {
        Ok(image) => json!({
            "ok": true,
            "items": [{
                "type": "image",
                "media_type": "image/png",
                "data_url": image.data_url,
                "width": image.width,
                "height": image.height,
                "bytes": image.encoded_bytes
            }]
        }),
        Err(ClipboardImageError::NotAvailable) => json!({
            "ok": false,
            "cancelled": true,
            "error": "clipboard image not available"
        }),
        Err(ClipboardImageError::TooLarge { bytes, max_bytes }) => json!({
            "ok": false,
            "cancelled": false,
            "error": format!("clipboard image too large: {bytes} bytes (max {max_bytes})")
        }),
        Err(error) => json!({
            "ok": false,
            "cancelled": false,
            "error": format!("clipboard read failed: {error:?}")
        }),
    };

    let msg = json!({
        "jsonrpc": "2.0",
        "id": id,
        "result": result
    });
    if writeln!(child_stdin, "{}", msg)
        .and_then(|_| child_stdin.flush())
        .is_err()
    {
        app.push_line(
            LogKind::Error,
            "clipboard response error: failed to send result",
        );
    }
}

fn parse_onboarding_model_provider(title: &str) -> Option<String> {
    let prefix = "Select model (";
    if !title.starts_with(prefix) || !title.ends_with(')') {
        return None;
    }
    let provider = title
        .strip_prefix(prefix)?
        .strip_suffix(')')?
        .trim()
        .to_string();
    if provider.is_empty() {
        return None;
    }
    Some(provider)
}

fn parse_onboarding_model_costs(detail: Option<&str>) -> (String, String) {
    let Some(detail) = detail else {
        return ("-".to_string(), "-".to_string());
    };
    for part in detail.split('•').map(str::trim) {
        if let Some(raw) = part.strip_prefix("cost in/out ") {
            let raw = raw.strip_suffix(" USD per 1M").unwrap_or(raw);
            let (input, output) = raw.split_once('/').unwrap_or((raw, "-"));
            let input = input.trim();
            let output = output.trim();
            return (
                if input.is_empty() {
                    "-".to_string()
                } else {
                    input.to_string()
                },
                if output.is_empty() {
                    "-".to_string()
                } else {
                    output.to_string()
                },
            );
        }
    }
    ("-".to_string(), "-".to_string())
}

fn build_onboarding_model_list_panel(request: &UiPickRequest) -> Option<ModelListPanelState> {
    if request.multi || request.items.is_empty() {
        return None;
    }
    let provider = parse_onboarding_model_provider(&request.title)?;

    let mut name_width = "model".len();
    let mut cost_input_width = "in$ /1M".len();
    let mut cost_output_width = "out$ /1M".len();
    let mut rows_limits = Vec::new();
    let mut rows_cost = Vec::new();
    let mut model_ids = Vec::new();
    let mut pick_item_ids = Vec::new();

    for item in &request.items {
        name_width = name_width.max(item.label.len());
        let (cost_in, cost_out) = parse_onboarding_model_costs(item.detail.as_deref());
        cost_input_width = cost_input_width.max(cost_in.len());
        cost_output_width = cost_output_width.max(cost_out.len());
        rows_limits.push(format!(
            "  {:<name_width$}  {:>3}  {:>2}  {:>3}",
            item.label, "-", "-", "-",
        ));
        rows_cost.push(format!(
            "  {:<name_width$}  {:>cost_input_width$}  {:>cost_output_width$}",
            item.label, cost_in, cost_out,
        ));
        model_ids.push(item.label.clone());
        pick_item_ids.push(item.id.clone());
    }

    let header_limits = format!(
        "  {:<name_width$}  {:>3}  {:>2}  {:>3}",
        "model", "ctx", "in", "out",
    );
    let header_cost = format!(
        "  {:<name_width$}  {:>cost_input_width$}  {:>cost_output_width$}",
        "model", "in$ /1M", "out$ /1M",
    );

    Some(ModelListPanelState {
        title: format!("Models ({provider}) current: -"),
        header_limits,
        rows_limits,
        header_cost,
        rows_cost,
        model_ids,
        selected: 0,
        view_mode: ModelListViewMode::Limits,
        submit_action: ModelListSubmitAction::UiPick {
            request_id: request.id.clone(),
            item_ids: pick_item_ids,
        },
    })
}

fn handle_pick_request(app: &mut AppState, request: UiPickRequest) {
    if let Some(panel) = build_onboarding_model_list_panel(&request) {
        app.pick_dialog = None;
        app.model_list_panel = Some(panel);
        return;
    }
    let chosen = vec![false; request.items.len()];
    app.pick_dialog = Some(PickDialogState {
        id: request.id,
        title: request.title,
        items: request
            .items
            .into_iter()
            .map(|item| PickDialogItem {
                id: item.id,
                label: item.label,
                detail: item.detail,
            })
            .collect(),
        selected: 0,
        multi: request.multi,
        chosen,
    });
}

fn update_server_capabilities_from_response(app: &mut AppState, response: &RpcResponse) {
    if response.error.is_some() {
        return;
    }
    let Some(result) = response.result.as_ref() else {
        return;
    };
    let Some(server_capabilities) = result
        .get("server_capabilities")
        .and_then(|value| value.as_object())
    else {
        return;
    };
    if let Some(supports_mcp_list) = server_capabilities
        .get("supports_mcp_list")
        .and_then(|value| value.as_bool())
    {
        app.supports_mcp_list = supports_mcp_list;
    }
    if let Some(supports_skills_list) = server_capabilities
        .get("supports_skills_list")
        .and_then(|value| value.as_bool())
    {
        app.supports_skills_list = supports_skills_list;
    }
    if let Some(supports_context_inspect) = server_capabilities
        .get("supports_context_inspect")
        .and_then(|value| value.as_bool())
    {
        app.supports_context_inspect = supports_context_inspect;
    }
    if let Some(supports_tool_call) = server_capabilities
        .get("supports_tool_call")
        .and_then(|value| value.as_bool())
    {
        app.supports_tool_call = supports_tool_call;
    }
    if let Some(supports_shell_exec) = server_capabilities
        .get("supports_shell_exec")
        .and_then(|value| value.as_bool())
    {
        app.supports_shell_exec = supports_shell_exec;
    }
    if let Some(supports_theme_set) = server_capabilities
        .get("supports_theme_set")
        .and_then(|value| value.as_bool())
    {
        app.supports_theme_set = supports_theme_set;
    }
}

fn handle_rpc_response(
    app: &mut AppState,
    response: RpcResponse,
    child_stdin: &mut RuntimeStdin,
    next_id: &mut impl FnMut() -> String,
) -> bool {
    update_server_capabilities_from_response(app, &response);

    let handled_session_list = app.pending_session_list_id.as_deref() == Some(response.id.as_str());
    if handled_session_list {
        app.pending_session_list_id = None;
        handle_session_list_response(app, response);
        return true;
    }

    let handled_session_history =
        app.pending_session_history_id.as_deref() == Some(response.id.as_str());
    if handled_session_history {
        app.pending_session_history_id = None;
        handle_session_history_response(app, response);
        return true;
    }

    let handled_model_list = app.pending_model_list_id.as_deref() == Some(response.id.as_str());
    if handled_model_list {
        app.pending_model_list_id = None;
        let mode = app
            .pending_model_list_mode
            .take()
            .unwrap_or(ModelListMode::Picker);
        handle_model_list_response(app, mode, response);
        return true;
    }

    let handled_model_set = app.pending_model_set_id.as_deref() == Some(response.id.as_str());
    if handled_model_set {
        app.pending_model_set_id = None;
        handle_model_set_response(app, response);
        return true;
    }

    let handled_mcp_list = app.pending_mcp_list_id.as_deref() == Some(response.id.as_str());
    if handled_mcp_list {
        app.pending_mcp_list_id = None;
        let detail_id = app.pending_mcp_detail_id.take();
        handle_mcp_list_response(app, response, detail_id.as_deref());
        return true;
    }

    let handled_lane_list = app.pending_lane_list_id.as_deref() == Some(response.id.as_str());
    if handled_lane_list {
        app.pending_lane_list_id = None;
        handle_lane_list_response(app, response);
        return true;
    }

    let handled_lane_status = app.pending_lane_status_id.as_deref() == Some(response.id.as_str());
    if handled_lane_status {
        app.pending_lane_status_id = None;
        handle_lane_status_response(app, response);
        return true;
    }

    let handled_lane_close = app.pending_lane_close_id.as_deref() == Some(response.id.as_str());
    if handled_lane_close {
        app.pending_lane_close_id = None;
        handle_lane_close_response(app, response, child_stdin, next_id);
        return true;
    }

    let handled_lane_create = app.pending_lane_create_id.as_deref() == Some(response.id.as_str());
    if handled_lane_create {
        app.pending_lane_create_id = None;
        handle_lane_create_response(app, response, child_stdin, next_id);
        return true;
    }

    let handled_skills_list = app.pending_skills_list_id.as_deref() == Some(response.id.as_str());
    if handled_skills_list {
        app.pending_skills_list_id = None;
        handle_skills_list_response(app, response);
        return true;
    }

    let handled_context_inspect =
        app.pending_context_inspect_id.as_deref() == Some(response.id.as_str());
    if handled_context_inspect {
        app.pending_context_inspect_id = None;
        handle_context_inspect_response(app, response);
        return true;
    }

    let handled_logout = app.pending_logout_id.as_deref() == Some(response.id.as_str());
    if handled_logout {
        app.pending_logout_id = None;
        handle_logout_response(app, response);
        return true;
    }

    let handled_shell_exec = app.pending_shell_exec_id.as_deref() == Some(response.id.as_str());
    if handled_shell_exec {
        app.pending_shell_exec_id = None;
        handle_shell_exec_response(app, response);
        return true;
    }

    let handled_theme_set = app.pending_theme_set_id.as_deref() == Some(response.id.as_str());
    if handled_theme_set {
        app.pending_theme_set_id = None;
        handle_theme_set_response(app, response);
        return true;
    }

    let handled_run_start = app.pending_run_start_id.as_deref() == Some(response.id.as_str());
    if handled_run_start {
        app.pending_run_start_id = None;
        handle_run_start_response(app, response);
        return true;
    }

    let handled_run_cancel = app.pending_run_cancel_id.as_deref() == Some(response.id.as_str());
    if handled_run_cancel {
        app.pending_run_cancel_id = None;
        handle_run_cancel_response(app, response);
        return true;
    }

    if let Some(error) = response.error {
        push_rpc_error(app, "rpc", &error);
        return true;
    }
    if let Some(result) = response.result {
        if app.enable_debug_print {
            app.push_line(LogKind::Rpc, format!("rpc result: {result}"));
        }
        return true;
    }

    false
}

fn handle_session_list_response(app: &mut AppState, response: RpcResponse) {
    if let Some(error) = response.error {
        push_rpc_error(app, "session.list", &error);
        return;
    }
    if let Some(result) = response.result {
        apply_session_list_result(app, &result);
    }
}

fn handle_session_history_response(app: &mut AppState, response: RpcResponse) {
    if let Some(error) = response.error {
        push_rpc_error(app, "session.history", &error);
        return;
    }
    if let Some(result) = response.result {
        let runs = result
            .get("runs")
            .and_then(|value| value.as_u64())
            .unwrap_or(0);
        let events = result
            .get("events_sent")
            .and_then(|value| value.as_u64())
            .unwrap_or(0);
        let truncated = result
            .get("truncated")
            .and_then(|value| value.as_bool())
            .unwrap_or(false);
        let suffix = if truncated { " (truncated)" } else { "" };
        app.push_line(
            LogKind::Status,
            format!("History restored: {events} events from {runs} runs{suffix}"),
        );
        app.push_line(LogKind::Space, "");
    }
}

fn truncate_bang_preview_line(value: &str) -> String {
    let char_count = value.chars().count();
    if char_count <= BANG_PREVIEW_MAX_LINE_CHARS {
        return value.to_string();
    }
    let head = value
        .chars()
        .take(BANG_PREVIEW_MAX_LINE_CHARS)
        .collect::<String>();
    format!("{head}...[truncated]")
}

fn push_bang_stream_preview(
    app: &mut AppState,
    stream_label: &str,
    output: Option<&str>,
    truncated: bool,
    cache_id: Option<&str>,
) {
    let Some(raw) = output else {
        return;
    };
    if raw.trim().is_empty() {
        return;
    }

    app.push_line(LogKind::Status, format!("bang {stream_label}:"));

    let mut line_count = 0usize;
    for line in raw.lines().take(BANG_PREVIEW_MAX_LINES_PER_STREAM) {
        line_count += 1;
        app.push_line(
            LogKind::Runtime,
            format!("  {}", truncate_bang_preview_line(line)),
        );
    }

    let total_lines = raw.lines().count();
    if total_lines > line_count {
        app.push_line(
            LogKind::Status,
            format!(
                "  ...[{} more lines]",
                total_lines.saturating_sub(line_count)
            ),
        );
    }

    if truncated {
        if let Some(cache_id) = cache_id {
            app.push_line(
                LogKind::Status,
                format!("  (truncated; full output: tool_output_cache ref `{cache_id}`)"),
            );
        } else {
            app.push_line(LogKind::Status, "  (truncated output)");
        }
    }
}

fn handle_shell_exec_response(app: &mut AppState, response: RpcResponse) {
    if let Some(error) = response.error {
        app.push_line(LogKind::Error, format!("shell.exec error: {error}"));
        return;
    }
    let Some(result) = response.result else {
        app.push_line(LogKind::Error, "shell.exec returned no result");
        return;
    };
    let command_preview = result
        .get("command_preview")
        .and_then(|value| value.as_str())
        .unwrap_or("")
        .to_string();
    let exit_code = result.get("exit_code").and_then(|value| value.as_i64());
    let signal = result
        .get("signal")
        .and_then(|value| value.as_str())
        .map(|value| value.to_string());
    let duration_ms = result
        .get("duration_ms")
        .and_then(|value| value.as_u64())
        .unwrap_or(0);
    let truncated = result.get("truncated").and_then(|value| value.as_object());
    let truncated_stdout = truncated
        .and_then(|value| value.get("stdout"))
        .and_then(|value| value.as_bool())
        .unwrap_or(false);
    let truncated_stderr = truncated
        .and_then(|value| value.get("stderr"))
        .and_then(|value| value.as_bool())
        .unwrap_or(false);
    let truncated_combined = truncated
        .and_then(|value| value.get("combined"))
        .and_then(|value| value.as_bool())
        .unwrap_or(false);

    let stdout = result
        .get("stdout")
        .and_then(|value| value.as_str())
        .map(|value| value.to_string());
    let stderr = result
        .get("stderr")
        .and_then(|value| value.as_str())
        .map(|value| value.to_string());

    let shell_result = crate::app::PendingShellResult {
        id: format!("shell_{}", app.pending_shell_results.len() + 1),
        command_preview,
        exit_code,
        signal,
        duration_ms,
        stdout: if truncated_stdout {
            None
        } else {
            stdout.clone()
        },
        stderr: if truncated_stderr {
            None
        } else {
            stderr.clone()
        },
        stdout_excerpt: if truncated_stdout { stdout } else { None },
        stderr_excerpt: if truncated_stderr { stderr } else { None },
        stdout_cache_id: result
            .get("stdout_cache_id")
            .and_then(|value| value.as_str())
            .map(|value| value.to_string()),
        stderr_cache_id: result
            .get("stderr_cache_id")
            .and_then(|value| value.as_str())
            .map(|value| value.to_string()),
        truncated_stdout,
        truncated_stderr,
        truncated_combined,
    };
    let exit_label = shell_result
        .exit_code
        .map(|code| code.to_string())
        .unwrap_or_else(|| "null".to_string());
    app.pending_shell_results.push(shell_result.clone());
    app.push_line(
        LogKind::Status,
        format!(
            "bang exec done: exit={exit_label} duration={}ms queued={}",
            duration_ms,
            app.pending_shell_results.len()
        ),
    );
    push_bang_stream_preview(
        app,
        "stdout",
        shell_result
            .stdout
            .as_deref()
            .or(shell_result.stdout_excerpt.as_deref()),
        shell_result.truncated_stdout,
        shell_result.stdout_cache_id.as_deref(),
    );
    push_bang_stream_preview(
        app,
        "stderr",
        shell_result
            .stderr
            .as_deref()
            .or(shell_result.stderr_excerpt.as_deref()),
        shell_result.truncated_stderr,
        shell_result.stderr_cache_id.as_deref(),
    );
}

fn handle_run_start_response(app: &mut AppState, response: RpcResponse) {
    if let Some(error) = response.error {
        app.update_run_status("error".to_string());
        app.active_run_id = None;
        push_rpc_error(app, "run.start", &error);
        return;
    }
    if let Some(result) = response.result {
        let run_id = result
            .get("run_id")
            .and_then(|value| value.as_str())
            .map(|value| value.to_string());
        if run_id.is_none() {
            app.update_run_status("error".to_string());
            app.active_run_id = None;
            app.push_line(LogKind::Error, "run.start returned no run_id");
            return;
        }
        app.active_run_id = run_id;
        app.pending_shell_results.clear();
        if app.run_status.as_deref() == Some("starting") {
            app.update_run_status("running".to_string());
        }
    }
}

fn handle_logout_response(app: &mut AppState, response: RpcResponse) {
    if let Some(error) = response.error {
        push_rpc_error(app, "auth.logout", &error);
        return;
    }
    let Some(result) = response.result else {
        app.push_line(LogKind::Error, "auth.logout returned no result");
        return;
    };

    let session_cleared = result
        .get("session_cleared")
        .and_then(|value| value.as_bool())
        .unwrap_or(true);
    let cancelled = result
        .get("cancelled")
        .and_then(|value| value.as_bool())
        .unwrap_or(false);
    if cancelled {
        app.push_line(LogKind::Status, "Logout cancelled.");
        app.push_line(LogKind::Space, "");
        return;
    }
    let ok = result
        .get("ok")
        .and_then(|value| value.as_bool())
        .unwrap_or(true);
    if !ok {
        app.push_line(LogKind::Error, "auth.logout failed");
        return;
    }
    if session_cleared {
        app.session_id = None;
    }

    app.push_line(
        LogKind::Status,
        "Logged out. Local auth credentials cleared.",
    );
    if session_cleared {
        app.push_line(LogKind::Status, "Session reset.");
    }
    app.push_line(LogKind::Space, "");
}

fn handle_theme_set_response(app: &mut AppState, response: RpcResponse) {
    if let Some(error) = response.error {
        push_rpc_error(app, "theme.set", &error);
        return;
    }
    let name = response
        .result
        .as_ref()
        .and_then(|result| result.get("name"))
        .and_then(|value| value.as_str())
        .unwrap_or("(unknown)");
    if let Some(parsed) = parse_theme_name(name) {
        apply_theme_name(parsed);
    }
    let scope = response
        .result
        .as_ref()
        .and_then(|result| result.get("scope"))
        .and_then(|value| value.as_str())
        .unwrap_or("unknown");
    let path = response
        .result
        .as_ref()
        .and_then(|result| result.get("path"))
        .and_then(|value| value.as_str())
        .unwrap_or("(unknown path)");
    app.push_line(
        LogKind::Status,
        format!("Saved theme '{name}' to [{scope}] {path} (applied)"),
    );
}

fn handle_run_cancel_response(app: &mut AppState, response: RpcResponse) {
    if let Some(error) = response.error {
        push_rpc_error(app, "run.cancel", &error);
        return;
    }
    if app.enable_debug_print {
        if let Some(result) = response.result {
            app.push_line(LogKind::Rpc, format!("run.cancel result: {result}"));
        }
    }
}

fn extract_tool_call_result(response: RpcResponse) -> Result<Value, String> {
    if let Some(error) = response.error {
        return Err(error.to_string());
    }
    let result = response
        .result
        .ok_or_else(|| "tool.call returned no result".to_string())?;
    let ok = result
        .get("ok")
        .and_then(|value| value.as_bool())
        .unwrap_or(false);
    if !ok {
        return Err("tool.call failed".to_string());
    }
    result
        .get("result")
        .cloned()
        .ok_or_else(|| "tool.call returned no payload".to_string())
}

fn handle_lane_list_response(app: &mut AppState, response: RpcResponse) {
    match extract_tool_call_result(response) {
        Ok(result) => apply_lane_list_result(app, &result),
        Err(error) => app.push_error_report("lane_list error", error),
    }
}

fn handle_lane_status_response(app: &mut AppState, response: RpcResponse) {
    let result = match extract_tool_call_result(response) {
        Ok(result) => result,
        Err(error) => {
            app.push_error_report("lane_status error", error);
            return;
        }
    };
    let lane = result.get("lane").unwrap_or(&result);
    let lane_id = lane
        .get("lane_id")
        .and_then(|value| value.as_str())
        .unwrap_or("-");
    let state = lane
        .get("state")
        .and_then(|value| value.as_str())
        .unwrap_or("-");
    app.push_line(LogKind::Status, format!("Lane {lane_id}: {state}"));
    if let Some(mux_live) = result.get("mux_live").and_then(|value| value.as_bool()) {
        app.push_line(LogKind::Status, format!("  mux_live={mux_live}"));
    }
    app.push_line(LogKind::Space, "");
}

fn handle_lane_close_response(
    app: &mut AppState,
    response: RpcResponse,
    child_stdin: &mut RuntimeStdin,
    next_id: &mut impl FnMut() -> String,
) {
    let result = match extract_tool_call_result(response) {
        Ok(result) => result,
        Err(error) => {
            app.push_error_report("lane_close error", error);
            return;
        }
    };
    let lane_id = result
        .get("lane")
        .and_then(|lane| lane.get("lane_id"))
        .and_then(|value| value.as_str())
        .unwrap_or("-");
    app.push_line(LogKind::Status, format!("Closed lane {lane_id}"));
    app.push_line(LogKind::Space, "");

    let request_id = next_id();
    app.pending_lane_list_id = Some(request_id.clone());
    if let Err(error) = send_tool_call(child_stdin, &request_id, "lane_list", json!({})) {
        app.pending_lane_list_id = None;
        app.push_error_report("send error", error.to_string());
    }
}

fn handle_lane_create_response(
    app: &mut AppState,
    response: RpcResponse,
    child_stdin: &mut RuntimeStdin,
    next_id: &mut impl FnMut() -> String,
) {
    let result = match extract_tool_call_result(response) {
        Ok(result) => result,
        Err(error) => {
            app.push_error_report("lane_create error", error);
            return;
        }
    };

    let lane_id = result
        .get("lane")
        .and_then(|lane| lane.get("lane_id"))
        .and_then(|value| value.as_str())
        .unwrap_or("-");
    app.push_line(LogKind::Status, format!("Created lane {lane_id}"));
    if let Some(attach) = result
        .get("hints")
        .and_then(|hints| hints.get("attach_command"))
        .and_then(|value| value.as_str())
    {
        app.push_line(LogKind::Status, format!("Attach: {attach}"));
    }
    app.push_line(LogKind::Space, "");

    let request_id = next_id();
    app.pending_lane_list_id = Some(request_id.clone());
    if let Err(error) = send_tool_call(child_stdin, &request_id, "lane_list", json!({})) {
        app.pending_lane_list_id = None;
        app.push_error_report("send error", error.to_string());
    }
}

fn apply_lane_list_result(app: &mut AppState, result: &Value) {
    let lanes = result
        .get("lanes")
        .and_then(|value| value.as_array())
        .cloned()
        .unwrap_or_default();

    let mut rows = Vec::new();
    let mut items = Vec::new();
    for lane in lanes {
        let lane_id = lane
            .get("lane_id")
            .and_then(|value| value.as_str())
            .unwrap_or("")
            .to_string();
        if lane_id.is_empty() {
            continue;
        }
        let task_id = lane
            .get("task_id")
            .and_then(|value| value.as_str())
            .unwrap_or("-")
            .to_string();
        let state = lane
            .get("state")
            .and_then(|value| value.as_str())
            .unwrap_or("-")
            .to_string();
        let mux_backend = lane
            .get("mux_backend")
            .and_then(|value| value.as_str())
            .unwrap_or("-")
            .to_string();
        rows.push(format!("{lane_id} | {task_id} | {state} | {mux_backend}"));
        items.push(LaneListItem { lane_id });
    }
    rows.push("+ New lane".to_string());

    app.model_list_panel = None;
    app.session_list_panel = None;
    app.context_panel = None;
    app.skills_list_panel = None;
    app.theme_list_panel = None;
    app.prompt_dialog = None;
    app.pick_dialog = None;
    app.lane_list_panel = Some(LaneListPanelState {
        title: "Lanes".to_string(),
        header: "lane_id | task_id | state | mux".to_string(),
        rows,
        lanes: items,
        selected: 0,
    });
}

fn handle_mcp_list_response(app: &mut AppState, response: RpcResponse, detail_id: Option<&str>) {
    if let Some(error) = response.error {
        push_rpc_error(app, "mcp.list", &error);
        return;
    }
    if let Some(result) = response.result {
        apply_mcp_list_result(app, &result, detail_id);
    }
}

fn handle_context_inspect_response(app: &mut AppState, response: RpcResponse) {
    if let Some(error) = response.error {
        push_rpc_error(app, "context.inspect", &error);
        return;
    }
    if let Some(result) = response.result {
        apply_context_inspect_result(app, &result);
    }
}

fn handle_skills_list_response(app: &mut AppState, response: RpcResponse) {
    if let Some(error) = response.error {
        app.skills_catalog_loaded = true;
        app.pending_skills_query = None;
        app.pending_skills_scope = None;
        push_rpc_error(app, "skills.list", &error);
        return;
    }
    if let Some(result) = response.result {
        apply_skills_list_result(app, &result);
    }
}

fn apply_skills_list_result(app: &mut AppState, result: &Value) {
    let skills = result
        .get("skills")
        .and_then(|value| value.as_array())
        .cloned()
        .unwrap_or_default();
    let errors = result
        .get("errors")
        .and_then(|value| value.as_array())
        .cloned()
        .unwrap_or_default();
    let truncated = result
        .get("truncated")
        .and_then(|value| value.as_bool())
        .unwrap_or(false);
    let open_panel = app.pending_skills_query.is_some() || app.pending_skills_scope.is_some();
    let query = app.pending_skills_query.take().unwrap_or_default();
    let scope_filter = app
        .pending_skills_scope
        .take()
        .unwrap_or(SkillsScopeFilter::All);

    let mut items = Vec::new();
    for skill in skills {
        let name = skill
            .get("name")
            .and_then(|value| value.as_str())
            .unwrap_or("")
            .to_string();
        let description = skill
            .get("description")
            .and_then(|value| value.as_str())
            .unwrap_or("")
            .to_string();
        let path = skill
            .get("path")
            .and_then(|value| value.as_str())
            .unwrap_or("")
            .to_string();
        let scope = skill
            .get("scope")
            .and_then(|value| value.as_str())
            .unwrap_or("user")
            .to_string();
        if name.is_empty() || path.is_empty() {
            continue;
        }
        let enabled = !app.disabled_skill_paths.contains(&path);
        items.push(SkillsListItemState {
            name,
            description,
            path,
            scope,
            enabled,
        });
    }

    app.skills_catalog_loaded = true;
    app.skills_catalog_items = items.clone();

    if !open_panel {
        return;
    }

    if items.is_empty() {
        app.push_line(LogKind::Status, "No skills found.");
        app.push_line(LogKind::Space, "");
        app.skills_list_panel = None;
        app.theme_list_panel = None;
        return;
    }

    if truncated {
        app.push_line(
            LogKind::Status,
            "skills.list result truncated; refine search in the panel.",
        );
    }
    if !errors.is_empty() {
        app.push_line(
            LogKind::Status,
            format!("skills.list skipped {} invalid skill files.", errors.len()),
        );
    }
    if truncated || !errors.is_empty() {
        app.push_line(LogKind::Space, "");
    }

    let mut panel = SkillsListPanelState {
        title: format!(
            "Skills picker ({}){}{}",
            items.len(),
            if truncated { " truncated" } else { "" },
            if errors.is_empty() {
                String::new()
            } else {
                format!(", errors={}", errors.len())
            }
        ),
        header: String::new(),
        rows: Vec::new(),
        filtered_indices: Vec::new(),
        items,
        selected: 0,
        search_query: query,
        scope_filter,
    };
    panel.rebuild();
    app.model_list_panel = None;
    app.session_list_panel = None;
    app.context_panel = None;
    app.theme_list_panel = None;
    app.skills_list_panel = Some(panel);
}

fn format_context_file_row(file: &Value) -> Option<String> {
    let path = file.get("path").and_then(|value| value.as_str())?;
    let mtime = file
        .get("mtime_ms")
        .and_then(|value| value.as_i64())
        .unwrap_or(0);
    let size = file
        .get("size_bytes")
        .and_then(|value| value.as_u64())
        .unwrap_or(0);
    Some(format!("- {path} (mtime={mtime}, size={size})"))
}

fn apply_context_inspect_result(app: &mut AppState, result: &Value) {
    let mut rows = Vec::new();

    if let Some(percent) = app.context_left_percent {
        rows.push(format!("context_left_percent: {percent}%"));
    }
    if let Some(runtime_working_dir) = result
        .get("runtime_working_dir")
        .and_then(|value| value.as_str())
    {
        rows.push(format!("runtime_working_dir: {runtime_working_dir}"));
    }
    if let Some(runtime_sandbox_root) = result
        .get("runtime_sandbox_root")
        .and_then(|value| value.as_str())
    {
        rows.push(format!("runtime_sandbox_root: {runtime_sandbox_root}"));
    }
    if let Some(ui_context) = result.get("ui_context").and_then(|value| value.as_object()) {
        if let Some(cwd) = ui_context.get("cwd").and_then(|value| value.as_str()) {
            rows.push(format!("ui.cwd: {cwd}"));
        }
        if let Some(workspace_root) = ui_context
            .get("workspace_root")
            .and_then(|value| value.as_str())
        {
            rows.push(format!("ui.workspace_root: {workspace_root}"));
        }
        if let Some(active_file_path) = ui_context
            .get("active_file_path")
            .and_then(|value| value.as_str())
        {
            rows.push(format!("ui.active_file: {active_file_path}"));
        }
    }

    rows.push(String::new());
    rows.push("AGENTS".to_string());

    if let Some(agents) = result.get("agents").and_then(|value| value.as_object()) {
        let enabled = agents
            .get("enabled")
            .and_then(|value| value.as_bool())
            .unwrap_or(false);
        let root_dir = agents
            .get("root_dir")
            .and_then(|value| value.as_str())
            .unwrap_or("-");
        rows.push(format!("enabled: {enabled}"));
        rows.push(format!("root_dir: {root_dir}"));
        if let Some(working_dir) = agents.get("working_dir").and_then(|value| value.as_str()) {
            rows.push(format!("working_dir: {working_dir}"));
        }

        if let Some(initial_files) = agents
            .get("initial_files")
            .and_then(|value| value.as_array())
        {
            if initial_files.is_empty() {
                rows.push("initial_files: (none)".to_string());
            } else {
                rows.push("initial_files:".to_string());
                for file in initial_files {
                    if let Some(line) = format_context_file_row(file) {
                        rows.push(format!("  {line}"));
                    }
                }
            }
        }
        if let Some(loaded_files) = agents
            .get("loaded_files")
            .and_then(|value| value.as_array())
        {
            if loaded_files.is_empty() {
                rows.push("loaded_files: (none)".to_string());
            } else {
                rows.push("loaded_files:".to_string());
                for file in loaded_files {
                    if let Some(line) = format_context_file_row(file) {
                        rows.push(format!("  {line}"));
                    }
                }
            }
        }
    } else {
        rows.push("unavailable".to_string());
    }

    rows.push(String::new());
    rows.push("SKILLS".to_string());
    if let Some(skills) = result.get("skills").and_then(|value| value.as_object()) {
        if let Some(root_dir) = skills.get("root_dir").and_then(|value| value.as_str()) {
            rows.push(format!("root_dir: {root_dir}"));
        }
        if let Some(working_dir) = skills.get("working_dir").and_then(|value| value.as_str()) {
            rows.push(format!("working_dir: {working_dir}"));
        }
        if let Some(catalog) = skills.get("catalog").and_then(|value| value.as_object()) {
            let skills_count = catalog
                .get("skills")
                .and_then(|value| value.as_array())
                .map(|value| value.len())
                .unwrap_or(0);
            let errors_count = catalog
                .get("errors")
                .and_then(|value| value.as_array())
                .map(|value| value.len())
                .unwrap_or(0);
            let truncated = catalog
                .get("truncated")
                .and_then(|value| value.as_bool())
                .unwrap_or(false);
            rows.push(format!(
                "catalog: skills={skills_count}, errors={errors_count}, truncated={truncated}"
            ));
            if let Some(skill_items) = catalog.get("skills").and_then(|value| value.as_array()) {
                if skill_items.is_empty() {
                    rows.push("skills: (none)".to_string());
                } else {
                    rows.push("skills:".to_string());
                    for item in skill_items {
                        let name = item
                            .get("name")
                            .and_then(|value| value.as_str())
                            .unwrap_or("-");
                        let scope = item
                            .get("scope")
                            .and_then(|value| value.as_str())
                            .unwrap_or("-");
                        let path = item
                            .get("path")
                            .and_then(|value| value.as_str())
                            .unwrap_or("-");
                        rows.push(format!("  - [{scope}] {name} ({path})"));
                    }
                }
            }
        }
        if let Some(loaded_versions) = skills
            .get("loaded_versions")
            .and_then(|value| value.as_array())
        {
            if loaded_versions.is_empty() {
                rows.push("loaded_versions: (none)".to_string());
            } else {
                rows.push("loaded_versions:".to_string());
                for entry in loaded_versions {
                    let path = entry
                        .get("path")
                        .and_then(|value| value.as_str())
                        .unwrap_or("-");
                    let mtime = entry
                        .get("mtime_ms")
                        .and_then(|value| value.as_i64())
                        .unwrap_or(0);
                    rows.push(format!("  - {path} (mtime={mtime})"));
                }
            }
        }
    } else {
        rows.push("unavailable".to_string());
    }
    app.model_list_panel = None;
    app.session_list_panel = None;
    app.lane_list_panel = None;
    app.skills_list_panel = None;
    app.theme_list_panel = None;
    app.context_panel = Some(ContextPanelState {
        title: "Context".to_string(),
        header: "snapshot".to_string(),
        rows,
        selected: 0,
    });
}

fn apply_mcp_list_result(app: &mut AppState, result: &Value, detail_id: Option<&str>) {
    let servers = result
        .get("servers")
        .and_then(|value| value.as_array())
        .cloned()
        .unwrap_or_default();

    if servers.is_empty() {
        app.push_line(LogKind::Status, "no MCP servers configured");
        app.push_line(LogKind::Space, "");
        return;
    }

    if let Some(detail_id) = detail_id {
        let server = servers.iter().find(|entry| {
            entry
                .get("id")
                .and_then(|value| value.as_str())
                .map(|value| value == detail_id)
                .unwrap_or(false)
        });
        let Some(server) = server else {
            app.push_line(LogKind::Error, format!("MCP server not found: {detail_id}"));
            app.push_line(LogKind::Space, "");
            return;
        };
        let id = server
            .get("id")
            .and_then(|value| value.as_str())
            .unwrap_or(detail_id);
        let transport = server
            .get("transport")
            .and_then(|value| value.as_str())
            .unwrap_or("-");
        let source = server
            .get("source")
            .and_then(|value| value.as_str())
            .unwrap_or("-");
        let enabled = server
            .get("enabled")
            .and_then(|value| value.as_bool())
            .unwrap_or(false);
        let state = server
            .get("state")
            .and_then(|value| value.as_str())
            .unwrap_or("-");
        let tools = server
            .get("tools")
            .and_then(|value| value.as_u64())
            .map(|value| value.to_string())
            .unwrap_or_else(|| "0".to_string());
        app.push_line(LogKind::Status, format!("MCP {id}"));
        app.push_line(
            LogKind::Status,
            format!(
                "  transport={transport} source={source} enabled={enabled} state={state} tools={tools}"
            ),
        );
        if let Some(last_error) = server.get("last_error").and_then(|value| value.as_str()) {
            app.push_line(LogKind::Error, format!("  last_error={last_error}"));
        }
        if let Some(last_connected_at) = server
            .get("last_connected_at")
            .and_then(|value| value.as_str())
        {
            app.push_line(
                LogKind::Status,
                format!("  last_connected_at={last_connected_at}"),
            );
        }
        app.push_line(LogKind::Space, "");
        return;
    }

    app.push_line(
        LogKind::Status,
        "MCP servers: id transport source enabled state tools",
    );
    for server in &servers {
        let id = server
            .get("id")
            .and_then(|value| value.as_str())
            .unwrap_or("-");
        let transport = server
            .get("transport")
            .and_then(|value| value.as_str())
            .unwrap_or("-");
        let source = server
            .get("source")
            .and_then(|value| value.as_str())
            .unwrap_or("-");
        let enabled = server
            .get("enabled")
            .and_then(|value| value.as_bool())
            .unwrap_or(false);
        let state = server
            .get("state")
            .and_then(|value| value.as_str())
            .unwrap_or("-");
        let tools = server
            .get("tools")
            .and_then(|value| value.as_u64())
            .map(|value| value.to_string())
            .unwrap_or_else(|| "0".to_string());
        app.push_line(
            LogKind::Status,
            format!("{id} {transport} {source} {enabled} {state} {tools}"),
        );
    }
    app.push_line(LogKind::Space, "");
}

fn apply_session_list_result(app: &mut AppState, result: &Value) {
    let sessions = result
        .get("sessions")
        .and_then(|value| value.as_array())
        .cloned()
        .unwrap_or_default();
    if sessions.is_empty() {
        app.push_line(LogKind::Status, "No saved sessions found.");
        app.push_line(LogKind::Space, "");
        return;
    }
    app.session_list_panel = Some(build_session_list_panel(&sessions));
}

fn format_session_updated(value: &str) -> String {
    let trimmed = value.trim_end_matches('Z').replace('T', " ");
    truncate_text(&trimmed, 19)
}

fn build_session_list_panel(sessions: &[Value]) -> SessionListPanelState {
    let mut rows = Vec::new();
    let mut session_ids = Vec::new();
    for session in sessions {
        let session_id = session
            .get("session_id")
            .and_then(|value| value.as_str())
            .unwrap_or("")
            .to_string();
        if session_id.is_empty() {
            continue;
        }
        let updated = session
            .get("updated_at")
            .and_then(|value| value.as_str())
            .map(format_session_updated)
            .unwrap_or_else(|| "-".to_string());
        let count = session
            .get("message_count")
            .and_then(|value| value.as_u64())
            .map(|value| value.to_string())
            .unwrap_or_else(|| "-".to_string());
        let preview = session
            .get("last_user_message")
            .and_then(|value| value.as_str())
            .map(|value| value.replace('\n', " "))
            .unwrap_or_default();
        let preview = truncate_text(preview.trim(), 72);
        let short_id: String = session_id.chars().take(8).collect();
        rows.push(format!("{updated} | {count:>4} | {short_id} | {preview}"));
        session_ids.push(session_id);
    }
    SessionListPanelState {
        title: "Resume session".to_string(),
        header: "Updated (UTC)       | Msgs | Session | Preview".to_string(),
        rows,
        session_ids,
        selected: 0,
    }
}

fn handle_model_list_response(app: &mut AppState, mode: ModelListMode, response: RpcResponse) {
    if let Some(error) = response.error {
        push_rpc_error(app, "model.list", &error);
        return;
    }
    if let Some(result) = response.result {
        apply_model_list_result(app, mode, &result);
    }
}

fn apply_model_list_result(app: &mut AppState, mode: ModelListMode, result: &Value) {
    let provider = result
        .get("provider")
        .and_then(|value| value.as_str())
        .map(|value| value.to_string());
    let models = result
        .get("models")
        .and_then(|value| value.as_array())
        .map(|items| {
            items
                .iter()
                .filter_map(|item| item.as_str().map(|value| value.to_string()))
                .collect::<Vec<_>>()
        })
        .unwrap_or_default();
    let current = result
        .get("current")
        .and_then(|value| value.as_str())
        .map(|value| value.to_string());
    if let Some(provider) = provider.clone() {
        app.current_provider = Some(provider);
    }
    app.current_model = current.clone();
    app.skills_list_panel = None;
    app.theme_list_panel = None;
    if matches!(mode, ModelListMode::Silent) {
        return;
    }
    if models.is_empty() {
        app.push_line(LogKind::Error, "model.list returned no models");
        return;
    }

    if matches!(mode, ModelListMode::Picker) {
        app.model_list_panel = None;
        let selected = current
            .as_ref()
            .and_then(|value| models.iter().position(|model| model == value))
            .unwrap_or(0);
        app.model_picker = Some(ModelPickerState { models, selected });
        return;
    }

    app.model_picker = None;
    let details = result.get("details").and_then(|value| value.as_object());
    let provider_label = provider
        .or_else(|| app.current_provider.clone())
        .unwrap_or_else(|| "openai".to_string());
    let current_label = current.clone().unwrap_or_else(|| "-".to_string());
    app.model_list_panel = Some(build_model_list_panel(
        provider_label,
        current_label,
        models,
        details,
        current.as_deref(),
    ));
}

fn build_model_list_panel(
    provider_label: String,
    current_label: String,
    models: Vec<String>,
    details: Option<&serde_json::Map<String, Value>>,
    current: Option<&str>,
) -> ModelListPanelState {
    let format_usd = |value: Option<f64>| -> String {
        match value {
            Some(cost) if cost.is_finite() && cost >= 0.0 => {
                let fixed = format!("{cost:.4}");
                fixed
                    .trim_end_matches('0')
                    .trim_end_matches('.')
                    .to_string()
            }
            _ => "-".to_string(),
        }
    };

    let mut ctx_width = "ctx".len();
    let mut input_width = "in".len();
    let mut output_width = "out".len();
    let mut cost_input_width = "in$ /1M".len();
    let mut cost_output_width = "out$ /1M".len();
    let mut name_width = "model".len();
    let mut rows = Vec::new();
    let mut model_ids = Vec::new();
    for model in models {
        name_width = name_width.max(model.len());
        let model_id = model.clone();
        let detail = details
            .and_then(|map| map.get(&model))
            .and_then(|value| value.as_object());
        let ctx = detail
            .and_then(|map| map.get("context_window"))
            .and_then(|value| value.as_u64())
            .map(|value| value.to_string())
            .unwrap_or_else(|| "-".to_string());
        let input = detail
            .and_then(|map| map.get("max_input_tokens"))
            .and_then(|value| value.as_u64())
            .map(|value| value.to_string())
            .unwrap_or_else(|| "-".to_string());
        let output = detail
            .and_then(|map| map.get("max_output_tokens"))
            .and_then(|value| value.as_u64())
            .map(|value| value.to_string())
            .unwrap_or_else(|| "-".to_string());
        let cost_input = format_usd(
            detail
                .and_then(|map| map.get("cost_per_1m_input_tokens_usd"))
                .and_then(|value| value.as_f64()),
        );
        let cost_output = format_usd(
            detail
                .and_then(|map| map.get("cost_per_1m_output_tokens_usd"))
                .and_then(|value| value.as_f64()),
        );
        ctx_width = ctx_width.max(ctx.len());
        input_width = input_width.max(input.len());
        output_width = output_width.max(output.len());
        cost_input_width = cost_input_width.max(cost_input.len());
        cost_output_width = cost_output_width.max(cost_output.len());
        let is_current = current == Some(model.as_str());
        rows.push((
            model,
            ctx,
            input,
            output,
            cost_input,
            cost_output,
            is_current,
        ));
        model_ids.push(model_id);
    }
    let header_limits = format!(
        "  {:<name_width$}  {:>ctx_width$}  {:>input_width$}  {:>output_width$}",
        "model", "ctx", "in", "out",
    );
    let header_cost = format!(
        "  {:<name_width$}  {:>cost_input_width$}  {:>cost_output_width$}",
        "model", "in$ /1M", "out$ /1M",
    );
    let selected = rows
        .iter()
        .position(|(_, _, _, _, _, _, is_current)| *is_current)
        .unwrap_or(0);
    let rendered_rows_limits = rows
        .iter()
        .map(|(model, ctx, input, output, _, _, is_current)| {
            let marker = if *is_current { "*" } else { " " };
            format!(
                "{marker} {:<name_width$}  {:>ctx_width$}  {:>input_width$}  {:>output_width$}",
                model, ctx, input, output,
            )
        })
        .collect();
    let rendered_rows_cost = rows
        .into_iter()
        .map(|(model, _, _, _, cost_input, cost_output, is_current)| {
            let marker = if is_current { "*" } else { " " };
            format!(
                "{marker} {:<name_width$}  {:>cost_input_width$}  {:>cost_output_width$}",
                model, cost_input, cost_output,
            )
        })
        .collect();

    ModelListPanelState {
        title: format!("Models ({provider_label}) current: {current_label}"),
        header_limits,
        rows_limits: rendered_rows_limits,
        header_cost,
        rows_cost: rendered_rows_cost,
        model_ids,
        selected,
        view_mode: ModelListViewMode::Limits,
        submit_action: ModelListSubmitAction::ModelSet,
    }
}

fn handle_model_set_response(app: &mut AppState, response: RpcResponse) {
    if let Some(error) = response.error {
        push_rpc_error(app, "model.set", &error);
        return;
    }
    if let Some(result) = response.result {
        let name = result
            .get("name")
            .and_then(|value| value.as_str())
            .unwrap_or("");
        let provider = result
            .get("provider")
            .and_then(|value| value.as_str())
            .unwrap_or("");
        if !name.is_empty() {
            app.current_model = Some(name.to_string());
            app.push_line(LogKind::Status, format!("Model set: {provider}/{name}"));
            app.push_line(LogKind::Space, "");
        }
    }
}

fn handle_ctrl_c(
    app: &mut AppState,
    child_stdin: &mut RuntimeStdin,
    next_id: &mut impl FnMut() -> String,
) -> bool {
    if app.pending_run_cancel_id.is_some() {
        app.push_line(
            LogKind::Status,
            "Cancellation is still pending. Press Ctrl+C again quickly to force quit.",
        );
        return true;
    }

    if let Some(run_id) = app.active_run_id.clone() {
        let id = next_id();
        app.pending_run_cancel_id = Some(id.clone());
        if let Err(error) = send_run_cancel(child_stdin, &id, &run_id, Some("user interrupted")) {
            app.pending_run_cancel_id = None;
            app.push_error_report("send error", error.to_string());
        } else {
            app.push_line(
                LogKind::Status,
                "Cancel requested (Ctrl+C again quickly to force quit)",
            );
        }
        return true;
    }

    if app.pending_run_start_id.is_some() || app.is_running() {
        app.push_line(
            LogKind::Status,
            "Run is starting; Ctrl+C again quickly to force quit.",
        );
        return true;
    }

    false
}

fn maybe_request_skills_catalog(
    app: &mut AppState,
    child_stdin: &mut RuntimeStdin,
    next_id: &mut impl FnMut() -> String,
) {
    if !app.supports_skills_list {
        return;
    }
    if app.skills_catalog_loaded || app.pending_skills_list_id.is_some() {
        return;
    }
    let id = next_id();
    app.pending_skills_list_id = Some(id.clone());
    if let Err(error) = crate::app::runtime::send_skills_list(child_stdin, &id, false) {
        app.pending_skills_list_id = None;
        app.skills_catalog_loaded = true;
        app.push_error_report("send error", error.to_string());
    }
}

fn handle_input_edit_key(
    input: &mut InputState,
    key: KeyCode,
    modifiers: KeyModifiers,
    allow_history: bool,
    allow_ctrl_j: bool,
) -> Option<bool> {
    match (key, modifiers) {
        (KeyCode::Char('u'), mods) if mods.contains(KeyModifiers::CONTROL) => {
            input.kill_line();
            Some(true)
        }
        (KeyCode::Char('k'), mods) if mods.contains(KeyModifiers::CONTROL) => {
            input.kill_to_end();
            Some(true)
        }
        (KeyCode::Char('w'), mods) if mods.contains(KeyModifiers::CONTROL) => {
            input.delete_word_back();
            Some(true)
        }
        (KeyCode::Char('a'), mods) if mods.contains(KeyModifiers::CONTROL) => {
            input.move_home();
            Some(true)
        }
        (KeyCode::Char('e'), mods) if mods.contains(KeyModifiers::CONTROL) => {
            input.move_end();
            Some(true)
        }
        (KeyCode::Char('j'), mods) if allow_ctrl_j && mods.contains(KeyModifiers::CONTROL) => {
            // Insert newline into the composer (terminal-friendly alternative to Shift+Enter).
            input.insert_char('\n');
            Some(true)
        }
        (KeyCode::Up, _) => {
            if input.move_up() {
                Some(true)
            } else if allow_history {
                input.history_up();
                Some(true)
            } else {
                Some(false)
            }
        }
        (KeyCode::Down, _) => {
            if input.move_down() {
                Some(true)
            } else if allow_history {
                input.history_down();
                Some(true)
            } else {
                Some(false)
            }
        }
        (KeyCode::Left, _) => {
            input.move_left();
            Some(true)
        }
        (KeyCode::Right, _) => {
            input.move_right();
            Some(true)
        }
        (KeyCode::Home, _) => {
            input.move_home();
            Some(true)
        }
        (KeyCode::End, _) => {
            input.move_end();
            Some(true)
        }
        (KeyCode::Delete, _) => {
            input.delete();
            Some(true)
        }
        (KeyCode::Backspace, _) => {
            input.backspace();
            Some(true)
        }
        (KeyCode::Char(ch), mods) => {
            if !mods.contains(KeyModifiers::CONTROL) && !mods.contains(KeyModifiers::ALT) {
                input.insert_char(ch);
                Some(true)
            } else {
                Some(false)
            }
        }
        _ => None,
    }
}

fn handle_main_key(
    app: &mut AppState,
    key: KeyCode,
    modifiers: KeyModifiers,
    terminal: &mut crate::app::render::custom_terminal::Terminal<CrosstermBackend<std::io::Stdout>>,
    child_stdin: &mut RuntimeStdin,
    next_id: &mut impl FnMut() -> String,
) -> bool {
    let now = Instant::now();
    let is_plain_backslash = matches!(key, KeyCode::Char('\\')) && modifiers.is_empty();
    let is_plain_enter = key == KeyCode::Enter && modifiers.is_empty();
    if !is_plain_backslash && !is_plain_enter {
        app.pending_shift_enter_backslash = None;
    }
    match (key, modifiers) {
        (KeyCode::F(2), _) => {
            app.mouse_capture_enabled = !app.mouse_capture_enabled;
            if app.mouse_capture_enabled {
                let _ = terminal.backend_mut().execute(EnableMouseCapture);
            } else {
                let _ = terminal.backend_mut().execute(DisableMouseCapture);
            }
            true
        }
        (KeyCode::Char('h'), mods) if mods.contains(KeyModifiers::ALT) => {
            app.toggle_status_line_mode();
            true
        }
        (KeyCode::Char('l'), mods) if mods.contains(KeyModifiers::CONTROL) => {
            app.clear_log();
            true
        }
        (KeyCode::Esc, _) => {
            if app.scroll_from_bottom > 0 {
                app.scroll_from_bottom = 0;
                true
            } else if app.bang_input_mode
                && app.input.buffer.is_empty()
                && app.pending_image_attachments.is_empty()
            {
                app.bang_input_mode = false;
                true
            } else if !app.input.current().is_empty() || !app.pending_image_attachments.is_empty() {
                app.clear_composer();
                true
            } else if app.is_running() {
                if app.pending_run_cancel_id.is_some() {
                    true
                } else if let Some(run_id) = app.active_run_id.clone() {
                    let id = next_id();
                    app.pending_run_cancel_id = Some(id.clone());
                    if let Err(error) =
                        send_run_cancel(child_stdin, &id, &run_id, Some("user interrupted"))
                    {
                        app.pending_run_cancel_id = None;
                        app.push_error_report("send error", error.to_string());
                    } else {
                        app.push_line(LogKind::Status, "Cancel requested (Esc)");
                    }
                    true
                } else {
                    false
                }
            } else {
                false
            }
        }
        (KeyCode::Char('v'), mods) if mods.contains(KeyModifiers::ALT) => {
            handle_clipboard_image_paste(app)
        }
        (KeyCode::Char('!'), mods)
            if mods.is_empty()
                && !app.bang_input_mode
                && app.input.buffer.is_empty()
                && app.pending_image_attachments.is_empty() =>
        {
            app.bang_input_mode = true;
            true
        }
        (KeyCode::Backspace, mods)
            if mods.is_empty()
                && app.bang_input_mode
                && app.input.buffer.is_empty()
                && app.pending_image_attachments.is_empty() =>
        {
            app.bang_input_mode = false;
            true
        }
        (KeyCode::Char('\\'), mods) if mods.is_empty() => {
            app.input.insert_char('\\');
            app.pending_shift_enter_backslash = Some(now);
            true
        }
        (KeyCode::Enter, mods) if !mods.is_empty() => {
            // Only plain Enter submits; any modifiers insert a newline.
            app.input.insert_char('\n');
            true
        }
        (KeyCode::Enter, _) => {
            if let Some(armed_at) = app.pending_shift_enter_backslash {
                let within_window = now.duration_since(armed_at) <= SHIFT_ENTER_BACKSLASH_WINDOW;
                let at_end = app.input.cursor == app.input.buffer.len();
                let last_backslash = app.input.buffer.last() == Some(&'\\');
                if within_window && at_end && last_backslash {
                    app.input.backspace();
                    app.input.insert_char('\n');
                    app.pending_shift_enter_backslash = None;
                    return true;
                }
            }
            app.pending_shift_enter_backslash = None;
            crate::app::handlers::command::handle_enter(app, child_stdin, next_id)
        }
        (KeyCode::Tab, mods) if mods.is_empty() => {
            crate::app::handlers::command::complete_slash_command(&mut app.input)
                || crate::app::handlers::command::complete_skill_mention(
                    &mut app.input,
                    &app.skills_catalog_items,
                )
        }
        (KeyCode::PageUp, _) => {
            app.scroll_page_up();
            true
        }
        (KeyCode::PageDown, _) => {
            app.scroll_page_down();
            true
        }
        _ => handle_input_edit_key(&mut app.input, key, modifiers, true, true).unwrap_or_default(),
    }
}

fn handle_paste(app: &mut AppState, text: &str) -> bool {
    let cleaned = sanitize_paste(text);
    if cleaned.is_empty() {
        return false;
    }
    if blocks_composer_paste(app) {
        return false;
    }
    if app.prompt_dialog.is_some() {
        app.prompt_input.insert_str(&cleaned);
    } else {
        app.input.insert_str(&cleaned);
    }
    true
}

fn can_paste_clipboard_image(app: &AppState) -> bool {
    !blocks_composer_paste(app)
}

fn blocks_input_paste(app: &AppState) -> bool {
    app.confirm_dialog.is_some()
        || app.pending_confirm_dialog.is_some()
        || app.pick_dialog.is_some()
        || app.lane_list_panel.is_some()
}

fn blocks_composer_paste(app: &AppState) -> bool {
    blocks_input_paste(app) || app.skills_list_panel.is_some() || app.theme_list_panel.is_some()
}

fn append_clipboard_image(app: &mut AppState) -> Result<(), ClipboardImageError> {
    let image = read_clipboard_image_attachment(MAX_CLIPBOARD_IMAGE_BYTES)?;
    let attachment_id = app.next_image_attachment_id();
    let token = make_attachment_token(&app.composer_nonce, &attachment_id);
    app.add_pending_image_attachment(attachment_id, image.clone());
    app.input.insert_str(&token);
    let summary = format!(
        "Attached image {}x{} ({}KB)",
        image.width,
        image.height,
        image.encoded_bytes / 1024
    );
    app.push_line(LogKind::Status, summary);
    Ok(())
}

fn report_clipboard_paste_error(app: &mut AppState, error: ClipboardImageError) {
    match error {
        ClipboardImageError::NotAvailable => {
            app.push_line(LogKind::Status, "No image found in clipboard");
        }
        ClipboardImageError::TooLarge { bytes, max_bytes } => {
            app.push_line(
                LogKind::Error,
                format!(
                    "Clipboard image is too large ({}KB > {}KB)",
                    bytes / 1024,
                    max_bytes / 1024
                ),
            );
        }
        ClipboardImageError::Clipboard(error) | ClipboardImageError::Encode(error) => {
            app.push_line(
                LogKind::Error,
                format!("Clipboard image paste failed: {error}"),
            );
        }
    }
}

fn handle_clipboard_image_paste(app: &mut AppState) -> bool {
    if !can_paste_clipboard_image(app) {
        return false;
    }
    if app.prompt_dialog.is_some() {
        app.push_line(
            LogKind::Status,
            "Image paste is unavailable while prompt input is active",
        );
        return true;
    }
    if app.pending_image_attachments.len() >= MAX_CLIPBOARD_IMAGES_PER_MESSAGE {
        app.push_line(
            LogKind::Error,
            format!(
                "Image attachment limit reached ({MAX_CLIPBOARD_IMAGES_PER_MESSAGE} per message)"
            ),
        );
        return true;
    }

    if let Err(error) = append_clipboard_image(app) {
        report_clipboard_paste_error(app, error);
    }
    true
}

fn handle_prompt_key(
    app: &mut AppState,
    key: KeyCode,
    modifiers: KeyModifiers,
    child_stdin: &mut BufWriter<ChildStdin>,
    next_id: &mut impl FnMut() -> String,
) -> Option<bool> {
    let prompt = app.prompt_dialog.as_ref()?;
    let prompt_id = prompt.id.clone();
    let multiline = prompt.multiline;
    let secret = prompt.secret;

    let mut handled = true;
    match (key, modifiers) {
        (KeyCode::Esc, _) => {
            app.prompt_dialog = None;
            app.prompt_input.clear();
            app.pending_new_lane_seed_context = None;
            if prompt_id != "lane:new-task" && prompt_id != "lane:new-seed" {
                if let Err(error) = send_prompt_response(child_stdin, &prompt_id, None) {
                    app.push_error_report("prompt response error", error.to_string());
                }
            }
        }
        (KeyCode::Enter, mods) if mods.contains(KeyModifiers::SHIFT) && multiline => {
            app.prompt_input.insert_char('\n');
        }
        (KeyCode::Enter, _) => {
            let value = app.prompt_input.current();
            app.prompt_dialog = None;
            app.prompt_input.clear();

            if prompt_id == "lane:new-task" {
                let task_id = value.trim();
                if task_id.is_empty() {
                    app.push_line(LogKind::Error, "task_id is required");
                    app.pending_new_lane_seed_context = None;
                    app.prompt_dialog = Some(PromptDialogState {
                        id: "lane:new-task".to_string(),
                        title: "New lane".to_string(),
                        message: "Task id".to_string(),
                        multiline: false,
                        secret: false,
                    });
                    return Some(true);
                }
                app.pending_new_lane_seed_context = Some(task_id.to_string());
                app.prompt_dialog = Some(PromptDialogState {
                    id: "lane:new-seed".to_string(),
                    title: "New lane".to_string(),
                    message: "Seed context (optional)".to_string(),
                    multiline: true,
                    secret: false,
                });
                return Some(true);
            }

            if prompt_id == "lane:new-seed" {
                if let Some(task_id) = app.pending_new_lane_seed_context.take() {
                    let mut args = serde_json::Map::new();
                    args.insert("task_id".to_string(), Value::String(task_id));
                    let seed = value.trim();
                    if !seed.is_empty() {
                        args.insert("seed_context".to_string(), Value::String(seed.to_string()));
                    }
                    let id = next_id();
                    app.pending_lane_create_id = Some(id.clone());
                    if let Err(error) =
                        send_tool_call(child_stdin, &id, "lane_create", Value::Object(args))
                    {
                        app.pending_lane_create_id = None;
                        app.push_error_report("send error", error.to_string());
                    }
                }
                return Some(true);
            }

            if let Err(error) = send_prompt_response(child_stdin, &prompt_id, Some(value.as_str()))
            {
                app.push_error_report("prompt response error", error.to_string());
            }
        }
        _ => {
            handled =
                handle_input_edit_key(&mut app.prompt_input, key, modifiers, !secret, multiline)
                    .unwrap_or_default();
        }
    }

    Some(handled)
}

fn handle_pick_key(
    app: &mut AppState,
    key: KeyCode,
    child_stdin: &mut BufWriter<ChildStdin>,
    next_id: &mut impl FnMut() -> String,
) -> Option<bool> {
    let pick = app.pick_dialog.as_mut()?;
    let mut handled = true;
    match key {
        KeyCode::Esc => {
            let ids: Vec<String> = Vec::new();
            let id = pick.id.clone();
            app.pick_dialog = None;
            if let Err(error) = send_pick_response(child_stdin, &id, &ids) {
                app.push_error_report("pick response error", error.to_string());
            }
        }
        KeyCode::Up => {
            pick.selected = pick.selected.saturating_sub(1);
        }
        KeyCode::Down => {
            if pick.selected + 1 < pick.items.len() {
                pick.selected += 1;
            }
        }
        KeyCode::Enter => {
            let id = pick.id.clone();
            let ids = if pick.multi {
                pick.items
                    .iter()
                    .enumerate()
                    .filter_map(|(idx, item)| {
                        pick.chosen
                            .get(idx)
                            .copied()
                            .unwrap_or(false)
                            .then_some(item.id.clone())
                    })
                    .collect::<Vec<_>>()
            } else {
                pick.items
                    .get(pick.selected)
                    .map(|item| vec![item.id.clone()])
                    .unwrap_or_default()
            };
            app.pick_dialog = None;

            if let Some(lane_id) = id.strip_prefix("lane:action:") {
                if let Some(action) = ids.first() {
                    let request_id = next_id();
                    match action.as_str() {
                        "status" => {
                            app.pending_lane_status_id = Some(request_id.clone());
                            if let Err(error) = send_tool_call(
                                child_stdin,
                                &request_id,
                                "lane_status",
                                json!({ "lane_id": lane_id }),
                            ) {
                                app.pending_lane_status_id = None;
                                app.push_error_report("send error", error.to_string());
                            }
                        }
                        "close" => {
                            app.pending_lane_close_id = Some(request_id.clone());
                            if let Err(error) = send_tool_call(
                                child_stdin,
                                &request_id,
                                "lane_close",
                                json!({ "lane_id": lane_id }),
                            ) {
                                app.pending_lane_close_id = None;
                                app.push_error_report("send error", error.to_string());
                            }
                        }
                        _ => {}
                    }
                }
                return Some(true);
            }

            if let Err(error) = send_pick_response(child_stdin, &id, &ids) {
                app.push_error_report("pick response error", error.to_string());
            }
        }
        KeyCode::Char(' ') if pick.multi => {
            if let Some(choice) = pick.chosen.get_mut(pick.selected) {
                *choice = !*choice;
            }
        }
        KeyCode::Char(ch) if ch.is_ascii_digit() => {
            let index = ch.to_digit(10).unwrap_or(0) as usize;
            if index > 0 && index <= pick.items.len() {
                pick.selected = index - 1;
            }
        }
        _ => handled = false,
    }
    Some(handled)
}

fn handle_mouse_event(app: &mut AppState, kind: MouseEventKind) -> bool {
    match kind {
        MouseEventKind::ScrollUp => {
            app.scroll_up(3);
            true
        }
        MouseEventKind::ScrollDown => {
            app.scroll_down(3);
            true
        }
        _ => false,
    }
}

fn apply_redraw(needs_redraw: &mut bool, redraw: bool) {
    if redraw {
        *needs_redraw = true;
    }
}

fn handle_non_main_key(
    app: &mut AppState,
    key: KeyCode,
    modifiers: KeyModifiers,
    child_stdin: &mut RuntimeStdin,
    next_id: &mut impl FnMut() -> String,
) -> Option<bool> {
    if let Some(redraw) = handle_confirm_key(app, key, modifiers, child_stdin) {
        return Some(redraw);
    }
    if app.pending_confirm_dialog.is_some() {
        return Some(false);
    }

    if let Some(redraw) = handle_prompt_key(app, key, modifiers, child_stdin, next_id) {
        return Some(redraw);
    }

    if let Some(redraw) = handle_pick_key(app, key, child_stdin, next_id) {
        return Some(redraw);
    }

    if let Some(redraw) =
        crate::app::handlers::panels::handle_session_list_panel_key(app, key, child_stdin, next_id)
    {
        return Some(redraw);
    }

    if let Some(redraw) =
        crate::app::handlers::panels::handle_lane_list_panel_key(app, key, child_stdin, next_id)
    {
        return Some(redraw);
    }

    if let Some(redraw) = crate::app::handlers::panels::handle_skills_list_panel_key(app, key) {
        return Some(redraw);
    }

    if let Some(redraw) =
        crate::app::handlers::panels::handle_theme_list_panel_key(app, key, child_stdin, next_id)
    {
        return Some(redraw);
    }

    if let Some(redraw) = crate::app::handlers::panels::handle_context_panel_key(app, key) {
        return Some(redraw);
    }

    if let Some(redraw) =
        crate::app::handlers::panels::handle_model_list_panel_key(app, key, child_stdin, next_id)
    {
        return Some(redraw);
    }

    if let Some(redraw) =
        crate::app::handlers::panels::handle_provider_picker_key(app, key, child_stdin, next_id)
    {
        return Some(redraw);
    }

    if let Some(redraw) =
        crate::app::handlers::panels::handle_model_picker_key(app, key, child_stdin, next_id)
    {
        return Some(redraw);
    }

    None
}

struct TerminalRestoreGuard {
    use_alt_screen: bool,
}

impl TerminalRestoreGuard {
    fn new(use_alt_screen: bool) -> Self {
        Self { use_alt_screen }
    }
}

impl Drop for TerminalRestoreGuard {
    fn drop(&mut self) {
        let _ = disable_raw_mode();
        let mut stdout = std::io::stdout();
        let _ = stdout.execute(PopKeyboardEnhancementFlags);
        let _ = stdout.execute(DisableBracketedPaste);
        let _ = stdout.execute(DisableMouseCapture);
        if self.use_alt_screen {
            let _ = stdout.execute(LeaveAlternateScreen);
        }
        let _ = stdout.execute(Show);
    }
}

fn main() -> Result<(), Box<dyn std::error::Error>> {
    match parse_basic_cli_mode() {
        BasicCliMode::Help => {
            print_basic_help();
            return Ok(());
        }
        BasicCliMode::Version => {
            println!("{}", resolve_version_label());
            return Ok(());
        }
        BasicCliMode::Run => {}
    }
    parse_runtime_cli_overrides();
    let resume_mode = parse_resume_mode();
    let mut pending_initial_message = parse_initial_message();
    let debug_print = cli_flag_enabled("--debug") || env_truthy("CODELIA_DEBUG");
    let debug_perf = cli_flag_enabled("--debug-perf") || env_truthy("CODELIA_DEBUG_PERF");
    let diagnostics = cli_flag_enabled("--diagnostics") || env_truthy("CODELIA_DIAGNOSTICS");
    let (mut child, mut child_stdin, rx) = spawn_runtime(diagnostics)?;

    let mut rpc_id = 0_u64;
    let mut next_id = || {
        rpc_id += 1;
        rpc_id.to_string()
    };

    send_initialize(&mut child_stdin, &next_id())?;

    let mut stdout = std::io::stdout();
    let use_alt_screen = false;
    let _restore_guard = TerminalRestoreGuard::new(use_alt_screen);
    if use_alt_screen {
        stdout.execute(EnterAlternateScreen)?;
    }
    enable_raw_mode()?;
    // Try to enable the kitty keyboard protocol so we can reliably distinguish Shift+Enter and
    // other modifier combos on terminals that support it. On unsupported terminals this is a noop.
    let _ = stdout.execute(PushKeyboardEnhancementFlags(
        KeyboardEnhancementFlags::DISAMBIGUATE_ESCAPE_CODES
            | KeyboardEnhancementFlags::REPORT_EVENT_TYPES
            | KeyboardEnhancementFlags::REPORT_ALTERNATE_KEYS,
    ));
    // Ensure multi-line paste is delivered as Event::Paste instead of a stream of Enter keypresses.
    let _ = stdout.execute(EnableBracketedPaste);
    let backend = CrosstermBackend::new(stdout);
    let mut terminal = crate::app::render::custom_terminal::Terminal::new(backend)?;
    let mut app = AppState::default();
    app.enable_debug_print = debug_print;
    app.debug_perf_enabled = debug_perf;
    app.mouse_capture_enabled = use_alt_screen;
    if app.mouse_capture_enabled {
        let _ = terminal.backend_mut().execute(EnableMouseCapture);
    }
    for line in LOGO_LINES {
        app.push_line(LogKind::System, line);
    }
    app.push_line(LogKind::Space, "");
    app.push_line(LogKind::System, "Welcome to Codelia!");
    app.push_line(
        LogKind::System,
        format!("Version: {}", resolve_version_label()),
    );
    app.push_line(LogKind::Space, "");
    if pending_initial_message.is_some() {
        app.push_line(
            LogKind::Status,
            "Queued initial prompt (`--initial-message`).",
        );
        app.push_line(LogKind::Space, "");
    }
    if app.enable_debug_print {
        app.push_line(
            LogKind::Status,
            "Debug logs enabled (`--debug` or CODELIA_DEBUG=1)",
        );
        app.push_line(LogKind::Space, "");
    }
    if app.debug_perf_enabled {
        app.push_line(
            LogKind::Status,
            "Debug perf panel enabled (`--debug-perf` or CODELIA_DEBUG_PERF=1)",
        );
        app.push_line(LogKind::Space, "");
    }
    if diagnostics {
        app.push_line(
            LogKind::Status,
            "Run diagnostics enabled (`--diagnostics` or CODELIA_DIAGNOSTICS=1)",
        );
        app.push_line(LogKind::Space, "");
    }
    let id = next_id();
    app.pending_model_list_id = Some(id.clone());
    app.pending_model_list_mode = Some(ModelListMode::Silent);
    if let Err(error) = send_model_list(&mut child_stdin, &id, None, false) {
        app.push_error_report("send error", error.to_string());
    }

    match resume_mode {
        ResumeMode::Id(session_id) => {
            let short_id: String = session_id.chars().take(8).collect();
            app.session_id = Some(session_id);
            app.push_line(LogKind::Status, format!("Resume session {short_id}"));
            app.push_line(LogKind::Space, "");
            if let Some(session_id) = app.session_id.clone() {
                crate::app::handlers::panels::request_session_history(
                    &mut app,
                    &mut child_stdin,
                    &mut next_id,
                    &session_id,
                );
            }
        }
        ResumeMode::Picker => {
            let id = next_id();
            app.pending_session_list_id = Some(id.clone());
            if let Err(error) = send_session_list(&mut child_stdin, &id, Some(50)) {
                app.push_error_report("send error", error.to_string());
            }
        }
        ResumeMode::None => {}
    }

    let mut inline_initialized = false;
    let mut inline_viewport_height = 0_u16;
    let mut inline_screen_size: Option<Size> = None;
    let mut needs_redraw = true;
    let mut should_exit = false;
    let key_debug = std::env::var("CODELIA_TUI_KEY_DEBUG").ok().as_deref() == Some("1");
    let mut last_ctrl_c_at: Option<Instant> = None;

    loop {
        if process_runtime_messages(&mut app, &rx, &mut child_stdin, &mut next_id) {
            needs_redraw = true;
        }

        maybe_request_skills_catalog(&mut app, &mut child_stdin, &mut next_id);

        if pending_initial_message.is_some() && can_auto_start_initial_message(&app) {
            if let Some(message) = pending_initial_message.take() {
                if crate::app::handlers::command::start_prompt_run(
                    &mut app,
                    &mut child_stdin,
                    &mut next_id,
                    &message,
                ) {
                    app.clear_composer();
                }
                needs_redraw = true;
            }
        }

        if let Ok(Some(status)) = child.try_wait() {
            app.push_line(LogKind::Runtime, format!("runtime exited: {}", status));
            needs_redraw = true;
            should_exit = true;
        }

        let timeout = Duration::from_millis(50);
        if event::poll(timeout)? {
            match event::read()? {
                Event::Key(key) => {
                    if key.kind != KeyEventKind::Press {
                        continue;
                    }
                    if key_debug {
                        eprintln!("key: {}", KeyDebugLog::from_event(&key));
                    }
                    if key.code == KeyCode::Char('c')
                        && key.modifiers.contains(KeyModifiers::CONTROL)
                    {
                        let now = Instant::now();
                        if let Some(previous) = last_ctrl_c_at {
                            if now.duration_since(previous) <= CTRL_C_FORCE_QUIT_WINDOW {
                                app.push_line(LogKind::Status, "Force quitting...");
                                break;
                            }
                        }
                        if handle_ctrl_c(&mut app, &mut child_stdin, &mut next_id) {
                            last_ctrl_c_at = Some(now);
                            needs_redraw = true;
                            continue;
                        }
                        break;
                    }

                    last_ctrl_c_at = None;

                    if let Some(redraw) = handle_non_main_key(
                        &mut app,
                        key.code,
                        key.modifiers,
                        &mut child_stdin,
                        &mut next_id,
                    ) {
                        apply_redraw(&mut needs_redraw, redraw);
                        continue;
                    }

                    if handle_main_key(
                        &mut app,
                        key.code,
                        key.modifiers,
                        &mut terminal,
                        &mut child_stdin,
                        &mut next_id,
                    ) {
                        app.prune_unreferenced_attachments();
                        needs_redraw = true;
                    }
                }
                Event::Paste(text) => {
                    if blocks_input_paste(&app) {
                        continue;
                    }
                    if handle_paste(&mut app, &text) {
                        app.prune_unreferenced_attachments();
                        apply_redraw(&mut needs_redraw, true);
                    }
                }
                Event::Mouse(mouse) => {
                    apply_redraw(&mut needs_redraw, handle_mouse_event(&mut app, mouse.kind));
                }
                Event::Resize(_, _) => {
                    needs_redraw = true;
                }
                _ => {}
            }
        }

        let now = Instant::now();
        if app.update_spinner(now) {
            needs_redraw = true;
        }

        if needs_redraw {
            let frame_started = Instant::now();
            let mut followup_redraw = false;
            let screen_size = terminal.size()?;
            let log_changed_for_scrollback = app.log_changed;
            if use_alt_screen {
                let area = Rect::new(0, 0, screen_size.width, screen_size.height);
                if terminal.viewport_area != area {
                    terminal.set_viewport_area(area);
                    terminal.clear()?;
                }
            } else {
                let desired =
                    desired_height(&mut app, screen_size.width, screen_size.height).max(1);
                let min_height = 12_u16;
                let screen_changed = inline_screen_size != Some(screen_size);
                if !inline_initialized {
                    let target_height = desired.max(min_height).min(screen_size.height).max(1);
                    let (area, cursor_pos) =
                        compute_inline_area(terminal.backend_mut(), target_height, screen_size)?;
                    terminal.set_viewport_area(area);
                    terminal.last_known_cursor_pos = cursor_pos;
                    terminal.last_known_screen_size = screen_size;
                    terminal.clear()?;
                    inline_initialized = true;
                    inline_viewport_height = target_height;
                    inline_screen_size = Some(screen_size);
                } else {
                    let mut area = terminal.viewport_area;
                    area.width = screen_size.width;
                    area.height = inline_viewport_height.min(screen_size.height).max(1);
                    let max_y = screen_size.height.saturating_sub(area.height);
                    if area.y > max_y {
                        area.y = max_y;
                    }
                    if screen_changed || area != terminal.viewport_area {
                        terminal.set_viewport_area(area);
                        terminal.clear()?;
                    }
                    inline_viewport_height = area.height;
                    inline_screen_size = Some(screen_size);
                }
                terminal.last_known_screen_size = screen_size;
            }
            let draw_started = Instant::now();
            terminal.draw(|f| draw_ui(f, &mut app))?;
            app.record_perf_frame(frame_started.elapsed(), draw_started.elapsed());
            if !use_alt_screen {
                let effects =
                    apply_terminal_effects(&mut terminal, &mut app, log_changed_for_scrollback)?;
                if effects.request_redraw {
                    followup_redraw = true;
                }
            }
            if activate_pending_confirm_dialog(&mut app) {
                needs_redraw = true;
                continue;
            }
            needs_redraw = followup_redraw;
            app.assert_render_invariants();
        }
        if should_exit {
            break;
        }
    }

    let _ = child.kill();
    if !use_alt_screen {
        let area = terminal.viewport_area;
        let screen_size = terminal.size().unwrap_or(terminal.last_known_screen_size);
        let mut cursor_y = area.bottom();
        if cursor_y >= screen_size.height {
            let _ = terminal.backend_mut().set_cursor_position(Position {
                x: 0,
                y: screen_size.height.saturating_sub(1),
            });
            let _ = terminal.backend_mut().append_lines(1);
            cursor_y = screen_size.height.saturating_sub(1);
        }
        let _ = terminal
            .backend_mut()
            .set_cursor_position(Position { x: 0, y: cursor_y });
        let _ = Backend::flush(terminal.backend_mut());
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::{
        apply_lane_list_result, cli_flag_enabled_from_args, parse_basic_cli_mode_from_args,
        parse_initial_message_from_args, parse_resume_mode_from_args,
        parse_runtime_cli_overrides_from_args, push_bang_stream_preview,
        resolve_version_label_from_versions, truncate_bang_preview_line, BasicCliMode, ResumeMode,
    };
    use crate::app::AppState;
    use serde_json::json;

    #[test]
    fn parse_resume_mode_accepts_picker_and_value() {
        assert_eq!(
            parse_resume_mode_from_args(["--resume"]),
            ResumeMode::Picker
        );
        assert_eq!(
            parse_resume_mode_from_args(["--resume", "abc"]),
            ResumeMode::Id("abc".to_string())
        );
        assert_eq!(
            parse_resume_mode_from_args(["--resume=xyz"]),
            ResumeMode::Id("xyz".to_string())
        );
    }

    #[test]
    fn parse_basic_cli_mode_supports_help_and_version() {
        assert_eq!(
            parse_basic_cli_mode_from_args(["--help"]),
            BasicCliMode::Help
        );
        assert_eq!(parse_basic_cli_mode_from_args(["-h"]), BasicCliMode::Help);
        assert_eq!(
            parse_basic_cli_mode_from_args(["--version"]),
            BasicCliMode::Version
        );
        assert_eq!(
            parse_basic_cli_mode_from_args(["-V"]),
            BasicCliMode::Version
        );
        assert_eq!(
            parse_basic_cli_mode_from_args(["--resume", "abc"]),
            BasicCliMode::Run
        );
    }

    #[test]
    fn cli_flag_enabled_supports_bool_and_equals_forms() {
        assert!(cli_flag_enabled_from_args("--debug", ["--debug"]));
        assert!(cli_flag_enabled_from_args("--debug", ["--debug=true"]));
        assert!(cli_flag_enabled_from_args("--debug", ["--debug=1"]));
        assert!(!cli_flag_enabled_from_args("--debug", ["--debug=false"]));
        assert!(!cli_flag_enabled_from_args("--debug", ["--debug=0"]));
        assert!(!cli_flag_enabled_from_args("--debug", ["--debug=maybe"]));
    }

    #[test]
    fn parse_initial_message_accepts_short_and_long_forms() {
        assert_eq!(
            parse_initial_message_from_args(["--initial-message=hello"]),
            Some("hello".to_string())
        );
        assert_eq!(
            parse_initial_message_from_args(["--initial-message", "hello world"]),
            Some("hello world".to_string())
        );
        assert_eq!(
            parse_initial_message_from_args(["--initial-user-message", "hello"]),
            Some("hello".to_string())
        );
    }

    #[test]
    fn parse_initial_message_ignores_empty() {
        assert_eq!(
            parse_initial_message_from_args(["--initial-message="]),
            None
        );
        assert_eq!(
            parse_initial_message_from_args(["--initial-message", "   "]),
            None
        );
    }

    #[test]
    fn parse_runtime_cli_overrides_maps_ssh_flags_and_ignores_missing_values() {
        let overrides = parse_runtime_cli_overrides_from_args([
            "--ssh",
            "host-alias",
            "--ssh-port",
            "2222",
            "--ssh-identity",
            "/home/me/.ssh/id_ed25519",
            "--ssh-option=StrictHostKeyChecking=yes",
            "--ssh-option",
            "ServerAliveInterval=15",
            "--remote-command=remote run",
            "--remote-cwd",
            "/srv/app",
            "--ssh-option",
            "--debug",
        ]);
        assert_eq!(
            overrides,
            vec![
                ("CODELIA_RUNTIME_SSH_HOST", "host-alias".to_string()),
                ("CODELIA_RUNTIME_REMOTE_CMD", "remote run".to_string()),
                ("CODELIA_RUNTIME_REMOTE_CWD", "/srv/app".to_string()),
                ("CODELIA_RUNTIME_TRANSPORT", "ssh".to_string()),
                (
                    "CODELIA_RUNTIME_SSH_OPTS",
                    "-o 'BatchMode=yes' -o 'StrictHostKeyChecking=yes' -o 'ServerAliveInterval=15' -o 'ServerAliveCountMax=3' -p 2222 -i /home/me/.ssh/id_ed25519 -o 'StrictHostKeyChecking=yes' -o 'ServerAliveInterval=15'"
                        .to_string(),
                ),
            ]
        );
    }

    #[test]
    fn version_label_uses_cli_version_without_tui_suffix() {
        assert_eq!(
            resolve_version_label_from_versions(Some("0.1.12"), "0.1.0"),
            "codelia 0.1.12"
        );
        assert_eq!(
            resolve_version_label_from_versions(Some(" 0.2.0 "), "0.1.0"),
            "codelia 0.2.0"
        );
    }

    #[test]
    fn version_label_falls_back_without_tui_version_when_cli_is_missing() {
        assert_eq!(
            resolve_version_label_from_versions(None, "0.1.0"),
            "codelia"
        );
        assert_eq!(
            resolve_version_label_from_versions(Some("   "), "0.1.0"),
            "codelia"
        );
    }

    #[test]
    fn truncate_bang_preview_line_appends_marker_when_long() {
        let input = "x".repeat(300);
        let out = truncate_bang_preview_line(&input);
        assert!(out.ends_with("...[truncated]"));
        assert!(out.len() < input.len());
    }

    #[test]
    fn push_bang_stream_preview_emits_runtime_lines_and_truncation_hint() {
        let mut app = AppState::default();
        push_bang_stream_preview(
            &mut app,
            "stdout",
            Some("line1\nline2"),
            true,
            Some("cache-ref-1"),
        );

        let lines = app
            .log
            .iter()
            .map(|line| line.plain_text())
            .collect::<Vec<_>>();
        assert!(lines.iter().any(|line| line.contains("bang stdout:")));
        assert!(lines.iter().any(|line| line.contains("line1")));
        assert!(lines
            .iter()
            .any(|line| line.contains("tool_output_cache ref `cache-ref-1`")));
    }

    #[test]
    fn apply_lane_list_result_adds_new_lane_row() {
        let mut app = AppState::default();
        let payload = json!({
            "lanes": [
                {
                    "lane_id": "lane-a",
                    "task_id": "task-a",
                    "state": "running",
                    "mux_backend": "tmux"
                }
            ]
        });

        apply_lane_list_result(&mut app, &payload);

        let panel = app.lane_list_panel.expect("lane panel present");
        assert_eq!(panel.rows.len(), 2);
        assert_eq!(panel.rows[1], "+ New lane");
    }
}
