mod apply;
mod auto_review;
mod client_tools;
mod components;
mod context_inspect;
mod formatters;
mod image;
mod lane;
mod mcp;
mod model;
mod panel_builders;
mod replay;
mod run_control;
mod session;
mod skills;
mod steer;
mod tasks;
#[cfg(test)]
mod tests;

use self::formatters::push_rpc_error;
use crate::app::handlers;
use crate::app::handlers::theme::apply_theme_from_name;
use crate::app::runtime::{parse_runtime_output_with_history, RpcResponse, RuntimeTx};
use crate::app::state::LogKind;
use crate::app::{AppState, PendingRpc, PendingRpcSlot};
use crate::protocol::{methods, InitializeResult, InitializeResultShellSandboxIssue};
use std::sync::mpsc::Receiver;
use std::sync::mpsc::TryRecvError;

pub(crate) type RuntimeReceiver = Receiver<String>;

pub(super) use formatters::push_shell_stream_preview;
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
    tx: &mut dyn RuntimeTx,
) -> bool {
    let mut needs_redraw = false;
    let mut processed = 0usize;
    while processed < MAX_RUNTIME_LINES_PER_TICK {
        match rx.try_recv() {
            Ok(line) => {
                processed += 1;
                // Applying a line can change the history slot or active run for the next line.
                let msg = parse_runtime_output_with_history(
                    &line,
                    app.rpc_pending.has_slot(PendingRpcSlot::SessionHistory),
                    app.runtime_info.active_run_id.as_deref(),
                );
                if apply::apply_runtime_msg(app, msg, tx) {
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

fn handle_initialize_response(app: &mut AppState, response: RpcResponse) {
    if let Some(error) = response.error {
        push_rpc_error(app, "initialize", &error);
        return;
    }
    let Some(result) = response.result else {
        return;
    };
    if let Some(result) = decode_response_result::<methods::Initialize>(app, result) {
        apply_initialize_result(app, &result);
    }
}

fn decode_response_result<R: crate::protocol::ClientRequest>(
    app: &mut AppState,
    result: serde_json::Value,
) -> Option<R::Result> {
    match crate::protocol::decode_result::<R>(result) {
        Ok(result) => Some(result),
        Err(error) => {
            push_protocol_mismatch(app, &error);
            None
        }
    }
}

pub(super) fn push_protocol_mismatch(app: &mut AppState, error: &crate::protocol::DecodeError) {
    app.push_line(LogKind::Error, error.to_string());
}

fn apply_initialize_result(app: &mut AppState, result: &InitializeResult) {
    if let Some(providers) = &result.model_providers {
        app.runtime_info.model_providers = providers.clone();
    }

    if let Some(sandbox) = &result.sandbox_mode {
        let mode = sandbox.value.as_str();
        if matches!(mode, "readonly" | "workspace-write" | "full-access") {
            let message = match sandbox.legacy.as_ref().map(|legacy| legacy.as_str()) {
                Some("full-access") => {
                    format!("Sandbox mode is {mode}. To disable OS isolation while keeping command approval, restart with --sandbox-mode full-access.")
                }
                Some(legacy @ ("minimal" | "trusted")) => {
                    format!("Sandbox mode is {mode} (from legacy {legacy}).")
                }
                _ => format!("Sandbox mode is {mode}."),
            };
            app.push_line(LogKind::Status, message);
            if mode == "full-access" {
                app.push_line(
                    LogKind::Status,
                    "Shell commands run with your user permissions after approval. Restart with --sandbox-mode workspace-write to require OS isolation.",
                );
            }
        }
    }

    if result.shell_sandbox_issue
        == Some(InitializeResultShellSandboxIssue::WindowsNativeUnqualified)
    {
        app.push_line(
            LogKind::Status,
            "Confined shell unavailable on this Windows host. MXC may retain access granted by Windows ACLs, including local IPC. This configuration has not qualified for native execution.",
        );
    }

    if let Some(tui) = &result.tui {
        if let Some(theme_name) = tui.theme.as_deref() {
            let _ = apply_theme_from_name(theme_name);
        }
        let reviewer_state = tui.auto_review.as_ref().map(|state| state.as_str());
        let reviewer_issue = tui.auto_review_issue.as_ref().map(|issue| issue.as_str());
        if !auto_review::push_confined_status(
            app,
            reviewer_state,
            tui.auto_review_confined_launch_enabled,
            tui.auto_review_confined_launch_issue
                .as_ref()
                .map(|issue| issue.as_str()),
            reviewer_issue,
        ) {
            if let Some(message) = match reviewer_state {
                Some("off") => Some("Auto approve is off."),
                Some("active") => Some("Auto approve is on."),
                Some("unavailable") => Some(auto_review::unavailable_message(reviewer_issue)),
                _ => None,
            } {
                app.push_line(LogKind::Status, message);
            }
        }
    }

    let Some(caps) = &result.server_capabilities else {
        return;
    };
    let info = &mut app.runtime_info;
    // Flags without a default keep their previous value when omitted.
    for (flag, target) in [
        (caps.supports_mcp_list, &mut info.supports_mcp_list),
        (caps.supports_skills_list, &mut info.supports_skills_list),
        (
            caps.supports_context_inspect,
            &mut info.supports_context_inspect,
        ),
        (caps.supports_tool_call, &mut info.supports_tool_call),
        (caps.supports_shell_exec, &mut info.supports_shell_exec),
        (caps.supports_shell_tasks, &mut info.supports_shell_tasks),
        (caps.supports_shell_detach, &mut info.supports_shell_detach),
        (caps.supports_tasks, &mut info.supports_tasks),
        (caps.supports_theme_set, &mut info.supports_theme_set),
        (
            caps.supports_image_generation,
            &mut info.supports_image_generation,
        ),
    ] {
        if let Some(value) = flag {
            *target = value;
        }
    }
    info.supports_model_ultrafast = caps.supports_model_ultrafast.unwrap_or(false);
    info.supports_scoped_logout = caps.supports_scoped_logout.unwrap_or(false);
    info.supports_session_lifecycle = caps.supports_session_lifecycle.unwrap_or(false);
    info.supports_auto_review_configure = caps.supports_auto_review_configure.unwrap_or(false);
    info.supports_project_allow_trust = caps.supports_project_allow_trust.unwrap_or(false);
    info.supports_permissions_rw = caps.supports_permissions_rw.unwrap_or(false);
    info.supports_ui_requests = caps.supports_ui_requests.unwrap_or(false);
    info.supports_structured_approval = caps.supports_structured_approval.unwrap_or(false);
    info.attachment_upload_limits = caps
        .attachment_upload_limits
        .as_ref()
        .and_then(crate::app::state::upload::UploadLimits::from_wire);
    info.supports_attachment_upload =
        caps.supports_attachment_upload == Some(true) && info.attachment_upload_limits.is_some();
    info.supports_run_steer = caps.supports_run_steer.unwrap_or(false);
    app.goal.supported = caps.supports_goals == Some(true);
}

#[cfg(test)]
mod scoped_logout_tests {
    use super::*;

    fn initialize_result(mut fields: serde_json::Value) -> InitializeResult {
        fields["protocol_version"] = serde_json::json!("0");
        fields["server"] = serde_json::json!({"name": "runtime", "version": "test"});
        serde_json::from_value(fields).expect("initialize result")
    }

    #[test]
    fn local_auto_review_status_is_visible_on_initialize() {
        let mut app = AppState::default();
        for (status, message) in [
            ("off", "Auto approve is off."),
            ("active", "Auto approve is on."),
            (
                "unavailable",
                "Auto approve is unavailable. Check the user settings.",
            ),
        ] {
            apply_initialize_result(
                &mut app,
                &initialize_result(serde_json::json!({"tui": {"auto_review": status}})),
            );
            assert_eq!(app.log.last().unwrap().plain_text(), message);
        }
    }

    #[test]
    fn unavailable_auto_review_identifies_the_selection_issue() {
        let mut app = AppState::default();
        apply_initialize_result(
            &mut app,
            &initialize_result(serde_json::json!({
                "tui": {"auto_review": "unavailable", "auto_review_issue": "unregistered_review_model"}
            })),
        );
        assert!(app
            .log
            .last()
            .unwrap()
            .plain_text()
            .contains("Choose a registered provider and model."));
    }

    #[test]
    fn initialize_surfaces_auto_review_authentication_and_migration_issues() {
        for (issue, message) in [
            (
                "review_auth_incompatible",
                "The Auto approve review model does not support the current authentication method.",
            ),
            (
                "review_reconfigure_required",
                "Run /auto-approve to update your saved Auto approve settings.",
            ),
        ] {
            let mut app = AppState::default();
            apply_initialize_result(
                &mut app,
                &initialize_result(serde_json::json!({
                    "tui": {"auto_review": "unavailable", "auto_review_issue": issue}
                })),
            );
            assert_eq!(app.log.last().unwrap().plain_text(), message);
        }
    }

    #[test]
    fn scoped_logout_requires_an_explicit_runtime_capability() {
        let mut app = AppState::default();
        for (capabilities, expected) in [
            (serde_json::json!({"supports_scoped_logout": true}), true),
            (serde_json::json!({"supports_theme_set": true}), false),
        ] {
            apply_initialize_result(
                &mut app,
                &initialize_result(serde_json::json!({"server_capabilities": capabilities})),
            );
            assert_eq!(app.runtime_info.supports_scoped_logout, expected);
        }
    }
}

fn handle_rpc_response(app: &mut AppState, response: RpcResponse, tx: &mut dyn RuntimeTx) -> bool {
    if crate::app::goal::handle_response(app, &response) {
        return true;
    }
    if let Some(pending) = app.rpc_pending.take(&response.id) {
        match pending {
            PendingRpc::Initialize => handle_initialize_response(app, response),
            PendingRpc::SessionList { show_all } => {
                session::handle_session_list_response(app, response, show_all)
            }
            PendingRpc::SessionUpdate => session::handle_session_update_response(app, response),
            PendingRpc::SessionHistory => session::handle_session_history_response(app, response),
            PendingRpc::SessionOpen => session::handle_session_open_response(app, response, tx),
            PendingRpc::ModelList { mode, scope } => {
                model::handle_model_list_response(app, mode, scope, response)
            }
            PendingRpc::ModelSet => model::handle_model_set_response(app, response),
            PendingRpc::McpList { detail_id } => {
                mcp::handle_mcp_list_response(app, response, detail_id.as_deref())
            }
            PendingRpc::LaneList => lane::handle_lane_list_response(app, response),
            PendingRpc::LaneStatus => lane::handle_lane_status_response(app, response),
            PendingRpc::LaneClose => lane::handle_lane_close_response(app, response, tx),
            PendingRpc::LaneCreate => lane::handle_lane_create_response(app, response, tx),
            PendingRpc::SkillsList { query, scope } => {
                skills::handle_skills_list_response(app, response, query, scope)
            }
            PendingRpc::ContextInspect => {
                context_inspect::handle_context_inspect_response(app, response)
            }
            PendingRpc::Logout => run_control::handle_logout_response(app, response),
            PendingRpc::ShellExec => run_control::handle_shell_exec_response(app, response),
            PendingRpc::ShellStart => run_control::handle_shell_start_response(app, response, tx),
            PendingRpc::ShellWait => run_control::handle_shell_wait_response(app, response),
            PendingRpc::ShellDetach => run_control::handle_shell_detach_response(app, response),
            PendingRpc::TaskList => tasks::handle_task_list_response(app, response),
            PendingRpc::TaskStatus => tasks::handle_task_status_response(app, response),
            PendingRpc::TaskCancel => tasks::handle_task_cancel_response(app, response),
            PendingRpc::ThemeSet => run_control::handle_theme_set_response(app, response),
            PendingRpc::AutoReview => auto_review::handle(app, response),
            PendingRpc::ShellRules(operation) => {
                handlers::shell_rules::response(app, operation, response)
            }
            PendingRpc::ImageModelGet => {
                image::model::<crate::protocol::methods::ImageModelGet>(app, response, |status| {
                    (status.message, status.state.as_str() == "unavailable")
                });
            }
            PendingRpc::ImageModelConfigure => {
                image::model::<crate::protocol::methods::ImageModelConfigure>(
                    app,
                    response,
                    |status| {
                        (
                            status.message,
                            status
                                .state
                                .as_ref()
                                .is_some_and(|state| state.as_str() == "unavailable"),
                        )
                    },
                );
            }
            PendingRpc::ImageArtifact {
                artifact_id,
                preview_revision,
            } => image::artifact(app, response, &artifact_id, preview_revision),
            PendingRpc::RunStart => run_control::handle_run_start_response(app, response),
            PendingRpc::RunSteer { client_steer_id } => {
                run_control::handle_run_steer_response(app, client_steer_id, response)
            }
            PendingRpc::RunCancel => run_control::handle_run_cancel_response(app, response),
            PendingRpc::Upload(pending) => {
                crate::app::handlers::command::upload::handle_response(app, pending, &response, tx);
            }
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
