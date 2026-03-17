use crate::app::state::LogKind;
use crate::app::AppState;
use std::time::Instant;

use super::{
    QUEUE_CANCEL_USAGE_MESSAGE, QUEUE_CLEAR_USAGE_MESSAGE, QUEUE_EMPTY_MESSAGE, QUEUE_LIST_LIMIT,
    QUEUE_USAGE_MESSAGE,
};

fn queue_age_label(queued_at: Instant, now: Instant) -> String {
    let elapsed = now.saturating_duration_since(queued_at).as_secs();
    if elapsed < 60 {
        return format!("{elapsed}s");
    }
    let minutes = elapsed / 60;
    let seconds = elapsed % 60;
    format!("{minutes}m{seconds:02}s")
}

fn parse_queue_index_token(token: &str) -> Option<usize> {
    let normalized = token.strip_prefix('#').unwrap_or(token);
    normalized
        .parse::<usize>()
        .ok()
        .and_then(|value| value.checked_sub(1))
}

fn handle_queue_cancel_target(app: &mut AppState, target: &str) {
    let trimmed = target.trim();
    if trimmed.is_empty() {
        app.push_line(LogKind::Error, QUEUE_CANCEL_USAGE_MESSAGE);
        return;
    }
    let index = parse_queue_index_token(trimmed);

    let removed = if let Some(index) = index {
        if index < app.pending_prompt_queue.len() {
            app.pending_prompt_queue.remove(index)
        } else {
            None
        }
    } else {
        let id = trimmed.to_ascii_lowercase();
        if let Some(position) = app
            .pending_prompt_queue
            .iter()
            .position(|item| item.queue_id.eq_ignore_ascii_case(&id))
        {
            app.pending_prompt_queue.remove(position)
        } else {
            None
        }
    };

    if let Some(item) = removed {
        app.push_line(
            LogKind::Status,
            format!(
                "Cancelled queued prompt {} (queue={})",
                item.queue_id,
                app.pending_prompt_queue.len()
            ),
        );
    } else {
        app.push_line(LogKind::Status, format!("Queue item not found: {trimmed}"));
    }
}

pub(super) fn handle_queue_command<'a>(
    app: &mut AppState,
    parts: &mut impl Iterator<Item = &'a str>,
) {
    let Some(subcommand) = parts.next() else {
        if app.pending_prompt_queue.is_empty() {
            app.push_line(LogKind::Status, QUEUE_EMPTY_MESSAGE);
            return;
        }
        let now = Instant::now();
        app.push_line(
            LogKind::Status,
            format!(
                "queue: {} pending (showing first {})",
                app.pending_prompt_queue.len(),
                QUEUE_LIST_LIMIT.min(app.pending_prompt_queue.len())
            ),
        );
        let queue_rows = app
            .pending_prompt_queue
            .iter()
            .take(QUEUE_LIST_LIMIT)
            .enumerate()
            .map(|(index, item)| {
                format!(
                    "  {}. {} [{} ago] {}",
                    index + 1,
                    item.queue_id,
                    queue_age_label(item.queued_at, now),
                    item.preview
                )
            })
            .collect::<Vec<_>>();
        for row in queue_rows {
            app.push_line(LogKind::Status, row);
        }
        if app.pending_prompt_queue.len() > QUEUE_LIST_LIMIT {
            app.push_line(
                LogKind::Status,
                format!(
                    "  ... {} more",
                    app.pending_prompt_queue
                        .len()
                        .saturating_sub(QUEUE_LIST_LIMIT)
                ),
            );
        }
        return;
    };

    match subcommand {
        "cancel" => {
            if app.pending_prompt_queue.is_empty() {
                app.push_line(LogKind::Status, QUEUE_EMPTY_MESSAGE);
                return;
            }
            let rest = parts.collect::<Vec<_>>().join(" ");
            if rest.trim().is_empty() {
                if let Some(item) = app.pending_prompt_queue.pop_front() {
                    app.push_line(
                        LogKind::Status,
                        format!(
                            "Cancelled queued prompt {} (queue={})",
                            item.queue_id,
                            app.pending_prompt_queue.len()
                        ),
                    );
                }
                return;
            }
            handle_queue_cancel_target(app, &rest);
        }
        "clear" => {
            if parts.next().is_some() {
                app.push_line(LogKind::Error, QUEUE_CLEAR_USAGE_MESSAGE);
                return;
            }
            if app.pending_prompt_queue.is_empty() {
                app.push_line(LogKind::Status, QUEUE_EMPTY_MESSAGE);
                return;
            }
            let cleared = app.pending_prompt_queue.len();
            app.pending_prompt_queue.clear();
            app.push_line(LogKind::Status, format!("Cleared queue ({cleared} items)."));
        }
        _ => {
            app.push_line(LogKind::Error, QUEUE_USAGE_MESSAGE);
        }
    }
}
