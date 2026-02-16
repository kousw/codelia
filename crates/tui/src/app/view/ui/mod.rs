mod constants;
mod input;
mod layout;
mod log;
mod panels;
mod status;
mod style;
mod text;

use crate::app::{AppState, SyncPhase};
use ratatui::layout::Rect;
use ratatui::text::{Line, Text};
use ratatui::widgets::{Clear, Paragraph};

use self::constants::{INPUT_PADDING_X, INPUT_PADDING_Y, MAX_INPUT_HEIGHT, PANEL_GAP};
use self::input::{
    active_input_for_layout, compute_input_layout, masked_prompt_input, rendered_main_input,
};
use self::layout::layout_heights;
use self::log::cached_wrap_log_lines;
use self::panels::{build_panel_render, build_panel_view, render_input_panel};
use self::status::{build_debug_perf_lines, build_run_line, build_status_line};

pub(crate) use layout::desired_height;
pub(crate) use log::wrapped_log_range_to_lines;

fn update_render_visible_range(
    app: &mut AppState,
    wrapped_total: usize,
    visible_start: usize,
    visible_end: usize,
) {
    app.render_state.wrapped_total = wrapped_total;
    app.render_state.visible_start = visible_start;
    app.render_state.visible_end = visible_end;

    // Layout-only changes (e.g. confirm/prompt/input height growth) can increase
    // visible_start without any new log lines. We still need one scrollback sync pass.
    if app.scroll_from_bottom == 0
        && app.render_state.sync_phase == SyncPhase::Idle
        && visible_start > app.render_state.inserted_until
    {
        app.render_state.sync_phase = SyncPhase::NeedsInsert;
    }
}

