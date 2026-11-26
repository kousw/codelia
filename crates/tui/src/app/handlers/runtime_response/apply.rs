use super::components;
use super::formatters::{add_kind_spacing, format_duration, last_summary_kind};
use super::panel_builders::build_onboarding_model_list_panel;
use super::replay::apply_replay_progress;
use super::{client_tools, steer};
use crate::app::handlers::confirm::handle_confirm_request;
use crate::app::runtime::{
    send_client_tool_error, send_pick_response, AgentMsg, ClientToolMsg, ClientToolRejection,
    RunControlMsg, RunErrorPresentation, RuntimeMsg, RuntimeTx, ServerUiMsg, UiPickRequest,
    UiPromptRequest,
};
use crate::app::state::{InputState, LogKind, LogLine, LogTone};
use crate::app::{
    AppState, PendingRpcSlot, PickDialogItem, PromptDialogState, PromptSlot, RuntimePickDialog,
    RuntimePickList, RuntimePickListKind, PROMPT_DISPATCH_RETRY_BACKOFF,
};
use std::time::Instant;

pub(crate) fn apply_runtime_msg(
    app: &mut AppState,
    msg: RuntimeMsg,
    tx: &mut dyn RuntimeTx,
) -> bool {
    match msg {
        RuntimeMsg::Ignored => return false,
        RuntimeMsg::LogLines(lines) => append_lines(app, lines, false),
        RuntimeMsg::RpcResponse(response) => {
            // Parity: keep non-ignored messages requesting redraw even when unmatched.
            let _ = super::handle_rpc_response(app, response, tx);
        }
        RuntimeMsg::UiRequest(request) => apply_ui_request(app, request, tx),
        RuntimeMsg::ClientTool(tool) => match tool {
            ClientToolMsg::Call(request) => {
                client_tools::handle_client_tool_request(app, request, tx);
            }
            ClientToolMsg::Cancel(cancellation) => {
                client_tools::handle_client_tool_cancel(app, cancellation);
            }
            ClientToolMsg::RejectMalformed { rejection, lines } => {
                append_lines(app, lines, false);
                reject_malformed(app, rejection, tx);
            }
        },
        RuntimeMsg::RunControl(control) => apply_run_control(app, control),
        RuntimeMsg::Agent(event) => apply_agent_msg(app, event),
    }
    true
}

fn apply_ui_request(app: &mut AppState, request: ServerUiMsg, tx: &mut dyn RuntimeTx) {
    match request {
        ServerUiMsg::Confirm(request) => handle_confirm_request(app, request),
        ServerUiMsg::Prompt(request) => handle_prompt_request(app, request),
        ServerUiMsg::Pick(request) => handle_pick_request(app, request, tx),
        ServerUiMsg::PickCancelled { id } => {
            if app
                .overlays
                .runtime_dialogs
                .pick
                .as_ref()
                .is_some_and(|dialog| !dialog.is_client_tool_choice() && dialog.id() == id)
            {
                app.overlays.runtime_dialogs.pick = None;
            }
        }
    }
}

fn reject_malformed(app: &mut AppState, rejection: ClientToolRejection, tx: &mut dyn RuntimeTx) {
    use crate::app::runtime::{send_confirm_response, send_pick_response, send_prompt_response};
    let id = rejection.id.as_str();
    let sent = match rejection.method.as_str() {
        "ui.confirm.request" => send_confirm_response(tx, id, false, false, None),
        "ui.prompt.request" => send_prompt_response(tx, id, None),
        "ui.pick.request" => send_pick_response(tx, id, &[]),
        _ => send_client_tool_error(tx, id, &rejection.message),
    };
    if let Err(error) = sent {
        app.push_error_report("protocol reply send error", error.to_string());
    }
}

fn apply_run_control(app: &mut AppState, msg: RunControlMsg) {
    match msg {
        RunControlMsg::Status {
            status,
            run_id,
            run_error,
            lines,
            unconsumed_steer_ids,
            unconsumed_client_steer_ids,
        } => {
            apply_status(
                app,
                status,
                run_id,
                &unconsumed_steer_ids,
                unconsumed_client_steer_ids.as_deref(),
            );
            append_lines(app, lines, false);
            if let Some(error) = run_error {
                show_run_error(app, error);
            }
        }
        RunControlMsg::Context { left_percent } => {
            if let Some(percent) = left_percent {
                app.context_left_percent = Some(percent);
            }
        }
        RunControlMsg::Metrics(metrics) => {
            if app.runtime_info.active_run_id.as_deref() == Some(metrics.run_id.as_str()) {
                if let Some(tps) = metrics.output_tokens_per_second {
                    app.runtime_info.last_llm_tps = Some(tps);
                }
            }
        }
        RunControlMsg::Goal(notification) => crate::app::goal::notify(app, notification),
    }
}

