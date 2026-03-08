use super::RuntimeStdin;
use crate::app::handlers;
use crate::app::handlers::confirm::handle_confirm_key;
use crate::app::runtime::{
    send_pick_response, send_prompt_response, send_run_cancel, send_shell_detach, send_tool_call,
};
use crate::app::state::{InputState, LogKind};
use crate::app::util::{
    make_attachment_token, read_clipboard_image_attachment, sanitize_paste, ClipboardImageError,
};
use crate::app::{AppState, PromptDialogState};
use crate::entry::terminal::{set_mouse_capture, TuiTerminal};
use crossterm::event::{KeyCode, KeyModifiers, MouseEventKind};
use serde_json::{json, Value};
use std::time::{Duration, Instant};

const SHIFT_ENTER_BACKSLASH_WINDOW: Duration = Duration::from_millis(80);
const MAX_CLIPBOARD_IMAGE_BYTES: usize = 5 * 1024 * 1024;
const MAX_CLIPBOARD_IMAGES_PER_MESSAGE: usize = 3;

pub(crate) fn handle_ctrl_c(
    app: &mut AppState,
    child_stdin: &mut RuntimeStdin,
    next_id: &mut impl FnMut() -> String,
) -> bool {
    if app.rpc_pending.run_cancel_id.is_some() {
        app.push_line(
            LogKind::Status,
            "Cancellation is still pending. Press Ctrl+C again quickly to force quit.",
        );
        return true;
    }

    if let Some(run_id) = app.runtime_info.active_run_id.clone() {
        let id = next_id();
        app.rpc_pending.run_cancel_id = Some(id.clone());
        if let Err(error) = send_run_cancel(child_stdin, &id, &run_id, Some("user interrupted")) {
            app.rpc_pending.run_cancel_id = None;
            app.push_error_report("send error", error.to_string());
        } else {
            app.push_line(
                LogKind::Status,
                "Cancel requested (Ctrl+C again quickly to force quit)",
            );
        }
        return true;
    }

    if app.rpc_pending.run_start_id.is_some() || app.is_running() {
        app.push_line(
            LogKind::Status,
            "Run is starting; Ctrl+C again quickly to force quit.",
        );
        return true;
    }

    false
}

pub(crate) fn maybe_request_skills_catalog(
    app: &mut AppState,
    child_stdin: &mut RuntimeStdin,
    next_id: &mut impl FnMut() -> String,
) {
    if !app.runtime_info.supports_skills_list {
        return;
    }
    if app.skills_catalog_loaded || app.rpc_pending.skills_list_id.is_some() {
        return;
    }
    let id = next_id();
    app.rpc_pending.skills_list_id = Some(id.clone());
    if let Err(error) = crate::app::runtime::send_skills_list(child_stdin, &id, false) {
        app.rpc_pending.skills_list_id = None;
        app.skills_catalog_loaded = true;
        app.push_error_report("send error", error.to_string());
    }
}

fn handle_input_edit_key(
    input: &mut InputState,
    key: KeyCode,
    modifiers: KeyModifiers,
    allow_history: bool,
    allow_ctrl_j: bool,
) -> Option<bool> {
    match (key, modifiers) {
        (KeyCode::Char('u'), mods) if mods.contains(KeyModifiers::CONTROL) => {
            input.kill_line();
            Some(true)
        }
        (KeyCode::Char('k'), mods) if mods.contains(KeyModifiers::CONTROL) => {
            input.kill_to_end();
            Some(true)
        }
        (KeyCode::Char('w'), mods) if mods.contains(KeyModifiers::CONTROL) => {
            input.delete_word_back();
            Some(true)
        }
        (KeyCode::Char('a'), mods) if mods.contains(KeyModifiers::CONTROL) => {
            input.move_home();
            Some(true)
        }
        (KeyCode::Char('e'), mods) if mods.contains(KeyModifiers::CONTROL) => {
            input.move_end();
            Some(true)
        }
        (KeyCode::Char('j'), mods) if allow_ctrl_j && mods.contains(KeyModifiers::CONTROL) => {
            // Insert newline into the composer (terminal-friendly alternative to Shift+Enter).
            input.insert_char('\n');
            Some(true)
        }
        (KeyCode::Up, _) => {
            if input.move_up() {
                Some(true)
            } else if allow_history {
                input.history_up();
                Some(true)
            } else {
                Some(false)
            }
        }
        (KeyCode::Down, _) => {
            if input.move_down() {
                Some(true)
            } else if allow_history {
                input.history_down();
                Some(true)
            } else {
                Some(false)
            }
        }
        (KeyCode::Left, _) => {
            input.move_left();
            Some(true)
        }
        (KeyCode::Right, _) => {
            input.move_right();
            Some(true)
        }
        (KeyCode::Home, _) => {
            input.move_home();
            Some(true)
        }
        (KeyCode::End, _) => {
            input.move_end();
            Some(true)
        }
        (KeyCode::Delete, _) => {
            input.delete();
            Some(true)
        }
        (KeyCode::Backspace, _) => {
            input.backspace();
            Some(true)
        }
        (KeyCode::Char(ch), mods) => {
            if !mods.contains(KeyModifiers::CONTROL) && !mods.contains(KeyModifiers::ALT) {
                input.insert_char(ch);
                Some(true)
            } else {
                Some(false)
            }
        }
        _ => None,
    }
}

