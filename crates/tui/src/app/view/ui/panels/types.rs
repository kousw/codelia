pub(in crate::app::view::ui) struct PanelView {
    pub(super) title: Option<String>,
    pub(super) lines: Vec<String>,
    pub(super) header_index: Option<usize>,
    pub(super) selected: Option<usize>,
    pub(super) wrap_lines: bool,
    pub(super) tail_pinned_from: Option<usize>,
}
