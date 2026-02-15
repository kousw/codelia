use crate::app::state::{LogKind, LogSpan, LogTone};
use ratatui::style::{Color, Modifier, Style};

use super::constants::INPUT_BG;

const CODE_BLOCK_BG: Color = Color::Rgb(24, 30, 36);
const DIFF_ADDED_BG: Color = Color::Rgb(21, 45, 33);
const DIFF_REMOVED_BG: Color = Color::Rgb(53, 28, 31);

pub(super) fn style_for(span: &LogSpan) -> Style {
    let mut style = style_for_kind(span.kind, span.tone);
    if let Some(fg) = span.fg {
        style = style.fg(Color::Rgb(fg.r, fg.g, fg.b));
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
            Style::default().fg(Color::LightGreen).bg(CODE_BLOCK_BG),
            Style::default()
                .fg(Color::LightGreen)
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
            Style::default().fg(Color::Green).bg(DIFF_ADDED_BG),
            Style::default().fg(Color::Green).bg(DIFF_ADDED_BG),
        ),
        LogKind::DiffRemoved => (
            Style::default().fg(Color::Red).bg(DIFF_REMOVED_BG),
            Style::default().fg(Color::Red).bg(DIFF_REMOVED_BG),
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
    use super::{style_for, CODE_BLOCK_BG, DIFF_ADDED_BG, DIFF_REMOVED_BG};
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
}
