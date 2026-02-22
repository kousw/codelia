use crate::app::runtime::{send_confirm_response, UiConfirmRequest};
use crate::app::{AppState, ConfirmMode, ConfirmPhase};
use crossterm::event::{KeyCode, KeyModifiers};
use std::io::BufWriter;
use std::process::ChildStdin;

pub fn handle_confirm_request(app: &mut AppState, request: UiConfirmRequest) {
    app.scroll_from_bottom = 0;
    app.confirm_input.clear();
    app.confirm_dialog = None;
    app.pending_confirm_dialog = Some(crate::app::ConfirmDialogState {
        id: request.id,
        title: request.title,
        message: request.message,
        danger_level: request.danger_level,
        confirm_label: request.confirm_label.unwrap_or_else(|| "Yes".to_string()),
        cancel_label: request.cancel_label.unwrap_or_else(|| "No".to_string()),
        allow_remember: request.allow_remember,
        allow_reason: request.allow_reason,
        selected: 0,
        mode: ConfirmMode::Select,
    });
    app.render_state.confirm_phase = ConfirmPhase::Pending;
}

pub fn activate_pending_confirm_dialog(app: &mut AppState) -> bool {
    if app.render_state.confirm_phase != ConfirmPhase::Pending || app.confirm_dialog.is_some() {
        return false;
    }
    let Some(pending_confirm) = app.pending_confirm_dialog.take() else {
        app.render_state.confirm_phase = ConfirmPhase::None;
        return false;
    };
    app.confirm_dialog = Some(pending_confirm);
    app.render_state.confirm_phase = ConfirmPhase::Active;
    true
}

struct ConfirmResponse {
    ok: bool,
    remember: bool,
    reason: Option<String>,
}

struct ConfirmKeyUpdate {
    selected: usize,
    mode: ConfirmMode,
    consume: bool,
    response: Option<ConfirmResponse>,
}

fn confirm_cancel_index(allow_remember: bool) -> usize {
    if allow_remember {
        2
    } else {
        1
    }
}

fn confirm_option_count(allow_remember: bool) -> usize {
    if allow_remember {
        3
    } else {
        2
    }
}

fn handle_confirm_select_key(
    key: KeyCode,
    selected: usize,
    allow_remember: bool,
    allow_reason: bool,
) -> ConfirmKeyUpdate {
    let mut update = ConfirmKeyUpdate {
        selected,
        mode: ConfirmMode::Select,
        consume: true,
        response: None,
    };

    match key {
        KeyCode::Up => {
            update.selected = update.selected.saturating_sub(1);
        }
        KeyCode::Down => {
            let max_index = confirm_option_count(allow_remember).saturating_sub(1);
            update.selected = usize::min(update.selected + 1, max_index);
        }
        KeyCode::Char('1') => update.selected = 0,
        KeyCode::Char('2') => {
            if confirm_option_count(allow_remember) >= 2 {
                update.selected = 1;
            }
        }
        KeyCode::Char('3') => {
            if allow_remember {
                update.selected = 2;
            }
        }
        KeyCode::Tab => {
            if allow_reason {
                update.selected = confirm_cancel_index(allow_remember);
                update.mode = ConfirmMode::Reason;
            } else {
                update.consume = false;
            }
        }
        KeyCode::Enter => {
            let (ok, remember) = match update.selected {
                0 => (true, false),
                1 if allow_remember => (true, true),
                _ => (false, false),
            };
            update.response = Some(ConfirmResponse {
                ok,
                remember,
                reason: None,
            });
        }
        KeyCode::Char('y') | KeyCode::Char('Y') => {
            update.response = Some(ConfirmResponse {
                ok: true,
                remember: false,
                reason: None,
            });
        }
        KeyCode::Char('n') | KeyCode::Char('N') | KeyCode::Esc => {
            update.response = Some(ConfirmResponse {
                ok: false,
                remember: false,
                reason: None,
            });
        }
        _ => {
            update.consume = false;
        }
    }

    update
}

fn handle_confirm_reason_key(
    app: &mut AppState,
    key: KeyCode,
    modifiers: KeyModifiers,
    selected: usize,
) -> ConfirmKeyUpdate {
    let mut update = ConfirmKeyUpdate {
        selected,
        mode: ConfirmMode::Reason,
        consume: true,
        response: None,
    };

    match key {
        KeyCode::Esc | KeyCode::Tab => {
            update.mode = ConfirmMode::Select;
        }
        KeyCode::Enter => {
            let text = app.confirm_input.current();
            update.response = Some(ConfirmResponse {
                ok: false,
                remember: false,
                reason: (!text.trim().is_empty()).then_some(text),
            });
        }
        KeyCode::Backspace => {
            app.confirm_input.backspace();
        }
        KeyCode::Delete => {
            app.confirm_input.delete();
        }
        KeyCode::Left => {
            app.confirm_input.move_left();
        }
        KeyCode::Right => {
            app.confirm_input.move_right();
        }
        KeyCode::Home => {
            app.confirm_input.move_home();
        }
        KeyCode::End => {
            app.confirm_input.move_end();
        }
        KeyCode::Char(ch) => {
            if !modifiers.contains(KeyModifiers::CONTROL) && !modifiers.contains(KeyModifiers::ALT)
            {
                app.confirm_input.insert_char(ch);
            }
        }
        _ => {
            update.consume = false;
        }
    }

    update
}

pub fn handle_confirm_key(
    app: &mut AppState,
    key: KeyCode,
    modifiers: KeyModifiers,
    child_stdin: &mut BufWriter<ChildStdin>,
) -> Option<bool> {
    let (confirm_id, mode, selected, allow_remember, allow_reason) = {
        let confirm = app.confirm_dialog.as_ref()?;
        (
            confirm.id.clone(),
            confirm.mode,
            confirm.selected,
            confirm.allow_remember,
            confirm.allow_reason,
        )
    };

    let update = match mode {
        ConfirmMode::Select => {
            handle_confirm_select_key(key, selected, allow_remember, allow_reason)
        }
        ConfirmMode::Reason => handle_confirm_reason_key(app, key, modifiers, selected),
    };

    if let Some(response) = update.response {
        app.confirm_dialog = None;
        app.pending_confirm_dialog = None;
        app.render_state.confirm_phase = ConfirmPhase::None;
        app.confirm_input.clear();
        // After confirm closes, force a bottom-aligned scrollback sync.
        app.scroll_from_bottom = 0;
        app.request_scrollback_sync();
        if let Err(error) = send_confirm_response(
            child_stdin,
            &confirm_id,
            response.ok,
            response.remember,
            response.reason.as_deref(),
        ) {
            app.push_error_report("confirm response error", error.to_string());
        }
        return Some(true);
    }

    if let Some(confirm) = app.confirm_dialog.as_mut() {
        let max_index = confirm_option_count(confirm.allow_remember).saturating_sub(1);
        confirm.selected = update.selected.min(max_index);
        confirm.mode = if confirm.allow_reason {
            update.mode
        } else {
            ConfirmMode::Select
        };
    }
    Some(update.consume)
}
