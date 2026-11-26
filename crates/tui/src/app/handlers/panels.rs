use crate::app::runtime::{
    send_model_list, send_model_set, send_pick_response, send_session_history, send_session_list,
    send_session_open, send_theme_set, RuntimeTx,
};
use crate::app::state::parse_theme_name;
use crate::app::state::LogKind;
use crate::app::{
    AppState, LocalPanel, ModelListMode, ModelListSubmitAction, ModelSetScope, PendingRpc,
    PendingRpcSlot,
};
use crossterm::event::KeyCode;

const REASONING_LEVELS: [&str; 5] = ["low", "medium", "high", "xhigh", "max"];
const SESSION_HISTORY_MAX_EVENTS: usize = 500;

#[cfg(test)]
mod reasoning_level_tests {
    use super::{
        handle_model_picker_key, request_session_history, request_session_list, REASONING_LEVELS,
    };
    use crate::app::runtime::MockRuntimeTx;
    use crate::app::{AppState, LocalPanel, ModelPickerState, PendingRpc, PendingRpcSlot};
    use crossterm::event::KeyCode;

    #[test]
    fn reasoning_picker_includes_max_after_xhigh() {
        assert_eq!(REASONING_LEVELS, ["low", "medium", "high", "xhigh", "max"]);
    }

    #[test]
    fn model_picker_enter_keeps_the_new_reasoning_picker() {
        let mut app = AppState::default();
        let mut tx = MockRuntimeTx::default();
        app.overlays.local_panel = Some(LocalPanel::ModelPicker(ModelPickerState {
            models: vec!["model".into()],
            selected: 0,
        }));

        assert_eq!(
            handle_model_picker_key(&mut app, KeyCode::Enter, &mut tx),
            Some(true)
        );
        assert!(matches!(
            app.overlays.local_panel,
            Some(LocalPanel::ReasoningPicker(ref picker)) if picker.model == "model"
        ));
    }

    #[test]
    fn read_only_request_send_failure_clears_own_slot_without_dropping_others() {
        let mut app = AppState::default();
        app.rpc_pending
            .insert("keep".into(), PendingRpc::SessionOpen);
        let mut tx = MockRuntimeTx::default();
        tx.fail_next = Some(std::io::ErrorKind::BrokenPipe);

        request_session_history(&mut app, &mut tx, "sess-1");
        assert!(!app.rpc_pending.has_slot(PendingRpcSlot::SessionHistory));
        assert_eq!(
            app.rpc_pending.slot_id(PendingRpcSlot::SessionOpen),
            Some("keep")
        );

        tx.fail_next = Some(std::io::ErrorKind::BrokenPipe);
        request_session_list(&mut app, &mut tx, true);
        assert!(!app.rpc_pending.has_slot(PendingRpcSlot::SessionList));
        assert_eq!(
            app.rpc_pending.slot_id(PendingRpcSlot::SessionOpen),
            Some("keep")
        );
    }
}

fn open_reasoning_picker(
    app: &mut AppState,
    provider: Option<&str>,
    model: String,
    scope: ModelSetScope,
    tx: &mut dyn RuntimeTx,
) {
    let levels = app
        .runtime_info
        .model_reasoning_levels
        .get(&model)
        .cloned()
        .unwrap_or_else(|| {
            REASONING_LEVELS
                .iter()
                .map(|level| (*level).to_string())
                .collect::<Vec<_>>()
        });
    if levels.is_empty() {
        let id = tx.next_id();
        app.rpc_pending.insert(id.clone(), PendingRpc::ModelSet);
        if let Err(error) = send_model_set(
            tx,
            &id,
            provider,
            &model,
            None,
            None,
            Some(scope.as_str()),
            false,
        ) {
            app.rpc_pending.remove_slot(PendingRpcSlot::ModelSet);
            app.push_error_report("send error", error.to_string());
        }
        return;
    }
    let selected = app
        .runtime_info
        .current_reasoning
        .as_ref()
        .and_then(|current| levels.iter().position(|value| value == current))
        .unwrap_or_else(|| usize::from(levels.len() > 1));
    app.overlays.local_panel = Some(LocalPanel::ReasoningPicker(
        crate::app::ReasoningPickerState {
            provider: provider.map(str::to_string),
            model,
            scope,
            levels,
            selected,
        },
    ));
}

