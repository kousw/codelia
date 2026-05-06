pub struct ModelPickerState {
    pub models: Vec<String>,
    pub selected: usize,
}

pub struct ReasoningPickerState {
    pub provider: Option<String>,
    pub model: String,
    pub scope: ModelSetScope,
    pub levels: Vec<String>,
    pub selected: usize,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ModelListMode {
    Picker,
    List,
    Silent,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ModelListViewMode {
    Limits,
    Cost,
}

impl ModelListViewMode {
    pub fn toggle(self) -> Self {
        match self {
            ModelListViewMode::Limits => ModelListViewMode::Cost,
            ModelListViewMode::Cost => ModelListViewMode::Limits,
        }
    }

    pub fn label(self) -> &'static str {
        match self {
            ModelListViewMode::Limits => "limits",
            ModelListViewMode::Cost => "cost",
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ModelSetScope {
    Config,
    Session,
}

impl ModelSetScope {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Config => "config",
            Self::Session => "session",
        }
    }
}

pub enum ModelListSubmitAction {
    ModelSet {
        scope: ModelSetScope,
    },
    UiPick {
        request_id: String,
        item_ids: Vec<String>,
    },
}

pub struct ProviderPickerState {
    pub providers: Vec<String>,
    pub selected: usize,
    pub mode: ModelListMode,
    pub scope: ModelSetScope,
}

pub struct ModelListPanelState {
    pub title: String,
    pub header_limits: String,
    pub rows_limits: Vec<String>,
    pub header_cost: String,
    pub rows_cost: Vec<String>,
    pub model_ids: Vec<String>,
    pub selected: usize,
    pub view_mode: ModelListViewMode,
    pub submit_action: ModelListSubmitAction,
}
