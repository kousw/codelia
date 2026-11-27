use super::formatters::push_rpc_error;
use crate::app::runtime::RpcResponse;
use crate::app::state::telemetry::SessionTotalsView;
use crate::app::{AppState, ContextPanelState, LocalPanel};
use crate::protocol::{decode_result, methods, TelemetryGetResult};

pub(crate) const STATS_PANEL_TITLE: &str = "Telemetry & Stats";

fn format_commas(value: u64) -> String {
    let digits = value.to_string();
    let mut out = String::with_capacity(digits.len() + digits.len() / 3);
    for (idx, ch) in digits.chars().rev().enumerate() {
        if idx > 0 && idx % 3 == 0 {
            out.push(',');
        }
        out.push(ch);
    }
    out.chars().rev().collect()
}

fn format_mib(bytes: i64) -> String {
    let mib = (bytes.max(0) as f64) / (1024.0 * 1024.0);
    format!("{mib:.1} MiB")
}

fn format_opt_mib(bytes: Option<u64>) -> String {
    match bytes {
        Some(value) => format!("{:.1} MiB", (value as f64) / (1024.0 * 1024.0)),
        None => "-".to_string(),
    }
}

fn format_cost(cost: Option<f64>) -> String {
    match cost {
        Some(usd) if usd < 0.01 => format!("${usd:.4}"),
        Some(usd) => format!("${usd:.3}"),
        None => "n/a".to_string(),
    }
}

fn push_summary_section(rows: &mut Vec<String>, label: &str, totals: &SessionTotalsView) {
    rows.push(label.to_string());
    let cache_pct = totals
        .cache_read_ratio()
        .map(|pct| format!("{pct:.1}%"))
        .unwrap_or_else(|| "-".to_string());
    rows.push(format!(
        "  calls={}  cache(hit/miss/unk)={}/{}/{}  read_ratio={}",
        totals.calls,
        totals.cache_hit_calls,
        totals.cache_miss_calls,
        totals.cache_unknown_calls,
        cache_pct
    ));
    rows.push(format!(
        "  tokens: in={}  out={} (reasoning={})  total={}",
        format_commas(totals.input_tokens),
        format_commas(totals.output_tokens),
        format_commas(totals.output_reasoning_tokens),
        format_commas(totals.total_tokens),
    ));
    rows.push(format!(
        "  cache_tokens: read={}  create={}  cost={}",
        format_commas(totals.cached_input_tokens),
        format_commas(totals.cache_creation_tokens),
        format_cost(totals.cost_usd),
    ));
    rows.push(format!(
        "  tools={} (errors={})  exec={:.0}ms  approval_wait={:.0}ms",
        totals.tool_calls, totals.tool_errors, totals.tool_exec_ms, totals.tool_approval_wait_ms
    ));
    if totals.retry_count > 0 || totals.compaction_count > 0 {
        rows.push(format!(
            "  retries={} ({:.0}ms wait)  compactions={} ({:.0}ms)",
            totals.retry_count,
            totals.retry_wait_ms,
            totals.compaction_count,
            totals.compaction_duration_ms
        ));
    }
}

