mod client_tools;
mod context_inspect;
mod formatters;
mod lane;
mod mcp;
mod model;
mod panel_builders;
mod parsed_output;
mod run_control;
mod session;
mod skills;
mod tasks;

use self::formatters::push_rpc_error;
use crate::app::handlers;
use crate::app::handlers::theme::apply_theme_from_name;
use crate::app::runtime::{parse_runtime_output, RpcResponse};
use crate::app::state::LogKind;
use crate::app::{AppState, PendingRpcMatch};
use std::io::BufWriter;
use std::process::ChildStdin;
use std::sync::mpsc::Receiver;
use std::sync::mpsc::TryRecvError;

pub(crate) type RuntimeStdin = BufWriter<ChildStdin>;
pub(crate) type RuntimeReceiver = Receiver<String>;

#[cfg(test)]
pub(crate) use formatters::{push_bang_stream_preview, truncate_bang_preview_line};
#[cfg(test)]
pub(crate) use lane::apply_lane_list_result;
#[cfg(test)]
pub(crate) use run_control::handle_run_start_response;

const MAX_RUNTIME_LINES_PER_TICK: usize = 300;

pub(crate) fn can_auto_start_initial_message(app: &AppState) -> bool {
    if app.rpc_pending.has_auto_start_blockers()
        || !app.pending_prompt_queue.is_empty()
        || app.dispatching_prompt.is_some()
    {
        return false;
    }
    handlers::can_dispatch_prompt_now(app)
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
                if parsed_output::apply_parsed_output(app, parsed, child_stdin, next_id) {
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
        let _ = apply_theme_from_name(theme_name);
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
        app.runtime_info.supports_mcp_list = supports_mcp_list;
    }
    if let Some(supports_skills_list) = server_capabilities
        .get("supports_skills_list")
        .and_then(|value| value.as_bool())
    {
        app.runtime_info.supports_skills_list = supports_skills_list;
    }
    if let Some(supports_context_inspect) = server_capabilities
        .get("supports_context_inspect")
        .and_then(|value| value.as_bool())
    {
        app.runtime_info.supports_context_inspect = supports_context_inspect;
    }
    if let Some(supports_tool_call) = server_capabilities
        .get("supports_tool_call")
        .and_then(|value| value.as_bool())
    {
        app.runtime_info.supports_tool_call = supports_tool_call;
    }
    if let Some(supports_shell_exec) = server_capabilities
        .get("supports_shell_exec")
        .and_then(|value| value.as_bool())
    {
        app.runtime_info.supports_shell_exec = supports_shell_exec;
    }
    if let Some(supports_shell_tasks) = server_capabilities
        .get("supports_shell_tasks")
        .and_then(|value| value.as_bool())
    {
        app.runtime_info.supports_shell_tasks = supports_shell_tasks;
    }
    if let Some(supports_shell_detach) = server_capabilities
        .get("supports_shell_detach")
        .and_then(|value| value.as_bool())
    {
        app.runtime_info.supports_shell_detach = supports_shell_detach;
    }
    if let Some(supports_tasks) = server_capabilities
        .get("supports_tasks")
        .and_then(|value| value.as_bool())
    {
        app.runtime_info.supports_tasks = supports_tasks;
    }
    if let Some(supports_theme_set) = server_capabilities
        .get("supports_theme_set")
        .and_then(|value| value.as_bool())
    {
        app.runtime_info.supports_theme_set = supports_theme_set;
    }
}

fn handle_rpc_response(
    app: &mut AppState,
    response: RpcResponse,
    child_stdin: &mut RuntimeStdin,
    next_id: &mut impl FnMut() -> String,
) -> bool {
    update_server_capabilities_from_response(app, &response);

    if let Some(pending) = app
        .rpc_pending
        .take_match_for_response(response.id.as_str())
    {
        match pending {
            PendingRpcMatch::SessionList => session::handle_session_list_response(app, response),
            PendingRpcMatch::SessionHistory => {
                session::handle_session_history_response(app, response)
            }
            PendingRpcMatch::ModelList { mode, scope } => {
                model::handle_model_list_response(app, mode, scope, response)
            }
            PendingRpcMatch::ModelSet => model::handle_model_set_response(app, response),
            PendingRpcMatch::McpList { detail_id } => {
                mcp::handle_mcp_list_response(app, response, detail_id.as_deref())
            }
            PendingRpcMatch::LaneList => lane::handle_lane_list_response(app, response),
            PendingRpcMatch::LaneStatus => lane::handle_lane_status_response(app, response),
            PendingRpcMatch::LaneClose => {
                lane::handle_lane_close_response(app, response, child_stdin, next_id)
            }
            PendingRpcMatch::LaneCreate => {
                lane::handle_lane_create_response(app, response, child_stdin, next_id)
            }
            PendingRpcMatch::SkillsList => skills::handle_skills_list_response(app, response),
            PendingRpcMatch::ContextInspect => {
                context_inspect::handle_context_inspect_response(app, response)
            }
            PendingRpcMatch::Logout => run_control::handle_logout_response(app, response),
            PendingRpcMatch::ShellExec => run_control::handle_shell_exec_response(app, response),
            PendingRpcMatch::ShellStart => {
                run_control::handle_shell_start_response(app, response, child_stdin, next_id)
            }
            PendingRpcMatch::ShellWait => run_control::handle_shell_wait_response(app, response),
            PendingRpcMatch::ShellDetach => {
                run_control::handle_shell_detach_response(app, response)
            }
            PendingRpcMatch::TaskList => tasks::handle_task_list_response(app, response),
            PendingRpcMatch::TaskStatus => tasks::handle_task_status_response(app, response),
            PendingRpcMatch::TaskCancel => tasks::handle_task_cancel_response(app, response),
            PendingRpcMatch::ThemeSet => run_control::handle_theme_set_response(app, response),
            PendingRpcMatch::RunStart => run_control::handle_run_start_response(app, response),
            PendingRpcMatch::RunCancel => run_control::handle_run_cancel_response(app, response),
        }
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
