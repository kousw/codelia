use crate::app::runtime::{
    send_client_tool_error, send_client_tool_success, send_client_tool_text_success,
    ClientToolRequest,
};
use crate::app::state::{LogKind, LogLine, LogSpan, LogTone};
use crate::app::{AppState, ContextPanelState, PickDialogItem, PickDialogState};
use serde_json::{json, Value};

use super::RuntimeStdin;

const MAX_PANEL_ROWS: usize = 200;
const PROGRESS_BAR_WIDTH: usize = 16;

fn arg_str<'a>(args: &'a Value, name: &str) -> Option<&'a str> {
    args.get(name).and_then(|value| value.as_str())
}

fn arg_bool(args: &Value, name: &str) -> bool {
    args.get(name)
        .and_then(|value| value.as_bool())
        .unwrap_or(false)
}

fn truncate(text: &str, max: usize) -> String {
    if text.chars().count() <= max {
        return text.to_string();
    }
    let take = max.saturating_sub(3);
    format!("{}...", text.chars().take(take).collect::<String>())
}

fn panel_rows_from_content(content: &str) -> Vec<String> {
    let mut rows = content
        .replace("\r\n", "\n")
        .replace('\r', "\n")
        .lines()
        .take(MAX_PANEL_ROWS)
        .map(|line| truncate(line, 160))
        .collect::<Vec<_>>();
    if rows.is_empty() {
        rows.push("(empty)".to_string());
    }
    rows
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
enum ProgressStatus {
    Running,
    Completed,
    Error,
}

impl ProgressStatus {
    fn from_args(args: &Value) -> Self {
        match arg_str(args, "status") {
            Some("completed") => Self::Completed,
            Some("error") => Self::Error,
            _ => Self::Running,
        }
    }

    fn label(self) -> &'static str {
        match self {
            Self::Running => "Progress",
            Self::Completed => "Done",
            Self::Error => "Error",
        }
    }

    fn kind(self) -> LogKind {
        match self {
            Self::Running => LogKind::Status,
            Self::Completed => LogKind::TodoCompleted,
            Self::Error => LogKind::Error,
        }
    }

    fn is_terminal(self) -> bool {
        matches!(self, Self::Completed | Self::Error)
    }
}

fn finite_non_negative(value: Option<f64>) -> Option<f64> {
    let value = value?;
    if value.is_finite() && value >= 0.0 {
        Some(value)
    } else {
        None
    }
}

fn progress_fraction(
    current: Option<f64>,
    total: Option<f64>,
    status: ProgressStatus,
) -> Option<f64> {
    if status == ProgressStatus::Completed {
        return Some(1.0);
    }
    let current = finite_non_negative(current)?;
    let total = finite_non_negative(total)?;
    if total <= 0.0 {
        return None;
    }
    Some((current / total).clamp(0.0, 1.0))
}

fn progress_bar(fraction: Option<f64>) -> (String, String) {
    let Some(fraction) = fraction else {
        return ("▒▒▒▒▒▒▒▒".to_string(), "▒▒▒▒▒▒▒▒".to_string());
    };
    let filled = (fraction * PROGRESS_BAR_WIDTH as f64).round() as usize;
    let filled = filled.min(PROGRESS_BAR_WIDTH);
    (
        "█".repeat(filled),
        "░".repeat(PROGRESS_BAR_WIDTH.saturating_sub(filled)),
    )
}

fn progress_count(current: Option<f64>, total: Option<f64>) -> Option<String> {
    let current = finite_non_negative(current)?;
    Some(match finite_non_negative(total) {
        Some(total) if total > 0.0 => format_number_pair(current, total),
        _ => format_number(current),
    })
}

fn format_number_pair(current: f64, total: f64) -> String {
    format!("{}/{}", format_number(current), format_number(total))
}

fn format_number(value: f64) -> String {
    if value.fract() == 0.0 {
        format!("{}", value as u64)
    } else {
        format!("{value:.1}")
    }
}

