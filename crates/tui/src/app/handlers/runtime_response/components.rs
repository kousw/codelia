use super::formatters::{tool_call_summary_with_status_icon, tool_call_with_status_icon};
use crate::app::runtime::{
    CompactionPhase, PermissionPreviewUpdate, PermissionReadyUpdate, ToolCallResultUpdate,
};
use crate::app::state::{LogKind, LogLine};
use crate::app::{AppState, LogComponentSpan};

pub(super) const UNKNOWN_RUN_SCOPE: &str = "unknown";

pub(super) type PendingComponentStart = (String, LogKind);

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
enum ToolResultReplacementMode {
    KeepExistingSummary,
    UseFallbackSummary,
}

fn take_first_line_by_kind(lines: &mut Vec<LogLine>, kind: LogKind) -> Option<LogLine> {
    let index = lines.iter().position(|line| line.kind() == kind)?;
    Some(lines.remove(index))
}

fn current_run_scope(app: &AppState) -> String {
    app.runtime_info
        .active_run_id
        .clone()
        .unwrap_or_else(|| UNKNOWN_RUN_SCOPE.to_string())
}

pub(super) fn clear_component_tracking_for_run(app: &mut AppState, run_scope: &str) {
    app.active_compaction_component_by_scope.remove(run_scope);
    app.compaction_sequence_by_scope.remove(run_scope);
    let prefix = format!("run:{run_scope}:");
    app.pending_component_lines
        .retain(|key, _| !key.starts_with(&prefix));
}

fn next_compaction_component_key(app: &mut AppState, run_scope: &str) -> String {
    let next = app
        .compaction_sequence_by_scope
        .entry(run_scope.to_string())
        .and_modify(|value| *value = value.saturating_add(1))
        .or_insert(1);
    format!("run:{run_scope}:compaction#{next}")
}

fn take_component_line_index(app: &mut AppState, key: &str) -> Option<usize> {
    let span = app.pending_component_lines.get(key).copied()?;
    let index = span.first_index();
    if app.log.get(index).is_some() {
        return Some(index);
    }
    app.pending_component_lines.remove(key);
    None
}

pub(super) fn take_active_compaction_key(app: &mut AppState, run_scope: &str) -> Option<String> {
    if let Some(key) = app.active_compaction_component_by_scope.remove(run_scope) {
        return Some(key);
    }
    if run_scope != UNKNOWN_RUN_SCOPE {
        return None;
    }
    if app.active_compaction_component_by_scope.len() == 1 {
        let only_scope = app
            .active_compaction_component_by_scope
            .keys()
            .next()
            .cloned()?;
        return app.active_compaction_component_by_scope.remove(&only_scope);
    }
    None
}

pub(super) fn apply_compaction_component_events(
    app: &mut AppState,
    lines: &mut Vec<LogLine>,
    pending_component_starts: &mut Vec<PendingComponentStart>,
    phase: CompactionPhase,
) {
    match phase {
        CompactionPhase::Started => {
            if let Some(running_line) = take_first_line_by_kind(lines, LogKind::Compaction) {
                let run_scope = current_run_scope(app);
                let key = next_compaction_component_key(app, &run_scope);
                app.active_compaction_component_by_scope
                    .insert(run_scope, key.clone());
                pending_component_starts.push((key, LogKind::Compaction));
                lines.insert(0, running_line);
            }
        }
        CompactionPhase::Completed => {
            let Some(completion_line) = take_first_line_by_kind(lines, LogKind::Compaction) else {
                return;
            };
            let run_scope = current_run_scope(app);
            let Some(active_key) = take_active_compaction_key(app, &run_scope) else {
                lines.insert(0, completion_line);
                return;
            };
            if let Some(index) = take_component_line_index(app, &active_key) {
                app.replace_log_line(index, completion_line);
                app.pending_component_lines.remove(&active_key);
            } else {
                lines.insert(0, completion_line);
            }
        }
    }
}

pub(super) fn register_pending_component_lines(
    app: &mut AppState,
    appended_from: usize,
    pending_component_starts: Vec<PendingComponentStart>,
) {
    let mut search_from = appended_from;
    for (key, kind) in pending_component_starts {
        let Some((index, _)) = app
            .log
            .iter()
            .enumerate()
            .skip(search_from)
            .find(|(_, line)| line.kind() == kind)
        else {
            continue;
        };
        app.pending_component_lines
            .insert(key, LogComponentSpan::single(index));
        search_from = index.saturating_add(1);
    }
}

