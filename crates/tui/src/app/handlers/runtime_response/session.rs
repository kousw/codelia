use super::formatters::push_rpc_error;
use super::panel_builders::build_session_list_panel;
use crate::app::runtime::RpcResponse;
use crate::app::state::LogKind;
use crate::app::AppState;
use serde_json::Value;

pub(super) fn handle_session_list_response(app: &mut AppState, response: RpcResponse) {
    if let Some(error) = response.error {
        push_rpc_error(app, "session.list", &error);
        return;
    }
    if let Some(result) = response.result {
        apply_session_list_result(app, &result);
    }
}

pub(super) fn handle_session_history_response(app: &mut AppState, response: RpcResponse) {
    if let Some(error) = response.error {
        push_rpc_error(app, "session.history", &error);
        return;
    }
    if let Some(result) = response.result {
        let runs = result
            .get("runs")
            .and_then(|value| value.as_u64())
            .unwrap_or(0);
        let events = result
            .get("events_sent")
            .and_then(|value| value.as_u64())
            .unwrap_or(0);
        let truncated = result
            .get("truncated")
            .and_then(|value| value.as_bool())
            .unwrap_or(false);
        let suffix = if truncated { " (truncated)" } else { "" };
        app.push_line(
            LogKind::Status,
            format!("History restored: {events} events from {runs} runs{suffix}"),
        );
        app.push_line(LogKind::Space, "");
    }
}

fn apply_session_list_result(app: &mut AppState, result: &Value) {
    let sessions = result
        .get("sessions")
        .and_then(|value| value.as_array())
        .cloned()
        .unwrap_or_default();
    if sessions.is_empty() {
        app.push_line(LogKind::Status, "No saved sessions found.");
        app.push_line(LogKind::Space, "");
        return;
    }
    app.session_list_panel = Some(build_session_list_panel(&sessions));
}
