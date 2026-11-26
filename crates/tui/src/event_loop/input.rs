use crate::app::handlers::confirm::handle_confirm_key;
use crate::app::handlers::{self, panels};
use crate::app::log_wrap::selected_text_for_range;
use crate::app::runtime::{
    send_client_tool_error, send_client_tool_success, send_pick_response, send_prompt_response,
    send_run_cancel, send_shell_detach, send_tool_call, RuntimeTx,
};
use crate::app::state::input::attachments::token_span_at;
use crate::app::state::{InputState, LogKind, SelectionHitTest};
use crate::app::util::{sanitize_paste, write_clipboard_text};
use crate::app::{
    AppState, ConfirmSlot, LocalPanel, PasteTarget, PendingRpc, PendingRpcSlot, PromptDialogState,
    PromptSlot, RuntimeDialogRef,
};
use crossterm::event::{KeyCode, KeyModifiers, MouseButton, MouseEvent, MouseEventKind};
use serde_json::{json, Value};
use std::time::{Duration, Instant};

const SHIFT_ENTER_BACKSLASH_WINDOW: Duration = Duration::from_millis(80);

pub(crate) fn handle_ctrl_c(app: &mut AppState, tx: &mut dyn RuntimeTx) -> bool {
    if app.rpc_pending.has_slot(PendingRpcSlot::RunCancel) {
        app.push_line(
            LogKind::Status,
            "Cancellation is still pending. Press Ctrl+C again quickly to force quit.",
        );
        return true;
    }

    if crate::app::goal::pause(app, tx, true) {
        return true;
    }

    if let Some(run_id) = app.runtime_info.active_run_id.clone() {
        let id = tx.next_id();
        app.rpc_pending.insert(id.clone(), PendingRpc::RunCancel);
        if let Err(error) = send_run_cancel(tx, &id, &run_id, Some("user interrupted")) {
            app.rpc_pending.remove_slot(PendingRpcSlot::RunCancel);
            app.push_error_report("send error", error.to_string());
        } else {
            app.push_line(
                LogKind::Status,
                "Cancel requested (Ctrl+C again quickly to force quit)",
            );
        }
        return true;
    }

    if app.rpc_pending.has_slot(PendingRpcSlot::RunStart) || app.is_running() {
        app.push_line(
            LogKind::Status,
            "Run is starting; Ctrl+C again quickly to force quit.",
        );
        return true;
    }

    false
}

