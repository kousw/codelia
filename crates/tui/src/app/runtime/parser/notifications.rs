//! Presentation of the catalogued runtime -> UI requests and notifications
//! other than `agent.event`. Inputs are generated protocol types; wire decoding
//! happens in `typed_output` (`parser.rs`).
use super::common::{format_percent, format_u64_with_commas};
use super::helpers::summary_and_detail_line;
use super::types::{ParsedOutput, UiConfirmRequest, UiPickItem, UiPickRequest, UiPromptRequest};
use crate::app::goal::GoalNotification;
use crate::app::state::LogKind;
use crate::protocol::{
    GoalOffer, GoalSnapshot, LlmCallDiagnostics, RunContextNotify, RunDiagnosticsNotify,
    RunUsageSummary, UiConfirmRequestParams, UiPickCancelledParams, UiPickRequestParams,
    UiPromptRequestParams,
};

/// Token counts are non-negative on the wire; clamp defensively for display.
fn count(value: i64) -> u64 {
    u64::try_from(value).unwrap_or(0)
}

pub(super) fn confirm_request_output(id: String, params: UiConfirmRequestParams) -> ParsedOutput {
    ParsedOutput {
        confirm_request: Some(UiConfirmRequest {
            id,
            title: params.title,
            message: params.message,
            danger_level: params.danger_level.map(|level| level.as_str().to_owned()),
            confirm_label: params.confirm_label,
            cancel_label: params.cancel_label,
            allow_remember: params.allow_remember.unwrap_or(false),
            allow_reason: params.allow_reason.unwrap_or(false),
        }),
        ..ParsedOutput::empty()
    }
}

pub(super) fn prompt_request_output(id: String, params: UiPromptRequestParams) -> ParsedOutput {
    ParsedOutput {
        prompt_request: Some(UiPromptRequest {
            id,
            title: params.title,
            message: params.message,
            default_value: params.default_value,
            multiline: params.multiline.unwrap_or(false),
            secret: params.secret.unwrap_or(false),
        }),
        ..ParsedOutput::empty()
    }
}

pub(super) fn pick_request_output(id: String, params: UiPickRequestParams) -> ParsedOutput {
    ParsedOutput {
        pick_request: Some(UiPickRequest {
            id,
            title: params.title,
            message: params.message,
            items: params
                .items
                .into_iter()
                .map(|item| UiPickItem {
                    id: item.id,
                    label: item.label,
                    detail: item.detail,
                })
                .collect(),
            multi: params.multi.unwrap_or(false),
            approval: params.approval.unwrap_or(false),
        }),
        ..ParsedOutput::empty()
    }
}

pub(super) fn pick_cancelled_output(params: UiPickCancelledParams) -> ParsedOutput {
    ParsedOutput {
        cancelled_pick_id: Some(params.id),
        ..ParsedOutput::empty()
    }
}

pub(super) fn run_context_output(params: RunContextNotify) -> ParsedOutput {
    let percent = params
        .context_left_percent
        .is_finite()
        .then(|| params.context_left_percent.clamp(0.0, 100.0).round() as u8);
    ParsedOutput {
        context_left_percent: percent,
        ..ParsedOutput::empty()
    }
}

pub(super) fn goal_updated_output(snapshot: GoalSnapshot) -> ParsedOutput {
    ParsedOutput {
        goal_notification: Some(GoalNotification::Updated(snapshot)),
        ..ParsedOutput::empty()
    }
}

pub(super) fn goal_ready_output(offer: GoalOffer) -> ParsedOutput {
    ParsedOutput {
        goal_notification: Some(GoalNotification::Ready(offer)),
        ..ParsedOutput::empty()
    }
}

