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
use ratatui::{Terminal, TerminalOptions, Viewport};
use std::io::Write;

use crate::entry::terminal_mode::ResolvedTerminalMode;

pub(crate) type TerminalBackend = CrosstermBackend<std::io::Stdout>;
pub(crate) type TuiTerminal = Terminal<TerminalBackend>;

pub(crate) struct TerminalRestoreGuard {
    mode: ResolvedTerminalMode,
    preview_image_id: Option<u32>,
}

impl TerminalRestoreGuard {
    pub(crate) fn new(mode: ResolvedTerminalMode) -> Self {
        Self {
            mode,
            preview_image_id: None,
        }
    }

    pub(crate) fn with_preview_image(mut self, image_id: Option<u32>) -> Self {
        self.preview_image_id = image_id;
        self
    }
}

impl Drop for TerminalRestoreGuard {
    fn drop(&mut self) {
        let _ = disable_raw_mode();
        let mut stdout = std::io::stdout();
        let _ = stdout.execute(PopKeyboardEnhancementFlags);
        let _ = stdout.execute(DisableBracketedPaste);
        let _ = stdout.execute(DisableMouseCapture);
        if let Some(id) = self.preview_image_id {
            // Delete only our reusable Kitty cache entry at the terminal
            // lifecycle boundary. Preview close itself clears its text cells.
            let _ = write!(stdout, "\x1b_Ga=d,d=I,i={id},q=2\x1b\\");
            let _ = stdout.flush();
        }
        if self.mode.uses_alternate_screen() {
            let _ = stdout.execute(LeaveAlternateScreen);
        }
        let _ = stdout.execute(Show);
    }
}

pub(crate) fn image_preview_policy(
    mode: ResolvedTerminalMode,
) -> crate::app::image_preview::PreviewPolicy {
    let request = std::env::var("CODELIA_TUI_IMAGE_PROTOCOL").ok();
    let font = if request.as_deref() == Some("kitty") {
        // window_size uses the OS, never an stdin-reading terminal query.
        crossterm::terminal::window_size().ok().and_then(|size| {
            if size.columns == 0 || size.rows == 0 {
                return None;
            }
            Some(ratatui_image::FontSize::new(
                size.width / size.columns,
                size.height / size.rows,
            ))
        })
    } else {
        None
    };
    crate::app::image_preview::PreviewPolicy::resolve(
        request.as_deref(),
        mode.uses_alternate_screen(),
        std::env::var_os("TMUX").is_some()
            || std::env::var("TERM")
                .is_ok_and(|term| term.starts_with("tmux") || term.starts_with("screen"))
            || std::env::var("TERM_PROGRAM").is_ok_and(|term| term == "tmux"),
        font,
    )
}

pub(crate) fn setup_terminal(
    mode: ResolvedTerminalMode,
    inline_height: u16,
) -> Result<TuiTerminal, Box<dyn std::error::Error>> {
    let mut stdout = std::io::stdout();
    if mode.uses_alternate_screen() {
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
    let terminal = if mode.uses_alternate_screen() {
        Terminal::new(backend)?
    } else {
        Terminal::with_options(
            backend,
            TerminalOptions {
                viewport: Viewport::Inline(inline_height.max(1)),
            },
        )?
    };
    Ok(terminal)
}

pub(crate) fn set_mouse_capture(terminal: &mut TuiTerminal, enabled: bool) {
    if enabled {
        let _ = terminal.backend_mut().execute(EnableMouseCapture);
    } else {
        let _ = terminal.backend_mut().execute(DisableMouseCapture);
    }
}

pub(crate) fn restore_inline_cursor(terminal: &mut TuiTerminal) {
    let area = terminal.get_frame().area();
    let screen_size = terminal.size().unwrap_or(area.as_size());
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
