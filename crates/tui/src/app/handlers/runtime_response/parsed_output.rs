use super::formatters::{
    add_kind_spacing, format_duration, last_summary_kind, tool_call_with_status_icon,
};
use super::panel_builders::build_onboarding_model_list_panel;
use crate::app::handlers::confirm::handle_confirm_request;
use crate::app::runtime::{ParsedOutput, ToolCallResultUpdate, UiPickRequest, UiPromptRequest};
use crate::app::state::{LogKind, LogLine, LogTone};
use crate::app::{AppState, PickDialogItem, PickDialogState, PromptDialogState};

use super::RuntimeStdin;

const COMPACTION_RUNNING_LABEL: &str = "Compaction: running";

fn is_compaction_running_line(line: &LogLine) -> bool {
    line.kind() == LogKind::Compaction && line.plain_text() == COMPACTION_RUNNING_LABEL
}

fn is_compaction_terminal_line(line: &LogLine) -> bool {
    if line.kind() != LogKind::Compaction {
        return false;
    }
    let text = line.plain_text();
    text.starts_with("Compaction: completed") || text.starts_with("Compaction: skipped")
}

fn apply_compaction_line_update(app: &mut AppState, lines: &mut Vec<LogLine>) {
    let Some(incoming_index) = lines.iter().position(is_compaction_terminal_line) else {
        return;
    };
    let completion_line = lines.remove(incoming_index);
    if let Some((existing_index, _)) = app
        .log
        .iter()
        .enumerate()
        .rev()
        .find(|(_, line)| is_compaction_running_line(line))
    {
        app.replace_log_line(existing_index, completion_line);
    } else {
        lines.insert(0, completion_line);
    }
}

pub(super) fn apply_parsed_output(
    app: &mut AppState,
    parsed: ParsedOutput,
    child_stdin: &mut RuntimeStdin,
    next_id: &mut impl FnMut() -> String,
) -> bool {
    let ParsedOutput {
        lines,
        status,
        status_run_id,
        context_left_percent,
        assistant_text,
        final_text,
        rpc_response,
        confirm_request,
        prompt_request,
        pick_request,
        tool_call_start_id,
        tool_call_result,
        permission_preview_update,
    } = parsed;

    if let Some(status) = status {
        let terminal = matches!(status.as_str(), "completed" | "error" | "cancelled");
        if terminal {
            app.rpc_pending.run_start_id = None;
            app.rpc_pending.run_cancel_id = None;
            app.runtime_info.active_run_id = None;
            app.permission_preview_by_tool_call.clear();
        } else if let Some(run_id) = status_run_id {
            app.runtime_info.active_run_id = Some(run_id);
        }
        app.update_run_status(status);
    }
    if let Some(percent) = context_left_percent {
        app.context_left_percent = Some(percent);
    }
    if let Some(text) = assistant_text {
        app.last_assistant_text = Some(text);
    }

    let mut lines = lines;
    if let Some(update) = permission_preview_update {
        app.permission_preview_by_tool_call.insert(
            update.tool_call_id,
            crate::app::PermissionPreviewRecord {
                has_diff: update.has_diff,
                truncated: update.truncated,
                diff_fingerprint: update.diff_fingerprint,
            },
        );
    }
    if let Some(ToolCallResultUpdate {
        tool_call_id,
        tool,
        is_error,
        fallback_summary,
        edit_diff_fingerprint,
    }) = tool_call_result
    {
        let preview = app.permission_preview_by_tool_call.remove(&tool_call_id);
        let suppress_edit_diff_lines = tool == "edit"
            && preview.as_ref().is_some_and(|record| {
                record.has_diff
                    && !record.truncated
                    && record.diff_fingerprint.as_deref() == edit_diff_fingerprint.as_deref()
            });
        let mut inserted_fallback_summary = false;
        if let Some(index) = app.pending_tool_lines.remove(&tool_call_id) {
            if let Some(existing) = app.log.get(index).cloned() {
                let updated = tool_call_with_status_icon(&existing, is_error);
                app.replace_log_line(index, updated);
            } else {
                lines.insert(0, fallback_summary);
                inserted_fallback_summary = true;
            }
        } else {
            let fallback = match fallback_summary.plain_text().as_str() {
                "✔ Bash done" => LogLine::new(LogKind::ToolResult, "✔ Bash finished"),
                "✖ Bash failed" => LogLine::new(LogKind::Error, "✖ Bash failed"),
                "✔ Read done" => LogLine::new(LogKind::ToolResult, "✔ Read finished"),
                "✖ Read failed" => LogLine::new(LogKind::Error, "✖ Read failed"),
                _ => fallback_summary,
            };
            lines.insert(0, fallback);
            inserted_fallback_summary = true;
        }
        if suppress_edit_diff_lines {
            if inserted_fallback_summary {
                lines.truncate(1);
            } else {
                lines.clear();
            }
        }
    }
    let has_final = final_text.is_some();
    if let Some(final_text) = final_text {
        if app.last_assistant_text.as_deref() == Some(final_text.as_str()) {
            lines.clear();
        } else {
            app.last_assistant_text = Some(final_text);
        }
    }

    if has_final {
        if let Some(duration) = app.run_duration() {
            if !matches!(lines.last().map(LogLine::kind), Some(LogKind::Space)) {
                lines.push(LogLine::new(LogKind::Space, ""));
            }
            lines.push(LogLine::new_with_tone(
                LogKind::Status,
                LogTone::Detail,
                format!("⏱ Run duration: {}", format_duration(duration)),
            ));
        }
    }

    apply_compaction_line_update(app, &mut lines);

    // Filter out debug print lines if debug print is disabled
    lines.retain(|line| {
        if app.enable_debug_print {
            return true;
        }
        !matches!(line.kind(), LogKind::Runtime | LogKind::Rpc)
    });

    let prev_summary = last_summary_kind(&app.log, app.enable_debug_print);
    let mut lines = add_kind_spacing(lines, prev_summary, app.enable_debug_print);
    if has_final && !matches!(lines.last().map(LogLine::kind), Some(LogKind::Space)) {
        lines.push(LogLine::new(LogKind::Space, ""));
    }
    let appended_from = app.log.len();
    app.extend_lines(lines);
    if let Some(tool_call_id) = tool_call_start_id {
        let tool_line_index = app
            .log
            .iter()
            .enumerate()
            .skip(appended_from)
            .find(|(_, line)| line.kind() == LogKind::ToolCall)
            .map(|(index, _)| index);
        if let Some(index) = tool_line_index {
            app.pending_tool_lines.insert(tool_call_id, index);
        }
    }

    let mut needs_redraw = true;
    if let Some(response) = rpc_response {
        if super::handle_rpc_response(app, response, child_stdin, next_id) {
            needs_redraw = true;
        }
    }
    if let Some(request) = confirm_request {
        handle_confirm_request(app, request);
        needs_redraw = true;
    }
    if let Some(request) = prompt_request {
        handle_prompt_request(app, request);
        needs_redraw = true;
    }
    if let Some(request) = pick_request {
        handle_pick_request(app, request);
        needs_redraw = true;
    }
    needs_redraw
}

