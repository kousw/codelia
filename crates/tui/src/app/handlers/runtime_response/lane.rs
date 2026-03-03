use crate::app::runtime::{send_tool_call, RpcResponse};
use crate::app::state::LogKind;
use crate::app::{AppState, LaneListItem, LaneListPanelState};
use serde_json::{json, Value};

use super::RuntimeStdin;

fn extract_tool_call_result(response: RpcResponse) -> Result<Value, String> {
    if let Some(error) = response.error {
        return Err(error.to_string());
    }
    let result = response
        .result
        .ok_or_else(|| "tool.call returned no result".to_string())?;
    let ok = result
        .get("ok")
        .and_then(|value| value.as_bool())
        .unwrap_or(false);
    if !ok {
        return Err("tool.call failed".to_string());
    }
    result
        .get("result")
        .cloned()
        .ok_or_else(|| "tool.call returned no payload".to_string())
}

pub(super) fn handle_lane_list_response(app: &mut AppState, response: RpcResponse) {
    match extract_tool_call_result(response) {
        Ok(result) => apply_lane_list_result(app, &result),
        Err(error) => app.push_error_report("lane_list error", error),
    }
}

pub(super) fn handle_lane_status_response(app: &mut AppState, response: RpcResponse) {
    let result = match extract_tool_call_result(response) {
        Ok(result) => result,
        Err(error) => {
            app.push_error_report("lane_status error", error);
            return;
        }
    };
    let lane = result.get("lane").unwrap_or(&result);
    let lane_id = lane
        .get("lane_id")
        .and_then(|value| value.as_str())
        .unwrap_or("-");
    let state = lane
        .get("state")
        .and_then(|value| value.as_str())
        .unwrap_or("-");
    app.push_line(LogKind::Status, format!("Lane {lane_id}: {state}"));
    if let Some(mux_live) = result.get("mux_live").and_then(|value| value.as_bool()) {
        app.push_line(LogKind::Status, format!("  mux_live={mux_live}"));
    }
    app.push_line(LogKind::Space, "");
}

pub(super) fn handle_lane_close_response(
    app: &mut AppState,
    response: RpcResponse,
    child_stdin: &mut RuntimeStdin,
    next_id: &mut impl FnMut() -> String,
) {
    let result = match extract_tool_call_result(response) {
        Ok(result) => result,
        Err(error) => {
            app.push_error_report("lane_close error", error);
            return;
        }
    };
    let lane_id = result
        .get("lane")
        .and_then(|lane| lane.get("lane_id"))
        .and_then(|value| value.as_str())
        .unwrap_or("-");
    app.push_line(LogKind::Status, format!("Closed lane {lane_id}"));
    app.push_line(LogKind::Space, "");

    let request_id = next_id();
    app.rpc_pending.lane_list_id = Some(request_id.clone());
    if let Err(error) = send_tool_call(child_stdin, &request_id, "lane_list", json!({})) {
        app.rpc_pending.lane_list_id = None;
        app.push_error_report("send error", error.to_string());
    }
}

pub(super) fn handle_lane_create_response(
    app: &mut AppState,
    response: RpcResponse,
    child_stdin: &mut RuntimeStdin,
    next_id: &mut impl FnMut() -> String,
) {
    let result = match extract_tool_call_result(response) {
        Ok(result) => result,
        Err(error) => {
            app.push_error_report("lane_create error", error);
            return;
        }
    };

    let lane_id = result
        .get("lane")
        .and_then(|lane| lane.get("lane_id"))
        .and_then(|value| value.as_str())
        .unwrap_or("-");
    app.push_line(LogKind::Status, format!("Created lane {lane_id}"));
    if let Some(attach) = result
        .get("hints")
        .and_then(|hints| hints.get("attach_command"))
        .and_then(|value| value.as_str())
    {
        app.push_line(LogKind::Status, format!("Attach: {attach}"));
    }
    app.push_line(LogKind::Space, "");

    let request_id = next_id();
    app.rpc_pending.lane_list_id = Some(request_id.clone());
    if let Err(error) = send_tool_call(child_stdin, &request_id, "lane_list", json!({})) {
        app.rpc_pending.lane_list_id = None;
        app.push_error_report("send error", error.to_string());
    }
}

pub(crate) fn apply_lane_list_result(app: &mut AppState, result: &Value) {
    let lanes = result
        .get("lanes")
        .and_then(|value| value.as_array())
        .cloned()
        .unwrap_or_default();

    let mut rows = Vec::new();
    let mut items = Vec::new();
    for lane in lanes {
        let lane_id = lane
            .get("lane_id")
            .and_then(|value| value.as_str())
            .unwrap_or("")
            .to_string();
        if lane_id.is_empty() {
            continue;
        }
        let task_id = lane
            .get("task_id")
            .and_then(|value| value.as_str())
            .unwrap_or("-")
            .to_string();
        let state = lane
            .get("state")
            .and_then(|value| value.as_str())
            .unwrap_or("-")
            .to_string();
        let mux_backend = lane
            .get("mux_backend")
            .and_then(|value| value.as_str())
            .unwrap_or("-")
            .to_string();
        rows.push(format!("{lane_id} | {task_id} | {state} | {mux_backend}"));
        items.push(LaneListItem { lane_id });
    }
    rows.push("+ New lane".to_string());

    app.model_list_panel = None;
    app.reasoning_picker = None;
    app.session_list_panel = None;
    app.context_panel = None;
    app.skills_list_panel = None;
    app.theme_list_panel = None;
    app.prompt_dialog = None;
    app.pick_dialog = None;
    app.lane_list_panel = Some(LaneListPanelState {
        title: "Lanes".to_string(),
        header: "lane_id | task_id | state | mux".to_string(),
        rows,
        lanes: items,
        selected: 0,
    });
}
