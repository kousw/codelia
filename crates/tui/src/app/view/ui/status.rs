use crate::app::{AppState, ModelFastMode, StatusLineMode};
use ratatui::style::{Modifier, Style};
use ratatui::text::{Line, Span};

use super::super::theme::ui_colors;
use super::text::truncate_to_width;

pub(super) fn build_run_line(app: &AppState, width: usize) -> Line<'static> {
    let run_status = app.run_status.as_deref().unwrap_or("idle");
    let mut label = match app.spinner_frame() {
        Some(frame) => format!("{frame} {run_status}"),
        None if run_status == "awaiting_ui" => "● awaiting input".to_string(),
        None => format!("● {run_status}"),
    };
    if app.streamed_completion && !app.is_running() {
        if let Some(duration) = app.run_duration() {
            label.push_str(&format!(" · {:.1}s", duration.as_secs_f64()));
        }
    }
    let theme = ui_colors();
    let style = match run_status {
        "starting" | "running" | "awaiting_ui" => Style::default().fg(theme.run_ready_fg),
        "completed" => Style::default().fg(theme.run_completed_fg),
        "cancelled" => Style::default()
            .fg(theme.run_cancelled_fg)
            .add_modifier(theme.low_emphasis_modifier),
        "error" => Style::default()
            .fg(theme.run_error_fg)
            .add_modifier(Modifier::BOLD),
        _ => Style::default()
            .fg(theme.log_muted_fg)
            .add_modifier(theme.low_emphasis_modifier),
    };
    let mut line = Line::from(Span::styled(label, style));
    let Some(snapshot) = app.goal.snapshot(app.runtime_info.session_id.as_deref()) else {
        return line;
    };
    let (Some(goal), Some(status)) = (&snapshot.goal, app.goal.status(snapshot)) else {
        return line;
    };
    let remaining = width.saturating_sub(line.width());
    let badge = format!(" · goal {status}");
    let badge_width = unicode_width::UnicodeWidthStr::width(badge.as_str());
    if remaining < badge_width {
        return line;
    }
    let suffix = if remaining > badge_width + 3 {
        let objective = crate::app::util::sanitize_paste(&goal.objective)
            .split_whitespace()
            .collect::<Vec<_>>()
            .join(" ");
        format!(
            "{badge} · {}",
            truncate_to_width(&objective, remaining - badge_width - 3)
        )
    } else {
        badge
    };
    line.spans.push(Span::styled(
        suffix,
        Style::default().fg(theme.log_muted_fg),
    ));
    line
}