fn apply_status(
    app: &mut AppState,
    status: String,
    run_id: Option<String>,
    unconsumed_steer_ids: &[String],
    unconsumed_client_steer_ids: Option<&[String]>,
) {
    let terminal = matches!(status.as_str(), "completed" | "error" | "cancelled");
    if terminal {
        app.clear_stream_output();
        let finished_run_scope = run_id.or_else(|| app.runtime_info.active_run_id.clone());
        app.rpc_pending.remove_slot(PendingRpcSlot::RunStart);
        app.rpc_pending.remove_slot(PendingRpcSlot::RunCancel);
        app.runtime_info.active_run_id = None;
        app.permission_preview_by_tool_call.clear();
        app.permission_ready_tool_call_ids.clear();
        let retry_at = Instant::now() + PROMPT_DISPATCH_RETRY_BACKOFF;
        match app.next_queue_dispatch_retry_at {
            Some(current) if current >= retry_at => {}
            _ => app.next_queue_dispatch_retry_at = Some(retry_at),
        }
        if let Some(run_scope) = finished_run_scope.as_deref() {
            components::clear_component_tracking_for_run(app, run_scope);
        }
        steer::fallback_unconsumed_steers(
            app,
            finished_run_scope.as_deref(),
            unconsumed_steer_ids,
            unconsumed_client_steer_ids,
        );
    } else if let Some(run_id) = run_id {
        app.runtime_info.active_run_id = Some(run_id);
    }
    app.update_run_status(status);
}

fn show_run_error(app: &mut AppState, error: RunErrorPresentation) {
    let detail = match app.runtime_info.current_model.as_deref() {
        Some(model) => format!("{}\nModel: {model}", error.detail),
        None => error.detail,
    };
    app.push_error_report(error.summary, detail);
    if app.error_detail_mode == crate::app::ErrorDetailMode::Summary {
        if let Some(hint) = error.hint {
            app.push_line(LogKind::Status, format!("  Next: {hint}"));
        }
    }
}

fn apply_agent_msg(app: &mut AppState, event: AgentMsg) {
    let lines = match event {
        AgentMsg::StreamDelta(update) => {
            app.apply_stream_update(update);
            return;
        }
        AgentMsg::Text {
            mut lines,
            content,
            canonical_run_id,
        } => {
            if is_live_output(app, canonical_run_id.as_deref()) {
                app.reconcile_stream_output(false, &content, &mut lines);
            }
            app.last_assistant_text = Some(content);
            lines
        }
        AgentMsg::Reasoning {
            mut lines,
            content,
            canonical_run_id,
        } => {
            if is_live_output(app, canonical_run_id.as_deref()) {
                app.reconcile_stream_output(true, &content, &mut lines);
            }
            lines
        }
        AgentMsg::Final {
            lines,
            content,
            canonical_run_id,
        } => {
            apply_final(app, lines, content, canonical_run_id.as_deref());
            return;
        }
        AgentMsg::StreamReset { lines, run_id } => {
            if is_live_output(app, run_id.as_deref()) {
                app.clear_stream_output();
            }
            lines
        }
        AgentMsg::ReplayProgress(event) => {
            apply_replay_progress(app, event);
            return;
        }
        AgentMsg::ToolCallStart {
            tool_call_id,
            lines,
        } => {
            let start = components::tool_call_start(app, &tool_call_id);
            let appended_from = app.log.len();
            append_lines(app, lines, false);
            components::register_pending_component_lines(app, appended_from, vec![start]);
            return;
        }
        AgentMsg::ToolCallResult {
            update,
            mut lines,
            replay_progress,
        } => {
            if let Some(progress) = replay_progress {
                apply_replay_progress(app, progress);
            }
            components::tool_call_result(app, &mut lines, update);
            lines
        }
        AgentMsg::PermissionPreview { update, lines } => {
            if let Some(update) = update {
                components::permission_preview(app, update);
            }
            lines
        }
        AgentMsg::PermissionReady { update, mut lines } => {
            if let Some(update) = update {
                components::permission_ready(app, update, &mut lines);
            }
            lines
        }
        AgentMsg::Compaction { phase, mut lines } => {
            let mut starts = Vec::new();
            components::apply_compaction_component_events(app, &mut lines, &mut starts, phase);
            let appended_from = app.log.len();
            append_lines(app, lines, false);
            components::register_pending_component_lines(app, appended_from, starts);
            return;
        }
        AgentMsg::SteerApplied {
            steer_id,
            client_id,
            run_id,
            lines,
        } => steer::apply_steer(app, &run_id, &steer_id, client_id.as_deref()).unwrap_or(lines),
        AgentMsg::UnreadableSteerApplied { run_id, lines } => {
            steer::pause_unreadable_run_steers(app, run_id.as_deref());
            lines
        }
    };
    append_lines(app, lines, false);
}

