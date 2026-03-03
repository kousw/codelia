use crate::app::util::text::char_width;

pub(super) fn visual_width(text: &str) -> usize {
    text.chars().map(char_width).sum()
}

pub(super) fn truncate_to_width(text: &str, width: usize) -> String {
    if visual_width(text) <= width {
        return text.to_string();
    }
    if width == 0 {
        return String::new();
    }
    if width <= 3 {
        return ".".repeat(width);
    }

    let target = width - 3;
    let mut out = String::new();
    let mut used = 0;
    for ch in text.chars() {
        let w = char_width(ch);
        if used + w > target {
            break;
        }
        out.push(ch);
        used += w;
    }
    out.push_str("...");
    out
}
