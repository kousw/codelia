use crate::app::state::{
    LaneActionPickerState, ShellRulePicker, ShellRulePickerState, UpdatePickerState,
};
use crate::app::util::text::wrap_line;
use crate::app::{
    ConfirmDialogState, PickDialogItem, PromptDialogState, RuntimePickList, RuntimePickListKind,
};
use ratatui::text::Line;

use super::super::text::truncate_to_width;
use super::render::build_panel_render;
use super::types::PanelView;

const MAX_COMPACT_CONFIRM_PREVIEW_LINES: usize = 3;
const MAX_COMPACT_CONFIRM_LINE_CHARS: usize = 72;
const TRUNCATION_SUFFIX: &str = "...";
const COMMAND_PREFIX: &str = "Command: ";
const ALLOWANCE_PREFIX: &str = "Future allowance: ";
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

pub(super) fn build_runtime_pick_list_view(panel: &RuntimePickList) -> PanelView {
    let approval = matches!(panel.kind, RuntimePickListKind::Approval { .. });
    let shell_approval = approval
        && panel
            .message
            .as_deref()
            .is_some_and(is_shell_approval_message);
    let message = panel
        .message
        .as_deref()
        .filter(|message| !shell_approval && !message.trim().is_empty());
    let visible_message = if approval {
        message.map(visible_approval_message)
    } else {
        None
    };
    let message = if approval {
        visible_message
            .as_deref()
            .map(|message| message.split_once('\n').map_or("", |(_, rest)| rest))
    } else {
        message
    };
    let rows = panel.items.iter().enumerate().map(|(idx, item)| {
        let prefix = if panel.multi {
            if panel.chosen.get(idx).copied().unwrap_or(false) {
                "[x] "
            } else {
                "[ ] "
            }
        } else if shell_approval {
            ""
        } else {
            "    "
        };
        pick_item_row(item, prefix)
    });
    build_pick_panel_view(
        (!shell_approval).then_some(panel.title.as_str()),
        message,
        rows,
        panel.selected,
        !shell_approval,
    )
}

pub(super) fn build_lane_action_picker_view(panel: &LaneActionPickerState) -> PanelView {
    build_pick_panel_view(
        Some(&panel.title),
        None,
        panel.items.iter().map(|item| pick_item_row(item, "    ")),
        panel.selected,
        true,
    )
}

pub(super) fn build_update_picker_view(panel: &UpdatePickerState) -> PanelView {
    build_pick_panel_view(
        Some(&panel.title),
        panel
            .message
            .as_deref()
            .filter(|message| !message.trim().is_empty()),
        panel.items.iter().map(|item| pick_item_row(item, "")),
        panel.selected,
        true,
    )
}

pub(super) fn build_shell_rule_picker_view(panel: &ShellRulePickerState) -> PanelView {
    build_pick_panel_view(
        Some(&panel.title),
        panel
            .message
            .as_deref()
            .filter(|message| !message.trim().is_empty()),
        panel.items.iter().map(|item| pick_item_row(item, "    ")),
        panel.selected,
        true,
    )
}

fn pick_item_row(item: &PickDialogItem, prefix: &str) -> String {
    match &item.detail {
        Some(detail) => format!("{prefix}{} - {detail}", item.label),
        None => format!("{prefix}{}", item.label),
    }
}

fn build_pick_panel_view(
    title: Option<&str>,
    message: Option<&str>,
    rows: impl Iterator<Item = String>,
    selected: usize,
    wrap_lines: bool,
) -> PanelView {
    let mut lines = Vec::new();
    if let Some(message) = message {
        lines.extend(message.lines().map(str::to_owned));
        lines.push(String::new());
    }
    let selected = lines.len() + selected;
    lines.extend(rows);
    PanelView {
        title: title.map(str::to_owned),
        lines,
        header_index: None,
        selected: Some(selected),
        wrap_lines,
        tail_pinned_from: None,
    }
}

fn is_shell_approval_message(message: &str) -> bool {
    message.starts_with(COMMAND_PREFIX) || message.starts_with(ALLOWANCE_PREFIX)
}

fn visible_approval_message(message: &str) -> String {
    let mut visible = String::with_capacity(message.len());
    for ch in message.chars() {
        if (ch.is_control() && ch != '\n')
            || matches!(ch, '\u{061c}' | '\u{200e}' | '\u{200f}' | '\u{2028}'..='\u{202e}' | '\u{2066}'..='\u{2069}')
        {
            visible.extend(ch.escape_debug());
        } else {
            visible.push(ch);
        }
    }
    visible
}

