pub struct SessionListPanelState {
    pub title: String,
    pub header: String,
    pub rows: Vec<String>,
    pub session_ids: Vec<String>,
    pub selected: usize,
}

pub struct ContextPanelState {
    pub title: String,
    pub header: String,
    pub rows: Vec<String>,
    pub selected: usize,
}

#[derive(Clone)]
pub struct LaneListItem {
    pub lane_id: String,
}

pub struct LaneListPanelState {
    pub title: String,
    pub header: String,
    pub rows: Vec<String>,
    pub lanes: Vec<LaneListItem>,
    pub selected: usize,
}

pub struct ThemeListPanelState {
    pub title: String,
    pub header: String,
    pub rows: Vec<String>,
    pub theme_ids: Vec<String>,
    pub selected: usize,
}
