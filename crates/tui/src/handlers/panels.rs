use crate::app::{AppState, ModelListMode};
use crate::model::LogKind;
use crate::runtime::{send_model_list, send_model_set, send_session_history};
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
        app.push_line(LogKind::Error, format!("send error: {error}"));
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
            app.model_list_panel = None;
            needs_redraw = true;
        }
        KeyCode::Enter => {
            let selected = panel.selected;
            let model = panel.model_ids.get(selected).cloned();
            app.model_list_panel = None;
            if let Some(model) = model {
                let id = next_id();
                app.pending_model_set_id = Some(id.clone());
                let provider = app.current_provider.as_deref();
                if let Err(error) = send_model_set(child_stdin, &id, provider, &model) {
                    app.push_line(LogKind::Error, format!("send error: {error}"));
                }
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
                    app.push_line(LogKind::Error, format!("send error: {error}"));
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
                    app.push_line(LogKind::Error, format!("send error: {error}"));
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