pub(super) fn render_approval_pick(
    panel: &RuntimePickList,
    review_offset: Option<usize>,
    view: &PanelView,
    max_lines: u16,
    width: usize,
) -> Vec<Line<'static>> {
    let message = visible_approval_message(panel.message.as_deref().unwrap_or_default());
    if let Some(offset) = review_offset {
        return render_pick_details("Approval details", &message, offset, max_lines, width);
    }
    if is_shell_approval_message(&message) {
        return render_shell_approval_pick(panel, view, &message, max_lines, width);
    }
    if max_lines < 2 {
        return build_panel_render(view, max_lines, width);
    }
    let preview = message
        .lines()
        .find(|line| !line.trim().is_empty())
        .unwrap_or_default();
    let hint = "[D details] ";
    let summary = truncate_to_width(preview, width.saturating_sub(hint.len()));
    let preview = Line::from(truncate_to_width(&format!("{hint}{summary}"), width));
    let mut lines = build_panel_render(view, if max_lines == 2 { 2 } else { max_lines - 1 }, width);
    if max_lines == 2 {
        lines[0] = preview;
    } else {
        lines.insert(1, preview);
    }
    lines
}

fn approval_preview_rows(section: &str, width: usize, budget: usize) -> Vec<Line<'static>> {
    let mut rows: Vec<_> = section
        .lines()
        .flat_map(|line| wrap_line(line, width))
        .take(budget + 1)
        .map(|row| truncate_to_width(&row, width))
        .collect();
    if rows.len() > budget {
        rows.truncate(budget);
        if let Some(last) = rows.last_mut() {
            *last = format!("{}…", truncate_to_width(last, width.saturating_sub(1)));
        }
    }
    rows.into_iter().map(Line::from).collect()
}

fn render_shell_approval_pick(
    panel: &RuntimePickList,
    view: &PanelView,
    message: &str,
    max_lines: u16,
    width: usize,
) -> Vec<Line<'static>> {
    if max_lines < 2 || width == 0 {
        return build_panel_render(view, max_lines, width);
    }
    let mut sections = message.split("\n\n");
    let first = sections.next().unwrap_or_default();
    let (allowance, command) = if first.starts_with(ALLOWANCE_PREFIX) {
        (Some(first), sections.next().unwrap_or_default())
    } else {
        (None, first)
    };
    let height = usize::from(max_lines);
    // Reserve one row per choice whenever the viewport can also show the primary preview.
    let primary_rows = 1 + usize::from(allowance.is_some() && height >= 3);
    let choice_rows = view.lines.len().min(height - primary_rows);
    let mut preview_rows = height - choice_rows;
    let mut lines = Vec::new();
    let show_title = preview_rows > primary_rows + 1;
    if show_title {
        let hint = "[D details]";
        let title = truncate_to_width(&panel.title, width.saturating_sub(hint.len() + 1));
        lines.push(Line::from(truncate_to_width(
            &format!("{hint} {title}"),
            width,
        )));
        preview_rows -= 1;
    }

    let inline_hint = " [D]";
    let show_inline_hint = !show_title && width > inline_hint.len();
    let preview_width = width - usize::from(show_inline_hint) * inline_hint.len();
    let command_budget = (preview_rows - usize::from(allowance.is_some())).min(3);
    let command_rows = approval_preview_rows(command, preview_width, command_budget);
    if let Some(allowance) = allowance {
        let allowance_budget = preview_rows.saturating_sub(command_rows.len()).min(6);
        lines.extend(approval_preview_rows(
            allowance,
            preview_width,
            allowance_budget,
        ));
    }
    lines.extend(command_rows);
    if show_inline_hint {
        if let Some(first) = lines.first_mut() {
            *first = Line::from(format!("{first}{inline_hint}"));
        }
    }
    lines.extend(build_panel_render(view, choice_rows as u16, width));
    lines
}

pub(super) fn render_shell_rule_details(
    panel: &ShellRulePickerState,
    max_lines: u16,
    width: usize,
) -> Option<Vec<Line<'static>>> {
    let offset = panel.review_offset?;
    let message = match &panel.kind {
        ShellRulePicker::Choose { .. } => {
            let item = panel.items.get(panel.selected)?;
            format!(
                "{}\n{}",
                item.label,
                item.detail.as_deref().unwrap_or_default()
            )
        }
        ShellRulePicker::Confirm { .. } | ShellRulePicker::Trust { .. } => {
            panel.message.clone().unwrap_or_default()
        }
    };
    Some(render_pick_details(
        "Saved rule details",
        &message,
        offset,
        max_lines,
        width,
    ))
}

fn render_pick_details(
    title: &str,
    message: &str,
    offset: usize,
    max_lines: u16,
    width: usize,
) -> Vec<Line<'static>> {
    if max_lines == 0 {
        return Vec::new();
    }
    let rows: Vec<_> = message
        .lines()
        .flat_map(|line| wrap_line(line, width.max(1)))
        .collect();
    let visible = usize::from(max_lines.saturating_sub(1));
    let start = offset.min(rows.len().saturating_sub(visible));
    let hint = format!("{title} [↑/↓, PgUp/PgDn · D / Esc to return]");
    let mut lines = vec![Line::from(truncate_to_width(&hint, width))];
    lines.extend(rows.into_iter().skip(start).take(visible).map(Line::from));
    lines
}

#[cfg(test)]
mod tests {
    use super::{build_confirm_panel_view, build_runtime_pick_list_view, render_approval_pick};
    use crate::app::{
        ConfirmDialogState, ConfirmMode, PickDialogItem, RuntimePickList, RuntimePickListKind,
    };
    use ratatui::{backend::TestBackend, widgets::Paragraph, Terminal};

