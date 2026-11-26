use super::dialogs::{RuntimeDialogRef, RuntimeDialogs};
use super::{
    ContextPanelState, LaneListPanelState, ModelListPanelState, ModelListSubmitAction,
    ModelPickerState, ProviderPickerState, ReasoningPickerState, SessionListPanelState,
    SkillsListPanelState, ThemeListPanelState,
};

pub struct QueueSteerPicker {
    pub run_id: String,
    pub queue_id: String,
}

pub enum LocalPanel {
    SessionList(SessionListPanelState),
    LaneList(LaneListPanelState),
    Context(ContextPanelState),
    SkillsList(SkillsListPanelState),
    ThemeList(ThemeListPanelState),
    ModelList(ModelListPanelState),
    ProviderPicker(ProviderPickerState),
    ModelPicker(ModelPickerState),
    ReasoningPicker(ReasoningPickerState),
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum PasteTarget {
    Blocked,
    RuntimePrompt,
    Composer,
}

#[derive(Default)]
pub struct OverlayState {
    pub runtime_dialogs: RuntimeDialogs,
    pub local_panel: Option<LocalPanel>,
    pub queue_focus: Option<QueueSteerPicker>,
}

impl OverlayState {
    pub fn has_modal_or_panel(&self) -> bool {
        self.runtime_dialogs.is_any_open() || self.local_panel.is_some()
    }

    pub fn has_onboarding_model_pick(&self) -> bool {
        matches!(
            &self.local_panel,
            Some(LocalPanel::ModelList(panel))
                if matches!(panel.submit_action, ModelListSubmitAction::UiPick { .. })
        )
    }

    pub fn paste_target(&self, image_preview_open: bool, startup_pending: bool) -> PasteTarget {
        if image_preview_open {
            return PasteTarget::Blocked;
        }
        match self.runtime_dialogs.top() {
            Some(RuntimeDialogRef::Prompt(_)) => PasteTarget::RuntimePrompt,
            Some(_) => PasteTarget::Blocked,
            None if startup_pending || self.local_panel.is_some() || self.queue_focus.is_some() => {
                PasteTarget::Blocked
            }
            None => PasteTarget::Composer,
        }
    }
}
