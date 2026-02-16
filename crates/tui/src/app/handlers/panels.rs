use crate::app::runtime::{
    send_model_list, send_model_set, send_pick_response, send_session_history,
};
use crate::app::state::LogKind;
use crate::app::{AppState, ModelListMode, ModelListSubmitAction};
use crossterm::event::KeyCode;
use std::io::BufWriter;
use std::process::ChildStdin;

type RuntimeStdin = BufWriter<ChildStdin>;

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

pub(crate) fn request_session_history(
    app: &mut AppState,
    child_stdin: &mut RuntimeStdin,
    next_id: &mut impl FnMut() -> String,
    session_id: &str,
) {
    let id = next_id();
    app.pending_session_history_id = Some(id.clone());
    if let Err(error) = send_session_history(child_stdin, &id, session_id, None, None) {
        app.push_error_report("send error", error.to_string());
    }
}

pub(crate) fn handle_context_panel_key(app: &mut AppState, key: KeyCode) -> Option<bool> {
    let panel = app.context_panel.as_mut()?;
    let mut needs_redraw = false;
    match key {
        KeyCode::Esc | KeyCode::Enter => {
            app.context_panel = None;
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
    app.skills_list_panel.as_ref()?;
    let mut needs_redraw = false;
    match key {
        KeyCode::Esc => {
            app.skills_list_panel = None;
            needs_redraw = true;
        }
        KeyCode::Enter => {
            let selected = app.skills_list_panel.as_ref().and_then(|panel| {
                panel
                    .selected_item_index()
                    .and_then(|index| panel.items.get(index))
                    .map(|item| (item.name.clone(), item.enabled))
            });
            app.skills_list_panel = None;
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
            if let Some(panel) = app.skills_list_panel.as_mut() {
                panel.selected = panel.selected.saturating_sub(1);
            }
            needs_redraw = true;
        }
        KeyCode::Down => {
            if let Some(panel) = app.skills_list_panel.as_mut() {
                if panel.selected + 1 < panel.filtered_indices.len() {
                    panel.selected += 1;
                }
            }
            needs_redraw = true;
        }
        KeyCode::PageUp => {
            if let Some(panel) = app.skills_list_panel.as_mut() {
                panel.selected = panel.selected.saturating_sub(5);
            }
            needs_redraw = true;
        }
        KeyCode::PageDown => {
            if let Some(panel) = app.skills_list_panel.as_mut() {
                let next = panel.selected.saturating_add(5);
                panel.selected = usize::min(next, panel.filtered_indices.len().saturating_sub(1));
            }
            needs_redraw = true;
        }
        KeyCode::Tab => {
            if let Some(panel) = app.skills_list_panel.as_mut() {
                panel.scope_filter = panel.scope_filter.cycle();
                panel.rebuild();
            }
            needs_redraw = true;
        }
        KeyCode::Char(' ') | KeyCode::Char('e') | KeyCode::Char('E') => {
            let selected_index = app
                .skills_list_panel
                .as_ref()
                .and_then(|panel| panel.selected_item_index());
            if let Some(index) = selected_index {
                let mut update: Option<(String, bool)> = None;
                if let Some(panel) = app.skills_list_panel.as_mut() {
                    if let Some(item) = panel.items.get_mut(index) {
                        item.enabled = !item.enabled;
                        update = Some((item.path.clone(), item.enabled));
                    }
                    panel.rebuild();
                }
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
            if let Some(panel) = app.skills_list_panel.as_mut() {
                panel.search_query.pop();
                panel.rebuild();
            }
            needs_redraw = true;
        }
        KeyCode::Char(ch) => {
            if let Some(panel) = app.skills_list_panel.as_mut() {
                panel.search_query.push(ch);
                panel.rebuild();
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
    child_stdin: &mut RuntimeStdin,
    next_id: &mut impl FnMut() -> String,
) -> Option<bool> {
    let panel = app.model_list_panel.as_mut()?;
    let mut needs_redraw = false;
    match key {
        KeyCode::Esc => {
            let pending_pick_id = match &panel.submit_action {
                ModelListSubmitAction::UiPick { request_id, .. } => Some(request_id.clone()),
                ModelListSubmitAction::ModelSet => None,
            };
            app.model_list_panel = None;
            if let Some(request_id) = pending_pick_id {
                let ids: Vec<String> = Vec::new();
                if let Err(error) = send_pick_response(child_stdin, &request_id, &ids) {
                    app.push_error_report("pick response error", error.to_string());
                }
            }
            needs_redraw = true;
        }
        KeyCode::Enter => {
            let selected = panel.selected;
            let model = panel.model_ids.get(selected).cloned();
            let submit_action = match &panel.submit_action {
                ModelListSubmitAction::ModelSet => ModelListSubmitAction::ModelSet,
                ModelListSubmitAction::UiPick {
                    request_id,
                    item_ids,
                } => ModelListSubmitAction::UiPick {
                    request_id: request_id.clone(),
                    item_ids: item_ids.clone(),
                },
            };
            app.model_list_panel = None;
            if let Some(model) = model {
                match submit_action {
                    ModelListSubmitAction::ModelSet => {
                        let id = next_id();
                        app.pending_model_set_id = Some(id.clone());
                        let provider = app.current_provider.as_deref();
                        if let Err(error) = send_model_set(child_stdin, &id, provider, &model) {
                            app.push_error_report("send error", error.to_string());
                        }
                    }
                    ModelListSubmitAction::UiPick {
                        request_id,
                        item_ids,
                    } => {
                        if let Some(item_id) = item_ids.get(selected) {
                            let ids = vec![item_id.clone()];
                            if let Err(error) = send_pick_response(child_stdin, &request_id, &ids) {
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
    child_stdin: &mut RuntimeStdin,
    next_id: &mut impl FnMut() -> String,
) -> Option<bool> {
    let panel = app.session_list_panel.as_mut()?;
    let mut needs_redraw = false;
    match key {
        KeyCode::Esc => {
            app.session_list_panel = None;
            needs_redraw = true;
        }
        KeyCode::Enter => {
            let selected = panel.selected;
            let session_id = panel.session_ids.get(selected).cloned();
            app.session_list_panel = None;
            if let Some(session_id) = session_id {
                app.session_id = Some(session_id.clone());
                let short_id: String = session_id.chars().take(8).collect();
                app.push_line(LogKind::Status, format!("Resuming session {short_id}"));
                app.push_line(LogKind::Space, "");
                request_session_history(app, child_stdin, next_id, &session_id);
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
        _ => {}
    }
    Some(needs_redraw)
}

pub(crate) fn handle_lane_list_panel_key(
    app: &mut AppState,
    key: KeyCode,
    _child_stdin: &mut RuntimeStdin,
    _next_id: &mut impl FnMut() -> String,
) -> Option<bool> {
    let panel = app.lane_list_panel.as_mut()?;
    let mut needs_redraw = false;
    match key {
        KeyCode::Esc => {
            app.lane_list_panel = None;
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
                app.pending_new_lane_seed_context = None;
                app.prompt_dialog = Some(crate::app::PromptDialogState {
                    id: "lane:new-task".to_string(),
                    title: "New lane".to_string(),
                    message: "Task id".to_string(),
                    multiline: false,
                    secret: false,
                });
                app.prompt_input.clear();
                needs_redraw = true;
            } else if let Some(lane) = panel.lanes.get(panel.selected).cloned() {
                app.pick_dialog = Some(crate::app::PickDialogState {
                    id: format!("lane:action:{}", lane.lane_id),
                    title: format!("Lane {}", lane.lane_id),
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
    child_stdin: &mut RuntimeStdin,
    next_id: &mut impl FnMut() -> String,
) -> Option<bool> {
    let picker = app.provider_picker.as_mut()?;
    let mut needs_redraw = false;
    match key {
        KeyCode::Esc => {
            app.provider_picker = None;
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
            app.provider_picker = None;
            app.model_list_panel = None;
            if let Some(provider) = provider {
                let id = next_id();
                app.pending_model_list_id = Some(id.clone());
                app.pending_model_list_mode = Some(mode);
                let include_details = matches!(mode, ModelListMode::List);
                if let Err(error) =
                    send_model_list(child_stdin, &id, Some(&provider), include_details)
                {
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
    child_stdin: &mut RuntimeStdin,
    next_id: &mut impl FnMut() -> String,
) -> Option<bool> {
    let picker = app.model_picker.as_mut()?;
    let mut needs_redraw = false;
    match key {
        KeyCode::Esc => {
            app.model_picker = None;
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
            if let Some(model) = picker.models.get(picker.selected).cloned() {
                let id = next_id();
                app.pending_model_set_id = Some(id.clone());
                let provider = app.current_provider.as_deref();
                if let Err(error) = send_model_set(child_stdin, &id, provider, &model) {
                    app.push_error_report("send error", error.to_string());
                }
            }
            app.model_picker = None;
            app.model_list_panel = None;
            needs_redraw = true;
        }
        _ => {}
    }
    Some(needs_redraw)
}
