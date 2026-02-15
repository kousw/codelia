pub struct ConfirmDialogState {
    pub id: String,
    pub title: String,
    pub message: String,
    pub danger_level: Option<String>,
    pub confirm_label: String,
    pub cancel_label: String,
    pub allow_remember: bool,
    pub allow_reason: bool,
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
    pub items: Vec<PickDialogItem>,
    pub selected: usize,
    pub multi: bool,
    pub chosen: Vec<bool>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ConfirmMode {
    Select,
    Reason,
}
