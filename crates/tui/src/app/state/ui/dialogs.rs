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

pub struct PickDialogState {
    pub id: String,
    pub title: String,
    pub message: Option<String>,
    pub items: Vec<PickDialogItem>,
    pub selected: usize,
    pub multi: bool,
    pub chosen: Vec<bool>,
    pub approval: bool,
    pub review_offset: Option<usize>,
    pub shell_rule_picker: Option<ShellRulePicker>,
    pub(crate) local_update_picker: bool,
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
pub enum ConfirmMode {
    Select,
    Reason,
}