fn build_progress_line(args: &Value) -> LogLine {
    let status = ProgressStatus::from_args(args);
    let phase = truncate(arg_str(args, "phase").unwrap_or("progress"), 24);
    let message = truncate(arg_str(args, "message").unwrap_or(""), 140);
    let current = args.get("current").and_then(|value| value.as_f64());
    let total = args.get("total").and_then(|value| value.as_f64());
    let fraction = progress_fraction(current, total, status);
    let (filled, empty) = progress_bar(fraction);
    let percent = fraction.map(|value| (value * 100.0).round() as u64);
    let count = progress_count(current, total);
    let status_kind = status.kind();

    let mut spans = vec![
        LogSpan::new(
            status_kind,
            LogTone::Summary,
            format!("{:<8} {:<24} [", status.label(), phase),
        ),
        LogSpan::new(status_kind, LogTone::Summary, filled),
        LogSpan::new(LogKind::ToolResult, LogTone::Detail, empty),
        LogSpan::new(LogKind::Status, LogTone::Detail, "]"),
    ];

    if let Some(percent) = percent {
        spans.push(LogSpan::new(
            LogKind::Status,
            LogTone::Summary,
            format!(" {:>3}%", percent.min(100)),
        ));
    }

    if let Some(count) = count {
        spans.push(LogSpan::new(
            LogKind::Status,
            LogTone::Detail,
            format!(" {}", count),
        ));
    }

    if !message.is_empty() {
        spans.push(LogSpan::new(
            LogKind::Assistant,
            LogTone::Detail,
            format!("  {message}"),
        ));
    }

    LogLine::new_with_spans(spans)
}

fn progress_tracking_key(args: &Value) -> String {
    if let Some(id) = arg_str(args, "id").filter(|value| !value.trim().is_empty()) {
        return format!("id:{id}");
    }
    let phase = arg_str(args, "phase")
        .filter(|value| !value.trim().is_empty())
        .unwrap_or("progress");
    format!("phase:{phase}")
}

fn replace_or_append_progress_line(app: &mut AppState, key: &str, line: LogLine) {
    if let Some(index) = app.progress_component_lines.get(key).copied() {
        if app.log.get(index).is_some() {
            app.replace_log_line(index, line);
            return;
        }
    }

    let index = app.log.len();
    app.extend_lines(vec![line]);
    app.progress_component_lines.insert(key.to_string(), index);
}

fn append_optional_choice(
    items: &mut Vec<PickDialogItem>,
    args: &Value,
    enabled: &str,
    id: &str,
    label_field: &str,
    default_label: &str,
    description_field: &str,
) {
    if !arg_bool(args, enabled) {
        return;
    }
    items.push(PickDialogItem {
        id: id.to_string(),
        label: arg_str(args, label_field)
            .unwrap_or(default_label)
            .to_string(),
        detail: arg_str(args, description_field).map(|value| value.to_string()),
    });
}

fn handle_ask_user_choice(
    app: &mut AppState,
    request: ClientToolRequest,
    child_stdin: &mut RuntimeStdin,
) -> bool {
    if app.pick_dialog.is_some() {
        if let Err(error) = send_client_tool_error(child_stdin, &request.id, "pick dialog is busy")
        {
            app.push_error_report("client tool response error", error.to_string());
        }
        return true;
    }
    let choices = request
        .arguments
        .get("choices")
        .and_then(|value| value.as_array())
        .cloned()
        .unwrap_or_default();
    let mut items = choices
        .into_iter()
        .filter_map(|choice| {
            let id = choice.get("id")?.as_str()?.to_string();
            let label = choice.get("label")?.as_str()?.to_string();
            let detail = choice
                .get("description")
                .and_then(|value| value.as_str())
                .map(|value| value.to_string());
            Some(PickDialogItem { id, label, detail })
        })
        .collect::<Vec<_>>();
    append_optional_choice(
        &mut items,
        &request.arguments,
        "allow_none",
        "__none_of_these__",
        "none_label",
        "None of these",
        "none_description",
    );
    append_optional_choice(
        &mut items,
        &request.arguments,
        "allow_other",
        "__other__",
        "other_label",
        "Other",
        "other_description",
    );
    if items.is_empty() {
        if let Err(error) = send_client_tool_error(child_stdin, &request.id, "choices are required")
        {
            app.push_error_report("client tool response error", error.to_string());
        }
        return true;
    }
    let title = arg_str(&request.arguments, "title")
        .unwrap_or("Choose")
        .to_string();
    let message = arg_str(&request.arguments, "message")
        .filter(|value| !value.trim().is_empty())
        .map(|value| value.to_string());
    app.rpc_pending
        .client_tool_choice_ids
        .insert(request.id.clone());
    app.pick_dialog = Some(PickDialogState {
        id: request.id,
        title,
        message,
        items,
        selected: 0,
        multi: false,
        chosen: Vec::new(),
    });
    true
}

