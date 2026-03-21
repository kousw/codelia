use crate::app::util::text::wrap_line;
use crate::app::{ConfirmDialogState, PickDialogState, PromptDialogState};

use super::types::PanelView;

const MAX_COMPACT_CONFIRM_PREVIEW_LINES: usize = 3;
const MAX_COMPACT_CONFIRM_LINE_CHARS: usize = 72;
const TRUNCATION_SUFFIX: &str = "...";
const COMMAND_PREFIX: &str = "Command: ";
const REMEMBER_HEADER: &str = "Remember (don't ask again):";

fn split_confirm_message_sections(message: &str) -> (Vec<String>, Vec<String>) {
    let mut lines = message
        .lines()
        .map(|raw_line| raw_line.trim_end_matches('\r').to_string())
        .collect::<Vec<_>>();

    if let Some(remember_index) = lines.iter().rposition(|line| line == REMEMBER_HEADER) {
        let mut command = lines[..remember_index].to_vec();
        while command.last().is_some_and(|line| line.is_empty()) {
            command.pop();
        }

        let mut remainder = lines.split_off(remember_index);
        while remainder.first().is_some_and(|line| line.is_empty()) {
            remainder.remove(0);
        }
        while remainder.last().is_some_and(|line| line.is_empty()) {
            remainder.pop();
        }
        return (command, remainder);
    }

    while lines.last().is_some_and(|line| line.is_empty()) {
        lines.pop();
    }
    (lines, Vec::new())
}

fn build_compact_confirm_preview(message: &str) -> Option<(Vec<String>, Vec<String>, bool)> {
    let (paragraph_lines, remainder_lines) = split_confirm_message_sections(message);
    if paragraph_lines.is_empty() {
        return None;
    }

    let mut wrapped_command_rows = Vec::new();
    let first_row_width = MAX_COMPACT_CONFIRM_LINE_CHARS.saturating_sub(COMMAND_PREFIX.len());
    for line in paragraph_lines {
        let width = if wrapped_command_rows.is_empty() {
            first_row_width.max(1)
        } else {
            MAX_COMPACT_CONFIRM_LINE_CHARS
        };
        let mut rows = wrap_line(&line, width);
        if wrapped_command_rows.is_empty() {
            if let Some(first) = rows.first_mut() {
                *first = format!("{COMMAND_PREFIX}{first}");
            } else {
                rows.push(COMMAND_PREFIX.trim_end().to_string());
            }
        }
        wrapped_command_rows.extend(rows);
    }
    if wrapped_command_rows.is_empty() {
        return None;
    }

    let command_omitted = wrapped_command_rows.len() > MAX_COMPACT_CONFIRM_PREVIEW_LINES;
    let mut preview_lines = if command_omitted {
        wrapped_command_rows
            .into_iter()
            .take(MAX_COMPACT_CONFIRM_PREVIEW_LINES.saturating_sub(1))
            .collect::<Vec<_>>()
    } else {
        wrapped_command_rows
    };
    if command_omitted {
        preview_lines.push(TRUNCATION_SUFFIX.to_string());
    }

    Some((preview_lines, remainder_lines, command_omitted))
}

fn build_confirm_detail_toggle_hint(
    panel: &ConfirmDialogState,
    command_omitted: bool,
) -> Option<String> {
    if panel.command_view {
        return Some("[D / Esc to return]".to_string());
    }
    if !(panel.allow_remember || panel.allow_reason) || !command_omitted {
        return None;
    }
    Some("[D to review full command]".to_string())
}

fn build_command_review_lines(message: &str) -> Vec<String> {
    let (paragraph_lines, _) = split_confirm_message_sections(message);
    if paragraph_lines.is_empty() {
        return vec!["Command unavailable.".to_string()];
    }
    let mut lines = Vec::with_capacity(paragraph_lines.len() + 2);
    lines.push("Command review:".to_string());
    lines.push(String::new());
    lines.extend(paragraph_lines);
    lines
}

