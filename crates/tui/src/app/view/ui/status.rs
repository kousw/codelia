use crate::app::{AppState, StatusLineMode};
use ratatui::style::{Modifier, Style};
use ratatui::text::{Line, Span};

use super::super::theme::ui_colors;
use super::text::truncate_to_width;

pub(super) fn build_run_line(app: &AppState) -> Line<'static> {
    let run_status = app.run_status.as_deref().unwrap_or("idle");
    let label = if app.is_running() {
        format!("● {run_status} {}", app.spinner_frame())
    } else {
        format!("● {run_status}")
    };
    let theme = ui_colors();
    let style = match run_status {
        "starting" | "running" | "awaiting_ui" => Style::default().fg(theme.run_ready_fg),
        "completed" => Style::default().fg(theme.run_completed_fg),
        "cancelled" => Style::default()
            .fg(theme.run_cancelled_fg)
            .add_modifier(Modifier::DIM),
        "error" => Style::default()
            .fg(theme.run_error_fg)
            .add_modifier(Modifier::BOLD),
        _ => Style::default().add_modifier(Modifier::DIM),
    };
    Line::from(Span::styled(label, style))
}

pub(super) fn build_status_line(app: &AppState) -> Line<'static> {
    let mut segments = Vec::new();
    match app.status_line_mode {
        StatusLineMode::Info => {
            let provider = app.current_provider.as_deref().unwrap_or("-");
            let model = app.current_model.as_deref().unwrap_or("-");
            segments.push(format!("model: {provider}/{model}"));
            if let Some(percent) = app.context_left_percent {
                segments.push(format!("context left: {percent}%"));
            }
            let image_count = app.referenced_attachment_count();
            if image_count > 0 {
                segments.push(format!("images: {image_count}"));
            }
            if !app.pending_prompt_queue.is_empty() {
                segments.push(format!("queue: {}", app.pending_prompt_queue.len()));
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
            segments.push("Alt+V paste image".to_string());
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
    Line::from(Span::styled(
        status_text,
        Style::default().add_modifier(Modifier::DIM),
    ))
}

pub(super) fn build_debug_perf_lines(app: &AppState, width: usize) -> Vec<Line<'static>> {
    if !app.debug_perf_enabled || width == 0 {
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

    let line1_raw = format!(
        "perf frame:{:.2}ms draw:{:.2}ms wrap_miss:{:.2}ms wrapped:{}",
        app.perf_debug.frame_last_ms,
        app.perf_debug.draw_last_ms,
        app.perf_debug.wrap_last_miss_ms,
        app.perf_debug.wrapped_total
    );
    let line1 = truncate_to_width(&line1_raw, width);
    let line2_raw = format!(
        "cache hit:{} miss:{} rate:{:.1}% redraw:{}",
        hits, misses, hit_rate, app.perf_debug.redraw_count
    );
    let line2 = truncate_to_width(&line2_raw, width);

    let debug_fg = ui_colors().debug_perf_fg;
    vec![
        Line::from(Span::styled(
            line1,
            Style::default().fg(debug_fg).add_modifier(Modifier::DIM),
        )),
        Line::from(Span::styled(
            line2,
            Style::default().fg(debug_fg).add_modifier(Modifier::DIM),
        )),
    ]
}
