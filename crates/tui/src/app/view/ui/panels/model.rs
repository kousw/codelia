use crate::app::{ModelListPanelState, ModelListViewMode};

use super::types::PanelView;

pub(super) fn build_model_list_panel_view(panel: &ModelListPanelState) -> PanelView {
    let (header, rows) = match panel.view_mode {
        ModelListViewMode::Limits => (&panel.header_limits, &panel.rows_limits),
        ModelListViewMode::Cost => (&panel.header_cost, &panel.rows_cost),
    };
    let mut lines = Vec::with_capacity(rows.len().saturating_add(1));
    lines.push(header.clone());
    lines.extend(rows.iter().cloned());
    let selected = if rows.is_empty() {
        None
    } else {
        Some(panel.selected.saturating_add(1))
    };
    PanelView {
        title: Some(format!(
            "{} [view: {} | Tab switch]",
            panel.title,
            panel.view_mode.label()
        )),
        lines,
        header_index: Some(0),
        selected,
        wrap_lines: true,
        tail_pinned_from: None,
    }
}
