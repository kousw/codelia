use crate::app::state::LogKind;
use crate::app::{ActiveRunSubmitMode, AppState, PROMPT_DISPATCH_MAX_ATTEMPTS};
use std::time::Instant;

use super::prompt::send_steer_submission;
use super::{
    RuntimeStdin, QUEUE_CANCEL_USAGE_MESSAGE, QUEUE_CLEAR_USAGE_MESSAGE, QUEUE_EMPTY_MESSAGE,
    QUEUE_LIST_LIMIT, QUEUE_MODE_USAGE_MESSAGE, QUEUE_STEER_USAGE_MESSAGE, QUEUE_USAGE_MESSAGE,
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

fn remove_queue_target(app: &mut AppState, target: &str) -> Option<crate::app::PendingPromptRun> {
    let trimmed = target.trim();
    if trimmed.is_empty() {
        return None;
    }
    if let Some(index) = parse_queue_index_token(trimmed) {
        if index < app.pending_prompt_queue.len() {
            return app.pending_prompt_queue.remove(index);
        }
        return None;
    }
    let id = trimmed.to_ascii_lowercase();
    let position = app
        .pending_prompt_queue
        .iter()
        .position(|item| item.queue_id.eq_ignore_ascii_case(&id))?;
    app.pending_prompt_queue.remove(position)
}

fn handle_queue_cancel_target(app: &mut AppState, target: &str) {
    let trimmed = target.trim();
    if trimmed.is_empty() {
        app.push_line(LogKind::Error, QUEUE_CANCEL_USAGE_MESSAGE);
        return;
    }

    if let Some(item) = remove_queue_target(app, trimmed) {
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

fn handle_queue_mode<'a>(app: &mut AppState, parts: &mut impl Iterator<Item = &'a str>) {
    let Some(mode_arg) = parts.next() else {
        app.push_line(
            LogKind::Status,
            format!(
                "Active-run submit mode: {} (/queue mode [queue|steer|toggle])",
                app.active_run_submit_mode.label()
            ),
        );
        return;
    };
    if parts.next().is_some() {
        app.push_line(LogKind::Error, QUEUE_MODE_USAGE_MESSAGE);
        return;
    }
    let next_mode = match mode_arg {
        "queue" => ActiveRunSubmitMode::Queue,
        "steer" => ActiveRunSubmitMode::Steer,
        "toggle" => app.active_run_submit_mode.toggled(),
        _ => {
            app.push_line(LogKind::Error, QUEUE_MODE_USAGE_MESSAGE);
            return;
        }
    };
    match app.set_active_run_submit_mode(next_mode) {
        Ok(mode) => app.push_line(
            LogKind::Status,
            format!("Active-run submit mode set to {}.", mode.label()),
        ),
        Err(message) => app.push_line(LogKind::Error, message),
    }
}

fn handle_queue_steer<'a>(
    app: &mut AppState,
    child_stdin: &mut RuntimeStdin,
    next_id: &mut impl FnMut() -> String,
    parts: &mut impl Iterator<Item = &'a str>,
) {
    if app.pending_prompt_queue.is_empty() {
        app.push_line(LogKind::Status, QUEUE_EMPTY_MESSAGE);
        return;
    }
    if !app.is_running() {
        app.push_line(
            LogKind::Status,
            "No active run to steer; queued prompts will dispatch automatically.",
        );
        return;
    }
    if !app.runtime_info.supports_run_steer {
        app.push_line(LogKind::Error, "Active runtime does not support run.steer.");
        return;
    }
    let Some(run_id) = app.runtime_info.active_run_id.clone() else {
        app.push_line(
            LogKind::Status,
            "Run is still starting (run_id not assigned yet); retry /queue steer shortly.",
        );
        return;
    };

    let target = parts.collect::<Vec<_>>().join(" ");
    let trimmed = target.trim();
    if trimmed.contains(char::is_whitespace) {
        app.push_line(LogKind::Error, QUEUE_STEER_USAGE_MESSAGE);
        return;
    }
    let removed = if trimmed.is_empty() {
        app.pending_prompt_queue.pop_front()
    } else {
        remove_queue_target(app, trimmed)
    };
    let Some(item) = removed else {
        app.push_line(LogKind::Status, format!("Queue item not found: {trimmed}"));
        return;
    };

    let queue_id = item.queue_id.clone();
    if send_steer_submission(app, child_stdin, next_id, &run_id, item) {
        app.push_line(
            LogKind::Status,
            format!("Promoted queued prompt {queue_id} to mid-run steer."),
        );
    }
}

pub(super) fn handle_queue_command<'a>(
    app: &mut AppState,
    child_stdin: &mut RuntimeStdin,
    next_id: &mut impl FnMut() -> String,
    parts: &mut impl Iterator<Item = &'a str>,
) {
    let Some(subcommand) = parts.next() else {
        if app.pending_prompt_queue.is_empty() && app.in_flight_steers.is_empty() {
            app.push_line(
                LogKind::Status,
                format!(
                    "{QUEUE_EMPTY_MESSAGE} (active-run mode: {})",
                    app.active_run_submit_mode.label()
                ),
            );
            return;
        }
        let now = Instant::now();
        if !app.in_flight_steers.is_empty() {
            app.push_line(
                LogKind::Status,
                format!(
                    "steering: {} awaiting pickup (mode: {})",
                    app.in_flight_steers.len(),
                    app.active_run_submit_mode.label()
                ),
            );
            let steer_rows = app
                .in_flight_steers
                .iter()
                .take(QUEUE_LIST_LIMIT)
                .enumerate()
                .map(|(index, steer)| {
                    let steer_label = steer
                        .server_steer_id
                        .as_deref()
                        .unwrap_or(&steer.client_steer_id);
                    format!(
                        "  {}. {} [{} ago] {}",
                        index + 1,
                        steer_label,
                        queue_age_label(steer.submitted_at, now),
                        steer.submission.preview
                    )
                })
                .collect::<Vec<_>>();
            for row in steer_rows {
                app.push_line(LogKind::Status, row);
            }
        }
        if !app.pending_prompt_queue.is_empty() {
            app.push_line(
                LogKind::Status,
                format!(
                    "queue: {} pending (mode: {}; showing first {})",
                    app.pending_prompt_queue.len(),
                    app.active_run_submit_mode.label(),
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
                        "  {}. {} [{} ago] {}{}",
                        index + 1,
                        item.queue_id,
                        queue_age_label(item.queued_at, now),
                        item.preview,
                        if item.dispatch_attempts >= PROMPT_DISPATCH_MAX_ATTEMPTS {
                            " (paused)"
                        } else {
                            ""
                        }
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
        }
        return;
    };

    match subcommand {
        "mode" => {
            handle_queue_mode(app, parts);
        }
        "steer" => {
            handle_queue_steer(app, child_stdin, next_id, parts);
        }
        "retry" => {
            if parts.next().is_some() {
                app.push_line(LogKind::Error, "usage: /queue retry");
                return;
            }
            if app.pending_prompt_queue.is_empty() {
                app.push_line(LogKind::Status, QUEUE_EMPTY_MESSAGE);
                return;
            }
            // A Steer can be uploading while an ordinary prompt waits ahead of it.
            let Some(item) = app
                .pending_prompt_queue
                .iter_mut()
                .find(|item| item.dispatch_attempts >= PROMPT_DISPATCH_MAX_ATTEMPTS)
            else {
                app.push_line(LogKind::Status, "Queue is not paused.");
                return;
            };
            item.files.retry(&mut item.input_payload);
            item.dispatch_attempts = 0;
            let queue_id = item.queue_id.clone();
            app.next_queue_dispatch_retry_at = None;
            app.push_line(
                LogKind::Status,
                format!("Retrying queued prompt {queue_id}."),
            );
        }
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
