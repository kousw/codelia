use super::formatters::{push_bang_stream_preview, push_rpc_error};
use crate::app::handlers::theme::apply_theme_from_name;
use crate::app::runtime::{send_shell_wait, RpcResponse, RuntimeTx};
use crate::app::state::LogKind;
use crate::app::{
    AppState, PendingRpc, PendingRpcSlot, PendingShellResult, PROMPT_DISPATCH_MAX_ATTEMPTS,
    PROMPT_DISPATCH_RETRY_BACKOFF,
};
use crate::protocol::{
    methods, rpc_error_code, ShellExecResult, ShellOutputTruncated, ShellTaskInfo, ShellWaitResult,
    ThemeSetResult,
};
use serde_json::Value;
use std::time::Instant;

/// The command result fields shared by `shell.exec` and finished `shell.wait`.
struct ShellOutcome<'a> {
    command_preview: &'a str,
    exit_code: Option<i64>,
    signal: Option<&'a str>,
    duration_ms: Option<f64>,
    stdout: &'a str,
    stderr: &'a str,
    truncated: &'a ShellOutputTruncated,
    stdout_cache_id: Option<&'a str>,
    stderr_cache_id: Option<&'a str>,
}

impl<'a> From<&'a ShellExecResult> for ShellOutcome<'a> {
    fn from(result: &'a ShellExecResult) -> Self {
        Self {
            command_preview: &result.command_preview,
            exit_code: result.exit_code,
            signal: result.signal.as_deref(),
            duration_ms: Some(result.duration_ms),
            stdout: &result.stdout,
            stderr: &result.stderr,
            truncated: &result.truncated,
            stdout_cache_id: result.stdout_cache_id.as_deref(),
            stderr_cache_id: result.stderr_cache_id.as_deref(),
        }
    }
}

impl<'a> From<&'a ShellTaskInfo> for ShellOutcome<'a> {
    fn from(task: &'a ShellTaskInfo) -> Self {
        Self {
            command_preview: task.command_preview.as_deref().unwrap_or(""),
            exit_code: task.exit_code,
            signal: task.signal.as_deref(),
            duration_ms: task.duration_ms,
            stdout: &task.stdout,
            stderr: &task.stderr,
            truncated: &task.truncated,
            stdout_cache_id: task.stdout_cache_id.as_deref(),
            stderr_cache_id: task.stderr_cache_id.as_deref(),
        }
    }
}

