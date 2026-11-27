use crate::protocol::{
    CacheHitState, CompactionCompleteEvent, RunMetricsNotify, RunSummaryNotify, StepCompleteEvent,
    StepCompleteEventStatus, TelemetryGetResult, TelemetrySummary,
};
use std::collections::{HashMap, VecDeque};

const MAX_RECENT_CALLS: usize = 64;
const MAX_RECENT_TOOLS: usize = 64;
const MAX_RECENT_COMPACTIONS: usize = 32;

#[derive(Debug, Clone)]
pub struct LocalToolTiming {
    pub tool: String,
    pub is_error: bool,
    pub duration_ms: f64,
    pub exec_duration_ms: Option<f64>,
    pub approval_wait_ms: Option<f64>,
}

#[derive(Debug, Clone)]
pub struct LocalCompactionRecord {
    pub compacted: bool,
    pub duration_ms: Option<f64>,
    pub messages_before: Option<i64>,
    pub messages_after: Option<i64>,
    pub estimated_tokens_before: Option<i64>,
    pub estimated_tokens_after: Option<i64>,
}

#[derive(Debug, Default, Clone)]
pub struct SessionTotalsView {
    pub calls: u64,
    pub input_tokens: u64,
    pub output_tokens: u64,
    pub output_reasoning_tokens: u64,
    pub cached_input_tokens: u64,
    pub cache_creation_tokens: u64,
    pub total_tokens: u64,
    pub cache_hit_calls: u64,
    pub cache_miss_calls: u64,
    pub cache_unknown_calls: u64,
    pub cost_usd: Option<f64>,
    pub retry_count: u64,
    pub retry_wait_ms: f64,
    pub tool_calls: u64,
    pub tool_errors: u64,
    pub tool_exec_ms: f64,
    pub tool_approval_wait_ms: f64,
    pub compaction_count: u64,
    pub compaction_duration_ms: f64,
}

impl SessionTotalsView {
    pub fn cache_read_ratio(&self) -> Option<f64> {
        if self.input_tokens == 0 {
            None
        } else {
            Some((self.cached_input_tokens as f64 / self.input_tokens as f64) * 100.0)
        }
    }

    pub fn from_summary(summary: &TelemetrySummary) -> Self {
        Self {
            calls: non_neg_u64(summary.total_calls),
            input_tokens: non_neg_u64(summary.total_input_tokens),
            output_tokens: non_neg_u64(summary.total_output_tokens),
            output_reasoning_tokens: non_neg_u64(summary.total_output_reasoning_tokens),
            cached_input_tokens: non_neg_u64(summary.total_cached_input_tokens),
            cache_creation_tokens: non_neg_u64(summary.total_cache_creation_tokens),
            total_tokens: non_neg_u64(summary.total_tokens),
            cache_hit_calls: non_neg_u64(summary.cache_hit_calls),
            cache_miss_calls: non_neg_u64(summary.cache_miss_calls),
            cache_unknown_calls: non_neg_u64(summary.cache_unknown_calls),
            cost_usd: summary
                .total_cost_usd
                .filter(|v| v.is_finite() && *v >= 0.0),
            retry_count: non_neg_u64(summary.retry_count),
            retry_wait_ms: summary.retry_wait_ms.max(0.0),
            tool_calls: non_neg_u64(summary.tool_calls),
            tool_errors: non_neg_u64(summary.tool_errors),
            tool_exec_ms: summary.tool_exec_ms.max(0.0),
            tool_approval_wait_ms: summary.tool_approval_wait_ms.max(0.0),
            compaction_count: non_neg_u64(summary.compaction_count),
            compaction_duration_ms: summary.compaction_duration_ms.max(0.0),
        }
    }

