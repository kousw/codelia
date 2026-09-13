use super::frame::draw_frame;
use crate::app::state::{LogColor, LogKind, LogLine, LogSpan, LogTone};
use crate::app::AppState;
use ratatui::backend::{Backend, ClearType, CrosstermBackend, WindowSize};
use ratatui::buffer::Cell;
use ratatui::layout::{Position, Size};
use ratatui::{Terminal, TerminalOptions, Viewport};
use std::cell::RefCell;
use std::io::{self, Write};
use std::rc::Rc;
use unicode_width::UnicodeWidthStr;

#[derive(Clone, Default)]
struct CaptureWriter(Rc<RefCell<Vec<u8>>>);

impl Write for CaptureWriter {
    fn write(&mut self, bytes: &[u8]) -> io::Result<usize> {
        self.0.borrow_mut().extend_from_slice(bytes);
        Ok(bytes.len())
    }
    fn flush(&mut self) -> io::Result<()> {
        Ok(())
    }
}

// Only terminal queries are stubbed; output uses the real Crossterm serializer.
struct RecordingBackend {
    inner: CrosstermBackend<CaptureWriter>,
    size: Size,
    cursor: Position,
}

impl Backend for RecordingBackend {
    type Error = io::Error;
    fn draw<'a, I>(&mut self, content: I) -> io::Result<()>
    where
        I: Iterator<Item = (u16, u16, &'a Cell)>,
    {
        let mut covered = None;
        self.inner.draw(content.inspect(|(x, y, cell)| {
            if covered.is_some_and(|(row, end)| row == *y && *x < end) {
                assert_eq!(
                    cell.symbol(),
                    "",
                    "wide continuation must not print a space"
                );
            } else {
                covered = Some((*y, x.saturating_add(cell.symbol().width() as u16)));
            }
        }))
    }
    fn hide_cursor(&mut self) -> io::Result<()> {
        self.inner.hide_cursor()
    }
    fn show_cursor(&mut self) -> io::Result<()> {
        self.inner.show_cursor()
    }
    fn get_cursor_position(&mut self) -> io::Result<Position> {
        Ok(self.cursor)
    }
    fn set_cursor_position<P: Into<Position>>(&mut self, position: P) -> io::Result<()> {
        self.cursor = position.into();
        self.inner.set_cursor_position(self.cursor)
    }
    fn clear(&mut self) -> io::Result<()> {
        self.inner.clear()
    }
    fn clear_region(&mut self, clear_type: ClearType) -> io::Result<()> {
        self.inner.clear_region(clear_type)
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
        Backend::flush(&mut self.inner)
    }
    fn append_lines(&mut self, n: u16) -> io::Result<()> {
        self.inner.append_lines(n)
    }
}

#[test]
fn inline_native_scrollback_ansi_capture() {
    let mut captures = Vec::new();
    for (height, batch_size) in [(12, 80), (24, 80), (12, 30), (24, 30), (12, 1), (24, 1)] {
        let mut writer = CaptureWriter::default();
        writer
            .write_all(b"SHELL-PREFIX-A\r\nSHELL-PREFIX-B\r\n")
            .unwrap();
        let backend = RecordingBackend {
            inner: CrosstermBackend::new(writer.clone()),
            size: Size::new(40, height),
            cursor: Position::new(0, 2),
        };
        let mut terminal = Terminal::with_options(
            backend,
            TerminalOptions {
                viewport: Viewport::Inline(12),
            },
        )
        .unwrap();
        let mut app = AppState::default();
        let composer = "EDIT-ME";
        app.input.buffer = composer.chars().collect();
        app.input.cursor = app.input.buffer.len();
        let expected = (0..80)
            .map(|i| match i % 4 {
                0 => format!("HISTORY-{i:03}"),
                1 => format!("HISTORY-{i:03} \u{65e5}\u{672c}\u{8a9e}ABC \u{7a7a} \u{767d}"),
                // Keep emulator fixtures within its Unicode width table. Newer
                // width-divergence cases are checked against rendered cells in
                // scrollback_tests, without assuming host Unicode support.
                2 => format!("HISTORY-{i:03} e\u{301} \u{304b}\u{3099} \u{754c}"),
                _ => format!("HISTORY-{i:03}{}\u{754c}", "x".repeat(27)),
            })
            .collect::<Vec<_>>();
        // Replay bulk restored history, chunked updates, and single-line streaming.
        for (batch_index, batch) in expected.chunks(batch_size).enumerate() {
            for (offset, text) in batch.iter().enumerate() {
                if (batch_index * batch_size + offset) % 4 == 1 {
                    app.extend_lines(vec![LogLine::new_with_spans(vec![
                        LogSpan::new_with_fg(
                            LogKind::AssistantCode,
                            LogTone::Summary,
                            &text[..12],
                            Some(LogColor::rgb(255, 0, 0)),
                        ),
                        LogSpan::new_with_fg(
                            LogKind::AssistantCode,
                            LogTone::Summary,
                            &text[12..],
                            Some(LogColor::rgb(0, 255, 0)),
                        ),
                    ])]);
                } else {
                    app.push_line(LogKind::Assistant, text);
                }
            }
            assert!(
                !draw_frame(&mut terminal, &mut app, true)
                    .unwrap()
                    .request_redraw
            );
        }
        let data = String::from_utf8(writer.0.borrow().clone()).unwrap();
        // Diff rendering can emit only changed suffixes, not whole log strings.
        assert!(!data.is_empty());
        assert_eq!(
            app.render_state.committed.line,
            expected.len() - app.last_log_viewport_height
        );
        // CSI S deletes rows without retaining native history in xterm. Guard
        // this known incompatibility even when the optional emulator isn't installed.
        assert!(
            !data.split("\x1b[").skip(1).any(|sequence| {
                sequence.bytes().find(|byte| (0x40..=0x7e).contains(byte)) == Some(b'S')
            }),
            "CSI S is not a native-scrollback insertion primitive"
        );
        captures.push(
            serde_json::json!({ "cols": 40, "rows": height, "data": data,
            "prefix": ["SHELL-PREFIX-A", "SHELL-PREFIX-B"], "expected": expected,
            "composer": composer, "batch_size": batch_size,
            // Declarative fixture expectations, not captured from the rendered buffer.
            "footer": ["\u{25cf} idle", "", "", format!("  > {composer}"), "", "model: -/- [-]  \u{2022}  Alt+H help"],
            "composer_column": 4,
            "styled_rows": (0..80).filter(|i| i % 4 == 1).map(|i| i + 2).collect::<Vec<_>>() }),
        );
    }
    // Optional emulator smoke output; regular unit tests need no npm dependency.
    if let Some(path) = std::env::var_os("CODELIA_TUI_CAPTURE_PATH") {
        std::fs::write(path, serde_json::to_vec(&captures).unwrap()).unwrap();
    }
}
