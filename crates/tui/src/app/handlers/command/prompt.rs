use crate::app::runtime::send_run_start;
use crate::app::state::LogKind;
use crate::app::util::attachments::{
    build_run_input_payload, referenced_attachment_ids, render_input_text_with_attachment_labels,
};
use crate::app::{AppState, PendingPromptRun, PROMPT_DISPATCH_RETRY_BACKOFF};
use std::time::Instant;

use super::{build_shell_result_prefix, RuntimeStdin, QUEUE_PREVIEW_MAX_CHARS};

fn truncate_preview(text: &str, max: usize) -> String {
    if max == 0 {
        return String::new();
    }
    let count = text.chars().count();
    if count <= max {
        return text.to_string();
    }
    let take = max.saturating_sub(3);
    let truncated: String = text.chars().take(take).collect();
    format!("{truncated}...")
}

fn build_prompt_preview(input: &str) -> String {
    let first = input
        .lines()
        .map(str::trim)
        .find(|line| !line.is_empty())
        .unwrap_or_default();
    if first.is_empty() {
        return "(empty)".to_string();
    }
    truncate_preview(first, QUEUE_PREVIEW_MAX_CHARS)
}

fn make_prompt_submission(app: &AppState, raw_input: &str) -> PendingPromptRun {
    let user_text = raw_input.trim().to_string();
    let shell_result_count = app.pending_shell_results.len();
    let final_input =
        if let Some(shell_prefix) = build_shell_result_prefix(&app.pending_shell_results) {
            format!("{shell_prefix}\n\n{user_text}")
        } else {
            user_text.clone()
        };
    let attachment_count = referenced_attachment_ids(
        &user_text,
        &app.composer_nonce,
        &app.pending_image_attachments,
    )
    .len();
    let input_payload = build_run_input_payload(
        &final_input,
        &app.composer_nonce,
        &app.pending_image_attachments,
    );
    PendingPromptRun {
        queue_id: String::new(),
        queued_at: Instant::now(),
        preview: build_prompt_preview(&user_text),
        user_text,
        input_payload,
        attachment_count,
        shell_result_count,
        dispatch_attempts: 0,
    }
}

fn push_user_prompt_lines(app: &mut AppState, message: &str) {
    let display_text = render_input_text_with_attachment_labels(
        message,
        &app.composer_nonce,
        &app.pending_image_attachments,
    );
    app.push_line(LogKind::User, " ");
    for (index, line) in display_text.lines().enumerate() {
        let prefix = if index == 0 { "> " } else { "  " };
        app.push_line(LogKind::User, format!("{prefix}{line}"));
    }
    for attachment_id in
        referenced_attachment_ids(message, &app.composer_nonce, &app.pending_image_attachments)
    {
        if let Some(image) = app.pending_image_attachments.get(&attachment_id) {
            app.push_line(
                LogKind::User,
                format!(
                    "  [image {}x{} {}KB]",
                    image.width,
                    image.height,
                    image.encoded_bytes / 1024
                ),
            );
        }
    }
    app.push_line(LogKind::User, " ");
}

fn dispatch_prompt_submission(
    app: &mut AppState,
    child_stdin: &mut RuntimeStdin,
    next_id: &mut impl FnMut() -> String,
    submission: &PendingPromptRun,
) -> bool {
    app.input.record_history(&submission.user_text);
    app.scroll_from_bottom = 0;
    app.last_assistant_text = None;
    push_user_prompt_lines(app, &submission.user_text);
    app.update_run_status("starting".to_string());
    let id = next_id();
    app.rpc_pending.run_start_id = Some(id.clone());
    if let Err(error) = send_run_start(
        child_stdin,
        &id,
        app.runtime_info.session_id.as_deref(),
        submission.input_payload.clone(),
        false,
    ) {
        app.rpc_pending.run_start_id = None;
        app.update_run_status("error".to_string());
        app.push_error_report("send error", error.to_string());
        return false;
    }
    true
}

pub(super) fn can_dispatch_prompt_now(app: &AppState) -> bool {
    if app.rpc_pending.run_start_id.is_some()
        || app.rpc_pending.run_cancel_id.is_some()
        || app.is_running()
    {
        return false;
    }
    app.confirm_dialog.is_none()
        && app.pending_confirm_dialog.is_none()
        && app.prompt_dialog.is_none()
        && app.pick_dialog.is_none()
        && app.provider_picker.is_none()
        && app.model_picker.is_none()
        && app.reasoning_picker.is_none()
        && app.model_list_panel.is_none()
        && app.session_list_panel.is_none()
        && app.lane_list_panel.is_none()
        && app.context_panel.is_none()
        && app.skills_list_panel.is_none()
        && app.theme_list_panel.is_none()
}

pub(super) fn try_dispatch_queued_prompt(
    app: &mut AppState,
    child_stdin: &mut RuntimeStdin,
    next_id: &mut impl FnMut() -> String,
) -> bool {
    if app.dispatching_prompt.is_some() || app.pending_prompt_queue.is_empty() {
        return false;
    }
    if !can_dispatch_prompt_now(app) {
        return false;
    }
    if let Some(retry_at) = app.next_queue_dispatch_retry_at {
        if Instant::now() < retry_at {
            return false;
        }
    }

    let Some(next_prompt) = app.pending_prompt_queue.pop_front() else {
        return false;
    };
    app.dispatching_prompt = Some(next_prompt);

    let sent = if let Some(dispatching) = app.dispatching_prompt.clone() {
        dispatch_prompt_submission(app, child_stdin, next_id, &dispatching)
    } else {
        false
    };

    if sent {
        app.next_queue_dispatch_retry_at = None;
        return true;
    }

    if let Some(failed) = app.dispatching_prompt.take() {
        app.pending_prompt_queue.push_front(failed);
    }
    app.next_queue_dispatch_retry_at = Some(Instant::now() + PROMPT_DISPATCH_RETRY_BACKOFF);
    app.push_line(
        LogKind::Status,
        format!(
            "Queued prompt dispatch failed; will retry (queue={})",
            app.pending_prompt_queue.len()
        ),
    );
    true
}

pub(super) fn start_prompt_run(
    app: &mut AppState,
    child_stdin: &mut RuntimeStdin,
    next_id: &mut impl FnMut() -> String,
    raw_input: &str,
) -> bool {
    // Keep a single submission path: always snapshot+enqueue first, then opportunistically
    // dispatch immediately when gates are open.
    let mut submission = make_prompt_submission(app, raw_input);
    if submission.user_text.is_empty() {
        return false;
    }

    let was_blocked = !can_dispatch_prompt_now(app);
    submission.queue_id = format!("q{}", app.next_prompt_queue_id);
    app.next_prompt_queue_id = app.next_prompt_queue_id.saturating_add(1);
    app.pending_prompt_queue.push_back(submission.clone());
    if submission.shell_result_count > 0 {
        app.pending_shell_results.clear();
    }

    if was_blocked {
        app.push_line(
            LogKind::Status,
            format!(
                "Queued prompt {} (queue={})",
                submission.queue_id,
                app.pending_prompt_queue.len()
            ),
        );
    }

    let _ = try_dispatch_queued_prompt(app, child_stdin, next_id);
    true
}