fn handle_prompt_request(app: &mut AppState, request: UiPromptRequest) {
    app.prompt_input.clear();
    if let Some(default_value) = request.default_value.as_deref() {
        app.prompt_input.set_from(default_value);
    }
    app.prompt_dialog = Some(PromptDialogState {
        id: request.id,
        title: request.title,
        message: request.message,
        multiline: request.multiline,
        secret: request.secret,
    });
}

fn handle_pick_request(app: &mut AppState, request: UiPickRequest) {
    if let Some(panel) = build_onboarding_model_list_panel(&request) {
        app.pick_dialog = None;
        app.model_list_panel = Some(panel);
        return;
    }
    let chosen = vec![false; request.items.len()];
    app.pick_dialog = Some(PickDialogState {
        id: request.id,
        title: request.title,
        items: request
            .items
            .into_iter()
            .map(|item| PickDialogItem {
                id: item.id,
                label: item.label,
                detail: item.detail,
            })
            .collect(),
        selected: 0,
        multi: request.multi,
        chosen,
    });
}

#[cfg(test)]
mod tests {
    use super::apply_compaction_line_update;
    use crate::app::state::{LogKind, LogLine};
    use crate::app::AppState;

    #[test]
    fn compaction_complete_replaces_latest_running_line() {
        let mut app = AppState::default();
        app.push_line(LogKind::Compaction, "Compaction: running");

        let mut incoming = vec![LogLine::new(
            LogKind::Compaction,
            "Compaction: completed (compacted=true)",
        )];
        apply_compaction_line_update(&mut app, &mut incoming);

        assert!(incoming.is_empty());
        assert_eq!(app.log.len(), 1);
        assert_eq!(
            app.log[0].plain_text(),
            "Compaction: completed (compacted=true)"
        );
    }

    #[test]
    fn compaction_complete_keeps_line_when_running_is_missing() {
        let mut app = AppState::default();
        let mut incoming = vec![LogLine::new(
            LogKind::Compaction,
            "Compaction: skipped (compacted=false)",
        )];

        apply_compaction_line_update(&mut app, &mut incoming);

        assert_eq!(incoming.len(), 1);
        assert_eq!(incoming[0].plain_text(), "Compaction: skipped (compacted=false)");
        assert!(app.log.is_empty());
    }
}