    fn merge_delta(&mut self, delta: &SessionTotalsView) {
        self.calls = self.calls.saturating_add(delta.calls);
        self.input_tokens = self.input_tokens.saturating_add(delta.input_tokens);
        self.output_tokens = self.output_tokens.saturating_add(delta.output_tokens);
        self.output_reasoning_tokens = self
            .output_reasoning_tokens
            .saturating_add(delta.output_reasoning_tokens);
        self.cached_input_tokens = self
            .cached_input_tokens
            .saturating_add(delta.cached_input_tokens);
        self.cache_creation_tokens = self
            .cache_creation_tokens
            .saturating_add(delta.cache_creation_tokens);
        self.total_tokens = self.total_tokens.saturating_add(delta.total_tokens);
        self.cache_hit_calls = self.cache_hit_calls.saturating_add(delta.cache_hit_calls);
        self.cache_miss_calls = self.cache_miss_calls.saturating_add(delta.cache_miss_calls);
        self.cache_unknown_calls = self
            .cache_unknown_calls
            .saturating_add(delta.cache_unknown_calls);
        if let Some(cost) = delta.cost_usd {
            self.cost_usd = Some(self.cost_usd.unwrap_or(0.0) + cost);
        }
        self.retry_count = self.retry_count.saturating_add(delta.retry_count);
        self.retry_wait_ms += delta.retry_wait_ms;
        self.tool_calls = self.tool_calls.saturating_add(delta.tool_calls);
        self.tool_errors = self.tool_errors.saturating_add(delta.tool_errors);
        self.tool_exec_ms += delta.tool_exec_ms;
        self.tool_approval_wait_ms += delta.tool_approval_wait_ms;
        self.compaction_count = self.compaction_count.saturating_add(delta.compaction_count);
        self.compaction_duration_ms += delta.compaction_duration_ms;
    }
}

fn non_neg_u64(value: i64) -> u64 {
    u64::try_from(value).unwrap_or(0)
}

#[derive(Debug, Default)]
pub struct TelemetryStore {
    pub last_call: Option<RunMetricsNotify>,
    pub recent_calls: VecDeque<RunMetricsNotify>,
    pub last_run_summary: Option<RunSummaryNotify>,
    pub session_summary: Option<TelemetrySummary>,
    /// Live incremental delta accumulated during an in-flight run (cleared once
    /// authoritative `run.summary` or `telemetry.get` snaps `session_summary`).
    in_flight_delta: SessionTotalsView,
    active_tool_names: HashMap<String, String>,
    pub recent_tools: VecDeque<LocalToolTiming>,
    pub recent_compactions: VecDeque<LocalCompactionRecord>,
    pub pulled_snapshot: Option<TelemetryGetResult>,
}

impl TelemetryStore {
    pub fn reset_session(&mut self) {
        self.last_call = None;
        self.recent_calls.clear();
        self.last_run_summary = None;
        self.session_summary = None;
        self.in_flight_delta = SessionTotalsView::default();
        self.active_tool_names.clear();
        self.recent_tools.clear();
        self.recent_compactions.clear();
        self.pulled_snapshot = None;
    }

    pub fn record_metrics(&mut self, metrics: RunMetricsNotify) {
        self.in_flight_delta.calls = self.in_flight_delta.calls.saturating_add(1);
        if let Some(usage) = &metrics.usage {
            self.in_flight_delta.input_tokens = self
                .in_flight_delta
                .input_tokens
                .saturating_add(non_neg_u64(usage.input_tokens));
            self.in_flight_delta.output_tokens = self
                .in_flight_delta
                .output_tokens
                .saturating_add(non_neg_u64(usage.output_tokens));
            if let Some(reasoning) = usage.output_reasoning_tokens {
                self.in_flight_delta.output_reasoning_tokens = self
                    .in_flight_delta
                    .output_reasoning_tokens
                    .saturating_add(non_neg_u64(reasoning));
            }
            self.in_flight_delta.total_tokens = self
                .in_flight_delta
                .total_tokens
                .saturating_add(non_neg_u64(usage.total_tokens));
        }
        if let Some(cache) = &metrics.cache {
            self.in_flight_delta.cached_input_tokens = self
                .in_flight_delta
                .cached_input_tokens
                .saturating_add(non_neg_u64(cache.cache_read_tokens));
            self.in_flight_delta.cache_creation_tokens = self
                .in_flight_delta
                .cache_creation_tokens
                .saturating_add(non_neg_u64(cache.cache_creation_tokens));
            match cache.hit_state {
                CacheHitState::Hit => {
                    self.in_flight_delta.cache_hit_calls =
                        self.in_flight_delta.cache_hit_calls.saturating_add(1);
                }
                CacheHitState::Miss => {
                    self.in_flight_delta.cache_miss_calls =
                        self.in_flight_delta.cache_miss_calls.saturating_add(1);
                }
                CacheHitState::Unknown | _ => {
                    self.in_flight_delta.cache_unknown_calls =
                        self.in_flight_delta.cache_unknown_calls.saturating_add(1);
                }
            }
        } else {
            self.in_flight_delta.cache_unknown_calls =
                self.in_flight_delta.cache_unknown_calls.saturating_add(1);
        }
        if let Some(cost) = metrics.cost_usd.filter(|v| v.is_finite() && *v >= 0.0) {
            self.in_flight_delta.cost_usd =
                Some(self.in_flight_delta.cost_usd.unwrap_or(0.0) + cost);
        }
        if let Some(retries) = metrics.retry_count {
            self.in_flight_delta.retry_count = self
                .in_flight_delta
                .retry_count
                .saturating_add(non_neg_u64(retries));
        }
        if let Some(wait_ms) = metrics.retry_wait_ms.filter(|v| v.is_finite() && *v >= 0.0) {
            self.in_flight_delta.retry_wait_ms += wait_ms;
        }

        self.last_call = Some(metrics.clone());
        if self.recent_calls.len() >= MAX_RECENT_CALLS {
            self.recent_calls.pop_front();
        }
        self.recent_calls.push_back(metrics);
    }

