use crate::protocol::{
    CompactionCompleteEvent, RunMetricsNotify, RunSummaryNotify, StepCompleteEvent,
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
}

fn non_neg_u64(value: i64) -> u64 {
    u64::try_from(value).unwrap_or(0)
}

#[derive(Debug, Default)]
pub struct TelemetryStore {
    pub last_call: Option<RunMetricsNotify>,
    pub recent_calls: VecDeque<RunMetricsNotify>,
    pub last_run_summary: Option<RunSummaryNotify>,
    /// Authoritative session summary owned by runtime (updated from `run.metrics.session`,
    /// `run.summary.session`, and `telemetry.get.session_summary`).
    pub session_summary: Option<TelemetrySummary>,
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
        self.active_tool_names.clear();
        self.recent_tools.clear();
        self.recent_compactions.clear();
        self.pulled_snapshot = None;
    }

    pub fn record_metrics(&mut self, mut metrics: RunMetricsNotify) {
        if let Some(session) = metrics.session.take() {
            self.session_summary = Some(session);
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
        if self.last_call.is_none() {
            if let Some(last) = snapshot.recent_calls.last() {
                self.last_call = Some(last.clone());
            }
        }
        self.pulled_snapshot = Some(snapshot);
    }

    pub fn session_totals(&self) -> SessionTotalsView {
        self.session_summary
            .as_ref()
            .map(SessionTotalsView::from_summary)
            .unwrap_or_default()
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

    fn sample_summary(calls: i64, total_tokens: i64, cost: Option<f64>) -> TelemetrySummary {
        TelemetrySummary {
            total_calls: calls,
            total_tokens,
            total_input_tokens: calls * 1000,
            total_output_tokens: calls * 200,
            total_output_reasoning_tokens: calls * 40,
            total_cached_input_tokens: calls * 600,
            total_cache_creation_tokens: 0,
            total_input_image_tokens: 0,
            cache_hit_calls: calls,
            cache_miss_calls: 0,
            cache_unknown_calls: 0,
            total_cost_usd: cost,
            retry_count: 1,
            retry_wait_ms: 500.0,
            tool_calls: 1,
            tool_errors: 0,
            tool_exec_ms: 50.0,
            tool_approval_wait_ms: 100.0,
            compaction_count: 0,
            compaction_duration_ms: 0.0,
            by_model: BTreeMap::new(),
        }
    }

    fn sample_metrics(
        seq: i64,
        cached: i64,
        cost: Option<f64>,
        session: Option<TelemetrySummary>,
    ) -> RunMetricsNotify {
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
            session,
        }
    }

    #[test]
    fn telemetry_store_tracks_runtime_authoritative_summary_and_strips_nested_session() {
        let mut store = TelemetryStore::default();
        store.record_metrics(sample_metrics(
            1,
            600,
            Some(0.01),
            Some(sample_summary(1, 1200, Some(0.01))),
        ));
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
        // Stored per-call records strip nested session snapshots.
        assert!(store.last_call.as_ref().unwrap().session.is_none());
        assert!(store.recent_calls.back().unwrap().session.is_none());

        let authoritative = sample_summary(2, 2400, Some(0.025));
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

    #[test]
    fn mid_run_pulled_snapshot_stays_consistent_with_runtime_authoritative_metrics() {
        use crate::protocol::{
            ContextUsage, ContextUsageBasis, RuntimeMemoryUsage, RuntimePerfSnapshot,
            TelemetryGetResult,
        };

        let mut store = TelemetryStore::default();
        let after_call_1 = sample_summary(1, 1200, Some(0.01));
        store.record_metrics(sample_metrics(
            1,
            600,
            Some(0.01),
            Some(after_call_1.clone()),
        ));

        store.apply_pulled_snapshot(TelemetryGetResult {
            session_id: Some("sess-1".into()),
            active_run_id: Some("run-1".into()),
            context: ContextUsage {
                provider: Some("openai".into()),
                model: Some("gpt-5".into()),
                limit_tokens: Some(128_000),
                used_tokens: Some(1200),
                input_tokens: Some(1000),
                left_percent: Some(99.0),
                basis: ContextUsageBasis::Provider,
                breakdown: Vec::new(),
            },
            session_summary: after_call_1.clone(),
            run_summary: Some(after_call_1),
            recent_calls: Vec::new(),
            recent_tools: Vec::new(),
            runtime: RuntimePerfSnapshot {
                startup_phases: Vec::new(),
                agent_init_phases: Vec::new(),
                active_subagents: 0,
                max_concurrent_subagents: 8,
                backpressure_events: 0,
                memory: RuntimeMemoryUsage {
                    rss_bytes: 0,
                    heap_used_bytes: 0,
                    heap_total_bytes: 0,
                    external_bytes: 0,
                    array_buffers_bytes: 0,
                },
            },
        });

        let totals = store.session_totals();
        assert_eq!(totals.calls, 1);
        assert_eq!(totals.total_tokens, 1200);
        assert_eq!(totals.cost_usd, Some(0.01));

        store.record_metrics(sample_metrics(
            2,
            600,
            Some(0.01),
            Some(sample_summary(2, 2400, Some(0.02))),
        ));
        let after_second = store.session_totals();
        assert_eq!(after_second.calls, 2);
        assert_eq!(after_second.total_tokens, 2400);
        assert_eq!(after_second.cost_usd, Some(0.02));
    }
}
