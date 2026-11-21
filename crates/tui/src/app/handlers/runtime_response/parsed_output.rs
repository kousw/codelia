use super::formatters::{
    add_kind_spacing, format_duration, last_summary_kind, tool_call_summary_with_status_icon,
    tool_call_with_status_icon,
};
use super::panel_builders::build_onboarding_model_list_panel;
use crate::app::handlers::confirm::handle_confirm_request;
use crate::app::runtime::{
    ParsedOutput, PermissionReadyUpdate, ReplayProgressEvent, ToolCallResultUpdate, UiPickRequest,
    UiPromptRequest,
};
use crate::app::state::{LogKind, LogLine, LogTone};
use crate::app::{
    AppState, LogComponentSpan, PickDialogItem, PickDialogState, PromptDialogState,
    PROMPT_DISPATCH_RETRY_BACKOFF,
};
use std::time::Instant;

use super::RuntimeStdin;

const UNKNOWN_RUN_SCOPE: &str = "unknown";

type PendingComponentStart = (String, LogKind);

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
enum ToolResultReplacementMode {
    KeepExistingSummary,
    UseFallbackSummary,
}

fn take_first_line_by_kind(lines: &mut Vec<LogLine>, kind: LogKind) -> Option<LogLine> {
    let index = lines.iter().position(|line| line.kind() == kind)?;
    Some(lines.remove(index))
}

fn current_run_scope(app: &AppState) -> String {
    app.runtime_info
        .active_run_id
        .clone()
        .unwrap_or_else(|| UNKNOWN_RUN_SCOPE.to_string())
}

fn clear_component_tracking_for_run(app: &mut AppState, run_scope: &str) {
    app.active_compaction_component_by_scope.remove(run_scope);
    app.compaction_sequence_by_scope.remove(run_scope);
    let prefix = format!("run:{run_scope}:");
    app.pending_component_lines
        .retain(|key, _| !key.starts_with(&prefix));
}

fn next_compaction_component_key(app: &mut AppState, run_scope: &str) -> String {
    let next = app
        .compaction_sequence_by_scope
        .entry(run_scope.to_string())
        .and_modify(|value| *value = value.saturating_add(1))
        .or_insert(1);
    format!("run:{run_scope}:compaction#{next}")
}

fn take_component_line_index(app: &mut AppState, key: &str) -> Option<usize> {
    let span = app.pending_component_lines.get(key).copied()?;
    let index = span.first_index();
    if app.log.get(index).is_some() {
        return Some(index);
    }
    app.pending_component_lines.remove(key);
    None
}

fn take_active_compaction_key(app: &mut AppState, run_scope: &str) -> Option<String> {
    if let Some(key) = app.active_compaction_component_by_scope.remove(run_scope) {
        return Some(key);
    }
    if run_scope != UNKNOWN_RUN_SCOPE {
        return None;
    }
    if app.active_compaction_component_by_scope.len() == 1 {
        let only_scope = app
            .active_compaction_component_by_scope
            .keys()
            .next()
            .cloned()?;
        return app.active_compaction_component_by_scope.remove(&only_scope);
    }
    None
}

fn apply_compaction_component_events(
    app: &mut AppState,
    lines: &mut Vec<LogLine>,
    pending_component_starts: &mut Vec<PendingComponentStart>,
    compaction_started: bool,
    compaction_completed: bool,
) {
    if compaction_started {
        if let Some(running_line) = take_first_line_by_kind(lines, LogKind::Compaction) {
            let run_scope = current_run_scope(app);
            let key = next_compaction_component_key(app, &run_scope);
            app.active_compaction_component_by_scope
                .insert(run_scope, key.clone());
            pending_component_starts.push((key, LogKind::Compaction));
            lines.insert(0, running_line);
        }
    }

    if !compaction_completed {
        return;
    }

    let Some(completion_line) = take_first_line_by_kind(lines, LogKind::Compaction) else {
        return;
    };

    let run_scope = current_run_scope(app);
    let Some(active_key) = take_active_compaction_key(app, &run_scope) else {
        lines.insert(0, completion_line);
        return;
    };

    if let Some(index) = take_component_line_index(app, &active_key) {
        app.replace_log_line(index, completion_line);
        app.pending_component_lines.remove(&active_key);
    } else {
        lines.insert(0, completion_line);
    }
}

fn register_pending_component_lines(
    app: &mut AppState,
    appended_from: usize,
    pending_component_starts: Vec<PendingComponentStart>,
) {
    let mut search_from = appended_from;
    for (key, kind) in pending_component_starts {
        let Some((index, _)) = app
            .log
            .iter()
            .enumerate()
            .skip(search_from)
            .find(|(_, line)| line.kind() == kind)
        else {
            continue;
        };
        app.pending_component_lines
            .insert(key, LogComponentSpan::single(index));
        search_from = index.saturating_add(1);
    }
}

fn tool_component_key(run_scope: &str, tool_call_id: &str) -> String {
    format!("run:{run_scope}:tool:{tool_call_id}")
}

fn resolve_tool_component_key(app: &AppState, tool_call_id: &str) -> Option<String> {
    let suffix = format!(":tool:{tool_call_id}");
    app.pending_component_lines
        .iter()
        .filter(|(key, _)| key.ends_with(&suffix))
        .max_by_key(|(_, span)| span.first_index())
        .map(|(key, _)| key.clone())
}

fn tool_result_replacement_mode(tool: &str) -> ToolResultReplacementMode {
    match tool {
        "shell"
        | "shell_status"
        | "shell_logs"
        | "shell_wait"
        | "shell_result"
        | "shell_cancel"
        | "webfetch"
        | "task_spawn"
        | "task_wait"
        | "task_status"
        | "task_result"
        | "task_cancel"
        | "task_list"
        | "task_cancel_all"
        | "task_send_message"
        | "task_receive_messages" => ToolResultReplacementMode::UseFallbackSummary,
        _ => ToolResultReplacementMode::KeepExistingSummary,
    }
}

fn fallback_unconsumed_steers(
    app: &mut AppState,
    finished_run_scope: Option<&str>,
    unconsumed_steer_ids: &[String],
) {
    if app.in_flight_steers.is_empty() {
        return;
    }
    let unconsumed_set: std::collections::HashSet<&str> =
        unconsumed_steer_ids.iter().map(String::as_str).collect();
    let mut kept = std::collections::VecDeque::with_capacity(app.in_flight_steers.len());
    let mut fallen_back = Vec::new();
    while let Some(steer) = app.in_flight_steers.pop_front() {
        let matches_unconsumed_id = steer
            .server_steer_id
            .as_deref()
            .is_some_and(|id| unconsumed_set.contains(id));
        let matches_finished_run = finished_run_scope.is_some_and(|scope| steer.run_id == scope);
        if matches_unconsumed_id || matches_finished_run {
            fallen_back.push(steer);
        } else {
            kept.push_back(steer);
        }
    }
    app.in_flight_steers = kept;

    for mut steer in fallen_back {
        let steer_label = steer
            .server_steer_id
            .clone()
            .unwrap_or_else(|| steer.client_steer_id.clone());
        if steer.submission.queue_id.is_empty() {
            steer.submission.queue_id = app.allocate_prompt_queue_id();
        }
        let queue_id = steer.submission.queue_id.clone();
        crate::app::handlers::command::insert_pending_prompt_ordered(
            &mut app.pending_prompt_queue,
            steer.submission,
        );
        app.push_line(
            LogKind::Status,
            format!(
                "Steer {steer_label} was not picked up before run ended; moved to queue ({queue_id}, queue={})",
                app.pending_prompt_queue.len()
            ),
        );
    }
}