    pub fn record_summary(&mut self, summary: RunSummaryNotify) {
        self.session_summary = Some(summary.session.clone());
        self.last_run_summary = Some(summary);
        self.in_flight_delta = SessionTotalsView::default();
        self.active_tool_names.clear();
    }

    pub fn record_tool_call(&mut self, tool_call_id: &str, tool: &str) {
        if !tool_call_id.is_empty() && !tool.is_empty() {
            if self.active_tool_names.len() >= 256 {
                self.active_tool_names.clear();
            }
            self.active_tool_names
                .insert(tool_call_id.to_owned(), tool.to_owned());
        }
    }

    pub fn record_step_complete(&mut self, event: &StepCompleteEvent) {
        let tool = self
            .active_tool_names
            .remove(&event.step_id)
            .unwrap_or_else(|| "tool".to_owned());
        let is_error = matches!(event.status, StepCompleteEventStatus::Error);
        let duration_ms = if event.duration_ms.is_finite() && event.duration_ms >= 0.0 {
            event.duration_ms
        } else {
            0.0
        };
        let exec_duration_ms = event
            .exec_duration_ms
            .filter(|v| v.is_finite() && *v >= 0.0);
        let approval_wait_ms = event
            .approval_wait_ms
            .filter(|v| v.is_finite() && *v >= 0.0);

        self.in_flight_delta.tool_calls = self.in_flight_delta.tool_calls.saturating_add(1);
        if is_error {
            self.in_flight_delta.tool_errors = self.in_flight_delta.tool_errors.saturating_add(1);
        }
        self.in_flight_delta.tool_exec_ms += exec_duration_ms.unwrap_or(duration_ms);
        self.in_flight_delta.tool_approval_wait_ms += approval_wait_ms.unwrap_or(0.0);

        if self.recent_tools.len() >= MAX_RECENT_TOOLS {
            self.recent_tools.pop_front();
        }
        self.recent_tools.push_back(LocalToolTiming {
            tool,
            is_error,
            duration_ms,
            exec_duration_ms,
            approval_wait_ms,
        });
    }

    pub fn record_compaction_complete(&mut self, event: &CompactionCompleteEvent) {
        let duration_ms = event.duration_ms.filter(|v| v.is_finite() && *v >= 0.0);
        if event.compacted {
            self.in_flight_delta.compaction_count =
                self.in_flight_delta.compaction_count.saturating_add(1);
            if let Some(ms) = duration_ms {
                self.in_flight_delta.compaction_duration_ms += ms;
            }
        }
        if self.recent_compactions.len() >= MAX_RECENT_COMPACTIONS {
            self.recent_compactions.pop_front();
        }
        self.recent_compactions.push_back(LocalCompactionRecord {
            compacted: event.compacted,
            duration_ms,
            messages_before: event.messages_before,
            messages_after: event.messages_after,
            estimated_tokens_before: event.estimated_tokens_before,
            estimated_tokens_after: event.estimated_tokens_after,
        });
    }

    pub fn apply_pulled_snapshot(&mut self, snapshot: TelemetryGetResult) {
        self.session_summary = Some(snapshot.session_summary.clone());
        if snapshot.active_run_id.is_none() {
            self.in_flight_delta = SessionTotalsView::default();
        }
        if self.last_call.is_none() {
            if let Some(last) = snapshot.recent_calls.last() {
                self.last_call = Some(last.clone());
            }
        }
        self.pulled_snapshot = Some(snapshot);
    }

    pub fn session_totals(&self) -> SessionTotalsView {
        let mut base = self
            .session_summary
            .as_ref()
            .map(SessionTotalsView::from_summary)
            .unwrap_or_default();
        base.merge_delta(&self.in_flight_delta);
        base
    }

    pub fn last_tps(&self) -> Option<f64> {
        self.last_call
            .as_ref()
            .and_then(|call| call.output_tokens_per_second)
            .filter(|v| v.is_finite() && *v >= 0.0)
    }

