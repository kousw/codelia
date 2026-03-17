use super::formatters::{
    add_kind_spacing, format_duration, last_summary_kind, tool_call_summary_with_status_icon,
    tool_call_with_status_icon,
};
use super::panel_builders::build_onboarding_model_list_panel;
use crate::app::handlers::confirm::handle_confirm_request;
use crate::app::runtime::{
    ParsedOutput, PermissionReadyUpdate, ToolCallResultUpdate, UiPickRequest, UiPromptRequest,
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

fn tool_result_prefers_fallback_summary_replacement(tool: &str) -> bool {
    matches!(
        tool,
        "shell" | "shell_status" | "shell_logs" | "shell_wait" | "shell_result" | "shell_cancel"
    )
}

pub(super) fn apply_parsed_output(
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
        compaction_started,
        compaction_completed,
        permission_preview_update,
        permission_ready_update,
    } = parsed;

    if let Some(status) = status {
        let terminal = matches!(status.as_str(), "completed" | "error" | "cancelled");
        if terminal {
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
            if let Some(run_scope) = finished_run_scope {
                clear_component_tracking_for_run(app, &run_scope);
            }
        } else if let Some(run_id) = status_run_id {
            app.runtime_info.active_run_id = Some(run_id);
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
        fallback_summary,
        edit_diff_fingerprint,
    }) = tool_call_result
    {
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
                    let updated = if tool_result_prefers_fallback_summary_replacement(&tool) {
                        tool_call_summary_with_status_icon(&fallback_summary.plain_text(), is_error)
                    } else {
                        tool_call_with_status_icon(&existing, is_error)
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
    register_pending_component_lines(app, appended_from, pending_component_starts);

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

#[cfg(test)]
mod tests {
    use super::{
        apply_compaction_component_events, apply_parsed_output, clear_component_tracking_for_run,
        register_pending_component_lines, resolve_tool_component_key, take_active_compaction_key,
        tool_component_key, PendingComponentStart, UNKNOWN_RUN_SCOPE,
    };
    use crate::app::handlers::runtime_response::RuntimeStdin;
    use crate::app::runtime::parse_runtime_output;
    use crate::app::state::{LogKind, LogLine};
    use crate::app::{AppState, LogComponentSpan, PendingPromptRun};
    use serde_json::json;
    use std::io::{BufWriter, Write};
    use std::process::Stdio;
    use std::time::Instant;

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
    fn terminal_run_status_adds_dispatch_cooldown() {
        with_runtime_writer(|writer| {
            let mut app = AppState::default();
            app.pending_prompt_queue.push_back(PendingPromptRun {
                queue_id: "q1".to_string(),
                queued_at: Instant::now(),
                preview: "queued".to_string(),
                user_text: "queued".to_string(),
                input_payload: json!({"type": "text", "text": "queued"}),
                attachment_count: 0,
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
                                "output": " M crates/tui/src/app/runtime/parser.rs"
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
}