pub(super) fn apply_parsed_output(
    app: &mut AppState,
    parsed: ParsedOutput,
    child_stdin: &mut RuntimeStdin,
    next_id: &mut impl FnMut() -> String,
) -> bool {
    let ParsedOutput {
        stream_update,
        mut lines,
        status,
        status_run_id,
        run_error,
        context_left_percent,
        llm_metrics,
        assistant_text,
        reasoning_text,
        stream_reset,
        canonical_run_id,
        final_text,
        rpc_response,
        goal_notification,
        confirm_request,
        prompt_request,
        pick_request,
        cancelled_pick_id,
        client_tool_request,
        client_tool_cancel,
        replay_progress,
        tool_call_start_id,
        tool_call_result,
        compaction_started,
        compaction_completed,
        permission_preview_update,
        permission_ready_update,
        applied_steer_id,
        unconsumed_steer_ids,
    } = parsed;

    if let Some(notification) = goal_notification {
        crate::app::goal::notify(app, notification);
        return true;
    }

    if let Some(update) = stream_update {
        app.apply_stream_update(update);
    }
    if let Some(steer_id) = applied_steer_id {
        if let Some(pos) = app
            .in_flight_steers
            .iter()
            .position(|steer| steer.server_steer_id.as_deref() == Some(steer_id.as_str()))
        {
            if let Some(steer) = app.in_flight_steers.remove(pos) {
                lines = crate::app::util::user_message::user_message_lines(
                    &steer.submission.display_text,
                    &steer.submission.image_descriptions,
                );
            }
        }
    }
    if let Some(progress) = replay_progress {
        match progress {
            ReplayProgressEvent::Call {
                run_id,
                tool_call_id,
                args,
            } => {
                app.pending_history_progress
                    .insert((run_id, tool_call_id), args);
            }
            ReplayProgressEvent::Result {
                run_id,
                tool_call_id,
                is_error,
            } => {
                if let Some(args) = app
                    .pending_history_progress
                    .remove(&(run_id.clone(), tool_call_id))
                {
                    if !is_error {
                        super::client_tools::apply_progress(app, &args, Some(&run_id));
                    }
                }
            }
        }
    }

    if let Some(status) = status {
        let terminal = matches!(status.as_str(), "completed" | "error" | "cancelled");
        if terminal {
            app.clear_stream_output();
            let finished_run_scope = status_run_id
                .clone()
                .or_else(|| app.runtime_info.active_run_id.clone());
            app.rpc_pending.run_start_id = None;
            app.rpc_pending.run_cancel_id = None;
            app.runtime_info.active_run_id = None;
            app.permission_preview_by_tool_call.clear();
            app.permission_ready_tool_call_ids.clear();
            let retry_at = Instant::now() + PROMPT_DISPATCH_RETRY_BACKOFF;
            match app.next_queue_dispatch_retry_at {
                Some(current) if current >= retry_at => {}
                _ => app.next_queue_dispatch_retry_at = Some(retry_at),
            }
            if let Some(run_scope) = finished_run_scope.as_deref() {
                clear_component_tracking_for_run(app, run_scope);
            }
            fallback_unconsumed_steers(app, finished_run_scope.as_deref(), &unconsumed_steer_ids);
        } else if let Some(run_id) = status_run_id {
            app.runtime_info.active_run_id = Some(run_id);
        }
        app.update_run_status(status);
    }
    if let Some(percent) = context_left_percent {
        app.context_left_percent = Some(percent);
    }
    if let Some(metrics) = llm_metrics {
        if app.runtime_info.active_run_id.as_deref() == Some(metrics.run_id.as_str()) {
            if let Some(tps) = metrics.output_tokens_per_second {
                app.runtime_info.last_llm_tps = Some(tps);
            }
        }
    }
    let mut lines = lines;
    let live_output = canonical_run_id
        .as_deref()
        .is_some_and(|id| app.runtime_info.active_run_id.as_deref() == Some(id));
    if stream_reset && live_output {
        app.clear_stream_output();
    }
    if let Some(text) = reasoning_text.as_deref().filter(|_| live_output) {
        app.reconcile_stream_output(true, text, &mut lines);
    }
    if let Some(text) = assistant_text {
        if live_output {
            app.reconcile_stream_output(false, &text, &mut lines);
        }
        app.last_assistant_text = Some(text);
    }

    let mut pending_component_starts: Vec<PendingComponentStart> = Vec::new();
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
    if let Some(PermissionReadyUpdate { tool_call_id }) = permission_ready_update {
        if !app.permission_ready_tool_call_ids.insert(tool_call_id) {
            lines.clear();
        }
    }
    if let Some(ToolCallResultUpdate {
        tool_call_id,
        tool,
        is_error,
        preserve_call_summary,
        fallback_summary,
        edit_diff_fingerprint,
    }) = tool_call_result
    {
        let replacement_mode = if preserve_call_summary {
            ToolResultReplacementMode::KeepExistingSummary
        } else {
            tool_result_replacement_mode(&tool)
        };
        app.permission_ready_tool_call_ids.remove(&tool_call_id);
        let preview = app.permission_preview_by_tool_call.remove(&tool_call_id);
        let suppress_edit_diff_lines = matches!(tool.as_str(), "edit" | "apply_patch")
            && preview.as_ref().is_some_and(|record| {
                record.has_diff
                    && !record.truncated
                    && record.diff_fingerprint.as_deref() == edit_diff_fingerprint.as_deref()
            });
        let mut inserted_fallback_summary = false;
        let run_scope = current_run_scope(app);
        let scoped_key = tool_component_key(&run_scope, &tool_call_id);
        let component_key = if app.pending_component_lines.contains_key(&scoped_key) {
            Some(scoped_key)
        } else {
            resolve_tool_component_key(app, &tool_call_id)
        };
        if let Some(component_key) = component_key {
            if let Some(index) = take_component_line_index(app, &component_key) {
                app.pending_component_lines.remove(&component_key);
                if let Some(existing) = app.log.get(index).cloned() {
                    let updated = match replacement_mode {
                        ToolResultReplacementMode::UseFallbackSummary => {
                            tool_call_summary_with_status_icon(
                                &fallback_summary.plain_text(),
                                is_error,
                            )
                        }
                        ToolResultReplacementMode::KeepExistingSummary => {
                            tool_call_with_status_icon(&existing, is_error)
                        }
                    };
                    app.replace_log_line(index, updated);
                } else {
                    lines.insert(0, fallback_summary);
                    inserted_fallback_summary = true;
                }
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
    if let Some(tool_call_id) = tool_call_start_id.as_deref() {
        let run_scope = current_run_scope(app);
        pending_component_starts.push((
            tool_component_key(&run_scope, tool_call_id),
            LogKind::ToolCall,
        ));
    }
    apply_compaction_component_events(
        app,
        &mut lines,
        &mut pending_component_starts,
        compaction_started,
        compaction_completed,
    );

    let has_final = final_text.is_some();
    let streamed_final = live_output
        && final_text
            .as_deref()
            .is_some_and(|text| app.reconcile_final_output(text, &mut lines));
    if has_final && live_output {
        app.streamed_completion = streamed_final;
        app.clear_stream_output();
    }
    if let Some(final_text) = final_text {
        if !streamed_final && app.last_assistant_text.as_deref() == Some(final_text.as_str()) {
            lines.clear();
        } else {
            app.last_assistant_text = Some(final_text);
        }
    }

    if has_final && !streamed_final {
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
    if has_final
        && !streamed_final
        && !matches!(lines.last().map(LogLine::kind), Some(LogKind::Space))
    {
        lines.push(LogLine::new(LogKind::Space, ""));
    }
    let appended_from = app.log.len();
    app.extend_lines(lines);
    register_pending_component_lines(app, appended_from, pending_component_starts);

    if let Some(error) = run_error {
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
    let mut needs_redraw = true;
    if let Some(response) = rpc_response {
        if super::handle_rpc_response(app, response, child_stdin, next_id) {
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
    if cancelled_pick_id.as_ref().is_some_and(|id| {
        app.pick_dialog
            .as_ref()
            .is_some_and(|dialog| &dialog.id == id)
    }) {
        app.pick_dialog = None;
        needs_redraw = true;
    }
    if let Some(request) = pick_request {
        handle_pick_request(app, request);
        needs_redraw = true;
    }
    if let Some(request) = client_tool_request {
        if super::client_tools::handle_client_tool_request(app, request, child_stdin) {
            needs_redraw = true;
        }
    }
    if let Some(cancellation) = client_tool_cancel {
        if super::client_tools::handle_client_tool_cancel(app, cancellation) {
            needs_redraw = true;
        }
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
        approval: request.approval,
        review_offset: None,
        shell_rule_picker: None,
    });
}

#[cfg(test)]
mod tests {
    use super::{
        apply_compaction_component_events, apply_parsed_output, clear_component_tracking_for_run,
        register_pending_component_lines, resolve_tool_component_key, take_active_compaction_key,
        tool_component_key, PendingComponentStart, UNKNOWN_RUN_SCOPE,
    };
    use crate::app::handlers::runtime_response::RuntimeStdin;
    use crate::app::runtime::{parse_runtime_output, parse_runtime_output_with_history};
    use crate::app::state::{LogKind, LogLine};
    use crate::app::{AppState, LogComponentSpan, PendingPromptRun};
    use serde_json::json;
    use std::io::{BufWriter, Write};
    use std::process::Stdio;
    use std::time::Instant;

    #[test]
    fn streaming_partial_survives_cancel_and_final_is_rendered_once() {
        with_runtime_writer(|writer| {
            let mut app = AppState::default();
            app.runtime_info.active_run_id = Some("run".into());
            for event in [
                json!({"type":"text.delta","stream_id":"s","index":0,"delta":""}),
                json!({"type":"text.delta","stream_id":"s","index":0,"delta":"partial"}),
            ] {
                let parsed = parse_runtime_output(
                    &json!({"method":"agent.event","params":{"run_id":"run","event":event}})
                        .to_string(),
                );
                apply_parsed_output(&mut app, parsed, writer, &mut || "id".into());
            }
            app.flush_stream_output();
            assert!(app
                .log
                .iter()
                .any(|line| line.plain_text().contains("partial")));
            assert!(app
                .stream_preview
                .segments()
                .iter()
                .any(|segment| segment.content == "partial"));
            let terminal = parse_runtime_output(
                r#"{"method":"run.status","params":{"run_id":"run","status":"cancelled"}}"#,
            );
            apply_parsed_output(&mut app, terminal, writer, &mut || "id".into());
            assert!(app.stream_preview.segments().is_empty());
            let final_event = parse_runtime_output(
                r#"{"method":"agent.event","params":{"run_id":"run","event":{"type":"final","content":"canonical answer"}}}"#,
            );
            apply_parsed_output(&mut app, final_event, writer, &mut || "id".into());
            assert_eq!(
                app.log
                    .iter()
                    .filter(|line| line.plain_text().contains("canonical answer"))
                    .count(),
                1
            );
            app.flush_stream_output();
            assert!(app
                .log
                .iter()
                .any(|line| line.plain_text().contains("partial")));
        });
    }

    #[test]
    fn structured_errors_show_context_only_on_failure_and_keep_safe_details_for_errors_show() {
        with_runtime_writer(|writer| {
            let mut app = AppState::default();
            app.runtime_info.current_model = Some("fixture-model".into());
            let healthy = parse_runtime_output(
                r#"{"method":"run.status","params":{"run_id":"run","status":"running"}}"#,
            );
            apply_parsed_output(&mut app, healthy, writer, &mut || "id".into());
            assert!(app.last_error_detail.is_none());
            assert!(!app
                .log
                .iter()
                .any(|line| line.plain_text().contains("Next:")));
            let failure = parse_runtime_output(
                r#"{"method":"run.status","params":{"run_id":"run","status":"error","message":"Google request failed.","error":{"name":"ProviderFailureError","message":"Google request failed.","provider":"google","kind":"provider","status":503,"attempts":1,"max_attempts":3,"detail":"The response stream ended before completion.","code":"response_incomplete","hint":"Retry; if it repeats, share /errors show.","stack":"private-stack"}}}"#,
            );
            apply_parsed_output(&mut app, failure, writer, &mut || "id".into());
            let shown = app
                .log
                .iter()
                .map(LogLine::plain_text)
                .collect::<Vec<_>>()
                .join("\n");
            assert!(shown.contains("HTTP 503"));
            assert!(shown.contains("ended before completion"));
            assert!(shown.contains("Next:"));
            assert!(!shown.contains("private-stack"));
            let details = app.last_error_detail.as_deref().unwrap();
            assert!(details.contains("Provider: google"));
            assert!(details.contains("Model: fixture-model"));
            assert!(details.contains("Code: response_incomplete"));
            assert!(app.show_last_error_detail());
            assert!(app
                .log
                .iter()
                .any(|line| line.plain_text().contains("Code: response_incomplete")));
        });
    }

    fn feed_event(app: &mut AppState, writer: &mut RuntimeStdin, event: serde_json::Value) {
        let parsed = parse_runtime_output(
            &json!({"method":"agent.event","params":{"run_id":"run","event":event}}).to_string(),
        );
        apply_parsed_output(app, parsed, writer, &mut || "id".into());
    }

    fn transcript_frame(app: &mut AppState) -> ratatui::buffer::Buffer {
        let mut terminal =
            ratatui::Terminal::new(ratatui::backend::TestBackend::new(48, 18)).unwrap();
        terminal
            .draw(|frame| crate::app::view::draw_ui(frame, app))
            .unwrap();
        terminal.backend().buffer().clone()
    }

    #[test]
    fn shorter_final_replaces_uncommitted_stream_suffix() {
        with_runtime_writer(|writer| {
            let mut app = AppState::default();
            app.runtime_info.active_run_id = Some("run".into());
            feed_event(
                &mut app,
                writer,
                json!({"type":"text.delta","stream_id":"s","index":0,"delta":"hello wrong"}),
            );
            feed_event(&mut app, writer, json!({"type":"final","content":"hello"}));
            let text = app
                .log
                .iter()
                .map(|line| line.plain_text())
                .collect::<Vec<_>>()
                .join("\n");
            assert!(text.contains("hello"));
            assert!(!text.contains("wrong"));
        });
    }

    #[test]
    fn interleaved_text_and_reasoning_confirm_all_text_segments_once() {
        with_runtime_writer(|writer| {
            let mut app = AppState::default();
            app.runtime_info.active_run_id = Some("run".into());
            for event in [
                json!({"type":"text.delta","stream_id":"s","index":0,"delta":"first"}),
                json!({"type":"reasoning.delta","stream_id":"s","index":0,"delta":"thought"}),
                json!({"type":"text.delta","stream_id":"s","index":1,"delta":"second"}),
                json!({"type":"reasoning","content":"thought"}),
                json!({"type":"final","content":"first\nsecond"}),
            ] {
                feed_event(&mut app, writer, event);
            }
            for value in ["first", "second"] {
                assert_eq!(
                    app.log
                        .iter()
                        .filter(|line| line.plain_text().contains(value))
                        .count(),
                    1
                );
            }
            assert!(app.stream_preview.segments().is_empty());
        });
    }

    #[test]
    fn public_delta_blocks_join_without_duplicate_canonical_final() {
        with_runtime_writer(|writer| {
            let mut app = AppState::default();
            app.runtime_info.active_run_id = Some("run".into());
            feed_event(
                &mut app,
                writer,
                json!({"type":"text.delta","stream_id":"s","index":0,"delta":"first"}),
            );
            feed_event(
                &mut app,
                writer,
                json!({"type":"text.delta","stream_id":"s","index":1,"delta":"second"}),
            );
            let before = transcript_frame(&mut app);
            feed_event(
                &mut app,
                writer,
                json!({"type":"final","content":"first\nsecond"}),
            );
            assert_eq!(before, transcript_frame(&mut app));
            assert!(app.stream_preview.segments().is_empty());
            assert!(!app
                .log
                .iter()
                .any(|line| line.plain_text().contains("Response revised")));
        });
    }

    #[test]
    fn full_markdown_frame_is_unchanged_at_canonical_final() {
        with_runtime_writer(|writer| {
            let mut app = AppState::default();
            app.update_run_status("running".into());
            app.runtime_info.active_run_id = Some("run".into());
            let content = format!(
                "# Answer\n{}\n```rust\nfn main() {{}}\n```",
                (0..600)
                    .map(|i| format!("- item {i}: 日本語🙂 **bold** and `code`\n"))
                    .collect::<String>()
            );
            assert!(content.len() > 16384);
            for chunk in content.split_inclusive('\n') {
                feed_event(
                    &mut app,
                    writer,
                    json!({"type":"text.delta","stream_id":"s","index":0,"delta":chunk}),
                );
            }
            let before = transcript_frame(&mut app);
            app.scroll_up(580);
            let scrolled = transcript_frame(&mut app);
            assert_ne!(before, scrolled);
            assert_eq!(scrolled, transcript_frame(&mut app));
            feed_event(&mut app, writer, json!({"type":"final","content":content}));
            assert_eq!(scrolled, transcript_frame(&mut app));
            app.scroll_from_bottom = 0;
            assert_eq!(before, transcript_frame(&mut app));
            assert!(app.stream_preview.segments().is_empty());
            assert!(app.streamed_completion);
            assert!(!app
                .log
                .iter()
                .any(|line| line.plain_text().contains("Run duration:")));
        });
    }

    #[test]
    fn reasoning_handoff_keeps_the_answer_and_its_position() {
        with_runtime_writer(|writer| {
            let mut app = AppState::default();
            app.runtime_info.active_run_id = Some("run".into());
            feed_event(
                &mut app,
                writer,
                json!({"type":"reasoning.delta","stream_id":"s","index":0,"delta":"thinking\nmore thought"}),
            );
            feed_event(
                &mut app,
                writer,
                json!({"type":"text.delta","stream_id":"s","index":0,"delta":"# Result\n- **one**\n- two"}),
            );
            let before = transcript_frame(&mut app);
            feed_event(
                &mut app,
                writer,
                json!({"type":"reasoning","content":"thinking\nmore thought"}),
            );
            assert_eq!(before, transcript_frame(&mut app));
            feed_event(
                &mut app,
                writer,
                json!({"type":"final","content":"# Result\n- **one**\n- two"}),
            );
            assert_eq!(before, transcript_frame(&mut app));
        });
    }

    #[test]
    fn retry_clears_abandoned_transcript_but_replayed_final_does_not_consume_live_output() {
        with_runtime_writer(|writer| {
            let mut app = AppState::default();
            app.runtime_info.active_run_id = Some("run".into());
            feed_event(
                &mut app,
                writer,
                json!({"type":"text.delta","stream_id":"s","index":0,"delta":"partial"}),
            );
            let replay = parse_runtime_output(
                r#"{"method":"agent.event","params":{"run_id":"run","meta":{"replayed":true},"event":{"type":"final","content":"partial"}}}"#,
            );
            apply_parsed_output(&mut app, replay, writer, &mut || "id".into());
            assert_eq!(app.stream_preview.segments()[0].content, "partial");
            feed_event(
                &mut app,
                writer,
                json!({"type":"llm.retry","provider":"openai","failure_kind":"network","next_attempt":2,"max_attempts":3,"delay_ms":1000}),
            );
            assert!(app.stream_preview.segments().is_empty());
            transcript_frame(&mut app);
            assert!(app
                .wrapped_log_cache
                .as_ref()
                .unwrap()
                .wrapped
                .iter()
                .any(|row| row.line.plain_text().contains("LLM retry")));
        });
    }

    fn with_runtime_writer<T>(f: impl FnOnce(&mut RuntimeStdin) -> T) -> T {
        #[cfg(windows)]
        let mut command = {
            let mut command = std::process::Command::new("cmd");
            command.args(["/C", "more"]);
            command
        };
        #[cfg(not(windows))]
        let mut command = {
            let mut command = std::process::Command::new("sh");
            command.args(["-c", "cat >/dev/null"]);
            command
        };
        let mut child = command
            .stdin(Stdio::piped())
            .stdout(Stdio::null())
            .spawn()
            .expect("spawn runtime writer");
        let stdin = child.stdin.take().expect("child stdin");
        let mut writer = BufWriter::new(stdin);
        let out = f(&mut writer);
        writer.flush().expect("flush runtime writer");
        drop(writer);
        let _ = child.kill();
        let _ = child.wait();
        out
    }

    #[test]
    fn progress_tool_events_show_only_progress_and_preserve_errors() {
        with_runtime_writer(|writer| {
            let mut app = AppState::default();
            let events = [
                json!({"method":"agent.event", "params":{"event":{
                    "type":"tool_call", "tool":"tui_show_progress", "tool_call_id":"p1",
                    "args":{"phase":"Build", "current":1, "total":2}
                }}}),
                json!({"jsonrpc":"2.0", "id":"request1", "method":"client.tool.call", "params":{
                    "run_id":"run-1", "name":"tui_show_progress",
                    "arguments":{"phase":"Build", "current":1, "total":2}, "raw_arguments":"{}"
                }}),
                json!({"method":"agent.event", "params":{"event":{
                    "type":"tool_result", "tool":"tui_show_progress", "tool_call_id":"p1",
                    "result":"progress shown"
                }}}),
            ];
            for event in events {
                apply_parsed_output(
                    &mut app,
                    parse_runtime_output(&event.to_string()),
                    writer,
                    &mut || "id".into(),
                );
            }
            assert_eq!(app.log.len(), 1);
            let text = app.log[0].plain_text();
            assert!(text.contains("Build") && text.contains("50%"));
            assert!(!text.contains("tui_show_progress"));

            let error = json!({"method":"agent.event", "params":{"event":{
                "type":"tool_result", "tool":"tui_show_progress", "tool_call_id":"p2",
                "is_error":true, "result":"error: unavailable"
            }}});
            apply_parsed_output(
                &mut app,
                parse_runtime_output(&error.to_string()),
                writer,
                &mut || "id".into(),
            );
            assert!(app
                .log
                .iter()
                .any(|line| line.plain_text().contains("unavailable")));
        });
    }

    #[cfg(unix)]
    #[test]
    fn replayed_progress_is_restored_only_after_success_without_client_rpc() {
        use std::io::Read;
        let mut child = std::process::Command::new("cat")
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .spawn()
            .expect("capture runtime writes");
        let mut writer = BufWriter::new(child.stdin.take().expect("stdin"));
        let mut app = AppState::default();
        let events = [
            json!({"type":"tool_call", "tool":"tui_show_progress", "tool_call_id":"p1", "args":{"id":"build", "phase":"Build", "current":1, "total":4}}),
            json!({"type":"tool_result", "tool":"tui_show_progress", "tool_call_id":"p1", "result":"progress shown"}),
            json!({"type":"tool_call", "tool":"tui_show_progress", "tool_call_id":"p2", "args":{"id":"build", "phase":"Build", "status":"completed", "message":"ready"}}),
            json!({"type":"tool_result", "tool":"tui_show_progress", "tool_call_id":"p2", "result":"progress shown"}),
            json!({"type":"tool_call", "tool":"tui_show_progress", "tool_call_id":"p3", "args":{"phase":"not shown"}}),
            json!({"type":"tool_result", "tool":"tui_show_progress", "tool_call_id":"p3", "is_error":true, "result":"error: invalid"}),
        ];
        for (index, event) in events.into_iter().enumerate() {
            let raw = json!({"method":"agent.event", "params": {"run_id":"old-run", "meta":{"replayed":true}, "event":event}}).to_string();
            apply_parsed_output(
                &mut app,
                parse_runtime_output(&raw),
                &mut writer,
                &mut || "id".into(),
            );
            if index == 0 {
                assert!(app.log.is_empty());
            }
        }
        assert!(app
            .log
            .iter()
            .any(|line| line.plain_text().contains("ready") && line.plain_text().contains("100%")));
        assert!(!app
            .log
            .iter()
            .any(|line| line.plain_text().contains("not shown")));
        assert!(app
            .log
            .iter()
            .any(|line| line.plain_text().contains("invalid")));
        assert!(app.pending_history_progress.is_empty());
        drop(writer);
        let mut output = String::new();
        child
            .stdout
            .take()
            .unwrap()
            .read_to_string(&mut output)
            .unwrap();
        child.wait().unwrap();
        assert!(
            output.is_empty(),
            "history replay sent client RPC: {output}"
        );
    }

    #[test]
    fn legacy_history_fallback_does_not_replay_active_run_events() {
        let event = |run_id: &str| {
            json!({"method":"agent.event", "params":{
            "run_id":run_id, "event":{"type":"tool_call", "tool":"tui_show_progress", "tool_call_id":"p1", "args":{"phase":"Build"}}
        }}).to_string()
        };
        let live = parse_runtime_output_with_history(&event("live"), true, Some("live"));
        assert!(live.replay_progress.is_none());
        let replay = parse_runtime_output_with_history(&event("old"), true, Some("live"));
        assert!(replay.replay_progress.is_some());
        let explicit = json!({"method":"agent.event", "params":{
            "run_id":"live", "meta":{"replayed":true},
            "event":{"type":"tool_call", "tool":"tui_show_progress", "tool_call_id":"p1", "args":{"phase":"Build"}}
        }}).to_string();
        assert!(
            parse_runtime_output_with_history(&explicit, true, Some("live"))
                .replay_progress
                .is_some()
        );
    }

    #[test]
    fn replayed_progress_keys_are_isolated_between_runs() {
        with_runtime_writer(|writer| {
            let mut app = AppState::default();
            for run_id in ["run-a", "run-b"] {
                for event in [
                    json!({"type":"tool_call", "tool":"tui_show_progress", "tool_call_id":"p1", "args":{"id":"build", "phase":run_id, "current":1, "total":2}}),
                    json!({"type":"tool_result", "tool":"tui_show_progress", "tool_call_id":"p1", "result":"progress shown"}),
                ] {
                    let raw = json!({"method":"agent.event", "params":{"run_id":run_id, "meta":{"replayed":true}, "event":event}}).to_string();
                    apply_parsed_output(&mut app, parse_runtime_output(&raw), writer, &mut || {
                        "id".into()
                    });
                }
            }
            assert_eq!(app.log.len(), 2);
            assert!(app.log[0].plain_text().contains("run-a"));
            assert!(app.log[1].plain_text().contains("run-b"));
        });
    }

    #[test]
    fn session_history_replays_legacy_progress_and_clears_pending_tracking() {
        use std::sync::mpsc;
        with_runtime_writer(|writer| {
            let mut app = AppState::default();
            app.rpc_pending.session_history_id = Some("history".to_string());
            let (tx, rx) = mpsc::channel();
            for event in [
                json!({"type":"tool_call", "tool":"tui_show_progress", "tool_call_id":"p1", "args":{"id":"build", "phase":"Build", "current":1, "total":2}}),
                json!({"type":"tool_result", "tool":"tui_show_progress", "tool_call_id":"p1", "result":"progress shown"}),
            ] {
                tx.send(
                    json!({"method":"agent.event", "params":{"run_id":"old-run", "event":event}})
                        .to_string(),
                )
                .unwrap();
            }
            tx.send(
                json!({"jsonrpc":"2.0", "id":"history", "result":{"runs":1,"events_sent":2}})
                    .to_string(),
            )
            .unwrap();
            super::super::process_runtime_messages(&mut app, &rx, writer, &mut || "id".into());
            assert!(app.log.iter().any(
                |line| line.plain_text().contains("Build") && line.plain_text().contains("50%")
            ));
            assert!(app.pending_history_progress.is_empty());
            assert!(!app
                .progress_component_lines
                .keys()
                .any(|key| key.starts_with("history:")));
        });
    }

    #[test]
    fn terminal_run_status_adds_dispatch_cooldown() {
        with_runtime_writer(|writer| {
            let mut app = AppState::default();
            app.pending_prompt_queue.push_back(PendingPromptRun {
                seq: 1,
                queue_id: "q1".to_string(),
                queued_at: Instant::now(),
                preview: "queued".to_string(),
                user_text: "queued".to_string(),
                display_text: "queued".to_string(),
                image_descriptions: Vec::new(),
                input_payload: json!({"type": "text", "text": "queued"}),
                attachment_count: 0,
                files: Default::default(),
                shell_result_count: 0,
                dispatch_attempts: 0,
            });
            app.runtime_info.active_run_id = Some("run-1".to_string());
            let parsed = parse_runtime_output(
                r#"{"method":"run.status","params":{"run_id":"run-1","status":"completed"}}"#,
            );

            assert!(apply_parsed_output(&mut app, parsed, writer, &mut || {
                "id-1".to_string()
            }));
            assert!(app.next_queue_dispatch_retry_at.is_some());
            assert!(app.runtime_info.active_run_id.is_none());
            assert_eq!(app.run_status.as_deref(), Some("completed"));
        });
    }

    #[test]
    fn llm_metrics_follow_active_run_and_retain_last_known_values() {
        with_runtime_writer(|writer| {
            let mut app = AppState::default();
            let mut next_id = || "id-1".to_string();
            let mut apply = |app: &mut AppState, method: &str, params: serde_json::Value| {
                apply_parsed_output(
                    app,
                    parse_runtime_output(&json!({"method": method, "params": params}).to_string()),
                    writer,
                    &mut next_id,
                );
            };
            apply(
                &mut app,
                "run.status",
                json!({"run_id": "run-1", "status": "running"}),
            );
            apply(
                &mut app,
                "run.context",
                json!({"run_id": "run-1", "context_left_percent": 96}),
            );
            apply(
                &mut app,
                "run.metrics",
                json!({"run_id": "run-1", "output_tokens_per_second": 42.25}),
            );
            assert_eq!(app.runtime_info.last_llm_tps, Some(42.25));
            apply(
                &mut app,
                "run.metrics",
                json!({"run_id": "other", "output_tokens_per_second": 99}),
            );
            assert_eq!(app.runtime_info.last_llm_tps, Some(42.25));
            apply(
                &mut app,
                "run.metrics",
                json!({"run_id": "run-1", "output_tokens_per_second": null}),
            );
            assert_eq!(app.runtime_info.last_llm_tps, Some(42.25));
            apply(
                &mut app,
                "run.metrics",
                json!({"run_id": "run-1", "output_tokens_per_second": 50}),
            );
            apply(
                &mut app,
                "run.status",
                json!({"run_id": "run-1", "status": "completed"}),
            );
            assert_eq!(app.runtime_info.last_llm_tps, Some(50.0));
            assert_eq!(app.context_left_percent, Some(96));
            apply(
                &mut app,
                "run.status",
                json!({"run_id": "run-2", "status": "running"}),
            );
            assert_eq!(app.runtime_info.last_llm_tps, Some(50.0));
            assert_eq!(app.context_left_percent, Some(96));
            apply(
                &mut app,
                "run.metrics",
                json!({"run_id": "run-1", "output_tokens_per_second": 99}),
            );
            assert_eq!(app.runtime_info.last_llm_tps, Some(50.0));
            apply(
                &mut app,
                "run.metrics",
                json!({"run_id": "run-2", "output_tokens_per_second": null}),
            );
            apply(
                &mut app,
                "run.context",
                json!({"run_id": "run-2", "context_left_percent": null}),
            );
            assert_eq!(app.runtime_info.last_llm_tps, Some(50.0));
            assert_eq!(app.context_left_percent, Some(96));
            apply(
                &mut app,
                "run.metrics",
                json!({"run_id": "run-2", "output_tokens_per_second": 0}),
            );
            apply(
                &mut app,
                "run.context",
                json!({"run_id": "run-2", "context_left_percent": 0}),
            );
            assert_eq!(app.runtime_info.last_llm_tps, Some(0.0));
            assert_eq!(app.context_left_percent, Some(0));
        });
    }

    #[test]
    fn client_tool_timeout_clears_matching_choice_dialog_and_pending_id() {
        with_runtime_writer(|writer| {
            let mut app = AppState::default();
            let request = parse_runtime_output(
                &json!({
                    "jsonrpc": "2.0",
                    "id": "ui_choice_1",
                    "method": "client.tool.call",
                    "params": {
                        "run_id": "run-1",
                        "name": "tui_ask_user_choice",
                        "arguments": {
                            "title": "Choose next",
                            "choices": [{ "id": "continue", "label": "Continue" }]
                        },
                        "raw_arguments": "{}"
                    }
                })
                .to_string(),
            );
            assert!(apply_parsed_output(&mut app, request, writer, &mut || {
                "id-1".to_string()
            }));
            assert_eq!(
                app.pick_dialog.as_ref().map(|dialog| dialog.id.as_str()),
                Some("ui_choice_1")
            );
            assert!(app
                .rpc_pending
                .client_tool_choice_ids
                .contains("ui_choice_1"));

            let cancellation = parse_runtime_output(
                r#"{"jsonrpc":"2.0","method":"client.tool.cancel","params":{"request_id":"ui_choice_1","run_id":"run-1","name":"tui_ask_user_choice","reason":"timeout"}}"#,
            );
            assert!(apply_parsed_output(
                &mut app,
                cancellation,
                writer,
                &mut || "id-2".to_string()
            ));

            assert!(app.pick_dialog.is_none());
            assert!(!app
                .rpc_pending
                .client_tool_choice_ids
                .contains("ui_choice_1"));
            assert!(!app.selection_input_blocked());
            assert!(app
                .log
                .iter()
                .any(|line| line.plain_text() == "Choice request timed out."));
        });
    }

    #[test]
    fn stale_client_tool_cancel_leaves_active_choice_untouched() {
        with_runtime_writer(|writer| {
            let mut app = AppState::default();
            let request = parse_runtime_output(
                r#"{"jsonrpc":"2.0","id":"ui_choice_active","method":"client.tool.call","params":{"run_id":"run-1","name":"tui_ask_user_choice","arguments":{"title":"Choose next","choices":[{"id":"continue","label":"Continue"}]},"raw_arguments":"{}"}}"#,
            );
            assert!(apply_parsed_output(&mut app, request, writer, &mut || {
                "id-1".to_string()
            }));

            let stale_cancellation = parse_runtime_output(
                r#"{"jsonrpc":"2.0","method":"client.tool.cancel","params":{"request_id":"ui_choice_stale","run_id":"run-1","name":"tui_ask_user_choice","reason":"timeout"}}"#,
            );
            assert!(apply_parsed_output(
                &mut app,
                stale_cancellation,
                writer,
                &mut || "id-2".to_string()
            ));

            assert_eq!(
                app.pick_dialog.as_ref().map(|dialog| dialog.id.as_str()),
                Some("ui_choice_active")
            );
            assert!(app
                .rpc_pending
                .client_tool_choice_ids
                .contains("ui_choice_active"));
        });
    }

    #[test]
    fn subagent_failure_replaces_wait_header_with_named_failure() {
        with_runtime_writer(|writer| {
            let mut app = AppState::default();
            app.push_line(LogKind::ToolCall, "Wait for agent: 13c77088");
            app.pending_component_lines.insert(
                tool_component_key(UNKNOWN_RUN_SCOPE, "wait-1"),
                LogComponentSpan::single(0),
            );
            let parsed = parse_runtime_output(&json!({
                "method":"agent.event", "params":{"event":{
                    "type":"tool_result", "tool":"task_wait", "tool_call_id":"wait-1",
                    "is_error":false,
                    "result":{"name":"MapleScope3", "state":"failed", "termination_reason":"execution_error", "failure_message":"Model session is missing"}
                }}
            }).to_string());
            assert!(apply_parsed_output(&mut app, parsed, writer, &mut || "id".into()));
            assert_eq!(
                app.log[0].plain_text(),
                "✖ Agent: MapleScope3 — failed (execution_error)"
            );
            assert_eq!(app.log[1].plain_text(), "  Model session is missing");
        });
    }

    #[test]
    fn shell_tool_result_replaces_pending_shell_call_with_fallback_summary() {
        with_runtime_writer(|writer| {
            let mut app = AppState::default();
            app.push_line(LogKind::ToolCall, "Shell: git status --short");
            app.pending_component_lines.insert(
                tool_component_key(UNKNOWN_RUN_SCOPE, "shell-result-1"),
                LogComponentSpan::single(0),
            );

            let parsed = parse_runtime_output(
                &json!({
                    "jsonrpc": "2.0",
                    "method": "agent.event",
                    "params": {
                        "event": {
                            "type": "tool_result",
                            "tool": "shell",
                            "tool_call_id": "shell-result-1",
                            "is_error": false,
                            "result": {
                                "key": "shell-1234abcd",
                                "command": "git status --short",
                                "state": "completed",
                                "exit_code": 0,
                                "duration_ms": 12,
                                "stdout": " M crates/tui/src/app/runtime/parser.rs"
                            }
                        }
                    }
                })
                .to_string(),
            );

            assert!(apply_parsed_output(&mut app, parsed, writer, &mut || {
                "id-1".to_string()
            }));
            assert_eq!(
                app.log[0].plain_text(),
                "✔ Shell: git status --short (12 ms)"
            );
            assert_eq!(app.log[0].spans()[0].kind, LogKind::ToolResult);
            assert_eq!(app.log[0].spans()[2].kind, LogKind::ToolCall);
            assert_eq!(app.log[0].spans()[4].kind, LogKind::Assistant);
            assert_eq!(
                app.log[1].plain_text(),
                "   M crates/tui/src/app/runtime/parser.rs"
            );
        });
    }

    #[test]
    fn denied_shell_reports_reason_once_and_preserves_safe_call_context() {
        with_runtime_writer(|writer| {
            for (command, reason, expected_header) in [
                (
                    "git status --short",
                    "review_unavailable: The review request timed out.",
                    "✖ Shell: git status --short",
                ),
                (
                    "echo mock-credential",
                    "review_evidence_credential: The review evidence matches a credential detector. Evidence location: command arguments.",
                    "✖ Shell: command held before review",
                ),
            ] {
                let mut app = AppState::default();
                let call = json!({
                    "method": "agent.event",
                    "params": { "event": {
                        "type": "tool_call", "tool": "shell", "tool_call_id": "shell-1",
                        "args": { "command": command }
                    }}
                });
                let result = json!({
                    "method": "agent.event",
                    "params": { "event": {
                        "type": "tool_result", "tool": "shell", "tool_call_id": "shell-1",
                        "is_error": true,
                        "result": format!("Permission denied: {reason} Do not repeat this request without new evidence or updated instructions. Otherwise report the blocker.")
                    }}
                });

                for event in [call, result] {
                    let parsed = parse_runtime_output(&event.to_string());
                    assert!(apply_parsed_output(&mut app, parsed, writer, &mut || {
                        "id-1".to_string()
                    }));
                }

                assert_eq!(app.log.len(), 2);
                assert_eq!(app.log[0].plain_text(), expected_header);
                assert_eq!(app.log[1].plain_text(), format!("  {reason}"));
            }
        });
    }

    #[test]
    fn webfetch_tool_result_replaces_pending_call_with_fallback_summary() {
        with_runtime_writer(|writer| {
            let mut app = AppState::default();
            app.push_line(LogKind::ToolCall, "WebFetch: www.google.com");
            app.pending_component_lines.insert(
                tool_component_key(UNKNOWN_RUN_SCOPE, "webfetch-result-1"),
                LogComponentSpan::single(0),
            );

            let parsed = parse_runtime_output(
                &json!({
                    "jsonrpc": "2.0",
                    "method": "agent.event",
                    "params": {
                        "event": {
                            "type": "tool_result",
                            "tool": "webfetch",
                            "tool_call_id": "webfetch-result-1",
                            "is_error": false,
                            "result": {
                                "url": "https://www.google.com",
                                "final_url": "https://www.google.com/",
                                "status": 200,
                                "output_format": "text",
                                "content": "Google",
                                "byte_size": 50000,
                                "duration_ms": 227,
                                "truncated": true
                            }
                        }
                    }
                })
                .to_string(),
            );

            assert!(apply_parsed_output(&mut app, parsed, writer, &mut || {
                "id-1".to_string()
            }));
            assert_eq!(
                app.log[0].plain_text(),
                "✔ WebFetch: www.google.com/ (49 KB, 227 ms, truncated)"
            );
            assert_eq!(app.log[0].kind(), LogKind::ToolResult);
            assert_eq!(app.log[0].spans()[0].kind, LogKind::ToolResult);
            assert_eq!(app.log[0].spans()[2].kind, LogKind::ToolCall);
            assert_eq!(app.log[0].spans()[4].kind, LogKind::Assistant);
        });
    }

    #[test]
    fn non_shell_tool_result_keeps_existing_summary_and_only_adds_status_icon() {
        with_runtime_writer(|writer| {
            let mut app = AppState::default();
            app.push_line(LogKind::ToolCall, "Read: crates/tui/src/main.rs");
            app.pending_component_lines.insert(
                tool_component_key(UNKNOWN_RUN_SCOPE, "read-result-1"),
                LogComponentSpan::single(0),
            );

            let parsed = parse_runtime_output(
                &json!({
                    "jsonrpc": "2.0",
                    "method": "agent.event",
                    "params": {
                        "event": {
                            "type": "tool_result",
                            "tool": "read",
                            "tool_call_id": "read-result-1",
                            "is_error": false,
                            "result": "first line\nsecond line"
                        }
                    }
                })
                .to_string(),
            );

            assert!(apply_parsed_output(&mut app, parsed, writer, &mut || {
                "id-1".to_string()
            }));
            assert_eq!(app.log[0].plain_text(), "✔ Read: crates/tui/src/main.rs");
            assert_eq!(app.log.len(), 1);
        });
    }

    #[test]
    fn apply_patch_tool_result_suppresses_duplicate_diff_after_permission_preview() {
        with_runtime_writer(|writer| {
            let mut app = AppState::default();
            app.push_line(LogKind::ToolCall, "ApplyPatch: 1 file(s)");
            app.pending_component_lines.insert(
                tool_component_key(UNKNOWN_RUN_SCOPE, "tool-apply-1"),
                LogComponentSpan::single(0),
            );

            let preview = parse_runtime_output(
                r#"{"method":"agent.event","params":{"event":{"type":"permission.preview","tool":"apply_patch","tool_call_id":"tool-apply-1","diff":"--- a/demo.txt\n+++ b/demo.txt\n@@ -1 +1 @@\n-old line\n+new line"}}}"#,
            );
            assert!(apply_parsed_output(&mut app, preview, writer, &mut || {
                "id-1".to_string()
            }));
            let preview_len = app.log.len();

            let result = parse_runtime_output(
                r#"{"method":"agent.event","params":{"event":{"type":"tool_result","tool":"apply_patch","tool_call_id":"tool-apply-1","result":{"summary":"Applied patch to 1 file(s)","diff":"--- a/demo.txt\n+++ b/demo.txt\n@@ -1 +1 @@\n-old line\n+new line"}}}}"#,
            );
            assert!(apply_parsed_output(&mut app, result, writer, &mut || {
                "id-2".to_string()
            }));

            assert_eq!(app.log.len(), preview_len);
            assert_eq!(app.log[0].plain_text(), "✔ ApplyPatch: 1 file(s)");
            assert_eq!(
                app.log
                    .iter()
                    .filter(|line| line.plain_text().contains("+ new line"))
                    .count(),
                1
            );
        });
    }

    #[test]
    fn permission_ready_replay_with_same_tool_call_id_is_suppressed() {
        with_runtime_writer(|writer| {
            let mut app = AppState::default();
            let first = parse_runtime_output(
                r#"{"method":"agent.event","params":{"event":{"type":"permission.ready","tool":"shell","tool_call_id":"shell-confirm-1"}}}"#,
            );
            assert!(apply_parsed_output(&mut app, first, writer, &mut || {
                "id-1".to_string()
            }));
            let first_len = app.log.len();
            assert!(
                app.log
                    .iter()
                    .any(|line| line.plain_text()
                        == "Review shell changes, then choose Allow or Deny")
            );

            let second = parse_runtime_output(
                r#"{"method":"agent.event","params":{"event":{"type":"permission.ready","tool":"shell","tool_call_id":"shell-confirm-1"}}}"#,
            );
            assert!(apply_parsed_output(&mut app, second, writer, &mut || {
                "id-2".to_string()
            }));

            assert_eq!(app.log.len(), first_len);
            assert_eq!(
                app.log
                    .iter()
                    .filter(|line| line.plain_text()
                        == "Review shell changes, then choose Allow or Deny")
                    .count(),
                1
            );
        });
    }

    #[test]
    fn compaction_start_uses_run_scoped_sequence_key() {
        let mut app = AppState::default();
        app.runtime_info.active_run_id = Some("run-1".to_string());
        let mut incoming = vec![LogLine::new(LogKind::Compaction, "Compaction: running")];
        let mut starts: Vec<PendingComponentStart> = Vec::new();

        apply_compaction_component_events(&mut app, &mut incoming, &mut starts, true, false);

        assert_eq!(incoming.len(), 1);
        assert_eq!(incoming[0].plain_text(), "Compaction: running");
        assert_eq!(starts.len(), 1);
        assert_eq!(starts[0].0, "run:run-1:compaction#1");
        assert_eq!(starts[0].1, LogKind::Compaction);
    }

    #[test]
    fn compaction_complete_replaces_active_component_line() {
        let mut app = AppState::default();
        app.runtime_info.active_run_id = Some("run-1".to_string());
        app.push_line(LogKind::Compaction, "Compaction: running");
        app.pending_component_lines.insert(
            "run:run-1:compaction#1".to_string(),
            LogComponentSpan::single(0),
        );
        app.active_compaction_component_by_scope
            .insert("run-1".to_string(), "run:run-1:compaction#1".to_string());

        let mut incoming = vec![LogLine::new(
            LogKind::Compaction,
            "Compaction: completed (compacted=true)",
        )];
        let mut starts: Vec<PendingComponentStart> = Vec::new();

        apply_compaction_component_events(&mut app, &mut incoming, &mut starts, false, true);

        assert!(incoming.is_empty());
        assert_eq!(app.log.len(), 1);
        assert_eq!(
            app.log[0].plain_text(),
            "Compaction: completed (compacted=true)"
        );
        assert!(!app
            .pending_component_lines
            .contains_key("run:run-1:compaction#1"));
    }

    #[test]
    fn compaction_complete_keeps_line_when_active_component_is_missing() {
        let mut app = AppState::default();
        let mut incoming = vec![LogLine::new(
            LogKind::Compaction,
            "Compaction: skipped (compacted=false)",
        )];
        let mut starts: Vec<PendingComponentStart> = Vec::new();

        apply_compaction_component_events(&mut app, &mut incoming, &mut starts, false, true);

        assert_eq!(incoming.len(), 1);
        assert_eq!(
            incoming[0].plain_text(),
            "Compaction: skipped (compacted=false)"
        );
        assert!(app.log.is_empty());
    }

    #[test]
    fn register_pending_component_lines_stores_tool_component_span() {
        let mut app = AppState::default();
        app.push_line(LogKind::ToolCall, "Bash: pwd");

        register_pending_component_lines(
            &mut app,
            0,
            vec![(tool_component_key("run-1", "tool-1"), LogKind::ToolCall)],
        );

        assert_eq!(
            app.pending_component_lines
                .get("run:run-1:tool:tool-1")
                .copied(),
            Some(LogComponentSpan::single(0))
        );
    }

    #[test]
    fn resolve_tool_component_key_matches_suffix_across_scopes_and_picks_latest_span() {
        let mut app = AppState::default();
        app.pending_component_lines.insert(
            "run:run-a:tool:tool-7".to_string(),
            LogComponentSpan::single(2),
        );
        app.pending_component_lines.insert(
            "run:run-b:tool:tool-7".to_string(),
            LogComponentSpan::single(9),
        );

        let resolved = resolve_tool_component_key(&app, "tool-7");

        assert_eq!(resolved.as_deref(), Some("run:run-b:tool:tool-7"));
    }

    #[test]
    fn compaction_start_twice_increments_sequence_and_tracks_latest_active_key() {
        let mut app = AppState::default();
        app.runtime_info.active_run_id = Some("run-9".to_string());
        let mut first = vec![LogLine::new(LogKind::Compaction, "Compaction: running")];
        let mut second = vec![LogLine::new(LogKind::Compaction, "Compaction: running")];
        let mut starts: Vec<PendingComponentStart> = Vec::new();

        apply_compaction_component_events(&mut app, &mut first, &mut starts, true, false);
        apply_compaction_component_events(&mut app, &mut second, &mut starts, true, false);

        assert_eq!(starts.len(), 2);
        assert_eq!(starts[0].0, "run:run-9:compaction#1");
        assert_eq!(starts[1].0, "run:run-9:compaction#2");
        assert_eq!(
            app.active_compaction_component_by_scope
                .get("run-9")
                .map(String::as_str),
            Some("run:run-9:compaction#2")
        );
    }

    #[test]
    fn clear_component_tracking_for_run_clears_run_scoped_compaction_state() {
        let mut app = AppState::default();
        app.compaction_sequence_by_scope
            .insert("run-1".to_string(), 7);
        app.compaction_sequence_by_scope
            .insert("run-2".to_string(), 3);
        app.active_compaction_component_by_scope
            .insert("run-1".to_string(), "run:run-1:compaction#7".to_string());
        app.active_compaction_component_by_scope
            .insert("run-2".to_string(), "run:run-2:compaction#3".to_string());
        app.pending_component_lines.insert(
            "run:run-1:tool:tool-1".to_string(),
            LogComponentSpan::single(0),
        );
        app.pending_component_lines.insert(
            "run:run-1:compaction#7".to_string(),
            LogComponentSpan::single(1),
        );
        app.pending_component_lines.insert(
            "run:run-2:tool:tool-9".to_string(),
            LogComponentSpan::single(2),
        );

        clear_component_tracking_for_run(&mut app, "run-1");

        assert!(!app.compaction_sequence_by_scope.contains_key("run-1"));
        assert_eq!(
            app.compaction_sequence_by_scope.get("run-2").copied(),
            Some(3)
        );
        assert!(!app
            .active_compaction_component_by_scope
            .contains_key("run-1"));
        assert_eq!(
            app.active_compaction_component_by_scope
                .get("run-2")
                .map(String::as_str),
            Some("run:run-2:compaction#3")
        );
        assert!(!app
            .pending_component_lines
            .contains_key("run:run-1:tool:tool-1"));
        assert!(!app
            .pending_component_lines
            .contains_key("run:run-1:compaction#7"));
        assert!(app
            .pending_component_lines
            .contains_key("run:run-2:tool:tool-9"));
    }

    #[test]
    fn take_active_compaction_key_only_crosses_scope_for_unknown_run_scope() {
        let mut app = AppState::default();
        app.active_compaction_component_by_scope
            .insert("run-a".to_string(), "run:run-a:compaction#2".to_string());

        let non_unknown = take_active_compaction_key(&mut app, "run-b");
        assert!(non_unknown.is_none());
        assert_eq!(
            app.active_compaction_component_by_scope
                .get("run-a")
                .map(String::as_str),
            Some("run:run-a:compaction#2")
        );

        let unknown = take_active_compaction_key(&mut app, UNKNOWN_RUN_SCOPE);
        assert_eq!(unknown.as_deref(), Some("run:run-a:compaction#2"));
        assert!(app.active_compaction_component_by_scope.is_empty());
    }

    #[test]
    fn register_pending_component_lines_tracks_multiple_components_in_order() {
        let mut app = AppState::default();
        app.push_line(LogKind::ToolCall, "Bash: pwd");
        app.push_line(LogKind::Compaction, "Compaction: running");

        register_pending_component_lines(
            &mut app,
            0,
            vec![
                (tool_component_key("run-1", "tool-1"), LogKind::ToolCall),
                ("run:run-1:compaction#1".to_string(), LogKind::Compaction),
            ],
        );

        assert_eq!(
            app.pending_component_lines
                .get("run:run-1:tool:tool-1")
                .copied(),
            Some(LogComponentSpan::single(0))
        );
        assert_eq!(
            app.pending_component_lines
                .get("run:run-1:compaction#1")
                .copied(),
            Some(LogComponentSpan::single(1))
        );
    }

    #[test]
    fn steer_applied_removes_in_flight_steer_and_unconsumed_steers_fallback_ordered() {
        use crate::app::InFlightSteer;

        with_runtime_writer(|writer| {
            let mut app = AppState::default();
            app.update_run_status("running".to_string());
            app.runtime_info.active_run_id = Some("run-1".to_string());

            app.in_flight_steers.push_back(InFlightSteer {
                client_steer_id: "cs-1".to_string(),
                server_steer_id: Some("s1".to_string()),
                run_id: "run-1".to_string(),
                submitted_at: Instant::now(),
                submission: PendingPromptRun {
                    seq: 1,
                    queue_id: String::new(),
                    queued_at: Instant::now(),
                    preview: "applied steer".to_string(),
                    user_text: "applied steer".to_string(),
                    display_text: "applied steer [Image 1]".to_string(),
                    image_descriptions: vec!["  [image 10x20 1KB]".to_string()],
                    input_payload: json!({"type":"text","text":"applied steer"}),
                    attachment_count: 0,
                    files: Default::default(),
                    shell_result_count: 0,
                    dispatch_attempts: 0,
                },
            });
            app.in_flight_steers.push_back(InFlightSteer {
                client_steer_id: "cs-2".to_string(),
                server_steer_id: Some("s2".to_string()),
                run_id: "run-1".to_string(),
                submitted_at: Instant::now(),
                submission: PendingPromptRun {
                    seq: 2,
                    queue_id: String::new(),
                    queued_at: Instant::now(),
                    preview: "unconsumed steer".to_string(),
                    user_text: "unconsumed steer".to_string(),
                    display_text: "unconsumed steer".to_string(),
                    image_descriptions: Vec::new(),
                    input_payload: json!({"type":"text","text":"unconsumed steer"}),
                    attachment_count: 0,
                    files: Default::default(),
                    shell_result_count: 0,
                    dispatch_attempts: 0,
                },
            });
            app.pending_prompt_queue.push_back(PendingPromptRun {
                seq: 3,
                queue_id: "q1".to_string(),
                queued_at: Instant::now(),
                preview: "later queued".to_string(),
                user_text: "later queued".to_string(),
                display_text: "later queued".to_string(),
                image_descriptions: Vec::new(),
                input_payload: json!({"type":"text","text":"later queued"}),
                attachment_count: 0,
                files: Default::default(),
                shell_result_count: 0,
                dispatch_attempts: 0,
            });

            let applied = parse_runtime_output(
                r#"{"method":"agent.event","params":{"run_id":"run-1","event":{"type":"steer_applied","steer_id":"s1","content":"RAW_MODEL_PAYLOAD"}}}"#,
            );
            apply_parsed_output(&mut app, applied, writer, &mut || "id-1".into());
            assert_eq!(app.in_flight_steers.len(), 1);
            let transcript = app
                .log
                .iter()
                .map(LogLine::plain_text)
                .collect::<Vec<_>>()
                .join("\n");
            assert!(transcript.contains("> applied steer [Image 1]"));
            assert!(transcript.contains("[image 10x20 1KB]"));
            assert!(!transcript.contains("RAW_MODEL_PAYLOAD"));
            assert_eq!(
                app.in_flight_steers[0].server_steer_id.as_deref(),
                Some("s2")
            );

            let completed = parse_runtime_output(
                r#"{"method":"run.status","params":{"run_id":"run-1","status":"completed","unconsumed_steer_ids":["s2"]}}"#,
            );
            apply_parsed_output(&mut app, completed, writer, &mut || "id-2".into());

            assert!(app.in_flight_steers.is_empty());
            assert_eq!(app.pending_prompt_queue.len(), 2);
            assert_eq!(app.pending_prompt_queue[0].user_text, "unconsumed steer");
            assert_eq!(app.pending_prompt_queue[1].user_text, "later queued");
        });
    }

    #[test]
    fn shared_steer_cancel_trace_returns_only_pending_submissions_in_order() {
        use crate::app::InFlightSteer;

        let trace = include_str!(concat!(
            env!("CARGO_MANIFEST_DIR"),
            "/../../packages/protocol/tests/fixtures/steer-cancel.jsonl"
        ));
        with_runtime_writer(|writer| {
            let mut events = trace.lines().map(parse_runtime_output);
            let mut app = AppState::default();
            let running = events.next().unwrap();
            assert_eq!(running.status.as_deref(), Some("running"));
            apply_parsed_output(&mut app, running, writer, &mut || "rpc".into());
            let run_id = app.runtime_info.active_run_id.clone().unwrap();

            let submission = |seq, server_id: &str, text: &str| InFlightSteer {
                client_steer_id: format!("c-{seq}"),
                server_steer_id: Some(server_id.into()),
                run_id: run_id.clone(),
                submitted_at: Instant::now(),
                submission: PendingPromptRun {
                    seq,
                    queue_id: String::new(),
                    queued_at: Instant::now(),
                    preview: text.into(),
                    user_text: text.into(),
                    display_text: text.into(),
                    image_descriptions: Vec::new(),
                    input_payload: json!({"type":"text","text":text}),
                    attachment_count: 0,
                    files: Default::default(),
                    shell_result_count: 0,
                    dispatch_attempts: 0,
                },
            };
            app.in_flight_steers
                .push_back(submission(1, "s1", "focus on tests"));
            let applied = events.next().unwrap();
            assert_eq!(applied.applied_steer_id.as_deref(), Some("s1"));
            apply_parsed_output(&mut app, applied, writer, &mut || "rpc".into());
            assert!(app.in_flight_steers.is_empty());
            assert!(app.pending_prompt_queue.is_empty());

            app.in_flight_steers.extend([
                submission(2, "s2", "follow up 1"),
                submission(3, "s3", "follow up 2"),
            ]);
            let cancelled = events.next().unwrap();
            assert_eq!(cancelled.status.as_deref(), Some("cancelled"));
            assert_eq!(cancelled.status_run_id.as_ref(), Some(&run_id));
            assert_eq!(cancelled.unconsumed_steer_ids, ["s2", "s3"]);
            apply_parsed_output(&mut app, cancelled, writer, &mut || "rpc".into());
            assert!(events.next().is_none());
            assert!(app.in_flight_steers.is_empty());
            assert_eq!(
                app.pending_prompt_queue
                    .iter()
                    .map(|item| item.user_text.as_str())
                    .collect::<Vec<_>>(),
                ["follow up 1", "follow up 2"]
            );
        });
    }

    #[test]
    fn steer_applied_and_cancel_fallback_match_server_steer_id_without_client_id_collision() {
        use crate::app::InFlightSteer;

        with_runtime_writer(|writer| {
            let mut app = AppState::default();
            app.update_run_status("running".to_string());
            app.runtime_info.active_run_id = Some("run-1".to_string());

            let client_id_1 = app.allocate_client_steer_id();
            let client_id_2 = app.allocate_client_steer_id();
            assert_eq!(client_id_1, "cs-1");
            assert_eq!(client_id_2, "cs-2");

            // Simulate swapped server IDs (e.g. client cs-1 got s2, client cs-2 got s1),
            // plus verify that even if a test/custom client ID ever looked like "s1",
            // steer_applied only matches server_steer_id.
            app.in_flight_steers.push_back(InFlightSteer {
                client_steer_id: client_id_1,
                server_steer_id: Some("s2".to_string()),
                run_id: "run-1".to_string(),
                submitted_at: Instant::now(),
                submission: PendingPromptRun {
                    seq: 1,
                    queue_id: String::new(),
                    queued_at: Instant::now(),
                    preview: "steer one".to_string(),
                    user_text: "steer one".to_string(),
                    display_text: "steer one".to_string(),
                    image_descriptions: Vec::new(),
                    input_payload: json!({"type":"text","text":"steer one"}),
                    attachment_count: 0,
                    files: Default::default(),
                    shell_result_count: 0,
                    dispatch_attempts: 0,
                },
            });
            app.in_flight_steers.push_back(InFlightSteer {
                client_steer_id: client_id_2,
                server_steer_id: Some("s1".to_string()),
                run_id: "run-1".to_string(),
                submitted_at: Instant::now(),
                submission: PendingPromptRun {
                    seq: 2,
                    queue_id: String::new(),
                    queued_at: Instant::now(),
                    preview: "steer two".to_string(),
                    user_text: "steer two".to_string(),
                    display_text: "steer two".to_string(),
                    image_descriptions: Vec::new(),
                    input_payload: json!({"type":"text","text":"steer two"}),
                    attachment_count: 0,
                    files: Default::default(),
                    shell_result_count: 0,
                    dispatch_attempts: 0,
                },
            });

            // s1 is applied; only the entry with server_steer_id == "s1" ("steer two") is removed.
            let applied = parse_runtime_output(
                r#"{"method":"agent.event","params":{"run_id":"run-1","event":{"type":"steer_applied","steer_id":"s1","content":"steer two"}}}"#,
            );
            apply_parsed_output(&mut app, applied, writer, &mut || "id-1".into());
            assert_eq!(app.in_flight_steers.len(), 1);
            assert_eq!(app.in_flight_steers[0].submission.user_text, "steer one");

            // Run is cancelled with unconsumed s2; only "steer one" falls back to queue.
            let cancelled = parse_runtime_output(
                r#"{"method":"run.status","params":{"run_id":"run-1","status":"cancelled","unconsumed_steer_ids":["s2"]}}"#,
            );
            apply_parsed_output(&mut app, cancelled, writer, &mut || "id-2".into());

            assert!(app.in_flight_steers.is_empty());
            assert_eq!(app.pending_prompt_queue.len(), 1);
            assert_eq!(app.pending_prompt_queue[0].user_text, "steer one");
        });
    }
}