fn append_skill_mention(app: &mut AppState, skill_name: &str) {
    let current = app.input.current();
    let ends_with_whitespace = current
        .chars()
        .last()
        .map(|ch| ch.is_whitespace())
        .unwrap_or(false);
    if !current.is_empty() && !ends_with_whitespace {
        app.input.insert_char(' ');
    }
    app.input.insert_str(&format!("${skill_name} "));
}

/// Binds the runtime to `session_id` so a model change before the first
/// message is saved to that session.
pub(crate) fn request_session_open(app: &mut AppState, tx: &mut dyn RuntimeTx, session_id: &str) {
    let id = tx.next_id();
    app.rpc_pending.insert(id.clone(), PendingRpc::SessionOpen);
    if let Err(error) = send_session_open(tx, &id, session_id) {
        app.rpc_pending.remove_slot(PendingRpcSlot::SessionOpen);
        app.push_error_report("send error", error.to_string());
    }
}

pub(crate) fn request_session_history(
    app: &mut AppState,
    tx: &mut dyn RuntimeTx,
    session_id: &str,
) {
    let id = tx.next_id();
    app.rpc_pending
        .insert(id.clone(), PendingRpc::SessionHistory);
    if let Err(error) =
        send_session_history(tx, &id, session_id, None, Some(SESSION_HISTORY_MAX_EVENTS))
    {
        app.rpc_pending.take(&id);
        app.push_error_report("send error", error.to_string());
    }
}

pub(crate) fn request_session_list(app: &mut AppState, tx: &mut dyn RuntimeTx, show_all: bool) {
    let id = tx.next_id();
    app.rpc_pending
        .insert(id.clone(), PendingRpc::SessionList { show_all });
    if let Err(error) = send_session_list(tx, &id, Some(50), show_all) {
        app.rpc_pending.take(&id);
        app.push_error_report("send error", error.to_string());
    }
}

pub(crate) fn handle_context_panel_key(app: &mut AppState, key: KeyCode) -> Option<bool> {
    let Some(LocalPanel::Context(panel)) = app.overlays.local_panel.as_mut() else {
        return None;
    };
    let mut needs_redraw = false;
    match key {
        KeyCode::Esc | KeyCode::Enter => {
            app.overlays.local_panel = None;
            needs_redraw = true;
        }
        KeyCode::Up => {
            panel.selected = panel.selected.saturating_sub(1);
            needs_redraw = true;
        }
        KeyCode::Down => {
            if panel.selected + 1 < panel.rows.len() {
                panel.selected += 1;
                needs_redraw = true;
            }
        }
        KeyCode::PageUp => {
            panel.selected = panel.selected.saturating_sub(8);
            needs_redraw = true;
        }
        KeyCode::PageDown => {
            let next = panel.selected.saturating_add(8);
            panel.selected = usize::min(next, panel.rows.len().saturating_sub(1));
            needs_redraw = true;
        }
        _ => {}
    }
    Some(needs_redraw)
}

