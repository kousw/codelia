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
    is_replayed_event, shell, subagents, summary_line, AgentMsg, ClientToolCancel, ClientToolMsg,
    ClientToolRequest, CompactionPhase, LlmMetricsUpdate, PermissionPreviewUpdate,
    PermissionReadyUpdate, ReplayProgressEvent, RunControlMsg, RuntimeMsg, ToolCallResultUpdate,
};
use crate::app::state::{LogKind, LogLine, LogSpan, LogTone};
use crate::app::transcript::render_body;
use crate::protocol::{
    AgentEvent, AgentEventNotify, ClientToolCallRequestParams, ClientToolCancelParams,
    LlmStatusEvent, RunMetricsNotify, RunStatusNotify,
};
use serde_json::Value;

/// A replayed `agent.event` that fails strict decoding. Saved logs from the
/// same contract always decode; this covers damaged or foreign logs.
pub(super) fn unreadable_history_event_output(event_type: Option<&str>) -> RuntimeMsg {
    let kind: String = event_type
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
    RuntimeMsg::LogLines(vec![LogLine::new(
        LogKind::Status,
        format!("Skipped a saved history event (`{kind}`) that this version cannot read."),
    )])
}

fn canonical_run_id(replayed: bool, run_id: &str) -> Option<String> {
    (!replayed && !run_id.is_empty()).then(|| run_id.to_string())
}

pub(super) fn agent_event_output(
    notify: AgentEventNotify,
    history_pending: bool,
    active_run_id: Option<&str>,
) -> RuntimeMsg {
    let run_id = notify.run_id.as_str();
    let replayed = is_replayed_event(
        notify.meta.as_ref().and_then(|meta| meta.replayed),
        Some(run_id),
        history_pending,
        active_run_id,
    );
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
            RuntimeMsg::Agent(AgentMsg::PermissionPreview {
                lines: permission_preview_lines(
                    &event.tool,
                    event.diff.as_deref(),
                    event.summary.as_deref(),
                    truncated,
                    event.file_path.as_deref(),
                    event.language.as_deref(),
                ),
                update: event.tool_call_id.map(|id| PermissionPreviewUpdate {
                    tool_call_id: id,
                    has_diff: diff_fingerprint.is_some(),
                    truncated,
                    diff_fingerprint,
                }),
            })
        }
        AgentEvent::PermissionReady(event) => RuntimeMsg::Agent(AgentMsg::PermissionReady {
            lines: permission_preflight_ready_lines(&event.tool),
            update: event
                .tool_call_id
                .map(|id| PermissionReadyUpdate { tool_call_id: id }),
        }),
        AgentEvent::Text(event) => {
            if is_legacy_permission_raw_args_message(&event.content) {
                return RuntimeMsg::Ignored;
            }
            RuntimeMsg::Agent(AgentMsg::Text {
                lines: render_body(&event.content, false),
                content: event.content,
                canonical_run_id: canonical_run_id(replayed, run_id),
            })
        }
        AgentEvent::Reasoning(event) => {
            if event.content.trim().is_empty() {
                return RuntimeMsg::Ignored;
            }
            RuntimeMsg::Agent(AgentMsg::Reasoning {
                lines: render_body(&event.content, true),
                content: event.content,
                canonical_run_id: canonical_run_id(replayed, run_id),
            })
        }
        AgentEvent::LlmStatus(status) => {
            // Providers and verification kinds this client does not know are
            // ignored.
            use crate::protocol::{
                LlmStatusBufferingEventProvider as BufferingProvider,
                LlmStatusVerificationEventProvider as VerificationProvider,
                LlmStatusVerificationEventVerification as Verification,
            };
            let message = match status {
                LlmStatusEvent::Verification(event)
                    if event.provider == VerificationProvider::Openai
                        && event.verification == Verification::TrustedAccessForCyber =>
                {
                    "OpenAI recommends Trusted Access for Cyber verification in your ChatGPT account."
                }
                LlmStatusEvent::Buffering(event)
                    if event.provider == BufferingProvider::Openai && event.active =>
                {
                    "OpenAI: additional checks in progress; waiting for the response."
                }
                _ => return RuntimeMsg::Ignored,
            };
            RuntimeMsg::LogLines(vec![summary_line("", message, LogKind::Status)])
        }
        AgentEvent::LlmRetry(event) => {
            let delay_ms = event.delay_ms.max(0.0) as u64;
            let delay = if delay_ms < 1000 {
                format!("{delay_ms}ms")
            } else {
                format!("{}s", delay_ms.div_ceil(1000))
            };
            let lines = vec![summary_line(
                "",
                format!(
                    "LLM retry: {} {} in {delay} ({}/{})",
                    event.provider,
                    event.failure_kind.as_str(),
                    event.next_attempt,
                    event.max_attempts
                ),
                LogKind::Status,
            )];
            if replayed {
                RuntimeMsg::LogLines(lines)
            } else {
                RuntimeMsg::Agent(AgentMsg::StreamReset {
                    lines,
                    run_id: canonical_run_id(replayed, run_id),
                })
            }
        }
        AgentEvent::StepStart(_) | AgentEvent::StepComplete(_) => RuntimeMsg::Ignored,
        AgentEvent::CompactionStart(_) => RuntimeMsg::Agent(AgentMsg::Compaction {
            lines: vec![summary_line("", "Compaction: running", LogKind::Compaction)],
            phase: CompactionPhase::Started,
        }),
        AgentEvent::CompactionComplete(event) => {
            let compacted = event.compacted;
            let status = if compacted { "completed" } else { "skipped" };
            RuntimeMsg::Agent(AgentMsg::Compaction {
                lines: vec![summary_line(
                    "",
                    format!("Compaction: {status} (compacted={compacted})"),
                    LogKind::Compaction,
                )],
                phase: CompactionPhase::Completed,
            })
        }
        AgentEvent::ToolCall(event) => {
            let tool = event.tool.as_str();
            // Completion text is rendered by the authoritative final event.
            if tool == "done" {
                return RuntimeMsg::Ignored;
            }
            let args = Value::Object(event.args);
            if tool == "tui_show_progress" {
                return replay_progress_output(replayed.then(|| ReplayProgressEvent::Call {
                    run_id: run_id.to_string(),
                    tool_call_id: event.tool_call_id,
                    args,
                }));
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
            RuntimeMsg::Agent(AgentMsg::ToolCallStart {
                lines: vec![LogLine::new_with_spans(spans)],
                tool_call_id: event.tool_call_id,
            })
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
                return replay_progress_output(replay_progress);
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
            RuntimeMsg::Agent(AgentMsg::ToolCallResult {
                lines,
                update: tool_call_result,
                replay_progress,
            })
        }
        AgentEvent::Final(event) => RuntimeMsg::Agent(AgentMsg::Final {
            lines: render_body(&event.content, false),
            content: event.content,
            canonical_run_id: canonical_run_id(replayed, run_id),
        }),
        AgentEvent::SteerApplied(event) => {
            // The renderer takes JSON derived from the decoded content.
            let content = serde_json::to_value(&event.content).ok();
            let lines = crate::app::state::log::steer_message_lines(content.as_ref());
            if replayed {
                RuntimeMsg::LogLines(lines)
            } else {
                RuntimeMsg::Agent(AgentMsg::SteerApplied {
                    steer_id: event.steer_id,
                    client_id: event.client_steer_id,
                    run_id: notify.run_id,
                    lines,
                })
            }
        }
        AgentEvent::HiddenUserMessage(event) => {
            if let Some(lines) = subagents::incoming_message_lines(&event.content) {
                return RuntimeMsg::LogLines(lines);
            }
            RuntimeMsg::LogLines(vec![LogLine::new(
                LogKind::User,
                format!("> {}", event.content),
            )])
        }
        AgentEvent::Unknown(raw) => {
            let event_type = raw.get("type").and_then(Value::as_str).unwrap_or("event");
            RuntimeMsg::LogLines(vec![LogLine::new(
                LogKind::Runtime,
                format!("event: {event_type}"),
            )])
        }
    }
}

