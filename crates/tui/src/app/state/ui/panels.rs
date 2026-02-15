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