pub(crate) fn handle_skills_list_panel_key(app: &mut AppState, key: KeyCode) -> Option<bool> {
    let Some(LocalPanel::SkillsList(panel)) = app.overlays.local_panel.as_mut() else {
        return None;
    };
    let mut needs_redraw = false;
    match key {
        KeyCode::Esc => {
            app.overlays.local_panel = None;
            needs_redraw = true;
        }
        KeyCode::Enter => {
            let selected = panel
                .selected_item_index()
                .and_then(|index| panel.items.get(index))
                .map(|item| (item.name.clone(), item.enabled));
            app.overlays.local_panel = None;
            if let Some((name, enabled)) = selected {
                if enabled {
                    append_skill_mention(app, &name);
                    app.push_line(LogKind::Status, format!("Inserted skill mention: ${name}"));
                } else {
                    app.push_line(
                        LogKind::Status,
                        format!("Skill is disabled; enable it before insert: {name}"),
                    );
                }
            }
            needs_redraw = true;
        }
        KeyCode::Up => {
            panel.selected = panel.selected.saturating_sub(1);
            needs_redraw = true;
        }
        KeyCode::Down => {
            if panel.selected + 1 < panel.filtered_indices.len() {
                panel.selected += 1;
            }
            needs_redraw = true;
        }
        KeyCode::PageUp => {
            panel.selected = panel.selected.saturating_sub(5);
            needs_redraw = true;
        }
        KeyCode::PageDown => {
            let next = panel.selected.saturating_add(5);
            panel.selected = usize::min(next, panel.filtered_indices.len().saturating_sub(1));
            needs_redraw = true;
        }
        KeyCode::Tab => {
            panel.scope_filter = panel.scope_filter.cycle();
            panel.rebuild();
            needs_redraw = true;
        }
        KeyCode::Char(' ') | KeyCode::Char('e') | KeyCode::Char('E') => {
            let selected_index = panel.selected_item_index();
            if let Some(index) = selected_index {
                let mut update: Option<(String, bool)> = None;
                if let Some(item) = panel.items.get_mut(index) {
                    item.enabled = !item.enabled;
                    update = Some((item.path.clone(), item.enabled));
                }
                panel.rebuild();
                if let Some((path, enabled)) = update {
                    if enabled {
                        app.disabled_skill_paths.remove(&path);
                    } else {
                        app.disabled_skill_paths.insert(path);
                    }
                }
            }
            needs_redraw = true;
        }
        KeyCode::Backspace => {
            panel.search_query.pop();
            panel.rebuild();
            needs_redraw = true;
        }
        KeyCode::Char(ch) => {
            panel.search_query.push(ch);
            panel.rebuild();
            needs_redraw = true;
        }
        _ => {}
    }
    Some(needs_redraw)
}

pub(crate) fn handle_theme_list_panel_key(
    app: &mut AppState,
    key: KeyCode,
    tx: &mut dyn RuntimeTx,
) -> Option<bool> {
    let Some(LocalPanel::ThemeList(panel)) = app.overlays.local_panel.as_mut() else {
        return None;
    };
    let mut needs_redraw = false;
    match key {
        KeyCode::Esc => {
            app.overlays.local_panel = None;
            needs_redraw = true;
        }
        KeyCode::Up => {
            panel.selected = panel.selected.saturating_sub(1);
            needs_redraw = true;
        }
        KeyCode::Down => {
            if panel.selected + 1 < panel.rows.len() {
                panel.selected += 1;
            }
            needs_redraw = true;
        }
        KeyCode::PageUp => {
            panel.selected = panel.selected.saturating_sub(5);
            needs_redraw = true;
        }
        KeyCode::PageDown => {
            let next = panel.selected.saturating_add(5);
            panel.selected = usize::min(next, panel.rows.len().saturating_sub(1));
            needs_redraw = true;
        }
        KeyCode::Enter => {
            let selected_theme = panel
                .theme_ids
                .get(panel.selected)
                .and_then(|value| parse_theme_name(value));
            app.overlays.local_panel = None;
            if let Some(theme) = selected_theme {
                if !app.runtime_info.supports_theme_set {
                    app.push_line(LogKind::Status, "Theme update unavailable");
                } else if app.rpc_pending.has_slot(PendingRpcSlot::ThemeSet) {
                    app.push_line(LogKind::Status, "Theme update request already running");
                } else {
                    let id = tx.next_id();
                    app.rpc_pending.insert(id.clone(), PendingRpc::ThemeSet);
                    if let Err(error) = send_theme_set(tx, &id, theme.as_str()) {
                        app.rpc_pending.remove_slot(PendingRpcSlot::ThemeSet);
                        app.push_error_report("send error", error.to_string());
                    }
                }
            }
            needs_redraw = true;
        }
        _ => {}
    }
    Some(needs_redraw)
}