fn replay_progress_output(event: Option<ReplayProgressEvent>) -> RuntimeMsg {
    match event {
        Some(event) => RuntimeMsg::Agent(AgentMsg::ReplayProgress(event)),
        None => RuntimeMsg::Ignored,
    }
}

fn stream_delta(
    run_id: &str,
    replayed: bool,
    stream_id: &str,
    index: i64,
    content: String,
    reasoning: bool,
) -> RuntimeMsg {
    use crate::app::state::stream_preview::StreamUpdate;
    let Ok(index) = u64::try_from(index) else {
        return RuntimeMsg::Ignored;
    };
    if replayed || run_id.is_empty() || stream_id.is_empty() {
        return RuntimeMsg::Ignored;
    }
    RuntimeMsg::Agent(AgentMsg::StreamDelta(StreamUpdate::Append {
        run_id: run_id.to_string(),
        stream_id: stream_id.to_string(),
        index,
        reasoning,
        content,
    }))
}

pub(super) fn run_metrics_output(notify: RunMetricsNotify) -> RuntimeMsg {
    RuntimeMsg::RunControl(RunControlMsg::Metrics(LlmMetricsUpdate {
        run_id: notify.run_id,
        output_tokens_per_second: notify
            .output_tokens_per_second
            .filter(|value| value.is_finite() && *value >= 0.0),
    }))
}

pub(super) fn run_status_output(notify: RunStatusNotify) -> RuntimeMsg {
    let status = notify.status.as_str();
    let message = notify.message.as_deref().unwrap_or("");
    let run_id = Some(notify.run_id.clone());
    let unconsumed_steer_ids = notify.unconsumed_steer_ids.unwrap_or_default();
    let unconsumed_client_steer_ids = notify.unconsumed_client_steer_ids;
    let is_error_status = status == "error";
    if is_error_status {
        if let Some(error) = &notify.error {
            return RuntimeMsg::RunControl(RunControlMsg::Status {
                run_error: Some(errors::run_error(error, message)),
                status: status.to_string(),
                run_id,
                unconsumed_steer_ids,
                unconsumed_client_steer_ids,
                lines: Vec::new(),
            });
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
    RuntimeMsg::RunControl(RunControlMsg::Status {
        lines,
        status: status.to_string(),
        run_id,
        unconsumed_steer_ids,
        unconsumed_client_steer_ids,
        run_error: None,
    })
}

pub(super) fn client_tool_call_output(
    id: String,
    params: ClientToolCallRequestParams,
) -> RuntimeMsg {
    RuntimeMsg::ClientTool(ClientToolMsg::Call(ClientToolRequest {
        id,
        name: params.name,
        arguments: params.arguments.map(Value::Object).unwrap_or(Value::Null),
    }))
}

pub(super) fn client_tool_cancel_output(params: ClientToolCancelParams) -> RuntimeMsg {
    RuntimeMsg::ClientTool(ClientToolMsg::Cancel(ClientToolCancel {
        request_id: params.request_id,
        reason: params.reason.as_str().to_owned(),
    }))
}
