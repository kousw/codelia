use super::formatters::{push_bang_stream_preview, push_rpc_error};
use crate::app::handlers::theme::apply_theme_from_name;
use crate::app::runtime::RpcResponse;
use crate::app::state::LogKind;
use crate::app::{AppState, PROMPT_DISPATCH_MAX_ATTEMPTS, PROMPT_DISPATCH_RETRY_BACKOFF};
use std::time::Instant;

pub(super) fn handle_shell_exec_response(app: &mut AppState, response: RpcResponse) {
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
        app.runtime_info.active_run_id = None;
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
            app.runtime_info.active_run_id = None;
            requeue_dispatching_prompt(app, "run.start returned no run_id");
            app.push_line(LogKind::Error, "run.start returned no run_id");
            return;
        }
        app.runtime_info.active_run_id = run_id;
        app.pending_shell_results.clear();
        app.dispatching_prompt = None;
        app.next_queue_dispatch_retry_at = None;
        if app.run_status.as_deref() == Some("starting") {
            app.update_run_status("running".to_string());
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
        app.runtime_info.session_id = None;
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

pub(super) fn handle_theme_set_response(app: &mut AppState, response: RpcResponse) {
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
    let _ = apply_theme_from_name(name);
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

pub(super) fn handle_run_cancel_response(app: &mut AppState, response: RpcResponse) {
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