pub(crate) fn handle_model_list_panel_key(
    app: &mut AppState,
    key: KeyCode,
    tx: &mut dyn RuntimeTx,
) -> Option<bool> {
    let Some(LocalPanel::ModelList(panel)) = app.overlays.local_panel.as_mut() else {
        return None;
    };
    let mut needs_redraw = false;
    match key {
        KeyCode::Esc => {
            let pending_pick_id = match &panel.submit_action {
                ModelListSubmitAction::UiPick { request_id, .. } => Some(request_id.clone()),
                ModelListSubmitAction::ModelSet { .. } => None,
            };
            app.overlays.local_panel = None;
            if let Some(request_id) = pending_pick_id {
                let ids: Vec<String> = Vec::new();
                if let Err(error) = send_pick_response(tx, &request_id, &ids) {
                    app.push_error_report("pick response error", error.to_string());
                }
            }
            needs_redraw = true;
        }
        KeyCode::Enter => {
            let selected = panel.selected;
            let model = panel.model_ids.get(selected).cloned();
            let submit_action = match &panel.submit_action {
                ModelListSubmitAction::ModelSet { scope } => {
                    ModelListSubmitAction::ModelSet { scope: *scope }
                }
                ModelListSubmitAction::UiPick {
                    request_id,
                    item_ids,
                } => ModelListSubmitAction::UiPick {
                    request_id: request_id.clone(),
                    item_ids: item_ids.clone(),
                },
            };
            app.overlays.local_panel = None;
            if let Some(model) = model {
                match submit_action {
                    ModelListSubmitAction::ModelSet { scope } => {
                        let provider = app.runtime_info.current_provider.clone();
                        open_reasoning_picker(app, provider.as_deref(), model, scope, tx);
                    }
                    ModelListSubmitAction::UiPick {
                        request_id,
                        item_ids,
                    } => {
                        if let Some(item_id) = item_ids.get(selected) {
                            let ids = vec![item_id.clone()];
                            if let Err(error) = send_pick_response(tx, &request_id, &ids) {
                                app.push_error_report("pick response error", error.to_string());
                            }
                        }
                    }
                }
            }
            needs_redraw = true;
        }
        KeyCode::Up => {
            panel.selected = panel.selected.saturating_sub(1);
            needs_redraw = true;
        }
        KeyCode::Down => {
            if panel.selected + 1 < panel.model_ids.len() {
                panel.selected += 1;
                needs_redraw = true;
            }
        }
        KeyCode::PageUp => {
            panel.selected = panel.selected.saturating_sub(5);
            needs_redraw = true;
        }
        KeyCode::PageDown => {
            let next = panel.selected.saturating_add(5);
            panel.selected = usize::min(next, panel.model_ids.len().saturating_sub(1));
            needs_redraw = true;
        }
        KeyCode::Tab => {
            panel.view_mode = panel.view_mode.toggle();
            needs_redraw = true;
        }
        _ => {}
    }
    Some(needs_redraw)
}