pub(super) fn build_status_line(app: &AppState) -> Line<'static> {
    let mut segments = Vec::new();
    if let Some(notice) = app.selection_notice.as_ref() {
        segments.push(notice.clone());
    }
    match app.status_line_mode {
        StatusLineMode::Info => {
            let provider = app.runtime_info.current_provider.as_deref().unwrap_or("-");
            let model = app.runtime_info.current_model.as_deref().unwrap_or("-");
            let reasoning = app.runtime_info.current_reasoning.as_deref().unwrap_or("-");
            let label = if app.runtime_info.current_model_source.as_deref() == Some("session") {
                "model~"
            } else {
                "model"
            };
            let fast = match app.runtime_info.current_fast {
                Some(ModelFastMode::Fast) => " ⚡",
                Some(ModelFastMode::Ultrafast) => " ⚡ ultrafast",
                _ => "",
            };
            segments.push(format!("{label}: {provider}/{model} [{reasoning}{fast}]"));
            if let Some(tps) = app.runtime_info.last_llm_tps {
                segments.push(format!("TPS: {tps:.1}"));
            }
            if let Some(percent) = app.context_left_percent {
                segments.push(format!("context left: {percent}%"));
            }
            let count = app.referenced_attachment_count();
            if count > 0 {
                segments.push(format!("attachments: {count}"));
            }
            if !app.in_flight_steers.is_empty() {
                segments.push(format!("steering: {}", app.in_flight_steers.len()));
            }
            if !app.pending_prompt_queue.is_empty() {
                segments.push(format!("queue: {}", app.pending_prompt_queue.len()));
            }
            if app.is_running() && app.runtime_info.supports_run_steer {
                segments.push(format!("enter: {}", app.active_run_submit_mode.label()));
            }
            if app.bang_input_mode {
                segments.push("mode: !shell".to_string());
            }
            segments.push("Alt+H help".to_string());
        }
        StatusLineMode::Telemetry => {
            let tps = app
                .telemetry
                .last_tps()
                .or(app.runtime_info.last_llm_tps)
                .map(|value| format!("{value:.1}"))
                .unwrap_or_else(|| "-".to_string());
            segments.push(format!("tps: {tps}"));
            if let Some(ttft) = app.telemetry.last_ttft_ms() {
                segments.push(format!("ttft: {}", format_compact_ms(ttft)));
            } else if let Some(lat) = app.telemetry.last_latency_ms() {
                segments.push(format!("lat: {}", format_compact_ms(lat)));
            }
            let totals = app.telemetry.session_totals();
            if let Some(ratio) = totals.cache_read_ratio() {
                segments.push(format!(
                    "cache: {ratio:.0}% ({}/{})",
                    totals.cache_hit_calls, totals.calls
                ));
            } else {
                segments.push("cache: -".to_string());
            }
            segments.push(format!(
                "tok: {}/{}",
                format_compact_count(totals.input_tokens),
                format_compact_count(totals.output_tokens)
            ));
            if let Some(cost) = totals.cost_usd {
                segments.push(format!("cost: {}", format_compact_cost(cost)));
            }
            if let Some(percent) = app.context_left_percent {
                segments.push(format!("ctx: {percent}%"));
            }
            segments.push("Alt+P perf".to_string());
            segments.push("/stats".to_string());
            segments.push("Alt+H help".to_string());
        }
        StatusLineMode::Help => {
            segments.push("! at empty input: bang mode".to_string());
            segments.push("Esc/Backspace at empty: exit !mode".to_string());
            segments.push("Ctrl+J/Shift+Enter newline".to_string());
            segments.push("Alt+V paste image/files".to_string());
            segments.push("Alt+I preview image".to_string());
            segments.push("Alt+P perf bar".to_string());
            segments.push("/stats telemetry".to_string());
            segments.push("Alt+M toggle queue/steer".to_string());
            if app.steerable_run_id().is_some() && app.steerable_prompts().next().is_some() {
                segments.push("Alt+Q select queued prompt".to_string());
            }
            segments.push("Drag log select/copy (alternate)".to_string());
            segments.push(format!(
                "F2 mouse: {}",
                if app.mouse_capture_enabled {
                    "on"
                } else {
                    "off"
                }
            ));
            segments.push("Ctrl+C cancel/quit".to_string());
            segments.push("Alt+H info".to_string());
        }
    }
    let status_text = segments.join("  •  ");
    let theme = ui_colors();
    Line::from(Span::styled(
        status_text,
        Style::default()
            .fg(theme.log_muted_fg)
            .add_modifier(theme.low_emphasis_modifier),
    ))
}

fn format_compact_count(value: u64) -> String {
    if value >= 1_000_000 {
        format!("{:.1}M", value as f64 / 1_000_000.0)
    } else if value >= 1_000 {
        format!("{:.1}k", value as f64 / 1_000.0)
    } else {
        value.to_string()
    }
}

fn format_compact_ms(ms: f64) -> String {
    if ms >= 1000.0 {
        format!("{:.2}s", ms / 1000.0)
    } else {
        format!("{ms:.0}ms")
    }
}

fn format_compact_cost(usd: f64) -> String {
    if usd < 0.01 {
        format!("${usd:.4}")
    } else {
        format!("${usd:.3}")
    }
}

fn format_memory_mib(bytes: Option<u64>) -> String {
    match bytes {
        Some(value) => format!("{:.1}", value as f64 / (1024.0 * 1024.0)),
        None => "-".to_string(),
    }
}