    pub fn last_ttft_ms(&self) -> Option<f64> {
        self.last_call
            .as_ref()
            .and_then(|call| call.timing.as_ref())
            .map(|timing| timing.time_to_first_token_ms)
            .filter(|v| v.is_finite() && *v >= 0.0)
    }

    pub fn last_latency_ms(&self) -> Option<f64> {
        self.last_call
            .as_ref()
            .and_then(|call| call.latency_ms)
            .filter(|v| v.is_finite() && *v >= 0.0)
    }
}

#[cfg(test)]
mod tests {
    use super::TelemetryStore;
    use crate::protocol::{
        CacheHitState, LlmCallCache, LlmCallTiming, LlmCallUsage, RunMetricsNotify,
        RunSummaryNotify, StepCompleteEvent, StepCompleteEventStatus, TelemetrySummary,
    };
    use std::collections::BTreeMap;

    fn sample_metrics(seq: i64, cached: i64, cost: Option<f64>) -> RunMetricsNotify {
        RunMetricsNotify {
            run_id: "run-1".into(),
            seq,
            provider: Some("openai".into()),
            model: Some("gpt-5".into()),
            actual_model: None,
            request_ts: None,
            response_ts: None,
            latency_ms: Some(1200.0),
            output_tokens_per_second: Some(50.0),
            timing: Some(LlmCallTiming {
                time_to_first_token_ms: 250.0,
                generation_duration_ms: 950.0,
                generation_start_ms: None,
                generation_start_source: None,
            }),
            stop_reason: Some("end_turn".into()),
            usage: Some(LlmCallUsage {
                input_tokens: 1000,
                output_tokens: 200,
                output_reasoning_tokens: Some(40),
                total_tokens: 1200,
                input_cached_tokens: Some(cached),
                input_cache_creation_tokens: Some(0),
                input_image_tokens: None,
            }),
            cache: Some(LlmCallCache {
                hit_state: if cached > 0 {
                    CacheHitState::Hit
                } else {
                    CacheHitState::Miss
                },
                cache_read_tokens: cached,
                cache_creation_tokens: 0,
                cache_read_ratio: Some(cached as f64 / 1000.0),
            }),
            cost_usd: cost,
            cost_basis: None,
            retry_count: Some(1),
            retry_wait_ms: Some(500.0),
            provider_meta_summary: None,
            context: None,
        }
    }

    #[test]
    fn telemetry_store_tracks_live_delta_and_snaps_on_summary() {
        let mut store = TelemetryStore::default();
        store.record_metrics(sample_metrics(1, 600, Some(0.01)));
        store.record_tool_call("tc-1", "read");
        store.record_step_complete(&StepCompleteEvent {
            step_id: "tc-1".into(),
            status: StepCompleteEventStatus::Completed,
            duration_ms: 150.0,
            exec_duration_ms: Some(50.0),
            approval_wait_ms: Some(100.0),
        });

        let totals = store.session_totals();
        assert_eq!(totals.calls, 1);
        assert_eq!(totals.input_tokens, 1000);
        assert_eq!(totals.cached_input_tokens, 600);
        assert_eq!(totals.cache_hit_calls, 1);
        assert_eq!(totals.tool_calls, 1);
        assert_eq!(totals.tool_exec_ms, 50.0);
        assert_eq!(totals.tool_approval_wait_ms, 100.0);
        assert_eq!(store.last_ttft_ms(), Some(250.0));
        assert_eq!(store.recent_tools.back().unwrap().tool, "read");

        let authoritative = TelemetrySummary {
            total_calls: 2,
            total_tokens: 2400,
            total_input_tokens: 2000,
            total_output_tokens: 400,
            total_output_reasoning_tokens: 80,
            total_cached_input_tokens: 1200,
            total_cache_creation_tokens: 0,
            total_input_image_tokens: 0,
            cache_hit_calls: 2,
            cache_miss_calls: 0,
            cache_unknown_calls: 0,
            total_cost_usd: Some(0.025),
            retry_count: 1,
            retry_wait_ms: 500.0,
            tool_calls: 1,
            tool_errors: 0,
            tool_exec_ms: 50.0,
            tool_approval_wait_ms: 100.0,
            compaction_count: 0,
            compaction_duration_ms: 0.0,
            by_model: BTreeMap::new(),
        };
        store.record_summary(RunSummaryNotify {
            run_id: "run-1".into(),
            duration_ms: 2500.0,
            run: authoritative.clone(),
            session: authoritative,
        });

        let snapped = store.session_totals();
        assert_eq!(snapped.calls, 2);
        assert_eq!(snapped.total_tokens, 2400);
        assert_eq!(snapped.cost_usd, Some(0.025));
    }
}
