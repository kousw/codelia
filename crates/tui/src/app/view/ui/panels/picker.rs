use super::types::PanelView;

pub(super) fn build_picker_panel_view(
    title: String,
    items: &[String],
    selected: usize,
    current: Option<&str>,
) -> PanelView {
    let mut lines = Vec::with_capacity(items.len());
    for item in items {
        let is_current = current == Some(item.as_str());
        let current_marker = if is_current { "*" } else { " " };
        lines.push(format!("{current_marker} {item}"));
    }
    PanelView {
        title: Some(title),
        lines,
        header_index: None,
        selected: Some(selected),
        wrap_lines: true,
        tail_pinned_from: None,
    }
}
