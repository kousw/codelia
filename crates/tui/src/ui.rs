use crate::app::{
    AppState, ConfirmDialogState, ContextPanelState, ModelListPanelState, SessionListPanelState,
    SkillsListPanelState, StatusLineMode, WrappedLogCache,
};
use crate::attachments::render_input_with_attachment_labels;
use crate::handlers::command::{
    active_skill_mention_token, command_suggestion_rows, skill_suggestion_rows,
};
use crate::input::InputState;
use crate::model::{LogKind, LogLine, LogTone};
use crate::text::{char_width, wrap_line};
use ratatui::layout::Rect;
use ratatui::style::{Color, Modifier, Style};
use ratatui::text::{Line, Span, Text};
use ratatui::widgets::{Block, Clear, Paragraph};
use std::time::Instant;

const MAX_INPUT_HEIGHT: u16 = 6;
const INPUT_PADDING_X: u16 = 2;
const INPUT_PADDING_Y: u16 = 1;
const INPUT_BG: Color = Color::Rgb(40, 40, 40);
const PANEL_GAP: u16 = 1;
const COMMAND_PANEL_LIMIT: usize = 6;
const DEBUG_PANEL_HEIGHT: u16 = 2;

fn style_for(kind: LogKind, tone: LogTone) -> Style {
    let (summary, detail) = match kind {
        LogKind::System => (
            Style::default().fg(Color::Cyan),
            Style::default().fg(Color::Cyan).add_modifier(Modifier::DIM),
        ),
        LogKind::User => (
            Style::default().fg(Color::White).bg(INPUT_BG),
            Style::default().fg(Color::White).bg(INPUT_BG),
        ),
        LogKind::Assistant => (
            Style::default().fg(Color::White),
            Style::default().fg(Color::White),
        ),
        LogKind::AssistantCode => (
            Style::default().fg(Color::LightGreen),
            Style::default()
                .fg(Color::LightGreen)
                .add_modifier(Modifier::DIM),
        ),
        LogKind::Reasoning => (
            Style::default()
                .fg(Color::Gray)
                .add_modifier(Modifier::ITALIC),
            Style::default()
                .fg(Color::Gray)
                .add_modifier(Modifier::ITALIC)
                .add_modifier(Modifier::DIM),
        ),
        LogKind::ToolCall => (
            Style::default().fg(Color::LightBlue),
            Style::default().fg(Color::White),
        ),
        LogKind::ToolResult => (
            Style::default().fg(Color::Green),
            Style::default()
                .fg(Color::Green)
                .add_modifier(Modifier::DIM),
        ),
        LogKind::DiffMeta => (
            Style::default().fg(Color::DarkGray),
            Style::default().fg(Color::DarkGray),
        ),
        LogKind::DiffContext => (
            Style::default().fg(Color::Gray),
            Style::default().fg(Color::Gray),
        ),
        LogKind::DiffAdded => (
            Style::default().fg(Color::Green),
            Style::default().fg(Color::Green),
        ),
        LogKind::DiffRemoved => (
            Style::default().fg(Color::Red),
            Style::default().fg(Color::Red),
        ),
        LogKind::Status => (
            Style::default().fg(Color::Blue),
            Style::default().fg(Color::Blue),
        ),
        LogKind::Rpc => (
            Style::default().add_modifier(Modifier::DIM),
            Style::default().add_modifier(Modifier::DIM),
        ),
        LogKind::Runtime => (
            Style::default().add_modifier(Modifier::DIM),
            Style::default().add_modifier(Modifier::DIM),
        ),
        LogKind::Space => (
            Style::default().fg(Color::Black),
            Style::default().fg(Color::Black),
        ),
        LogKind::Error => (
            Style::default().fg(Color::Red).add_modifier(Modifier::BOLD),
            Style::default()
                .fg(Color::Red)
                .add_modifier(Modifier::BOLD)
                .add_modifier(Modifier::DIM),
        ),
    };

    match tone {
        LogTone::Summary => summary,
        LogTone::Detail => detail,
    }
}

fn visual_width(text: &str) -> usize {
    text.chars().map(char_width).sum()
}

fn pad_to_width(mut text: String, width: usize) -> String {
    let current = visual_width(&text);
    if current >= width {
        return text;
    }
    text.push_str(&" ".repeat(width - current));
    text
}

