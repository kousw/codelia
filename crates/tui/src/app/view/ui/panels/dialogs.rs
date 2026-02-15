use crate::app::{ConfirmDialogState, PickDialogState, PromptDialogState};

use super::types::PanelView;

pub(super) fn build_confirm_panel_view(panel: &ConfirmDialogState) -> PanelView {
    let mut lines = Vec::new();
    let mut title = panel.title.clone();
    if panel.danger_level.as_deref() == Some("danger") {
        title = format!("DANGER: {title}");
    }
    let command_preview = panel
        .message
        .lines()
        .find(|line| !line.trim().is_empty())
        .map(|line| line.to_string());
    if !panel.message.trim().is_empty() {
        lines.extend(panel.message.lines().map(|line| line.to_string()));
    }
    lines.push(String::new());
    if let Some(preview) = command_preview.as_ref() {
        lines.push(format!("Command: {preview}"));
        lines.push(String::new());
    }
    let option_start = lines.len();
    lines.push(format!("1. {}", panel.confirm_label));
    if panel.allow_remember {
        lines.push(format!("2. {} (don't ask again)", panel.confirm_label));
        let cancel_line = if panel.allow_reason {
            format!("3. {} (Tab to add reason)", panel.cancel_label)
        } else {
            format!("3. {}", panel.cancel_label)
        };
        lines.push(cancel_line);
    } else {
        let cancel_line = if panel.allow_reason {
            format!("2. {} (Tab to add reason)", panel.cancel_label)
        } else {
            format!("2. {}", panel.cancel_label)
        };
        lines.push(cancel_line);
    }
    if panel.allow_reason && panel.mode == crate::app::ConfirmMode::Reason {
        lines.push(String::new());
        lines.push("Reason input active (Enter to deny, Tab to return)".to_string());
    }
    let max_index = if panel.allow_remember { 2 } else { 1 };
    PanelView {
        title: Some(title),
        lines,
        header_index: None,
        selected: Some(option_start + panel.selected.min(max_index)),
        wrap_lines: true,
        tail_pinned_from: Some(if command_preview.is_some() {
            option_start.saturating_sub(2)
        } else {
            option_start
        }),
    }
}

pub(super) fn build_prompt_panel_view(panel: &PromptDialogState) -> PanelView {
    let mut lines = Vec::new();
    if !panel.message.trim().is_empty() {
        lines.extend(panel.message.lines().map(|line| line.to_string()));
    }
    lines.push(String::new());
    let hint = if panel.multiline {
        "Enter to submit, Shift+Enter newline"
    } else {
        "Enter to submit"
    };
    lines.push(hint.to_string());
    PanelView {
        title: Some(panel.title.clone()),
        lines,
        header_index: None,
        selected: None,
        wrap_lines: true,
        tail_pinned_from: None,
    }
}

pub(super) fn build_pick_panel_view(panel: &PickDialogState) -> PanelView {
    let mut lines = Vec::with_capacity(panel.items.len());
    for (idx, item) in panel.items.iter().enumerate() {
        let check = if panel.multi {
            if panel.chosen.get(idx).copied().unwrap_or(false) {
                "[x]"
            } else {
                "[ ]"
            }
        } else {
            "   "
        };
        let detail = item
            .detail
            .as_ref()
            .map(|text| format!(" - {text}"))
            .unwrap_or_default();
        lines.push(format!("{check} {}{detail}", item.label));
    }
    PanelView {
        title: Some(panel.title.clone()),
        lines,
        header_index: None,
        selected: Some(panel.selected),
        wrap_lines: true,
        tail_pinned_from: None,
    }
}
