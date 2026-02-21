use crate::app::render::insert_history::insert_history_lines;
use crate::app::view::wrapped_log_range_to_lines;
use crate::app::{AppState, CursorPhase, SyncPhase};
use ratatui::backend::Backend;
use ratatui::layout::{Position, Rect, Size};
use std::io::Write;

pub fn compute_inline_area<B: Backend>(
    backend: &mut B,
    height: u16,
    size: Size,
) -> std::io::Result<(Rect, Position)> {
    let max_height = size.height.min(height);
    let max_row = size.height.saturating_sub(max_height);
    let initial_cursor = backend.get_cursor_position()?;

    let lines_after_cursor = height.saturating_sub(1);
    backend.append_lines(lines_after_cursor)?;
    // Re-read after append_lines so the terminal state and bookkeeping stay aligned.
    let pos = backend.get_cursor_position()?;
    // Keep startup anchored at the current cursor row. Overflow insertion will
    // gradually move the viewport down and eventually settle at the bottom.
    let row = initial_cursor.y.min(max_row);

    Ok((
        Rect {
            x: 0,
            y: row,
            width: size.width,
            height: max_height,
        },
        pos,
    ))
}

#[derive(Default)]
pub struct TerminalEffects {
    pub request_redraw: bool,
}

pub fn apply_terminal_effects<B>(
    terminal: &mut crate::app::render::custom_terminal::Terminal<B>,
    app: &mut AppState,
    log_changed_since_draw: bool,
) -> std::io::Result<TerminalEffects>
where
    B: Backend + Write,
{
    if log_changed_since_draw {
        app.request_scrollback_sync();
    }

    if app.scroll_from_bottom > 0 {
        app.assert_render_invariants();
        return Ok(TerminalEffects::default());
    }

    match app.render_state.sync_phase {
        SyncPhase::Idle => {
            app.assert_render_invariants();
            return Ok(TerminalEffects::default());
        }
        SyncPhase::InsertedNeedsRedraw => {
            app.render_state.sync_phase = SyncPhase::Idle;
            app.render_state.cursor_phase = CursorPhase::VisibleAtComposer;
            app.assert_render_invariants();
            return Ok(TerminalEffects::default());
        }
        SyncPhase::NeedsInsert => {}
    }

    let overflow = app
        .render_state
        .visible_start
        .min(app.render_state.wrapped_total);

    if overflow <= app.render_state.inserted_until {
        app.render_state.sync_phase = SyncPhase::Idle;
        app.assert_render_invariants();
        return Ok(TerminalEffects::default());
    }

    let start = app.render_state.inserted_until.min(overflow);
    if start >= overflow {
        app.render_state.inserted_until = overflow;
        app.render_state.sync_phase = SyncPhase::Idle;
        app.assert_render_invariants();
        return Ok(TerminalEffects::default());
    }

    let log_width = terminal.viewport_area.width as usize;
    let lines = wrapped_log_range_to_lines(app, log_width, start, overflow);
    if lines.is_empty() {
        app.render_state.inserted_until = overflow;
        app.render_state.sync_phase = SyncPhase::Idle;
        app.assert_render_invariants();
        return Ok(TerminalEffects::default());
    }
    app.render_state.cursor_phase = CursorPhase::HiddenDuringScrollbackInsert;
    terminal.hide_cursor()?;
    let max_lines_per_insert = {
        let width = terminal.viewport_area.width.max(1);
        let max_lines = u16::MAX / width;
        usize::from(max_lines.max(1))
    };
    for chunk in lines.chunks(max_lines_per_insert) {
        insert_history_lines(terminal, chunk.to_vec())?;
    }
    app.render_state.inserted_until = overflow;
    app.render_state.sync_phase = SyncPhase::InsertedNeedsRedraw;
    app.assert_render_invariants();
    Ok(TerminalEffects {
        request_redraw: true,
    })
}

#[cfg(test)]
mod tests {
    use super::compute_inline_area;
    use ratatui::backend::{Backend, ClearType, WindowSize};
    use ratatui::buffer::Cell;
    use ratatui::layout::{Position, Rect, Size};
    use std::io;

    #[derive(Debug)]
    struct InlineBackendMock {
        size: Size,
        cursor: Position,
    }

    impl InlineBackendMock {
        fn new(width: u16, height: u16, cursor: Position) -> Self {
            Self {
                size: Size::new(width, height),
                cursor,
            }
        }
    }

    impl Backend for InlineBackendMock {
        fn draw<'a, I>(&mut self, _content: I) -> io::Result<()>
        where
            I: Iterator<Item = (u16, u16, &'a Cell)>,
        {
            Ok(())
        }

        fn append_lines(&mut self, n: u16) -> io::Result<()> {
            let max_y = self.size.height.saturating_sub(1);
            self.cursor.y = self.cursor.y.saturating_add(n).min(max_y);
            Ok(())
        }

        fn hide_cursor(&mut self) -> io::Result<()> {
            Ok(())
        }

        fn show_cursor(&mut self) -> io::Result<()> {
            Ok(())
        }

        fn get_cursor_position(&mut self) -> io::Result<Position> {
            Ok(self.cursor)
        }

        fn set_cursor_position<P: Into<Position>>(&mut self, position: P) -> io::Result<()> {
            self.cursor = position.into();
            Ok(())
        }

        fn clear(&mut self) -> io::Result<()> {
            Ok(())
        }

        fn clear_region(&mut self, _clear_type: ClearType) -> io::Result<()> {
            Ok(())
        }

        fn size(&self) -> io::Result<Size> {
            Ok(self.size)
        }

        fn window_size(&mut self) -> io::Result<WindowSize> {
            Ok(WindowSize {
                columns_rows: self.size,
                pixels: Size::new(0, 0),
            })
        }

        fn flush(&mut self) -> io::Result<()> {
            Ok(())
        }
    }

    #[test]
    fn compute_inline_area_anchors_to_initial_cursor_row() {
        let mut backend = InlineBackendMock::new(120, 40, Position { x: 0, y: 7 });

        let (area, cursor_after_append) =
            compute_inline_area(&mut backend, 12, Size::new(120, 40)).expect("area");

        assert_eq!(area, Rect::new(0, 7, 120, 12));
        assert_eq!(cursor_after_append, Position { x: 0, y: 18 });
    }

    #[test]
    fn compute_inline_area_clamps_anchor_row_when_cursor_is_near_bottom() {
        let mut backend = InlineBackendMock::new(100, 20, Position { x: 0, y: 19 });

        let (area, cursor_after_append) =
            compute_inline_area(&mut backend, 8, Size::new(100, 20)).expect("area");

        // max_row = 20 - 8 = 12
        assert_eq!(area, Rect::new(0, 12, 100, 8));
        assert_eq!(cursor_after_append, Position { x: 0, y: 19 });
    }
}