fn truncate_to_width(text: &str, width: usize) -> String {
    if visual_width(text) <= width {
        return text.to_string();
    }
    if width == 0 {
        return String::new();
    }
    if width <= 3 {
        return ".".repeat(width);
    }

    let target = width - 3;
    let mut out = String::new();
    let mut used = 0;
    for ch in text.chars() {
        let w = char_width(ch);
        if used + w > target {
            break;
        }
        out.push(ch);
        used += w;
    }
    out.push_str("...");
    out
}

fn wrap_log_lines(lines: &[LogLine], width: usize) -> Vec<LogLine> {
    let mut out = Vec::new();
    for line in lines {
        if line.plain_text().is_empty() {
            out.push(line.clone());
            continue;
        }
        if !line.is_single_span() {
            out.push(line.clone());
            continue;
        }
        let is_user = line.kind() == LogKind::User;
        let wrap_width = if is_user {
            width.saturating_sub(4).max(1)
        } else {
            width
        };
        for wrapped in wrap_line(&line.plain_text(), wrap_width) {
            let wrapped = if is_user {
                pad_to_width(format!(" {wrapped} "), width)
            } else {
                wrapped
            };
            out.push(line.with_text(wrapped));
        }
    }
    out
}

fn cached_wrap_log_lines(app: &mut AppState, width: usize) -> &[LogLine] {
    if width == 0 {
        return &[];
    }
    let cache_hit = matches!(
        app.wrapped_log_cache.as_ref(),
        Some(cache) if cache.width == width && cache.log_version == app.log_version
    );
    if !cache_hit {
        let started = Instant::now();
        let wrapped = wrap_log_lines(&app.log, width);
        let wrapped_total = wrapped.len();
        app.wrapped_log_cache = Some(WrappedLogCache {
            width,
            log_version: app.log_version,
            wrapped,
        });
        app.record_wrap_cache_miss(started.elapsed(), wrapped_total);
    } else if let Some(wrapped_total) = app
        .wrapped_log_cache
        .as_ref()
        .map(|cache| cache.wrapped.len())
    {
        app.record_wrap_cache_hit(wrapped_total);
    }
    app.wrapped_log_cache
        .as_ref()
        .map(|cache| cache.wrapped.as_slice())
        .unwrap_or(&[])
}

fn debug_panel_height(app: &AppState) -> u16 {
    if app.debug_perf_enabled {
        DEBUG_PANEL_HEIGHT
    } else {
        0
    }
}

fn layout_heights(app: &AppState) -> (u16, u16, u16) {
    let modal_active = app.confirm_dialog.is_some() || app.prompt_dialog.is_some();
    if modal_active {
        return (0, 0, 0);
    }
    let run_height = 2_u16;
    let status_height = 1_u16;
    let debug_height = debug_panel_height(app);
    (run_height, status_height, debug_height)
}

struct InputLayout {
    lines: Vec<String>,
    cursor_x: u16,
    cursor_y: u16,
}

fn input_prefix(line_index: usize) -> &'static str {
    if line_index == 0 {
        "> "
    } else {
        "  "
    }
}