pub(crate) fn build_stats_panel(app: &AppState, loading_runtime: bool) -> ContextPanelState {
    let mut rows = Vec::new();
    let pulled = app.telemetry.pulled_snapshot.as_ref();

    // 1. Session summary
    let session_totals = app.telemetry.session_totals();
    push_summary_section(&mut rows, "SESSION TELEMETRY", &session_totals);

    // 2. Last / current run summary
    if let Some(run_summary) = pulled
        .and_then(|s| s.run_summary.as_ref())
        .or_else(|| app.telemetry.last_run_summary.as_ref().map(|r| &r.run))
    {
        rows.push(String::new());
        push_summary_section(
            &mut rows,
            "LAST / ACTIVE RUN",
            &SessionTotalsView::from_summary(run_summary),
        );
    }

    // 3. Context usage (from pulled snapshot or scalar fallback)
    rows.push(String::new());
    rows.push("CONTEXT".to_string());
    if let Some(snapshot) = pulled {
        let ctx = &snapshot.context;
        let used = ctx
            .used_tokens
            .map(|v| format_commas(u64::try_from(v).unwrap_or(0)))
            .unwrap_or_else(|| "-".to_string());
        let limit = ctx
            .limit_tokens
            .map(|v| format_commas(u64::try_from(v).unwrap_or(0)))
            .unwrap_or_else(|| "-".to_string());
        let left = ctx
            .left_percent
            .map(|v| format!("{v:.1}%"))
            .unwrap_or_else(|| "-".to_string());
        rows.push(format!(
            "  used={} / {}  left={}  basis={}",
            used,
            limit,
            left,
            ctx.basis.as_str()
        ));
        if !ctx.breakdown.is_empty() {
            let parts = ctx
                .breakdown
                .iter()
                .map(|entry| {
                    let tokens = format_commas(u64::try_from(entry.tokens).unwrap_or(0));
                    match entry.count {
                        Some(count) => format!("{}={}({})", entry.category.as_str(), tokens, count),
                        None => format!("{}={}", entry.category.as_str(), tokens),
                    }
                })
                .collect::<Vec<_>>()
                .join(" ");
            rows.push(format!("  breakdown (est): {parts}"));
        }
    } else if let Some(left) = app.context_left_percent {
        rows.push(format!("  left={left}%"));
    } else {
        rows.push("  (no context measurement yet)".to_string());
    }

    // 4. Recent LLM calls
    rows.push(String::new());
    rows.push("RECENT LLM CALLS".to_string());
    let recent_calls: Vec<_> = if let Some(snapshot) = pulled {
        snapshot.recent_calls.iter().rev().take(8).collect()
    } else {
        app.telemetry.recent_calls.iter().rev().take(8).collect()
    };
    if recent_calls.is_empty() {
        rows.push("  (none)".to_string());
    } else {
        for call in recent_calls {
            let model = call
                .actual_model
                .as_deref()
                .or(call.model.as_deref())
                .unwrap_or("-");
            let tps = call
                .output_tokens_per_second
                .filter(|v| v.is_finite() && *v >= 0.0)
                .map(|v| format!("{v:.1}t/s"))
                .unwrap_or_else(|| "-".to_string());
            let ttft = call
                .timing
                .as_ref()
                .map(|t| format!("{:.0}ms", t.time_to_first_token_ms))
                .unwrap_or_else(|| "-".to_string());
            let lat = call
                .latency_ms
                .map(|v| format!("{v:.0}ms"))
                .unwrap_or_else(|| "-".to_string());
            let cache_str = call
                .cache
                .as_ref()
                .map(|c| {
                    let pct = c
                        .cache_read_ratio
                        .map(|r| format!("{:.0}%", r * 100.0))
                        .unwrap_or_else(|| "-".to_string());
                    format!("{}({pct})", c.hit_state.as_str())
                })
                .unwrap_or_else(|| "-".to_string());
            let tok = call
                .usage
                .as_ref()
                .map(|u| format!("{}/{}", u.input_tokens, u.output_tokens))
                .unwrap_or_else(|| "-".to_string());
            let cost_part = call
                .cost_usd
                .map(|usd| format!(" cost={}", format_cost(Some(usd))))
                .unwrap_or_default();
            rows.push(format!(
                "  #{} {}  tps={} ttft={} lat={} cache={} tok={}{}",
                call.seq, model, tps, ttft, lat, cache_str, tok, cost_part
            ));
        }
    }

    // 5. Recent tool timings
    rows.push(String::new());
    rows.push("RECENT TOOLS".to_string());
    if let Some(snapshot) = pulled {
        if snapshot.recent_tools.is_empty() {
            rows.push("  (none)".to_string());
        } else {
            for tool in snapshot.recent_tools.iter().rev().take(8) {
                let exec = tool
                    .exec_duration_ms
                    .map(|v| format!("{v:.0}ms"))
                    .unwrap_or_else(|| format!("{:.0}ms", tool.duration_ms));
                let wait = tool
                    .approval_wait_ms
                    .filter(|v| *v > 0.0)
                    .map(|v| format!(" wait={v:.0}ms"))
                    .unwrap_or_default();
                rows.push(format!(
                    "  {} [{}] total={:.0}ms exec={}{}",
                    tool.tool,
                    tool.status.as_str(),
                    tool.duration_ms,
                    exec,
                    wait
                ));
            }
        }
    } else if app.telemetry.recent_tools.is_empty() {
        rows.push("  (none)".to_string());
    } else {
        for tool in app.telemetry.recent_tools.iter().rev().take(8) {
            let status = if tool.is_error { "error" } else { "completed" };
            let exec = tool
                .exec_duration_ms
                .map(|v| format!("{v:.0}ms"))
                .unwrap_or_else(|| format!("{:.0}ms", tool.duration_ms));
            let wait = tool
                .approval_wait_ms
                .filter(|v| *v > 0.0)
                .map(|v| format!(" wait={v:.0}ms"))
                .unwrap_or_default();
            rows.push(format!(
                "  {} [{}] total={:.0}ms exec={}{}",
                tool.tool, status, tool.duration_ms, exec, wait
            ));
        }
    }

    // 5b. Recent compactions (if any)
    if !app.telemetry.recent_compactions.is_empty() {
        rows.push(String::new());
        rows.push("RECENT COMPACTIONS".to_string());
        for rec in app.telemetry.recent_compactions.iter().rev().take(6) {
            let status = if rec.compacted {
                "compacted"
            } else {
                "skipped"
            };
            let dur = rec
                .duration_ms
                .map(|ms| format!(" {ms:.0}ms"))
                .unwrap_or_default();
            let msgs = match (rec.messages_before, rec.messages_after) {
                (Some(b), Some(a)) => format!(" msgs:{b}->{a}"),
                _ => String::new(),
            };
            let toks = match (rec.estimated_tokens_before, rec.estimated_tokens_after) {
                (Some(b), Some(a)) => format!(" tok:{b}->{a}"),
                _ => String::new(),
            };
            rows.push(format!("  {status}{dur}{msgs}{toks}"));
        }
    }

    // 6. TUI Performance (always-on ring buffer)
    rows.push(String::new());
    rows.push("TUI PERF (ALWAYS-ON)".to_string());
    let perf = &app.perf;
    rows.push(format!(
        "  frame(last/p95/max)={:.2}/{:.2}/{:.2}ms  draw={:.2}/{:.2}/{:.2}ms  redraws={}",
        perf.frame.last_ms(),
        perf.frame.p95_ms(),
        perf.frame.max_ms(),
        perf.draw.last_ms(),
        perf.draw.p95_ms(),
        perf.draw.max_ms(),
        perf.redraw_count,
    ));
    rows.push(format!(
        "  flush(last/p95)={:.2}/{:.2}ms  effect(last/p95)={:.2}/{:.2}ms  tick(p95/max)={:.2}/{:.2}ms",
        perf.stream_flush.last_ms(),
        perf.stream_flush.p95_ms(),
        perf.effect.last_ms(),
        perf.effect.p95_ms(),
        perf.tick_total.p95_ms(),
        perf.tick_total.max_ms(),
    ));
    rows.push(format!(
        "  wrap: hit={} miss={} ({:.1}%) miss(last/max)={:.2}/{:.2}ms  rows={} (log={})",
        perf.wrap_cache_hits,
        perf.wrap_cache_misses,
        perf.wrap_hit_rate(),
        perf.wrap_miss.last_ms(),
        perf.wrap_miss.max_ms(),
        perf.wrapped_total,
        perf.log_lines_total,
    ));
    rows.push(format!(
        "  loop: rpc_lines={} cap_hits={} slow(>16ms/>50ms)={}/{}  rss(tui/rt)={}/{}",
        perf.runtime_lines_processed,
        perf.runtime_tick_cap_hits,
        perf.slow_ticks_16ms,
        perf.slow_ticks_50ms,
        format_opt_mib(perf.tui_rss_bytes),
        format_opt_mib(perf.runtime_rss_bytes),
    ));

    // 7. Runtime Perf Snapshot (from telemetry.get)
    rows.push(String::new());
    rows.push("RUNTIME PERF".to_string());
    if let Some(snapshot) = pulled {
        let rt = &snapshot.runtime;
        rows.push(format!(
            "  memory: rss={}  heap={}/{}  ext={}  ab={}",
            format_mib(rt.memory.rss_bytes),
            format_mib(rt.memory.heap_used_bytes),
            format_mib(rt.memory.heap_total_bytes),
            format_mib(rt.memory.external_bytes),
            format_mib(rt.memory.array_buffers_bytes),
        ));
        rows.push(format!(
            "  subagents={}/{}  transport_backpressure={}",
            rt.active_subagents, rt.max_concurrent_subagents, rt.backpressure_events
        ));
        if !rt.startup_phases.is_empty() {
            let phases = rt
                .startup_phases
                .iter()
                .map(|p| format!("{}={:.1}ms", p.name, p.duration_ms))
                .collect::<Vec<_>>()
                .join(" ");
            rows.push(format!("  startup: {phases}"));
        }
        if !rt.agent_init_phases.is_empty() {
            let phases = rt
                .agent_init_phases
                .iter()
                .map(|p| format!("{}={:.1}ms", p.name, p.duration_ms))
                .collect::<Vec<_>>()
                .join(" ");
            rows.push(format!("  agent_init: {phases}"));
        }
    } else if loading_runtime {
        rows.push("  (fetching runtime telemetry...)".to_string());
    } else {
        rows.push("  (runtime telemetry.get unavailable)".to_string());
    }

    let header = if loading_runtime {
        "Up/Down/PgUp/PgDn scroll  Esc/Enter close  (syncing runtime...)".to_string()
    } else {
        "Up/Down/PgUp/PgDn scroll  Esc/Enter close  (Alt+P footer bar)".to_string()
    };

    ContextPanelState {
        title: STATS_PANEL_TITLE.to_string(),
        header,
        rows,
        selected: 0,
    }
}

