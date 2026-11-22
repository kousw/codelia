use super::formatters::push_rpc_error;
use super::panel_builders::build_session_list_panel;
use super::RuntimeStdin;
use crate::app::runtime::{send_model_list, RpcResponse};
use crate::app::state::LogKind;
use crate::app::{AppState, ModelListMode};
use crate::protocol::{decode_result, methods, rpc_error_code, SessionListResult};
use serde_json::Value;

pub(super) fn handle_session_list_response(app: &mut AppState, response: RpcResponse) {
    if let Some(error) = response.error {
        push_rpc_error(app, "session.list", &error);
        return;
    }
    if let Some(result) = response.result {
        match decode_result::<methods::SessionList>(result) {
            Ok(result) => apply_session_list_result(app, &result),
            Err(error) => super::push_protocol_mismatch(app, &error),
        }
    }
}

pub(super) fn handle_session_open_response(
    app: &mut AppState,
    response: RpcResponse,
    child_stdin: &mut RuntimeStdin,
    next_id: &mut impl FnMut() -> String,
) {
    if let Some(error) = response.error {
        // Older runtimes bind on the first run.start instead; nothing to report.
        if error.get("code").and_then(Value::as_i64) != Some(rpc_error_code::METHOD_NOT_FOUND) {
            push_rpc_error(app, "session.open", &error);
        }
        return;
    }
    if let Some(result) = response.result {
        if let Err(error) = decode_result::<methods::SessionOpen>(result) {
            super::push_protocol_mismatch(app, &error);
            return;
        }
    }
    // The opened session may carry its own model; refresh the status line,
    // unless the user already has a model list or picker on the way.
    if app.rpc_pending.model_list_id.is_some()
        && app.rpc_pending.model_list_mode != Some(ModelListMode::Silent)
    {
        return;
    }
    let id = next_id();
    app.rpc_pending.model_list_id = Some(id.clone());
    app.rpc_pending.model_list_mode = Some(ModelListMode::Silent);
    if let Err(error) = send_model_list(child_stdin, &id, None, false) {
        app.rpc_pending.model_list_id = None;
        app.rpc_pending.model_list_mode = None;
        app.push_error_report("send error", error.to_string());
    }
}

pub(super) fn handle_session_update_response(app: &mut AppState, response: RpcResponse) {
    if let Some(error) = response.error {
        push_rpc_error(app, "session.update", &error);
        return;
    }
    let Some(result) = response.result else {
        return;
    };
    let session = match decode_result::<methods::SessionUpdate>(result) {
        Ok(result) => result.session,
        Err(error) => {
            super::push_protocol_mismatch(app, &error);
            return;
        }
    };
    {
        let pinned = session.pinned.unwrap_or(false);
        let archived = session.archived_at.is_some();
        let id = session.session_id.as_str();
        app.push_line(
            LogKind::Status,
            format!(
                "Session {id}: {} / {}. Resume data retained.",
                if pinned { "pinned" } else { "unpinned" },
                if archived { "archived" } else { "active" }
            ),
        );
        if archived && !pinned {
            app.push_line(
                LogKind::Status,
                "Unpinned run history is eligible for diagnostic removal and compression; original messages and active writers are protected.",
            );
        }
        app.session_list_panel = None;
    }
}

pub(super) fn handle_session_history_response(app: &mut AppState, response: RpcResponse) {
    app.pending_history_progress.clear();
    app.progress_component_lines
        .retain(|key, _| !key.starts_with("history:"));
    if let Some(error) = response.error {
        push_rpc_error(app, "session.history", &error);
        return;
    }
    if let Some(result) = response.result {
        let result = match decode_result::<methods::SessionHistory>(result) {
            Ok(result) => result,
            Err(error) => {
                super::push_protocol_mismatch(app, &error);
                return;
            }
        };
        let runs = result.runs;
        let events = result.events_sent;
        let suffix = if result.truncated.unwrap_or(false) {
            " (truncated)"
        } else {
            ""
        };
        app.push_line(
            LogKind::Status,
            format!("History restored: {events} events from {runs} runs{suffix}"),
        );
        if let Some(resume_diff) = result.resume_diff.as_deref() {
            for line in resume_diff.lines() {
                app.push_line(LogKind::Status, line.to_string());
            }
        }
        app.push_line(LogKind::Space, "");
    }
}

