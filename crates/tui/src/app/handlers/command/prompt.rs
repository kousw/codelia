use crate::app::runtime::{send_run_start, send_run_steer};
use crate::app::state::LogKind;
use crate::app::util::attachments::{
    build_run_input_payload, referenced_attachment_ids, render_input_text_with_attachment_labels,
};
use crate::app::{
    ActiveRunSubmitMode, AppState, InFlightSteer, PendingPromptRun, PROMPT_DISPATCH_MAX_ATTEMPTS,
};
use std::collections::VecDeque;
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

pub(crate) fn insert_pending_prompt_ordered(
    queue: &mut VecDeque<PendingPromptRun>,
    item: PendingPromptRun,
) {
    let pos = queue
        .iter()
        .position(|existing| {
            existing.dispatch_attempts < PROMPT_DISPATCH_MAX_ATTEMPTS && existing.seq > item.seq
        })
        .unwrap_or(queue.len());
    queue.insert(pos, item);
}

fn make_prompt_submission(app: &mut AppState, raw_input: &str) -> PendingPromptRun {
    let user_text = raw_input.trim().to_string();
    let display_text = render_input_text_with_attachment_labels(
        &user_text,
        &app.composer_nonce,
        &app.pending_image_attachments,
        &app.pending_staged_attachments,
    );
    let attachment_ids = referenced_attachment_ids(
        &user_text,
        &app.composer_nonce,
        &app.pending_image_attachments,
        &app.pending_staged_attachments,
    );
    let image_descriptions = attachment_ids
        .iter()
        .filter_map(|attachment_id| {
            app.pending_image_attachments
                .get(attachment_id)
                .map(|image| {
                    format!(
                        "  [image {}x{} {}KB]",
                        image.width,
                        image.height,
                        image.encoded_bytes / 1024
                    )
                })
        })
        .collect::<Vec<_>>();
    let shell_result_count = app.pending_shell_results.len();
    let final_input =
        if let Some(shell_prefix) = build_shell_result_prefix(&app.pending_shell_results) {
            format!("{shell_prefix}\n\n{user_text}")
        } else {
            user_text.clone()
        };
    let input_payload = build_run_input_payload(
        &final_input,
        &app.composer_nonce,
        &app.pending_image_attachments,
        &app.pending_staged_attachments,
    );
    let files = super::upload::SubmissionFiles::snapshot(app, &input_payload);
    let attachment_count = attachment_ids.len();
    let seq = app.allocate_submit_seq();
    PendingPromptRun {
        seq,
        queue_id: String::new(),
        queued_at: Instant::now(),
        preview: build_prompt_preview(&display_text),
        user_text,
        display_text,
        image_descriptions,
        input_payload,
        files,
        attachment_count,
        shell_result_count,
        dispatch_attempts: 0,
    }
}

fn push_user_prompt_lines(app: &mut AppState, submission: &PendingPromptRun) {
    app.extend_lines(crate::app::util::user_message::user_message_lines(
        &submission.display_text,
        &submission.image_descriptions,
    ));
}

