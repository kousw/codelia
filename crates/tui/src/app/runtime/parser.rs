use crate::app::markdown::render_markdown_lines;
use crate::app::state::{LogKind, LogLine, LogSpan, LogTone};
use serde_json::Value;

mod helpers;
mod types;

use self::helpers::{
    format_percent, format_u64_with_commas, is_legacy_permission_raw_args_message,
    looks_like_error, normalize_diff_fingerprint, parse_runtime_log_line,
    permission_preflight_ready_lines, permission_preview_lines, prefix_block, prefix_rendered,
    summarize_tool_call, summary_and_detail_line, summary_line, tool_result_lines, DETAIL_INDENT,
};
#[cfg(test)]
use self::helpers::{
    limited_edit_diff_lines_with_hint, DIFF_ADDED_MARKER_FG, DIFF_NUMBER_FG, DIFF_REMOVED_MARKER_FG,
};
pub(crate) use self::types::{
    ParsedOutput, PermissionPreviewUpdate, RpcResponse, ToolCallResultUpdate, UiConfirmRequest,
    UiPickItem, UiPickRequest, UiPromptRequest,
};

pub fn parse_runtime_output(raw: &str) -> ParsedOutput {
    let trimmed = raw.trim_end();
    if trimmed.is_empty() {
        return ParsedOutput::empty();
    }

    if let Some(line) = parse_runtime_log_line(trimmed) {
        return ParsedOutput {
            lines: vec![line],
            ..ParsedOutput::empty()
        };
    }

    if trimmed.starts_with("[runtime]") {
        return ParsedOutput {
            lines: vec![LogLine::new(LogKind::Runtime, trimmed.to_string())],
            ..ParsedOutput::empty()
        };
    }

    let parsed: Result<Value, _> = serde_json::from_str(trimmed);
    let value = match parsed {
        Ok(value) => value,
        Err(_) => {
            return ParsedOutput {
                lines: vec![LogLine::new(LogKind::Runtime, trimmed.to_string())],
                ..ParsedOutput::empty()
            };
        }
    };

    if let Some(method) = value.get("method").and_then(|m| m.as_str()) {
        if method == "ui.confirm.request" {
            let id = value
                .get("id")
                .and_then(|v| v.as_str())
                .unwrap_or("")
                .to_string();
            let params = value.get("params").and_then(|v| v.as_object());
            let title = params
                .and_then(|p| p.get("title"))
                .and_then(|v| v.as_str())
                .unwrap_or("Confirm")
                .to_string();
            let message = params
                .and_then(|p| p.get("message"))
                .and_then(|v| v.as_str())
                .unwrap_or("")
                .to_string();
            let danger_level = params
                .and_then(|p| p.get("danger_level"))
                .and_then(|v| v.as_str())
                .map(|v| v.to_string());
            let confirm_label = params
                .and_then(|p| p.get("confirm_label"))
                .and_then(|v| v.as_str())
                .map(|v| v.to_string());
            let cancel_label = params
                .and_then(|p| p.get("cancel_label"))
                .and_then(|v| v.as_str())
                .map(|v| v.to_string());
            let allow_remember = params
                .and_then(|p| p.get("allow_remember"))
                .and_then(|v| v.as_bool())
                .unwrap_or(false);
            let allow_reason = params
                .and_then(|p| p.get("allow_reason"))
                .and_then(|v| v.as_bool())
                .unwrap_or(false);
            return ParsedOutput {
                confirm_request: Some(UiConfirmRequest {
                    id,
                    title,
                    message,
                    danger_level,
                    confirm_label,
                    cancel_label,
                    allow_remember,
                    allow_reason,
                }),
                ..ParsedOutput::empty()
            };
        }

        if method == "ui.prompt.request" {
            let id = value
                .get("id")
                .and_then(|v| v.as_str())
                .unwrap_or("")
                .to_string();
            let params = value.get("params").and_then(|v| v.as_object());
            let title = params
                .and_then(|p| p.get("title"))
                .and_then(|v| v.as_str())
                .unwrap_or("Prompt")
                .to_string();
            let message = params
                .and_then(|p| p.get("message"))
                .and_then(|v| v.as_str())
                .unwrap_or("")
                .to_string();
            let default_value = params
                .and_then(|p| p.get("default_value"))
                .and_then(|v| v.as_str())
                .map(|v| v.to_string());
            let multiline = params
                .and_then(|p| p.get("multiline"))
                .and_then(|v| v.as_bool())
                .unwrap_or(false);
            let secret = params
                .and_then(|p| p.get("secret"))
                .and_then(|v| v.as_bool())
                .unwrap_or(false);
            return ParsedOutput {
                prompt_request: Some(UiPromptRequest {
                    id,
                    title,
                    message,
                    default_value,
                    multiline,
                    secret,
                }),
                ..ParsedOutput::empty()
            };
        }

        if method == "ui.pick.request" {
            let id = value
                .get("id")
                .and_then(|v| v.as_str())
                .unwrap_or("")
                .to_string();
            let params = value.get("params").and_then(|v| v.as_object());
            let title = params
                .and_then(|p| p.get("title"))
                .and_then(|v| v.as_str())
                .unwrap_or("Pick")
                .to_string();
            let items = params
                .and_then(|p| p.get("items"))
                .and_then(|v| v.as_array())
                .map(|items| {
                    items
                        .iter()
                        .filter_map(|item| item.as_object())
                        .map(|item| UiPickItem {
                            id: item
                                .get("id")
                                .and_then(|v| v.as_str())
                                .unwrap_or("")
                                .to_string(),
                            label: item
                                .get("label")
                                .and_then(|v| v.as_str())
                                .unwrap_or("")
                                .to_string(),
                            detail: item
                                .get("detail")
                                .and_then(|v| v.as_str())
                                .map(|v| v.to_string()),
                        })
                        .collect::<Vec<_>>()
                })
                .unwrap_or_default();
            let multi = params
                .and_then(|p| p.get("multi"))
                .and_then(|v| v.as_bool())
                .unwrap_or(false);
            return ParsedOutput {
                pick_request: Some(UiPickRequest {
                    id,
                    title,
                    items,
                    multi,
                }),
                ..ParsedOutput::empty()
            };
        }

        if method == "agent.event" {
            let event = &value["params"]["event"];
            let event_type = event
                .get("type")
                .and_then(|v| v.as_str())
                .unwrap_or("event");
            match event_type {
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
                    return ParsedOutput {
                        lines: permission_preflight_ready_lines(tool),
                        ..ParsedOutput::empty()
                    };
                }
                "text" => {
                    let content = event.get("content").and_then(|v| v.as_str()).unwrap_or("");
                    if is_legacy_permission_raw_args_message(content) {
                        return ParsedOutput::empty();
                    }
                    let rendered = render_markdown_lines(content);
                    let lines = if content.trim().is_empty() {
                        Vec::new()
                    } else {
                        let mut lines = vec![LogLine::new(LogKind::Space, "")];
                        let mut body = prefix_rendered(
                            DETAIL_INDENT,
                            DETAIL_INDENT,
                            rendered,
                            LogTone::Detail,
                        );
                        lines.append(&mut body);
                        lines
                    };
                    return ParsedOutput {
                        lines,
                        assistant_text: Some(content.to_string()),
                        ..ParsedOutput::empty()
                    };
                }
                "reasoning" => {
                    let content = event.get("content").and_then(|v| v.as_str()).unwrap_or("");
                    if content.trim().is_empty() {
                        return ParsedOutput::empty();
                    }
                    let mut lines = vec![LogLine::new(LogKind::Space, "")];
                    let mut body =
                        prefix_block("", "", LogKind::Reasoning, LogTone::Detail, content);
                    lines.append(&mut body);
                    return ParsedOutput {
                        lines,
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
                    let mut rendered = tool_result_lines(tool, &content, is_error);
                    let mut lines = rendered.lines;
                    let is_error_result = is_error || looks_like_error(tool, &content, is_error);
                    let fallback_summary = if let Some(line) = lines.first().cloned() {
                        line
                    } else {
                        LogLine::new(LogKind::ToolResult, "")
                    };
                    let tool_call_result = tool_call_id.map(|id| ToolCallResultUpdate {
                        tool_call_id: id,
                        tool: tool.to_string(),
                        is_error: is_error_result,
                        fallback_summary,
                        edit_diff_fingerprint: rendered.edit_diff_fingerprint.take(),
                    });
                    if tool_call_result.is_some() && !lines.is_empty() {
                        lines.remove(0);
                    }
                    return ParsedOutput {
                        lines,
                        tool_call_result,
                        ..ParsedOutput::empty()
                    };
                }
                "final" => {
                    let content = event.get("content").and_then(|v| v.as_str()).unwrap_or("");
                    let rendered = render_markdown_lines(content);
                    let lines = if content.trim().is_empty() {
                        Vec::new()
                    } else {
                        let mut lines = vec![LogLine::new(LogKind::Space, "")];
                        let mut body = prefix_rendered(
                            DETAIL_INDENT,
                            DETAIL_INDENT,
                            rendered,
                            LogTone::Detail,
                        );
                        lines.append(&mut body);
                        lines
                    };
                    return ParsedOutput {
                        lines,
                        final_text: Some(content.to_string()),
                        ..ParsedOutput::empty()
                    };
                }
                "hidden_user_message" => {
                    let content = event.get("content").and_then(|v| v.as_str()).unwrap_or("");
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

        if method == "run.context" {
            let percent = value["params"]
                .get("context_left_percent")
                .and_then(|v| v.as_u64())
                .map(|value| value.min(100) as u8);
            return ParsedOutput {
                context_left_percent: percent,
                ..ParsedOutput::empty()
            };
        }

        if method == "run.diagnostics" {
            let params = value.get("params").cloned().unwrap_or(Value::Null);
            let kind = params
                .get("kind")
                .and_then(|v| v.as_str())
                .unwrap_or("unknown");
            if kind == "llm_call" {
                let call = params.get("call").cloned().unwrap_or(Value::Null);
                let seq = call.get("seq").and_then(|v| v.as_u64()).unwrap_or(0);
                let model = call
                    .get("model")
                    .and_then(|v| v.as_str())
                    .unwrap_or("unknown");
                let provider = call.get("provider").and_then(|v| v.as_str()).unwrap_or("-");
                let latency_ms = call.get("latency_ms").and_then(|v| v.as_u64()).unwrap_or(0);
                let stop_reason = call
                    .get("stop_reason")
                    .and_then(|v| v.as_str())
                    .unwrap_or("-");
                let usage = call.get("usage").cloned().unwrap_or(Value::Null);
                let input_tokens = usage
                    .get("input_tokens")
                    .and_then(|v| v.as_u64())
                    .unwrap_or(0);
                let output_tokens = usage
                    .get("output_tokens")
                    .and_then(|v| v.as_u64())
                    .unwrap_or(0);
                let total_tokens = usage
                    .get("total_tokens")
                    .and_then(|v| v.as_u64())
                    .unwrap_or(0);
                let cache = call.get("cache").cloned().unwrap_or(Value::Null);
                let hit_state = cache
                    .get("hit_state")
                    .and_then(|v| v.as_str())
                    .unwrap_or("unknown");
                let cache_read = cache
                    .get("cache_read_tokens")
                    .and_then(|v| v.as_u64())
                    .unwrap_or(0);
                let cache_creation = cache
                    .get("cache_creation_tokens")
                    .and_then(|v| v.as_u64())
                    .unwrap_or(0);
                let cache_read_ratio = if input_tokens == 0 {
                    0.0
                } else {
                    (cache_read as f64 / input_tokens as f64) * 100.0
                };
                let label = format!("diag llm#{seq} {model}");
                let detail = format!(
                    "provider={provider} latency={}ms stop={} tok(in/out/total)={}/{}/{} cache={} read={} ({}) create={}",
                    latency_ms,
                    stop_reason,
                    format_u64_with_commas(input_tokens),
                    format_u64_with_commas(output_tokens),
                    format_u64_with_commas(total_tokens),
                    hit_state,
                    format_u64_with_commas(cache_read),
                    format_percent(cache_read_ratio),
                    format_u64_with_commas(cache_creation),
                );
                let detail = if let Some(provider_meta_summary) = call
                    .get("provider_meta_summary")
                    .and_then(|v| v.as_str())
                    .filter(|v| !v.is_empty())
                {
                    format!("{detail} meta={provider_meta_summary}")
                } else {
                    detail
                };
                return ParsedOutput {
                    lines: summary_and_detail_line(
                        "",
                        &label,
                        &detail,
                        LogKind::Status,
                        LogKind::Status,
                    ),
                    ..ParsedOutput::empty()
                };
            }
            if kind == "run_summary" {
                let summary = params.get("summary").cloned().unwrap_or(Value::Null);
                let total_calls = summary
                    .get("total_calls")
                    .and_then(|v| v.as_u64())
                    .unwrap_or(0);
                let total_input = summary
                    .get("total_input_tokens")
                    .and_then(|v| v.as_u64())
                    .unwrap_or(0);
                let total_output = summary
                    .get("total_output_tokens")
                    .and_then(|v| v.as_u64())
                    .unwrap_or(0);
                let total_tokens = summary
                    .get("total_tokens")
                    .and_then(|v| v.as_u64())
                    .unwrap_or(0);
                let total_cached = summary
                    .get("total_cached_input_tokens")
                    .and_then(|v| v.as_u64())
                    .unwrap_or(0);
                let total_cache_creation = summary
                    .get("total_cache_creation_tokens")
                    .and_then(|v| v.as_u64())
                    .unwrap_or(0);
                let cache_read_ratio = if total_input == 0 {
                    0.0
                } else {
                    (total_cached as f64 / total_input as f64) * 100.0
                };
                let by_model = summary
                    .get("by_model")
                    .and_then(|v| v.as_object())
                    .cloned()
                    .unwrap_or_default();
                let mut hit_calls = 0_u64;
                let mut miss_calls = 0_u64;
                let mut unknown_calls = 0_u64;
                for model_stats in by_model.values() {
                    let calls = model_stats
                        .get("calls")
                        .and_then(|v| v.as_u64())
                        .unwrap_or(0);
                    let cached_input_tokens = model_stats
                        .get("cached_input_tokens")
                        .and_then(|v| v.as_u64())
                        .unwrap_or(0);
                    let input_tokens = model_stats
                        .get("input_tokens")
                        .and_then(|v| v.as_u64())
                        .unwrap_or(0);
                    if calls == 0 {
                        continue;
                    }
                    if cached_input_tokens > 0 {
                        hit_calls += calls;
                    } else if input_tokens > 0 {
                        miss_calls += calls;
                    } else {
                        unknown_calls += calls;
                    }
                }
                if hit_calls + miss_calls + unknown_calls < total_calls {
                    unknown_calls += total_calls - (hit_calls + miss_calls + unknown_calls);
                }
                let label = "diag run total (cumulative)";
                let detail = format!(
                    "calls={} tok(in/out/total)={}/{}/{} cache(read/create)={}/{} ({}) calls(hit/miss/unknown)={}/{}/{}",
                    total_calls,
                    format_u64_with_commas(total_input),
                    format_u64_with_commas(total_output),
                    format_u64_with_commas(total_tokens),
                    format_u64_with_commas(total_cached),
                    format_u64_with_commas(total_cache_creation),
                    format_percent(cache_read_ratio),
                    hit_calls,
                    miss_calls,
                    unknown_calls,
                );
                return ParsedOutput {
                    lines: summary_and_detail_line(
                        "",
                        label,
                        &detail,
                        LogKind::Status,
                        LogKind::Status,
                    ),
                    ..ParsedOutput::empty()
                };
            }
            return ParsedOutput::empty();
        }

        if method == "run.status" {
            let status = value["params"]
                .get("status")
                .and_then(|v| v.as_str())
                .unwrap_or("unknown");
            let message = value["params"]
                .get("message")
                .and_then(|v| v.as_str())
                .unwrap_or("");
            let run_id = value["params"]
                .get("run_id")
                .and_then(|v| v.as_str())
                .map(|id| id.to_string());
            let is_error_status = status == "error";
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
            return ParsedOutput {
                lines,
                status: Some(status.to_string()),
                status_run_id: run_id,
                ..ParsedOutput::empty()
            };
        }
    }

    if value.get("result").is_some() && value.get("id").is_some() {
        let id = value
            .get("id")
            .and_then(|id| id.as_str())
            .unwrap_or("")
            .to_string();
        return ParsedOutput {
            rpc_response: Some(RpcResponse {
                id,
                result: value.get("result").cloned(),
                error: value.get("error").cloned(),
            }),
            ..ParsedOutput::empty()
        };
    }

    if value.get("error").is_some() && value.get("id").is_some() {
        let id = value
            .get("id")
            .and_then(|id| id.as_str())
            .unwrap_or("")
            .to_string();
        return ParsedOutput {
            rpc_response: Some(RpcResponse {
                id,
                result: None,
                error: value.get("error").cloned(),
            }),
            ..ParsedOutput::empty()
        };
    }

    ParsedOutput {
        lines: vec![LogLine::new(LogKind::Runtime, trimmed.to_string())],
        ..ParsedOutput::empty()
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn parse_runtime_output_surfaces_runtime_error_lines() {
        let parsed = parse_runtime_output("[runtime] Error: Cannot find module '@codelia/logger'");
        assert_eq!(parsed.lines.len(), 1);
        assert_eq!(parsed.lines[0].kind(), LogKind::Error);
        assert_eq!(
            parsed.lines[0].plain_text(),
            "Error: Cannot find module '@codelia/logger'"
        );
    }

    #[test]
    fn parse_runtime_output_keeps_non_error_runtime_lines_as_runtime() {
        let parsed = parse_runtime_output("[runtime] runtime started");
        assert_eq!(parsed.lines.len(), 1);
        assert_eq!(parsed.lines[0].kind(), LogKind::Runtime);
        assert_eq!(parsed.lines[0].plain_text(), "[runtime] runtime started");
    }

    #[test]
    fn parse_run_status_error_is_rendered_as_error_line() {
        let payload = json!({
            "jsonrpc": "2.0",
            "method": "run.status",
            "params": {
                "status": "error",
                "message": "400 {\"type\":\"error\",\"error\":{\"message\":\"credit too low\"}}"
            }
        })
        .to_string();

        let parsed = parse_runtime_output(&payload);
        assert_eq!(parsed.lines.len(), 1);
        assert_eq!(parsed.lines[0].kind(), LogKind::Error);
        assert!(parsed.lines[0]
            .plain_text()
            .contains("runtime status: error -"));
        assert!(parsed.lines[0].plain_text().contains("credit too low"));
    }

    #[test]
    fn parse_run_diagnostics_llm_call_as_status_line() {
        let payload = json!({
            "jsonrpc": "2.0",
            "method": "run.diagnostics",
            "params": {
                "run_id": "run-1",
                "kind": "llm_call",
                "call": {
                    "run_id": "run-1",
                    "seq": 2,
                    "provider": "openai",
                    "model": "gpt-5-mini",
                    "request_ts": "2026-02-19T12:00:00.000Z",
                    "response_ts": "2026-02-19T12:00:00.321Z",
                    "latency_ms": 321,
                    "stop_reason": "tool_use",
                    "usage": {
                        "input_tokens": 100,
                        "output_tokens": 30,
                        "total_tokens": 130,
                        "input_cached_tokens": 40,
                        "input_cache_creation_tokens": 0
                    },
                    "cache": {
                        "hit_state": "hit",
                        "cache_read_tokens": 40,
                        "cache_creation_tokens": 0
                    },
                    "provider_meta_summary": "transport=ws_mode websocket_mode=on chain_reset=true ws_input_mode=full_regenerated"
                }
            }
        })
        .to_string();
        let parsed = parse_runtime_output(&payload);
        assert_eq!(parsed.lines.len(), 1);
        assert_eq!(parsed.lines[0].kind(), LogKind::Status);
        let line = parsed.lines[0].plain_text();
        assert!(line.contains("diag llm#2 gpt-5-mini"));
        assert!(line.contains("cache=hit read=40 (40.0%) create=0"));
        assert!(line.contains("meta=transport=ws_mode websocket_mode=on"));
        assert!(line.contains("ws_input_mode=full_regenerated"));
    }

    #[test]
    fn parse_run_diagnostics_summary_as_status_line() {
        let payload = json!({
            "jsonrpc": "2.0",
            "method": "run.diagnostics",
            "params": {
                "run_id": "run-1",
                "kind": "run_summary",
                "summary": {
                    "total_calls": 3,
                    "total_tokens": 300,
                    "total_input_tokens": 210,
                    "total_output_tokens": 90,
                    "total_cached_input_tokens": 50,
                    "total_cache_creation_tokens": 10,
                    "by_model": {}
                }
            }
        })
        .to_string();
        let parsed = parse_runtime_output(&payload);
        assert_eq!(parsed.lines.len(), 1);
        assert_eq!(parsed.lines[0].kind(), LogKind::Status);
        let line = parsed.lines[0].plain_text();
        assert!(line.contains("diag run total (cumulative)"));
        assert!(line.contains("calls=3"));
        assert!(line.contains("cache(read/create)=50/10 (23.8%)"));
        assert!(line.contains("calls(hit/miss/unknown)=0/0/3"));
    }

    #[test]
    fn parse_compaction_start_event_as_running_line() {
        let payload = json!({
            "jsonrpc": "2.0",
            "method": "agent.event",
            "params": {
                "event": {
                    "type": "compaction_start",
                    "timestamp": 123
                }
            }
        })
        .to_string();
        let parsed = parse_runtime_output(&payload);
        assert_eq!(parsed.lines.len(), 1);
        assert_eq!(parsed.lines[0].kind(), LogKind::Compaction);
        assert_eq!(parsed.lines[0].plain_text(), "Compaction: running");
        assert!(parsed.compaction_started);
        assert!(!parsed.compaction_completed);
    }

    #[test]
    fn parse_compaction_complete_event_as_compaction_line() {
        let payload_completed = json!({
            "jsonrpc": "2.0",
            "method": "agent.event",
            "params": {
                "event": {
                    "type": "compaction_complete",
                    "timestamp": 124,
                    "compacted": true
                }
            }
        })
        .to_string();
        let parsed_completed = parse_runtime_output(&payload_completed);
        assert_eq!(parsed_completed.lines.len(), 1);
        assert_eq!(parsed_completed.lines[0].kind(), LogKind::Compaction);
        assert_eq!(
            parsed_completed.lines[0].plain_text(),
            "Compaction: completed (compacted=true)"
        );
        assert!(!parsed_completed.compaction_started);
        assert!(parsed_completed.compaction_completed);

        let payload_skipped = json!({
            "jsonrpc": "2.0",
            "method": "agent.event",
            "params": {
                "event": {
                    "type": "compaction_complete",
                    "timestamp": 125,
                    "compacted": false
                }
            }
        })
        .to_string();
        let parsed_skipped = parse_runtime_output(&payload_skipped);
        assert_eq!(parsed_skipped.lines.len(), 1);
        assert_eq!(parsed_skipped.lines[0].kind(), LogKind::Compaction);
        assert_eq!(
            parsed_skipped.lines[0].plain_text(),
            "Compaction: skipped (compacted=false)"
        );
        assert!(!parsed_skipped.compaction_started);
        assert!(parsed_skipped.compaction_completed);
    }

    #[test]
    fn lane_create_tool_call_is_summarized_without_seed_body() {
        let payload = json!({
            "jsonrpc": "2.0",
            "method": "agent.event",
            "params": {
                "event": {
                    "type": "tool_call",
                    "tool": "lane_create",
                    "tool_call_id": "tool-1",
                    "args": {
                        "task_id": "tui-diff-display-enhancement",
                        "mux_backend": "tmux",
                        "seed_context": "Very long initial text that should not be displayed in full"
                    }
                }
            }
        })
        .to_string();
        let parsed = parse_runtime_output(&payload);
        assert_eq!(parsed.lines.len(), 1);
        let line = parsed.lines[0].plain_text();
        assert!(line.contains("LaneCreate:"));
        assert!(line.contains("task=tui-diff-display-enhancement"));
        assert!(line.contains("+seed"));
        assert!(!line.contains("Very long initial text"));
    }

    #[test]
    fn web_search_tool_call_is_rendered_as_compact_summary() {
        let payload = json!({
            "jsonrpc": "2.0",
            "method": "agent.event",
            "params": {
                "event": {
                    "type": "tool_call",
                    "tool": "web_search",
                    "tool_call_id": "ws-1",
                    "args": {
                        "queries": ["latest ai news", "openai"],
                        "sources_count": 9
                    }
                }
            }
        })
        .to_string();
        let parsed = parse_runtime_output(&payload);
        assert_eq!(parsed.lines.len(), 1);
        assert_eq!(
            parsed.lines[0].plain_text(),
            "WebSearch: latest ai news | openai"
        );
        assert_eq!(parsed.tool_call_start_id.as_deref(), Some("ws-1"));
    }

    #[test]
    fn todo_patch_tool_call_is_rendered_as_compact_summary() {
        let payload = json!({
            "jsonrpc": "2.0",
            "method": "agent.event",
            "params": {
                "event": {
                    "type": "tool_call",
                    "tool": "todo_patch",
                    "tool_call_id": "todo-c-1",
                    "args": {
                        "updates": [
                            {
                                "id": "scope-design",
                                "notes": "Very long detail that should not be rendered inline",
                            }
                        ]
                    }
                }
            }
        })
        .to_string();
        let parsed = parse_runtime_output(&payload);
        assert_eq!(parsed.lines.len(), 1);
        let line = parsed.lines[0].plain_text();
        assert_eq!(line, "TODO: Patch 1 task(s)");
        assert!(!line.contains("scope-design"));
        assert!(!line.contains("notes"));
        assert_eq!(parsed.tool_call_start_id.as_deref(), Some("todo-c-1"));
    }

    #[test]
    fn todo_read_tool_call_is_rendered_as_compact_summary() {
        let payload = json!({
            "jsonrpc": "2.0",
            "method": "agent.event",
            "params": {
                "event": {
                    "type": "tool_call",
                    "tool": "todo_read",
                    "tool_call_id": "todo-read-c-1",
                    "args": {}
                }
            }
        })
        .to_string();
        let parsed = parse_runtime_output(&payload);
        assert_eq!(parsed.lines.len(), 1);
        assert_eq!(parsed.lines[0].plain_text(), "TODO: Read plan");
        assert_eq!(parsed.tool_call_start_id.as_deref(), Some("todo-read-c-1"));
    }

    #[test]
    fn agents_resolve_tool_call_is_rendered_as_compact_summary() {
        let cwd = std::env::current_dir().expect("cwd");
        let target = cwd.join("packages/runtime/src/rpc/history.ts");
        let payload = json!({
            "jsonrpc": "2.0",
            "method": "agent.event",
            "params": {
                "event": {
                    "type": "tool_call",
                    "tool": "agents_resolve",
                    "tool_call_id": "agents-call-1",
                    "args": {
                        "path": target.to_string_lossy()
                    }
                }
            }
        })
        .to_string();

        let parsed = parse_runtime_output(&payload);
        assert_eq!(parsed.lines.len(), 1);
        assert_eq!(
            parsed.lines[0].plain_text(),
            "AgentsResolve: packages/runtime/src/rpc/history.ts"
        );
        assert_eq!(parsed.tool_call_start_id.as_deref(), Some("agents-call-1"));
    }

    #[test]
    fn todo_split_tool_calls_report_action_specific_modes() {
        let new_payload = json!({
            "jsonrpc": "2.0",
            "method": "agent.event",
            "params": {
                "event": {
                    "type": "tool_call",
                    "tool": "todo_new",
                    "tool_call_id": "todo-c-2",
                    "args": {
                        "todos": [{"id": "a"}, {"id": "b"}]
                    }
                }
            }
        })
        .to_string();
        let parsed_new = parse_runtime_output(&new_payload);
        assert_eq!(parsed_new.lines.len(), 1);
        assert_eq!(parsed_new.lines[0].plain_text(), "TODO: Set 2 task(s)");

        let append_payload = json!({
            "jsonrpc": "2.0",
            "method": "agent.event",
            "params": {
                "event": {
                    "type": "tool_call",
                    "tool": "todo_append",
                    "tool_call_id": "todo-c-append",
                    "args": {
                        "todos": [{"id": "c"}]
                    }
                }
            }
        })
        .to_string();
        let parsed_append = parse_runtime_output(&append_payload);
        assert_eq!(parsed_append.lines.len(), 1);
        assert_eq!(
            parsed_append.lines[0].plain_text(),
            "TODO: Append 1 task(s)"
        );

        let clear_payload = json!({
            "jsonrpc": "2.0",
            "method": "agent.event",
            "params": {
                "event": {
                    "type": "tool_call",
                    "tool": "todo_clear",
                    "tool_call_id": "todo-c-3",
                    "args": {}
                }
            }
        })
        .to_string();
        let parsed_clear = parse_runtime_output(&clear_payload);
        assert_eq!(parsed_clear.lines.len(), 1);
        assert_eq!(parsed_clear.lines[0].plain_text(), "TODO: Clear tasks");
    }

    #[test]
    fn web_search_tool_result_uses_single_summary_line() {
        let payload = json!({
            "jsonrpc": "2.0",
            "method": "agent.event",
            "params": {
                "event": {
                    "type": "tool_result",
                    "tool": "web_search",
                    "tool_call_id": "ws-1",
                    "is_error": false,
                    "result": "WebSearch status=completed | queries=latest ai news | openai | sources=9"
                }
            }
        })
        .to_string();
        let parsed = parse_runtime_output(&payload);
        assert!(parsed.lines.is_empty());
        let update = parsed.tool_call_result.expect("tool result update");
        assert_eq!(update.tool_call_id, "ws-1");
        assert_eq!(
            update.fallback_summary.plain_text(),
            "✔ WebSearch: latest ai news | openai"
        );
    }

    #[test]
    fn lane_create_tool_result_shows_compact_hints() {
        let payload = json!({
            "jsonrpc": "2.0",
            "method": "agent.event",
            "params": {
                "event": {
                    "type": "tool_result",
                    "tool": "lane_create",
                    "tool_call_id": "tool-1",
                    "is_error": false,
                    "result": {
                        "ok": true,
                        "lane": {
                            "lane_id": "bf5735ae-58c9-4a7e-af6f-25f7f97e1b7e",
                            "task_id": "tui-diff-display-enhancement",
                            "state": "running",
                            "worktree_path": "/home/user/project/.codelia/worktrees/tui-diff-display-enhancement-bf5735ae"
                        },
                        "hints": {
                            "attach_command": "tmux attach -t 'codelia-lane-bf5735ae'"
                        }
                    }
                }
            }
        })
        .to_string();
        let parsed = parse_runtime_output(&payload);
        assert!(parsed.tool_call_result.is_some());
        let texts = parsed
            .lines
            .iter()
            .map(LogLine::plain_text)
            .collect::<Vec<_>>();
        assert!(texts.iter().any(|line| line.contains("lane: bf5735ae")));
        assert!(texts
            .iter()
            .any(|line| line.contains("task: tui-diff-display-enhancement")));
        assert!(texts.iter().any(|line| line.contains("state: running")));
        assert!(texts
            .iter()
            .any(|line| line.contains("attach: tmux attach -t")));
        assert!(!texts.iter().any(|line| line.contains("\"ok\":true")));
    }

    #[test]
    fn agents_resolve_tool_result_shows_compact_summary_and_details() {
        let cwd = std::env::current_dir().expect("cwd");
        let target = cwd.join("packages/runtime/src/rpc/history.ts");
        let agents_file = cwd.join("packages/runtime/AGENTS.md");
        let payload = json!({
            "jsonrpc": "2.0",
            "method": "agent.event",
            "params": {
                "event": {
                    "type": "tool_result",
                    "tool": "agents_resolve",
                    "tool_call_id": "agents-result-1",
                    "is_error": false,
                    "result": {
                        "target_path": target.to_string_lossy(),
                        "resolved_path": target.to_string_lossy(),
                        "count": 1,
                        "files": [
                            {
                                "path": agents_file.to_string_lossy(),
                                "mtime_ms": 1772638723215u64,
                                "size_bytes": 15813u64,
                                "reason": "new"
                            }
                        ]
                    }
                }
            }
        })
        .to_string();

        let parsed = parse_runtime_output(&payload);
        let update = parsed.tool_call_result.expect("tool result update");
        assert_eq!(update.tool_call_id, "agents-result-1");
        assert_eq!(
            update.fallback_summary.plain_text(),
            "✔ AgentsResolve: 1 file(s)"
        );

        let texts = parsed
            .lines
            .iter()
            .map(LogLine::plain_text)
            .collect::<Vec<_>>();
        assert!(texts
            .iter()
            .any(|line| line.contains("target: packages/runtime/src/rpc/history.ts")));
        assert!(texts
            .iter()
            .any(|line| line.contains("AGENTS: packages/runtime/AGENTS.md (new)")));
        assert!(!texts.iter().any(|line| line.contains("\"mtime_ms\"")));
    }

    #[test]
    fn todo_patch_tool_result_surfaces_task_list_when_available() {
        let payload = json!({
            "jsonrpc": "2.0",
            "method": "agent.event",
            "params": {
                "event": {
                    "type": "tool_result",
                    "tool": "todo_patch",
                    "tool_call_id": "todo-w-1",
                    "is_error": false,
                    "result": "Updated todos (patch): 2 pending, 1 in progress, 0 completed. Next: [plan].\nTodo plan:\n1. [>] [plan] (p1) Planning\n2. [ ] [test] (p2) Add tests\nSummary: 1 pending, 1 in progress, 0 completed\nNext: [plan]"
                }
            }
        })
        .to_string();
        let parsed = parse_runtime_output(&payload);
        let update = parsed.tool_call_result.expect("tool result update");
        assert_eq!(update.tool_call_id, "todo-w-1");
        assert!(update
            .fallback_summary
            .plain_text()
            .contains("TODO: Updated 2 pending, 1 in progress, 0 completed"));
        assert!(parsed
            .lines
            .iter()
            .any(|line| line.plain_text().contains("1. [>] [plan]")));
        assert!(parsed
            .lines
            .iter()
            .all(|line| !line.plain_text().contains("note:")));
    }

    #[test]
    fn todo_read_tool_result_surfaces_task_list_without_notes() {
        let payload = json!({
            "jsonrpc": "2.0",
            "method": "agent.event",
            "params": {
                "event": {
                    "type": "tool_result",
                    "tool": "todo_read",
                    "tool_call_id": "todo-r-1",
                    "is_error": false,
                    "result": "Todo plan:\n1. [>] [plan] (p1) Planning\n   note: currently executing\n2. [ ] [test] (p2) Add tests\n3. [x] [ship] (p3) Ship\nSummary: 1 pending, 1 in progress, 1 completed\nNext: [plan]"
                }
            }
        })
        .to_string();
        let parsed = parse_runtime_output(&payload);
        let update = parsed.tool_call_result.expect("tool result update");
        assert_eq!(update.tool_call_id, "todo-r-1");
        assert!(update
            .fallback_summary
            .plain_text()
            .contains("TODO: 1 pending, 1 in progress, 1 completed"));

        let in_progress_line = parsed
            .lines
            .iter()
            .find(|line| line.plain_text().contains("1. [>] [plan]"))
            .expect("in-progress todo line");
        assert_eq!(in_progress_line.kind(), LogKind::TodoInProgress);

        let completed_line = parsed
            .lines
            .iter()
            .find(|line| line.plain_text().contains("3. [x] [ship]"))
            .expect("completed todo line");
        assert_eq!(completed_line.kind(), LogKind::TodoCompleted);

        assert!(parsed
            .lines
            .iter()
            .any(|line| line.plain_text().contains("Next: [plan]")));
        assert!(parsed
            .lines
            .iter()
            .all(|line| !line.plain_text().contains("note: currently executing")));
    }

    #[test]
    fn todo_patch_failed_text_is_classified_as_error() {
        let payload = json!({
            "jsonrpc": "2.0",
            "method": "agent.event",
            "params": {
                "event": {
                    "type": "tool_result",
                    "tool": "todo_patch",
                    "tool_call_id": "todo-w-err-1",
                    "is_error": false,
                    "result": "Patch failed: unknown todo id(s): missing-task"
                }
            }
        })
        .to_string();

        let parsed = parse_runtime_output(&payload);
        let update = parsed.tool_call_result.expect("tool result update");
        assert!(update.is_error);
        assert_eq!(update.tool_call_id, "todo-w-err-1");
        assert!(update
            .fallback_summary
            .plain_text()
            .contains("TODO: Patch failed - unknown todo id(s): missing-task"));
        assert!(parsed.lines.is_empty());
    }

    #[test]
    fn todo_patch_validation_failure_is_summarized_with_actionable_text() {
        let payload = json!({
            "jsonrpc": "2.0",
            "method": "agent.event",
            "params": {
                "event": {
                    "type": "tool_result",
                    "tool": "todo_patch",
                    "tool_call_id": "todo-w-err-2",
                    "is_error": false,
                    "result": "Error: Tool input validation failed for todo_patch: Unrecognized key(s) in object: 'todos'"
                }
            }
        })
        .to_string();

        let parsed = parse_runtime_output(&payload);
        let update = parsed.tool_call_result.expect("tool result update");
        assert!(update.is_error);
        assert_eq!(update.tool_call_id, "todo-w-err-2");
        assert_eq!(
            update.fallback_summary.plain_text(),
            "✖ TODO: Invalid patch request - use updates, not todos"
        );
        assert!(parsed.lines.is_empty());
    }

    #[test]
    fn todo_tool_results_hide_raw_json_payloads() {
        let payload = json!({
            "jsonrpc": "2.0",
            "method": "agent.event",
            "params": {
                "event": {
                    "type": "tool_result",
                    "tool": "todo_read",
                    "tool_call_id": "todo-r-json-1",
                    "is_error": false,
                    "result": {
                        "debug": true,
                        "items": [
                            { "id": "plan", "status": "in_progress" }
                        ]
                    }
                }
            }
        })
        .to_string();

        let parsed = parse_runtime_output(&payload);
        let update = parsed.tool_call_result.expect("tool result update");
        let summary = update.fallback_summary.plain_text();
        assert!(!summary.contains("\"debug\""));
        assert!(!summary.contains("\"items\""));
        assert!(parsed.lines.is_empty());
    }

    #[test]
    fn shell_tool_call_is_rendered_as_compact_summary() {
        let payload = json!({
            "jsonrpc": "2.0",
            "method": "agent.event",
            "params": {
                "event": {
                    "type": "tool_call",
                    "tool": "shell",
                    "tool_call_id": "shell-call-1",
                    "args": {
                        "command": "git status --short",
                        "detached_wait": true
                    }
                }
            }
        })
        .to_string();
        let parsed = parse_runtime_output(&payload);
        assert_eq!(parsed.lines.len(), 1);
        assert_eq!(
            parsed.lines[0].plain_text(),
            "Shell: git status --short (detached wait)"
        );
        assert_eq!(parsed.tool_call_start_id.as_deref(), Some("shell-call-1"));
    }

    #[test]
    fn shell_list_tool_call_is_rendered_as_compact_summary() {
        let payload = json!({
            "jsonrpc": "2.0",
            "method": "agent.event",
            "params": {
                "event": {
                    "type": "tool_call",
                    "tool": "shell_list",
                    "tool_call_id": "shell-list-call-1",
                    "args": {
                        "include_terminal": true,
                        "limit": 10,
                        "state": "cancelled"
                    }
                }
            }
        })
        .to_string();
        let parsed = parse_runtime_output(&payload);
        assert_eq!(parsed.lines.len(), 1);
        assert_eq!(
            parsed.lines[0].plain_text(),
            "ShellList: state=cancelled include_terminal=true limit=10"
        );
        assert_eq!(
            parsed.tool_call_start_id.as_deref(),
            Some("shell-list-call-1")
        );
    }

    #[test]
    fn shell_list_tool_result_is_compact_and_muted() {
        let payload = json!({
            "jsonrpc": "2.0",
            "method": "agent.event",
            "params": {
                "event": {
                    "type": "tool_result",
                    "tool": "shell_list",
                    "tool_call_id": "shell-list-result-1",
                    "is_error": false,
                    "result": {
                        "tasks": [
                            {
                                "key": "build-1234abcd",
                                "label": "build",
                                "command": "bun run typecheck",
                                "state": "running"
                            },
                            {
                                "key": "timeout-bg-97a7a185",
                                "label": "timeout-bg",
                                "command": "bash -lc 'echo timeout-start; sleep 5; echo timeout-end'",
                                "state": "failed",
                                "failure_message": "Command timed out after 2s"
                            }
                        ],
                        "returned": 2,
                        "limit": 10,
                        "state": null,
                        "include_terminal": true
                    }
                }
            }
        })
        .to_string();
        let parsed = parse_runtime_output(&payload);
        let update = parsed.tool_call_result.expect("tool result update");
        assert_eq!(update.tool_call_id, "shell-list-result-1");
        assert_eq!(
            update.fallback_summary.plain_text(),
            "ShellList: 2 task(s), running=1"
        );
        assert_eq!(update.fallback_summary.kind(), LogKind::Shell);
        let texts = parsed
            .lines
            .iter()
            .map(LogLine::plain_text)
            .collect::<Vec<_>>();
        assert_eq!(
            texts,
            vec![
                "  running | build-1234abcd | build | bun run typecheck".to_string(),
                "  failed | timeout-bg-97a7a185 | timeout-bg | bash -lc 'echo timeout-start; sleep 5; echo timeout-end'".to_string(),
            ]
        );
        assert!(parsed
            .lines
            .iter()
            .all(|line| line.kind() == LogKind::Shell));
    }

    #[test]
    fn shell_tool_result_shows_compact_summary_and_stdout_without_raw_json() {
        let payload = json!({
            "jsonrpc": "2.0",
            "method": "agent.event",
            "params": {
                "event": {
                    "type": "tool_result",
                    "tool": "shell",
                    "tool_call_id": "shell-result-1",
                    "is_error": false,
                    "result": {
                        "key": "shell-1234abcd",
                        "command": "git status --short",
                        "state": "completed",
                        "exit_code": 0,
                        "duration_ms": 12,
                        "output": " M crates/tui/src/app/runtime/parser.rs\n?? crates/tui/src/app/runtime/parser/helpers.rs"
                    }
                }
            }
        })
        .to_string();
        let parsed = parse_runtime_output(&payload);
        let update = parsed.tool_call_result.expect("tool result update");
        assert_eq!(update.tool_call_id, "shell-result-1");
        assert_eq!(
            update.fallback_summary.plain_text(),
            "✔ Shell completed - git status --short"
        );
        assert_eq!(update.fallback_summary.kind(), LogKind::Shell);
        let texts = parsed
            .lines
            .iter()
            .map(LogLine::plain_text)
            .collect::<Vec<_>>();
        assert_eq!(
            texts,
            vec![
                "  Key: shell-1234abcd".to_string(),
                "  Exit code: 0".to_string(),
                "  Duration: 12 ms".to_string(),
                "  Output:".to_string(),
                "   M crates/tui/src/app/runtime/parser.rs".to_string(),
                "  ?? crates/tui/src/app/runtime/parser/helpers.rs".to_string(),
            ]
        );
        assert!(parsed
            .lines
            .iter()
            .all(|line| line.kind() == LogKind::Shell));
    }

    #[test]
    fn shell_status_tool_result_is_compact() {
        let payload = json!({
            "jsonrpc": "2.0",
            "method": "agent.event",
            "params": {
                "event": {
                    "type": "tool_result",
                    "tool": "shell_status",
                    "tool_call_id": "shell-status-1",
                    "is_error": false,
                    "result": {
                        "key": "build-1234abcd",
                        "command": "npm run dev",
                        "state": "running"
                    }
                }
            }
        })
        .to_string();
        let parsed = parse_runtime_output(&payload);
        let update = parsed.tool_call_result.expect("tool result update");
        assert_eq!(update.tool_call_id, "shell-status-1");
        assert_eq!(
            update.fallback_summary.plain_text(),
            "✔ Shell status: running - npm run dev"
        );
        assert_eq!(update.fallback_summary.kind(), LogKind::Shell);
        let texts = parsed
            .lines
            .iter()
            .map(LogLine::plain_text)
            .collect::<Vec<_>>();
        assert_eq!(
            texts,
            vec![
                "  Key: build-1234abcd".to_string(),
                "  State: running".to_string(),
            ]
        );
    }

    #[test]
    fn shell_logs_tool_result_surfaces_body_without_json_wrapper() {
        let payload = json!({
            "jsonrpc": "2.0",
            "method": "agent.event",
            "params": {
                "event": {
                    "type": "tool_result",
                    "tool": "shell_logs",
                    "tool_call_id": "shell-logs-1",
                    "is_error": false,
                    "result": {
                        "task_id": "shell-task-3",
                        "stream": "stdout",
                        "live": false,
                        "cache_id": "cache-123",
                        "content": "line-1\nline-2"
                    }
                }
            }
        })
        .to_string();
        let parsed = parse_runtime_output(&payload);
        let update = parsed.tool_call_result.expect("tool result update");
        assert_eq!(update.tool_call_id, "shell-logs-1");
        assert_eq!(
            update.fallback_summary.plain_text(),
            "✔ Shell logs: stdout (cached)"
        );
        let texts = parsed
            .lines
            .iter()
            .map(LogLine::plain_text)
            .collect::<Vec<_>>();
        assert_eq!(texts, vec!["  line-1".to_string(), "  line-2".to_string()]);
        assert_eq!(update.fallback_summary.kind(), LogKind::Shell);
        assert!(parsed
            .lines
            .iter()
            .all(|line| line.kind() == LogKind::Shell));
    }

    #[test]
    fn shell_wait_tool_result_is_compact() {
        let payload = json!({
            "jsonrpc": "2.0",
            "method": "agent.event",
            "params": {
                "event": {
                    "type": "tool_result",
                    "tool": "shell_wait",
                    "tool_call_id": "shell-wait-1",
                    "is_error": false,
                    "result": {
                        "key": "shell-wait-1",
                        "command": "npm test",
                        "state": "completed",
                        "exit_code": 0,
                        "duration_ms": 245
                    }
                }
            }
        })
        .to_string();
        let parsed = parse_runtime_output(&payload);
        let update = parsed.tool_call_result.expect("tool result update");
        assert_eq!(update.tool_call_id, "shell-wait-1");
        assert_eq!(
            update.fallback_summary.plain_text(),
            "✔ Shell wait: completed - npm test"
        );
        assert_eq!(update.fallback_summary.kind(), LogKind::Shell);
        let texts = parsed
            .lines
            .iter()
            .map(LogLine::plain_text)
            .collect::<Vec<_>>();
        assert_eq!(
            texts,
            vec![
                "  Key: shell-wait-1".to_string(),
                "  State: completed".to_string(),
                "  Exit code: 0".to_string(),
                "  Duration: 245 ms".to_string(),
            ]
        );
    }

    #[test]
    fn shell_wait_tool_result_preserves_failed_state() {
        let payload = json!({
            "jsonrpc": "2.0",
            "method": "agent.event",
            "params": {
                "event": {
                    "type": "tool_result",
                    "tool": "shell_wait",
                    "tool_call_id": "shell-wait-fail-1",
                    "is_error": false,
                    "result": {
                        "key": "shell-wait-fail-1",
                        "command": "npm test",
                        "state": "failed",
                        "exit_code": 7
                    }
                }
            }
        })
        .to_string();
        let parsed = parse_runtime_output(&payload);
        let update = parsed.tool_call_result.expect("tool result update");
        assert_eq!(update.tool_call_id, "shell-wait-fail-1");
        assert_eq!(
            update.fallback_summary.plain_text(),
            "✔ Shell wait: failed - npm test"
        );
        let texts = parsed
            .lines
            .iter()
            .map(LogLine::plain_text)
            .collect::<Vec<_>>();
        assert_eq!(
            texts,
            vec![
                "  Key: shell-wait-fail-1".to_string(),
                "  State: failed".to_string(),
                "  Exit code: 7".to_string(),
            ]
        );
    }

    #[test]
    fn shell_wait_tool_result_marks_still_running_compactly() {
        let payload = json!({
            "jsonrpc": "2.0",
            "method": "agent.event",
            "params": {
                "event": {
                    "type": "tool_result",
                    "tool": "shell_wait",
                    "tool_call_id": "shell-wait-2",
                    "is_error": false,
                    "result": {
                        "key": "shell-wait-2",
                        "command": "npm test",
                        "state": "running",
                        "still_running": true
                    }
                }
            }
        })
        .to_string();
        let parsed = parse_runtime_output(&payload);
        let update = parsed.tool_call_result.expect("tool result update");
        assert_eq!(update.tool_call_id, "shell-wait-2");
        assert_eq!(
            update.fallback_summary.plain_text(),
            "✔ Shell wait: still running - npm test"
        );
        assert_eq!(update.fallback_summary.kind(), LogKind::Shell);
        let texts = parsed
            .lines
            .iter()
            .map(LogLine::plain_text)
            .collect::<Vec<_>>();
        assert_eq!(
            texts,
            vec![
                "  Key: shell-wait-2".to_string(),
                "  State: running".to_string(),
            ]
        );
    }

    #[test]
    fn shell_result_tool_result_surfaces_final_output_without_json_wrapper() {
        let payload = json!({
            "jsonrpc": "2.0",
            "method": "agent.event",
            "params": {
                "event": {
                    "type": "tool_result",
                    "tool": "shell_result",
                    "tool_call_id": "shell-final-1",
                    "is_error": false,
                    "result": {
                        "key": "shell-final-1",
                        "command": "npm test",
                        "state": "completed",
                        "exit_code": 0,
                        "output": "tests passed"
                    }
                }
            }
        })
        .to_string();
        let parsed = parse_runtime_output(&payload);
        let update = parsed.tool_call_result.expect("tool result update");
        assert_eq!(update.tool_call_id, "shell-final-1");
        assert_eq!(
            update.fallback_summary.plain_text(),
            "✔ Shell result: completed - npm test"
        );
        assert_eq!(update.fallback_summary.kind(), LogKind::Shell);
        let texts = parsed
            .lines
            .iter()
            .map(LogLine::plain_text)
            .collect::<Vec<_>>();
        assert_eq!(
            texts,
            vec![
                "  Key: shell-final-1".to_string(),
                "  Exit code: 0".to_string(),
                "  Output:".to_string(),
                "  tests passed".to_string(),
            ]
        );
        assert!(parsed
            .lines
            .iter()
            .all(|line| line.kind() == LogKind::Shell));
    }

    #[test]
    fn shell_result_tool_result_preserves_failed_state() {
        let payload = json!({
            "jsonrpc": "2.0",
            "method": "agent.event",
            "params": {
                "event": {
                    "type": "tool_result",
                    "tool": "shell_result",
                    "tool_call_id": "shell-final-fail-1",
                    "is_error": false,
                    "result": {
                        "key": "shell-final-fail-1",
                        "command": "npm test",
                        "state": "failed",
                        "exit_code": 7
                    }
                }
            }
        })
        .to_string();
        let parsed = parse_runtime_output(&payload);
        let update = parsed.tool_call_result.expect("tool result update");
        assert_eq!(update.tool_call_id, "shell-final-fail-1");
        assert_eq!(
            update.fallback_summary.plain_text(),
            "✔ Shell result: failed - npm test"
        );
        let texts = parsed
            .lines
            .iter()
            .map(LogLine::plain_text)
            .collect::<Vec<_>>();
        assert_eq!(
            texts,
            vec![
                "  Key: shell-final-fail-1".to_string(),
                "  Exit code: 7".to_string(),
            ]
        );
    }

    #[test]
    fn shell_result_tool_result_keeps_full_log_prefix_inside_output() {
        let payload = json!({
            "jsonrpc": "2.0",
            "method": "agent.event",
            "params": {
                "event": {
                    "type": "tool_result",
                    "tool": "shell_result",
                    "tool_call_id": "shell-final-full-log-1",
                    "is_error": false,
                    "result": {
                        "key": "shell-final-full-log-1",
                        "command": "npm test",
                        "state": "completed",
                        "exit_code": 0,
                        "output": "Full log: still command output\nnext line"
                    }
                }
            }
        })
        .to_string();
        let parsed = parse_runtime_output(&payload);
        let update = parsed.tool_call_result.expect("tool result update");
        assert_eq!(update.tool_call_id, "shell-final-full-log-1");
        let texts = parsed
            .lines
            .iter()
            .map(LogLine::plain_text)
            .collect::<Vec<_>>();
        assert_eq!(
            texts,
            vec![
                "  Key: shell-final-full-log-1".to_string(),
                "  Exit code: 0".to_string(),
                "  Output:".to_string(),
                "  Full log: still command output".to_string(),
                "  next line".to_string(),
            ]
        );
    }

    #[test]
    fn shell_result_tool_preview_uses_head_tail_truncation() {
        let stdout = (1..=12)
            .map(|idx| format!("line-{idx}"))
            .collect::<Vec<_>>()
            .join("\n");
        let payload = json!({
            "jsonrpc": "2.0",
            "method": "agent.event",
            "params": {
                "event": {
                    "type": "tool_result",
                    "tool": "shell_result",
                    "tool_call_id": "shell-final-truncated-1",
                    "is_error": false,
                    "result": {
                        "key": "shell-final-truncated-1",
                        "command": "npm test",
                        "state": "completed",
                        "exit_code": 0,
                        "output": stdout
                    }
                }
            }
        })
        .to_string();
        let parsed = parse_runtime_output(&payload);
        let update = parsed.tool_call_result.expect("tool result update");
        assert_eq!(update.tool_call_id, "shell-final-truncated-1");
        assert_eq!(update.fallback_summary.kind(), LogKind::Shell);
        let texts = parsed
            .lines
            .iter()
            .map(LogLine::plain_text)
            .collect::<Vec<_>>();
        assert_eq!(
            texts,
            vec![
                "  Key: shell-final-truncated-1".to_string(),
                "  Exit code: 0".to_string(),
                "  Output:".to_string(),
                "  line-1".to_string(),
                "  line-2".to_string(),
                "  line-3".to_string(),
                "  line-4".to_string(),
                "  ... (4 line(s) omitted) ...".to_string(),
                "  line-9".to_string(),
                "  line-10".to_string(),
                "  line-11".to_string(),
                "  line-12".to_string(),
            ]
        );
    }

    #[test]
    fn grep_tool_result_is_muted() {
        let payload = json!({
            "jsonrpc": "2.0",
            "method": "agent.event",
            "params": {
                "event": {
                    "type": "tool_result",
                    "tool": "grep",
                    "tool_call_id": "grep-result-1",
                    "is_error": false,
                    "result": "src/main.ts:1:alpha\nsrc/main.ts:2:beta"
                }
            }
        })
        .to_string();
        let parsed = parse_runtime_output(&payload);
        let update = parsed.tool_call_result.expect("tool result update");
        assert_eq!(update.tool_call_id, "grep-result-1");
        assert_eq!(update.fallback_summary.kind(), LogKind::Shell);
        assert_eq!(
            update.fallback_summary.plain_text(),
            "✔ grep src/main.ts:1:alpha"
        );
        assert!(parsed
            .lines
            .iter()
            .all(|line| line.kind() == LogKind::Shell));
    }

    #[test]
    fn shell_cancel_tool_result_is_compact() {
        let payload = json!({
            "jsonrpc": "2.0",
            "method": "agent.event",
            "params": {
                "event": {
                    "type": "tool_result",
                    "tool": "shell_cancel",
                    "tool_call_id": "shell-cancel-1",
                    "is_error": false,
                    "result": {
                        "key": "shell-cancel-1",
                        "command": "npm run dev",
                        "state": "cancelled",
                        "cancellation_reason": "cancelled"
                    }
                }
            }
        })
        .to_string();
        let parsed = parse_runtime_output(&payload);
        let update = parsed.tool_call_result.expect("tool result update");
        assert_eq!(update.tool_call_id, "shell-cancel-1");
        assert_eq!(
            update.fallback_summary.plain_text(),
            "✔ Shell cancelled - npm run dev"
        );
        assert_eq!(update.fallback_summary.kind(), LogKind::Shell);
        let texts = parsed
            .lines
            .iter()
            .map(LogLine::plain_text)
            .collect::<Vec<_>>();
        assert_eq!(
            texts,
            vec![
                "  Key: shell-cancel-1".to_string(),
                "  State: cancelled".to_string(),
                "  Cancellation: cancelled".to_string(),
            ]
        );
        assert!(parsed
            .lines
            .iter()
            .all(|line| line.kind() == LogKind::Shell));
    }

    #[test]
    fn parse_runtime_output_formats_edit_tool_result_with_diff_body() {
        let raw = r#"{"method":"agent.event","params":{"event":{"type":"tool_result","tool":"edit","result":{"summary":"updated file","diff":"--- a/demo.txt\n+++ b/demo.txt\n@@ -1,2 +1,2 @@\n-old line\n+new line\n context line"}}}}"#;
        let parsed = parse_runtime_output(raw);

        assert_eq!(parsed.lines[0].kind(), LogKind::ToolResult);
        assert!(parsed.lines[0].plain_text().contains("edit updated file"));
        assert!(parsed
            .lines
            .iter()
            .any(|line| line.plain_text().contains("- old line")));
        assert!(parsed
            .lines
            .iter()
            .any(|line| line.plain_text().contains("+ new line")));
    }

    #[test]
    fn parse_runtime_output_formats_write_tool_result_with_diff_body() {
        let raw = r#"{"method":"agent.event","params":{"event":{"type":"tool_result","tool":"write","result":{"summary":"Wrote 42 bytes to demo.txt","diff":"--- /dev/null\n+++ demo.txt\n@@ -0,0 +1,2 @@\n+hello\n+world","file_path":"demo.txt"}}}}"#;
        let parsed = parse_runtime_output(raw);

        assert_eq!(parsed.lines[0].kind(), LogKind::ToolResult);
        assert!(parsed.lines[0]
            .plain_text()
            .contains("write Wrote 42 bytes to demo.txt"));
        assert!(parsed
            .lines
            .iter()
            .any(|line| line.plain_text().contains("+ hello")));
        assert!(parsed
            .lines
            .iter()
            .any(|line| line.plain_text().contains("+ world")));
    }

    #[test]
    fn parse_runtime_output_write_diff_uses_write_specific_truncation_limit() {
        let mut diff = String::from("--- /dev/null\n+++ demo.txt\n@@ -0,0 +1,40 @@\n");
        for idx in 1..=40 {
            diff.push_str(&format!("+line {idx:02}\n"));
        }
        let raw = serde_json::json!({
            "method": "agent.event",
            "params": {
                "event": {
                    "type": "tool_result",
                    "tool": "write",
                    "result": {
                        "summary": "Wrote",
                        "diff": diff,
                        "file_path": "demo.txt"
                    }
                }
            }
        })
        .to_string();
        let parsed = parse_runtime_output(&raw);

        assert!(parsed
            .lines
            .iter()
            .any(|line| line.plain_text().contains("+ line 01")));
        assert!(parsed
            .lines
            .iter()
            .any(|line| line.plain_text().contains("+ line 40")));
        assert!(parsed
            .lines
            .iter()
            .any(|line| line.plain_text().contains("diff lines omitted")));
        assert!(!parsed.lines.iter().any(|line| line.plain_text() == "  ..."));
        assert!(!parsed
            .lines
            .iter()
            .any(|line| line.plain_text().contains("+ line 16")));
    }

    #[test]
    fn parse_runtime_output_permission_preview_tracks_tool_call_diff_metadata() {
        let raw = r#"{"method":"agent.event","params":{"event":{"type":"permission.preview","tool":"edit","tool_call_id":"tool-1","diff":"--- a/demo.txt\n+++ b/demo.txt\n@@ -1 +1 @@\n-old line\n+new line"}}}"#;
        let parsed = parse_runtime_output(raw);
        let update = parsed
            .permission_preview_update
            .expect("permission preview update");
        assert_eq!(update.tool_call_id, "tool-1");
        assert!(update.has_diff);
        assert!(!update.truncated);
        let fingerprint = update.diff_fingerprint.expect("diff fingerprint");
        assert!(fingerprint.contains("--- a/demo.txt"));
        assert!(fingerprint.contains("+new line"));
    }

    #[test]
    fn parse_runtime_output_edit_tool_result_tracks_diff_metadata_by_tool_call() {
        let raw = r#"{"method":"agent.event","params":{"event":{"type":"tool_result","tool":"edit","tool_call_id":"tool-1","result":{"summary":"updated file","diff":"--- a/demo.txt\n+++ b/demo.txt\n@@ -1 +1 @@\n-old line\n+new line"}}}}"#;
        let parsed = parse_runtime_output(raw);
        let update = parsed.tool_call_result.expect("tool result update");
        assert_eq!(update.tool_call_id, "tool-1");
        assert_eq!(update.tool, "edit");
        let fingerprint = update.edit_diff_fingerprint.expect("edit diff fingerprint");
        assert!(fingerprint.contains("--- a/demo.txt"));
        assert!(fingerprint.contains("+new line"));
        assert!(parsed
            .lines
            .iter()
            .any(|line| line.plain_text().contains("+ new line")));
    }

    #[test]
    fn parse_runtime_output_formats_structured_permission_preview_with_diff() {
        let raw = r#"{"method":"agent.event","params":{"event":{"type":"permission.preview","tool":"edit","diff":"--- a/demo.txt\n+++ b/demo.txt\n@@ -1 +1 @@\n-old line\n+new line","truncated":true}}}"#;
        let parsed = parse_runtime_output(raw);
        assert_eq!(parsed.lines[0].kind(), LogKind::Space);
        assert_eq!(parsed.lines[1].kind(), LogKind::Status);
        assert!(parsed.lines[1]
            .plain_text()
            .contains("Proposed edit changes (preview)"));
        assert_eq!(parsed.lines[2].kind(), LogKind::DiffRemoved);
        assert_eq!(parsed.lines[3].kind(), LogKind::DiffAdded);
        assert_eq!(
            parsed.lines.last().map(LogLine::plain_text),
            Some("  ...".to_string())
        );
    }

    #[test]
    fn parse_runtime_output_formats_structured_permission_preview_with_summary() {
        let raw = r#"{"method":"agent.event","params":{"event":{"type":"permission.preview","tool":"write","summary":"Preview unavailable: dry-run failed"}}}"#;
        let parsed = parse_runtime_output(raw);
        assert_eq!(parsed.lines[0].kind(), LogKind::Space);
        assert_eq!(parsed.lines[1].kind(), LogKind::Status);
        assert!(parsed.lines[1]
            .plain_text()
            .contains("Proposed write changes (preview)"));
        assert_eq!(parsed.lines[2].kind(), LogKind::DiffMeta);
        assert_eq!(
            parsed.lines[2].plain_text(),
            "  Preview unavailable: dry-run failed"
        );
    }

    #[test]
    fn parse_runtime_output_formats_structured_permission_ready_as_status_summary() {
        let raw = r#"{"method":"agent.event","params":{"event":{"type":"permission.ready","tool":"edit"}}}"#;
        let parsed = parse_runtime_output(raw);
        assert_eq!(parsed.lines[0].kind(), LogKind::Space);
        assert_eq!(parsed.lines[1].kind(), LogKind::Status);
        assert_eq!(
            parsed.lines[1].plain_text(),
            "Review edit changes, then choose Allow or Deny"
        );
    }

    #[test]
    fn parse_runtime_output_hides_legacy_permission_raw_args_text_event() {
        let raw = r#"{"method":"agent.event","params":{"event":{"type":"text","content":"Permission request raw args (lane_create):\n{\"task_id\":\"t1\"}"}}}"#;
        let parsed = parse_runtime_output(raw);
        assert!(parsed.lines.is_empty());
        assert!(parsed.assistant_text.is_none());
    }

    #[test]
    fn parse_runtime_output_preserves_code_block_syntax_spans_after_prefix() {
        let raw = r#"{"method":"agent.event","params":{"event":{"type":"text","content":"```rust\nfn main() {}\n```"}}}"#;
        let parsed = parse_runtime_output(raw);

        assert_eq!(parsed.lines.len(), 2);
        let code = &parsed.lines[1];
        assert_eq!(code.kind(), LogKind::AssistantCode);
        assert_eq!(code.spans()[0].text, "  ");
        assert!(code.spans().iter().skip(1).any(|span| span.fg.is_some()));
    }

    #[test]
    fn parse_runtime_output_preserves_typescript_fence_language_hint() {
        let raw = r#"{"method":"agent.event","params":{"event":{"type":"text","content":"```typescript\nconst value: number = 1;\n```"}}}"#;
        let parsed = parse_runtime_output(raw);

        assert_eq!(parsed.lines.len(), 2);
        let code = &parsed.lines[1];
        assert_eq!(code.kind(), LogKind::AssistantCode);
        assert_eq!(code.spans()[0].text, "  ");
        assert!(code.spans().iter().skip(1).any(|span| span.fg.is_some()));
    }

    #[test]
    fn permission_preview_diff_fenced_code_uses_code_block_background_with_diff_overlay() {
        let raw = r#"{"method":"agent.event","params":{"event":{"type":"permission.preview","tool":"write","diff":"--- a/demo.md\n+++ b/demo.md\n@@ -1,4 +1,4 @@\n ```ts\n-const value = 1;\n+const value = 2;\n ```"}}}"#;
        let parsed = parse_runtime_output(raw);

        let added_line = parsed
            .lines
            .iter()
            .find(|line| line.plain_text().contains("+ const value = 2;"))
            .expect("added diff line");
        assert_eq!(added_line.kind(), LogKind::DiffAdded);
        assert!(added_line
            .spans()
            .iter()
            .any(|span| span.kind == LogKind::DiffAdded));
    }

    #[test]
    fn permission_preview_diff_uses_file_extension_for_non_fenced_syntax_highlight() {
        let raw = r#"{"method":"agent.event","params":{"event":{"type":"permission.preview","tool":"edit","diff":"--- a/demo-write-edit.ts\n+++ b/demo-write-edit.ts\n@@ -1,2 +1,2 @@\n-const retries = 1;\n+const retries = 3;"}}}"#;
        let parsed = parse_runtime_output(raw);

        let added_line = parsed
            .lines
            .iter()
            .find(|line| line.plain_text().contains("+ const retries = 3;"))
            .expect("added ts line");
        assert_eq!(added_line.kind(), LogKind::DiffAdded);
        assert!(added_line.spans().iter().any(|span| span.fg.is_some()));
    }

    #[test]
    fn permission_preview_diff_uses_file_path_hint_when_headers_are_missing() {
        let raw = r#"{"method":"agent.event","params":{"event":{"type":"permission.preview","tool":"write","file_path":"demo-write-edit.ts","diff":"@@ -1 +1 @@\n-const retries = 1;\n+const retries = 3;"}}}"#;
        let parsed = parse_runtime_output(raw);

        let added_line = parsed
            .lines
            .iter()
            .find(|line| line.plain_text().contains("+ const retries = 3;"))
            .expect("added ts line");
        assert_eq!(added_line.kind(), LogKind::DiffAdded);
        assert!(added_line.spans().iter().any(|span| span.fg.is_some()));
    }

    #[test]
    fn permission_preview_diff_ts_write_case_emits_colored_spans() {
        let raw = r#"{"method":"agent.event","params":{"event":{"type":"permission.preview","tool":"write","file_path":"demo-write-edit-4.ts","diff":"--- demo-write-edit-4.ts\n+++ demo-write-edit-4.ts\n@@ -0,0 +1,3 @@\n+export type Item = {\n+  id: string;\n+  score: number;"}}}"#;
        let parsed = parse_runtime_output(raw);

        let added_line = parsed
            .lines
            .iter()
            .find(|line| line.plain_text().contains("+ export type Item"))
            .expect("added write line");
        assert_eq!(added_line.kind(), LogKind::DiffAdded);
        assert!(added_line.spans().iter().any(|span| span.fg.is_some()));
    }

    #[test]
    fn permission_preview_diff_uses_explicit_language_hint() {
        let raw = r#"{"method":"agent.event","params":{"event":{"type":"permission.preview","tool":"edit","file_path":"notes.unknown","language":"rust","diff":"@@ -1 +1 @@\n-fn old() {}\n+fn new() {}"}}}"#;
        let parsed = parse_runtime_output(raw);

        let added_line = parsed
            .lines
            .iter()
            .find(|line| line.plain_text().contains("+ fn new() {}"))
            .expect("added rust line");
        assert_eq!(added_line.kind(), LogKind::DiffAdded);
        assert!(added_line.spans().iter().any(|span| span.fg.is_some()));
    }

    #[test]
    fn permission_preview_diff_styles_line_numbers_and_markers() {
        let raw = r#"{"method":"agent.event","params":{"event":{"type":"permission.preview","tool":"edit","diff":"--- a/demo.txt\n+++ b/demo.txt\n@@ -1 +1 @@\n-old line\n+new line"}}}"#;
        let parsed = parse_runtime_output(raw);

        let removed_line = parsed
            .lines
            .iter()
            .find(|line| line.plain_text().contains("- old line"))
            .expect("removed line");
        let added_line = parsed
            .lines
            .iter()
            .find(|line| line.plain_text().contains("+ new line"))
            .expect("added line");

        assert_eq!(removed_line.spans()[1].fg, Some(DIFF_NUMBER_FG));
        assert_eq!(added_line.spans()[1].fg, Some(DIFF_NUMBER_FG));
        assert_eq!(removed_line.spans()[2].fg, Some(DIFF_REMOVED_MARKER_FG));
        assert_eq!(added_line.spans()[2].fg, Some(DIFF_ADDED_MARKER_FG));
    }

    #[test]
    fn limited_edit_diff_lines_truncates_output() {
        let diff = "--- a.txt\n+++ b.txt\n@@ -1 +1 @@\n-old\n+new";
        let (lines, truncated) = limited_edit_diff_lines_with_hint(diff, 1, None);
        assert!(truncated);
        assert_eq!(lines.len(), 1);
    }
}
