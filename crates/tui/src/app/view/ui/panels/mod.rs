mod dialogs;
mod lists;
mod model;
mod picker;
mod render;
mod suggestions;
mod types;

use crate::app::AppState;

use dialogs::{build_confirm_panel_view, build_pick_panel_view, build_prompt_panel_view};
use lists::{
    build_context_panel_view, build_lane_list_panel_view, build_session_list_panel_view,
    build_skills_list_panel_view,
};
use model::build_model_list_panel_view;
use picker::build_picker_panel_view;
use suggestions::{
    build_attachment_panel_view, build_command_panel_view, build_skill_suggestion_panel_view,
};

pub(super) use render::{build_panel_render, render_input_panel};
pub(super) use types::PanelView;

pub(super) fn build_panel_view(app: &AppState) -> Option<PanelView> {
    if let Some(panel) = &app.confirm_dialog {
        return Some(build_confirm_panel_view(panel));
    }

    if let Some(panel) = &app.prompt_dialog {
        return Some(build_prompt_panel_view(panel));
    }

    if let Some(panel) = &app.pick_dialog {
        return Some(build_pick_panel_view(panel));
    }

    if let Some(panel) = &app.session_list_panel {
        return Some(build_session_list_panel_view(panel));
    }

    if let Some(panel) = &app.lane_list_panel {
        return Some(build_lane_list_panel_view(panel));
    }

    if let Some(panel) = &app.context_panel {
        return Some(build_context_panel_view(panel));
    }

    if let Some(panel) = &app.skills_list_panel {
        return Some(build_skills_list_panel_view(panel));
    }

    if let Some(panel) = &app.model_list_panel {
        return Some(build_model_list_panel_view(panel));
    }

    if let Some(picker) = &app.provider_picker {
        return Some(build_picker_panel_view(
            "Select provider".to_string(),
            &picker.providers,
            picker.selected,
            app.current_provider.as_deref(),
        ));
    }

    if let Some(picker) = &app.model_picker {
        let provider_label = app.current_provider.as_deref().unwrap_or("openai");
        let title = format!("Select model ({provider_label})");
        return Some(build_picker_panel_view(
            title,
            &picker.models,
            picker.selected,
            app.current_model.as_deref(),
        ));
    }

    build_command_panel_view(app)
        .or_else(|| build_skill_suggestion_panel_view(app))
        .or_else(|| build_attachment_panel_view(app))
}
