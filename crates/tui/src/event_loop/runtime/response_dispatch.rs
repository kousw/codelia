use super::formatters::{
    add_kind_spacing, format_duration, last_summary_kind, push_bang_stream_preview, push_rpc_error,
    tool_call_with_status_icon,
};
use super::panel_builders::{
    build_model_list_panel, build_onboarding_model_list_panel, build_session_list_panel,
    format_context_file_row,
};
use crate::app::handlers::confirm::handle_confirm_request;
use crate::app::runtime::{
    parse_runtime_output, send_tool_call, ParsedOutput, RpcResponse, ToolCallResultUpdate,
    UiPickRequest, UiPromptRequest,
};
use crate::app::state::{parse_theme_name, LogKind, LogLine, LogTone};
use crate::app::view::theme::apply_theme_name;
use crate::app::{
    AppState, ContextPanelState, LaneListItem, LaneListPanelState, ModelListMode, ModelPickerState,
    PickDialogItem, PickDialogState, PromptDialogState, SkillsListItemState, SkillsListPanelState,
    SkillsScopeFilter, PROMPT_DISPATCH_MAX_ATTEMPTS, PROMPT_DISPATCH_RETRY_BACKOFF,
};
use crate::event_loop::{RuntimeReceiver, RuntimeStdin};
use serde_json::{json, Value};
use std::sync::mpsc::TryRecvError;
use std::time::Instant;

const MAX_RUNTIME_LINES_PER_TICK: usize = 300;

pub(crate) fn can_auto_start_initial_message(app: &AppState) -> bool {
    if app.pending_model_list_id.is_some()
        || app.pending_model_set_id.is_some()
        || app.pending_theme_set_id.is_some()
        || !app.pending_prompt_queue.is_empty()
        || app.dispatching_prompt.is_some()
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
    crate::app::handlers::command::can_dispatch_prompt_now(app)
}

pub(crate) fn process_runtime_messages(
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

    if let Some(theme_name) = result
        .get("tui")
        .and_then(|value| value.as_object())
        .and_then(|tui| tui.get("theme"))
        .and_then(|value| value.as_str())
    {
        if let Some(parsed) = parse_theme_name(theme_name) {
            apply_theme_name(parsed);
        }
    }

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

fn requeue_dispatching_prompt(app: &mut AppState, reason: &str) {
    if let Some(mut dispatching) = app.dispatching_prompt.take() {
        dispatching.dispatch_attempts = dispatching.dispatch_attempts.saturating_add(1);
        if dispatching.dispatch_attempts >= PROMPT_DISPATCH_MAX_ATTEMPTS {
            app.push_line(
                LogKind::Error,
                format!(
                    "Dropping queued prompt {} after {} failed dispatch attempts ({reason}).",
                    dispatching.queue_id, dispatching.dispatch_attempts
                ),
            );
            app.push_line(
                LogKind::Status,
                format!("Queue size now {}", app.pending_prompt_queue.len()),
            );
            app.next_queue_dispatch_retry_at = None;
            return;
        }
        app.pending_prompt_queue.push_front(dispatching.clone());
        app.next_queue_dispatch_retry_at = Some(Instant::now() + PROMPT_DISPATCH_RETRY_BACKOFF);
        app.push_line(
            LogKind::Status,
            format!(
                "Retrying queued prompt {} ({}/{}) after dispatch failure.",
                dispatching.queue_id, dispatching.dispatch_attempts, PROMPT_DISPATCH_MAX_ATTEMPTS
            ),
        );
    }
}

pub(crate) fn handle_run_start_response(app: &mut AppState, response: RpcResponse) {
    if let Some(error) = response.error {
        app.update_run_status("error".to_string());
        app.active_run_id = None;
        let reason = error
            .get("message")
            .and_then(|value| value.as_str())
            .unwrap_or("run.start rpc error");
        requeue_dispatching_prompt(app, reason);
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
            requeue_dispatching_prompt(app, "run.start returned no run_id");
            app.push_line(LogKind::Error, "run.start returned no run_id");
            return;
        }
        app.active_run_id = run_id;
        app.pending_shell_results.clear();
        app.dispatching_prompt = None;
        app.next_queue_dispatch_retry_at = None;
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

pub(crate) fn apply_lane_list_result(app: &mut AppState, result: &Value) {
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
    app.reasoning_picker = None;
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
    app.reasoning_picker = None;
    app.session_list_panel = None;
    app.context_panel = None;
    app.theme_list_panel = None;
    app.skills_list_panel = Some(panel);
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
    app.reasoning_picker = None;
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
    let reasoning = result
        .get("reasoning")
        .and_then(|value| value.as_str())
        .map(|value| value.to_string());
    if let Some(provider) = provider.clone() {
        app.current_provider = Some(provider);
    }
    app.current_model = current.clone();
    if let Some(reasoning) = reasoning {
        app.current_reasoning = Some(reasoning);
    }
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
        app.reasoning_picker = None;
        let selected = current
            .as_ref()
            .and_then(|value| models.iter().position(|model| model == value))
            .unwrap_or(0);
        app.model_picker = Some(ModelPickerState { models, selected });
        return;
    }

    app.model_picker = None;
    app.reasoning_picker = None;
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
        let reasoning = result
            .get("reasoning")
            .and_then(|value| value.as_str())
            .unwrap_or("");
        if !name.is_empty() {
            app.current_model = Some(name.to_string());
            if !provider.is_empty() {
                app.current_provider = Some(provider.to_string());
            }
            if !reasoning.is_empty() {
                app.current_reasoning = Some(reasoning.to_string());
            }
            let suffix = if reasoning.is_empty() {
                String::new()
            } else {
                format!(" [{reasoning}]")
            };
            app.push_line(
                LogKind::Status,
                format!("Model set: {provider}/{name}{suffix}"),
            );
            app.push_line(LogKind::Space, "");
        }
    }
}
