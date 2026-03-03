use super::formatters::push_rpc_error;
use crate::app::runtime::RpcResponse;
use crate::app::state::LogKind;
use crate::app::AppState;
use serde_json::Value;

pub(super) fn handle_mcp_list_response(
    app: &mut AppState,
    response: RpcResponse,
    detail_id: Option<&str>,
) {
    if let Some(error) = response.error {
        push_rpc_error(app, "mcp.list", &error);
        return;
    }
    if let Some(result) = response.result {
        apply_mcp_list_result(app, &result, detail_id);
    }
}

fn apply_mcp_list_result(app: &mut AppState, result: &Value, detail_id: Option<&str>) {
    let servers = result
        .get("servers")
        .and_then(|value| value.as_array())
        .cloned()
        .unwrap_or_default();

    if servers.is_empty() {
        app.push_line(LogKind::Status, "no MCP servers configured");
        app.push_line(LogKind::Space, "");
        return;
    }

    if let Some(detail_id) = detail_id {
        let server = servers.iter().find(|entry| {
            entry
                .get("id")
                .and_then(|value| value.as_str())
                .map(|value| value == detail_id)
                .unwrap_or(false)
        });
        let Some(server) = server else {
            app.push_line(LogKind::Error, format!("MCP server not found: {detail_id}"));
            app.push_line(LogKind::Space, "");
            return;
        };
        let id = server
            .get("id")
            .and_then(|value| value.as_str())
            .unwrap_or(detail_id);
        let transport = server
            .get("transport")
            .and_then(|value| value.as_str())
            .unwrap_or("-");
        let source = server
            .get("source")
            .and_then(|value| value.as_str())
            .unwrap_or("-");
        let enabled = server
            .get("enabled")
            .and_then(|value| value.as_bool())
            .unwrap_or(false);
        let state = server
            .get("state")
            .and_then(|value| value.as_str())
            .unwrap_or("-");
        let tools = server
            .get("tools")
            .and_then(|value| value.as_u64())
            .map(|value| value.to_string())
            .unwrap_or_else(|| "0".to_string());
        app.push_line(LogKind::Status, format!("MCP {id}"));
        app.push_line(
            LogKind::Status,
            format!(
                "  transport={transport} source={source} enabled={enabled} state={state} tools={tools}"
            ),
        );
        if let Some(last_error) = server.get("last_error").and_then(|value| value.as_str()) {
            app.push_line(LogKind::Error, format!("  last_error={last_error}"));
        }
        if let Some(last_connected_at) = server
            .get("last_connected_at")
            .and_then(|value| value.as_str())
        {
            app.push_line(
                LogKind::Status,
                format!("  last_connected_at={last_connected_at}"),
            );
        }
        app.push_line(LogKind::Space, "");
        return;
    }

    app.push_line(
        LogKind::Status,
        "MCP servers: id transport source enabled state tools",
    );
    for server in &servers {
        let id = server
            .get("id")
            .and_then(|value| value.as_str())
            .unwrap_or("-");
        let transport = server
            .get("transport")
            .and_then(|value| value.as_str())
            .unwrap_or("-");
        let source = server
            .get("source")
            .and_then(|value| value.as_str())
            .unwrap_or("-");
        let enabled = server
            .get("enabled")
            .and_then(|value| value.as_bool())
            .unwrap_or(false);
        let state = server
            .get("state")
            .and_then(|value| value.as_str())
            .unwrap_or("-");
        let tools = server
            .get("tools")
            .and_then(|value| value.as_u64())
            .map(|value| value.to_string())
            .unwrap_or_else(|| "0".to_string());
        app.push_line(
            LogKind::Status,
            format!("{id} {transport} {source} {enabled} {state} {tools}"),
        );
    }
    app.push_line(LogKind::Space, "");
}