pub(crate) fn handle_main_key(
    app: &mut AppState,
    key: KeyCode,
    modifiers: KeyModifiers,
    terminal: &mut TuiTerminal,
    child_stdin: &mut RuntimeStdin,
    next_id: &mut impl FnMut() -> String,
) -> bool {
    let now = Instant::now();
    let is_plain_backslash = matches!(key, KeyCode::Char('\\')) && modifiers.is_empty();
    let is_plain_enter = key == KeyCode::Enter && modifiers.is_empty();
    if !is_plain_backslash && !is_plain_enter {
        app.pending_shift_enter_backslash = None;
    }
    match (key, modifiers) {
        (KeyCode::F(2), _) => {
            app.mouse_capture_enabled = !app.mouse_capture_enabled;
            set_mouse_capture(terminal, app.mouse_capture_enabled);
            true
        }
        (KeyCode::Char('h'), mods) if mods.contains(KeyModifiers::ALT) => {
            app.toggle_status_line_mode();
            true
        }
        (KeyCode::Char('b'), mods)
            if mods.contains(KeyModifiers::CONTROL)
                && app.runtime_info.supports_shell_detach
                && app.active_shell_wait_task_id.is_some() =>
        {
            let Some(task_id) = app.active_shell_wait_task_id.clone() else {
                return false;
            };
            if app.rpc_pending.shell_detach_id.is_some() {
                app.push_line(LogKind::Status, "Shell detach is already pending.");
                return true;
            }
            let id = next_id();
            app.rpc_pending.shell_detach_id = Some(id.clone());
            if let Err(error) = send_shell_detach(child_stdin, &id, &task_id) {
                app.rpc_pending.shell_detach_id = None;
                app.push_error_report("send error", error.to_string());
            }
            true
        }
        (KeyCode::Char('l'), mods) if mods.contains(KeyModifiers::CONTROL) => {
            app.clear_log();
            true
        }
        (KeyCode::Esc, _) => {
            if app.scroll_from_bottom > 0 {
                app.scroll_from_bottom = 0;
                true
            } else if app.bang_input_mode
                && app.input.buffer.is_empty()
                && app.pending_image_attachments.is_empty()
            {
                app.bang_input_mode = false;
                true
            } else if !app.input.current().is_empty() || !app.pending_image_attachments.is_empty() {
                app.clear_composer();
                true
            } else if app.is_running() {
                if app.rpc_pending.run_cancel_id.is_some() {
                    true
                } else if let Some(run_id) = app.runtime_info.active_run_id.clone() {
                    let id = next_id();
                    app.rpc_pending.run_cancel_id = Some(id.clone());
                    if let Err(error) =
                        send_run_cancel(child_stdin, &id, &run_id, Some("user interrupted"))
                    {
                        app.rpc_pending.run_cancel_id = None;
                        app.push_error_report("send error", error.to_string());
                    } else {
                        app.push_line(LogKind::Status, "Cancel requested (Esc)");
                    }
                    true
                } else {
                    false
                }
            } else {
                false
            }
        }
        (KeyCode::Char('v'), mods) if mods.contains(KeyModifiers::ALT) => {
            handle_clipboard_image_paste(app)
        }
        (KeyCode::Char('!'), mods)
            if mods.is_empty()
                && !app.bang_input_mode
                && app.input.buffer.is_empty()
                && app.pending_image_attachments.is_empty() =>
        {
            app.bang_input_mode = true;
            true
        }
        (KeyCode::Backspace, mods)
            if mods.is_empty()
                && app.bang_input_mode
                && app.input.buffer.is_empty()
                && app.pending_image_attachments.is_empty() =>
        {
            app.bang_input_mode = false;
            true
        }
        (KeyCode::Char('\\'), mods) if mods.is_empty() => {
            app.input.insert_char('\\');
            app.pending_shift_enter_backslash = Some(now);
            true
        }
        (KeyCode::Enter, mods) if !mods.is_empty() => {
            // Only plain Enter submits; any modifiers insert a newline.
            app.input.insert_char('\n');
            true
        }
        (KeyCode::Enter, _) => {
            if let Some(armed_at) = app.pending_shift_enter_backslash {
                let within_window = now.duration_since(armed_at) <= SHIFT_ENTER_BACKSLASH_WINDOW;
                let at_end = app.input.cursor == app.input.buffer.len();
                let last_backslash = app.input.buffer.last() == Some(&'\\');
                if within_window && at_end && last_backslash {
                    app.input.backspace();
                    app.input.insert_char('\n');
                    app.pending_shift_enter_backslash = None;
                    return true;
                }
            }
            app.pending_shift_enter_backslash = None;
            handlers::handle_enter(app, child_stdin, next_id)
        }
        (KeyCode::Tab, mods) if mods.is_empty() => {
            handlers::complete_slash_command(&mut app.input)
                || handlers::complete_skill_mention(&mut app.input, &app.skills_catalog_items)
        }
        (KeyCode::PageUp, _) => {
            app.scroll_page_up();
            true
        }
        (KeyCode::PageDown, _) => {
            app.scroll_page_down();
            true
        }
        _ => handle_input_edit_key(&mut app.input, key, modifiers, true, true).unwrap_or_default(),
    }
}

