use super::dialogs::{PickDialogItem, RuntimeDialogKind, RuntimeDialogs};
use super::{
    ContextPanelState, LaneListPanelState, ModelListPanelState, ModelPickerState, ModelSetScope,
    ProviderPickerState, ReasoningPickerState, SessionListPanelState, SkillsListPanelState,
    ThemeListPanelState,
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
    ModelList {
        panel: ModelListPanelState,
        scope: ModelSetScope,
    },
    ProviderPicker(ProviderPickerState),
    ModelPicker(ModelPickerState),
    ReasoningPicker(ReasoningPickerState),
    UpdatePicker(UpdatePickerState),
    ShellRulePicker(ShellRulePickerState),
    LaneActionPicker(LaneActionPickerState),
}

impl LocalPanel {
    /// Local pickers with explicit confirmation flows that client tools must not
    /// silently clobber or open choices over.
    pub fn blocks_client_tool_panel(&self) -> bool {
        matches!(self, Self::UpdatePicker(_) | Self::ShellRulePicker(_))
    }
}

pub struct LaneActionPickerState {
    pub lane_id: String,
    pub title: String,
    pub items: Vec<PickDialogItem>,
    pub selected: usize,
}

pub struct UpdatePickerState {
    pub id: String,
    pub title: String,
    pub message: Option<String>,
    pub items: Vec<PickDialogItem>,
    pub selected: usize,
    pub startup: bool,
}

pub struct ShellRulePickerState {
    pub title: String,
    pub message: Option<String>,
    pub items: Vec<PickDialogItem>,
    pub selected: usize,
    pub kind: ShellRulePicker,
    pub review_offset: Option<usize>,
}

pub enum ShellRulePicker {
    Trust {
        trusted: bool,
        workspace: String,
        revision: String,
        session_id: Option<String>,
    },
    Choose {
        session_id: Option<String>,
    },
    Confirm {
        session_id: Option<String>,
    },
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

    pub fn paste_target(&self, image_preview_open: bool, startup_pending: bool) -> PasteTarget {
        if image_preview_open {
            return PasteTarget::Blocked;
        }
        match self.runtime_dialogs.top() {
            Some(RuntimeDialogKind::Prompt) => PasteTarget::RuntimePrompt,
            Some(_) => PasteTarget::Blocked,
            None if startup_pending || self.local_panel.is_some() || self.queue_focus.is_some() => {
                PasteTarget::Blocked
            }
            None => PasteTarget::Composer,
        }
    }
}