pub(super) fn handle_telemetry_get_response(app: &mut AppState, response: RpcResponse) {
    if let Some(error) = response.error {
        push_rpc_error(app, "telemetry.get", &error);
        return;
    }
    let Some(result) = response.result else {
        return;
    };
    let snapshot: TelemetryGetResult = match decode_result::<methods::TelemetryGet>(result) {
        Ok(result) => result,
        Err(error) => {
            super::push_protocol_mismatch(app, &error);
            return;
        }
    };
    if let Some(percent) = snapshot.context.left_percent {
        if percent.is_finite() {
            app.context_left_percent = Some(percent.clamp(0.0, 100.0).round() as u8);
        }
    }
    app.telemetry.apply_pulled_snapshot(snapshot);

    let stats_panel_open = matches!(
        &app.overlays.local_panel,
        Some(LocalPanel::Context(panel)) if panel.title == STATS_PANEL_TITLE
    );
    if stats_panel_open {
        let updated = build_stats_panel(app, false);
        if let Some(LocalPanel::Context(panel)) = &mut app.overlays.local_panel {
            let clamped = panel.selected.min(updated.rows.len().saturating_sub(1));
            panel.header = updated.header;
            panel.rows = updated.rows;
            panel.selected = clamped;
        }
    }
}

#[cfg(test)]
mod tests {
    use super::{handle_telemetry_get_response, STATS_PANEL_TITLE};
    use crate::app::handlers::command::handle_enter;
    use crate::app::handlers::runtime_response::apply_runtime_msg;
    use crate::app::runtime::{parse_runtime_output, MockRuntimeTx, RpcResponse};
    use crate::app::state::StatusLineMode;
    use crate::app::{AppState, LocalPanel, PendingRpcSlot};
    use crate::event_loop::input::handle_main_key;
    use crossterm::event::{KeyCode, KeyModifiers};
    use serde_json::json;
    use std::time::{Duration, Instant};