pub(crate) fn maybe_request_skills_catalog(app: &mut AppState, tx: &mut dyn RuntimeTx) {
    if !app.runtime_info.supports_skills_list {
        return;
    }
    if app.skills_catalog_loaded || app.rpc_pending.has_slot(PendingRpcSlot::SkillsList) {
        return;
    }
    let id = tx.next_id();
    app.rpc_pending.insert(
        id.clone(),
        PendingRpc::SkillsList {
            query: None,
            scope: None,
        },
    );
    if let Err(error) = crate::app::runtime::send_skills_list(tx, &id, false) {
        app.rpc_pending.remove_slot(PendingRpcSlot::SkillsList);
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
    tx: &mut dyn RuntimeTx,
) -> bool {
    let now = Instant::now();
    let is_plain_backslash = matches!(key, KeyCode::Char('\\')) && modifiers.is_empty();
    let is_plain_enter = key == KeyCode::Enter && modifiers.is_empty();
    if !is_plain_backslash && !is_plain_enter {
        app.pending_shift_enter_backslash = None;
    }
    match (key, modifiers) {
        (KeyCode::Char('q'), KeyModifiers::ALT) => {
            handlers::open_queue_steer_picker(app);
            true
        }
        (KeyCode::Char('i'), KeyModifiers::ALT) => {
            crate::app::handlers::image_preview::preview_composer_image(app);
            true
        }
        (KeyCode::F(2), _) => {
            app.mouse_capture_enabled = !app.mouse_capture_enabled;
            if !app.mouse_capture_enabled {
                app.clear_text_selection();
            }
            true
        }
        (KeyCode::Char('h'), mods) if mods.contains(KeyModifiers::ALT) => {
            app.toggle_status_line_mode();
            true
        }
        (KeyCode::Char('m'), mods) if mods.contains(KeyModifiers::ALT) => {
            app.toggle_active_run_submit_mode();
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
            if app.rpc_pending.has_slot(PendingRpcSlot::ShellDetach) {
                app.push_line(LogKind::Status, "Shell detach is already pending.");
                return true;
            }
            let id = tx.next_id();
            app.rpc_pending.insert(id.clone(), PendingRpc::ShellDetach);
            if let Err(error) = send_shell_detach(tx, &id, &task_id) {
                app.rpc_pending.remove_slot(PendingRpcSlot::ShellDetach);
                app.push_error_report("send error", error.to_string());
            }
            true
        }
        (KeyCode::Char('l'), mods) if mods.contains(KeyModifiers::CONTROL) => {
            app.clear_log();
            true
        }
        (KeyCode::Esc, _) => {
            if app.clear_text_selection() {
                true
            } else if app.scroll_from_bottom > 0 {
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
            } else if crate::app::goal::pause(app, tx, true) {
                true
            } else if app.is_running() {
                if app.rpc_pending.has_slot(PendingRpcSlot::RunCancel) {
                    true
                } else if let Some(run_id) = app.runtime_info.active_run_id.clone() {
                    let id = tx.next_id();
                    app.rpc_pending.insert(id.clone(), PendingRpc::RunCancel);
                    if let Err(error) = send_run_cancel(tx, &id, &run_id, Some("user interrupted"))
                    {
                        app.rpc_pending.remove_slot(PendingRpcSlot::RunCancel);
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
            handle_typed_clipboard_paste(app)
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
            handlers::handle_enter(app, tx)
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
        _ => handle_composer_edit(app, key, modifiers),
    }
}

fn handle_composer_edit(app: &mut AppState, key: KeyCode, modifiers: KeyModifiers) -> bool {
    let cursor = app.input.cursor;
    let backspace = key == KeyCode::Backspace
        || key == KeyCode::Char('w') && modifiers.contains(KeyModifiers::CONTROL);
    let delete = key == KeyCode::Delete;
    if backspace || delete {
        if let Some(range) =
            token_span_at(&app.input, &app.composer_nonce, cursor, delete, backspace)
        {
            app.input.replace_range(range, "");
            return true;
        }
    }
    let edited =
        handle_input_edit_key(&mut app.input, key, modifiers, true, true).unwrap_or_default();
    if edited {
        if let Some(range) = token_span_at(
            &app.input,
            &app.composer_nonce,
            app.input.cursor,
            false,
            false,
        ) {
            app.input.cursor = if app.input.cursor < cursor {
                range.start
            } else {
                range.end
            };
        }
    }
    edited
}

pub(crate) fn handle_paste(app: &mut AppState, text: &str, startup_pending: bool) -> bool {
    let input = match app.paste_target(startup_pending) {
        PasteTarget::Blocked => return false,
        PasteTarget::RuntimePrompt => {
            let Some(prompt) = &mut app.overlays.runtime_dialogs.prompt else {
                return false;
            };
            &mut prompt.input
        }
        PasteTarget::Composer => &mut app.input,
    };
    let cleaned = sanitize_paste(text);
    if cleaned.is_empty() {
        return false;
    }
    input.insert_str(&cleaned);
    true
}

fn handle_typed_clipboard_paste(app: &mut AppState) -> bool {
    match app.paste_target(false) {
        PasteTarget::Blocked => return false,
        PasteTarget::Composer if !app.bang_input_mode => app.start_clipboard_import(),
        PasteTarget::RuntimePrompt | PasteTarget::Composer => {
            app.push_line(
                LogKind::Status,
                "File and image paste is available in the chat composer.",
            );
        }
    }
    true
}

fn handle_prompt_key(
    app: &mut AppState,
    key: KeyCode,
    modifiers: KeyModifiers,
    tx: &mut dyn RuntimeTx,
) -> Option<bool> {
    let prompt = app.overlays.runtime_dialogs.prompt.as_mut()?;
    let prompt_id = prompt.state.id.clone();
    let multiline = prompt.state.multiline;
    let secret = prompt.state.secret;

    let mut handled = true;
    match (key, modifiers) {
        (KeyCode::Char('v'), mods) if mods.contains(KeyModifiers::ALT) => {
            handled = handle_typed_clipboard_paste(app);
        }
        (KeyCode::Esc, _) => {
            app.overlays.runtime_dialogs.prompt = None;
            app.new_lane_task_id = None;
            if prompt_id != "lane:new-task" && prompt_id != "lane:new-seed" {
                if let Err(error) = send_prompt_response(tx, &prompt_id, None) {
                    app.push_error_report("prompt response error", error.to_string());
                }
            }
        }
        (KeyCode::Enter, mods) if mods.contains(KeyModifiers::SHIFT) && multiline => {
            prompt.input.insert_char('\n');
        }
        (KeyCode::Enter, _) => {
            let value = prompt.input.current();
            app.overlays.runtime_dialogs.prompt = None;

            if prompt_id == "lane:new-task" {
                let task_id = value.trim();
                if task_id.is_empty() {
                    app.push_line(LogKind::Error, "task_id is required");
                    app.new_lane_task_id = None;
                    app.overlays.runtime_dialogs.prompt = Some(PromptSlot {
                        state: PromptDialogState {
                            id: "lane:new-task".to_string(),
                            title: "New lane".to_string(),
                            message: "Task id".to_string(),
                            multiline: false,
                            secret: false,
                        },
                        input: Default::default(),
                    });
                    return Some(true);
                }
                app.new_lane_task_id = Some(task_id.to_string());
                app.overlays.runtime_dialogs.prompt = Some(PromptSlot {
                    state: PromptDialogState {
                        id: "lane:new-seed".to_string(),
                        title: "New lane".to_string(),
                        message: "Seed context (optional)".to_string(),
                        multiline: true,
                        secret: false,
                    },
                    input: Default::default(),
                });
                return Some(true);
            }

            if prompt_id == "lane:new-seed" {
                if let Some(task_id) = app.new_lane_task_id.take() {
                    let mut args = serde_json::Map::new();
                    args.insert("task_id".to_string(), Value::String(task_id));
                    let seed = value.trim();
                    if !seed.is_empty() {
                        args.insert("seed_context".to_string(), Value::String(seed.to_owned()));
                    }
                    let id = tx.next_id();
                    app.rpc_pending.insert(id.clone(), PendingRpc::LaneCreate);
                    if let Err(error) = send_tool_call(tx, &id, "lane_create", Value::Object(args))
                    {
                        app.rpc_pending.remove_slot(PendingRpcSlot::LaneCreate);
                        app.push_error_report("send error", error.to_string());
                    }
                }
                return Some(true);
            }

            if let Err(error) = send_prompt_response(tx, &prompt_id, Some(value.as_str())) {
                app.push_error_report("prompt response error", error.to_string());
            }
        }
        _ => {
            handled = handle_input_edit_key(&mut prompt.input, key, modifiers, !secret, multiline)
                .unwrap_or_default();
        }
    }

    Some(handled)
}

fn handle_pick_key(app: &mut AppState, key: KeyCode, tx: &mut dyn RuntimeTx) -> Option<bool> {
    let pick = app.overlays.runtime_dialogs.pick.as_mut()?;
    if let Some(offset) = pick.review_offset.as_mut() {
        match key {
            KeyCode::Esc | KeyCode::Char('d' | 'D') => pick.review_offset = None,
            KeyCode::Up => *offset = offset.saturating_sub(1),
            KeyCode::Down => *offset = offset.saturating_add(1),
            KeyCode::PageUp => *offset = offset.saturating_sub(8),
            KeyCode::PageDown => *offset = offset.saturating_add(8),
            KeyCode::Home => *offset = 0,
            _ => return Some(false),
        }
        return Some(true);
    }
    if (pick.approval || pick.shell_rule_picker.is_some())
        && matches!(key, KeyCode::Char('d' | 'D'))
    {
        pick.review_offset = Some(0);
        return Some(true);
    }
    if pick.local_update_picker && matches!(key, KeyCode::Enter | KeyCode::Esc) {
        if key == KeyCode::Enter
            && !app
                .render_state
                .drawn_update_choice
                .as_ref()
                .is_some_and(|(id, selected)| *id == pick.id && *selected == pick.selected)
        {
            app.push_line(
                LogKind::Status,
                "Resize the terminal to see the selected update mode, or press Esc to cancel.",
            );
            return Some(true);
        }
        app.render_state.drawn_update_choice = None;
        if let Some(picker) = app.overlays.runtime_dialogs.pick.take() {
            crate::app::self_update::finish_picker(app, picker, key == KeyCode::Enter);
        }
        return Some(true);
    }
    if pick.shell_rule_picker.is_some() && matches!(key, KeyCode::Enter | KeyCode::Esc) {
        if let Some(picker) = app.overlays.runtime_dialogs.pick.take() {
            if key == KeyCode::Enter {
                handlers::shell_rules::select(app, tx, picker);
            }
        }
        return Some(true);
    }
    if pick.local_update_picker {
        app.render_state.drawn_update_choice = None;
    }
    let mut handled = true;
    match key {
        KeyCode::Esc => {
            let id = pick.id.clone();
            app.overlays.runtime_dialogs.pick = None;
            if app.rpc_pending.client_tool_choice_ids.remove(&id) {
                if let Err(error) = send_client_tool_error(tx, &id, "choice cancelled") {
                    app.push_error_report("client tool response error", error.to_string());
                }
                return Some(true);
            }
            let ids: Vec<String> = Vec::new();
            if let Err(error) = send_pick_response(tx, &id, &ids) {
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
            app.overlays.runtime_dialogs.pick = None;

            if app.rpc_pending.client_tool_choice_ids.remove(&id) {
                let selected_id = ids.first().cloned();
                let result = json!({ "selected_id": selected_id });
                if let Err(error) = send_client_tool_success(tx, &id, result) {
                    app.push_error_report("client tool response error", error.to_string());
                }
                return Some(true);
            }

            if let Some(lane_id) = id.strip_prefix("lane:action:") {
                if let Some(action) = ids.first() {
                    let request_id = tx.next_id();
                    match action.as_str() {
                        "status" => {
                            app.rpc_pending
                                .insert(request_id.clone(), PendingRpc::LaneStatus);
                            if let Err(error) = send_tool_call(
                                tx,
                                &request_id,
                                "lane_status",
                                json!({ "lane_id": lane_id }),
                            ) {
                                app.rpc_pending.remove_slot(PendingRpcSlot::LaneStatus);
                                app.push_error_report("send error", error.to_string());
                            }
                        }
                        "close" => {
                            app.rpc_pending
                                .insert(request_id.clone(), PendingRpc::LaneClose);
                            if let Err(error) = send_tool_call(
                                tx,
                                &request_id,
                                "lane_close",
                                json!({ "lane_id": lane_id }),
                            ) {
                                app.rpc_pending.remove_slot(PendingRpcSlot::LaneClose);
                                app.push_error_report("send error", error.to_string());
                            }
                        }
                        _ => {}
                    }
                }
                return Some(true);
            }

            if let Err(error) = send_pick_response(tx, &id, &ids) {
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

fn selection_point_at(
    app: &AppState,
    hit_map: crate::app::TranscriptHitMap,
    mouse: &MouseEvent,
    hit_test: SelectionHitTest,
) -> Option<crate::app::state::selection::SelectionPoint> {
    let cache = app.wrapped_log_cache.as_ref()?;
    if cache.log_version != hit_map.projection.log_version
        || cache.width != hit_map.projection.wrap_width
    {
        return None;
    }
    hit_map.point_at(&cache.wrapped, mouse.column, mouse.row, hit_test)
}

pub(crate) fn handle_mouse_event(
    app: &mut AppState,
    mouse: MouseEvent,
    owned_selection_enabled: bool,
    frame_dirty: bool,
) -> bool {
    if app.image_preview.is_open() {
        return false;
    }
    match mouse.kind {
        MouseEventKind::ScrollUp => {
            app.scroll_up(3);
            true
        }
        MouseEventKind::ScrollDown => {
            app.scroll_down(3);
            true
        }
        MouseEventKind::Down(MouseButton::Left) => {
            if !owned_selection_enabled
                || !app.mouse_capture_enabled
                || app.selection_input_blocked()
                || frame_dirty
                || !mouse.modifiers.is_empty()
            {
                return false;
            }
            let Some(hit_map) = app.transcript_hit_map else {
                return false;
            };
            let Some(point) = selection_point_at(app, hit_map, &mouse, SelectionHitTest::Start)
            else {
                return app.clear_text_selection();
            };
            app.selection_notice = None;
            app.selection_notice_expires_at = None;
            app.text_selection.start(point, hit_map.projection);
            true
        }
        MouseEventKind::Drag(MouseButton::Left) => {
            if !app.text_selection.is_dragging() {
                return false;
            }
            if !owned_selection_enabled
                || !app.mouse_capture_enabled
                || app.selection_input_blocked()
                || !mouse.modifiers.is_empty()
            {
                return app.clear_text_selection();
            }
            if frame_dirty {
                return false;
            }
            let Some(hit_map) = app.transcript_hit_map else {
                return app.clear_text_selection();
            };
            let Some(anchor) = app.text_selection.drag_anchor() else {
                return app.clear_text_selection();
            };
            let Some(point) =
                selection_point_at(app, hit_map, &mouse, SelectionHitTest::ExtendFrom(anchor))
            else {
                return app.clear_text_selection();
            };
            app.text_selection.update_drag(point, hit_map.projection)
        }
        MouseEventKind::Up(MouseButton::Left) => {
            if !app.text_selection.is_dragging() {
                return false;
            }
            if !owned_selection_enabled
                || !app.mouse_capture_enabled
                || app.selection_input_blocked()
                || !mouse.modifiers.is_empty()
            {
                return app.clear_text_selection();
            }
            if frame_dirty {
                return app.clear_text_selection();
            }
            let Some(hit_map) = app.transcript_hit_map else {
                return app.clear_text_selection();
            };
            let Some(anchor) = app.text_selection.drag_anchor() else {
                return app.clear_text_selection();
            };
            let Some(point) =
                selection_point_at(app, hit_map, &mouse, SelectionHitTest::ExtendFrom(anchor))
            else {
                return app.clear_text_selection();
            };
            let Some(range) = app.text_selection.finish_drag(point, hit_map.projection) else {
                return true;
            };
            let Some(text) = selected_text_for_range(app, range, hit_map.projection) else {
                app.text_selection.clear();
                app.set_selection_notice("Copy failed: empty selection");
                return true;
            };
            app.set_selection_notice(match write_clipboard_text(&text) {
                Ok(_) => format!("Copied {} chars", text.chars().count()),
                Err(error) => format!("Copy failed: {error}"),
            });
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
    tx: &mut dyn RuntimeTx,
) -> Option<bool> {
    match app.overlays.runtime_dialogs.top() {
        Some(RuntimeDialogRef::Confirm(ConfirmSlot::Pending(_))) => return Some(false),
        Some(RuntimeDialogRef::Confirm(ConfirmSlot::Active { .. })) => {
            return handle_confirm_key(app, key, modifiers, tx);
        }
        Some(RuntimeDialogRef::Prompt(_)) => return handle_prompt_key(app, key, modifiers, tx),
        Some(RuntimeDialogRef::Pick(_)) => return handle_pick_key(app, key, tx),
        None => {}
    }

    if app.overlays.local_panel.is_some()
        && key == KeyCode::Char('v')
        && modifiers.contains(KeyModifiers::ALT)
    {
        return Some(false);
    }

    match &app.overlays.local_panel {
        Some(LocalPanel::SessionList(_)) => panels::handle_session_list_panel_key(app, key, tx),
        Some(LocalPanel::LaneList(_)) => panels::handle_lane_list_panel_key(app, key, tx),
        Some(LocalPanel::Context(_)) => panels::handle_context_panel_key(app, key),
        Some(LocalPanel::SkillsList(_)) => panels::handle_skills_list_panel_key(app, key),
        Some(LocalPanel::ThemeList(_)) => panels::handle_theme_list_panel_key(app, key, tx),
        Some(LocalPanel::ModelList(_)) => panels::handle_model_list_panel_key(app, key, tx),
        Some(LocalPanel::ProviderPicker(_)) => panels::handle_provider_picker_key(app, key, tx),
        Some(LocalPanel::ModelPicker(_)) => panels::handle_model_picker_key(app, key, tx),
        Some(LocalPanel::ReasoningPicker(_)) => panels::handle_reasoning_picker_key(app, key, tx),
        None => {
            if app.queue_picker_focused() && !modifiers.is_empty() {
                return Some(false);
            }
            handlers::handle_queue_steer_picker_key(app, key, tx)
        }
    }
}

#[cfg(test)]
mod clipboard_input_tests {
    use super::*;
    use crate::app::state::input::attachments::make_attachment_token;

    #[test]
    fn attachment_tokens_are_atomic_cursor_and_delete_targets() {
        let mut app = AppState::default();
        let marker = make_attachment_token(&app.composer_nonce, "paste-1");
        app.input.set_from(&format!("before{marker}after"));
        app.input.cursor = "before".len() + marker.len();

        assert!(handle_composer_edit(
            &mut app,
            KeyCode::Left,
            KeyModifiers::NONE
        ));
        assert_eq!(app.input.cursor, "before".len());
        assert!(handle_composer_edit(
            &mut app,
            KeyCode::Right,
            KeyModifiers::NONE
        ));
        assert_eq!(app.input.cursor, "before".len() + marker.len());
        assert!(handle_composer_edit(
            &mut app,
            KeyCode::Backspace,
            KeyModifiers::NONE
        ));
        assert_eq!(app.input.current(), "beforeafter");
    }

    #[test]
    fn terminal_path_and_file_uri_paste_remain_plain_text() {
        let mut app = AppState::default();
        let pasted = "file:///tmp/secret.txt\n/tmp/literal path";
        assert!(handle_paste(&mut app, pasted, false));
        assert_eq!(app.input.current(), pasted);
        assert!(!app.has_pending_clipboard_import());
        assert_eq!(app.referenced_attachment_count(), 0);
    }
}

#[cfg(test)]
mod shell_rule_tests {
    use super::*;
    use crate::app::handlers::runtime_response::process_runtime_messages;
    use crate::app::runtime::MockRuntimeTx;
    use std::sync::mpsc;

    #[test]
    fn saved_shell_rules_list_exact_values_and_remove_only_the_confirmed_scope() {
        let mut tx = MockRuntimeTx::with_id_prefix("permissions-");
        let mut app = AppState::default();
        app.runtime_info.session_id = Some("session-1".into());
        let (sender, rx) = mpsc::channel();
        let exact_id = "a".repeat(64);
        let legacy_id = "b".repeat(64);
        let source_id = "c".repeat(64);
        let prefix_id = "d".repeat(64);
        let list = json!({"approval_mode":null,"paths":{"global":"/config.json","project":null},"rules":[],"remembered_tools":[{"tool":"search"}],"launch_rules": [
            {"id":exact_id,"template":"exact-argv/v2","origin":"parent_agent",
             "executable":"/bin/example","argv0":"/bin/example","launchKind":"argv",
             "args":["", "file name", "x\u{202e}y"],
             "cwd":"/one/two words","profile":"development","scope":"project"},
            {"id":legacy_id,"template":"bun-typecheck/v1","origin":"operator",
             "executable":"/bin/bun","profile":"development","scope":"session"},
            {"id":source_id,"template":"exact-argv/v2","origin":"operator",
             "executable":"/bin/example","argv0":"example","launchKind":"source",
             "args":["file name"],"source":"example 'file name'",
             "cwd":"/one","profile":"investigation","scope":"session"},
            {"id":prefix_id,"template":"argv-prefix/v1","origin":"parent_agent",
             "executable":"/bin/example","argv0":"example","launchKind":"source",
             "args":["test"],"cwd":"/one","profile":"development","scope":"project"}
        ]});
        let submit = |app: &mut AppState, tx: &mut dyn RuntimeTx, input: &str| {
            app.input.set_from(input);
            assert!(handlers::handle_enter(app, tx));
        };
        let respond = |app: &mut AppState, tx: &mut dyn RuntimeTx, id: &str, result: &Value| {
            sender
                .send(json!({"jsonrpc":"2.0","id":id,"result":result}).to_string())
                .expect("fixture response");
            assert!(process_runtime_messages(app, &rx, tx));
        };

        submit(&mut app, &mut tx, "/permissions");
        assert!(!app.rpc_pending.has_slot(PendingRpcSlot::ShellRules));
        app.runtime_info.supports_permissions_rw = true;
        submit(&mut app, &mut tx, "/permissions list");
        respond(&mut app, &mut tx, "permissions-1", &list);
        let log = |app: &AppState| {
            app.log
                .iter()
                .map(|line| line.plain_text())
                .collect::<Vec<_>>()
                .join("\n")
        };
        let listing = log(&app);
        assert!(listing.contains(r#"project · development · agent · argv ["/bin/example","","file name","x\u202ey"] · cwd "/one/two words""#));
        assert!(listing.contains(r#"session · investigation · operator · argv ["example","file name"] · cwd "/one" · resolved executable "/bin/example" · Bash source "example 'file name'""#));
        assert!(listing.contains("session · Legacy Bun rule"));
        assert!(listing
            .contains(r#""search" · Personal remembered tool permission for this workspace"#));
        assert!(listing
            .contains(r#"argv ["example","test"] + any trailing arguments · cwd "/one" · Bash"#));
        assert!(listing.contains("only to the selected session until this runtime exits"));
        assert!(listing.contains("Project rules persist for this workspace"));
        assert!(listing.contains("after project code changes"));

        for (id, keys) in [
            ("permissions-2", vec![KeyCode::Esc]),
            ("permissions-3", vec![KeyCode::Enter, KeyCode::Enter]),
            (
                "permissions-4",
                vec![
                    KeyCode::Down,
                    KeyCode::Char('d'),
                    KeyCode::Esc,
                    KeyCode::Enter,
                    KeyCode::Down,
                    KeyCode::Enter,
                ],
            ),
        ] {
            submit(&mut app, &mut tx, "/permissions remove");
            respond(&mut app, &mut tx, id, &list);
            for key in keys {
                assert_eq!(handle_pick_key(&mut app, key, &mut tx), Some(true));
            }
            assert!(app.overlays.runtime_dialogs.pick.is_none());
        }
        respond(
            &mut app,
            &mut tx,
            "permissions-5",
            &json!({"launch_rule_id":legacy_id,"scope":"session","removed":1}),
        );
        assert!(log(&app).contains("Removed the session shell rule."));

        submit(&mut app, &mut tx, "/permissions remove");
        respond(&mut app, &mut tx, "permissions-6", &list);
        assert_eq!(
            handle_pick_key(&mut app, KeyCode::Enter, &mut tx),
            Some(true)
        );
        app.runtime_info.session_id = Some("session-2".into());
        assert_eq!(
            handle_pick_key(&mut app, KeyCode::Down, &mut tx),
            Some(true)
        );
        assert_eq!(
            handle_pick_key(&mut app, KeyCode::Enter, &mut tx),
            Some(true)
        );
        assert!(log(&app).contains("The session changed."));

        // Remembered tools are independent of the launch-rule store.
        let tool_list = json!({"approval_mode":null,"paths":{"global":"/config.json","project":null},"rules":[],"remembered_tools":[{"tool":"webfetch"}]});
        for (request_id, confirm) in [("permissions-7", false), ("permissions-8", true)] {
            submit(&mut app, &mut tx, "/permissions remove");
            respond(&mut app, &mut tx, request_id, &tool_list);
            assert_eq!(
                app.overlays
                    .runtime_dialogs
                    .pick
                    .as_ref()
                    .unwrap()
                    .items
                    .len(),
                1
            );
            assert_eq!(
                handle_pick_key(&mut app, KeyCode::Enter, &mut tx),
                Some(true)
            );
            let dialog = app.overlays.runtime_dialogs.pick.as_ref().unwrap();
            assert!(dialog.message.as_deref().unwrap().contains("webfetch"));
            assert_eq!(dialog.selected, 0);
            if confirm {
                assert_eq!(
                    handle_pick_key(&mut app, KeyCode::Down, &mut tx),
                    Some(true)
                );
            }
            assert_eq!(
                handle_pick_key(&mut app, KeyCode::Enter, &mut tx),
                Some(true)
            );
            assert_eq!(
                app.rpc_pending.has_slot(PendingRpcSlot::ShellRules),
                confirm
            );
        }
        respond(
            &mut app,
            &mut tx,
            "permissions-9",
            &json!({"remembered_tool":"webfetch","scope":"project","removed":1}),
        );
        assert!(log(&app).contains(r#"Personal workspace permission cleared for "webfetch"."#));
        let requests = &tx.sent;
        assert_eq!(requests.len(), 9);
        assert_eq!(requests[8]["method"], "permissions.remove");
        assert_eq!(
            requests[8]["params"],
            json!({"remembered_tool":"webfetch","scope":"project"})
        );
        for request in [
            &requests[0],
            &requests[1],
            &requests[2],
            &requests[3],
            &requests[5],
        ] {
            assert_eq!(request["method"], "permissions.list");
            assert_eq!(request["params"], json!({}));
        }
        assert_eq!(requests[4]["method"], "permissions.remove");
        assert_eq!(
            requests[4]["params"],
            json!({"launch_rule_id":legacy_id,"scope":"session"})
        );
    }

    #[test]
    fn project_allow_confirmation_sends_only_the_reviewed_workspace_and_revision() {
        let mut tx = MockRuntimeTx::default();
        let mut app = AppState::default();
        app.runtime_info.supports_permissions_rw = true;
        app.runtime_info.supports_project_allow_trust = true;
        let (sender, rx) = mpsc::channel();
        for confirm in [false, true] {
            app.input.set_from("/permissions trust");
            assert!(handlers::handle_enter(&mut app, &mut tx));
            let id = app
                .rpc_pending
                .slot_id(PendingRpcSlot::ShellRules)
                .unwrap()
                .to_owned();
            sender.send(json!({"id":id,"jsonrpc":"2.0","result":{"approval_mode":null,"paths":{"global":"/config.json","project":null},"rules":[],"project_allow_trust":{"trusted":false,"workspace":"/workspace","revision":"snapshot-1","rules":[{"tool":"shell","command":"cargo test"}]}}}).to_string()).unwrap();
            assert!(process_runtime_messages(&mut app, &rx, &mut tx));
            let dialog = app.overlays.runtime_dialogs.pick.as_ref().unwrap();
            let message = dialog.message.as_ref().unwrap();
            assert!(message.contains("future edits"));
            assert!(message.contains("cargo test"));
            assert_eq!(dialog.selected, 0);
            if confirm {
                assert_eq!(
                    handle_pick_key(&mut app, KeyCode::Down, &mut tx),
                    Some(true)
                );
            }
            assert_eq!(
                handle_pick_key(&mut app, KeyCode::Enter, &mut tx),
                Some(true)
            );
            assert_eq!(
                app.rpc_pending.has_slot(PendingRpcSlot::ShellRules),
                confirm
            );
        }
        let requests = &tx.sent;
        assert_eq!(requests.len(), 3);
        assert_eq!(requests[2]["method"], "permissions.projectTrust.set");
        assert_eq!(
            requests[2]["params"],
            json!({"workspace":"/workspace","trusted":true,"expected_revision":"snapshot-1"})
        );
    }

    #[test]
    fn permissions_run_sends_raw_operator_shell_source_only_to_a_compatible_idle_runtime() {
        let mut tx = MockRuntimeTx::default();
        let mut app = AppState::default();
        let (sender, rx) = mpsc::channel();
        let source = "  example 'file name' \"\"\n  ";
        let input = format!("/permissions run {source}");
        let mut capabilities = json!({"supports_permissions_rw":true,"supports_tool_call":true,"supports_shell_exec":true,"supports_ui_requests":true});

        for structured in [false, true] {
            capabilities["supports_structured_approval"] = json!(structured);
            app.rpc_pending
                .insert("initialize".to_owned(), PendingRpc::Initialize);
            sender
                .send(
                    json!({"jsonrpc":"2.0","id":"initialize","result":{
                        "protocol_version":"0", "server":{"name":"runtime","version":"test"},
                        "server_capabilities":capabilities
                    }})
                    .to_string(),
                )
                .expect("fixture initialization");
            process_runtime_messages(&mut app, &rx, &mut tx);
            if structured {
                app.run_status = Some("running".to_owned());
            }
            app.input.set_from(&input);
            assert!(handlers::handle_enter(&mut app, &mut tx));
            assert!(!app.rpc_pending.has_shell_rule_run());
            assert_eq!(app.input.current(), input);
        }

        app.run_status = None;
        assert!(handlers::handle_enter(&mut app, &mut tx));
        assert!(app.rpc_pending.has_shell_rule_run());
        assert!(!handlers::can_dispatch_prompt_now(&app));
        assert!(app.input.current().is_empty());

        sender.send(
            json!({"jsonrpc":"2.0","id":"approval-pick","method":"ui.pick.request","params":{
                "title":"Approve shell?","message":source,"approval":true,"items":[
                    {"id":"approval-request/allow_once","label":"Allow once"},
                    {"id":"approval-request/save_project","label":"Allow and save for this project"}
                ]
            }})
            .to_string(),
        )
        .expect("fixture approval pick");
        assert!(process_runtime_messages(&mut app, &rx, &mut tx));
        assert!(app
            .overlays
            .runtime_dialogs
            .pick
            .as_ref()
            .is_some_and(|pick| pick.approval));
        for key in [KeyCode::Down, KeyCode::Enter] {
            assert_eq!(handle_pick_key(&mut app, key, &mut tx), Some(true));
        }
        assert!(app.rpc_pending.has_shell_rule_run());

        sender.send(json!({"jsonrpc":"2.0","id":"1","result":{"ok":true,"result":{
            "state":"completed","exit_code":0,"stdout":"fixture output","stderr":"fixture diagnostics"
        }}}).to_string()).expect("fixture shell result");
        assert!(process_runtime_messages(&mut app, &rx, &mut tx));
        assert!(!app.rpc_pending.has_shell_rule_run());
        assert!(app.pending_shell_results.is_empty());
        let log = app
            .log
            .iter()
            .map(|line| line.plain_text())
            .collect::<Vec<_>>()
            .join("\n");
        assert!(log.contains("The command runs once if allowed."));
        assert!(log.contains("Command completed (exit 0)"));
        assert!(log.contains("fixture output"));
        assert!(log.contains("fixture diagnostics"));

        let requests = &tx.sent;
        assert_eq!(requests.len(), 2);
        assert_eq!(requests[0]["method"], "tool.call");
        assert_eq!(
            requests[0]["params"],
            json!({"name":"shell","arguments":{"command":source}})
        );
        assert_eq!(
            requests[1],
            json!({"jsonrpc":"2.0","id":"approval-pick","result":{"ids":["approval-request/save_project"]}})
        );
    }
}

#[cfg(test)]
#[cfg(unix)]
mod update_tests {
    use super::*;
    use crate::app::runtime::MockRuntimeTx;
    use crate::app::self_update::{self, LauncherPaths};
    use ratatui::{backend::TestBackend, Terminal};
    use std::io::Write;

    #[test]
    fn update_command_and_picker_never_reply_to_runtime() {
        let mut tx = MockRuntimeTx::default();
        let fixture = std::env::temp_dir().join(format!("codelia-update-{}", std::process::id()));
        let mut script = std::fs::OpenOptions::new()
            .write(true)
            .create_new(true)
            .open(&fixture)
            .expect("create update helper fixture");
        struct RemoveFixture(std::path::PathBuf);
        impl Drop for RemoveFixture {
            fn drop(&mut self) {
                let _ = std::fs::remove_file(&self.0);
            }
        }
        let _fixture = RemoveFixture(fixture.clone());
        script
            .write_all(
                br#"case "$*" in
  'update --tui-status') mode=notify ;;
  'update --tui-set-mode auto') mode=auto ;;
  *) exit 1 ;;
esac
printf '{"current_version":"1.2.3","channel":"latest","candidate":"1.2.4","saved_mode":"%s","effective_mode":"%s","mode_source":"config","auto_apply_supported":true}\n' "$mode" "$mode"
"#,
            )
            .unwrap();
        drop(script);
        let mut app = AppState {
            update_control_launcher: Some(LauncherPaths {
                node: "/bin/sh".into(),
                entry: fixture,
            }),
            ..AppState::default()
        };
        let poll = |app: &mut AppState| {
            let deadline = Instant::now() + Duration::from_secs(5);
            while !self_update::poll(app) {
                assert!(Instant::now() < deadline, "update helper did not complete");
                std::thread::sleep(Duration::from_millis(5));
            }
        };

        fn pick_auto_in_short_terminal(app: &mut AppState, tx: &mut dyn RuntimeTx, enlarge: bool) {
            let mut terminal = Terminal::new(TestBackend::new(80, 7)).unwrap();
            let mut key = |app: &mut AppState, code| {
                assert_eq!(
                    handle_non_main_key(app, code, KeyModifiers::NONE, tx),
                    Some(true)
                );
            };
            terminal
                .draw(|f| crate::app::view::draw_ui(f, app))
                .unwrap();
            key(app, KeyCode::Down);
            terminal
                .draw(|f| crate::app::view::draw_ui(f, app))
                .unwrap();
            assert!(app.render_state.drawn_update_choice.is_none());
            key(app, KeyCode::Enter);
            let pick = app
                .overlays
                .runtime_dialogs
                .pick
                .as_ref()
                .expect("hidden choice must not close the picker");
            assert_eq!(pick.items[pick.selected].id, "auto");
            assert!(app.pending_update_control.is_none());
            if enlarge {
                terminal.backend_mut().resize(80, 24);
                terminal
                    .draw(|f| crate::app::view::draw_ui(f, app))
                    .unwrap();
                assert!(app.render_state.drawn_update_choice.is_some());
                // Even with enough room, a new selection must be drawn before Enter.
                key(app, KeyCode::Up);
                key(app, KeyCode::Enter);
                assert!(app.overlays.runtime_dialogs.pick.is_some());
                assert!(app.pending_update_control.is_none());
                key(app, KeyCode::Down);
                terminal
                    .draw(|f| crate::app::view::draw_ui(f, app))
                    .unwrap();
                assert!(app.render_state.drawn_update_choice.is_some());
            }
        }

        for key in [KeyCode::Esc, KeyCode::Enter] {
            app.input.set_from("/update");
            assert!(handlers::handle_enter(&mut app, &mut tx));
            assert!(app.input.current().is_empty());
            poll(&mut app);
            let picker = app
                .overlays
                .runtime_dialogs
                .pick
                .as_ref()
                .expect("local update picker");
            assert!(picker.local_update_picker);
            assert_eq!(picker.items[picker.selected].id, "notify");
            assert_eq!(
                picker.message.as_deref(),
                Some("Current: 1.2.3. Update candidate (latest): 1.2.4.")
            );
            pick_auto_in_short_terminal(&mut app, &mut tx, key == KeyCode::Enter);
            assert_eq!(handle_pick_key(&mut app, key, &mut tx), Some(true));
            assert!(app.overlays.runtime_dialogs.pick.is_none());
            assert_eq!(app.pending_update_control.is_some(), key == KeyCode::Enter);
        }
        poll(&mut app);
        assert!(app
            .log
            .iter()
            .flat_map(|line| &line.spans)
            .any(|span| span.text.contains("Update mode saved: auto.")));
        use crate::app::startup_confirmations::{self, StartupConfirmations};
        assert!(!StartupConfirmations::from_list(&["unknown".to_string()]).is_pending());
        for key in [KeyCode::Esc, KeyCode::Enter] {
            app.startup_confirmations = StartupConfirmations::from_list(&[
                "unknown".to_string(),
                "update-mode".to_string(),
                "update-mode".to_string(),
            ]);
            app.rpc_pending
                .insert("initialize".into(), PendingRpc::Initialize);
            assert!(!startup_confirmations::poll(&mut app));
            app.rpc_pending.remove_slot(PendingRpcSlot::Initialize);
            app.rpc_pending
                .insert("session-open".into(), PendingRpc::SessionOpen);
            assert!(!startup_confirmations::poll(&mut app));
            app.rpc_pending.remove_slot(PendingRpcSlot::SessionOpen);
            assert!(app.overlays.runtime_dialogs.pick.is_none());
            assert!(startup_confirmations::poll(&mut app));
            app.overlays.runtime_dialogs.prompt = Some(PromptSlot {
                state: PromptDialogState {
                    id: "auth".into(),
                    title: "Authentication".into(),
                    message: String::new(),
                    multiline: false,
                    secret: true,
                },
                input: Default::default(),
            });
            assert!(startup_confirmations::poll(&mut app));
            assert!(app.overlays.runtime_dialogs.pick.is_none());
            assert!(!startup_confirmations::poll(&mut app));
            assert!(app.startup_confirmations.is_pending());
            app.overlays.runtime_dialogs.prompt = None;
            assert!(startup_confirmations::poll(&mut app));
            let picker = app.overlays.runtime_dialogs.pick.as_ref().unwrap();
            assert!(self_update::is_startup_picker(picker));
            assert_eq!(picker.items[picker.selected].id, "notify");
            pick_auto_in_short_terminal(&mut app, &mut tx, key == KeyCode::Enter);
            assert_eq!(
                handle_non_main_key(&mut app, key, KeyModifiers::NONE, &mut tx),
                Some(true)
            );
            assert!(app.overlays.runtime_dialogs.pick.is_none());
            if key == KeyCode::Enter {
                assert!(!startup_confirmations::poll(&mut app));
                assert!(
                    app.startup_confirmations.is_pending(),
                    "must wait for persistence"
                );
                poll(&mut app);
            } else {
                assert!(app.pending_update_control.is_none());
            }
            assert!(!startup_confirmations::poll(&mut app));
            assert!(!app.startup_confirmations.is_pending());
        }
        assert!(tx.sent.is_empty());
    }
}

#[cfg(test)]
mod mouse_tests {
    use super::handle_mouse_event;
    use crate::app::state::{
        LogKind, LogLine, SelectableFragment, SelectionProjectionId, TranscriptHitMap,
        WrappedLogCache, WrappedLogRow,
    };
    use crate::app::AppState;
    use crossterm::event::{KeyModifiers, MouseButton, MouseEvent, MouseEventKind};
    use ratatui::layout::Rect;

    fn mouse(kind: MouseEventKind, column: u16, row: u16) -> MouseEvent {
        mouse_with_modifiers(kind, column, row, KeyModifiers::NONE)
    }

    fn mouse_with_modifiers(
        kind: MouseEventKind,
        column: u16,
        row: u16,
        modifiers: KeyModifiers,
    ) -> MouseEvent {
        MouseEvent {
            kind,
            column,
            row,
            modifiers,
        }
    }

    fn selectable_row() -> WrappedLogRow {
        WrappedLogRow {
            line: LogLine::new(LogKind::Assistant, "selectable row"),
            selectable_fragments: vec![SelectableFragment {
                cell_start: 0,
                cell_end: 20,
                text: "selectable row".to_string(),
            }],
            soft_wrap_after: false,
            source_end: Default::default(),
        }
    }

    fn selectable_app() -> AppState {
        AppState {
            log_version: 3,
            mouse_capture_enabled: true,
            transcript_hit_map: Some(TranscriptHitMap {
                frame_revision: 1,
                projection: SelectionProjectionId {
                    log_version: 3,
                    wrap_width: 20,
                },
                log_area: Rect::new(0, 2, 20, 3),
                visible_start: 5,
                visible_end: 8,
            }),
            wrapped_log_cache: Some(WrappedLogCache {
                width: 20,
                log_version: 3,
                committed: Default::default(),
                wrapped: (0..8).map(|_| selectable_row()).collect(),
            }),
            ..AppState::default()
        }
    }

    #[test]
    fn alternate_mode_primary_drag_uses_latest_hit_map_revision() {
        let mut app = selectable_app();
        assert!(handle_mouse_event(
            &mut app,
            mouse(MouseEventKind::Down(MouseButton::Left), 1, 2),
            true,
            false,
        ));
        app.transcript_hit_map.as_mut().unwrap().frame_revision = 2;
        assert!(handle_mouse_event(
            &mut app,
            mouse(MouseEventKind::Drag(MouseButton::Left), 6, 3),
            true,
            false,
        ));
        let range = app.text_selection.normalized_range().unwrap();
        assert_eq!(range.start.wrapped_row, 5);
        assert_eq!(range.end.wrapped_row, 6);
        assert!(app.text_selection.is_dragging());
    }

    #[test]
    fn dirty_frame_or_inline_mode_does_not_start_selection() {
        let mut app = selectable_app();
        let down = mouse(MouseEventKind::Down(MouseButton::Left), 1, 2);
        assert!(!handle_mouse_event(&mut app, down, true, true));
        assert!(!app.text_selection.is_dragging());
        assert!(!handle_mouse_event(&mut app, down, false, false));
        assert!(!app.text_selection.is_dragging());
    }

    #[test]
    fn shifted_primary_down_does_not_start_owned_selection() {
        let mut app = selectable_app();

        assert!(!handle_mouse_event(
            &mut app,
            mouse_with_modifiers(
                MouseEventKind::Down(MouseButton::Left),
                1,
                2,
                KeyModifiers::SHIFT,
            ),
            true,
            false,
        ));
        assert!(!app.text_selection.is_dragging());
    }

    #[test]
    fn empty_fragment_row_primary_down_does_not_start_selection() {
        let mut app = selectable_app();
        app.wrapped_log_cache.as_mut().unwrap().wrapped[5]
            .selectable_fragments
            .clear();

        assert!(!handle_mouse_event(
            &mut app,
            mouse(MouseEventKind::Down(MouseButton::Left), 1, 2),
            true,
            false,
        ));
        assert!(!app.text_selection.is_dragging());
    }

    #[test]
    fn outside_click_clears_idle_notice_and_requests_redraw() {
        let mut app = selectable_app();
        app.set_selection_notice("Copy failed: empty selection");

        assert!(handle_mouse_event(
            &mut app,
            mouse(MouseEventKind::Down(MouseButton::Left), 30, 2),
            true,
            false,
        ));
        assert!(app.selection_notice.is_none());
        assert!(app.transcript_hit_map.is_some());
    }

    #[test]
    fn modifiers_appearing_during_owned_drag_cancel_it() {
        let mut app = selectable_app();
        assert!(handle_mouse_event(
            &mut app,
            mouse(MouseEventKind::Down(MouseButton::Left), 1, 2),
            true,
            false,
        ));

        assert!(handle_mouse_event(
            &mut app,
            mouse_with_modifiers(
                MouseEventKind::Drag(MouseButton::Left),
                6,
                3,
                KeyModifiers::SHIFT,
            ),
            true,
            false,
        ));
        assert!(!app.text_selection.is_dragging());
    }

    #[test]
    fn idle_clear_preserves_current_hit_map_for_the_next_mouse_down() {
        let mut app = selectable_app();

        assert!(!app.clear_text_selection());
        assert!(app.transcript_hit_map.is_some());
        assert!(handle_mouse_event(
            &mut app,
            mouse(MouseEventKind::Down(MouseButton::Left), 1, 2),
            true,
            false,
        ));
        assert!(app.text_selection.is_dragging());
    }

    #[test]
    fn dirty_frame_mouse_up_cancels_drag_instead_of_leaving_it_stuck() {
        let mut app = selectable_app();
        assert!(handle_mouse_event(
            &mut app,
            mouse(MouseEventKind::Down(MouseButton::Left), 1, 2),
            true,
            false,
        ));

        assert!(handle_mouse_event(
            &mut app,
            mouse(MouseEventKind::Up(MouseButton::Left), 6, 3),
            true,
            true,
        ));
        assert!(!app.text_selection.is_dragging());
        assert!(app.text_selection.normalized_range().is_none());
    }

    #[test]
    fn wheel_scrolling_is_preserved_when_owned_selection_is_enabled() {
        let mut app = selectable_app();
        assert!(handle_mouse_event(
            &mut app,
            mouse(MouseEventKind::ScrollUp, 0, 0),
            true,
            false,
        ));
        assert_eq!(app.scroll_from_bottom, 3);
    }

    #[test]
    fn f2_toggles_mouse_capture_and_clears_owned_selection() {
        use super::handle_main_key;
        use crossterm::event::KeyCode;

        let mut app = selectable_app();
        app.mouse_capture_enabled = true;
        assert!(handle_mouse_event(
            &mut app,
            mouse(MouseEventKind::Down(MouseButton::Left), 1, 2),
            true,
            false,
        ));
        assert!(app.text_selection.is_dragging());

        let mut tx = crate::app::runtime::MockRuntimeTx::default();
        assert!(handle_main_key(
            &mut app,
            KeyCode::F(2),
            KeyModifiers::NONE,
            &mut tx
        ));
        assert!(!app.mouse_capture_enabled);
        assert!(!app.text_selection.is_dragging());
        assert!(app.text_selection.normalized_range().is_none());

        assert!(handle_main_key(
            &mut app,
            KeyCode::F(2),
            KeyModifiers::NONE,
            &mut tx
        ));
        assert!(app.mouse_capture_enabled);
    }
}