fn build_debug_perf_line_texts(app: &AppState) -> Vec<String> {
    if !app.debug_perf_enabled {
        return Vec::new();
    }

    let totals = app.telemetry.session_totals();
    let tps = app
        .telemetry
        .last_tps()
        .or(app.runtime_info.last_llm_tps)
        .map(|value| format!("{value:.1}"))
        .unwrap_or_else(|| "-".to_string());
    let ttft = app
        .telemetry
        .last_ttft_ms()
        .map(format_compact_ms)
        .unwrap_or_else(|| "-".to_string());
    let lat = app
        .telemetry
        .last_latency_ms()
        .map(format_compact_ms)
        .unwrap_or_else(|| "-".to_string());
    let cache = totals
        .cache_read_ratio()
        .map(|pct| format!("{pct:.0}%({}/{})", totals.cache_hit_calls, totals.calls))
        .unwrap_or_else(|| "-".to_string());
    let mut llm_line = format!(
        "llm tps:{tps} ttft:{ttft} lat:{lat} cache:{cache} tok:{}/{}",
        format_compact_count(totals.input_tokens),
        format_compact_count(totals.output_tokens),
    );
    if let Some(cost) = totals.cost_usd {
        llm_line.push_str(&format!(" cost:{}", format_compact_cost(cost)));
    }
    if let Some(percent) = app.context_left_percent {
        llm_line.push_str(&format!(" ctx:{percent}%"));
    }

    let perf = &app.perf;
    let total_memory = perf
        .tui_rss_bytes
        .and_then(|tui| perf.runtime_rss_bytes.map(|rt| tui.saturating_add(rt)));
    let tui_line = format!(
        "tui frame:{:.1}/{:.1}ms draw:{:.1}/{:.1}ms flush:{:.1}ms wrap:{:.0}%(m:{:.1}ms) slow:{}/{} mem:{}+{}={}MiB",
        perf.frame.last_ms(),
        perf.frame.p95_ms(),
        perf.draw.last_ms(),
        perf.draw.p95_ms(),
        perf.stream_flush.last_ms(),
        perf.wrap_hit_rate(),
        perf.wrap_miss.last_ms(),
        perf.slow_ticks_16ms,
        perf.slow_ticks_50ms,
        format_memory_mib(perf.tui_rss_bytes),
        format_memory_mib(perf.runtime_rss_bytes),
        format_memory_mib(total_memory),
    );

    vec![llm_line, tui_line]
}

pub(super) fn build_debug_perf_lines(app: &AppState, width: usize) -> Vec<Line<'static>> {
    if width == 0 {
        return Vec::new();
    }

    let theme = ui_colors();
    build_debug_perf_line_texts(app)
        .into_iter()
        .map(|text| {
            Line::from(Span::styled(
                truncate_to_width(&text, width),
                Style::default()
                    .fg(theme.debug_perf_fg)
                    .add_modifier(theme.low_emphasis_modifier),
            ))
        })
        .collect()
}

#[cfg(test)]
mod tests {
    use super::{build_debug_perf_line_texts, build_run_line, build_status_line};
    use crate::app::state::StatusLineMode;
    use crate::app::theme::ui_colors;
    use crate::app::AppState;
    use std::time::{Duration, Instant};

    #[test]
    fn debug_perf_lines_include_llm_and_tui_perf_summary() {
        let mut app = AppState::default();
        app.debug_perf_enabled = true;
        app.runtime_info.last_llm_tps = Some(42.5);
        app.context_left_percent = Some(78);
        app.perf
            .record_frame(Duration::from_micros(1250), Duration::from_micros(500));
        app.perf.record_wrap_hit(42, 20);
        app.perf.record_wrap_hit(42, 20);
        app.perf.record_wrap_hit(42, 20);
        app.perf.record_wrap_miss(Duration::from_millis(2), 42, 20);
        app.perf.tui_rss_bytes = Some(8 * 1024 * 1024);
        app.perf.runtime_rss_bytes = Some(12 * 1024 * 1024);

        let lines = build_debug_perf_line_texts(&app);
        assert_eq!(lines.len(), 2);
        assert!(lines[0].contains("llm tps:42.5"));
        assert!(lines[0].contains("ctx:78%"));
        assert!(lines[1].contains("wrap:75%"));
        assert!(lines[1].contains("mem:8.0+12.0=20.0MiB"));
    }

    #[test]
    fn status_line_telemetry_mode_displays_compact_metrics() {
        let mut app = AppState::default();
        app.status_line_mode = StatusLineMode::Telemetry;
        app.runtime_info.last_llm_tps = Some(51.4);
        app.context_left_percent = Some(64);
        let text = build_status_line(&app).to_string();
        assert!(text.contains("tps: 51.4"));
        assert!(text.contains("ctx: 64%"));
        assert!(text.contains("Alt+P perf"));
        assert!(text.contains("/stats"));
    }

    #[test]
    fn debug_perf_lines_hide_when_disabled() {
        let app = AppState::default();
        assert!(build_debug_perf_line_texts(&app).is_empty());
    }

    #[test]
    fn status_line_shows_latest_completed_call_tps_when_available() {
        let mut app = AppState::default();
        assert!(!build_status_line(&app).spans[0].content.contains("TPS:"));
        app.runtime_info.last_llm_tps = Some(42.25);
        assert!(build_status_line(&app).spans[0]
            .content
            .contains("TPS: 42.2"));
    }

