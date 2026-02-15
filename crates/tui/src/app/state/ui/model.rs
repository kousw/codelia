pub struct ModelPickerState {
    pub models: Vec<String>,
    pub selected: usize,
}

#[derive(Debug, Clone, Copy)]
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

pub enum ModelListSubmitAction {
    ModelSet,
    UiPick {
        request_id: String,
        item_ids: Vec<String>,
    },
}

pub struct ProviderPickerState {
    pub providers: Vec<String>,
    pub selected: usize,
    pub mode: ModelListMode,
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