pub(crate) fn handle_paste(app: &mut AppState, text: &str) -> bool {
    let cleaned = sanitize_paste(text);
    if cleaned.is_empty() {
        return false;
    }
    if blocks_composer_paste(app) {
        return false;
    }
    if app.prompt_dialog.is_some() {
        app.prompt_input.insert_str(&cleaned);
    } else {
        app.input.insert_str(&cleaned);
    }
    true
}

fn can_paste_clipboard_image(app: &AppState) -> bool {
    !blocks_composer_paste(app)
}

pub(crate) fn blocks_input_paste(app: &AppState) -> bool {
    app.confirm_dialog.is_some()
        || app.pending_confirm_dialog.is_some()
        || app.pick_dialog.is_some()
        || app.reasoning_picker.is_some()
        || app.lane_list_panel.is_some()
}

fn blocks_composer_paste(app: &AppState) -> bool {
    blocks_input_paste(app) || app.skills_list_panel.is_some() || app.theme_list_panel.is_some()
}

fn append_clipboard_image(app: &mut AppState) -> Result<(), ClipboardImageError> {
    let image = read_clipboard_image_attachment(MAX_CLIPBOARD_IMAGE_BYTES)?;
    let attachment_id = app.next_image_attachment_id();
    let token = make_attachment_token(&app.composer_nonce, &attachment_id);
    app.add_pending_image_attachment(attachment_id, image.clone());
    app.input.insert_str(&token);
    let summary = format!(
        "Attached image {}x{} ({}KB)",
        image.width,
        image.height,
        image.encoded_bytes / 1024
    );
    app.push_line(LogKind::Status, summary);
    Ok(())
}

fn report_clipboard_paste_error(app: &mut AppState, error: ClipboardImageError) {
    match error {
        ClipboardImageError::NotAvailable => {
            app.push_line(LogKind::Status, "No image found in clipboard");
        }
        ClipboardImageError::TooLarge { bytes, max_bytes } => {
            app.push_line(
                LogKind::Error,
                format!(
                    "Clipboard image is too large ({}KB > {}KB)",
                    bytes / 1024,
                    max_bytes / 1024
                ),
            );
        }
        ClipboardImageError::Clipboard(error) | ClipboardImageError::Encode(error) => {
            app.push_line(
                LogKind::Error,
                format!("Clipboard image paste failed: {error}"),
            );
        }
    }
}

fn handle_clipboard_image_paste(app: &mut AppState) -> bool {
    if !can_paste_clipboard_image(app) {
        return false;
    }
    if app.prompt_dialog.is_some() {
        app.push_line(
            LogKind::Status,
            "Image paste is unavailable while prompt input is active",
        );
        return true;
    }
    if app.pending_image_attachments.len() >= MAX_CLIPBOARD_IMAGES_PER_MESSAGE {
        app.push_line(
            LogKind::Error,
            format!(
                "Image attachment limit reached ({MAX_CLIPBOARD_IMAGES_PER_MESSAGE} per message)"
            ),
        );
        return true;
    }

    if let Err(error) = append_clipboard_image(app) {
        report_clipboard_paste_error(app, error);
    }
    true
}

