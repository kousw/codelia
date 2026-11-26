mod dialogs;
mod lists;
mod model;
mod picker;
mod render;
mod suggestions;
mod types;

use crate::app::{
    AppState, LocalPanel, RuntimePickDialog, RuntimePickListKind, VisibleRuntimeDialogRef,
};

use dialogs::{
    build_confirm_panel_view, build_lane_action_picker_view, build_prompt_panel_view,
    build_runtime_pick_list_view, build_shell_rule_picker_view, build_update_picker_view,
};
use lists::{
    build_context_panel_view, build_lane_list_panel_view, build_session_list_panel_view,
    build_skills_list_panel_view, build_theme_list_panel_view,
};
use model::build_model_list_panel_view;
use picker::build_picker_panel_view;
use suggestions::{
    build_attachment_panel_view, build_command_panel_view, build_queue_panel_view,
    build_skill_suggestion_panel_view,
};

pub(super) use render::{build_panel_render, render_input_panel};
pub(super) use types::PanelView;

pub(super) fn render_composer_panel(
    app: &AppState,
    view: &PanelView,
    max_lines: u16,
    width: usize,
) -> Vec<ratatui::text::Line<'static>> {
    match app.overlays.runtime_dialogs.visible_top() {
        Some(VisibleRuntimeDialogRef::Pick(RuntimePickDialog::List(pick))) => {
            if let RuntimePickListKind::Approval { review_offset } = pick.kind {
                return dialogs::render_approval_pick(pick, review_offset, view, max_lines, width);
            }
        }
        None => {
            if let Some(LocalPanel::ShellRulePicker(picker)) = &app.overlays.local_panel {
                if let Some(details) = dialogs::render_shell_rule_details(picker, max_lines, width)
                {
                    return details;
                }
            }
        }
        _ => {}
    }
    build_panel_render(view, max_lines, width)
}

pub(super) fn build_panel_view(app: &AppState) -> Option<PanelView> {
    if let Some(dialog) = app.overlays.runtime_dialogs.visible_top() {
        return Some(match dialog {
            VisibleRuntimeDialogRef::Confirm { state, .. } => build_confirm_panel_view(state),
            VisibleRuntimeDialogRef::Prompt(prompt) => build_prompt_panel_view(&prompt.state),
            VisibleRuntimeDialogRef::Pick(RuntimePickDialog::List(pick)) => {
                build_runtime_pick_list_view(pick)
            }
            VisibleRuntimeDialogRef::Pick(RuntimePickDialog::OnboardingModelList {
                panel, ..
            }) => build_model_list_panel_view(panel),
        });
    }

    match &app.overlays.local_panel {
        Some(LocalPanel::SessionList(panel)) => Some(build_session_list_panel_view(panel)),
        Some(LocalPanel::LaneList(panel)) => Some(build_lane_list_panel_view(panel)),
        Some(LocalPanel::Context(panel)) => Some(build_context_panel_view(panel)),
        Some(LocalPanel::SkillsList(panel)) => Some(build_skills_list_panel_view(panel)),
        Some(LocalPanel::ThemeList(panel)) => Some(build_theme_list_panel_view(panel)),
        Some(LocalPanel::ModelList { panel, .. }) => Some(build_model_list_panel_view(panel)),
        Some(LocalPanel::ProviderPicker(picker)) => Some(build_picker_panel_view(
            "Select provider".to_string(),
            &picker.providers,
            picker.selected,
            app.runtime_info.current_provider.as_deref(),
        )),
        Some(LocalPanel::ModelPicker(picker)) => {
            let provider_label = app
                .runtime_info
                .current_provider
                .as_deref()
                .unwrap_or("openai");
            let title = format!("Select model ({provider_label})");
            Some(build_picker_panel_view(
                title,
                &picker.models,
                picker.selected,
                app.runtime_info.current_model.as_deref(),
            ))
        }

        Some(LocalPanel::ReasoningPicker(picker)) => {
            let provider = picker.provider.as_deref().unwrap_or("openai");
            let title = format!("Select reasoning ({provider}/{})", picker.model);
            Some(build_picker_panel_view(
                title,
                &picker.levels,
                picker.selected,
                app.runtime_info.current_reasoning.as_deref(),
            ))
        }

        Some(LocalPanel::UpdatePicker(picker)) => Some(build_update_picker_view(picker)),
        Some(LocalPanel::ShellRulePicker(picker)) => Some(build_shell_rule_picker_view(picker)),
        Some(LocalPanel::LaneActionPicker(picker)) => Some(build_lane_action_picker_view(picker)),
        None => build_queue_panel_view(app)
            .or_else(|| build_command_panel_view(app))
            .or_else(|| build_skill_suggestion_panel_view(app))
            .or_else(|| build_attachment_panel_view(app)),
    }
}

// Focus owns the input area. Even a one-row terminal shows the current item.
pub(super) fn focused_queue_lines(
    app: &AppState,
    width: u16,
    height: u16,
) -> Option<Vec<ratatui::text::Line<'static>>> {
    if !app.queue_picker_focused() {
        return None;
    }
    let mut view = build_panel_view(app)?;
    if height == 1 {
        view.title = None;
    }
    Some(build_panel_render(&view, height, usize::from(width)))
}