fn queue_pending_shell_result(app: &mut AppState, outcome: ShellOutcome<'_>) {
    let truncated_stdout = outcome.truncated.stdout;
    let truncated_stderr = outcome.truncated.stderr;
    let truncated_combined = outcome.truncated.combined;
    let stdout = Some(outcome.stdout.to_string());
    let stderr = Some(outcome.stderr.to_string());
    let duration_ms = outcome
        .duration_ms
        .filter(|value| *value >= 0.0)
        .map_or(0, |value| value as u64);

    let shell_result = PendingShellResult {
        id: format!("shell_{}", app.pending_shell_results.len() + 1),
        command_preview: outcome.command_preview.to_string(),
        exit_code: outcome.exit_code,
        signal: outcome.signal.map(str::to_owned),
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
        stdout_cache_id: outcome.stdout_cache_id.map(str::to_owned),
        stderr_cache_id: outcome.stderr_cache_id.map(str::to_owned),
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

pub(super) fn handle_shell_exec_response(app: &mut AppState, response: RpcResponse) {
    if let Some(error) = response.error {
        app.push_line(LogKind::Error, format!("shell.exec error: {error}"));
        return;
    }
    let Some(result) = response.result else {
        app.push_line(LogKind::Error, "shell.exec returned no result");
        return;
    };
    match crate::protocol::decode_result::<methods::ShellExec>(result) {
        Ok(result) => queue_pending_shell_result(app, ShellOutcome::from(&result)),
        Err(error) => super::push_protocol_mismatch(app, &error),
    }
}

pub(super) fn handle_shell_start_response(
    app: &mut AppState,
    response: RpcResponse,
    tx: &mut dyn RuntimeTx,
) {
    if let Some(error) = response.error {
        app.active_shell_wait_task_id = None;
        app.push_line(LogKind::Error, format!("shell.start error: {error}"));
        return;
    }
    let Some(result) = response.result else {
        app.active_shell_wait_task_id = None;
        app.push_line(LogKind::Error, "shell.start returned no result");
        return;
    };
    let task = match crate::protocol::decode_result::<methods::ShellStart>(result) {
        Ok(task) => task,
        Err(error) => {
            app.active_shell_wait_task_id = None;
            super::push_protocol_mismatch(app, &error);
            return;
        }
    };
    let task_id = task.task_id.as_str();
    let id = tx.next_id();
    app.rpc_pending.insert(id.clone(), PendingRpc::ShellWait);
    app.active_shell_wait_task_id = Some(task_id.to_string());
    if let Err(error) = send_shell_wait(tx, &id, task_id) {
        app.rpc_pending.remove_slot(PendingRpcSlot::ShellWait);
        app.active_shell_wait_task_id = None;
        app.push_error_report("send error", error.to_string());
    }
}

pub(super) fn handle_shell_wait_response(app: &mut AppState, response: RpcResponse) {
    app.active_shell_wait_task_id = None;
    if let Some(error) = response.error {
        app.push_line(LogKind::Error, format!("shell.wait error: {error}"));
        return;
    }
    let Some(result) = response.result else {
        app.push_line(LogKind::Error, "shell.wait returned no result");
        return;
    };
    let task = match crate::protocol::decode_result::<methods::ShellWait>(result) {
        Ok(ShellWaitResult::TaskInfo(task)) => task,
        Ok(ShellWaitResult::DetachResult(detached)) => {
            app.push_line(
                LogKind::Status,
                format!(
                    "Detached shell task {} (running in background)",
                    detached.task_id
                ),
            );
            return;
        }
        Err(error) => {
            super::push_protocol_mismatch(app, &error);
            return;
        }
    };
    if task.still_running.unwrap_or(false) {
        app.push_line(
            LogKind::Status,
            format!(
                "Shell task {} is still running after the wait window",
                task.task_id
            ),
        );
        return;
    }
    queue_pending_shell_result(app, ShellOutcome::from(&task));
}

pub(super) fn handle_shell_detach_response(app: &mut AppState, response: RpcResponse) {
    if let Some(error) = response.error {
        app.push_line(LogKind::Error, format!("shell.detach error: {error}"));
    }
}

fn requeue_dispatching_prompt(app: &mut AppState, reason: &str, retry_safe: bool) {
    if let Some(mut dispatching) = app.dispatching_prompt.take() {
        dispatching.dispatch_attempts = if retry_safe {
            dispatching.dispatch_attempts.saturating_add(1)
        } else {
            PROMPT_DISPATCH_MAX_ATTEMPTS
        };
        if dispatching.dispatch_attempts >= PROMPT_DISPATCH_MAX_ATTEMPTS {
            let queue_id = dispatching.queue_id.clone();
            app.pending_prompt_queue.push_front(dispatching);
            let message = if retry_safe {
                format!("Paused queued prompt {queue_id} after {PROMPT_DISPATCH_MAX_ATTEMPTS} failed dispatch attempts ({reason}). Use /queue retry or /queue cancel.")
            } else {
                format!("Paused queued prompt {queue_id}: {reason}. Check whether the run started before /queue retry, or use /queue cancel.")
            };
            app.push_line(LogKind::Error, message);
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
        app.runtime_info.active_run_id = None;
        let reason = error
            .get("message")
            .and_then(|value| value.as_str())
            .unwrap_or("run.start rpc error");
        let retry_safe =
            error.get("code").and_then(Value::as_i64) == Some(rpc_error_code::RUNTIME_BUSY);
        requeue_dispatching_prompt(app, reason, retry_safe);
        push_rpc_error(app, "run.start", &error);
        return;
    }
    if let Some(result) = response.result {
        let result = match crate::protocol::decode_result::<methods::RunStart>(result) {
            Ok(result) => result,
            Err(error) => {
                app.update_run_status("error".to_string());
                app.runtime_info.active_run_id = None;
                requeue_dispatching_prompt(app, "run.start returned an unexpected result", false);
                super::push_protocol_mismatch(app, &error);
                return;
            }
        };
        app.runtime_info.active_run_id = Some(result.run_id);
        app.dispatching_prompt = None;
        app.next_queue_dispatch_retry_at = None;
        if app.run_status.as_deref() == Some("starting") {
            app.update_run_status("running".to_string());
        }
    } else {
        app.update_run_status("error".to_string());
        app.runtime_info.active_run_id = None;
        requeue_dispatching_prompt(app, "run.start returned no result", false);
        app.push_line(LogKind::Error, "run.start returned no result");
    }
}

fn decode_steer_acknowledgement(
    value: Value,
    client_steer_id: &str,
) -> (
    Result<crate::protocol::RunSteerResult, crate::protocol::DecodeError>,
    Option<String>,
) {
    let mismatched_client_id = value
        .get("client_steer_id")
        .and_then(Value::as_str)
        .is_some_and(|id| id != client_steer_id);
    let unverified_id = value
        .get("steer_id")
        .and_then(Value::as_str)
        .filter(|id| !id.is_empty() && !mismatched_client_id)
        .map(str::to_owned);
    let decoded = crate::protocol::decode_result::<methods::RunSteer>(value).and_then(|result| {
        if mismatched_client_id {
            return Err(crate::protocol::DecodeError {
                method: "run.steer".into(),
                source: <serde_json::Error as serde::de::Error>::custom(
                    "mismatched client_steer_id",
                ),
            });
        }
        Ok(result)
    });
    (decoded, unverified_id)
}

pub(crate) fn handle_run_steer_response(
    app: &mut AppState,
    client_steer_id: String,
    response: RpcResponse,
) {
    let Some(pos) = app
        .in_flight_steers
        .iter()
        .position(|steer| steer.client_steer_id == client_steer_id)
    else {
        return;
    };

    if let Some(error) = response.error {
        let mut steer = app.in_flight_steers.remove(pos).expect("checked index");
        let code = error.get("code").and_then(Value::as_i64);
        if steer.submission.queue_id.is_empty() {
            steer.submission.queue_id = app.allocate_prompt_queue_id();
        }
        let queue_id = steer.submission.queue_id.clone();
        if code == Some(rpc_error_code::RUN_NOT_FOUND) {
            crate::app::handlers::command::insert_pending_prompt_ordered(
                &mut app.pending_prompt_queue,
                steer.submission,
            );
            app.push_line(
                LogKind::Status,
                format!(
                    "Run already ended before steer {} arrived; moved to queue ({queue_id}, queue={})",
                    steer.client_steer_id,
                    app.pending_prompt_queue.len()
                ),
            );
            return;
        }

        steer.submission.dispatch_attempts = PROMPT_DISPATCH_MAX_ATTEMPTS;
        app.pending_prompt_queue.push_front(steer.submission);
        push_rpc_error(app, "run.steer", &error);
        app.push_line(
            LogKind::Error,
            format!(
                "Paused fallback steer {queue_id}: run.steer failed. Use /queue retry or /queue cancel."
            ),
        );
        return;
    }

    let result = response.result.unwrap_or(Value::Null);
    // A result that breaks the contract (including `ok: false`) is not
    // reported as queued, but the runtime may still have accepted it.
    // Keep any steer id so `steer_applied` can still match, and pause the
    // submission so a fallback at run end never resends it automatically.
    let (result, raw_steer_id) = decode_steer_acknowledgement(result, &client_steer_id);
    match result {
        Ok(result) => {
            if let Some(steer) = app.in_flight_steers.get_mut(pos) {
                steer.server_steer_id = Some(result.steer_id.clone());
            }
            app.push_line(
                LogKind::Status,
                format!("Steer {} queued for next step", result.steer_id),
            );
        }
        Err(error) => {
            super::push_protocol_mismatch(app, &error);
            if let Some(steer) = app.in_flight_steers.get_mut(pos) {
                steer.unverified_steer_id = raw_steer_id;
                steer.submission.dispatch_attempts = PROMPT_DISPATCH_MAX_ATTEMPTS;
            }
            app.push_line(
                LogKind::Error,
                format!(
                    "Steer {client_steer_id}: run.steer returned an unexpected result; it may already be applied, so it will not be resent automatically."
                ),
            );
        }
    }
}

pub(super) fn handle_logout_response(app: &mut AppState, response: RpcResponse) {
    if let Some(error) = response.error {
        push_rpc_error(app, "auth.logout", &error);
        return;
    }
    let Some(result) = response.result else {
        app.push_line(LogKind::Error, "auth.logout returned no result");
        return;
    };
    let result = match crate::protocol::decode_result::<methods::AuthLogout>(result) {
        Ok(result) => result,
        Err(error) => {
            super::push_protocol_mismatch(app, &error);
            return;
        }
    };

    let session_cleared = result.session_cleared;
    if result.cancelled.unwrap_or(false) {
        app.push_line(LogKind::Status, "Logout cancelled.");
        app.push_line(LogKind::Space, "");
        return;
    }
    if !result.ok {
        app.push_line(LogKind::Error, "auth.logout failed");
        return;
    }
    if session_cleared {
        app.discard_composer_attachments();
        app.runtime_info.attachment_session_epoch += 1;
        app.runtime_info.session_id = None;
    }

    let message = match result.provider.as_deref() {
        Some(provider) => format!("Logged out of {provider}. Other providers kept."),
        None => "Logged out. Local auth credentials cleared.".to_string(),
    };
    app.push_line(LogKind::Status, message);
    if session_cleared {
        app.push_line(LogKind::Status, "Session reset.");
    }
    app.push_line(LogKind::Space, "");
}

pub(super) fn handle_theme_set_response(app: &mut AppState, response: RpcResponse) {
    if let Some(error) = response.error {
        push_rpc_error(app, "theme.set", &error);
        return;
    }
    let result = match response
        .result
        .map(crate::protocol::decode_result::<methods::ThemeSet>)
    {
        Some(Ok(result)) => result,
        Some(Err(error)) => {
            super::push_protocol_mismatch(app, &error);
            return;
        }
        None => ThemeSetResult {
            name: "(unknown)".to_owned(),
            scope: None,
            path: None,
        },
    };
    let name = result.name.as_str();
    let _ = apply_theme_from_name(name);
    // Older runtimes omit scope and path; unknown scopes are shown as sent.
    let scope = result
        .scope
        .as_ref()
        .map(|scope| scope.as_str())
        .unwrap_or("unknown");
    let path = result.path.as_deref().unwrap_or("(unknown path)");
    app.push_line(
        LogKind::Status,
        format!("Saved theme '{name}' to [{scope}] {path} (applied)"),
    );
}

pub(super) fn handle_run_cancel_response(app: &mut AppState, response: RpcResponse) {
    if let Some(error) = response.error {
        push_rpc_error(app, "run.cancel", &error);
        return;
    }
    let Some(result) = response.result else {
        return;
    };
    match crate::protocol::decode_result::<methods::RunCancel>(result) {
        Ok(_) if app.enable_debug_print => app.push_line(LogKind::Rpc, "run.cancel result: ok"),
        Ok(_) => {}
        Err(error) => super::push_protocol_mismatch(app, &error),
    }
}

#[cfg(test)]
mod tests {
    /// A protocol-complete shell task with the given overrides.
    fn shell_task(fields: serde_json::Value) -> serde_json::Value {
        let mut task = serde_json::json!({
            "task_id": "task-1",
            "state": "running",
            "created_at": "2026-11-22T00:00:00.000Z",
            "updated_at": "2026-11-22T00:00:00.000Z",
            "exit_code": null,
            "stdout": "",
            "stderr": "",
            "truncated": {"stdout": false, "stderr": false, "combined": false},
            "duration_ms": null
        });
        for (key, value) in fields.as_object().expect("fields") {
            task[key] = value.clone();
        }
        task
    }

    #[test]
    fn named_logout_response_keeps_other_provider_session_and_reports_the_name() {
        let mut app = AppState::default();
        app.runtime_info.session_id = Some("kept".to_string());
        handle_logout_response(
            &mut app,
            RpcResponse {
                id: "logout-home".to_string(),
                result: Some(
                    json!({"ok":true,"provider":"home","auth_cleared":true,"session_cleared":false}),
                ),
                error: None,
            },
        );
        assert_eq!(app.runtime_info.session_id.as_deref(), Some("kept"));
        assert!(app
            .log
            .iter()
            .any(|line| line.plain_text().contains("Logged out of home")));
    }
    use super::{
        handle_logout_response, handle_shell_start_response, handle_shell_wait_response,
        PendingRpcSlot,
    };
    use crate::app::runtime::{MockRuntimeTx, RpcResponse};
    use crate::app::AppState;
    use serde_json::json;

    #[test]
    fn shell_start_response_schedules_shell_wait_and_marks_active_task() {
        let mut tx = MockRuntimeTx::with_id_prefix("id-");
        let mut app = AppState::default();

        handle_shell_start_response(
            &mut app,
            RpcResponse {
                id: "shell-start-1".to_string(),
                result: Some(shell_task(json!({
                    "task_id": "task-123",
                    "command_preview": "echo hi"
                }))),
                error: None,
            },
            &mut tx,
        );

        assert_eq!(app.active_shell_wait_task_id.as_deref(), Some("task-123"));
        assert_eq!(
            app.rpc_pending.slot_id(PendingRpcSlot::ShellWait),
            Some("id-1")
        );
    }

    #[test]
    fn shell_wait_response_for_detach_clears_active_task_and_logs_background_status() {
        let mut app = AppState::default();
        app.active_shell_wait_task_id = Some("task-123".to_string());

        handle_shell_wait_response(
            &mut app,
            RpcResponse {
                id: "shell-wait-1".to_string(),
                result: Some(json!({
                    "task_id": "task-123",
                    "detached": true,
                    "state": "running"
                })),
                error: None,
            },
        );

        assert!(app.active_shell_wait_task_id.is_none());
        assert!(app
            .log
            .iter()
            .any(|line| line.plain_text().contains("Detached shell task task-123")));
    }

    #[test]
    fn shell_wait_response_for_still_running_clears_active_task_without_queueing_result() {
        let mut app = AppState::default();
        app.active_shell_wait_task_id = Some("task-456".to_string());

        handle_shell_wait_response(
            &mut app,
            RpcResponse {
                id: "shell-wait-2".to_string(),
                result: Some(shell_task(json!({
                    "task_id": "task-456",
                    "state": "running",
                    "still_running": true
                }))),
                error: None,
            },
        );

        assert!(app.active_shell_wait_task_id.is_none());
        assert!(app.pending_shell_results.is_empty());
        assert!(app.log.iter().any(|line| line
            .plain_text()
            .contains("still running after the wait window")));
    }

    #[test]
    fn run_steer_not_found_falls_back_ordered_into_queue() {
        use super::handle_run_steer_response;
        use crate::app::{InFlightSteer, PendingPromptRun};

        let mut app = AppState::default();
        app.pending_prompt_queue.push_back(PendingPromptRun {
            seq: 20,
            queue_id: "q2".to_string(),
            queued_at: std::time::Instant::now(),
            preview: "later".to_string(),
            user_text: "later".to_string(),
            display_text: "later".to_string(),
            image_descriptions: Vec::new(),
            input_payload: json!({"type":"text","text":"later"}),
            attachment_count: 0,
            files: Default::default(),
            shell_result_count: 0,
            dispatch_attempts: 0,
        });
        app.in_flight_steers.push_back(InFlightSteer {
            client_steer_id: "cs-1".to_string(),
            server_steer_id: None,
            unverified_steer_id: None,
            run_id: "run-1".to_string(),
            submitted_at: std::time::Instant::now(),
            submission: PendingPromptRun {
                seq: 10,
                queue_id: String::new(),
                queued_at: std::time::Instant::now(),
                preview: "earlier steer".to_string(),
                user_text: "earlier steer".to_string(),
                display_text: "earlier steer".to_string(),
                image_descriptions: Vec::new(),
                input_payload: json!({"type":"text","text":"earlier steer"}),
                attachment_count: 0,
                files: Default::default(),
                shell_result_count: 0,
                dispatch_attempts: 0,
            },
        });

        handle_run_steer_response(
            &mut app,
            "cs-1".to_string(),
            RpcResponse {
                id: "rpc-1".to_string(),
                result: None,
                error: Some(json!({"code": -32002, "message": "active run not found"})),
            },
        );

        assert!(app.in_flight_steers.is_empty());
        assert_eq!(app.pending_prompt_queue.len(), 2);
        assert_eq!(app.pending_prompt_queue[0].user_text, "earlier steer");
        assert_eq!(app.pending_prompt_queue[0].dispatch_attempts, 0);
        assert_eq!(app.pending_prompt_queue[1].user_text, "later");
    }

    #[test]
    fn run_steer_other_error_pauses_fallback_at_queue_front() {
        use super::handle_run_steer_response;
        use crate::app::{InFlightSteer, PendingPromptRun, PROMPT_DISPATCH_MAX_ATTEMPTS};

        let mut app = AppState::default();
        app.in_flight_steers.push_back(InFlightSteer {
            client_steer_id: "cs-2".to_string(),
            server_steer_id: None,
            unverified_steer_id: None,
            run_id: "run-1".to_string(),
            submitted_at: std::time::Instant::now(),
            submission: PendingPromptRun {
                seq: 10,
                queue_id: String::new(),
                queued_at: std::time::Instant::now(),
                preview: "steer".to_string(),
                user_text: "steer".to_string(),
                display_text: "steer".to_string(),
                image_descriptions: Vec::new(),
                input_payload: json!({"type":"text","text":"steer"}),
                attachment_count: 0,
                files: Default::default(),
                shell_result_count: 0,
                dispatch_attempts: 0,
            },
        });

        handle_run_steer_response(
            &mut app,
            "cs-2".to_string(),
            RpcResponse {
                id: "rpc-2".to_string(),
                result: None,
                error: Some(json!({"code": -32602, "message": "invalid"})),
            },
        );

        assert!(app.in_flight_steers.is_empty());
        assert_eq!(app.pending_prompt_queue.len(), 1);
        assert_eq!(
            app.pending_prompt_queue[0].dispatch_attempts,
            PROMPT_DISPATCH_MAX_ATTEMPTS
        );
    }

    #[test]
    fn run_steer_result_that_is_not_ok_is_not_reported_as_queued() {
        use super::handle_run_steer_response;
        use crate::app::{InFlightSteer, PendingPromptRun};

        let mut app = AppState::default();
        app.in_flight_steers.push_back(InFlightSteer {
            client_steer_id: "cs-3".to_string(),
            server_steer_id: None,
            unverified_steer_id: None,
            run_id: "run-1".to_string(),
            submitted_at: std::time::Instant::now(),
            submission: PendingPromptRun {
                seq: 10,
                queue_id: String::new(),
                queued_at: std::time::Instant::now(),
                preview: "steer".to_string(),
                user_text: "steer".to_string(),
                display_text: "steer".to_string(),
                image_descriptions: Vec::new(),
                input_payload: json!({"type":"text","text":"steer"}),
                attachment_count: 0,
                files: Default::default(),
                shell_result_count: 0,
                dispatch_attempts: 0,
            },
        });

        handle_run_steer_response(
            &mut app,
            "cs-3".to_string(),
            RpcResponse {
                id: "rpc-3".to_string(),
                result: Some(json!({"ok": false, "steer_id": "steer-3"})),
                error: None,
            },
        );

        let text: Vec<String> = app.log.iter().map(|line| line.plain_text()).collect();
        assert!(!text
            .iter()
            .any(|line| line.contains("queued for next step")));
        assert!(text
            .iter()
            .any(|line| line.contains("protocol mismatch in run.steer")));
        assert_eq!(app.in_flight_steers.len(), 1);
        // The id is kept apart from confirmed ids so a later steer_applied
        // can still match it when no confirmed id does.
        assert_eq!(app.in_flight_steers[0].server_steer_id, None);
        assert_eq!(
            app.in_flight_steers[0].unverified_steer_id.as_deref(),
            Some("steer-3")
        );

        // If the run ends without steer_applied, the steer is not resent
        // automatically: it may already have been applied.
        super::super::steer::fallback_unconsumed_steers(&mut app, Some("run-1"), &[], None);
        assert!(app.in_flight_steers.is_empty());
        assert_eq!(app.pending_prompt_queue.len(), 1);
        assert_eq!(
            app.pending_prompt_queue[0].dispatch_attempts,
            crate::app::PROMPT_DISPATCH_MAX_ATTEMPTS
        );
    }
}
