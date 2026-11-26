use crate::app::runtime::{send_confirm_response, RuntimeTx, UiConfirmRequest};
use crate::app::state::InputState;
use crate::app::{AppState, ConfirmDialogState, ConfirmMode, ConfirmSlot};
use crossterm::event::{KeyCode, KeyModifiers};

pub fn handle_confirm_request(app: &mut AppState, request: UiConfirmRequest) {
    app.scroll_from_bottom = 0;
    app.overlays.runtime_dialogs.confirm = Some(ConfirmSlot::Pending(ConfirmDialogState {
        id: request.id,
        title: request.title,
        message: request.message,
        danger_level: request.danger_level,
        confirm_label: request.confirm_label.unwrap_or_else(|| "Yes".to_string()),
        cancel_label: request.cancel_label.unwrap_or_else(|| "No".to_string()),
        allow_remember: request.allow_remember,
        allow_reason: request.allow_reason,
        command_view: false,
        selected: 0,
        mode: ConfirmMode::Select,
    }));
}

pub fn activate_pending_confirm_dialog(app: &mut AppState) -> bool {
    app.overlays.runtime_dialogs.activate_pending_confirm()
}

struct ConfirmResponse {
    ok: bool,
    remember: bool,
    reason: Option<String>,
}

struct ConfirmKeyUpdate {
    selected: usize,
    mode: ConfirmMode,
    command_view: Option<bool>,
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
    command_view: bool,
) -> ConfirmKeyUpdate {
    let mut update = ConfirmKeyUpdate {
        selected,
        mode: ConfirmMode::Select,
        command_view: None,
        consume: true,
        response: None,
    };

    let can_toggle_details = allow_remember || allow_reason;

    if command_view {
        match key {
            KeyCode::Char('d') | KeyCode::Char('D') | KeyCode::Esc => {
                update.command_view = Some(false);
            }
            _ => {}
        }
        return update;
    }

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
        KeyCode::Char('d') | KeyCode::Char('D') => {
            if can_toggle_details {
                update.command_view = Some(true);
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
    input: &mut InputState,
    key: KeyCode,
    modifiers: KeyModifiers,
    selected: usize,
) -> ConfirmKeyUpdate {
    let mut update = ConfirmKeyUpdate {
        selected,
        mode: ConfirmMode::Reason,
        command_view: None,
        consume: true,
        response: None,
    };

    match key {
        KeyCode::Esc | KeyCode::Tab => {
            update.mode = ConfirmMode::Select;
        }
        KeyCode::Enter => {
            let text = input.current();
            update.response = Some(ConfirmResponse {
                ok: false,
                remember: false,
                reason: (!text.trim().is_empty()).then_some(text),
            });
        }
        KeyCode::Backspace => {
            input.backspace();
        }
        KeyCode::Delete => {
            input.delete();
        }
        KeyCode::Left => {
            input.move_left();
        }
        KeyCode::Right => {
            input.move_right();
        }
        KeyCode::Home => {
            input.move_home();
        }
        KeyCode::End => {
            input.move_end();
        }
        KeyCode::Char(ch) => {
            if !modifiers.contains(KeyModifiers::CONTROL) && !modifiers.contains(KeyModifiers::ALT)
            {
                input.insert_char(ch);
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
    tx: &mut dyn RuntimeTx,
) -> Option<bool> {
    let (confirm, input) = app.overlays.runtime_dialogs.active_confirm_mut()?;
    let update = match confirm.mode {
        ConfirmMode::Select => handle_confirm_select_key(
            key,
            confirm.selected,
            confirm.allow_remember,
            confirm.allow_reason,
            confirm.command_view,
        ),
        ConfirmMode::Reason => handle_confirm_reason_key(input, key, modifiers, confirm.selected),
    };

    if let Some(response) = update.response {
        let confirm_id = confirm.id.clone();
        app.overlays.runtime_dialogs.confirm = None;
        // After confirm closes, force a bottom-aligned scrollback sync.
        app.scroll_from_bottom = 0;
        app.request_scrollback_sync();
        if let Err(error) = send_confirm_response(
            tx,
            &confirm_id,
            response.ok,
            response.remember,
            response.reason.as_deref(),
        ) {
            app.push_error_report("confirm response error", error.to_string());
        }
        return Some(true);
    }

    let max_index = confirm_option_count(confirm.allow_remember).saturating_sub(1);
    confirm.selected = update.selected.min(max_index);
    confirm.mode = if confirm.allow_reason {
        update.mode
    } else {
        ConfirmMode::Select
    };
    if let Some(command_view) = update.command_view {
        confirm.command_view = command_view;
    }
    Some(update.consume)
}

#[cfg(test)]
mod tests {
    use super::handle_confirm_select_key;
    use crate::app::ConfirmMode;
    use crossterm::event::KeyCode;

    #[test]
    fn d_enters_command_view_in_select_mode() {
        let update = handle_confirm_select_key(KeyCode::Char('d'), 0, true, true, false);

        assert_eq!(update.selected, 0);
        assert_eq!(update.mode, ConfirmMode::Select);
        assert_eq!(update.command_view, Some(true));
        assert!(update.consume);
        assert!(update.response.is_none());
    }

    #[test]
    fn d_does_not_toggle_non_permission_confirm() {
        let update = handle_confirm_select_key(KeyCode::Char('d'), 0, false, false, false);

        assert_eq!(update.command_view, None);
        assert!(!update.consume);
    }

    #[test]
    fn esc_leaves_command_view_without_denying() {
        let update = handle_confirm_select_key(KeyCode::Esc, 1, true, true, true);

        assert_eq!(update.selected, 1);
        assert_eq!(update.command_view, Some(false));
        assert!(update.consume);
        assert!(update.response.is_none());
    }
}
