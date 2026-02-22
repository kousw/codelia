use crate::app::{
    ContextPanelState, LaneListPanelState, SessionListPanelState, SkillsListPanelState,
    ThemeListPanelState,
};

use super::types::PanelView;

pub(super) fn build_session_list_panel_view(panel: &SessionListPanelState) -> PanelView {
    let mut lines = Vec::with_capacity(panel.rows.len().saturating_add(1));
    lines.push(panel.header.clone());
    lines.extend(panel.rows.iter().cloned());
    let selected = if panel.rows.is_empty() {
        None
    } else {
        Some(panel.selected.saturating_add(1))
    };
    PanelView {
        title: Some(panel.title.clone()),
        lines,
        header_index: Some(0),
        selected,
        wrap_lines: true,
        tail_pinned_from: None,
    }
}

pub(super) fn build_context_panel_view(panel: &ContextPanelState) -> PanelView {
    let mut lines = Vec::with_capacity(panel.rows.len().saturating_add(1));
    lines.push(panel.header.clone());
    lines.extend(panel.rows.iter().cloned());
    let selected = if panel.rows.is_empty() {
        None
    } else {
        Some(panel.selected.saturating_add(1))
    };
    PanelView {
        title: Some(panel.title.clone()),
        lines,
        header_index: Some(0),
        selected,
        wrap_lines: true,
        tail_pinned_from: None,
    }
}

pub(super) fn build_lane_list_panel_view(panel: &LaneListPanelState) -> PanelView {
    let mut lines = Vec::with_capacity(panel.rows.len().saturating_add(1));
    lines.push(panel.header.clone());
    lines.extend(panel.rows.iter().cloned());
    let selected = if panel.rows.is_empty() {
        None
    } else {
        Some(panel.selected.saturating_add(1))
    };
    PanelView {
        title: Some(panel.title.clone()),
        lines,
        header_index: Some(0),
        selected,
        wrap_lines: true,
        tail_pinned_from: None,
    }
}

pub(super) fn build_skills_list_panel_view(panel: &SkillsListPanelState) -> PanelView {
    let mut lines = Vec::with_capacity(panel.rows.len().saturating_add(1));
    lines.push(panel.header.clone());
    lines.extend(panel.rows.iter().cloned());
    let selected = if panel.rows.is_empty() {
        None
    } else {
        Some(panel.selected.saturating_add(1))
    };
    PanelView {
        title: Some(panel.title.clone()),
        lines,
        header_index: Some(0),
        selected,
        wrap_lines: true,
        tail_pinned_from: None,
    }
}

pub(super) fn build_theme_list_panel_view(panel: &ThemeListPanelState) -> PanelView {
    let mut lines = Vec::with_capacity(panel.rows.len().saturating_add(1));
    lines.push(panel.header.clone());
    lines.extend(panel.rows.iter().cloned());
    let selected = if panel.rows.is_empty() {
        None
    } else {
        Some(panel.selected.saturating_add(1))
    };
    PanelView {
        title: Some(panel.title.clone()),
        lines,
        header_index: Some(0),
        selected,
        wrap_lines: true,
        tail_pinned_from: None,
    }
}
