use crate::app::state::{LogKind, LogSpan, LogTone};
use ratatui::style::{Color, Modifier, Style};
use std::sync::OnceLock;

use super::constants::INPUT_BG;

const CODE_BLOCK_BG: Color = Color::Rgb(24, 30, 36);
const DIFF_ADDED_BG: Color = Color::Rgb(21, 45, 33);
const DIFF_REMOVED_BG: Color = Color::Rgb(53, 28, 31);

static TRUECOLOR_SUPPORT: OnceLock<bool> = OnceLock::new();

fn supports_truecolor() -> bool {
    if std::env::var("CODELIA_FORCE_ANSI_SYNTAX").ok().as_deref() == Some("1") {
        return false;
    }
    *TRUECOLOR_SUPPORT.get_or_init(|| {
        let colorterm = std::env::var("COLORTERM")
            .unwrap_or_default()
            .to_ascii_lowercase();
        if colorterm.contains("truecolor") || colorterm.contains("24bit") {
            return true;
        }
        let term = std::env::var("TERM")
            .unwrap_or_default()
            .to_ascii_lowercase();
        term.contains("direct") || term.contains("truecolor")
    })
}

fn to_indexed_component(value: u8) -> u8 {
    ((value as u16 * 5 + 127) / 255) as u8
}

fn xterm_level(component: u8) -> u8 {
    match component {
        0 => 0,
        1 => 95,
        2 => 135,
        3 => 175,
        4 => 215,
        _ => 255,
    }
}

fn nearest_xterm_256(r: u8, g: u8, b: u8) -> u8 {
    let ri = to_indexed_component(r);
    let gi = to_indexed_component(g);
    let bi = to_indexed_component(b);
    let cube_index = 16 + 36 * ri + 6 * gi + bi;

    let cr = xterm_level(ri) as i32;
    let cg = xterm_level(gi) as i32;
    let cb = xterm_level(bi) as i32;
    let dr = r as i32 - cr;
    let dg = g as i32 - cg;
    let db = b as i32 - cb;
    let cube_dist = dr * dr + dg * dg + db * db;

    let avg = (r as u16 + g as u16 + b as u16) / 3;
    let gray_step = (((avg as i32 - 8) + 5) / 10).clamp(0, 23) as u8;
    let gray_level = (8 + gray_step as i32 * 10) as i32;
    let gr = r as i32 - gray_level;
    let gg = g as i32 - gray_level;
    let gb = b as i32 - gray_level;
    let gray_dist = gr * gr + gg * gg + gb * gb;
    let gray_index = 232 + gray_step;

    if gray_dist < cube_dist {
        gray_index
    } else {
        cube_index
    }
}

fn syntax_color(r: u8, g: u8, b: u8) -> Color {
    if supports_truecolor() {
        Color::Rgb(r, g, b)
    } else {
        Color::Indexed(nearest_xterm_256(r, g, b))
    }
}

pub(super) fn style_for(span: &LogSpan) -> Style {
    let mut style = style_for_kind(span.kind, span.tone);
    if let Some(fg) = span.fg {
        style = style.fg(syntax_color(fg.r, fg.g, fg.b));
    }
    style
}

