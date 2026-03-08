use crate::app::runtime::RpcResponse;
use crate::app::state::LogKind;
use crate::app::AppState;
use serde_json::Value;

fn extract_result(response: RpcResponse, label: &str) -> Result<Value, String> {
    if let Some(error) = response.error {
        return Err(format!("{label} error: {error}"));
    }
    response
        .result
        .ok_or_else(|| format!("{label} returned no result"))
}

fn task_id(task: &Value) -> &str {
    task.get("task_id")
        .and_then(|value| value.as_str())
        .unwrap_or("-")
}

fn task_key(task: &Value) -> Option<&str> {
    task.get("key")
        .and_then(|value| value.as_str())
        .filter(|value| !value.is_empty())
}

fn task_identity(task: &Value) -> String {
    let task_id = task_id(task);
    match task_key(task) {
        Some(key) if key != task_id => format!("{key} ({task_id})"),
        Some(key) => key.to_string(),
        None => task_id.to_string(),
    }
}

fn task_label(task: &Value) -> String {
    let identity = task_identity(task);
    let kind = task
        .get("kind")
        .and_then(|value| value.as_str())
        .unwrap_or("-");
    let state = task
        .get("state")
        .and_then(|value| value.as_str())
        .unwrap_or("-");
    let title = task
        .get("title")
        .and_then(|value| value.as_str())
        .unwrap_or("");
    if title.is_empty() {
        format!("{identity} | {kind} | {state}")
    } else {
        format!("{identity} | {kind} | {state} | {title}")
    }
}

pub(super) fn handle_task_list_response(app: &mut AppState, response: RpcResponse) {
    let result = match extract_result(response, "task.list") {
        Ok(result) => result,
        Err(error) => {
            app.push_error_report("task.list", error);
            return;
        }
    };
    let tasks = result
        .get("tasks")
        .and_then(|value| value.as_array())
        .cloned()
        .unwrap_or_default();
    if tasks.is_empty() {
        app.push_line(LogKind::Status, "No tasks.");
        return;
    }
    app.push_line(LogKind::Status, format!("Tasks: {} item(s)", tasks.len()));
    for task in tasks {
        app.push_line(LogKind::Status, format!("  {}", task_label(&task)));
    }
    app.push_line(LogKind::Space, "");
}

pub(super) fn handle_task_status_response(app: &mut AppState, response: RpcResponse) {
    let result = match extract_result(response, "task.status") {
        Ok(result) => result,
        Err(error) => {
            app.push_error_report("task.status", error);
            return;
        }
    };
    app.push_line(LogKind::Status, format!("Task {}", task_label(&result)));
    if let Some(key) = task_key(&result) {
        app.push_line(LogKind::Status, format!("  key={key}"));
    }
    app.push_line(LogKind::Status, format!("  task_id={}", task_id(&result)));
    if let Some(cwd) = result
        .get("working_directory")
        .and_then(|value| value.as_str())
    {
        app.push_line(LogKind::Status, format!("  cwd={cwd}"));
    }
    if let Some(duration_ms) = result.get("duration_ms").and_then(|value| value.as_u64()) {
        app.push_line(LogKind::Status, format!("  duration_ms={duration_ms}"));
    }
    if let Some(exit_code) = result.get("exit_code").and_then(|value| value.as_i64()) {
        app.push_line(LogKind::Status, format!("  exit_code={exit_code}"));
    }
    if let Some(message) = result
        .get("failure_message")
        .and_then(|value| value.as_str())
    {
        app.push_line(LogKind::Status, format!("  failure={message}"));
    }
    if let Some(message) = result
        .get("cancellation_reason")
        .and_then(|value| value.as_str())
    {
        app.push_line(LogKind::Status, format!("  cancellation={message}"));
    }
    if let Some(stdout) = result.get("stdout").and_then(|value| value.as_str()) {
        if !stdout.is_empty() {
            app.push_line(LogKind::Status, "  stdout:".to_string());
            for line in stdout.lines().take(5) {
                app.push_line(LogKind::Status, format!("    {line}"));
            }
        }
    }
    if let Some(stderr) = result.get("stderr").and_then(|value| value.as_str()) {
        if !stderr.is_empty() {
            app.push_line(LogKind::Status, "  stderr:".to_string());
            for line in stderr.lines().take(5) {
                app.push_line(LogKind::Status, format!("    {line}"));
            }
        }
    }
    app.push_line(LogKind::Space, "");
}

pub(super) fn handle_task_cancel_response(app: &mut AppState, response: RpcResponse) {
    let result = match extract_result(response, "task.cancel") {
        Ok(result) => result,
        Err(error) => {
            app.push_error_report("task.cancel", error);
            return;
        }
    };
    let state = result
        .get("state")
        .and_then(|value| value.as_str())
        .unwrap_or("-");
    app.push_line(
        LogKind::Status,
        format!("Task {}: {state}", task_identity(&result)),
    );
    app.push_line(LogKind::Space, "");
}

#[cfg(test)]
mod tests {
    use super::{
        handle_task_cancel_response, handle_task_list_response, handle_task_status_response,
    };
    use crate::app::runtime::RpcResponse;
    use crate::app::AppState;
    use serde_json::json;

    #[test]
    fn task_list_response_shows_public_key_before_task_id() {
        let mut app = AppState::default();
        handle_task_list_response(
            &mut app,
            RpcResponse {
                id: "task-list-1".to_string(),
                result: Some(json!({
                    "tasks": [{
                        "task_id": "task-123",
                        "key": "build-1234abcd",
                        "kind": "shell",
                        "state": "running",
                        "title": "bun run typecheck"
                    }]
                })),
                error: None,
            },
        );

        assert!(app.log.iter().any(|line| line
            .plain_text()
            .contains("build-1234abcd (task-123) | shell | running | bun run typecheck")));
    }

    #[test]
    fn task_status_response_includes_key_and_task_id_lines() {
        let mut app = AppState::default();
        handle_task_status_response(
            &mut app,
            RpcResponse {
                id: "task-status-1".to_string(),
                result: Some(json!({
                    "task_id": "task-123",
                    "key": "build-1234abcd",
                    "kind": "shell",
                    "state": "completed",
                    "title": "bun run typecheck"
                })),
                error: None,
            },
        );

        assert!(app.log.iter().any(|line| line
            .plain_text()
            .contains("Task build-1234abcd (task-123) | shell | completed | bun run typecheck")));
        assert!(app
            .log
            .iter()
            .any(|line| line.plain_text().contains("key=build-1234abcd")));
        assert!(app
            .log
            .iter()
            .any(|line| line.plain_text().contains("task_id=task-123")));
    }

    #[test]
    fn task_cancel_response_prefers_public_key_in_summary() {
        let mut app = AppState::default();
        handle_task_cancel_response(
            &mut app,
            RpcResponse {
                id: "task-cancel-1".to_string(),
                result: Some(json!({
                    "task_id": "task-123",
                    "key": "build-1234abcd",
                    "state": "cancelled"
                })),
                error: None,
            },
        );

        assert!(app.log.iter().any(|line| line
            .plain_text()
            .contains("Task build-1234abcd (task-123): cancelled")));
    }
}