    #[test]
    fn perf_command_and_alt_p_toggle_live_perf_bar() {
        let mut tx = MockRuntimeTx::default();
        let mut app = AppState::default();
        assert!(!app.debug_perf_enabled);

        // Always-on perf records even when hidden.
        app.record_perf_frame(Duration::from_millis(3), Duration::from_millis(1));
        assert_eq!(app.perf.redraw_count, 1);
        assert_eq!(app.perf.frame.last_ms(), 3.0);

        // Alt+P toggles on and off.
        let mut effects = Vec::new();
        assert!(handle_main_key(
            &mut app,
            KeyCode::Char('p'),
            KeyModifiers::ALT,
            &mut tx,
            &mut effects,
            Instant::now()
        ));
        assert!(app.debug_perf_enabled);

        app.input.set_from("/perf off");
        assert!(handle_enter(&mut app, &mut tx, &mut effects));
        assert!(!app.debug_perf_enabled);

        app.input.set_from("/perf on");
        assert!(handle_enter(&mut app, &mut tx, &mut effects));
        assert!(app.debug_perf_enabled);
    }

    #[test]
    fn alt_h_cycles_info_telemetry_help() {
        let mut tx = MockRuntimeTx::default();
        let mut app = AppState::default();
        let mut effects = Vec::new();
        assert_eq!(app.status_line_mode, StatusLineMode::Info);

        for expected in [
            StatusLineMode::Telemetry,
            StatusLineMode::Help,
            StatusLineMode::Info,
        ] {
            assert!(handle_main_key(
                &mut app,
                KeyCode::Char('h'),
                KeyModifiers::ALT,
                &mut tx,
                &mut effects,
                Instant::now()
            ));
            assert_eq!(app.status_line_mode, expected);
        }
    }