fn handle_open_selector(
    app: &mut AppState,
    request: ClientToolRequest,
    child_stdin: &mut RuntimeStdin,
) -> bool {
    let title = arg_str(&request.arguments, "title")
        .unwrap_or("Selector")
        .to_string();
    let header = arg_str(&request.arguments, "header")
        .unwrap_or("label | detail")
        .to_string();
    let rows = request
        .arguments
        .get("items")
        .and_then(|value| value.as_array())
        .map(|items| {
            items
                .iter()
                .take(MAX_PANEL_ROWS)
                .filter_map(|item| {
                    let label = item.get("label")?.as_str()?;
                    let detail = item.get("detail").and_then(|value| value.as_str());
                    Some(match detail {
                        Some(detail) if !detail.is_empty() => {
                            format!("{} | {}", truncate(label, 80), truncate(detail, 100))
                        }
                        _ => truncate(label, 160),
                    })
                })
                .collect::<Vec<_>>()
        })
        .unwrap_or_default();
    app.context_panel = Some(ContextPanelState {
        title,
        header,
        rows,
        selected: 0,
    });
    if let Err(error) = send_client_tool_text_success(child_stdin, &request.id, "selector opened") {
        app.push_error_report("client tool response error", error.to_string());
    }
    true
}

fn handle_preview_artifact(
    app: &mut AppState,
    request: ClientToolRequest,
    child_stdin: &mut RuntimeStdin,
) -> bool {
    let title = arg_str(&request.arguments, "title")
        .unwrap_or("Preview")
        .to_string();
    let kind = arg_str(&request.arguments, "kind").unwrap_or("text");
    let content = arg_str(&request.arguments, "content").unwrap_or("");
    app.context_panel = Some(ContextPanelState {
        title,
        header: format!("artifact kind={kind}"),
        rows: panel_rows_from_content(content),
        selected: 0,
    });
    if let Err(error) =
        send_client_tool_text_success(child_stdin, &request.id, "artifact previewed")
    {
        app.push_error_report("client tool response error", error.to_string());
    }
    true
}

fn focus_latest_kind(app: &mut AppState, kind: LogKind) -> bool {
    let Some(index) = app.log.iter().rposition(|line| line.kind() == kind) else {
        return false;
    };
    app.scroll_from_bottom = app.log.len().saturating_sub(index.saturating_add(1));
    true
}

fn handle_focus_context(
    app: &mut AppState,
    request: ClientToolRequest,
    child_stdin: &mut RuntimeStdin,
) -> bool {
    let target = arg_str(&request.arguments, "target").unwrap_or("bottom");
    let focused = match target {
        "bottom" => {
            app.scroll_from_bottom = 0;
            true
        }
        "top" => {
            app.scroll_from_bottom = app.log.len();
            true
        }
        "latest_error" => focus_latest_kind(app, LogKind::Error),
        "latest_tool_call" => focus_latest_kind(app, LogKind::ToolCall),
        _ => false,
    };
    if let Err(error) = send_client_tool_success(
        child_stdin,
        &request.id,
        json!({ "focused": focused, "target": target }),
    ) {
        app.push_error_report("client tool response error", error.to_string());
    }
    true
}

fn handle_show_progress(
    app: &mut AppState,
    request: ClientToolRequest,
    child_stdin: &mut RuntimeStdin,
) -> bool {
    let status = ProgressStatus::from_args(&request.arguments);
    let progress_key = progress_tracking_key(&request.arguments);
    replace_or_append_progress_line(app, &progress_key, build_progress_line(&request.arguments));
    if status.is_terminal() {
        app.progress_component_lines.remove(&progress_key);
    }
    if let Err(error) = send_client_tool_text_success(child_stdin, &request.id, "progress shown") {
        app.push_error_report("client tool response error", error.to_string());
    }
    true
}

pub(super) fn handle_client_tool_request(
    app: &mut AppState,
    request: ClientToolRequest,
    child_stdin: &mut RuntimeStdin,
) -> bool {
    match request.name.as_str() {
        "tui_ask_user_choice" => handle_ask_user_choice(app, request, child_stdin),
        "tui_open_selector" => handle_open_selector(app, request, child_stdin),
        "tui_preview_artifact" => handle_preview_artifact(app, request, child_stdin),
        "tui_focus_context" => handle_focus_context(app, request, child_stdin),
        "tui_show_progress" => handle_show_progress(app, request, child_stdin),
        _ => {
            if let Err(error) =
                send_client_tool_error(child_stdin, &request.id, "unknown TUI client tool")
            {
                app.push_error_report("client tool response error", error.to_string());
            }
            true
        }
    }
}

