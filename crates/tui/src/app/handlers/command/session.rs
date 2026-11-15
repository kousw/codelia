use super::RuntimeStdin;
use crate::app::handlers::panels::request_session_list;
use crate::app::runtime::send_session_update;
use crate::app::state::LogKind;
use crate::app::AppState;

pub(super) fn handle(
    app: &mut AppState,
    writer: &mut RuntimeStdin,
    next_id: &mut impl FnMut() -> String,
    args: &str,
) {
    let parts: Vec<_> = args.split_whitespace().collect();
    if parts.is_empty() || parts == ["list"] || parts == ["list", "--all"] {
        request_session_list(app, writer, next_id, parts.len() == 2);
        return;
    }
    let usage = "usage: /session [list [--all]|pin|unpin|archive|unarchive [session_id]]";
    if parts.len() > 2 || !matches!(parts[0], "pin" | "unpin" | "archive" | "unarchive") {
        app.push_line(LogKind::Error, usage);
        return;
    }
    if !app.runtime_info.supports_session_lifecycle {
        app.push_line(
            LogKind::Error,
            "Session pin/archive is unavailable in this runtime.",
        );
        return;
    }
    if app.rpc_pending.session_update_id.is_some() {
        app.push_line(LogKind::Status, "Wait for the pending session update.");
        return;
    }
    let Some(session_id) = parts
        .get(1)
        .map(|id| id.to_string())
        .or_else(|| app.runtime_info.session_id.clone())
    else {
        app.push_line(LogKind::Error, "No current session; supply a session_id.");
        return;
    };
    let action = parts[0];
    let (pinned, archived) = match action {
        "pin" => (Some(true), None),
        "unpin" => (Some(false), None),
        "archive" => (None, Some(true)),
        _ => (None, Some(false)),
    };
    let id = next_id();
    app.rpc_pending.session_update_id = Some(id.clone());
    if let Err(error) = send_session_update(writer, &id, &session_id, pinned, archived) {
        app.rpc_pending.session_update_id = None;
        app.push_error_report("send error", error.to_string());
    }
}
