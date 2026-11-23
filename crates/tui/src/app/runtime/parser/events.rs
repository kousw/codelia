//! Presentation of decoded runtime notifications and requests.
//!
//! Wire decoding happens in `crate::protocol`; these functions only map typed
//! values to transcript lines and state updates.
use super::diff::{normalize_diff_fingerprint, permission_preview_lines};
use super::errors;
use super::helpers::{
    is_legacy_permission_raw_args_message, looks_like_error, permission_preflight_ready_lines,
    summarize_tool_call, summary_and_detail_line, tool_result_lines,
};
use super::{
    shell, subagents, summary_line, ClientToolCancel, ClientToolRequest, LlmMetricsUpdate,
    ParsedOutput, PermissionPreviewUpdate, PermissionReadyUpdate, ReplayProgressEvent,
    ToolCallResultUpdate,
};
use crate::app::state::{LogKind, LogLine, LogSpan, LogTone};
use crate::app::transcript::render_body;
use crate::protocol::{
    AgentEvent, AgentEventNotify, ClientToolCallRequestParams, ClientToolCancelParams, DecodeError,
    LlmStatusEvent, RunMetricsNotify, RunStatusNotify,
};
use serde_json::Value;

/// One diagnostic line for a known method or tag that broke its contract.
pub(super) fn protocol_mismatch_output(error: &DecodeError) -> ParsedOutput {
    ParsedOutput {
        lines: vec![LogLine::new(LogKind::Error, error.to_string())],
        ..ParsedOutput::empty()
    }
}

/// A replayed `agent.event` that fails strict decoding. Saved logs from the
/// same contract always decode; this covers damaged or foreign logs.
pub(super) fn unreadable_history_event_output(value: &serde_json::Value) -> ParsedOutput {
    let kind: String = value["params"]["event"]["type"]
        .as_str()
        .unwrap_or("unknown")
        .chars()
        .filter(|c| !c.is_control())
        .map(|c| {
            if c.is_ascii_alphanumeric() || matches!(c, '.' | '_' | '-') {
                c
            } else {
                '_'
            }
        })
        .take(40)
        .collect();
    ParsedOutput {
        lines: vec![LogLine::new(
            LogKind::Status,
            format!("Skipped a saved history event (`{kind}`) that this version cannot read."),
        )],
        ..ParsedOutput::empty()
    }
}

fn canonical_run_id(replayed: bool, run_id: &str) -> Option<String> {
    (!replayed && !run_id.is_empty()).then(|| run_id.to_string())
}

