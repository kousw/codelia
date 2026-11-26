use super::super::input::InputState;
use super::model::ModelListPanelState;

pub enum ConfirmSlot {
    Pending(ConfirmDialogState),
    Active {
        state: ConfirmDialogState,
        input: InputState,
    },
}

pub struct PromptSlot {
    pub state: PromptDialogState,
    pub input: InputState,
}

pub enum RuntimeDialogRef<'a> {
    Confirm(&'a ConfirmSlot),
    Prompt(&'a PromptSlot),
    Pick(&'a RuntimePickDialog),
}

/// Independent slots keep lower-priority dialogs alive while another owns focus.
#[derive(Default)]
pub struct RuntimeDialogs {
    pub confirm: Option<ConfirmSlot>,
    pub prompt: Option<PromptSlot>,
    pub pick: Option<RuntimePickDialog>,
}

impl RuntimeDialogs {
    /// Highest-priority dialog for input routing and safety guards (`confirm > prompt > pick`),
    /// including `ConfirmSlot::Pending` so keys are swallowed before its first visible frame.
    pub fn top(&self) -> Option<RuntimeDialogRef<'_>> {
        if let Some(confirm) = &self.confirm {
            Some(RuntimeDialogRef::Confirm(confirm))
        } else if let Some(prompt) = &self.prompt {
            Some(RuntimeDialogRef::Prompt(prompt))
        } else {
            self.pick.as_ref().map(RuntimeDialogRef::Pick)
        }
    }

    /// Highest-priority visible dialog for rendering (`active confirm > prompt > pick`).
    /// Skips `ConfirmSlot::Pending` so the pre-activation sync frame preserves the previous
    /// layout height and underlying dialog until the confirm panel is shown on the next frame.
    pub fn visible_top(&self) -> Option<RuntimeDialogRef<'_>> {
        if let Some(confirm @ ConfirmSlot::Active { .. }) = &self.confirm {
            Some(RuntimeDialogRef::Confirm(confirm))
        } else if let Some(prompt) = &self.prompt {
            Some(RuntimeDialogRef::Prompt(prompt))
        } else {
            self.pick.as_ref().map(RuntimeDialogRef::Pick)
        }
    }

    pub fn is_any_open(&self) -> bool {
        self.top().is_some()
    }

    pub fn activate_pending_confirm(&mut self) -> bool {
        match self.confirm.take() {
            Some(ConfirmSlot::Pending(state)) => {
                self.confirm = Some(ConfirmSlot::Active {
                    state,
                    input: InputState::default(),
                });
                true
            }
            other => {
                self.confirm = other;
                false
            }
        }
    }

    pub fn active_confirm(&self) -> Option<(&ConfirmDialogState, &InputState)> {
        match self.confirm.as_ref()? {
            ConfirmSlot::Active { state, input } => Some((state, input)),
            ConfirmSlot::Pending(_) => None,
        }
    }

    pub fn active_confirm_mut(&mut self) -> Option<(&mut ConfirmDialogState, &mut InputState)> {
        match self.confirm.as_mut()? {
            ConfirmSlot::Active { state, input } => Some((state, input)),
            ConfirmSlot::Pending(_) => None,
        }
    }

    pub fn is_confirm_pending(&self) -> bool {
        matches!(self.confirm, Some(ConfirmSlot::Pending(_)))
    }
}

pub struct ConfirmDialogState {
    pub id: String,
    pub title: String,
    pub message: String,
    pub danger_level: Option<String>,
    pub confirm_label: String,
    pub cancel_label: String,
    pub allow_remember: bool,
    pub allow_reason: bool,
    pub command_view: bool,
    pub selected: usize,
    pub mode: ConfirmMode,
}

pub struct PromptDialogState {
    pub id: String,
    pub title: String,
    pub message: String,
    pub multiline: bool,
    pub secret: bool,
}

pub struct PickDialogItem {
    pub id: String,
    pub label: String,
    pub detail: Option<String>,
}

pub enum RuntimePickListKind {
    Standard,
    Approval { review_offset: Option<usize> },
    ClientToolChoice,
}

pub struct RuntimePickList {
    pub id: String,
    pub title: String,
    pub message: Option<String>,
    pub items: Vec<PickDialogItem>,
    pub selected: usize,
    pub multi: bool,
    pub chosen: Vec<bool>,
    pub kind: RuntimePickListKind,
}

pub enum RuntimePickDialog {
    List(RuntimePickList),
    OnboardingModelList {
        request_id: String,
        panel: Box<ModelListPanelState>,
    },
}

impl RuntimePickDialog {
    pub fn id(&self) -> &str {
        match self {
            Self::List(list) => &list.id,
            Self::OnboardingModelList { request_id, .. } => request_id,
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ConfirmMode {
    Select,
    Reason,
}