pub(super) fn run_diagnostics_output(params: RunDiagnosticsNotify) -> ParsedOutput {
    let (label, detail) = match params {
        RunDiagnosticsNotify::LlmCall(call) => llm_call_line(&call.call),
        RunDiagnosticsNotify::RunSummary(summary) => run_summary_line(&summary.summary),
        RunDiagnosticsNotify::Unknown(_) => return ParsedOutput::empty(),
    };
    ParsedOutput {
        lines: summary_and_detail_line("", &label, &detail, LogKind::Status, LogKind::Status),
        ..ParsedOutput::empty()
    }
}

fn llm_call_line(call: &LlmCallDiagnostics) -> (String, String) {
    let (input_tokens, output_tokens, total_tokens) = call
        .usage
        .as_ref()
        .map(|usage| {
            (
                count(usage.input_tokens),
                count(usage.output_tokens),
                count(usage.total_tokens),
            )
        })
        .unwrap_or((0, 0, 0));
    let cache_read = count(call.cache.cache_read_tokens);
    let cache_read_ratio = if input_tokens == 0 {
        0.0
    } else {
        (cache_read as f64 / input_tokens as f64) * 100.0
    };
    let latency_ms = if call.latency_ms.is_finite() && call.latency_ms >= 0.0 {
        call.latency_ms as u64
    } else {
        0
    };
    let mut detail = format!(
        "provider={} latency={}ms stop={} tok(in/out/total)={}/{}/{} cache={} read={} ({}) create={}",
        call.provider.as_deref().unwrap_or("-"),
        latency_ms,
        call.stop_reason.as_deref().unwrap_or("-"),
        format_u64_with_commas(input_tokens),
        format_u64_with_commas(output_tokens),
        format_u64_with_commas(total_tokens),
        call.cache.hit_state.as_str(),
        format_u64_with_commas(cache_read),
        format_percent(cache_read_ratio),
        format_u64_with_commas(count(call.cache.cache_creation_tokens)),
    );
    if let Some(tps) = call
        .output_tokens_per_second
        .filter(|value| value.is_finite() && *value >= 0.0)
    {
        detail = format!("{detail} tps={tps:.1}");
    }
    if let Some(meta) = call
        .provider_meta_summary
        .as_deref()
        .filter(|value| !value.is_empty())
    {
        detail = format!("{detail} meta={meta}");
    }
    (
        format!("diag llm#{} {}", count(call.seq), call.model),
        detail,
    )
}

fn run_summary_line(summary: &RunUsageSummary) -> (String, String) {
    let total_calls = count(summary.total_calls);
    let total_input = count(summary.total_input_tokens);
    let total_cached = count(summary.total_cached_input_tokens);
    let cache_read_ratio = if total_input == 0 {
        0.0
    } else {
        (total_cached as f64 / total_input as f64) * 100.0
    };
    let (mut hit_calls, mut miss_calls, mut unknown_calls) = (0_u64, 0_u64, 0_u64);
    for stats in summary.by_model.values() {
        let calls = count(stats.calls);
        if calls == 0 {
            continue;
        }
        if stats.cached_input_tokens > 0 {
            hit_calls += calls;
        } else if stats.input_tokens > 0 {
            miss_calls += calls;
        } else {
            unknown_calls += calls;
        }
    }
    if hit_calls + miss_calls + unknown_calls < total_calls {
        unknown_calls += total_calls - (hit_calls + miss_calls + unknown_calls);
    }
    let detail = format!(
        "calls={} tok(in/out/total)={}/{}/{} cache(read/create)={}/{} ({}) calls(hit/miss/unknown)={}/{}/{}",
        total_calls,
        format_u64_with_commas(total_input),
        format_u64_with_commas(count(summary.total_output_tokens)),
        format_u64_with_commas(count(summary.total_tokens)),
        format_u64_with_commas(total_cached),
        format_u64_with_commas(count(summary.total_cache_creation_tokens)),
        format_percent(cache_read_ratio),
        hit_calls,
        miss_calls,
        unknown_calls,
    );
    ("diag run total (cumulative)".to_owned(), detail)
}
