use crate::app::runtime::{send_shell_exec, send_shell_start};
use crate::app::state::LogKind;
use crate::app::{AppState, PendingShellResult};
use serde_json::json;

use super::RuntimeStdin;

pub(super) fn build_shell_result_prefix(results: &[PendingShellResult]) -> Option<String> {
    if results.is_empty() {
        return None;
    }
    let mut blocks = Vec::with_capacity(results.len());
    for result in results {
        let payload = json!({
            "id": result.id,
            "command_preview": result.command_preview,
            "exit_code": result.exit_code,
            "signal": result.signal,
            "duration_ms": result.duration_ms,
            "stdout": result.stdout,
            "stderr": result.stderr,
            "stdout_excerpt": result.stdout_excerpt,
            "stderr_excerpt": result.stderr_excerpt,
            "stdout_cache_id": result.stdout_cache_id,
            "stderr_cache_id": result.stderr_cache_id,
            "truncated": {
                "stdout": result.truncated_stdout,
                "stderr": result.truncated_stderr,
                "combined": result.truncated_combined,
            },
        });
        let json_text = payload
            .to_string()
            .replace('<', "\\u003c")
            .replace('>', "\\u003e");
        blocks.push(format!("<shell_result>\n{}\n</shell_result>", json_text));
    }
    Some(blocks.join("\n"))
}

pub(super) fn resolve_bang_command(raw_input: &str, bang_mode: bool) -> String {
    let trimmed = raw_input.trim();
    if bang_mode {
        return trimmed.to_string();
    }
    if let Some(rest) = trimmed.strip_prefix('!') {
        return rest.trim().to_string();
    }
    trimmed.to_string()
}

pub(super) fn handle_bang_command(
    app: &mut AppState,
    child_stdin: &mut RuntimeStdin,
    next_id: &mut impl FnMut() -> String,
    raw_input: &str,
) -> bool {
    if !app.runtime_info.supports_shell_exec {
        app.push_line(LogKind::Status, "Bang shell mode unavailable");
        return false;
    }
    if app.runtime_info.supports_shell_tasks {
        if app.rpc_pending.shell_start_id.is_some()
            || app.rpc_pending.shell_wait_id.is_some()
            || app.rpc_pending.shell_detach_id.is_some()
            || app.active_shell_wait_task_id.is_some()
        {
            app.push_line(
                LogKind::Status,
                "Bang command is still running; wait for completion or press Ctrl+B to detach.",
            );
            return false;
        }
    } else if app.rpc_pending.shell_exec_id.is_some() {
        app.push_line(
            LogKind::Status,
            "Bang command is still running; wait for completion.",
        );
        return false;
    }
    let command = resolve_bang_command(raw_input, app.bang_input_mode);
    if command.is_empty() {
        app.push_line(LogKind::Error, "bang command is empty");
        return false;
    }
    let id = next_id();
    app.push_line(LogKind::Status, format!("bang exec started: {}", command));
    if app.runtime_info.supports_shell_tasks {
        app.rpc_pending.shell_start_id = Some(id.clone());
        if let Err(error) = send_shell_start(child_stdin, &id, &command, None) {
            app.rpc_pending.shell_start_id = None;
            app.push_line(LogKind::Error, format!("send error: {error}"));
            return false;
        }
        return true;
    }
    app.rpc_pending.shell_exec_id = Some(id.clone());
    if let Err(error) = send_shell_exec(child_stdin, &id, &command, None) {
        app.rpc_pending.shell_exec_id = None;
        app.push_line(LogKind::Error, format!("send error: {error}"));
        return false;
    }
    true
}
