use super::frame::draw_frame;
use crate::app::state::{render::LogPosition, LogKind};
use crate::app::{AppState, SyncPhase};
use ratatui::backend::{Backend, ClearType, TestBackend, WindowSize};
use ratatui::buffer::Cell;
use ratatui::layout::{Position, Size};
use ratatui::{Terminal, TerminalOptions, Viewport};
use std::cell::RefCell;
use std::collections::VecDeque;
use std::convert::Infallible;

type BackendResult<T> = Result<T, Infallible>;

// Resize at the actual Terminal::draw size query, including the restoring draw.
// This exercises the same bounded helper used by the production input loop.
struct ResizingBackend {
    inner: RefCell<TestBackend>,
    sizes: RefCell<VecDeque<Size>>,
}

impl Backend for ResizingBackend {
    type Error = Infallible;
    fn draw<'a, I>(&mut self, content: I) -> BackendResult<()>
    where
        I: Iterator<Item = (u16, u16, &'a Cell)>,
    {
        self.inner.get_mut().draw(content)
    }
    fn hide_cursor(&mut self) -> BackendResult<()> {
        self.inner.get_mut().hide_cursor()
    }
    fn show_cursor(&mut self) -> BackendResult<()> {
        self.inner.get_mut().show_cursor()
    }
    fn get_cursor_position(&mut self) -> BackendResult<Position> {
        self.inner.get_mut().get_cursor_position()
    }
    fn set_cursor_position<P: Into<Position>>(&mut self, position: P) -> BackendResult<()> {
        self.inner.get_mut().set_cursor_position(position)
    }
    fn clear(&mut self) -> BackendResult<()> {
        self.inner.get_mut().clear()
    }
    fn clear_region(&mut self, clear_type: ClearType) -> BackendResult<()> {
        self.inner.get_mut().clear_region(clear_type)
    }
    fn size(&self) -> BackendResult<Size> {
        if let Some(size) = self.sizes.borrow_mut().pop_front() {
            self.inner.borrow_mut().resize(size.width, size.height);
        }
        self.inner.borrow().size()
    }
    fn window_size(&mut self) -> BackendResult<WindowSize> {
        self.inner.get_mut().window_size()
    }
    fn flush(&mut self) -> BackendResult<()> {
        self.inner.get_mut().flush()
    }
    fn append_lines(&mut self, n: u16) -> BackendResult<()> {
        self.inner.get_mut().append_lines(n)
    }
}

fn terminal(viewport: Viewport) -> Terminal<ResizingBackend> {
    Terminal::with_options(
        ResizingBackend {
            inner: RefCell::new(TestBackend::new(40, 12)),
            sizes: RefCell::new(VecDeque::new()),
        },
        TerminalOptions { viewport },
    )
    .unwrap()
}

fn app() -> AppState {
    let mut app = AppState::default();
    app.input.buffer = "EDIT".chars().collect();
    app.input.cursor = app.input.buffer.len();
    for i in 0..30 {
        app.push_line(LogKind::Assistant, format!("{i:03}-{}", "x".repeat(36)));
    }
    app
}

fn assert_composer_restored(terminal: &Terminal<ResizingBackend>) {
    let backend = terminal.backend().inner.borrow();
    let buffer = backend.buffer();
    let rows = (0..buffer.area.height)
        .map(|y| {
            (0..buffer.area.width)
                .map(|x| buffer[(x, y)].symbol())
                .collect::<String>()
        })
        .collect::<Vec<_>>();
    let row = rows
        .iter()
        .position(|row| row.contains("EDIT"))
        .expect("composer visible before polling");
    assert!(backend.cursor_visible());
    assert_eq!(backend.cursor_position().y as usize, row);
    let column = rows[row].find("EDIT").unwrap() + "EDIT".len();
    assert_eq!(backend.cursor_position().x as usize, column);
}

#[test]
fn restoring_resize_defers_more_insertion_but_restores_composer() {
    let mut terminal = terminal(Viewport::Inline(12));
    let mut app = app();
    terminal
        .backend_mut()
        .sizes
        .get_mut()
        .extend([Size::new(40, 12), Size::new(20, 12)]);
    let result = draw_frame(&mut terminal, &mut app, true).unwrap();
    assert!(result.request_redraw);
    assert_eq!(app.render_state.sync_phase, SyncPhase::NeedsInsert);
    assert!(terminal.backend().sizes.borrow().is_empty());
    assert_composer_restored(&terminal);
    let before = app.render_state.committed;
    let result = draw_frame(&mut terminal, &mut app, true).unwrap();
    assert!(!result.request_redraw);
    assert!(app.render_state.committed > before);
    assert_eq!(app.render_state.sync_phase, SyncPhase::Idle);
    assert_composer_restored(&terminal);
}

#[test]
fn repeated_resizes_remain_bounded_and_leave_a_drawn_viewport() {
    let mut terminal = terminal(Viewport::Inline(12));
    let mut app = app();
    for (first, second) in [(40, 30), (30, 20), (20, 16), (16, 12)] {
        terminal.backend_mut().sizes.get_mut().extend([
            Size::new(first, 12),
            Size::new(second, 12),
            Size::new(second, 12),
        ]);
        draw_frame(&mut terminal, &mut app, true).unwrap();
        // No unbounded settle loop: a third draw query is left for the next cycle.
        assert!(!terminal.backend().sizes.borrow().is_empty());
        terminal.backend_mut().sizes.get_mut().clear();
        assert_ne!(app.render_state.sync_phase, SyncPhase::InsertedNeedsRedraw);
        assert_composer_restored(&terminal);
    }
}

#[test]
fn alternate_frame_never_commits_inline_history() {
    let mut terminal = terminal(Viewport::Fullscreen);
    let mut app = app();
    assert!(
        !draw_frame(&mut terminal, &mut app, false)
            .unwrap()
            .request_redraw
    );
    assert_eq!(app.render_state.committed, LogPosition::default());
    assert_eq!(
        terminal.backend().inner.borrow().scrollback().area.height,
        0
    );
    assert_composer_restored(&terminal);
}
