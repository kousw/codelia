use crate::app::state::{
    active_skill_mention_token, command_suggestion_rows, skill_suggestion_rows,
};
use crate::app::AppState;

use super::types::PanelView;

const COMMAND_PANEL_LIMIT: usize = 6;

pub(super) fn build_command_panel_view(app: &AppState) -> Option<PanelView> {
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

pub(super) fn build_skill_suggestion_panel_view(app: &AppState) -> Option<PanelView> {
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

pub(super) fn build_attachment_panel_view(app: &AppState) -> Option<PanelView> {
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