#[cfg(test)]
mod tests {
    use super::{build_progress_line, handle_ask_user_choice, handle_show_progress};
    use crate::app::handlers::runtime_response::RuntimeStdin;
    use crate::app::runtime::ClientToolRequest;
    use crate::app::AppState;
    use serde_json::json;
    use std::io::{BufWriter, Write};
    use std::process::Stdio;

    fn with_runtime_writer<T>(f: impl FnOnce(&mut RuntimeStdin) -> T) -> T {
        #[cfg(windows)]
        let mut command = {
            let mut command = std::process::Command::new("cmd");
            command.args(["/C", "more"]);
            command
        };
        #[cfg(not(windows))]
        let mut command = {
            let mut command = std::process::Command::new("sh");
            command.args(["-c", "cat >/dev/null"]);
            command
        };
        let mut child = command
            .stdin(Stdio::piped())
            .stdout(Stdio::null())
            .spawn()
            .expect("spawn runtime writer");
        let stdin = child.stdin.take().expect("child stdin");
        let mut writer = BufWriter::new(stdin);
        let out = f(&mut writer);
        writer.flush().expect("flush runtime writer");
        drop(writer);
        let _ = child.kill();
        let _ = child.wait();
        out
    }

    fn progress_request(id: &str, arguments: serde_json::Value) -> ClientToolRequest {
        ClientToolRequest {
            id: id.to_string(),
            name: "tui_show_progress".to_string(),
            arguments,
        }
    }

    #[test]
    fn ask_user_choice_appends_fallback_options_when_enabled() {
        with_runtime_writer(|writer| {
            let mut app = AppState::default();

            handle_ask_user_choice(
                &mut app,
                progress_request(
                    "choice1",
                    json!({
                        "title": "Choose next",
                        "message": "Pick a direction.",
                        "allow_none": true,
                        "none_label": "No good option",
                        "allow_other": true,
                        "choices": [
                            { "id": "details", "label": "More details" }
                        ]
                    }),
                ),
                writer,
            );

            let pick = app.pick_dialog.expect("pick dialog");
            assert_eq!(pick.message.as_deref(), Some("Pick a direction."));
            let ids = pick
                .items
                .iter()
                .map(|item| item.id.as_str())
                .collect::<Vec<_>>();
            assert_eq!(ids, vec!["details", "__none_of_these__", "__other__"]);
            assert_eq!(pick.items[1].label, "No good option");
            assert_eq!(pick.items[2].label, "Other");
        });
    }

    #[test]
    fn progress_line_renders_bar_percent_and_message() {
        let line = build_progress_line(&json!({
            "phase": "smoke",
            "message": "custom tool smoke",
            "current": 2,
            "total": 4
        }));

        let text = line.plain_text();
        assert!(text.contains("Progress"));
        assert!(text.contains("smoke"));
        assert!(text.contains("[████████░░░░░░░░]"));
        assert!(text.contains("50%"));
        assert!(text.contains("2/4"));
        assert!(text.contains("custom tool smoke"));
    }

    #[test]
    fn progress_with_same_id_replaces_existing_line() {
        with_runtime_writer(|writer| {
            let mut app = AppState::default();

            handle_show_progress(
                &mut app,
                progress_request(
                    "call1",
                    json!({
                        "id": "build",
                        "phase": "build",
                        "current": 1,
                        "total": 4
                    }),
                ),
                writer,
            );
            handle_show_progress(
                &mut app,
                progress_request(
                    "call2",
                    json!({
                        "id": "build",
                        "phase": "build",
                        "status": "completed",
                        "message": "ready"
                    }),
                ),
                writer,
            );

            assert_eq!(app.log.len(), 1);
            let text = app.log[0].plain_text();
            assert!(text.contains("Done"));
            assert!(text.contains("100%"));
            assert!(text.contains("ready"));
            assert!(!app.progress_component_lines.contains_key("id:build"));
        });
    }

    #[test]
    fn progress_without_id_replaces_existing_phase_line() {
        with_runtime_writer(|writer| {
            let mut app = AppState::default();

            handle_show_progress(
                &mut app,
                progress_request(
                    "call1",
                    json!({
                        "phase": "smoke",
                        "message": "first",
                        "current": 1,
                        "total": 4
                    }),
                ),
                writer,
            );
            handle_show_progress(
                &mut app,
                progress_request(
                    "call2",
                    json!({
                        "phase": "smoke",
                        "message": "second",
                        "current": 2,
                        "total": 4
                    }),
                ),
                writer,
            );

            assert_eq!(app.log.len(), 1);
            let text = app.log[0].plain_text();
            assert!(text.contains("second"));
            assert!(text.contains("50%"));
            assert!(!text.contains("first"));
        });
    }
}
