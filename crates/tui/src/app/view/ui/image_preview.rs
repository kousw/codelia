use crate::app::{image_preview::PreviewMode, AppState};
use ratatui::{
    layout::{Margin, Rect, Size},
    style::{Color, Style},
    widgets::{Block, Clear, Paragraph},
    Frame,
};

pub(super) fn draw(frame: &mut Frame<'_>, app: &mut AppState) {
    if app.has_interaction_panel() {
        return;
    }
    let Some(mode) = app.image_preview.mode else {
        return;
    };
    let area = frame.area();
    app.render_state.cursor_phase = crate::app::CursorPhase::VisibleAtImagePreview;
    app.image_preview.desired_size = Size::default();
    if area.width < 24 || area.height < 10 {
        frame.render_widget(Clear, area);
        frame.render_widget(
            Paragraph::new("Image preview needs 24 x 10 cells. Esc: close"),
            area,
        );
        frame.set_cursor_position((area.x, area.y));
        return;
    }
    let (width, height) = match mode {
        PreviewMode::Small => (
            area.width.saturating_sub(2).min(52),
            area.height.saturating_sub(2).min(17),
        ),
        PreviewMode::Modal => (
            area.width.saturating_sub(2).min(100),
            area.height.saturating_sub(2).min(40),
        ),
    };
    let x = match mode {
        PreviewMode::Small => area.right() - width - 1,
        PreviewMode::Modal => area.x + (area.width - width) / 2,
    };
    let panel = Rect::new(x, area.y + (area.height - height) / 2, width, height);
    let block = Block::bordered()
        .title(format!(" Image preview - {mode:?} "))
        .title_bottom(" Enter: size | Esc: back/close | q: close ")
        .style(Style::default().fg(Color::White).bg(Color::Black));
    let inner = block.inner(panel).inner(Margin::new(1, 0));
    frame.render_widget(Clear, panel);
    frame.render_widget(block, panel);
    frame.render_widget(
        Paragraph::new(app.image_preview.label.as_str()),
        Rect::new(inner.x, inner.y, inner.width, 1),
    );
    frame.render_widget(
        Paragraph::new(app.image_preview.details.as_str()),
        Rect::new(inner.x, inner.y + 1, inner.width, 1),
    );
    frame.render_widget(
        Paragraph::new(app.image_preview.policy.label.as_str())
            .style(Style::default().fg(Color::Cyan)),
        Rect::new(inner.x, inner.y + 2, inner.width, 1),
    );
    let image_area = Rect::new(
        inner.x,
        inner.y + 3,
        inner.width,
        inner.height.saturating_sub(3),
    );
    if let Some(error) = &app.image_preview.error {
        frame.render_widget(
            Paragraph::new(format!(
                "Cannot preview: {error}\nEsc: close; /image to retry"
            ))
            .wrap(ratatui::widgets::Wrap { trim: false }),
            image_area,
        );
    } else if !app
        .image_preview
        .render_image(image_area, frame.buffer_mut())
    {
        frame.render_widget(Paragraph::new("Preparing image..."), image_area);
    }
    // Keep keyboard focus visibly on the preview, not the covered composer.
    frame.set_cursor_position((panel.x + 1, panel.bottom() - 1));
}