fn apply_session_list_result(app: &mut AppState, result: &SessionListResult) {
    let show_all = app.rpc_pending.session_list_show_all;
    let current_workspace_root = result.current_workspace_root.clone();
    let sessions = &result.sessions;
    if sessions.is_empty() {
        let message = if show_all {
            "No saved sessions found."
        } else {
            match current_workspace_root.as_deref() {
                Some(workspace_root) => {
                    app.push_line(
                        LogKind::Status,
                        format!(
                            "No saved sessions found in the current workspace: {workspace_root}"
                        ),
                    );
                    "Press A to show all sessions."
                }
                None => "No saved sessions found in the current workspace. Press A to show all sessions.",
            }
        };
        app.push_line(LogKind::Status, message);
        app.push_line(LogKind::Space, "");
    }
    app.session_list_panel = Some(build_session_list_panel(
        sessions,
        show_all,
        current_workspace_root.as_deref(),
    ));
}

#[cfg(all(test, unix))]
mod tests {
    use super::handle_session_open_response;
    use crate::app::runtime::RpcResponse;
    use crate::app::{AppState, ModelListMode};
    use serde_json::json;
    use std::io::{BufWriter, Read};
    use std::process::Stdio;

    fn run_open_response(app: &mut AppState, response: RpcResponse) -> String {
        let mut child = std::process::Command::new("cat")
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .spawn()
            .expect("capture runtime writes");
        let mut writer = BufWriter::new(child.stdin.take().expect("stdin"));
        let mut next = 0_u64;
        handle_session_open_response(app, response, &mut writer, &mut || {
            next += 1;
            format!("id-{next}")
        });
        drop(writer);
        let mut output = String::new();
        child
            .stdout
            .take()
            .unwrap()
            .read_to_string(&mut output)
            .unwrap();
        child.wait().unwrap();
        output
    }

    fn response(
        result: Option<serde_json::Value>,
        error: Option<serde_json::Value>,
    ) -> RpcResponse {
        RpcResponse {
            id: "open".to_string(),
            result,
            error,
        }
    }

    #[test]
    fn session_open_success_refreshes_the_model_silently() {
        let mut app = AppState::default();
        let output = run_open_response(&mut app, response(Some(json!({"session_id": "s1"})), None));
        assert!(output.contains("\"method\":\"model.list\""), "{output}");
        assert_eq!(app.rpc_pending.model_list_id.as_deref(), Some("id-1"));
        assert_eq!(app.rpc_pending.model_list_mode, Some(ModelListMode::Silent));
        assert!(app.log.is_empty());
    }

    #[test]
    fn session_open_success_keeps_a_pending_model_picker() {
        let mut app = AppState::default();
        app.rpc_pending.model_list_id = Some("picker".to_string());
        app.rpc_pending.model_list_mode = Some(ModelListMode::Picker);
        let output = run_open_response(&mut app, response(Some(json!({"session_id": "s1"})), None));
        assert!(output.is_empty(), "{output}");
        assert_eq!(app.rpc_pending.model_list_id.as_deref(), Some("picker"));
        assert_eq!(app.rpc_pending.model_list_mode, Some(ModelListMode::Picker));
    }

    #[test]
    fn session_open_ignores_older_runtimes_without_the_method() {
        let mut app = AppState::default();
        let output = run_open_response(
            &mut app,
            response(
                None,
                Some(json!({"code": -32601, "message": "method not found"})),
            ),
        );
        assert!(output.is_empty(), "{output}");
        assert!(app.log.is_empty());
    }

    #[test]
    fn session_open_reports_other_errors() {
        let mut app = AppState::default();
        let output = run_open_response(
            &mut app,
            response(
                None,
                Some(json!({"code": -32004, "message": "session not found"})),
            ),
        );
        assert!(output.is_empty(), "{output}");
        assert!(app
            .log
            .iter()
            .any(|line| line.plain_text().contains("session.open error")));
    }
}