pub(super) fn agent_event_output(
    notify: AgentEventNotify,
    history_pending: bool,
    active_run_id: Option<&str>,
) -> ParsedOutput {
    let run_id = notify.run_id.as_str();
    let replayed = notify
        .meta
        .as_ref()
        .and_then(|meta| meta.replayed)
        .unwrap_or_else(|| history_pending && active_run_id != Some(run_id));
    match notify.event {
        AgentEvent::TextDelta(delta) => stream_delta(
            run_id,
            replayed,
            &delta.stream_id,
            delta.index,
            delta.delta,
            false,
        ),
        AgentEvent::ReasoningDelta(delta) => stream_delta(
            run_id,
            replayed,
            &delta.stream_id,
            delta.index,
            delta.delta,
            true,
        ),
        AgentEvent::PermissionPreview(event) => {
            let truncated = event.truncated.unwrap_or(false);
            let diff_fingerprint = event.diff.as_deref().and_then(normalize_diff_fingerprint);
            ParsedOutput {
                lines: permission_preview_lines(
                    &event.tool,
                    event.diff.as_deref(),
                    event.summary.as_deref(),
                    truncated,
                    event.file_path.as_deref(),
                    event.language.as_deref(),
                ),
                permission_preview_update: event.tool_call_id.map(|id| PermissionPreviewUpdate {
                    tool_call_id: id,
                    has_diff: diff_fingerprint.is_some(),
                    truncated,
                    diff_fingerprint,
                }),
                ..ParsedOutput::empty()
            }
        }
        AgentEvent::PermissionReady(event) => ParsedOutput {
            lines: permission_preflight_ready_lines(&event.tool),
            permission_ready_update: event
                .tool_call_id
                .map(|id| PermissionReadyUpdate { tool_call_id: id }),
            ..ParsedOutput::empty()
        },
        AgentEvent::Text(event) => {
            if is_legacy_permission_raw_args_message(&event.content) {
                return ParsedOutput::empty();
            }
            ParsedOutput {
                lines: render_body(&event.content, false),
                assistant_text: Some(event.content),
                canonical_run_id: canonical_run_id(replayed, run_id),
                ..ParsedOutput::empty()
            }
        }
        AgentEvent::Reasoning(event) => {
            if event.content.trim().is_empty() {
                return ParsedOutput::empty();
            }
            ParsedOutput {
                lines: render_body(&event.content, true),
                reasoning_text: Some(event.content),
                canonical_run_id: canonical_run_id(replayed, run_id),
                ..ParsedOutput::empty()
            }
        }
        AgentEvent::LlmStatus(status) => {
            let message = match status {
                LlmStatusEvent::Verification(event)
                    if event.provider == "openai"
                        && event.verification == "trusted_access_for_cyber" =>
                {
                    "OpenAI recommends Trusted Access for Cyber verification in your ChatGPT account."
                }
                LlmStatusEvent::Buffering(event) if event.provider == "openai" && event.active => {
                    "OpenAI: additional checks in progress; waiting for the response."
                }
                _ => return ParsedOutput::empty(),
            };
            ParsedOutput {
                lines: vec![summary_line("", message, LogKind::Status)],
                ..ParsedOutput::empty()
            }
        }
        AgentEvent::LlmRetry(event) => {
            let delay_ms = event.delay_ms.max(0.0) as u64;
            let delay = if delay_ms < 1000 {
                format!("{delay_ms}ms")
            } else {
                format!("{}s", delay_ms.div_ceil(1000))
            };
            ParsedOutput {
                stream_reset: !replayed,
                canonical_run_id: canonical_run_id(replayed, run_id),
                lines: vec![summary_line(
                    "",
                    format!(
                        "LLM retry: {} {} in {delay} ({}/{})",
                        event.provider,
                        event.failure_kind.as_str(),
                        event.next_attempt,
                        event.max_attempts
                    ),
                    LogKind::Status,
                )],
                ..ParsedOutput::empty()
            }
        }
        AgentEvent::StepStart(_) | AgentEvent::StepComplete(_) => ParsedOutput::empty(),
        AgentEvent::CompactionStart(_) => ParsedOutput {
            lines: vec![summary_line("", "Compaction: running", LogKind::Compaction)],
            compaction_started: true,
            ..ParsedOutput::empty()
        },
        AgentEvent::CompactionComplete(event) => {
            let compacted = event.compacted;
            let status = if compacted { "completed" } else { "skipped" };
            ParsedOutput {
                lines: vec![summary_line(
                    "",
                    format!("Compaction: {status} (compacted={compacted})"),
                    LogKind::Compaction,
                )],
                compaction_completed: true,
                ..ParsedOutput::empty()
            }
        }
        AgentEvent::ToolCall(event) => {
            let tool = event.tool.as_str();
            // Completion text is rendered by the authoritative final event.
            if tool == "done" {
                return ParsedOutput::empty();
            }
            let args = Value::Object(event.args);
            if tool == "tui_show_progress" {
                return ParsedOutput {
                    replay_progress: replayed.then(|| ReplayProgressEvent::Call {
                        run_id: run_id.to_string(),
                        tool_call_id: event.tool_call_id.clone(),
                        args,
                    }),
                    ..ParsedOutput::empty()
                };
            }
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
            ParsedOutput {
                lines: vec![LogLine::new_with_spans(spans)],
                tool_call_start_id: Some(event.tool_call_id),
                ..ParsedOutput::empty()
            }
        }
        AgentEvent::ToolResult(event) => {
            let tool = event.tool.as_str();
            let content = event.result.as_str();
            let is_error = event.is_error.unwrap_or(false);
            let is_error_result = is_error || looks_like_error(tool, content, is_error);
            let replay_progress =
                (tool == "tui_show_progress" && replayed).then(|| ReplayProgressEvent::Result {
                    run_id: run_id.to_string(),
                    tool_call_id: event.tool_call_id.clone(),
                    is_error: is_error_result,
                });
            if matches!(tool, "tui_show_progress" | "done") && !is_error_result {
                return ParsedOutput {
                    replay_progress,
                    ..ParsedOutput::empty()
                };
            }
            let mut rendered = tool_result_lines(tool, content, is_error);
            let mut lines = rendered.lines;
            let fallback_summary = lines
                .first()
                .cloned()
                .unwrap_or_else(|| LogLine::new(LogKind::ToolResult, ""));
            let tool_call_result = ToolCallResultUpdate {
                tool_call_id: event.tool_call_id.clone(),
                tool: tool.to_string(),
                is_error: is_error_result,
                preserve_call_summary: shell::preserve_denied_call_summary(tool, content),
                fallback_summary,
                edit_diff_fingerprint: rendered.edit_diff_fingerprint.take(),
            };
            if !lines.is_empty() {
                lines.remove(0);
            }
            ParsedOutput {
                lines,
                tool_call_result: Some(tool_call_result),
                replay_progress,
                ..ParsedOutput::empty()
            }
        }
        AgentEvent::Final(event) => ParsedOutput {
            lines: render_body(&event.content, false),
            final_text: Some(event.content),
            canonical_run_id: canonical_run_id(replayed, run_id),
            ..ParsedOutput::empty()
        },
        AgentEvent::SteerApplied(event) => {
            // The steer renderer reads content parts as JSON (Phase 3 moves it
            // to the typed parts).
            let content = serde_json::to_value(&event.content).ok();
            ParsedOutput {
                lines: crate::app::util::user_message::steer_message_lines(content.as_ref()),
                applied_steer_id: (!replayed).then_some(event.steer_id),
                ..ParsedOutput::empty()
            }
        }
        AgentEvent::HiddenUserMessage(event) => {
            if let Some(lines) = subagents::incoming_message_lines(&event.content) {
                return ParsedOutput {
                    lines,
                    ..ParsedOutput::empty()
                };
            }
            ParsedOutput {
                lines: vec![LogLine::new(LogKind::User, format!("> {}", event.content))],
                ..ParsedOutput::empty()
            }
        }
        AgentEvent::Unknown(raw) => {
            let event_type = raw.get("type").and_then(Value::as_str).unwrap_or("event");
            ParsedOutput {
                lines: vec![LogLine::new(
                    LogKind::Runtime,
                    format!("event: {event_type}"),
                )],
                ..ParsedOutput::empty()
            }
        }
    }
}

