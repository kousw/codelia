use crate::app::state::{
    active_skill_mention_token, command_suggestion_rows, skill_suggestion_rows,
};
use crate::app::AppState;

use super::types::PanelView;

const COMMAND_PANEL_LIMIT: usize = 6;
const QUEUE_PANEL_LIMIT: usize = 4;

pub(super) fn build_queue_panel_view(app: &AppState) -> Option<PanelView> {
    if app.pending_prompt_queue.is_empty() {
        return None;
    }

    let mut lines = Vec::new();
    lines.push(format!("pending: {}", app.pending_prompt_queue.len()));
    lines.extend(app.pending_prompt_queue.iter().take(QUEUE_PANEL_LIMIT).map(|item| {
        let mut meta = Vec::new();
        if item.attachment_count > 0 {
            meta.push(format!("img:{}", item.attachment_count));
        }
        if item.shell_result_count > 0 {
            meta.push(format!("shell:{}", item.shell_result_count));
        }
        if meta.is_empty() {
            format!("{}  {}", item.queue_id, item.preview)
        } else {
            format!("{}  {} ({})", item.queue_id, item.preview, meta.join(", "))
        }
    }));
    if app.pending_prompt_queue.len() > QUEUE_PANEL_LIMIT {
        lines.push(format!(
            "... and {} more",
            app.pending_prompt_queue
                .len()
                .saturating_sub(QUEUE_PANEL_LIMIT)
        ));
    }

    Some(PanelView {
        title: Some("Queued prompts".to_string()),
        lines,
        header_index: Some(0),
        selected: None,
        wrap_lines: true,
        tail_pinned_from: None,
    })
}

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

#[cfg(test)]
mod tests {
    use super::build_queue_panel_view;
    use crate::app::{AppState, PendingPromptRun};
    use serde_json::json;
    use std::time::Instant;

    fn queued(id: &str, preview: &str) -> PendingPromptRun {
        PendingPromptRun {
            queue_id: id.to_string(),
            queued_at: Instant::now(),
            preview: preview.to_string(),
            user_text: preview.to_string(),
            input_payload: json!({"type": "text", "text": preview}),
            attachment_count: 0,
            shell_result_count: 0,
            dispatch_attempts: 0,
        }
    }

    #[test]
    fn queue_panel_hidden_when_empty() {
        let app = AppState::default();
        assert!(build_queue_panel_view(&app).is_none());
    }

    #[test]
    fn queue_panel_shows_count_and_rows_with_overflow_summary() {
        let mut app = AppState::default();
        app.pending_prompt_queue.push_back(queued("q1", "first"));
        app.pending_prompt_queue.push_back(queued("q2", "second"));
        app.pending_prompt_queue.push_back(queued("q3", "third"));
        app.pending_prompt_queue.push_back(queued("q4", "fourth"));
        app.pending_prompt_queue.push_back(queued("q5", "fifth"));

        let panel = build_queue_panel_view(&app).expect("queue panel");

        assert_eq!(panel.title.as_deref(), Some("Queued prompts"));
        assert_eq!(panel.header_index, Some(0));
        assert_eq!(panel.lines[0], "pending: 5");
        assert_eq!(panel.lines[1], "q1  first");
        assert_eq!(panel.lines[4], "q4  fourth");
        assert_eq!(panel.lines[5], "... and 1 more");
    }
}