fn handle_prompt_key(
    app: &mut AppState,
    key: KeyCode,
    modifiers: KeyModifiers,
    child_stdin: &mut RuntimeStdin,
    next_id: &mut impl FnMut() -> String,
) -> Option<bool> {
    let prompt = app.prompt_dialog.as_ref()?;
    let prompt_id = prompt.id.clone();
    let multiline = prompt.multiline;
    let secret = prompt.secret;

    let mut handled = true;
    match (key, modifiers) {
        (KeyCode::Esc, _) => {
            app.prompt_dialog = None;
            app.prompt_input.clear();
            app.rpc_pending.new_lane_seed_context = None;
            if prompt_id != "lane:new-task" && prompt_id != "lane:new-seed" {
                if let Err(error) = send_prompt_response(child_stdin, &prompt_id, None) {
                    app.push_error_report("prompt response error", error.to_string());
                }
            }
        }
        (KeyCode::Enter, mods) if mods.contains(KeyModifiers::SHIFT) && multiline => {
            app.prompt_input.insert_char('\n');
        }
        (KeyCode::Enter, _) => {
            let value = app.prompt_input.current();
            app.prompt_dialog = None;
            app.prompt_input.clear();

            if prompt_id == "lane:new-task" {
                let task_id = value.trim();
                if task_id.is_empty() {
                    app.push_line(LogKind::Error, "task_id is required");
                    app.rpc_pending.new_lane_seed_context = None;
                    app.prompt_dialog = Some(PromptDialogState {
                        id: "lane:new-task".to_string(),
                        title: "New lane".to_string(),
                        message: "Task id".to_string(),
                        multiline: false,
                        secret: false,
                    });
                    return Some(true);
                }
                app.rpc_pending.new_lane_seed_context = Some(task_id.to_string());
                app.prompt_dialog = Some(PromptDialogState {
                    id: "lane:new-seed".to_string(),
                    title: "New lane".to_string(),
                    message: "Seed context (optional)".to_string(),
                    multiline: true,
                    secret: false,
                });
                return Some(true);
            }

            if prompt_id == "lane:new-seed" {
                if let Some(task_id) = app.rpc_pending.new_lane_seed_context.take() {
                    let mut args = serde_json::Map::new();
                    args.insert("task_id".to_string(), Value::String(task_id));
                    let seed = value.trim();
                    if !seed.is_empty() {
                        args.insert("seed_context".to_string(), Value::String(seed.to_string()));
                    }
                    let id = next_id();
                    app.rpc_pending.lane_create_id = Some(id.clone());
                    if let Err(error) =
                        send_tool_call(child_stdin, &id, "lane_create", Value::Object(args))
                    {
                        app.rpc_pending.lane_create_id = None;
                        app.push_error_report("send error", error.to_string());
                    }
                }
                return Some(true);
            }

            if let Err(error) = send_prompt_response(child_stdin, &prompt_id, Some(value.as_str()))
            {
                app.push_error_report("prompt response error", error.to_string());
            }
        }
        _ => {
            handled =
                handle_input_edit_key(&mut app.prompt_input, key, modifiers, !secret, multiline)
                    .unwrap_or_default();
        }
    }

    Some(handled)
}

