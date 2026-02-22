use crate::app::AppState;

use super::constants::{DEBUG_PANEL_HEIGHT, INPUT_PADDING_Y, MAX_INPUT_HEIGHT, PANEL_GAP};
use super::input::{
    active_input_for_layout, compute_input_layout, masked_prompt_input, rendered_main_input,
};
use super::log::cached_wrap_log_lines;
use super::panels::{build_panel_render, build_panel_view};

pub(super) fn layout_heights(app: &AppState) -> (u16, u16, u16) {
    let modal_active = app.confirm_dialog.is_some() || app.prompt_dialog.is_some();
    if modal_active {
        return (0, 0, 0);
    }
    let run_height = 2_u16;
    let status_height = 1_u16;
    let debug_height = if app.debug_perf_enabled {
        DEBUG_PANEL_HEIGHT
    } else {
        0
    };
    (run_height, status_height, debug_height)
}

pub(crate) fn desired_height(app: &mut AppState, width: u16, height: u16) -> u16 {
    if width == 0 || height == 0 {
        return 0;
    }

    let remaining_height = height;

    let (run_height, status_height, debug_height) = layout_heights(app);
    let footer_height = status_height.saturating_add(debug_height);
    let input_width =
        width.saturating_sub(super::constants::INPUT_PADDING_X.saturating_mul(2)) as usize;
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
        return height;
    }

    let panel_view = build_panel_view(app);
    let available_for_panel = max_panel_height.saturating_sub(base_input_total);
    let mut panel_gap_height = 0_u16;
    let mut panel_line_count = 0_u16;
    if let Some(view) = panel_view.as_ref() {
        let max_lines = if available_for_panel > PANEL_GAP {
            panel_gap_height = PANEL_GAP;
            available_for_panel.saturating_sub(PANEL_GAP)
        } else {
            available_for_panel
        };
        panel_line_count = build_panel_render(view, max_lines, input_width.max(1)).len() as u16;
        if panel_line_count == 0 {
            panel_gap_height = 0;
        }
    }
    let input_total_height = base_input_total + panel_line_count + panel_gap_height;

    let reserved_height = input_total_height + footer_height + run_height;
    if remaining_height < reserved_height {
        return height;
    }

    let max_log_height = remaining_height.saturating_sub(reserved_height);
    let wrapped_total = cached_wrap_log_lines(app, width as usize).len();
    let mut desired_log_height = (wrapped_total as u16).min(max_log_height);
    if desired_log_height == 0 && max_log_height > 0 && wrapped_total > 0 {
        desired_log_height = 1;
    }

    let total = desired_log_height
        .saturating_add(run_height)
        .saturating_add(input_total_height)
        .saturating_add(footer_height);
    total.min(height).max(1)
}