fn dispatch_prompt_submission(
    app: &mut AppState,
    child_stdin: &mut RuntimeStdin,
    next_id: &mut impl FnMut() -> String,
    submission: &PendingPromptRun,
) -> bool {
    app.input.record_history(&submission.display_text);
    app.scroll_from_bottom = 0;
    app.last_assistant_text = None;
    push_user_prompt_lines(app, submission);
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

pub(super) fn send_steer_submission(
    app: &mut AppState,
    child_stdin: &mut RuntimeStdin,
    next_id: &mut impl FnMut() -> String,
    run_id: &str,
    mut submission: PendingPromptRun,
) -> bool {
    if !submission.files.items.is_empty()
        || app
            .pending_prompt_queue
            .iter()
            .any(|p| p.files.steer_target.as_deref() == Some(run_id))
    {
        submission.files.steer_target = Some(run_id.to_owned());
        if submission.queue_id.is_empty() {
            submission.queue_id = app.allocate_prompt_queue_id();
        }
        insert_pending_prompt_ordered(&mut app.pending_prompt_queue, submission);
        return true;
    }
    send_ready_steer(app, child_stdin, next_id, run_id, submission)
}

pub(super) fn send_ready_steer(
    app: &mut AppState,
    child_stdin: &mut RuntimeStdin,
    next_id: &mut impl FnMut() -> String,
    run_id: &str,
    mut submission: PendingPromptRun,
) -> bool {
    app.input.record_history(&submission.display_text);
    app.scroll_from_bottom = 0;
    let client_steer_id = app.allocate_client_steer_id();
    let rpc_id = next_id();
    let input_payload = submission.input_payload.clone();
    let steer = InFlightSteer {
        client_steer_id: client_steer_id.clone(),
        server_steer_id: None,
        run_id: run_id.to_string(),
        submitted_at: Instant::now(),
        submission: submission.clone(),
    };
    app.in_flight_steers.push_back(steer);
    app.rpc_pending
        .run_steer_ids
        .insert(rpc_id.clone(), client_steer_id.clone());
    if let Err(error) = send_run_steer(
        child_stdin,
        &rpc_id,
        run_id,
        input_payload,
        Some(&client_steer_id),
    ) {
        app.rpc_pending.run_steer_ids.remove(&rpc_id);
        if let Some(pos) = app
            .in_flight_steers
            .iter()
            .position(|item| item.client_steer_id == client_steer_id)
        {
            app.in_flight_steers.remove(pos);
        }
        if submission.queue_id.is_empty() {
            submission.queue_id = app.allocate_prompt_queue_id();
        }
        let queue_id = submission.queue_id.clone();
        submission.dispatch_attempts = PROMPT_DISPATCH_MAX_ATTEMPTS;
        app.pending_prompt_queue.push_front(submission);
        app.push_error_report("send error", error.to_string());
        app.push_line(
            LogKind::Error,
            format!(
                "Paused fallback steer {queue_id}: send outcome is unknown. Use /queue retry or /queue cancel."
            ),
        );
        return false;
    }
    true
}

pub(super) fn can_dispatch_prompt_now(app: &AppState) -> bool {
    if app.goal.blocks_prompt()
        || app.rpc_pending.run_start_id.is_some()
        || app.rpc_pending.run_cancel_id.is_some()
        || app.is_running()
        || app
            .pending_prompt_queue
            .front()
            .is_some_and(|item| item.dispatch_attempts >= PROMPT_DISPATCH_MAX_ATTEMPTS)
    {
        return false;
    }
    !app.image_preview.is_open()
        && app.confirm_dialog.is_none()
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
    if let Some(progress) = super::upload::drive(app, child_stdin, next_id) {
        return progress;
    }
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

    if let Some(mut failed) = app.dispatching_prompt.take() {
        let queue_id = failed.queue_id.clone();
        failed.dispatch_attempts = PROMPT_DISPATCH_MAX_ATTEMPTS;
        app.pending_prompt_queue.push_front(failed);
        app.push_line(
            LogKind::Error,
            format!("Paused queued prompt {queue_id}: send outcome is unknown. Check whether the run started before /queue retry, or use /queue cancel."),
        );
    }
    app.next_queue_dispatch_retry_at = None;
    true
}

pub(super) fn start_explicit_steer_run(
    app: &mut AppState,
    child_stdin: &mut RuntimeStdin,
    next_id: &mut impl FnMut() -> String,
    raw_arg: &str,
) -> bool {
    let trimmed = raw_arg.trim();
    if trimmed.is_empty() {
        app.push_line(LogKind::Error, "usage: /steer <text>");
        return false;
    }

    if !app.is_running() {
        return start_prompt_run(app, child_stdin, next_id, raw_arg);
    }

    if !app.runtime_info.supports_run_steer {
        app.push_line(
            LogKind::Error,
            "Active runtime does not support run.steer; submit normally to queue instead.",
        );
        return false;
    }

    let Some(run_id) = app.runtime_info.active_run_id.clone() else {
        app.push_line(
            LogKind::Status,
            "Run is still starting (run_id not assigned yet); retry /steer shortly or submit to queue.",
        );
        return false;
    };

    let submission = make_prompt_submission(app, raw_arg);
    if submission.user_text.is_empty() {
        app.push_line(LogKind::Error, "usage: /steer <text>");
        return false;
    }
    if submission.shell_result_count > 0 {
        app.pending_shell_results.clear();
    }
    let _ = send_steer_submission(app, child_stdin, next_id, &run_id, submission);
    true
}

pub(super) fn start_prompt_run(
    app: &mut AppState,
    child_stdin: &mut RuntimeStdin,
    next_id: &mut impl FnMut() -> String,
    raw_input: &str,
) -> bool {
    if raw_input.trim().is_empty() {
        return false;
    }

    if app.is_running()
        && app.active_run_submit_mode == ActiveRunSubmitMode::Steer
        && app.runtime_info.supports_run_steer
    {
        if let Some(run_id) = app.runtime_info.active_run_id.clone() {
            let submission = make_prompt_submission(app, raw_input);
            if submission.user_text.is_empty() {
                return false;
            }
            if submission.shell_result_count > 0 {
                app.pending_shell_results.clear();
            }
            let _ = send_steer_submission(app, child_stdin, next_id, &run_id, submission);
            return true;
        }
    }

    // Keep a single submission path: always snapshot+enqueue first, then opportunistically
    // dispatch immediately when gates are open.
    let mut submission = make_prompt_submission(app, raw_input);
    if submission.user_text.is_empty() {
        return false;
    }

    let was_blocked = !can_dispatch_prompt_now(app);
    submission.queue_id = app.allocate_prompt_queue_id();
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
