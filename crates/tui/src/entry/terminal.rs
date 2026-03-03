use crossterm::cursor::Show;
use crossterm::event::{
    DisableBracketedPaste, DisableMouseCapture, EnableBracketedPaste, EnableMouseCapture,
    KeyboardEnhancementFlags, PopKeyboardEnhancementFlags, PushKeyboardEnhancementFlags,
};
use crossterm::terminal::{
    disable_raw_mode, enable_raw_mode, EnterAlternateScreen, LeaveAlternateScreen,
};
use crossterm::ExecutableCommand;
use ratatui::backend::Backend;
use ratatui::backend::CrosstermBackend;
use ratatui::layout::Position;

pub(crate) type TerminalBackend = CrosstermBackend<std::io::Stdout>;
pub(crate) type TuiTerminal = crate::app::render::custom_terminal::Terminal<TerminalBackend>;

pub(crate) struct TerminalRestoreGuard {
    use_alt_screen: bool,
}

impl TerminalRestoreGuard {
    pub(crate) fn new(use_alt_screen: bool) -> Self {
        Self { use_alt_screen }
    }
}

impl Drop for TerminalRestoreGuard {
    fn drop(&mut self) {
        let _ = disable_raw_mode();
        let mut stdout = std::io::stdout();
        let _ = stdout.execute(PopKeyboardEnhancementFlags);
        let _ = stdout.execute(DisableBracketedPaste);
        let _ = stdout.execute(DisableMouseCapture);
        if self.use_alt_screen {
            let _ = stdout.execute(LeaveAlternateScreen);
        }
        let _ = stdout.execute(Show);
    }
}

pub(crate) fn setup_terminal(
    use_alt_screen: bool,
) -> Result<TuiTerminal, Box<dyn std::error::Error>> {
    let mut stdout = std::io::stdout();
    if use_alt_screen {
        stdout.execute(EnterAlternateScreen)?;
    }
    enable_raw_mode()?;

    // Try to enable the kitty keyboard protocol so we can reliably distinguish Shift+Enter and
    // other modifier combos on terminals that support it. On unsupported terminals this is a noop.
    let _ = stdout.execute(PushKeyboardEnhancementFlags(
        KeyboardEnhancementFlags::DISAMBIGUATE_ESCAPE_CODES
            | KeyboardEnhancementFlags::REPORT_EVENT_TYPES
            | KeyboardEnhancementFlags::REPORT_ALTERNATE_KEYS,
    ));
    // Ensure multi-line paste is delivered as Event::Paste instead of a stream of Enter keypresses.
    let _ = stdout.execute(EnableBracketedPaste);

    let backend = CrosstermBackend::new(stdout);
    Ok(crate::app::render::custom_terminal::Terminal::new(backend)?)
}

pub(crate) fn set_mouse_capture(terminal: &mut TuiTerminal, enabled: bool) {
    if enabled {
        let _ = terminal.backend_mut().execute(EnableMouseCapture);
    } else {
        let _ = terminal.backend_mut().execute(DisableMouseCapture);
    }
}

pub(crate) fn restore_inline_cursor(terminal: &mut TuiTerminal) {
    let area = terminal.viewport_area;
    let screen_size = terminal.size().unwrap_or(terminal.last_known_screen_size);
    let mut cursor_y = area.bottom();
    if cursor_y >= screen_size.height {
        let _ = terminal.backend_mut().set_cursor_position(Position {
            x: 0,
            y: screen_size.height.saturating_sub(1),
        });
        let _ = terminal.backend_mut().append_lines(1);
        cursor_y = screen_size.height.saturating_sub(1);
    }
    let _ = terminal
        .backend_mut()
        .set_cursor_position(Position { x: 0, y: cursor_y });
    let _ = Backend::flush(terminal.backend_mut());
}
