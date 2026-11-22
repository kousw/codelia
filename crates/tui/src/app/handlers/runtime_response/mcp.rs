use super::formatters::push_rpc_error;
use crate::app::runtime::RpcResponse;
use crate::app::state::LogKind;
use crate::app::AppState;
use crate::protocol::{decode_result, methods, McpListResult, McpListServer};

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
        match decode_result::<methods::McpList>(result) {
            Ok(result) => apply_mcp_list_result(app, &result, detail_id),
            Err(error) => super::push_protocol_mismatch(app, &error),
        }
    }
}

/// `transport source enabled state tools` of one server.
fn columns(server: &McpListServer) -> String {
    format!(
        "{} {} {} {} {}",
        server.transport.as_str(),
        server.source.as_ref().map_or("-", |source| source.as_str()),
        server.enabled,
        server.state.as_str(),
        server.tools.unwrap_or(0)
    )
}

fn apply_mcp_list_result(app: &mut AppState, result: &McpListResult, detail_id: Option<&str>) {
    let servers = &result.servers;
    if servers.is_empty() {
        app.push_line(LogKind::Status, "no MCP servers configured");
        app.push_line(LogKind::Space, "");
        return;
    }

    if let Some(detail_id) = detail_id {
        let Some(server) = servers.iter().find(|entry| entry.id == detail_id) else {
            app.push_line(LogKind::Error, format!("MCP server not found: {detail_id}"));
            app.push_line(LogKind::Space, "");
            return;
        };
        app.push_line(LogKind::Status, format!("MCP {}", server.id));
        app.push_line(
            LogKind::Status,
            format!(
                "  transport={} source={} enabled={} state={} tools={}",
                server.transport.as_str(),
                server.source.as_ref().map_or("-", |source| source.as_str()),
                server.enabled,
                server.state.as_str(),
                server.tools.unwrap_or(0)
            ),
        );
        if let Some(last_error) = &server.last_error {
            app.push_line(LogKind::Error, format!("  last_error={last_error}"));
        }
        if let Some(last_connected_at) = &server.last_connected_at {
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
    for server in servers {
        app.push_line(
            LogKind::Status,
            format!("{} {}", server.id, columns(server)),
        );
    }
    app.push_line(LogKind::Space, "");
}
