use super::inline::apply_terminal_effects;
use crate::app::state::render::LogPosition;
use crate::app::state::LogKind;
use crate::app::view::draw_ui;
use crate::app::{AppState, SyncPhase};
use ratatui::backend::{Backend, ClearType, TestBackend, WindowSize};
use ratatui::buffer::Cell;
use ratatui::layout::{Position, Size};
use ratatui::{Terminal, TerminalOptions, Viewport};
use std::io;

// Fail before the next scroll operation. No production failure-injection hooks.
struct FailingBackend {
    inner: TestBackend,
    successful_scroll_lines: usize,
    fail_after: Option<usize>,
}

impl Backend for FailingBackend {
    type Error = io::Error;

    fn draw<'a, I>(&mut self, content: I) -> io::Result<()>
    where
        I: Iterator<Item = (u16, u16, &'a Cell)>,
    {
        self.inner.draw(content).unwrap();
        Ok(())
    }
    fn hide_cursor(&mut self) -> io::Result<()> {
        self.inner.hide_cursor().unwrap();
        Ok(())
    }
    fn show_cursor(&mut self) -> io::Result<()> {
        self.inner.show_cursor().unwrap();
        Ok(())
    }
    fn get_cursor_position(&mut self) -> io::Result<Position> {
        Ok(self.inner.get_cursor_position().unwrap())
    }
    fn set_cursor_position<P: Into<Position>>(&mut self, position: P) -> io::Result<()> {
        self.inner.set_cursor_position(position).unwrap();
        Ok(())
    }
    fn clear(&mut self) -> io::Result<()> {
        self.inner.clear().unwrap();
        Ok(())
    }
    fn clear_region(&mut self, clear_type: ClearType) -> io::Result<()> {
        self.inner.clear_region(clear_type).unwrap();
        Ok(())
    }
    fn size(&self) -> io::Result<Size> {
        Ok(self.inner.size().unwrap())
    }
    fn window_size(&mut self) -> io::Result<WindowSize> {
        Ok(self.inner.window_size().unwrap())
    }
    fn flush(&mut self) -> io::Result<()> {
        self.inner.flush().unwrap();
        Ok(())
    }
    fn append_lines(&mut self, n: u16) -> io::Result<()> {
        if self.fail_after == Some(self.successful_scroll_lines) {
            return Err(io::Error::other("injected scroll failure"));
        }
        self.inner.append_lines(n).unwrap();
        self.successful_scroll_lines += usize::from(n);
        Ok(())
    }
}

#[test]
fn failed_insertion_commits_only_successful_chunks_and_can_resume() {
    let width = 40;
    let chunk_size = usize::from(u16::MAX / width);
    for fail_after in [0, chunk_size] {
        let backend = FailingBackend {
            inner: TestBackend::new(width, 12),
            successful_scroll_lines: 0,
            fail_after: None,
        };
        let mut terminal = Terminal::with_options(
            backend,
            TerminalOptions {
                viewport: Viewport::Inline(12),
            },
        )
        .unwrap();
        let mut app = AppState::default();
        for i in 0..chunk_size + 10 {
            app.push_line(LogKind::Assistant, format!("row-{i}"));
        }
        terminal.draw(|frame| draw_ui(frame, &mut app)).unwrap();
        // Inline setup may append lines; inject failures only in history insertion.
        terminal.backend_mut().successful_scroll_lines = 0;
        terminal.backend_mut().fail_after = Some(fail_after);
        let overflow = app.render_state.visible_start;
        let error = match apply_terminal_effects(&mut terminal, &mut app, true, width) {
            Err(error) => error,
            Ok(_) => panic!("expected an insertion error"),
        };
        assert_eq!(error.to_string(), "injected scroll failure");
        assert_eq!(
            app.render_state.committed,
            LogPosition {
                line: fail_after,
                grapheme: 0
            }
        );
        assert_eq!(app.render_state.inserted_until, fail_after);
        assert_eq!(app.render_state.sync_phase, SyncPhase::NeedsInsert);
        terminal.backend_mut().fail_after = None;
        let effects = apply_terminal_effects(&mut terminal, &mut app, false, width).unwrap();
        assert!(effects.request_redraw);
        assert_eq!(
            app.render_state.committed,
            LogPosition {
                line: overflow,
                grapheme: 0
            }
        );
        assert_eq!(app.render_state.inserted_until, overflow);
        terminal
            .backend()
            .inner
            .assert_scrollback_lines((0..overflow).map(|i| format!("{:<40}", format!("row-{i}"))));
    }
}

#[test]
fn partial_log_chunk_failure_resumes_after_optional_rewrap() {
    let width = 40;
    let chunk_size = usize::from(u16::MAX / width);
    let text = (0..10_000).map(|i| format!("{i:07}")).collect::<String>();
    for redraw_width in [None, Some(40), Some(20)] {
        let backend = FailingBackend {
            inner: TestBackend::new(width, 12),
            successful_scroll_lines: 0,
            fail_after: None,
        };
        let mut terminal = Terminal::with_options(
            backend,
            TerminalOptions {
                viewport: Viewport::Inline(12),
            },
        )
        .unwrap();
        let mut app = AppState::default();
        app.push_line(LogKind::Assistant, &text);
        terminal.draw(|f| draw_ui(f, &mut app)).unwrap();
        terminal.backend_mut().successful_scroll_lines = 0;
        terminal.backend_mut().fail_after = Some(chunk_size);
        assert!(apply_terminal_effects(&mut terminal, &mut app, true, width).is_err());
        assert_eq!(
            app.render_state.committed,
            LogPosition {
                line: 0,
                grapheme: chunk_size * usize::from(width)
            }
        );
        let read_history = |terminal: &Terminal<FailingBackend>| {
            let buffer = terminal.backend().inner.scrollback();
            (0..buffer.area.height)
                .map(|y| {
                    (0..buffer.area.width)
                        .map(|x| buffer[(x, y)].symbol())
                        .collect::<String>()
                        .trim_end()
                        .to_string()
                })
                .collect::<Vec<_>>()
        };
        let prefix = read_history(&terminal).concat();
        terminal.backend_mut().fail_after = None;
        if let Some(width) = redraw_width {
            terminal.backend_mut().inner.resize(width, 12);
            terminal.draw(|f| draw_ui(f, &mut app)).unwrap();
        }
        let before = read_history(&terminal).len();
        apply_terminal_effects(
            &mut terminal,
            &mut app,
            false,
            redraw_width.unwrap_or(width),
        )
        .unwrap();
        terminal.draw(|f| draw_ui(f, &mut app)).unwrap();
        let history = read_history(&terminal);
        let (start, end) = (app.render_state.visible_start, app.render_state.visible_end);
        let tail = crate::app::log_wrap::wrapped_log_range_to_lines(
            &mut app,
            usize::from(redraw_width.unwrap_or(width)),
            start,
            end,
        );
        let tail: String = tail
            .iter()
            .flat_map(|line| line.spans.iter().map(|span| span.content.as_ref()))
            .collect();
        assert_eq!(
            format!("{prefix}{}{tail}", history[before..].concat()),
            text
        );
    }
}