fn handle_pick_key(
    app: &mut AppState,
    key: KeyCode,
    child_stdin: &mut RuntimeStdin,
    next_id: &mut impl FnMut() -> String,
) -> Option<bool> {
    let pick = app.pick_dialog.as_mut()?;
    let mut handled = true;
    match key {
        KeyCode::Esc => {
            let ids: Vec<String> = Vec::new();
            let id = pick.id.clone();
            app.pick_dialog = None;
            if let Err(error) = send_pick_response(child_stdin, &id, &ids) {
                app.push_error_report("pick response error", error.to_string());
            }
        }
        KeyCode::Up => {
            pick.selected = pick.selected.saturating_sub(1);
        }
        KeyCode::Down => {
            if pick.selected + 1 < pick.items.len() {
                pick.selected += 1;
            }
        }
        KeyCode::Enter => {
            let id = pick.id.clone();
            let ids = if pick.multi {
                pick.items
                    .iter()
                    .enumerate()
                    .filter_map(|(idx, item)| {
                        pick.chosen
                            .get(idx)
                            .copied()
                            .unwrap_or(false)
                            .then_some(item.id.clone())
                    })
                    .collect::<Vec<_>>()
            } else {
                pick.items
                    .get(pick.selected)
                    .map(|item| vec![item.id.clone()])
                    .unwrap_or_default()
            };
            app.pick_dialog = None;

            if let Some(lane_id) = id.strip_prefix("lane:action:") {
                if let Some(action) = ids.first() {
                    let request_id = next_id();
                    match action.as_str() {
                        "status" => {
                            app.rpc_pending.lane_status_id = Some(request_id.clone());
                            if let Err(error) = send_tool_call(
                                child_stdin,
                                &request_id,
                                "lane_status",
                                json!({ "lane_id": lane_id }),
                            ) {
                                app.rpc_pending.lane_status_id = None;
                                app.push_error_report("send error", error.to_string());
                            }
                        }
                        "close" => {
                            app.rpc_pending.lane_close_id = Some(request_id.clone());
                            if let Err(error) = send_tool_call(
                                child_stdin,
                                &request_id,
                                "lane_close",
                                json!({ "lane_id": lane_id }),
                            ) {
                                app.rpc_pending.lane_close_id = None;
                                app.push_error_report("send error", error.to_string());
                            }
                        }
                        _ => {}
                    }
                }
                return Some(true);
            }

            if let Err(error) = send_pick_response(child_stdin, &id, &ids) {
                app.push_error_report("pick response error", error.to_string());
            }
        }
        KeyCode::Char(' ') if pick.multi => {
            if let Some(choice) = pick.chosen.get_mut(pick.selected) {
                *choice = !*choice;
            }
        }
        KeyCode::Char(ch) if ch.is_ascii_digit() => {
            let index = ch.to_digit(10).unwrap_or(0) as usize;
            if index > 0 && index <= pick.items.len() {
                pick.selected = index - 1;
            }
        }
        _ => handled = false,
    }
    Some(handled)
}

pub(crate) fn handle_mouse_event(app: &mut AppState, kind: MouseEventKind) -> bool {
    match kind {
        MouseEventKind::ScrollUp => {
            app.scroll_up(3);
            true
        }
        MouseEventKind::ScrollDown => {
            app.scroll_down(3);
            true
        }
        _ => false,
    }
}

pub(crate) fn apply_redraw(needs_redraw: &mut bool, redraw: bool) {
    if redraw {
        *needs_redraw = true;
    }
}

pub(crate) fn handle_non_main_key(
    app: &mut AppState,
    key: KeyCode,
    modifiers: KeyModifiers,
    child_stdin: &mut RuntimeStdin,
    next_id: &mut impl FnMut() -> String,
) -> Option<bool> {
    if let Some(redraw) = handle_confirm_key(app, key, modifiers, child_stdin) {
        return Some(redraw);
    }
    if app.pending_confirm_dialog.is_some() {
        return Some(false);
    }

    if let Some(redraw) = handle_prompt_key(app, key, modifiers, child_stdin, next_id) {
        return Some(redraw);
    }

    if let Some(redraw) = handle_pick_key(app, key, child_stdin, next_id) {
        return Some(redraw);
    }

    if let Some(redraw) =
        crate::app::handlers::panels::handle_session_list_panel_key(app, key, child_stdin, next_id)
    {
        return Some(redraw);
    }

    if let Some(redraw) =
        crate::app::handlers::panels::handle_lane_list_panel_key(app, key, child_stdin, next_id)
    {
        return Some(redraw);
    }

    if let Some(redraw) = crate::app::handlers::panels::handle_skills_list_panel_key(app, key) {
        return Some(redraw);
    }

    if let Some(redraw) =
        crate::app::handlers::panels::handle_theme_list_panel_key(app, key, child_stdin, next_id)
    {
        return Some(redraw);
    }

    if let Some(redraw) = crate::app::handlers::panels::handle_context_panel_key(app, key) {
        return Some(redraw);
    }

    if let Some(redraw) =
        crate::app::handlers::panels::handle_model_list_panel_key(app, key, child_stdin, next_id)
    {
        return Some(redraw);
    }

    if let Some(redraw) =
        crate::app::handlers::panels::handle_provider_picker_key(app, key, child_stdin, next_id)
    {
        return Some(redraw);
    }

    if let Some(redraw) =
        crate::app::handlers::panels::handle_model_picker_key(app, key, child_stdin, next_id)
    {
        return Some(redraw);
    }

    if let Some(redraw) =
        crate::app::handlers::panels::handle_reasoning_picker_key(app, key, child_stdin, next_id)
    {
        return Some(redraw);
    }

    None
}