fn style_for_kind(kind: LogKind, tone: LogTone) -> Style {
    let (summary, detail) = match kind {
        LogKind::System => (
            Style::default().fg(Color::Cyan),
            Style::default().fg(Color::Cyan).add_modifier(Modifier::DIM),
        ),
        LogKind::User => (
            Style::default().fg(Color::White).bg(INPUT_BG),
            Style::default().fg(Color::White).bg(INPUT_BG),
        ),
        LogKind::Assistant => (
            Style::default().fg(Color::White),
            Style::default().fg(Color::White),
        ),
        LogKind::AssistantCode => (
            Style::default().fg(Color::White).bg(CODE_BLOCK_BG),
            Style::default()
                .fg(Color::White)
                .bg(CODE_BLOCK_BG)
                .add_modifier(Modifier::DIM),
        ),
        LogKind::Reasoning => (
            Style::default()
                .fg(Color::Gray)
                .add_modifier(Modifier::ITALIC),
            Style::default()
                .fg(Color::Gray)
                .add_modifier(Modifier::ITALIC)
                .add_modifier(Modifier::DIM),
        ),
        LogKind::ToolCall => (
            Style::default().fg(Color::LightBlue),
            Style::default().fg(Color::White),
        ),
        LogKind::ToolResult => (
            Style::default().fg(Color::Green),
            Style::default()
                .fg(Color::Green)
                .add_modifier(Modifier::DIM),
        ),
        LogKind::DiffMeta => (
            Style::default().fg(Color::DarkGray),
            Style::default().fg(Color::DarkGray),
        ),
        LogKind::DiffContext => (
            Style::default().fg(Color::Gray),
            Style::default().fg(Color::Gray),
        ),
        LogKind::DiffAdded => (
            Style::default().fg(Color::White).bg(DIFF_ADDED_BG),
            Style::default().fg(Color::White).bg(DIFF_ADDED_BG),
        ),
        LogKind::DiffRemoved => (
            Style::default().fg(Color::White).bg(DIFF_REMOVED_BG),
            Style::default().fg(Color::White).bg(DIFF_REMOVED_BG),
        ),
        LogKind::Status => (
            Style::default().fg(Color::Blue),
            Style::default().fg(Color::Blue),
        ),
        LogKind::Rpc => (
            Style::default().add_modifier(Modifier::DIM),
            Style::default().add_modifier(Modifier::DIM),
        ),
        LogKind::Runtime => (
            Style::default().add_modifier(Modifier::DIM),
            Style::default().add_modifier(Modifier::DIM),
        ),
        LogKind::Space => (
            Style::default().fg(Color::Black),
            Style::default().fg(Color::Black),
        ),
        LogKind::Error => (
            Style::default().fg(Color::Red).add_modifier(Modifier::BOLD),
            Style::default()
                .fg(Color::Red)
                .add_modifier(Modifier::BOLD)
                .add_modifier(Modifier::DIM),
        ),
    };

    match tone {
        LogTone::Summary => summary,
        LogTone::Detail => detail,
    }
}

#[cfg(test)]
mod tests {
    use super::{
        nearest_xterm_256, style_for, syntax_color, CODE_BLOCK_BG, DIFF_ADDED_BG, DIFF_REMOVED_BG,
    };
    use crate::app::state::{LogColor, LogKind, LogSpan, LogTone};
    use ratatui::style::Color;

    #[test]
    fn diff_styles_use_background_emphasis() {
        let added = style_for(&LogSpan::new(LogKind::DiffAdded, LogTone::Detail, "+line"));
        let removed = style_for(&LogSpan::new(
            LogKind::DiffRemoved,
            LogTone::Detail,
            "-line",
        ));

        assert_eq!(added.bg, Some(DIFF_ADDED_BG));
        assert_eq!(removed.bg, Some(DIFF_REMOVED_BG));
    }

    #[test]
    fn assistant_code_style_keeps_block_background_with_token_foreground_override() {
        let span = LogSpan::new_with_fg(
            LogKind::AssistantCode,
            LogTone::Detail,
            "fn",
            Some(LogColor::rgb(1, 2, 3)),
        );
        let style = style_for(&span);

        assert_eq!(style.bg, Some(CODE_BLOCK_BG));
        assert_eq!(style.fg, Some(Color::Rgb(1, 2, 3)));
    }

    #[test]
    fn diff_code_overlay_keeps_diff_background_while_overriding_foreground() {
        let added = style_for(&LogSpan::new_with_fg(
            LogKind::DiffAdded,
            LogTone::Detail,
            "const",
            Some(LogColor::rgb(7, 8, 9)),
        ));
        let removed = style_for(&LogSpan::new_with_fg(
            LogKind::DiffRemoved,
            LogTone::Detail,
            "const",
            Some(LogColor::rgb(9, 8, 7)),
        ));

        assert_eq!(added.bg, Some(DIFF_ADDED_BG));
        assert_eq!(removed.bg, Some(DIFF_REMOVED_BG));
        assert!(matches!(
            added.fg,
            Some(Color::Rgb(7, 8, 9)) | Some(Color::Indexed(_))
        ));
        assert!(matches!(
            removed.fg,
            Some(Color::Rgb(9, 8, 7)) | Some(Color::Indexed(_))
        ));
    }

    #[test]
    fn nearest_xterm_256_returns_valid_palette_index() {
        let idx = nearest_xterm_256(191, 97, 106);
        assert!((16..=255).contains(&idx));
    }

    #[test]
    fn syntax_color_respects_force_ansi_override() {
        std::env::set_var("CODELIA_FORCE_ANSI_SYNTAX", "1");
        let color = syntax_color(120, 130, 140);
        assert!(matches!(color, Color::Indexed(_)));
    }
}