    #[test]
    fn idle_and_status_lines_use_explicit_muted_foreground() {
        let app = AppState::default();
        let expected = Some(ui_colors().log_muted_fg);

        assert_eq!(build_run_line(&app, 80).spans[0].style.fg, expected);
        assert_eq!(build_status_line(&app).spans[0].style.fg, expected);
    }

    #[test]
    fn run_line_pulses_at_constant_width_and_pauses_for_input() {
        let mut app = AppState::default();
        let start = Instant::now();
        assert!(!app.update_spinner(start));
        app.update_run_status("running".to_string());
        let first_frame = build_run_line(&app, 80);
        assert_eq!(first_frame.to_string(), "⣶⣄⣀ running");
        assert!(!app.update_spinner(start + Duration::from_millis(119)));

        let mut previous_frame = first_frame.to_string();
        for step in 1..=8 {
            assert!(app.update_spinner(start + Duration::from_millis(120 * step)));
            let frame = build_run_line(&app, 80);
            assert_ne!(frame.to_string(), previous_frame);
            assert_eq!(frame.width(), first_frame.width());
            previous_frame = frame.to_string();
        }

        app.update_run_status("awaiting_ui".to_string());
        let resumed_at = start + Duration::from_secs(2);
        assert!(!app.update_spinner(resumed_at));
        assert_eq!(build_run_line(&app, 80).to_string(), "● awaiting input");

        app.update_run_status("running".to_string());
        assert_eq!(build_run_line(&app, 80), first_frame);
        assert!(app.update_spinner(resumed_at + Duration::from_millis(120)));

        app.update_run_status("cancelled".to_string());
        assert!(!app.update_spinner(start + Duration::from_secs(3)));
        assert_eq!(build_run_line(&app, 80).to_string(), "● cancelled");
    }

    #[test]
    fn selection_notice_is_visible_in_info_mode() {
        let app = AppState {
            status_line_mode: StatusLineMode::Info,
            selection_notice: Some("Copied 4 chars".to_string()),
            ..AppState::default()
        };

        assert!(build_status_line(&app).spans[0]
            .content
            .starts_with("Copied 4 chars"));
    }

    #[test]
    fn selection_notice_is_visible_in_help_mode() {
        let app = AppState {
            status_line_mode: StatusLineMode::Help,
            selection_notice: Some("Copy failed: unavailable".to_string()),
            ..AppState::default()
        };

        assert!(build_status_line(&app).spans[0]
            .content
            .starts_with("Copy failed: unavailable"));
    }
}

#[cfg(test)]
mod fast_mode_tests {
    use super::*;
    #[test]
    fn status_distinguishes_ultrafast_from_fast() {
        let mut app = AppState::default();
        app.status_line_mode = StatusLineMode::Info;
        app.runtime_info.current_fast = Some(ModelFastMode::Ultrafast);
        assert!(build_status_line(&app).to_string().contains("ultrafast"));
        app.runtime_info.current_fast = Some(ModelFastMode::Fast);
        let fast = build_status_line(&app).to_string();
        assert!(fast.contains('⚡'));
        assert!(!fast.contains("ultrafast"));
    }

    #[test]
    fn status_line_shows_steer_mode_and_in_flight_count_while_running() {
        use crate::app::{ActiveRunSubmitMode, InFlightSteer, PendingPromptRun};
        use serde_json::json;
        use std::time::Instant;

        let mut app = AppState::default();
        app.runtime_info.supports_run_steer = true;
        app.update_run_status("running".to_string());
        app.active_run_submit_mode = ActiveRunSubmitMode::Steer;
        app.in_flight_steers.push_back(InFlightSteer {
            client_steer_id: "cs-1".to_string(),
            server_steer_id: Some("s1".to_string()),
            unverified_steer_id: None,
            run_id: "run-1".to_string(),
            submitted_at: Instant::now(),
            submission: PendingPromptRun {
                seq: 1,
                queue_id: String::new(),
                queued_at: Instant::now(),
                preview: "steer".to_string(),
                user_text: "steer".to_string(),
                display_text: "steer".to_string(),
                image_descriptions: Vec::new(),
                input_payload: json!({"type":"text","text":"steer"}),
                attachment_count: 0,
                files: Default::default(),
                shell_result_count: 0,
                dispatch_attempts: 0,
            },
        });
        let text = build_status_line(&app).to_string();
        assert!(text.contains("steering: 1"));
        assert!(text.contains("enter: steer"));
    }
}
