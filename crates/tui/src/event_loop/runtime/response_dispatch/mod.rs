mod context_inspect;
mod lane;
mod mcp;
mod model;
mod run_control;
mod session;
mod skills;

use super::formatters::{
    add_kind_spacing, format_duration, last_summary_kind, push_rpc_error,
    tool_call_with_status_icon,
};
use super::panel_builders::build_onboarding_model_list_panel;
use crate::app::handlers::confirm::handle_confirm_request;
use crate::app::runtime::{
    parse_runtime_output, ParsedOutput, RpcResponse, ToolCallResultUpdate, UiPickRequest,
    UiPromptRequest,
};
use crate::app::state::{parse_theme_name, LogKind, LogLine, LogTone};
use crate::app::view::theme::apply_theme_name;
use crate::app::{AppState, ModelListMode, PickDialogItem, PickDialogState, PromptDialogState};
use crate::event_loop::{RuntimeReceiver, RuntimeStdin};
use std::sync::mpsc::TryRecvError;

#[cfg(test)]
pub(crate) use lane::apply_lane_list_result;
#[cfg(test)]
pub(crate) use run_control::handle_run_start_response;

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
        session::handle_session_list_response(app, response);
        return true;
    }

    let handled_session_history =
        app.pending_session_history_id.as_deref() == Some(response.id.as_str());
    if handled_session_history {
        app.pending_session_history_id = None;
        session::handle_session_history_response(app, response);
        return true;
    }

    let handled_model_list = app.pending_model_list_id.as_deref() == Some(response.id.as_str());
    if handled_model_list {
        app.pending_model_list_id = None;
        let mode = app
            .pending_model_list_mode
            .take()
            .unwrap_or(ModelListMode::Picker);
        model::handle_model_list_response(app, mode, response);
        return true;
    }

    let handled_model_set = app.pending_model_set_id.as_deref() == Some(response.id.as_str());
    if handled_model_set {
        app.pending_model_set_id = None;
        model::handle_model_set_response(app, response);
        return true;
    }

    let handled_mcp_list = app.pending_mcp_list_id.as_deref() == Some(response.id.as_str());
    if handled_mcp_list {
        app.pending_mcp_list_id = None;
        let detail_id = app.pending_mcp_detail_id.take();
        mcp::handle_mcp_list_response(app, response, detail_id.as_deref());
        return true;
    }

    let handled_lane_list = app.pending_lane_list_id.as_deref() == Some(response.id.as_str());
    if handled_lane_list {
        app.pending_lane_list_id = None;
        lane::handle_lane_list_response(app, response);
        return true;
    }

    let handled_lane_status = app.pending_lane_status_id.as_deref() == Some(response.id.as_str());
    if handled_lane_status {
        app.pending_lane_status_id = None;
        lane::handle_lane_status_response(app, response);
        return true;
    }

    let handled_lane_close = app.pending_lane_close_id.as_deref() == Some(response.id.as_str());
    if handled_lane_close {
        app.pending_lane_close_id = None;
        lane::handle_lane_close_response(app, response, child_stdin, next_id);
        return true;
    }

    let handled_lane_create = app.pending_lane_create_id.as_deref() == Some(response.id.as_str());
    if handled_lane_create {
        app.pending_lane_create_id = None;
        lane::handle_lane_create_response(app, response, child_stdin, next_id);
        return true;
    }

    let handled_skills_list = app.pending_skills_list_id.as_deref() == Some(response.id.as_str());
    if handled_skills_list {
        app.pending_skills_list_id = None;
        skills::handle_skills_list_response(app, response);
        return true;
    }

    let handled_context_inspect =
        app.pending_context_inspect_id.as_deref() == Some(response.id.as_str());
    if handled_context_inspect {
        app.pending_context_inspect_id = None;
        context_inspect::handle_context_inspect_response(app, response);
        return true;
    }

    let handled_logout = app.pending_logout_id.as_deref() == Some(response.id.as_str());
    if handled_logout {
        app.pending_logout_id = None;
        run_control::handle_logout_response(app, response);
        return true;
    }

    let handled_shell_exec = app.pending_shell_exec_id.as_deref() == Some(response.id.as_str());
    if handled_shell_exec {
        app.pending_shell_exec_id = None;
        run_control::handle_shell_exec_response(app, response);
        return true;
    }

    let handled_theme_set = app.pending_theme_set_id.as_deref() == Some(response.id.as_str());
    if handled_theme_set {
        app.pending_theme_set_id = None;
        run_control::handle_theme_set_response(app, response);
        return true;
    }

    let handled_run_start = app.pending_run_start_id.as_deref() == Some(response.id.as_str());
    if handled_run_start {
        app.pending_run_start_id = None;
        run_control::handle_run_start_response(app, response);
        return true;
    }

    let handled_run_cancel = app.pending_run_cancel_id.as_deref() == Some(response.id.as_str());
    if handled_run_cancel {
        app.pending_run_cancel_id = None;
        run_control::handle_run_cancel_response(app, response);
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
