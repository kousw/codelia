use crate::app::state::{LogKind, LogTone};
use ratatui::style::{Color, Modifier, Style};

use super::constants::INPUT_BG;

pub(super) fn style_for(kind: LogKind, tone: LogTone) -> Style {
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
            Style::default().fg(Color::LightGreen),
            Style::default()
                .fg(Color::LightGreen)
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
            Style::default().fg(Color::Green),
            Style::default().fg(Color::Green),
        ),
        LogKind::DiffRemoved => (
            Style::default().fg(Color::Red),
            Style::default().fg(Color::Red),
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