pub fn draw_ui(f: &mut crate::app::render::custom_terminal::Frame, app: &mut AppState) {
    if app.confirm_dialog.is_some() || app.prompt_dialog.is_some() {
        app.scroll_from_bottom = 0;
    }

    let size = f.area();
    if size.width == 0 || size.height == 0 {
        return;
    }

    // Clear the whole frame every draw. `Paragraph` doesn't guarantee it overwrites every cell,
    // so without an explicit clear we can end up with "ghost" characters when scrolling or when
    // rendering shorter lines (often noticeable in code blocks).
    f.render_widget(Clear, size);

    let remaining_height = size.height;
    if remaining_height == 0 {
        return;
    }

    let (run_height, status_height, debug_height) = layout_heights(app);
    let footer_height = status_height.saturating_add(debug_height);
    let log_width = size.width as usize;
    let input_width = size.width.saturating_sub(INPUT_PADDING_X.saturating_mul(2)) as usize;
    let masked_prompt = masked_prompt_input(app);
    let rendered_main = rendered_main_input(app);
    let active_input = active_input_for_layout(app, &masked_prompt, &rendered_main);
    let input_layout = compute_input_layout(input_width.max(1), active_input, app.bang_input_mode);
    let max_input_height = remaining_height
        .saturating_sub(footer_height + INPUT_PADDING_Y.saturating_mul(2))
        .clamp(1, MAX_INPUT_HEIGHT);
    let mut input_height = (input_layout.lines.len() as u16).max(1);
    input_height = input_height.min(max_input_height);
    let base_input_total = input_height + INPUT_PADDING_Y.saturating_mul(2);
    let max_panel_height = remaining_height.saturating_sub(footer_height + run_height);
    if max_panel_height < base_input_total {
        return;
    }

    let panel_view = build_panel_view(app);
    let available_for_panel = max_panel_height.saturating_sub(base_input_total);
    let mut panel_gap_height = 0_u16;
    let mut panel_lines: Vec<Line> = Vec::new();
    if let Some(view) = panel_view.as_ref() {
        let max_lines = if available_for_panel > PANEL_GAP {
            panel_gap_height = PANEL_GAP;
            available_for_panel.saturating_sub(PANEL_GAP)
        } else {
            available_for_panel
        };
        panel_lines = build_panel_render(view, max_lines, input_width.max(1));
        if panel_lines.is_empty() {
            panel_gap_height = 0;
        }
    }
    let input_total_height = base_input_total + panel_lines.len() as u16 + panel_gap_height;

    let reserved_height = input_total_height + footer_height + run_height;
    if remaining_height < reserved_height {
        return;
    }

    // Place the input directly after the visible log lines. This avoids a large empty
    // gap between the last log line and the input when the conversation is short.
    let max_log_height = remaining_height.saturating_sub(reserved_height);
    let wrapped_total = cached_wrap_log_lines(app, log_width).len();
    let mut desired_log_height = (wrapped_total as u16).min(max_log_height);
    if desired_log_height == 0 && max_log_height > 0 && wrapped_total > 0 {
        desired_log_height = 1;
    }

    // Keep scroll stable while the user is in scrollback mode.
    if app.log_changed && app.scroll_from_bottom > 0 && app.last_wrap_width == log_width {
        let added = wrapped_total.saturating_sub(app.last_wrapped_total);
        app.scroll_from_bottom = app.scroll_from_bottom.saturating_add(added);
    }
    app.log_changed = false;
    app.last_log_viewport_height = max_log_height as usize;

    let log_height = desired_log_height as usize;
    let max_scroll = wrapped_total.saturating_sub(log_height);
    if app.scroll_from_bottom > max_scroll {
        app.scroll_from_bottom = max_scroll;
    }

    let log_area = Rect {
        x: size.x,
        y: size.y,
        width: size.width,
        height: desired_log_height,
    };
    let raw_visible_start =
        wrapped_total.saturating_sub(log_height.saturating_add(app.scroll_from_bottom));
    if app.render_state.inserted_until > wrapped_total {
        app.render_state.inserted_until = wrapped_total;
    }
    // In inline mode, never render lines that were already pushed into terminal scrollback.
    // This keeps the viewport strictly "after" the scrollback insertion boundary.
    let visible_start = raw_visible_start.max(app.render_state.inserted_until);
    let visible_end = visible_start.saturating_add(log_height).min(wrapped_total);
    update_render_visible_range(app, wrapped_total, visible_start, visible_end);

    if log_area.height > 0 {
        let visible: Vec<Line> =
            wrapped_log_range_to_lines(app, log_width, visible_start, visible_end);
        f.render_widget(Paragraph::new(Text::from(visible)), log_area);
    }

    let input_area = Rect {
        x: size.x,
        y: size.y + desired_log_height + run_height,
        width: size.width,
        height: input_total_height,
    };
    render_input_panel(
        f,
        input_area,
        &input_layout,
        &panel_lines,
        panel_gap_height,
        app.bang_input_mode,
    );

    let run_area = Rect {
        x: size.x,
        y: size.y + desired_log_height,
        width: size.width,
        height: run_height,
    };
    if run_area.height > 0 {
        let line = build_run_line(app);
        f.render_widget(Paragraph::new(Text::from(vec![line])), run_area);
    }

    let status_area = Rect {
        x: size.x,
        y: input_area.y + input_total_height,
        width: size.width,
        height: status_height,
    };
    if status_area.height > 0 {
        let line = build_status_line(app);
        f.render_widget(Paragraph::new(Text::from(vec![line])), status_area);
    }

    let debug_area = Rect {
        x: size.x,
        y: status_area.y + status_height,
        width: size.width,
        height: debug_height,
    };
    if debug_area.height > 0 {
        let mut lines = build_debug_perf_lines(app, debug_area.width as usize);
        if lines.len() > debug_area.height as usize {
            lines.truncate(debug_area.height as usize);
        }
        if !lines.is_empty() {
            f.render_widget(Paragraph::new(Text::from(lines)), debug_area);
        }
    }

    app.last_wrapped_total = wrapped_total;
    app.last_wrap_width = log_width;
    app.render_state.cursor_phase = crate::app::CursorPhase::VisibleAtComposer;
    app.assert_render_invariants();
}

#[cfg(test)]
mod tests {
    use super::update_render_visible_range;
    use crate::app::{AppState, SyncPhase};

    #[test]
    fn layout_only_visible_start_increase_requests_scrollback_sync() {
        let mut app = AppState::default();
        app.render_state.inserted_until = 4;
        app.render_state.sync_phase = SyncPhase::Idle;

        update_render_visible_range(&mut app, 20, 7, 12);

        assert_eq!(app.render_state.sync_phase, SyncPhase::NeedsInsert);
    }

    #[test]
    fn scrollback_mode_does_not_request_scrollback_sync() {
        let mut app = AppState::default();
        app.scroll_from_bottom = 2;
        app.render_state.inserted_until = 4;
        app.render_state.sync_phase = SyncPhase::Idle;

        update_render_visible_range(&mut app, 20, 7, 12);

        assert_eq!(app.render_state.sync_phase, SyncPhase::Idle);
    }
}
