use crate::app::state::{LogKind, LogLine};
use crate::protocol::{IncomingMessage, ServerNotification, ServerRequest};
use serde_json::Value;

mod agents;
mod common;
mod diff;
mod errors;
mod events;
mod helpers;
mod lane;
mod notifications;
mod shell;
mod subagents;
mod todo;
mod types;
mod web;

use self::common::summary_line;
pub(crate) use self::errors::RunErrorPresentation;
use self::helpers::parse_runtime_log_line;
pub(crate) use self::types::{
    AgentMsg, ClientToolCancel, ClientToolMsg, ClientToolRejection, ClientToolRequest,
    CompactionPhase, GoalNotification, LlmMetricsUpdate, PermissionPreviewUpdate,
    PermissionReadyUpdate, ReplayProgressEvent, RpcResponse, RunControlMsg, RuntimeMsg,
    ServerUiMsg, ToolCallResultUpdate, UiConfirmRequest, UiPickRequest, UiPromptRequest,
};

/// Wire decoding: catalogued methods decode through the generated protocol
/// types and go to the presentation modules (`events`, `notifications`).
/// Returns `None` for responses and for methods outside the catalog.
fn typed_output(
    value: &Value,
    history_pending: bool,
    active_run_id: Option<&str>,
) -> Option<RuntimeMsg> {
    match IncomingMessage::classify(value)? {
        IncomingMessage::Request { id, method, params } => {
            match ServerRequest::decode(&method, params) {
                Ok(ServerRequest::ClientToolCall(params)) => {
                    Some(events::client_tool_call_output(id, params))
                }
                Ok(ServerRequest::UiConfirmRequest(params)) => {
                    Some(notifications::confirm_request_output(id, params))
                }
                Ok(ServerRequest::UiPromptRequest(params)) => {
                    Some(notifications::prompt_request_output(id, params))
                }
                Ok(ServerRequest::UiPickRequest(params)) => {
                    Some(notifications::pick_request_output(id, params))
                }
                Ok(ServerRequest::Unknown { .. }) => None,
                Err(error) => Some(RuntimeMsg::ClientTool(ClientToolMsg::RejectMalformed {
                    rejection: ClientToolRejection {
                        id,
                        method,
                        message: error.to_string(),
                    },
                    lines: protocol_mismatch_lines(&error),
                })),
            }
        }
        IncomingMessage::Notification { method, params } => {
            match ServerNotification::decode(&method, params) {
                Ok(ServerNotification::AgentEvent(notify)) => Some(events::agent_event_output(
                    notify,
                    history_pending,
                    active_run_id,
                )),
                Ok(ServerNotification::RunStatus(notify)) => {
                    Some(events::run_status_output(notify))
                }
                Ok(ServerNotification::RunMetrics(notify)) => {
                    Some(events::run_metrics_output(notify))
                }
                Ok(ServerNotification::ClientToolCancel(notify)) => {
                    Some(events::client_tool_cancel_output(notify))
                }
                Ok(ServerNotification::UiPickCancelled(notify)) => {
                    Some(notifications::pick_cancelled_output(notify))
                }
                Ok(ServerNotification::RunContext(notify)) => {
                    Some(notifications::run_context_output(notify))
                }
                Ok(ServerNotification::RunDiagnostics(notify)) => {
                    Some(notifications::run_diagnostics_output(notify))
                }
                Ok(ServerNotification::GoalUpdated(snapshot))
                | Ok(ServerNotification::GoalCleared(snapshot)) => {
                    Some(notifications::goal_updated_output(snapshot))
                }
                Ok(ServerNotification::GoalReady(offer)) => {
                    Some(notifications::goal_ready_output(offer))
                }
                // Opt-in notifications this client does not request.
                Ok(ServerNotification::RunContextUsage(_))
                | Ok(ServerNotification::TaskProgress(_))
                | Ok(ServerNotification::AuthLoginStatus(_)) => Some(RuntimeMsg::Ignored),
                Ok(ServerNotification::Unknown { .. }) => None,
                Err(error) if method == "agent.event" => Some(unreadable_agent_event(
                    &value["params"],
                    &error,
                    history_pending,
                    active_run_id,
                )),
                Err(error) => Some(RuntimeMsg::LogLines(protocol_mismatch_lines(&error))),
            }
        }
        IncomingMessage::Response { .. } => None,
    }
}

fn unreadable_agent_event(
    params: &Value,
    error: &crate::protocol::DecodeError,
    history_pending: bool,
    active_run_id: Option<&str>,
) -> RuntimeMsg {
    let run_id = params["run_id"].as_str();
    let replayed = params["meta"]["replayed"].as_bool();
    let event_type = params["event"]["type"].as_str();
    if is_replayed_event(replayed, run_id, history_pending, active_run_id) {
        return events::unreadable_history_event_output(event_type);
    }

    let lines = protocol_mismatch_lines(error);
    if event_type == Some("steer_applied") {
        RuntimeMsg::Agent(AgentMsg::UnreadableSteerApplied {
            run_id: run_id.map(str::to_owned),
            lines,
        })
    } else {
        RuntimeMsg::LogLines(lines)
    }
}

fn protocol_mismatch_lines(error: &crate::protocol::DecodeError) -> Vec<LogLine> {
    vec![LogLine::new(LogKind::Error, error.to_string())]
}

fn is_replayed_event(
    replayed: Option<bool>,
    run_id: Option<&str>,
    history_pending: bool,
    active_run_id: Option<&str>,
) -> bool {
    replayed.unwrap_or_else(|| history_pending && (run_id.is_none() || active_run_id != run_id))
}

#[cfg(test)]
pub(crate) fn parse_runtime_output(raw: &str) -> RuntimeMsg {
    parse_runtime_output_with_history(raw, false, None)
}

pub(crate) fn parse_runtime_output_with_history(
    raw: &str,
    history_pending: bool,
    active_run_id: Option<&str>,
) -> RuntimeMsg {
    let trimmed = raw.trim_end();
    if trimmed.is_empty() {
        return RuntimeMsg::Ignored;
    }

    if let Some(line) = parse_runtime_log_line(trimmed) {
        return RuntimeMsg::LogLines(vec![line]);
    }

    if trimmed.starts_with("[runtime]") {
        return RuntimeMsg::LogLines(vec![LogLine::new(LogKind::Runtime, trimmed.to_string())]);
    }

    let parsed: Result<Value, _> = serde_json::from_str(trimmed);
    let value = match parsed {
        Ok(value) => value,
        Err(_) => {
            return RuntimeMsg::LogLines(vec![LogLine::new(LogKind::Runtime, trimmed.to_string())]);
        }
    };

    if let Some(output) = typed_output(&value, history_pending, active_run_id) {
        return output;
    }

    if value.get("id").is_some() && (value.get("result").is_some() || value.get("error").is_some())
    {
        return RuntimeMsg::RpcResponse(RpcResponse {
            id: value["id"].as_str().unwrap_or("").to_owned(),
            result: value.get("result").cloned(),
            error: value.get("error").cloned(),
        });
    }

    RuntimeMsg::LogLines(vec![LogLine::new(LogKind::Runtime, trimmed.to_string())])
}

#[cfg(test)]
mod tests;

/// Test inputs in this crate often omit protocol fields the renderer never
/// reads (`seq`, timestamps, ids). The parser decodes strictly, so tests
/// complete those fields before parsing; contract tests live in
/// `crate::protocol::tests` and call the parser directly.
#[cfg(test)]
pub(crate) mod test_support;