fn compute_input_layout(width: usize, input: &InputState) -> InputLayout {
    if width == 0 {
        return InputLayout {
            lines: vec![String::new()],
            cursor_x: 0,
            cursor_y: 0,
        };
    }

    let mut lines: Vec<String> = Vec::new();
    let mut line_index = 0_usize;
    let mut line = input_prefix(line_index).to_string();
    let mut col = line.len();

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
            line = input_prefix(line_index).to_string();
            col = line.len();
            continue;
        }

        let ch_width = char_width(ch);
        let prefix_width = input_prefix(line_index).len();
        if col + ch_width > width && col > prefix_width {
            lines.push(line);
            line_index += 1;
            line = input_prefix(line_index).to_string();
            col = line.len();
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

fn render_input(f: &mut crate::custom_terminal::Frame, area: Rect, layout: &InputLayout) {
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
        .map(|line| Line::from(line.clone()))
        .collect();
    f.render_widget(
        Paragraph::new(Text::from(visible)).style(Style::default().bg(INPUT_BG)),
        area,
    );

    let cursor_visible_y = cursor_y.saturating_sub(start).min(height.saturating_sub(1));
    f.set_cursor_position((area.x + layout.cursor_x, area.y + cursor_visible_y as u16));
}

struct PanelView {
    title: Option<String>,
    lines: Vec<String>,
    header_index: Option<usize>,
    selected: Option<usize>,
    wrap_lines: bool,
    tail_pinned_from: Option<usize>,
}

fn build_model_list_panel_view(panel: &ModelListPanelState) -> PanelView {
    let (header, rows) = match panel.view_mode {
        crate::app::ModelListViewMode::Limits => (&panel.header_limits, &panel.rows_limits),
        crate::app::ModelListViewMode::Cost => (&panel.header_cost, &panel.rows_cost),
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

fn build_session_list_panel_view(panel: &SessionListPanelState) -> PanelView {
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

fn build_context_panel_view(panel: &ContextPanelState) -> PanelView {
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

fn build_skills_list_panel_view(panel: &SkillsListPanelState) -> PanelView {
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

fn build_confirm_panel_view(panel: &ConfirmDialogState) -> PanelView {
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

fn build_prompt_panel_view(panel: &crate::app::PromptDialogState) -> PanelView {
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

fn build_pick_panel_view(panel: &crate::app::PickDialogState) -> PanelView {
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

fn build_picker_panel_view(
    title: String,
    items: &[String],
    selected: usize,
    current: Option<&str>,
) -> PanelView {
    let mut lines = Vec::with_capacity(items.len());
    for item in items {
        let is_current = current == Some(item.as_str());
        let current_marker = if is_current { "*" } else { " " };
        lines.push(format!("{current_marker} {item}"));
    }
    PanelView {
        title: Some(title),
        lines,
        header_index: None,
        selected: Some(selected),
        wrap_lines: true,
        tail_pinned_from: None,
    }
}

fn build_command_panel_view(app: &AppState) -> Option<PanelView> {
    let text = app.input.current();
    let trimmed = text.trim_start();
    if !trimmed.starts_with('/') {
        return None;
    }
    if trimmed.chars().any(char::is_whitespace) {
        return None;
    }

    let token = trimmed.split_whitespace().next().unwrap_or_default();
    if token.is_empty() {
        return None;
    }

    let mut lines = Vec::new();
    lines.push(format!("matching: {token}"));
    let rows = command_suggestion_rows(token, COMMAND_PANEL_LIMIT);
    if rows.is_empty() {
        lines.push("No matching command. Type /help for all commands.".to_string());
    } else {
        lines.extend(rows);
    }

    Some(PanelView {
        title: Some("Command suggestions".to_string()),
        lines,
        header_index: Some(0),
        selected: None,
        wrap_lines: true,
        tail_pinned_from: None,
    })
}

fn build_skill_suggestion_panel_view(app: &AppState) -> Option<PanelView> {
    let text = app.input.current();
    let token = active_skill_mention_token(&text)?;

    let mut lines = Vec::new();
    lines.push(format!("matching: {token}"));
    if app.skills_catalog_items.is_empty() {
        lines.push("No local skills cached yet. Run /skills to refresh.".to_string());
    } else {
        let rows = skill_suggestion_rows(&token, &app.skills_catalog_items, COMMAND_PANEL_LIMIT);
        if rows.is_empty() {
            lines.push("No matching local skill.".to_string());
        } else {
            lines.extend(rows);
        }
    }

    Some(PanelView {
        title: Some("Skill suggestions".to_string()),
        lines,
        header_index: Some(0),
        selected: None,
        wrap_lines: true,
        tail_pinned_from: None,
    })
}

fn build_attachment_panel_view(app: &AppState) -> Option<PanelView> {
    if app.pending_image_attachments.is_empty() {
        return None;
    }
    let ids = app.referenced_attachment_ids();
    if ids.is_empty() {
        return None;
    }
    let lines = ids
        .iter()
        .enumerate()
        .filter_map(|(index, attachment_id)| {
            app.pending_image_attachments
                .get(attachment_id)
                .map(|image| {
                    format!(
                        "[Image {}] {}x{} {}KB",
                        index + 1,
                        image.width,
                        image.height,
                        image.encoded_bytes / 1024
                    )
                })
        })
        .collect::<Vec<_>>();
    Some(PanelView {
        title: Some("Attachments".to_string()),
        lines,
        header_index: None,
        selected: None,
        wrap_lines: false,
        tail_pinned_from: None,
    })
}

fn build_panel_view(app: &AppState) -> Option<PanelView> {
    if let Some(panel) = &app.confirm_dialog {
        return Some(build_confirm_panel_view(panel));
    }

    if let Some(panel) = &app.prompt_dialog {
        return Some(build_prompt_panel_view(panel));
    }

    if let Some(panel) = &app.pick_dialog {
        return Some(build_pick_panel_view(panel));
    }

    if let Some(panel) = &app.session_list_panel {
        return Some(build_session_list_panel_view(panel));
    }

    if let Some(panel) = &app.context_panel {
        return Some(build_context_panel_view(panel));
    }

    if let Some(panel) = &app.skills_list_panel {
        return Some(build_skills_list_panel_view(panel));
    }

    if let Some(panel) = &app.model_list_panel {
        return Some(build_model_list_panel_view(panel));
    }

    if let Some(picker) = &app.provider_picker {
        return Some(build_picker_panel_view(
            "Select provider".to_string(),
            &picker.providers,
            picker.selected,
            app.current_provider.as_deref(),
        ));
    }

    if let Some(picker) = &app.model_picker {
        let provider_label = app.current_provider.as_deref().unwrap_or("openai");
        let title = format!("Select model ({provider_label})");
        return Some(build_picker_panel_view(
            title,
            &picker.models,
            picker.selected,
            app.current_model.as_deref(),
        ));
    }

    build_command_panel_view(app)
        .or_else(|| build_skill_suggestion_panel_view(app))
        .or_else(|| build_attachment_panel_view(app))
}

fn build_panel_render(panel: &PanelView, max_lines: u16, max_width: usize) -> Vec<Line<'_>> {
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

fn render_input_panel(
    f: &mut crate::custom_terminal::Frame,
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

fn build_run_line(app: &AppState) -> Line<'static> {
    let run_status = app.run_status.as_deref().unwrap_or("idle");
    let label = if app.is_running() {
        format!("● {run_status} {}", app.spinner_frame())
    } else {
        format!("● {run_status}")
    };
    let style = match run_status {
        "starting" | "running" | "awaiting_ui" => Style::default().fg(Color::White),
        "completed" => Style::default().fg(Color::LightGreen),
        "cancelled" => Style::default()
            .fg(Color::LightRed)
            .add_modifier(Modifier::DIM),
        "error" => Style::default().fg(Color::Red).add_modifier(Modifier::BOLD),
        _ => Style::default().add_modifier(Modifier::DIM),
    };
    Line::from(Span::styled(label, style))
}

fn build_status_line(app: &AppState) -> Line<'static> {
    let mut segments = Vec::new();
    match app.status_line_mode {
        StatusLineMode::Info => {
            let provider = app.current_provider.as_deref().unwrap_or("-");
            let model = app.current_model.as_deref().unwrap_or("-");
            segments.push(format!("model: {provider}/{model}"));
            if let Some(percent) = app.context_left_percent {
                segments.push(format!("context left: {percent}%"));
            }
            let image_count = app.referenced_attachment_count();
            if image_count > 0 {
                segments.push(format!("images: {image_count}"));
            }
            segments.push("Alt+H help".to_string());
        }
        StatusLineMode::Help => {
            segments.push("Esc back".to_string());
            segments.push("Ctrl+J/Shift+Enter newline".to_string());
            segments.push("Alt+V paste image".to_string());
            segments.push(format!(
                "F2 mouse: {}",
                if app.mouse_capture_enabled {
                    "on"
                } else {
                    "off"
                }
            ));
            segments.push("Ctrl+C cancel/quit".to_string());
            segments.push("Alt+H info".to_string());
        }
    }
    let status_text = segments.join("  •  ");
    Line::from(Span::styled(
        status_text,
        Style::default().add_modifier(Modifier::DIM),
    ))
}

fn build_debug_perf_lines(app: &AppState, width: usize) -> Vec<Line<'static>> {
    if !app.debug_perf_enabled || width == 0 {
        return Vec::new();
    }

    let hits = app.perf_debug.wrap_cache_hits;
    let misses = app.perf_debug.wrap_cache_misses;
    let total = hits.saturating_add(misses);
    let hit_rate = if total == 0 {
        0.0
    } else {
        (hits as f64 * 100.0) / total as f64
    };

    let line1_raw = format!(
        "perf frame:{:.2}ms draw:{:.2}ms wrap_miss:{:.2}ms wrapped:{}",
        app.perf_debug.frame_last_ms,
        app.perf_debug.draw_last_ms,
        app.perf_debug.wrap_last_miss_ms,
        app.perf_debug.wrapped_total
    );
    let line1 = truncate_to_width(&line1_raw, width);
    let line2_raw = format!(
        "cache hit:{} miss:{} rate:{:.1}% redraw:{}",
        hits, misses, hit_rate, app.perf_debug.redraw_count
    );
    let line2 = truncate_to_width(&line2_raw, width);

    vec![
        Line::from(Span::styled(
            line1,
            Style::default()
                .fg(Color::Yellow)
                .add_modifier(Modifier::DIM),
        )),
        Line::from(Span::styled(
            line2,
            Style::default()
                .fg(Color::Yellow)
                .add_modifier(Modifier::DIM),
        )),
    ]
}

pub struct LogMetrics {
    pub wrapped_total: usize,
    pub log_height: u16,
    pub log_width: usize,
}

fn masked_prompt_input(app: &AppState) -> Option<InputState> {
    app.prompt_dialog
        .as_ref()
        .filter(|panel| panel.secret)
        .map(|_| app.prompt_input.masked_clone('*'))
}

fn rendered_main_input(app: &AppState) -> Option<InputState> {
    if app.confirm_dialog.is_some() || app.prompt_dialog.is_some() {
        return None;
    }
    Some(render_input_with_attachment_labels(
        &app.input,
        &app.composer_nonce,
        &app.pending_image_attachments,
    ))
}

fn active_input_for_layout<'a>(
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

pub fn compute_log_metrics(app: &mut AppState, size: Rect) -> LogMetrics {
    let log_width = size.width as usize;
    if size.width == 0 || size.height == 0 {
        return LogMetrics {
            wrapped_total: 0,
            log_height: 0,
            log_width,
        };
    }

    let remaining_height = size.height;

    let (run_height, status_height, debug_height) = layout_heights(app);
    let footer_height = status_height.saturating_add(debug_height);
    let input_width = size.width.saturating_sub(INPUT_PADDING_X.saturating_mul(2)) as usize;
    let masked_prompt = masked_prompt_input(app);
    let rendered_main = rendered_main_input(app);
    let active_input = active_input_for_layout(app, &masked_prompt, &rendered_main);
    let input_layout = compute_input_layout(input_width.max(1), active_input);
    let max_input_height = remaining_height
        .saturating_sub(footer_height + INPUT_PADDING_Y.saturating_mul(2))
        .clamp(1, MAX_INPUT_HEIGHT);
    let mut input_height = (input_layout.lines.len() as u16).max(1);
    input_height = input_height.min(max_input_height);
    let base_input_total = input_height + INPUT_PADDING_Y.saturating_mul(2);
    let max_panel_height = remaining_height.saturating_sub(footer_height + run_height);
    if max_panel_height < base_input_total {
        return LogMetrics {
            wrapped_total: 0,
            log_height: 0,
            log_width,
        };
    }

    let panel_view = build_panel_view(app);
    let available_for_panel = max_panel_height.saturating_sub(base_input_total);
    let mut panel_gap = 0_u16;
    let mut panel_line_count = 0_u16;
    if let Some(view) = panel_view.as_ref() {
        let max_lines = if available_for_panel > PANEL_GAP {
            panel_gap = PANEL_GAP;
            available_for_panel.saturating_sub(PANEL_GAP)
        } else {
            available_for_panel
        };
        panel_line_count = build_panel_render(view, max_lines, input_width.max(1)).len() as u16;
        if panel_line_count == 0 {
            panel_gap = 0;
        }
    }
    let input_total_height = base_input_total + panel_line_count + panel_gap;

    let reserved_height = input_total_height + footer_height + run_height;
    if remaining_height < reserved_height {
        return LogMetrics {
            wrapped_total: 0,
            log_height: 0,
            log_width,
        };
    }

    let max_log_height = remaining_height.saturating_sub(reserved_height);
    let wrapped_total = cached_wrap_log_lines(app, log_width).len();
    let mut desired_log_height = (wrapped_total as u16).min(max_log_height);
    if desired_log_height == 0 && max_log_height > 0 && wrapped_total > 0 {
        desired_log_height = 1;
    }

    LogMetrics {
        wrapped_total,
        log_height: desired_log_height,
        log_width,
    }
}

pub fn log_lines_to_lines(lines: &[LogLine]) -> Vec<Line<'static>> {
    lines
        .iter()
        .map(|line| {
            let styled = line
                .spans()
                .iter()
                .map(|span| Span::styled(span.text.clone(), style_for(span.kind, span.tone)))
                .collect::<Vec<_>>();
            Line::from(styled)
        })
        .collect()
}

pub fn wrapped_log_range_to_lines(
    app: &mut AppState,
    width: usize,
    start: usize,
    end: usize,
) -> Vec<Line<'static>> {
    if width == 0 || start >= end {
        return Vec::new();
    }
    let wrapped = cached_wrap_log_lines(app, width);
    let clamped_end = end.min(wrapped.len());
    let clamped_start = start.min(clamped_end);
    if clamped_start >= clamped_end {
        return Vec::new();
    }
    log_lines_to_lines(&wrapped[clamped_start..clamped_end])
}

pub fn desired_height(app: &mut AppState, width: u16, height: u16) -> u16 {
    if width == 0 || height == 0 {
        return 0;
    }

    let remaining_height = height;

    let (run_height, status_height, debug_height) = layout_heights(app);
    let footer_height = status_height.saturating_add(debug_height);
    let input_width = width.saturating_sub(INPUT_PADDING_X.saturating_mul(2)) as usize;
    let masked_prompt = masked_prompt_input(app);
    let rendered_main = rendered_main_input(app);
    let active_input = active_input_for_layout(app, &masked_prompt, &rendered_main);
    let input_layout = compute_input_layout(input_width.max(1), active_input);
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
    let mut panel_gap = 0_u16;
    let mut panel_line_count = 0_u16;
    if let Some(view) = panel_view.as_ref() {
        let max_lines = if available_for_panel > PANEL_GAP {
            panel_gap = PANEL_GAP;
            available_for_panel.saturating_sub(PANEL_GAP)
        } else {
            available_for_panel
        };
        panel_line_count = build_panel_render(view, max_lines, input_width.max(1)).len() as u16;
        if panel_line_count == 0 {
            panel_gap = 0;
        }
    }
    let input_total_height = base_input_total + panel_line_count + panel_gap;

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

pub fn draw_ui(f: &mut crate::custom_terminal::Frame, app: &mut AppState) {
    if app.confirm_dialog.is_some() || app.prompt_dialog.is_some() {
        app.scroll_from_bottom = 0;
    }
    app.last_visible_log_valid = false;

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
    let input_layout = compute_input_layout(input_width.max(1), active_input);
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
    let mut panel_gap = 0_u16;
    let mut panel_lines = Vec::new();
    if let Some(view) = panel_view.as_ref() {
        let max_lines = if available_for_panel > PANEL_GAP {
            panel_gap = PANEL_GAP;
            available_for_panel.saturating_sub(PANEL_GAP)
        } else {
            available_for_panel
        };
        panel_lines = build_panel_render(view, max_lines, input_width.max(1));
        if panel_lines.is_empty() {
            panel_gap = 0;
        }
    }
    let input_total_height = base_input_total + panel_lines.len() as u16 + panel_gap;

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
    // In inline mode, never render lines that were already pushed into terminal scrollback.
    // This keeps the viewport strictly "after" the scrollback insertion boundary.
    let visible_start = raw_visible_start.max(app.inline_scrollback_inserted.min(wrapped_total));
    let visible_end = visible_start.saturating_add(log_height).min(wrapped_total);
    app.last_visible_log_start = visible_start;
    app.last_visible_log_end = visible_end;
    app.last_visible_log_width = log_width;
    app.last_visible_log_version = app.log_version;
    app.last_visible_log_valid = true;

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
    render_input_panel(f, input_area, &input_layout, &panel_lines, panel_gap);

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
}