fn is_live_output(app: &AppState, run_id: Option<&str>) -> bool {
    run_id.is_some_and(|id| app.runtime_info.active_run_id.as_deref() == Some(id))
}

fn apply_final(app: &mut AppState, mut lines: Vec<LogLine>, content: String, run_id: Option<&str>) {
    let live_output = is_live_output(app, run_id);
    let streamed_final = live_output && app.reconcile_final_output(&content, &mut lines);
    if live_output {
        app.streamed_completion = streamed_final;
        app.clear_stream_output();
    }
    if !streamed_final && app.last_assistant_text.as_deref() == Some(content.as_str()) {
        lines.clear();
    } else {
        app.last_assistant_text = Some(content);
    }

    if !streamed_final {
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
    append_lines(app, lines, !streamed_final);
}

fn append_lines(app: &mut AppState, mut lines: Vec<LogLine>, trailing_space: bool) {
    if !app.enable_debug_print {
        lines.retain(|line| !matches!(line.kind(), LogKind::Runtime | LogKind::Rpc));
    }
    if lines.is_empty() && !trailing_space {
        return;
    }
    let prev_summary = last_summary_kind(&app.log, app.enable_debug_print);
    let mut lines = add_kind_spacing(lines, prev_summary, app.enable_debug_print);
    if trailing_space && !matches!(lines.last().map(LogLine::kind), Some(LogKind::Space)) {
        lines.push(LogLine::new(LogKind::Space, ""));
    }
    app.extend_lines(lines);
}

fn handle_prompt_request(app: &mut AppState, request: UiPromptRequest) {
    let mut input = InputState::default();
    if let Some(default_value) = request.default_value.as_deref() {
        input.set_from(default_value);
    }
    app.overlays.runtime_dialogs.prompt = Some(PromptSlot {
        state: PromptDialogState {
            id: request.id,
            title: request.title,
            message: request.message,
            multiline: request.multiline,
            secret: request.secret,
        },
        input,
    });
}

fn handle_pick_request(app: &mut AppState, request: UiPickRequest, tx: &mut dyn RuntimeTx) {
    match app.overlays.runtime_dialogs.pick.take() {
        Some(RuntimePickDialog::List(RuntimePickList {
            id,
            kind: RuntimePickListKind::ClientToolChoice,
            ..
        })) => {
            app.rpc_pending.client_tool_choice_ids.remove(&id);
            if let Err(error) = send_client_tool_error(tx, &id, "choice superseded") {
                app.push_error_report("client tool response error", error.to_string());
            }
        }
        Some(existing) => {
            app.overlays.runtime_dialogs.pick = Some(existing);
            let empty: Vec<String> = Vec::new();
            if let Err(error) = send_pick_response(tx, &request.id, &empty) {
                app.push_error_report("pick response error", error.to_string());
            }
            return;
        }
        None => {}
    }
    if let Some(panel) = build_onboarding_model_list_panel(&request) {
        app.overlays.runtime_dialogs.pick = Some(RuntimePickDialog::OnboardingModelList {
            request_id: request.id,
            panel: Box::new(panel),
        });
        return;
    }
    let chosen = vec![false; request.items.len()];
    app.overlays.runtime_dialogs.pick = Some(RuntimePickDialog::List(RuntimePickList {
        id: request.id,
        title: request.title,
        message: request.message,
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
        kind: if request.approval {
            RuntimePickListKind::Approval {
                review_offset: None,
            }
        } else {
            RuntimePickListKind::Standard
        },
    }));
}
