use crate::app::runtime::RpcResponse;
use crate::app::state::LogKind;
use crate::app::AppState;
use crate::protocol::{decode_result, methods, ClientRequest, TaskInfo, TaskSummary};

/// The result of a task request, or the error line to show instead.
fn extract_result<R: ClientRequest>(
    response: RpcResponse,
    label: &str,
) -> Result<R::Result, String> {
    if let Some(error) = response.error {
        return Err(format!("{label} error: {error}"));
    }
    let result = response
        .result
        .ok_or_else(|| format!("{label} returned no result"))?;
    decode_result::<R>(result).map_err(|error| error.to_string())
}

/// Fields shared by task summaries and full task info.
struct TaskView<'a> {
    task_id: &'a str,
    key: Option<&'a str>,
    kind: &'a str,
    state: &'a str,
    title: &'a str,
}

impl<'a> From<&'a TaskSummary> for TaskView<'a> {
    fn from(task: &'a TaskSummary) -> Self {
        Self {
            task_id: &task.task_id,
            key: task.key.as_deref(),
            kind: task.kind.as_str(),
            state: task.state.as_str(),
            title: task.title.as_deref().unwrap_or(""),
        }
    }
}

impl<'a> From<&'a TaskInfo> for TaskView<'a> {
    fn from(task: &'a TaskInfo) -> Self {
        Self {
            task_id: &task.task_id,
            key: task.key.as_deref(),
            kind: task.kind.as_str(),
            state: task.state.as_str(),
            title: task.title.as_deref().unwrap_or(""),
        }
    }
}

impl TaskView<'_> {
    fn key(&self) -> Option<&str> {
        self.key.filter(|value| !value.is_empty())
    }

    fn identity(&self) -> String {
        match self.key() {
            Some(key) if key != self.task_id => format!("{key} ({})", self.task_id),
            Some(key) => key.to_string(),
            None => self.task_id.to_string(),
        }
    }

    fn label(&self) -> String {
        let identity = self.identity();
        let (kind, state) = (self.kind, self.state);
        if self.title.is_empty() {
            format!("{identity} | {kind} | {state}")
        } else {
            format!("{identity} | {kind} | {state} | {}", self.title)
        }
    }
}

pub(super) fn handle_task_list_response(app: &mut AppState, response: RpcResponse) {
    let result = match extract_result::<methods::TaskList>(response, "task.list") {
        Ok(result) => result,
        Err(error) => {
            app.push_error_report("task.list", error);
            return;
        }
    };
    if result.tasks.is_empty() {
        app.push_line(LogKind::Status, "No tasks.");
        return;
    }
    app.push_line(
        LogKind::Status,
        format!("Tasks: {} item(s)", result.tasks.len()),
    );
    for task in &result.tasks {
        app.push_line(
            LogKind::Status,
            format!("  {}", TaskView::from(task).label()),
        );
    }
    app.push_line(LogKind::Space, "");
}

pub(super) fn handle_task_status_response(app: &mut AppState, response: RpcResponse) {
    let result = match extract_result::<methods::TaskStatus>(response, "task.status") {
        Ok(result) => result,
        Err(error) => {
            app.push_error_report("task.status", error);
            return;
        }
    };
    let view = TaskView::from(&result);
    app.push_line(LogKind::Status, format!("Task {}", view.label()));
    if let Some(key) = view.key() {
        app.push_line(LogKind::Status, format!("  key={key}"));
    }
    app.push_line(LogKind::Status, format!("  task_id={}", result.task_id));
    if let Some(cwd) = &result.working_directory {
        app.push_line(LogKind::Status, format!("  cwd={cwd}"));
    }
    if let Some(duration_ms) = result.duration_ms.filter(|value| *value >= 0.0) {
        app.push_line(
            LogKind::Status,
            format!("  duration_ms={}", duration_ms as u64),
        );
    }
    if let Some(exit_code) = result.exit_code {
        app.push_line(LogKind::Status, format!("  exit_code={exit_code}"));
    }
    if let Some(message) = &result.failure_message {
        app.push_line(LogKind::Status, format!("  failure={message}"));
    }
    if let Some(message) = &result.cancellation_reason {
        app.push_line(LogKind::Status, format!("  cancellation={message}"));
    }
    for (label, output) in [("stdout", &result.stdout), ("stderr", &result.stderr)] {
        if let Some(output) = output.as_deref().filter(|output| !output.is_empty()) {
            app.push_line(LogKind::Status, format!("  {label}:"));
            for line in output.lines().take(5) {
                app.push_line(LogKind::Status, format!("    {line}"));
            }
        }
    }
    app.push_line(LogKind::Space, "");
}

pub(super) fn handle_task_cancel_response(app: &mut AppState, response: RpcResponse) {
    let result = match extract_result::<methods::TaskCancel>(response, "task.cancel") {
        Ok(result) => result,
        Err(error) => {
            app.push_error_report("task.cancel", error);
            return;
        }
    };
    let view = TaskView::from(&result);
    app.push_line(
        LogKind::Status,
        format!("Task {}: {}", view.identity(), view.state),
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
    use serde_json::{json, Value};

    /// A protocol-complete task with the given overrides.
    fn task(fields: Value) -> Value {
        let mut task = json!({
            "task_id": "task-123",
            "kind": "shell",
            "workspace_mode": "live_workspace",
            "state": "running",
            "created_at": "2026-11-22T00:00:00.000Z",
            "updated_at": "2026-11-22T00:00:00.000Z",
            "exit_code": null,
            "duration_ms": null
        });
        for (key, value) in fields.as_object().expect("fields") {
            task[key] = value.clone();
        }
        task
    }

    #[test]
    fn task_list_response_shows_public_key_before_task_id() {
        let mut app = AppState::default();
        handle_task_list_response(
            &mut app,
            RpcResponse {
                id: "task-list-1".to_string(),
                result: Some(json!({
                    "tasks": [task(json!({
                        "key": "build-1234abcd",
                        "title": "bun run typecheck"
                    }))]
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
                result: Some(task(json!({
                    "key": "build-1234abcd",
                    "state": "completed",
                    "title": "bun run typecheck"
                }))),
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
                result: Some(task(json!({
                    "key": "build-1234abcd",
                    "state": "cancelled"
                }))),
                error: None,
            },
        );

        assert!(app.log.iter().any(|line| line
            .plain_text()
            .contains("Task build-1234abcd (task-123): cancelled")));
    }
}
