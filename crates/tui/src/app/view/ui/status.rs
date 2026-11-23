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
        StatusLineMode::Help => {
            segments.push("! at empty input: bang mode".to_string());
            segments.push("Esc/Backspace at empty: exit !mode".to_string());
            segments.push("Ctrl+J/Shift+Enter newline".to_string());
            segments.push("Alt+V paste image/files".to_string());
            segments.push("Alt+I preview image".to_string());
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

fn format_memory_bytes(bytes: Option<u64>) -> String {
    match bytes {
        Some(value) => {
            let mib = value as f64 / (1024.0 * 1024.0);
            format!("{mib:.1} MiB")
        }
        None => "-".to_string(),
    }
}

fn build_debug_perf_line_texts(app: &AppState) -> Vec<String> {
    if !app.debug_perf_enabled {
        return Vec::new();
    }

    let hits = app.perf_debug.wrap_cache_hits;
    let misses = app.perf_debug.wrap_cache_misses;
    let total = hits.saturating_add(misses);
    let hit_rate = if total == 0 {
        0.0
    } else {
        (hits as f64 * 100.0) / total as f64
    };
    let total_memory = app.perf_debug.tui_rss_bytes.and_then(|tui| {
        app.perf_debug
            .runtime_rss_bytes
            .map(|runtime| tui.saturating_add(runtime))
    });

    vec![
        format!(
            "perf frame:{:.2}ms draw:{:.2}ms wrap_miss:{:.2}ms wrapped:{}",
            app.perf_debug.frame_last_ms,
            app.perf_debug.draw_last_ms,
            app.perf_debug.wrap_last_miss_ms,
            app.perf_debug.wrapped_total
        ),
        format!(
            "cache hit:{} miss:{} rate:{:.1}% redraw:{}",
            hits, misses, hit_rate, app.perf_debug.redraw_count
        ),
        format!(
            "mem tui:{} runtime:{} total:{}",
            format_memory_bytes(app.perf_debug.tui_rss_bytes),
            format_memory_bytes(app.perf_debug.runtime_rss_bytes),
            format_memory_bytes(total_memory)
        ),
    ]
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
    fn debug_perf_lines_include_memory_summary() {
        let mut app = AppState::default();
        app.debug_perf_enabled = true;
        app.perf_debug.frame_last_ms = 1.25;
        app.perf_debug.draw_last_ms = 0.5;
        app.perf_debug.wrap_last_miss_ms = 2.0;
        app.perf_debug.wrap_cache_hits = 3;
        app.perf_debug.wrap_cache_misses = 1;
        app.perf_debug.redraw_count = 7;
        app.perf_debug.wrapped_total = 42;
        app.perf_debug.tui_rss_bytes = Some(8 * 1024 * 1024);
        app.perf_debug.runtime_rss_bytes = Some(12 * 1024 * 1024);

        let lines = build_debug_perf_line_texts(&app);
        assert_eq!(lines.len(), 3);
        assert_eq!(lines[2], "mem tui:8.0 MiB runtime:12.0 MiB total:20.0 MiB");
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
