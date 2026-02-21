use std::fmt;
use std::io;
use std::io::Write;

use crossterm::cursor::{Hide, MoveTo};
use crossterm::queue;
use crossterm::style::Color as CColor;
use crossterm::style::Colors;
use crossterm::style::Print;
use crossterm::style::SetAttribute;
use crossterm::style::SetBackgroundColor;
use crossterm::style::SetColors;
use crossterm::style::SetForegroundColor;
use crossterm::terminal::Clear;
use crossterm::terminal::ClearType;
use crossterm::Command;
use ratatui::layout::Size;
use ratatui::prelude::Backend;
use ratatui::style::Color;
use ratatui::style::Modifier;
use ratatui::text::Line;
use ratatui::text::Span;

/// Insert lines above the viewport using direct terminal writes.
/// Ported from codex-rs/tui/src/insert_history.rs (MIT).
pub fn insert_history_lines<B>(
    terminal: &mut crate::app::render::custom_terminal::Terminal<B>,
    lines: Vec<Line<'static>>,
) -> io::Result<()>
where
    B: Backend + Write,
{
    if lines.is_empty() {
        return Ok(());
    }

    let screen_size = terminal.size().unwrap_or(Size::new(0, 0));
    let mut area = terminal.viewport_area;
    if area.width == 0 || area.height == 0 || screen_size.height == 0 {
        return Ok(());
    }

    let mut should_update_area = false;
    let last_cursor_pos = terminal.last_known_cursor_pos;
    let writer = terminal.backend_mut();
    let wrapped_lines = lines.len() as u16;
    let mut cursor_shift_y = 0_u16;

    let cursor_top = if area.bottom() < screen_size.height {
        let scroll_amount = wrapped_lines.min(screen_size.height - area.bottom());
        let top_1based = area.top() + 1;
        queue!(writer, SetScrollRegion(top_1based..screen_size.height))?;
        queue!(writer, MoveTo(0, area.top()))?;
        for _ in 0..scroll_amount {
            queue!(writer, Print("\x1bM"))?;
        }
        queue!(writer, ResetScrollRegion)?;

        let cursor_top = area.top().saturating_sub(1);
        area.y += scroll_amount;
        cursor_shift_y = scroll_amount;
        should_update_area = true;
        cursor_top
    } else {
        area.top().saturating_sub(1)
    };

    if area.top() == 0 {
        return Ok(());
    }

    queue!(writer, Hide)?;
    queue!(writer, SetScrollRegion(1..area.top()))?;
    queue!(writer, MoveTo(0, cursor_top))?;

    for line in lines {
        queue!(writer, Print("\r\n"))?;
        queue!(
            writer,
            SetColors(Colors::new(
                line.style
                    .fg
                    .map(std::convert::Into::into)
                    .unwrap_or(CColor::Reset),
                line.style
                    .bg
                    .map(std::convert::Into::into)
                    .unwrap_or(CColor::Reset)
            ))
        )?;
        queue!(writer, Clear(ClearType::UntilNewLine))?;
        let merged_spans: Vec<Span> = line
            .spans
            .iter()
            .map(|s| Span {
                style: s.style.patch(line.style),
                content: s.content.clone(),
            })
            .collect();
        write_spans(writer, merged_spans.iter())?;
    }

    queue!(writer, ResetScrollRegion)?;
    let restore_y = last_cursor_pos
        .y
        .saturating_add(cursor_shift_y)
        .min(screen_size.height.saturating_sub(1));
    queue!(writer, MoveTo(last_cursor_pos.x, restore_y))?;

    let _ = writer;
    terminal.last_known_cursor_pos.x = last_cursor_pos.x;
    terminal.last_known_cursor_pos.y = restore_y;
    if should_update_area {
        terminal.set_viewport_area(area);
    }

    Ok(())
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct SetScrollRegion(pub std::ops::Range<u16>);

impl Command for SetScrollRegion {
    fn write_ansi(&self, f: &mut impl fmt::Write) -> fmt::Result {
        write!(f, "\x1b[{};{}r", self.0.start, self.0.end)
    }

    #[cfg(windows)]
    fn execute_winapi(&self) -> std::io::Result<()> {
        panic!("tried to execute SetScrollRegion command using WinAPI, use ANSI instead");
    }

    #[cfg(windows)]
    fn is_ansi_code_supported(&self) -> bool {
        true
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct ResetScrollRegion;

impl Command for ResetScrollRegion {
    fn write_ansi(&self, f: &mut impl fmt::Write) -> fmt::Result {
        write!(f, "\x1b[r")
    }

    #[cfg(windows)]
    fn execute_winapi(&self) -> std::io::Result<()> {
        panic!("tried to execute ResetScrollRegion command using WinAPI, use ANSI instead");
    }

    #[cfg(windows)]
    fn is_ansi_code_supported(&self) -> bool {
        true
    }
}

struct ModifierDiff {
    pub from: Modifier,
    pub to: Modifier,
}

impl ModifierDiff {
    fn queue<W>(self, mut w: W) -> io::Result<()>
    where
        W: io::Write,
    {
        use crossterm::style::Attribute as CAttribute;
        let removed = self.from - self.to;
        if removed.contains(Modifier::REVERSED) {
            queue!(w, SetAttribute(CAttribute::NoReverse))?;
        }
        if removed.contains(Modifier::BOLD) {
            queue!(w, SetAttribute(CAttribute::NormalIntensity))?;
            if self.to.contains(Modifier::DIM) {
                queue!(w, SetAttribute(CAttribute::Dim))?;
            }
        }
        if removed.contains(Modifier::ITALIC) {
            queue!(w, SetAttribute(CAttribute::NoItalic))?;
        }
        if removed.contains(Modifier::UNDERLINED) {
            queue!(w, SetAttribute(CAttribute::NoUnderline))?;
        }
        if removed.contains(Modifier::DIM) {
            queue!(w, SetAttribute(CAttribute::NormalIntensity))?;
        }
        if removed.contains(Modifier::CROSSED_OUT) {
            queue!(w, SetAttribute(CAttribute::NotCrossedOut))?;
        }
        if removed.contains(Modifier::SLOW_BLINK) || removed.contains(Modifier::RAPID_BLINK) {
            queue!(w, SetAttribute(CAttribute::NoBlink))?;
        }

        let added = self.to - self.from;
        if added.contains(Modifier::REVERSED) {
            queue!(w, SetAttribute(CAttribute::Reverse))?;
        }
        if added.contains(Modifier::BOLD) {
            queue!(w, SetAttribute(CAttribute::Bold))?;
        }
        if added.contains(Modifier::ITALIC) {
            queue!(w, SetAttribute(CAttribute::Italic))?;
        }
        if added.contains(Modifier::UNDERLINED) {
            queue!(w, SetAttribute(CAttribute::Underlined))?;
        }
        if added.contains(Modifier::DIM) {
            queue!(w, SetAttribute(CAttribute::Dim))?;
        }
        if added.contains(Modifier::CROSSED_OUT) {
            queue!(w, SetAttribute(CAttribute::CrossedOut))?;
        }
        if added.contains(Modifier::SLOW_BLINK) {
            queue!(w, SetAttribute(CAttribute::SlowBlink))?;
        }
        if added.contains(Modifier::RAPID_BLINK) {
            queue!(w, SetAttribute(CAttribute::RapidBlink))?;
        }

        Ok(())
    }
}

fn write_spans<'a, I>(mut writer: &mut impl Write, content: I) -> io::Result<()>
where
    I: IntoIterator<Item = &'a Span<'a>>,
{
    let mut fg = Color::Reset;
    let mut bg = Color::Reset;
    let mut last_modifier = Modifier::empty();
    for span in content {
        let mut modifier = Modifier::empty();
        modifier.insert(span.style.add_modifier);
        modifier.remove(span.style.sub_modifier);
        if modifier != last_modifier {
            let diff = ModifierDiff {
                from: last_modifier,
                to: modifier,
            };
            diff.queue(&mut writer)?;
            last_modifier = modifier;
        }
        let next_fg = span.style.fg.unwrap_or(Color::Reset);
        let next_bg = span.style.bg.unwrap_or(Color::Reset);
        if next_fg != fg || next_bg != bg {
            queue!(
                writer,
                SetColors(Colors::new(next_fg.into(), next_bg.into()))
            )?;
            fg = next_fg;
            bg = next_bg;
        }

        queue!(writer, Print(span.content.clone()))?;
    }

    queue!(
        writer,
        SetForegroundColor(CColor::Reset),
        SetBackgroundColor(CColor::Reset),
        SetAttribute(crossterm::style::Attribute::Reset),
    )
}

#[cfg(test)]
mod tests {
    use super::insert_history_lines;
    use crate::app::render::custom_terminal::Terminal;
    use ratatui::backend::{Backend, ClearType, WindowSize};
    use ratatui::buffer::Cell;
    use ratatui::layout::{Position, Rect, Size};
    use ratatui::style::Style;
    use ratatui::text::Line;
    use std::io::{self, Write};

    #[derive(Debug, Default)]
    struct RenderBackendMock {
        size: Size,
        cursor: Position,
        hidden: bool,
        writes: Vec<u8>,
    }

    impl RenderBackendMock {
        fn new(size: Size, cursor: Position) -> Self {
            Self {
                size,
                cursor,
                hidden: false,
                writes: Vec::new(),
            }
        }

        fn output(&self) -> String {
            String::from_utf8_lossy(&self.writes).to_string()
        }
    }

    impl Write for RenderBackendMock {
        fn write(&mut self, buf: &[u8]) -> io::Result<usize> {
            self.writes.extend_from_slice(buf);
            Ok(buf.len())
        }

        fn flush(&mut self) -> io::Result<()> {
            Ok(())
        }
    }

    impl Backend for RenderBackendMock {
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
            self.hidden = true;
            Ok(())
        }

        fn show_cursor(&mut self) -> io::Result<()> {
            self.hidden = false;
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

    fn sample_line(text: &str) -> Line<'static> {
        Line::styled(text.to_string(), Style::default())
    }

    #[test]
    fn insert_history_lines_updates_viewport_and_cursor_restore() {
        let backend = RenderBackendMock::new(Size::new(20, 12), Position { x: 5, y: 7 });
        let mut terminal = Terminal::new(backend).expect("terminal");
        terminal.set_viewport_area(Rect::new(0, 3, 20, 4));
        terminal.last_known_cursor_pos = Position { x: 5, y: 7 };

        insert_history_lines(
            &mut terminal,
            vec![sample_line("alpha"), sample_line("beta")],
        )
        .expect("insert_history_lines");

        // Viewport shifts downward by number of inserted wrapped lines when there is room.
        assert_eq!(terminal.viewport_area, Rect::new(0, 5, 20, 4));
        // Cursor restore tracks the same downward shift.
        assert_eq!(terminal.last_known_cursor_pos, Position { x: 5, y: 9 });

        let output = terminal.backend_mut().output();
        assert!(output.contains("\u{1b}[4;12r"));
        assert!(output.contains("\u{1b}[1;5r"));
        assert!(output.contains("\u{1b}M"));
    }

    #[test]
    fn vt100_replay_insert_history_semantics() {
        if std::env::var("CODELIA_TUI_VT100_REPLAY").ok().as_deref() != Some("1") {
            return;
        }

        let backend = RenderBackendMock::new(Size::new(24, 10), Position { x: 0, y: 6 });
        let mut terminal = Terminal::new(backend).expect("terminal");
        terminal.set_viewport_area(Rect::new(0, 2, 24, 4));
        terminal.last_known_cursor_pos = Position { x: 0, y: 6 };

        insert_history_lines(
            &mut terminal,
            vec![sample_line("line-one"), sample_line("line-two")],
        )
        .expect("insert_history_lines");

        let bytes = terminal.backend_mut().output();
        let mut parser = vt100::Parser::new(10, 24, 0);
        parser.process(bytes.as_bytes());

        let screen = parser.screen();
        let (cursor_row, cursor_col) = screen.cursor_position();
        // vt100 parser cursor is 0-based; expected final row is 8 for this scenario.
        assert_eq!((cursor_row, cursor_col), (8, 0));
        assert!(screen.contents().contains("line-two"));
    }
}
