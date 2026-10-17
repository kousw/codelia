use crossterm::event::{KeyCode, KeyEvent, KeyEventKind, KeyModifiers};
use ratatui::{
    layout::{Margin, Rect},
    style::{Color, Style},
    text::Line,
    widgets::{Block, Clear, Paragraph},
    Frame,
};
use ratatui_image::{thread::ThreadProtocol, StatefulImage};

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(super) enum Mode {
    Small,
    Modal,
    Hidden,
}

pub(super) struct Preview {
    pub image: ThreadProtocol,
    pub mode: Mode,
    label: String,
    protocol: String,
    note: String,
}

impl Preview {
    pub fn new(label: String, protocol: String, note: String, image: ThreadProtocol) -> Self {
        Self {
            image,
            mode: Mode::Small,
            label,
            protocol,
            note,
        }
    }

    /// Returns true only for explicit quit keys; closing a modal keeps the lab open.
    pub fn handle_key(&mut self, key: KeyEvent) -> bool {
        if key.kind != KeyEventKind::Press {
            return false;
        }
        if key.code == KeyCode::Char('c') && key.modifiers.contains(KeyModifiers::CONTROL) {
            return true;
        }
        if !key.modifiers.is_empty() {
            return false;
        }
        match key.code {
            KeyCode::Char('q') => return true,
            KeyCode::Enter | KeyCode::Char(' ') => {
                self.mode = if self.mode == Mode::Modal {
                    Mode::Small
                } else {
                    Mode::Modal
                };
            }
            KeyCode::Esc => {
                self.mode = if self.mode == Mode::Modal {
                    Mode::Small
                } else {
                    Mode::Hidden
                };
            }
            KeyCode::Char('v') => {
                self.mode = if self.mode == Mode::Hidden {
                    Mode::Small
                } else {
                    Mode::Hidden
                };
            }
            _ => {}
        }
        false
    }
}

pub(super) fn preview_area(area: Rect, mode: Mode) -> Option<Rect> {
    if mode == Mode::Hidden || area.width < 24 || area.height < 10 {
        return None;
    }
    let (width, height, x, y) = match mode {
        Mode::Small => {
            let width = 36.min(area.width.saturating_sub(4));
            let height = 12.min(area.height.saturating_sub(7));
            (width, height, area.right() - width - 2, area.y + 5)
        }
        Mode::Modal => {
            let width = (u32::from(area.width) * 4 / 5).min(110) as u16;
            let height = (u32::from(area.height) * 4 / 5).min(40) as u16;
            (
                width,
                height,
                area.x + (area.width - width) / 2,
                area.y + (area.height - height) / 2,
            )
        }
        Mode::Hidden => return None,
    };
    Some(Rect::new(x, y, width, height))
}

pub(super) fn draw(frame: &mut Frame<'_>, app: &mut Preview) {
    let area = frame.area();
    // This is an alternate-screen rendering lab, not the production scrollback.
    frame.render_widget(
        Block::new().style(Style::default().fg(Color::White).bg(Color::Black)),
        area,
    );
    let lines = vec![
        Line::from("Codelia image preview lab - no runtime / API / uploads"),
        Line::from(format!("Protocol: {} | View: {:?}", app.protocol, app.mode)),
        Line::from(app.label.as_str()),
        Line::from(app.note.as_str()),
        Line::from(""),
        Line::from("Sample conversation background"),
        Line::from("A small panel can sit beside text."),
        Line::from("Enter opens a larger centered overlay."),
        Line::from("The overlay is inside this terminal,"),
        Line::from("not a separate OS window."),
        Line::from(""),
        Line::from("Toggle and resize to check stale pixels."),
        Line::from("Native terminal scrollback is not tested here."),
    ];
    frame.render_widget(Paragraph::new(lines), area.inner(Margin::new(1, 0)));
    if area.height > 0 {
        frame.render_widget(
            Paragraph::new("Enter/Space: small/modal | Esc: close/hide | v: visibility | q: quit")
                .style(Style::default().fg(Color::Cyan).bg(Color::Black)),
            Rect::new(area.x, area.bottom() - 1, area.width, 1),
        );
    }
    let Some(panel) = preview_area(area, app.mode) else {
        if app.mode != Mode::Hidden && area.height > 4 {
            frame.render_widget(
                Paragraph::new("Preview needs at least 24 x 10 cells"),
                Rect::new(area.x, area.y + 4, area.width, 1),
            );
        }
        return;
    };
    let title = if app.mode == Mode::Modal {
        " Image preview - Modal "
    } else {
        " Image preview - Small "
    };
    let block = Block::bordered()
        .title(title)
        .style(Style::default().fg(Color::Cyan).bg(Color::Black));
    let image_area = block.inner(panel);
    frame.render_widget(Clear, panel);
    frame.render_widget(block, panel);
    if app.image.protocol_type().is_none() {
        frame.render_widget(
            Paragraph::new("Preparing image...").style(Style::default().fg(Color::Gray)),
            image_area,
        );
    }
    frame.render_stateful_widget(StatefulImage::new(), image_area, &mut app.image);
}