pub(crate) fn handle_session_list_panel_key(
    app: &mut AppState,
    key: KeyCode,
    tx: &mut dyn RuntimeTx,
) -> Option<bool> {
    let Some(LocalPanel::SessionList(panel)) = app.overlays.local_panel.as_mut() else {
        return None;
    };
    let mut needs_redraw = false;
    match key {
        KeyCode::Esc => {
            app.overlays.local_panel = None;
            needs_redraw = true;
        }
        KeyCode::Enter => {
            if app.rpc_pending.has_shell_rule_run() {
                app.push_line(
                    LogKind::Status,
                    "Wait for the /permissions command to finish before changing sessions.",
                );
                return Some(true);
            }
            let selected = panel.selected;
            let session_id = panel.session_ids.get(selected).cloned();
            app.overlays.local_panel = None;
            if let Some(session_id) = session_id {
                if app.runtime_info.session_id.as_ref() != Some(&session_id) {
                    app.runtime_info.attachment_session_epoch += 1;
                    app.discard_composer_attachments();
                    app.image_preview.forget();
                }
                app.runtime_info.session_id = Some(session_id.clone());
                let short_id: String = session_id.chars().take(8).collect();
                app.push_line(LogKind::Status, format!("Resuming session {short_id}"));
                app.push_line(LogKind::Space, "");
                request_session_open(app, tx, &session_id);
                request_session_history(app, tx, &session_id);
            }
            needs_redraw = true;
        }
        KeyCode::Up => {
            panel.selected = panel.selected.saturating_sub(1);
            needs_redraw = true;
        }
        KeyCode::Down => {
            if panel.selected + 1 < panel.rows.len() {
                panel.selected += 1;
                needs_redraw = true;
            }
        }
        KeyCode::PageUp => {
            panel.selected = panel.selected.saturating_sub(5);
            needs_redraw = true;
        }
        KeyCode::PageDown => {
            let next = panel.selected.saturating_add(5);
            panel.selected = usize::min(next, panel.rows.len().saturating_sub(1));
            needs_redraw = true;
        }
        KeyCode::Char('a') | KeyCode::Char('A') => {
            let show_all = !panel.show_all;
            request_session_list(app, tx, show_all);
            needs_redraw = true;
        }
        _ => {}
    }
    Some(needs_redraw)
}

pub(crate) fn handle_lane_list_panel_key(
    app: &mut AppState,
    key: KeyCode,
    _tx: &mut dyn RuntimeTx,
) -> Option<bool> {
    let Some(LocalPanel::LaneList(panel)) = app.overlays.local_panel.as_mut() else {
        return None;
    };
    let mut needs_redraw = false;
    match key {
        KeyCode::Esc => {
            app.overlays.local_panel = None;
            needs_redraw = true;
        }
        KeyCode::Up => {
            panel.selected = panel.selected.saturating_sub(1);
            needs_redraw = true;
        }
        KeyCode::Down => {
            if panel.selected + 1 < panel.rows.len() {
                panel.selected += 1;
                needs_redraw = true;
            }
        }
        KeyCode::PageUp => {
            panel.selected = panel.selected.saturating_sub(5);
            needs_redraw = true;
        }
        KeyCode::PageDown => {
            let next = panel.selected.saturating_add(5);
            panel.selected = usize::min(next, panel.rows.len().saturating_sub(1));
            needs_redraw = true;
        }
        KeyCode::Enter => {
            if panel.selected >= panel.lanes.len() {
                app.new_lane_task_id = None;
                app.overlays.runtime_dialogs.prompt = Some(crate::app::PromptSlot {
                    state: crate::app::PromptDialogState {
                        id: "lane:new-task".to_string(),
                        title: "New lane".to_string(),
                        message: "Task id".to_string(),
                        multiline: false,
                        secret: false,
                    },
                    input: Default::default(),
                });
                needs_redraw = true;
            } else if let Some(lane) = panel.lanes.get(panel.selected).cloned() {
                app.overlays.runtime_dialogs.pick = Some(crate::app::PickDialogState {
                    id: format!("lane:action:{}", lane.lane_id),
                    title: format!("Lane {}", lane.lane_id),
                    message: None,
                    items: vec![
                        crate::app::PickDialogItem {
                            id: "status".to_string(),
                            label: "Status".to_string(),
                            detail: Some("Show lane status".to_string()),
                        },
                        crate::app::PickDialogItem {
                            id: "close".to_string(),
                            label: "Close".to_string(),
                            detail: Some("Close lane".to_string()),
                        },
                    ],
                    multi: false,
                    selected: 0,
                    approval: false,
                    review_offset: None,
                    shell_rule_picker: None,
                    local_update_picker: false,
                    chosen: vec![false, false],
                });
                needs_redraw = true;
            }
        }
        _ => {}
    }

    Some(needs_redraw)
}

