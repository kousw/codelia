//! Presentation of the catalogued runtime -> UI requests and notifications
//! other than `agent.event`. Inputs are generated protocol types; wire decoding
//! happens in `typed_output` (`parser.rs`).
use super::common::{format_percent, format_u64_with_commas};
use super::helpers::summary_and_detail_line;
use super::types::{
    GoalNotification, RunControlMsg, RuntimeMsg, ServerUiMsg, UiConfirmRequest, UiPickItem,
    UiPickRequest, UiPromptRequest,
};
use crate::app::state::{LogKind, LogLine};
use crate::protocol::{
    GoalOffer, GoalSnapshot, RunContextNotify, RunMetricsNotify, RunSummaryNotify,
    UiConfirmRequestParams, UiPickCancelledParams, UiPickRequestParams, UiPromptRequestParams,
};

/// Token counts are non-negative on the wire; clamp defensively for display.
fn count(value: i64) -> u64 {
    u64::try_from(value).unwrap_or(0)
}

pub(super) fn confirm_request_output(id: String, params: UiConfirmRequestParams) -> RuntimeMsg {
    RuntimeMsg::UiRequest(ServerUiMsg::Confirm(UiConfirmRequest {
        id,
        title: params.title,
        message: params.message,
        danger_level: params.danger_level.map(|level| level.as_str().to_owned()),
        confirm_label: params.confirm_label,
        cancel_label: params.cancel_label,
        allow_remember: params.allow_remember.unwrap_or(false),
        allow_reason: params.allow_reason.unwrap_or(false),
    }))
}

pub(super) fn prompt_request_output(id: String, params: UiPromptRequestParams) -> RuntimeMsg {
    RuntimeMsg::UiRequest(ServerUiMsg::Prompt(UiPromptRequest {
        id,
        title: params.title,
        message: params.message,
        default_value: params.default_value,
        multiline: params.multiline.unwrap_or(false),
        secret: params.secret.unwrap_or(false),
    }))
}

pub(super) fn pick_request_output(id: String, params: UiPickRequestParams) -> RuntimeMsg {
    RuntimeMsg::UiRequest(ServerUiMsg::Pick(UiPickRequest {
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
    }))
}

pub(super) fn pick_cancelled_output(params: UiPickCancelledParams) -> RuntimeMsg {
    RuntimeMsg::UiRequest(ServerUiMsg::PickCancelled { id: params.id })
}

pub(super) fn run_context_output(params: RunContextNotify) -> RuntimeMsg {
    let percent = params
        .context_left_percent
        .is_finite()
        .then(|| params.context_left_percent.clamp(0.0, 100.0).round() as u8);
    RuntimeMsg::RunControl(RunControlMsg::Context {
        left_percent: percent,
    })
}

pub(super) fn goal_updated_output(snapshot: GoalSnapshot) -> RuntimeMsg {
    RuntimeMsg::RunControl(RunControlMsg::Goal(GoalNotification::Updated(Box::new(
        snapshot,
    ))))
}

pub(super) fn goal_ready_output(offer: GoalOffer) -> RuntimeMsg {
    RuntimeMsg::RunControl(RunControlMsg::Goal(GoalNotification::Ready(offer)))
}

pub(super) fn run_summary_output(params: RunSummaryNotify) -> RuntimeMsg {
    RuntimeMsg::RunControl(RunControlMsg::Summary(Box::new(params)))
}

