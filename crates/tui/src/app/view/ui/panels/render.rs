use crate::app::util::text::wrap_line;
use ratatui::layout::Rect;
use ratatui::style::{Color, Modifier, Style};
use ratatui::text::{Line, Span, Text};
use ratatui::widgets::{Block, Paragraph};

use super::super::constants::{INPUT_BG, INPUT_PADDING_X, INPUT_PADDING_Y};
use super::super::input::{render_input, InputLayout};
use super::super::text::truncate_to_width;
use super::types::PanelView;

pub(in crate::app::view::ui) fn build_panel_render(
    panel: &PanelView,
    max_lines: u16,
    max_width: usize,
) -> Vec<Line<'_>> {
    if max_lines == 0 {
        return Vec::new();
    }
    let mut out = Vec::new();
    let mut remaining = max_lines;
    if let Some(title) = panel.title.as_ref() {
        if remaining == 0 {
            return out;
        }
        out.push(Line::from(Span::styled(
            title.clone(),
            Style::default().add_modifier(Modifier::DIM),
        )));
        remaining = remaining.saturating_sub(1);
    }

    if remaining == 0 || panel.lines.is_empty() {
        return out;
    }

    let mut expanded: Vec<(usize, String)> = Vec::new();
    let content_width = max_width.saturating_sub(2).max(1);
    for (line_index, line) in panel.lines.iter().enumerate() {
        if line.is_empty() {
            expanded.push((line_index, String::new()));
            continue;
        }
        if panel.wrap_lines {
            for wrapped in wrap_line(line, content_width) {
                expanded.push((line_index, wrapped));
            }
        } else {
            expanded.push((line_index, truncate_to_width(line, content_width)));
        }
    }
    if expanded.is_empty() {
        return out;
    }

    let total = expanded.len();
    let visible = usize::min(total, remaining as usize);
    let selected = panel
        .selected
        .and_then(|selected_line| expanded.iter().position(|(idx, _)| *idx == selected_line))
        .unwrap_or(0)
        .min(total.saturating_sub(1));
    let mut start = 0_usize;
    if total > visible {
        if let Some(pin_from) = panel.tail_pinned_from {
            if let Some(tail_start) = expanded.iter().position(|(idx, _)| *idx >= pin_from) {
                let tail_len = total.saturating_sub(tail_start);
                start = if tail_len >= visible {
                    tail_start
                } else {
                    total - visible
                };
            } else if selected >= visible {
                start = selected.saturating_add(1).saturating_sub(visible);
            }
        } else if selected >= visible {
            start = selected.saturating_add(1).saturating_sub(visible);
        }
        let max_start = total - visible;
        if start > max_start {
            start = max_start;
        }
    }
    let end = usize::min(start + visible, total);
    let mut prev_line_index: Option<usize> = None;
    for (line_index, line) in expanded[start..end].iter() {
        let is_selected_line = panel.selected == Some(*line_index);
        let is_first_visual_line = prev_line_index != Some(*line_index);
        let mut style = Style::default();
        if panel.header_index == Some(*line_index) {
            style = style.add_modifier(Modifier::DIM);
        }
        if is_selected_line {
            style = style.add_modifier(Modifier::BOLD);
        }
        let marker = if is_selected_line && is_first_visual_line {
            "> "
        } else {
            "  "
        };
        out.push(Line::from(Span::styled(format!("{marker}{line}"), style)));
        prev_line_index = Some(*line_index);
    }
    out
}

pub(in crate::app::view::ui) fn render_input_panel(
    f: &mut crate::app::render::custom_terminal::Frame,
    area: Rect,
    layout: &InputLayout,
    panel_lines: &[Line],
    panel_gap: u16,
) {
    if area.height == 0 || area.width == 0 {
        return;
    }

    let background = Block::default().style(Style::default().bg(INPUT_BG));
    f.render_widget(background, area);

    let inner = Rect {
        x: area.x + INPUT_PADDING_X,
        y: area.y + INPUT_PADDING_Y,
        width: area.width.saturating_sub(INPUT_PADDING_X.saturating_mul(2)),
        height: area
            .height
            .saturating_sub(INPUT_PADDING_Y.saturating_mul(2)),
    };
    if inner.height == 0 || inner.width == 0 {
        return;
    }

    let panel_height = panel_lines.len() as u16;
    if panel_height > 0 {
        let panel_area = Rect {
            x: inner.x,
            y: inner.y,
            width: inner.width,
            height: panel_height,
        };
        f.render_widget(
            Paragraph::new(Text::from(panel_lines.to_vec())).style(Style::default().bg(INPUT_BG)),
            panel_area,
        );
    }

    let gap_height = panel_gap.min(inner.height.saturating_sub(panel_height));
    if gap_height > 0 {
        let divider = "─".repeat(inner.width as usize);
        let gap_area = Rect {
            x: inner.x,
            y: inner.y + panel_height,
            width: inner.width,
            height: gap_height,
        };
        let line = Line::from(Span::styled(
            divider,
            Style::default().fg(Color::DarkGray).bg(INPUT_BG),
        ));
        f.render_widget(Paragraph::new(Text::from(vec![line])), gap_area);
    }

    let input_area = Rect {
        x: inner.x,
        y: inner.y + panel_height + gap_height,
        width: inner.width,
        height: inner.height.saturating_sub(panel_height + gap_height),
    };
    render_input(f, input_area, layout);
}