pub(crate) fn handle_provider_picker_key(
    app: &mut AppState,
    key: KeyCode,
    tx: &mut dyn RuntimeTx,
) -> Option<bool> {
    let Some(LocalPanel::ProviderPicker(picker)) = app.overlays.local_panel.as_mut() else {
        return None;
    };
    let mut needs_redraw = false;
    match key {
        KeyCode::Esc => {
            app.overlays.local_panel = None;
            needs_redraw = true;
        }
        KeyCode::Up => {
            if picker.selected > 0 {
                picker.selected -= 1;
                needs_redraw = true;
            }
        }
        KeyCode::Down => {
            if picker.selected + 1 < picker.providers.len() {
                picker.selected += 1;
                needs_redraw = true;
            }
        }
        KeyCode::Enter => {
            let provider = picker.providers.get(picker.selected).cloned();
            let mode = picker.mode;
            let scope = picker.scope;
            app.overlays.local_panel = None;
            if let Some(provider) = provider {
                let id = tx.next_id();
                app.rpc_pending
                    .insert(id.clone(), PendingRpc::ModelList { mode, scope });
                let include_details = matches!(mode, ModelListMode::List);
                if let Err(error) = send_model_list(tx, &id, Some(&provider), include_details) {
                    app.rpc_pending.take(&id);
                    app.push_error_report("send error", error.to_string());
                }
            }
            needs_redraw = true;
        }
        _ => {}
    }
    Some(needs_redraw)
}

pub(crate) fn handle_model_picker_key(
    app: &mut AppState,
    key: KeyCode,
    tx: &mut dyn RuntimeTx,
) -> Option<bool> {
    let Some(LocalPanel::ModelPicker(picker)) = app.overlays.local_panel.as_mut() else {
        return None;
    };
    let mut needs_redraw = false;
    match key {
        KeyCode::Esc => {
            app.overlays.local_panel = None;
            needs_redraw = true;
        }
        KeyCode::Up => {
            if picker.selected > 0 {
                picker.selected -= 1;
                needs_redraw = true;
            }
        }
        KeyCode::Down => {
            if picker.selected + 1 < picker.models.len() {
                picker.selected += 1;
                needs_redraw = true;
            }
        }
        KeyCode::Enter => {
            let model = picker.models.get(picker.selected).cloned();
            app.overlays.local_panel = None;
            if let Some(model) = model {
                let provider = app.runtime_info.current_provider.clone();
                open_reasoning_picker(app, provider.as_deref(), model, ModelSetScope::Config, tx);
            }
            needs_redraw = true;
        }
        _ => {}
    }
    Some(needs_redraw)
}

pub(crate) fn handle_reasoning_picker_key(
    app: &mut AppState,
    key: KeyCode,
    tx: &mut dyn RuntimeTx,
) -> Option<bool> {
    let Some(LocalPanel::ReasoningPicker(picker)) = app.overlays.local_panel.as_mut() else {
        return None;
    };
    let mut needs_redraw = false;
    match key {
        KeyCode::Esc => {
            app.overlays.local_panel = None;
            needs_redraw = true;
        }
        KeyCode::Up => {
            if picker.selected > 0 {
                picker.selected -= 1;
                needs_redraw = true;
            }
        }
        KeyCode::Down => {
            if picker.selected + 1 < picker.levels.len() {
                picker.selected += 1;
                needs_redraw = true;
            }
        }
        KeyCode::Enter => {
            let provider = picker.provider.clone();
            let model = picker.model.clone();
            let scope = picker.scope;
            let reasoning = picker.levels.get(picker.selected).cloned();
            app.overlays.local_panel = None;
            if let Some(reasoning) = reasoning {
                let id = tx.next_id();
                app.rpc_pending.insert(id.clone(), PendingRpc::ModelSet);
                if let Err(error) = send_model_set(
                    tx,
                    &id,
                    provider.as_deref(),
                    &model,
                    Some(&reasoning),
                    None,
                    Some(scope.as_str()),
                    false,
                ) {
                    app.rpc_pending.remove_slot(PendingRpcSlot::ModelSet);
                    app.push_error_report("send error", error.to_string());
                }
            }
            needs_redraw = true;
        }
        _ => {}
    }
    Some(needs_redraw)
}