pub(super) fn tool_component_key(run_scope: &str, tool_call_id: &str) -> String {
    format!("run:{run_scope}:tool:{tool_call_id}")
}

pub(super) fn resolve_tool_component_key(app: &AppState, tool_call_id: &str) -> Option<String> {
    let suffix = format!(":tool:{tool_call_id}");
    app.pending_component_lines
        .iter()
        .filter(|(key, _)| key.ends_with(&suffix))
        .max_by_key(|(_, span)| span.first_index())
        .map(|(key, _)| key.clone())
}

fn tool_result_replacement_mode(tool: &str) -> ToolResultReplacementMode {
    match tool {
        "shell"
        | "shell_status"
        | "shell_logs"
        | "shell_wait"
        | "shell_result"
        | "shell_cancel"
        | "webfetch"
        | "task_spawn"
        | "task_wait"
        | "task_status"
        | "task_result"
        | "task_cancel"
        | "task_list"
        | "task_cancel_all"
        | "task_send_message"
        | "task_receive_messages" => ToolResultReplacementMode::UseFallbackSummary,
        _ => ToolResultReplacementMode::KeepExistingSummary,
    }
}

pub(super) fn tool_call_start(app: &AppState, tool_call_id: &str) -> PendingComponentStart {
    (
        tool_component_key(&current_run_scope(app), tool_call_id),
        LogKind::ToolCall,
    )
}

pub(super) fn permission_preview(app: &mut AppState, update: PermissionPreviewUpdate) {
    app.permission_preview_by_tool_call.insert(
        update.tool_call_id,
        crate::app::PermissionPreviewRecord {
            has_diff: update.has_diff,
            truncated: update.truncated,
            diff_fingerprint: update.diff_fingerprint,
        },
    );
}

pub(super) fn permission_ready(
    app: &mut AppState,
    PermissionReadyUpdate { tool_call_id }: PermissionReadyUpdate,
    lines: &mut Vec<LogLine>,
) {
    if !app.permission_ready_tool_call_ids.insert(tool_call_id) {
        lines.clear();
    }
}

pub(super) fn tool_call_result(
    app: &mut AppState,
    lines: &mut Vec<LogLine>,
    update: ToolCallResultUpdate,
) {
    let ToolCallResultUpdate {
        tool_call_id,
        tool,
        is_error,
        preserve_call_summary,
        fallback_summary,
        edit_diff_fingerprint,
    } = update;
    let replacement_mode = if preserve_call_summary {
        ToolResultReplacementMode::KeepExistingSummary
    } else {
        tool_result_replacement_mode(&tool)
    };
    app.permission_ready_tool_call_ids.remove(&tool_call_id);
    let preview = app.permission_preview_by_tool_call.remove(&tool_call_id);
    let suppress_edit_diff_lines = matches!(tool.as_str(), "edit" | "apply_patch")
        && preview.as_ref().is_some_and(|record| {
            record.has_diff
                && !record.truncated
                && record.diff_fingerprint.as_deref() == edit_diff_fingerprint.as_deref()
        });
    let mut inserted_fallback_summary = false;
    let run_scope = current_run_scope(app);
    let scoped_key = tool_component_key(&run_scope, &tool_call_id);
    let component_key = if app.pending_component_lines.contains_key(&scoped_key) {
        Some(scoped_key)
    } else {
        resolve_tool_component_key(app, &tool_call_id)
    };
    if let Some(component_key) = component_key {
        if let Some(index) = take_component_line_index(app, &component_key) {
            app.pending_component_lines.remove(&component_key);
            if let Some(existing) = app.log.get(index).cloned() {
                let updated = match replacement_mode {
                    ToolResultReplacementMode::UseFallbackSummary => {
                        tool_call_summary_with_status_icon(&fallback_summary.plain_text(), is_error)
                    }
                    ToolResultReplacementMode::KeepExistingSummary => {
                        tool_call_with_status_icon(&existing, is_error)
                    }
                };
                app.replace_log_line(index, updated);
            } else {
                lines.insert(0, fallback_summary);
                inserted_fallback_summary = true;
            }
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
