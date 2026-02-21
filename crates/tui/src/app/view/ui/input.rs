use crate::app::state::InputState;
use crate::app::util::attachments::render_input_with_attachment_labels;
use crate::app::util::text::{char_width, detect_continuation_prefix};
use crate::app::AppState;
use ratatui::layout::Rect;
use ratatui::style::Style;
use ratatui::text::{Line, Span, Text};
use ratatui::widgets::Paragraph;

use super::super::theme::ui_colors;
use super::constants::input_bg;

pub(super) struct InputLayout {
    pub(super) lines: Vec<String>,
    pub(super) cursor_x: u16,
    pub(super) cursor_y: u16,
}

fn text_width(text: &str) -> usize {
    text.chars().map(char_width).sum()
}

fn input_prefix(line_index: usize, bang_mode: bool) -> &'static str {
    if line_index == 0 {
        if bang_mode {
            "! "
        } else {
            "> "
        }
    } else {
        "  "
    }
}

pub(super) fn compute_input_layout(
    width: usize,
    input: &InputState,
    bang_mode: bool,
) -> InputLayout {
    if width == 0 {
        return InputLayout {
            lines: vec![String::new()],
            cursor_x: 0,
            cursor_y: 0,
        };
    }

    let logical_text: String = input.buffer.iter().collect();
    let logical_continuation_prefixes: Vec<String> = logical_text
        .split('\n')
        .map(|segment| detect_continuation_prefix(segment).unwrap_or_default())
        .collect();

    let mut lines: Vec<String> = Vec::new();
    let mut line_index = 0_usize;
    let mut logical_line_index = 0_usize;
    let mut line = input_prefix(line_index, bang_mode).to_string();
    let mut col = text_width(&line);
    let mut line_prefix_width = col;

    let len = input.buffer.len();
    let cursor = input.cursor.min(len);
    let mut cursor_x = col;
    let mut cursor_y = 0_usize;
    let mut cursor_set = cursor == 0;

    for (idx, &ch) in input.buffer.iter().enumerate() {
        if idx == cursor && !cursor_set {
            cursor_x = col;
            cursor_y = line_index;
            cursor_set = true;
        }

        if ch == '\n' {
            lines.push(line);
            line_index += 1;
            logical_line_index += 1;
            line = input_prefix(line_index, bang_mode).to_string();
            col = text_width(&line);
            line_prefix_width = col;
            continue;
        }

        let ch_width = char_width(ch);
        if col + ch_width > width && col > line_prefix_width {
            lines.push(line);
            line_index += 1;
            let base_prefix = input_prefix(line_index, bang_mode);
            let continuation = logical_continuation_prefixes
                .get(logical_line_index)
                .map(|value| value.as_str())
                .unwrap_or("");
            let continuation_fits = !continuation.is_empty()
                && text_width(base_prefix).saturating_add(text_width(continuation)) < width;
            line = if continuation_fits {
                format!("{base_prefix}{continuation}")
            } else {
                base_prefix.to_string()
            };
            col = text_width(&line);
            line_prefix_width = col;
        }

        line.push(ch);
        col += ch_width;
    }

    if !cursor_set {
        cursor_x = col;
        cursor_y = line_index;
    }

    lines.push(line);

    let max_x = width.saturating_sub(1);
    let cursor_x = (cursor_x.min(max_x)) as u16;
    let cursor_y = (cursor_y.min(lines.len().saturating_sub(1))) as u16;

    InputLayout {
        lines,
        cursor_x,
        cursor_y,
    }
}

pub(super) fn render_input(
    f: &mut crate::app::render::custom_terminal::Frame,
    area: Rect,
    layout: &InputLayout,
    bang_mode: bool,
) {
    if area.height == 0 || area.width == 0 {
        return;
    }

    let total = layout.lines.len();
    let height = area.height as usize;
    let cursor_y = layout.cursor_y as usize;

    let mut start = 0_usize;
    if total > height {
        start = cursor_y.saturating_add(1).saturating_sub(height);
        let max_start = total - height;
        if start > max_start {
            start = max_start;
        }
    }

    let end = usize::min(start + height, total);
    let visible_slice = &layout.lines[start..end];
    let visible: Vec<Line> = visible_slice
        .iter()
        .enumerate()
        .map(|(offset, line)| {
            if bang_mode && start + offset == 0 && line.starts_with("! ") {
                let rest = line[2..].to_string();
                Line::from(vec![
                    Span::styled(
                        "! ".to_string(),
                        Style::default().fg(ui_colors().bang_prefix_fg),
                    ),
                    Span::raw(rest),
                ])
            } else {
                Line::from(line.clone())
            }
        })
        .collect();
    f.render_widget(
        Paragraph::new(Text::from(visible)).style(Style::default().bg(input_bg())),
        area,
    );

    let cursor_visible_y = cursor_y.saturating_sub(start).min(height.saturating_sub(1));
    f.set_cursor_position((area.x + layout.cursor_x, area.y + cursor_visible_y as u16));
}

pub(super) fn masked_prompt_input(app: &AppState) -> Option<InputState> {
    app.prompt_dialog
        .as_ref()
        .filter(|panel| panel.secret)
        .map(|_| app.prompt_input.masked_clone('*'))
}

pub(super) fn rendered_main_input(app: &AppState) -> Option<InputState> {
    if app.confirm_dialog.is_some() || app.prompt_dialog.is_some() {
        return None;
    }
    Some(render_input_with_attachment_labels(
        &app.input,
        &app.composer_nonce,
        &app.pending_image_attachments,
    ))
}

pub(super) fn active_input_for_layout<'a>(
    app: &'a AppState,
    masked_prompt: &'a Option<InputState>,
    rendered_main: &'a Option<InputState>,
) -> &'a InputState {
    if app.confirm_dialog.is_some() {
        &app.confirm_input
    } else if let Some(masked) = masked_prompt.as_ref() {
        masked
    } else if app.prompt_dialog.is_some() {
        &app.prompt_input
    } else if let Some(rendered) = rendered_main.as_ref() {
        rendered
    } else {
        &app.input
    }
}

#[cfg(test)]
mod tests {
    use super::compute_input_layout;
    use crate::app::state::InputState;

    #[test]
    fn input_wrap_keeps_task_list_continuation_indent() {
        let mut input = InputState::default();
        input.set_from("- [x] continuation alignment stays visible");

        let layout = compute_input_layout(16, &input, false);
        assert!(layout.lines.len() >= 2);
        assert!(layout.lines[1].starts_with("        "));
    }

    #[test]
    fn input_wrap_keeps_indented_code_continuation() {
        let mut input = InputState::default();
        input.set_from("    const value = someVeryLongIdentifier");

        let layout = compute_input_layout(16, &input, false);
        assert!(layout.lines.len() >= 2);
        assert!(layout.lines[1].starts_with("      "));
    }

    #[test]
    fn input_wrap_falls_back_when_continuation_prefix_is_too_wide() {
        let mut input = InputState::default();
        input.set_from("- [x] abcdefghij");

        let layout = compute_input_layout(8, &input, false);
        assert!(layout.lines.len() >= 2);
        assert_eq!(layout.lines[1], "  abcdef");
    }
}