    fn approval_dialog(message: &str, choices: &[&str]) -> RuntimePickList {
        RuntimePickList {
            id: "approval".into(),
            title: "Approve shell?".into(),
            message: Some(message.into()),
            items: choices
                .iter()
                .map(|label| PickDialogItem {
                    id: (*label).into(),
                    label: (*label).into(),
                    detail: None,
                })
                .collect(),
            selected: 0,
            multi: false,
            chosen: vec![],
            kind: RuntimePickListKind::Approval {
                review_offset: None,
            },
        }
    }

    fn draw_approval(
        panel: &RuntimePickList,
        review_offset: Option<usize>,
        width: u16,
        height: u16,
    ) -> String {
        let view = build_runtime_pick_list_view(panel);
        let lines = render_approval_pick(panel, review_offset, &view, height, usize::from(width));
        assert!(lines.len() <= usize::from(height));
        assert!(lines.iter().all(|line| line.width() <= usize::from(width)));
        let mut terminal = Terminal::new(TestBackend::new(width, height)).unwrap();
        terminal
            .draw(|frame| frame.render_widget(Paragraph::new(lines), frame.area()))
            .unwrap();
        terminal.backend().to_string()
    }

    #[test]
    fn shell_approval_wraps_command_above_all_choices_and_keeps_reason_in_details() {
        let mut panel = approval_dialog(
            "Command: python3 -c 'a deliberately long command to test wrapping'\n  first continuation\n  \n  last continuation\n\nReason: Auto approve requests a decision.\n\nWorking directory: project",
            &["Run once", "Set up future allowance…", "Skip"],
        );
        panel.selected = 1;
        let compact = draw_approval(&panel, None, 36, 7);
        assert!(compact.contains("Command: python3"));
        assert!(compact.contains("long command to test wrapping"));
        assert!(compact.contains('…'));
        assert!(compact.contains("[D"));
        assert!(compact.contains("Run once"));
        assert!(compact.contains("> Set up future allowance…"));
        assert!(compact.contains("Skip"));
        assert!(!compact.contains("Reason:"));
        assert!(!compact.contains("Working directory:"));

        let beginning = draw_approval(&panel, Some(0), 36, 4);
        assert!(beginning.contains("Command: python3"));
        assert!(beginning.contains("first continuation"));
        let end = draw_approval(&panel, Some(8), 36, 8);
        assert!(end.contains("last continuation"));
        assert!(end.contains("Reason: Auto approve requests a"));
        assert!(end.contains("sion."));
        assert!(end.contains("Working directory: project"));
        assert!(!end.contains("Run once"));
    }

    #[test]
    fn shell_rule_approval_keeps_the_scope_and_choices_visible_on_a_short_screen() {
        let mut panel = approval_dialog(
            "Future allowance: cargo test with any trailing arguments in the project. Bound executable: /bin/cargo.\n\nCommand: cargo test --release\n\nReason: approval required\n\nWorking directory: project",
            &[
                "Run once",
                "Save for this session and run",
                "Save for this workspace and run",
                "Skip",
            ],
        );
        panel.selected = 2;
        let compact = draw_approval(&panel, None, 44, 7);
        assert!(compact.contains("Future allowance: cargo test"));
        assert!(compact.contains("[D]"));
        assert!(compact.contains("Command: cargo test --release"));
        assert!(compact.contains("Run once"));
        assert!(compact.contains("Save for this session and run"));
        assert!(compact.contains("> Save for this workspace and run"));
        assert!(compact.contains("Skip"));
        assert!(!compact.contains("Working directory:"));
    }

    #[test]
    fn approval_keeps_the_command_and_choice_visible_and_details_are_scrollable() {
        assert_eq!(
            super::visible_approval_message("Future allowance: x\u{202e}y"),
            r"Future allowance: x\u{202e}y"
        );
        let panel = RuntimePickList {
            id: "approval".into(),
            title: "Approve shell?".into(),
            message: Some("git status; git diff --cached --shortstat\nWorking directory: example\nNetwork: off\nExpires: now".into()),
            items: ["Allow once", "Deny and continue"].into_iter().map(|label| PickDialogItem {
                id: label.into(), label: label.into(), detail: None,
            }).collect(),
            selected: 1,
            multi: false,
            chosen: vec![],
            kind: RuntimePickListKind::Approval { review_offset: None },
        };
        let view = build_runtime_pick_list_view(&panel);
        for height in [2, 3, 5] {
            let rendered = render_approval_pick(&panel, None, &view, height, 36);
            assert!(rendered
                .iter()
                .any(|line| line.to_string().contains("git status")));
            assert!(rendered
                .iter()
                .any(|line| line.to_string().contains("Deny and continue")));
        }
        let rendered = render_approval_pick(&panel, Some(1), &view, 4, 32);
        assert!(rendered
            .iter()
            .any(|line| line.to_string().contains("shortstat")));
        assert!(!rendered
            .iter()
            .any(|line| line.to_string().contains("Allow once")));
    }

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
