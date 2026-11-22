//! Pre-catalog `agent.event` renderer over raw JSON.
//!
//! Live events are decoded with the generated protocol types (`events.rs`).
//! This renderer only receives replayed history events that do not match the
//! current contract, so older session logs keep rendering. Remove it with the
//! Phase 3 parser split (dev-docs/specs/protocol-codegen.md section 11).
use super::diff::{normalize_diff_fingerprint, permission_preview_lines};
use super::helpers::{
    is_legacy_permission_raw_args_message, looks_like_error, permission_preflight_ready_lines,
    summarize_tool_call, tool_result_lines,
};
use super::{
    shell, subagents, summary_line, ParsedOutput, PermissionPreviewUpdate, PermissionReadyUpdate,
    ReplayProgressEvent, ToolCallResultUpdate,
};
use crate::app::state::{LogKind, LogLine, LogSpan, LogTone};
use crate::app::transcript::render_body;
use serde_json::Value;

pub(super) fn legacy_agent_event_output(
    value: &Value,
    history_pending: bool,
    active_run_id: Option<&str>,
) -> ParsedOutput {
    let event = &value["params"]["event"];
    let run_id = value["params"]
        .get("run_id")
        .and_then(Value::as_str)
        .unwrap_or("");
    let replayed = value["params"]["meta"]
        .get("replayed")
        .and_then(Value::as_bool)
        .unwrap_or_else(|| history_pending && active_run_id != Some(run_id));
    let event_type = event
        .get("type")
        .and_then(|v| v.as_str())
        .unwrap_or("event");
    match event_type {
        "text.delta" | "reasoning.delta" => {
            use crate::app::state::stream_preview::StreamUpdate;
            if replayed || run_id.is_empty() {
                return ParsedOutput::empty();
            }
            let Some(id) = event
                .get("stream_id")
                .and_then(Value::as_str)
                .filter(|id| !id.is_empty())
            else {
                return ParsedOutput::empty();
            };
            let Some(content) = event.get("delta").and_then(Value::as_str) else {
                return ParsedOutput::empty();
            };
            let Some(index) = event.get("index").and_then(Value::as_u64) else {
                return ParsedOutput::empty();
            };
            return ParsedOutput {
                stream_update: Some(StreamUpdate::Append {
                    run_id: run_id.to_string(),
                    stream_id: id.to_string(),
                    index,
                    reasoning: event_type == "reasoning.delta",
                    content: content.to_string(),
                }),
                ..ParsedOutput::empty()
            };
        }
        "permission.preview" => {
            let tool = event.get("tool").and_then(|v| v.as_str()).unwrap_or("tool");
            let tool_call_id = event
                .get("tool_call_id")
                .and_then(|v| v.as_str())
                .map(|v| v.to_string());
            let file_path = event.get("file_path").and_then(|v| v.as_str());
            let language = event.get("language").and_then(|v| v.as_str());
            let diff = event.get("diff").and_then(|v| v.as_str());
            let summary = event.get("summary").and_then(|v| v.as_str());
            let truncated = event
                .get("truncated")
                .and_then(|v| v.as_bool())
                .unwrap_or(false);
            let diff_fingerprint = diff.and_then(normalize_diff_fingerprint);
            return ParsedOutput {
                lines: permission_preview_lines(
                    tool, diff, summary, truncated, file_path, language,
                ),
                permission_preview_update: tool_call_id.map(|id| PermissionPreviewUpdate {
                    tool_call_id: id,
                    has_diff: diff_fingerprint.is_some(),
                    truncated,
                    diff_fingerprint,
                }),
                ..ParsedOutput::empty()
            };
        }
        "permission.ready" => {
            let tool = event.get("tool").and_then(|v| v.as_str()).unwrap_or("tool");
            let tool_call_id = event
                .get("tool_call_id")
                .and_then(|v| v.as_str())
                .map(|v| v.to_string());
            return ParsedOutput {
                lines: permission_preflight_ready_lines(tool),
                permission_ready_update: tool_call_id
                    .map(|id| PermissionReadyUpdate { tool_call_id: id }),
                ..ParsedOutput::empty()
            };
        }
        "text" => {
            let content = event.get("content").and_then(|v| v.as_str()).unwrap_or("");
            if is_legacy_permission_raw_args_message(content) {
                return ParsedOutput::empty();
            }
            let lines = render_body(content, false);
            return ParsedOutput {
                lines,
                assistant_text: Some(content.to_string()),
                canonical_run_id: (!replayed && !run_id.is_empty()).then(|| run_id.to_string()),
                ..ParsedOutput::empty()
            };
        }
        "reasoning" => {
            let content = event.get("content").and_then(|v| v.as_str()).unwrap_or("");
            if content.trim().is_empty() {
                return ParsedOutput::empty();
            }
            return ParsedOutput {
                lines: render_body(content, true),
                reasoning_text: Some(content.to_string()),
                canonical_run_id: (!replayed && !run_id.is_empty()).then(|| run_id.to_string()),
                ..ParsedOutput::empty()
            };
        }
        "llm.status" => {
            if event.get("provider").and_then(|v| v.as_str()) != Some("openai") {
                return ParsedOutput::empty();
            }
            let message = match event.get("kind").and_then(|v| v.as_str()) {
                Some("verification") if event.get("verification").and_then(|v| v.as_str()) == Some("trusted_access_for_cyber") =>
                    "OpenAI recommends Trusted Access for Cyber verification in your ChatGPT account.",
                Some("buffering") if event.get("active").and_then(|v| v.as_bool()) == Some(true) =>
                    "OpenAI: additional checks in progress; waiting for the response.",
                _ => return ParsedOutput::empty(),
            };
            return ParsedOutput {
                lines: vec![summary_line("", message, LogKind::Status)],
                ..ParsedOutput::empty()
            };
        }
        "llm.retry" => {
            let provider = event
                .get("provider")
                .and_then(|v| v.as_str())
                .unwrap_or("provider");
            let kind = event
                .get("failure_kind")
                .and_then(|v| v.as_str())
                .unwrap_or("transient");
            let next_attempt = event
                .get("next_attempt")
                .and_then(|v| v.as_u64())
                .unwrap_or(0);
            let max_attempts = event
                .get("max_attempts")
                .and_then(|v| v.as_u64())
                .unwrap_or(0);
            let delay_ms = event.get("delay_ms").and_then(|v| v.as_u64()).unwrap_or(0);
            let delay = if delay_ms < 1000 {
                format!("{delay_ms}ms")
            } else {
                format!("{}s", delay_ms.div_ceil(1000))
            };
            return ParsedOutput {
                stream_reset: !replayed,
                canonical_run_id: (!replayed && !run_id.is_empty()).then(|| run_id.to_string()),
                lines: vec![summary_line(
                    "",
                    format!(
                        "LLM retry: {provider} {kind} in {delay} ({next_attempt}/{max_attempts})"
                    ),
                    LogKind::Status,
                )],
                ..ParsedOutput::empty()
            };
        }
        "step_start" | "step_complete" => {
            return ParsedOutput::empty();
        }
        "compaction_start" => {
            let lines = vec![summary_line("", "Compaction: running", LogKind::Compaction)];
            return ParsedOutput {
                lines,
                compaction_started: true,
                ..ParsedOutput::empty()
            };
        }
        "compaction_complete" => {
            let compacted = event
                .get("compacted")
                .and_then(|v| v.as_bool())
                .unwrap_or(false);
            let status = if compacted { "completed" } else { "skipped" };
            let label = format!("Compaction: {status} (compacted={compacted})");
            let lines = vec![summary_line("", label, LogKind::Compaction)];
            return ParsedOutput {
                lines,
                compaction_completed: true,
                ..ParsedOutput::empty()
            };
        }
        "tool_call" => {
            let tool = event.get("tool").and_then(|v| v.as_str()).unwrap_or("tool");
            // Completion text is rendered by the authoritative final event.
            if tool == "done" {
                return ParsedOutput::empty();
            }
            if tool == "tui_show_progress" {
                let replay_progress = if replayed {
                    event.get("tool_call_id").and_then(Value::as_str).map(|id| {
                        ReplayProgressEvent::Call {
                            run_id: run_id.to_string(),
                            tool_call_id: id.to_string(),
                            args: event.get("args").cloned().unwrap_or(Value::Null),
                        }
                    })
                } else {
                    None
                };
                return ParsedOutput {
                    replay_progress,
                    ..ParsedOutput::empty()
                };
            }
            let args = event.get("args").cloned().unwrap_or(Value::Null);
            let tool_call_id = event
                .get("tool_call_id")
                .and_then(|v| v.as_str())
                .map(|v| v.to_string());
            let summary = summarize_tool_call(tool, &args);
            let mut spans = vec![LogSpan::new(
                LogKind::ToolCall,
                LogTone::Summary,
                summary.label,
            )];
            if !summary.detail.is_empty() {
                spans.push(LogSpan::new(LogKind::ToolCall, LogTone::Summary, " "));
                spans.push(LogSpan::new(
                    LogKind::Assistant,
                    LogTone::Summary,
                    summary.detail,
                ));
            }
            let lines = vec![LogLine::new_with_spans(spans)];
            return ParsedOutput {
                lines,
                tool_call_start_id: tool_call_id,
                ..ParsedOutput::empty()
            };
        }
        "tool_result" => {
            let tool = event.get("tool").and_then(|v| v.as_str()).unwrap_or("tool");
            let tool_call_id = event
                .get("tool_call_id")
                .and_then(|v| v.as_str())
                .map(|v| v.to_string());
            let result = event.get("result").cloned().unwrap_or(Value::Null);
            let is_error = event
                .get("is_error")
                .and_then(|v| v.as_bool())
                .unwrap_or(false);
            let content = if let Some(text) = result.as_str() {
                text.to_string()
            } else {
                result.to_string()
            };
            let is_error_result = is_error || looks_like_error(tool, &content, is_error);
            let replay_progress = if tool == "tui_show_progress" && replayed {
                tool_call_id.as_ref().map(|id| ReplayProgressEvent::Result {
                    run_id: run_id.to_string(),
                    tool_call_id: id.clone(),
                    is_error: is_error_result,
                })
            } else {
                None
            };
            if matches!(tool, "tui_show_progress" | "done") && !is_error_result {
                return ParsedOutput {
                    replay_progress,
                    ..ParsedOutput::empty()
                };
            }
            let mut rendered = tool_result_lines(tool, &content, is_error);
            let mut lines = rendered.lines;
            let fallback_summary = if let Some(line) = lines.first().cloned() {
                line
            } else {
                LogLine::new(LogKind::ToolResult, "")
            };
            let tool_call_result = tool_call_id.map(|id| ToolCallResultUpdate {
                tool_call_id: id,
                tool: tool.to_string(),
                is_error: is_error_result,
                preserve_call_summary: shell::preserve_denied_call_summary(tool, &content),
                fallback_summary,
                edit_diff_fingerprint: rendered.edit_diff_fingerprint.take(),
            });
            if tool_call_result.is_some() && !lines.is_empty() {
                lines.remove(0);
            }
            return ParsedOutput {
                lines,
                tool_call_result,
                replay_progress,
                ..ParsedOutput::empty()
            };
        }
        "final" => {
            let content = event.get("content").and_then(|v| v.as_str()).unwrap_or("");
            let lines = render_body(content, false);
            return ParsedOutput {
                lines,
                final_text: Some(content.to_string()),
                canonical_run_id: (!replayed && !run_id.is_empty()).then(|| run_id.to_string()),
                ..ParsedOutput::empty()
            };
        }
        "steer_applied" => {
            let lines = crate::app::util::user_message::steer_message_lines(event.get("content"));
            let applied_steer_id = (!replayed)
                .then(|| {
                    event
                        .get("steer_id")
                        .and_then(Value::as_str)
                        .map(str::to_string)
                })
                .flatten();
            return ParsedOutput {
                lines,
                applied_steer_id,
                ..ParsedOutput::empty()
            };
        }
        "hidden_user_message" => {
            let content = event.get("content").and_then(|v| v.as_str()).unwrap_or("");
            if let Some(lines) = subagents::incoming_message_lines(content) {
                return ParsedOutput {
                    lines,
                    ..ParsedOutput::empty()
                };
            }
            let line = format!("> {}", content);
            let lines = vec![LogLine::new(LogKind::User, line)];
            return ParsedOutput {
                lines,
                ..ParsedOutput::empty()
            };
        }
        _ => {
            return ParsedOutput {
                lines: vec![LogLine::new(
                    LogKind::Runtime,
                    format!("event: {event_type}"),
                )],
                ..ParsedOutput::empty()
            };
        }
    }
}