pub(super) fn build_confirm_panel_view(panel: &ConfirmDialogState) -> PanelView {
    let mut lines = Vec::new();
    let mut title = panel.title.clone();
    if panel.danger_level.as_deref() == Some("danger") {
        title = format!("DANGER: {title}");
    }

    if panel.command_view {
        lines.extend(build_command_review_lines(&panel.message));
        if let Some(toggle_hint) = build_confirm_detail_toggle_hint(panel, true) {
            if !lines.is_empty() {
                lines.push(String::new());
            }
            lines.push(toggle_hint);
        }
        return PanelView {
            title: Some(title),
            lines,
            header_index: None,
            selected: None,
            wrap_lines: true,
            tail_pinned_from: None,
        };
    }

    let use_compact_preview = panel.allow_remember || panel.allow_reason;
    let mut compact_detail_start = None;
    let mut command_omitted = false;
    let command_preview = if use_compact_preview {
        let compact = build_compact_confirm_preview(&panel.message);
        if let Some((preview_lines, detail_lines, omitted)) = compact.as_ref() {
            lines.extend(preview_lines.iter().cloned());
            command_omitted = *omitted;
            if let Some(toggle_hint) = build_confirm_detail_toggle_hint(panel, command_omitted) {
                lines.push(toggle_hint);
            }
            if !detail_lines.is_empty() {
                lines.push(String::new());
                compact_detail_start = Some(lines.len());
                lines.extend(detail_lines.iter().cloned());
            }
        } else if !panel.message.trim().is_empty() {
            lines.extend(panel.message.lines().map(|line| line.to_string()));
        }
        compact.map(|(preview_lines, _, _)| preview_lines)
    } else {
        let preview = panel
            .message
            .lines()
            .find(|line| !line.trim().is_empty())
            .map(|line| line.to_string());
        if !panel.message.trim().is_empty() {
            lines.extend(panel.message.lines().map(|line| line.to_string()));
        }
        preview.map(|line| vec![line])
    };

    if !use_compact_preview {
        if let Some(toggle_hint) = build_confirm_detail_toggle_hint(panel, command_omitted) {
            if !lines.is_empty() {
                lines.push(String::new());
            }
            lines.push(toggle_hint);
        }
        if !lines.is_empty() {
            lines.push(String::new());
        }
    }
    if let Some(preview) = command_preview
        .as_ref()
        .filter(|_| !use_compact_preview && !(panel.allow_remember || panel.allow_reason))
    {
        lines.push(format!("Command: {}", preview[0]));
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
        tail_pinned_from: Some(if use_compact_preview {
            compact_detail_start.unwrap_or(option_start)
        } else if command_preview.is_some() {
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

#[cfg(test)]
mod tests {
    use super::build_confirm_panel_view;
    use crate::app::{ConfirmDialogState, ConfirmMode};

    fn confirm_dialog(
        message: &str,
        allow_remember: bool,
        allow_reason: bool,
    ) -> ConfirmDialogState {
        ConfirmDialogState {
            id: "confirm-1".to_string(),
            title: "Run command?".to_string(),
            message: message.to_string(),
            danger_level: None,
            confirm_label: "Allow".to_string(),
            cancel_label: "Deny".to_string(),
            allow_remember,
            allow_reason,
            command_view: false,
            selected: 0,
            mode: ConfirmMode::Select,
        }
    }

    #[test]
    fn permission_confirm_preview_is_compacted_and_tail_pins_options() {
        let panel = confirm_dialog(
            "printf 'line1'\nprintf 'line2'\nprintf 'line3'\nprintf 'line4'\n\nRemember (don't ask again):\n- shell: printf\n- shell: printf line2",
            true,
            true,
        );

        let view = build_confirm_panel_view(&panel);

        assert_eq!(view.lines[0], "Command: printf 'line1'");
        assert_eq!(view.lines[1], "printf 'line2'",);
        assert_eq!(view.lines[2], "...",);
        assert_eq!(view.lines[3], "[D to review full command]");
        assert_eq!(view.lines[5], "Remember (don't ask again):");
        assert_eq!(view.lines[6], "- shell: printf");
        assert_eq!(view.lines[7], "- shell: printf line2");
        assert_eq!(view.lines[8], "1. Allow");
        assert_eq!(view.tail_pinned_from, Some(5));
    }

    #[test]
    fn long_single_line_command_wraps_into_preview_rows_before_ellipsis() {
        let panel = confirm_dialog(
            "python3 -c \"import json; data = {'alpha': 1, 'beta': [1, 2, 3], 'gamma': 'a long command that should wrap into preview rows before being omitted'}; print(json.dumps(data))\"\n\nRemember (don't ask again):\n- shell: python3",
            true,
            true,
        );

        let view = build_confirm_panel_view(&panel);

        assert!(view.lines[0].starts_with("Command: python3 -c \"import json;"));
        assert_ne!(view.lines[1], "...");
        assert_ne!(view.lines[2], "...");
        assert!(view
            .lines
            .iter()
            .all(|line| line != "[D to review full command]"));
    }

    #[test]
    fn compact_preview_preserves_repeated_spaces_and_tabs() {
        let panel = confirm_dialog(
            "python3 -c \"print('a  b\t c')\"\n\nRemember (don't ask again):\n- shell: python3",
            true,
            true,
        );

        let view = build_confirm_panel_view(&panel);

        assert!(view.lines[0].contains("a  b\t c"));
        assert!(view
            .lines
            .iter()
            .all(|line| line != "[D to review full command]"));
    }

    #[test]
    fn command_review_preserves_blank_lines_before_remember_section() {
        let mut panel = confirm_dialog(
            "python3 - <<'PY'\nprint('alpha')\n\nprint('beta')\nPY\n\nRemember (don't ask again):\n- shell: python3",
            true,
            true,
        );
        panel.command_view = true;

        let view = build_confirm_panel_view(&panel);

        assert_eq!(view.lines[2], "python3 - <<'PY'");
        assert_eq!(view.lines[3], "print('alpha')");
        assert_eq!(view.lines[4], "");
        assert_eq!(view.lines[5], "print('beta')");
        assert_eq!(view.lines[6], "PY");
        assert!(view
            .lines
            .iter()
            .all(|line| line != "Remember (don't ask again):"));
    }

    #[test]
    fn permission_confirm_command_view_uses_panel_for_command_only() {
        let mut panel = confirm_dialog(
            "printf 'line1'\nprintf 'line2'\n\nRemember (don't ask again):\n- shell: printf",
            true,
            true,
        );
        panel.command_view = true;

        let view = build_confirm_panel_view(&panel);

        assert_eq!(view.lines[0], "Command review:");
        assert_eq!(view.lines[2], "printf 'line1'");
        assert_eq!(view.lines[3], "printf 'line2'");
        assert!(view.lines.iter().all(|line| line != "1. Allow"));
        assert!(view
            .lines
            .iter()
            .all(|line| line != "Remember (don't ask again):"));
        assert_eq!(view.lines[5], "[D / Esc to return]");
        assert_eq!(view.selected, None);
        assert_eq!(view.tail_pinned_from, None);
    }

    #[test]
    fn generic_confirm_keeps_full_multiline_message() {
        let panel = confirm_dialog("First line\nSecond line", false, false);

        let view = build_confirm_panel_view(&panel);

        assert_eq!(view.lines[0], "First line");
        assert_eq!(view.lines[1], "Second line");
        assert_eq!(view.lines[3], "Command: First line");
        assert_eq!(view.lines[5], "1. Allow");
        assert_eq!(view.tail_pinned_from, Some(3));
    }
}
