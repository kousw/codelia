use ratatui::style::Color;

use super::super::theme::ui_colors;

pub(super) const MAX_INPUT_HEIGHT: u16 = 6;
pub(super) const INPUT_PADDING_X: u16 = 2;
pub(super) const INPUT_PADDING_Y: u16 = 1;
pub(super) const PANEL_GAP: u16 = 1;
pub(super) const DEBUG_PANEL_HEIGHT: u16 = 2;

pub(super) fn input_bg() -> Color {
    ui_colors().input_bg
}
