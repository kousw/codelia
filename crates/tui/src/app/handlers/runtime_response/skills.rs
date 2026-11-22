use super::formatters::push_rpc_error;
use crate::app::runtime::RpcResponse;
use crate::app::state::LogKind;
use crate::app::{AppState, SkillsListItemState, SkillsListPanelState, SkillsScopeFilter};
use crate::protocol::{decode_result, methods, SkillCatalog};

pub(super) fn handle_skills_list_response(app: &mut AppState, response: RpcResponse) {
    if let Some(error) = response.error {
        app.skills_catalog_loaded = true;
        app.rpc_pending.skills_query = None;
        app.rpc_pending.skills_scope = None;
        push_rpc_error(app, "skills.list", &error);
        return;
    }
    if let Some(result) = response.result {
        match decode_result::<methods::SkillsList>(result) {
            Ok(result) => apply_skills_list_result(app, &result),
            Err(error) => {
                app.skills_catalog_loaded = true;
                app.rpc_pending.skills_query = None;
                app.rpc_pending.skills_scope = None;
                super::push_protocol_mismatch(app, &error);
            }
        }
    }
}

fn apply_skills_list_result(app: &mut AppState, result: &SkillCatalog) {
    let errors = &result.errors;
    let truncated = result.truncated;
    let open_panel =
        app.rpc_pending.skills_query.is_some() || app.rpc_pending.skills_scope.is_some();
    let query = app.rpc_pending.skills_query.take().unwrap_or_default();
    let scope_filter = app
        .rpc_pending
        .skills_scope
        .take()
        .unwrap_or(SkillsScopeFilter::All);

    let mut items = Vec::new();
    for skill in &result.skills {
        let name = skill.name.clone();
        let description = skill.description.clone();
        let path = skill.path.clone();
        let scope = skill.scope.as_str().to_owned();
        if name.is_empty() || path.is_empty() {
            continue;
        }
        let enabled = !app.disabled_skill_paths.contains(&path);
        items.push(SkillsListItemState {
            name,
            description,
            path,
            scope,
            enabled,
        });
    }

    app.skills_catalog_loaded = true;
    app.skills_catalog_items = items.clone();

    if !open_panel {
        return;
    }

    if items.is_empty() {
        app.push_line(LogKind::Status, "No skills found.");
        app.push_line(LogKind::Space, "");
        app.skills_list_panel = None;
        app.theme_list_panel = None;
        return;
    }

    if truncated {
        app.push_line(
            LogKind::Status,
            "skills.list result truncated; refine search in the panel.",
        );
    }
    if !errors.is_empty() {
        app.push_line(
            LogKind::Status,
            format!("skills.list skipped {} invalid skill files.", errors.len()),
        );
    }
    if truncated || !errors.is_empty() {
        app.push_line(LogKind::Space, "");
    }

    let mut panel = SkillsListPanelState {
        title: format!(
            "Skills picker ({}){}{}",
            items.len(),
            if truncated { " truncated" } else { "" },
            if errors.is_empty() {
                String::new()
            } else {
                format!(", errors={}", errors.len())
            }
        ),
        header: String::new(),
        rows: Vec::new(),
        filtered_indices: Vec::new(),
        items,
        selected: 0,
        search_query: query,
        scope_filter,
    };
    panel.rebuild();
    app.model_list_panel = None;
    app.reasoning_picker = None;
    app.session_list_panel = None;
    app.context_panel = None;
    app.theme_list_panel = None;
    app.skills_list_panel = Some(panel);
}