pub(crate) fn format_metrics_diagnostic_lines(call: &RunMetricsNotify) -> Vec<LogLine> {
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
    let (hit_state, cache_read, cache_create) = call
        .cache
        .as_ref()
        .map(|cache| {
            (
                cache.hit_state.as_str(),
                count(cache.cache_read_tokens),
                count(cache.cache_creation_tokens),
            )
        })
        .unwrap_or(("unknown", 0, 0));
    let cache_read_ratio_label = call
        .cache
        .as_ref()
        .and_then(|cache| cache.cache_read_ratio)
        .filter(|value| value.is_finite() && *value >= 0.0)
        .map(|ratio| format_percent(ratio * 100.0))
        .or_else(|| {
            if matches!(hit_state, "hit" | "miss") && input_tokens > 0 {
                Some(format_percent(
                    (cache_read as f64 / input_tokens as f64) * 100.0,
                ))
            } else {
                None
            }
        })
        .unwrap_or_else(|| "-".to_string());
    let latency_ms = call
        .latency_ms
        .filter(|value| value.is_finite() && *value >= 0.0)
        .map(|value| value as u64)
        .unwrap_or(0);
    let mut detail = format!(
        "provider={} latency={}ms stop={} tok(in/out/total)={}/{}/{} cache={} read={} ({}) create={}",
        call.provider.as_deref().unwrap_or("-"),
        latency_ms,
        call.stop_reason.as_deref().unwrap_or("-"),
        format_u64_with_commas(input_tokens),
        format_u64_with_commas(output_tokens),
        format_u64_with_commas(total_tokens),
        hit_state,
        format_u64_with_commas(cache_read),
        cache_read_ratio_label,
        format_u64_with_commas(cache_create),
    );
    if let Some(ttft) = call
        .timing
        .as_ref()
        .map(|timing| timing.time_to_first_token_ms)
        .filter(|value| value.is_finite() && *value >= 0.0)
    {
        detail = format!("{detail} ttft={:.0}ms", ttft);
    }
    if let Some(tps) = call
        .output_tokens_per_second
        .filter(|value| value.is_finite() && *value >= 0.0)
    {
        detail = format!("{detail} tps={tps:.1}");
    }
    if let Some(cost) = call
        .cost_usd
        .filter(|value| value.is_finite() && *value >= 0.0)
    {
        detail = format!("{detail} cost=${cost:.4}");
    }
    if let Some(retries) = call.retry_count.filter(|value| *value > 0) {
        detail = format!("{detail} retries={retries}");
    }
    if let Some(meta) = call
        .provider_meta_summary
        .as_deref()
        .filter(|value| !value.is_empty())
    {
        detail = format!("{detail} meta={meta}");
    }
    let model = call
        .actual_model
        .as_deref()
        .or(call.model.as_deref())
        .unwrap_or("-");
    let label = format!("diag llm#{} {}", count(call.seq), model);
    summary_and_detail_line("", &label, &detail, LogKind::Status, LogKind::Status)
}

pub(crate) fn format_summary_diagnostic_lines(notify: &RunSummaryNotify) -> Vec<LogLine> {
    let summary = &notify.session;
    let total_calls = count(summary.total_calls);
    let total_input = count(summary.total_input_tokens);
    let total_cached = count(summary.total_cached_input_tokens);
    let cache_read_ratio = if total_input == 0 {
        0.0
    } else {
        (total_cached as f64 / total_input as f64) * 100.0
    };
    let mut detail = format!(
        "calls={} tok(in/out/total)={}/{}/{} cache(read/create)={}/{} ({}) calls(hit/miss/unknown)={}/{}/{}",
        total_calls,
        format_u64_with_commas(total_input),
        format_u64_with_commas(count(summary.total_output_tokens)),
        format_u64_with_commas(count(summary.total_tokens)),
        format_u64_with_commas(total_cached),
        format_u64_with_commas(count(summary.total_cache_creation_tokens)),
        format_percent(cache_read_ratio),
        count(summary.cache_hit_calls),
        count(summary.cache_miss_calls),
        count(summary.cache_unknown_calls),
    );
    if let Some(cost) = summary
        .total_cost_usd
        .filter(|value| value.is_finite() && *value >= 0.0)
    {
        detail = format!("{detail} cost=${cost:.4}");
    }
    summary_and_detail_line(
        "",
        "diag run total (cumulative)",
        &detail,
        LogKind::Status,
        LogKind::Status,
    )
}