    #[test]
    fn stats_and_diag_open_panel_and_refresh_on_telemetry_get_response() {
        let mut tx = MockRuntimeTx::with_id_prefix("id-");
        let mut app = AppState::default();
        app.runtime_info.supports_telemetry = true;

        app.input.set_from("/diag");
        assert!(handle_enter(&mut app, &mut tx, &mut Vec::new()));
        assert_eq!(
            app.rpc_pending.slot_id(PendingRpcSlot::TelemetryGet),
            Some("id-1")
        );
        assert_eq!(tx.sent.len(), 1);
        assert_eq!(tx.sent[0]["method"], "telemetry.get");

        let Some(LocalPanel::Context(panel)) = &mut app.overlays.local_panel else {
            panic!("expected stats panel to open immediately");
        };
        assert_eq!(panel.title, STATS_PANEL_TITLE);
        assert!(panel.rows.iter().any(|r| r.contains("fetching runtime")));
        panel.selected = 2;

        let summary = json!({
            "total_calls": 2,
            "total_tokens": 1500,
            "total_input_tokens": 1200,
            "total_output_tokens": 300,
            "total_output_reasoning_tokens": 50,
            "total_cached_input_tokens": 900,
            "total_cache_creation_tokens": 0,
            "total_input_image_tokens": 0,
            "cache_hit_calls": 2,
            "cache_miss_calls": 0,
            "cache_unknown_calls": 0,
            "total_cost_usd": 0.015,
            "retry_count": 0,
            "retry_wait_ms": 0,
            "tool_calls": 1,
            "tool_errors": 0,
            "tool_exec_ms": 42,
            "tool_approval_wait_ms": 120,
            "compaction_count": 0,
            "compaction_duration_ms": 0,
            "by_model": {}
        });
        handle_telemetry_get_response(
            &mut app,
            RpcResponse {
                id: "id-1".into(),
                result: Some(json!({
                    "session_id": "s-1",
                    "active_run_id": null,
                    "context": {
                        "provider": "openai",
                        "model": "gpt-5",
                        "limit_tokens": 128000,
                        "used_tokens": 1200,
                        "input_tokens": 1200,
                        "left_percent": 99.1,
                        "basis": "provider",
                        "breakdown": [
                            { "category": "system", "tokens": 400 },
                            { "category": "messages", "tokens": 800, "count": 4 }
                        ]
                    },
                    "session_summary": summary,
                    "run_summary": summary,
                    "recent_calls": [],
                    "recent_tools": [],
                    "runtime": {
                        "startup_phases": [{ "name": "config", "duration_ms": 4.2 }],
                        "agent_init_phases": [{ "name": "skills", "duration_ms": 8.5 }],
                        "active_subagents": 0,
                        "max_concurrent_subagents": 8,
                        "backpressure_events": 0,
                        "memory": {
                            "rss_bytes": 67108864,
                            "heap_used_bytes": 16777216,
                            "heap_total_bytes": 33554432,
                            "external_bytes": 1048576,
                            "array_buffers_bytes": 0
                        }
                    }
                })),
                error: None,
            },
        );

        let Some(LocalPanel::Context(panel)) = &app.overlays.local_panel else {
            panic!("stats panel should stay open");
        };
        assert_eq!(panel.selected, 2);
        assert!(panel
            .rows
            .iter()
            .any(|r| r.contains("startup: config=4.2ms")));
        assert!(panel
            .rows
            .iter()
            .any(|r| r.contains("agent_init: skills=8.5ms")));
        assert!(panel.rows.iter().any(|r| r.contains("cost=$0.015")));
        assert_eq!(app.context_left_percent, Some(99));
    }

    #[test]
    fn diagnostics_transcript_flag_controls_transcript_lines_from_always_on_metrics() {
        let payload = json!({
            "jsonrpc": "2.0",
            "method": "run.metrics",
            "params": {
                "run_id": "run-1",
                "seq": 1,
                "provider": "openai",
                "model": "gpt-5",
                "latency_ms": 400,
                "output_tokens_per_second": 40.0,
                "usage": { "input_tokens": 500, "output_tokens": 100, "total_tokens": 600 },
                "cache": { "hit_state": "hit", "cache_read_tokens": 250, "cache_creation_tokens": 0 }
            }
        })
        .to_string();

        let mut tx = MockRuntimeTx::default();
        let mut quiet_app = AppState::default();
        quiet_app.runtime_info.active_run_id = Some("run-1".into());
        apply_runtime_msg(&mut quiet_app, parse_runtime_output(&payload), &mut tx);
        assert!(quiet_app.log.is_empty());
        assert_eq!(quiet_app.telemetry.session_totals().calls, 1);

        let mut diag_app = AppState::default();
        diag_app.diagnostics_transcript_enabled = true;
        diag_app.runtime_info.active_run_id = Some("run-1".into());
        apply_runtime_msg(&mut diag_app, parse_runtime_output(&payload), &mut tx);
        assert_eq!(diag_app.log.len(), 1);
        assert!(diag_app.log[0].plain_text().contains("diag llm#1 gpt-5"));
        assert_eq!(diag_app.telemetry.session_totals().calls, 1);
    }
}