fn stream_delta(
    run_id: &str,
    replayed: bool,
    stream_id: &str,
    index: i64,
    content: String,
    reasoning: bool,
) -> ParsedOutput {
    use crate::app::state::stream_preview::StreamUpdate;
    let Ok(index) = u64::try_from(index) else {
        return ParsedOutput::empty();
    };
    if replayed || run_id.is_empty() || stream_id.is_empty() {
        return ParsedOutput::empty();
    }
    ParsedOutput {
        stream_update: Some(StreamUpdate::Append {
            run_id: run_id.to_string(),
            stream_id: stream_id.to_string(),
            index,
            reasoning,
            content,
        }),
        ..ParsedOutput::empty()
    }
}

pub(super) fn run_metrics_output(notify: RunMetricsNotify) -> ParsedOutput {
    ParsedOutput {
        llm_metrics: Some(LlmMetricsUpdate {
            run_id: notify.run_id,
            output_tokens_per_second: notify
                .output_tokens_per_second
                .filter(|value| value.is_finite() && *value >= 0.0),
        }),
        ..ParsedOutput::empty()
    }
}

pub(super) fn run_status_output(notify: RunStatusNotify) -> ParsedOutput {
    let status = notify.status.as_str();
    let message = notify.message.as_deref().unwrap_or("");
    let run_id = Some(notify.run_id.clone());
    let unconsumed_steer_ids = notify.unconsumed_steer_ids.clone().unwrap_or_default();
    let is_error_status = status == "error";
    if is_error_status {
        if let Some(error) = &notify.error {
            return ParsedOutput {
                run_error: Some(errors::run_error(error, message)),
                status: Some(status.to_string()),
                status_run_id: run_id,
                unconsumed_steer_ids,
                ..ParsedOutput::empty()
            };
        }
    }
    let summary_kind = if is_error_status {
        LogKind::Error
    } else {
        LogKind::Runtime
    };
    let detail_kind = if is_error_status {
        LogKind::Error
    } else {
        LogKind::Status
    };
    let lines = if message.is_empty() {
        vec![LogLine::new(
            summary_kind,
            format!("runtime status: {status}"),
        )]
    } else {
        summary_and_detail_line(
            "",
            &format!("runtime status: {status} -"),
            message,
            summary_kind,
            detail_kind,
        )
    };
    ParsedOutput {
        lines,
        status: Some(status.to_string()),
        status_run_id: run_id,
        unconsumed_steer_ids,
        ..ParsedOutput::empty()
    }
}

pub(super) fn client_tool_call_output(
    id: String,
    params: ClientToolCallRequestParams,
) -> ParsedOutput {
    ParsedOutput {
        client_tool_request: Some(ClientToolRequest {
            id,
            name: params.name,
            arguments: params.arguments.map(Value::Object).unwrap_or(Value::Null),
        }),
        ..ParsedOutput::empty()
    }
}

pub(super) fn client_tool_cancel_output(params: ClientToolCancelParams) -> ParsedOutput {
    ParsedOutput {
        client_tool_cancel: Some(ClientToolCancel {
            request_id: params.request_id,
            reason: params.reason.as_str().to_owned(),
        }),
        ..ParsedOutput::empty()
    }
}
