use crate::app::handlers::confirm::activate_pending_confirm_dialog;
use crate::app::render::inline::{apply_terminal_effects, compute_inline_area};
use crate::app::state::LogKind;
use crate::app::view::{desired_height, draw_ui};
use crate::app::AppState;
use crate::entry::terminal::TuiTerminal;
use crate::event_loop::input::{
    apply_redraw, blocks_input_paste, handle_ctrl_c, handle_main_key, handle_mouse_event,
    handle_non_main_key, handle_paste, maybe_request_skills_catalog,
};
use crate::event_loop::runtime::{can_auto_start_initial_message, process_runtime_messages};
use crate::event_loop::{RuntimeReceiver, RuntimeStdin};
use crossterm::event::{self, Event, KeyCode, KeyEventKind, KeyModifiers};
use ratatui::layout::{Rect, Size};
use std::fmt;
use std::process::Child;
use std::time::{Duration, Instant};

const CTRL_C_FORCE_QUIT_WINDOW: Duration = Duration::from_secs(2);

#[derive(Clone, Copy, Debug)]
struct KeyDebugLog {
    code: KeyCode,
    modifiers: KeyModifiers,
    kind: KeyEventKind,
}

impl KeyDebugLog {
    fn from_event(event: &crossterm::event::KeyEvent) -> Self {
        Self {
            code: event.code,
            modifiers: event.modifiers,
            kind: event.kind,
        }
    }
}

impl fmt::Display for KeyDebugLog {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(
            f,
            "code={:?} mods={:?} kind={:?}",
            self.code, self.modifiers, self.kind
        )
    }
}

pub(crate) fn run_tui_loop(
    app: &mut AppState,
    terminal: &mut TuiTerminal,
    rx: &RuntimeReceiver,
    child: &mut Child,
    child_stdin: &mut RuntimeStdin,
    next_id: &mut impl FnMut() -> String,
    pending_initial_message: &mut Option<String>,
    use_alt_screen: bool,
) -> Result<(), Box<dyn std::error::Error>> {
    let mut inline_initialized = false;
    let mut inline_viewport_height = 0_u16;
    let mut inline_screen_size: Option<Size> = None;
    let mut needs_redraw = true;
    let mut should_exit = false;
    let key_debug = std::env::var("CODELIA_TUI_KEY_DEBUG").ok().as_deref() == Some("1");
    let mut last_ctrl_c_at: Option<Instant> = None;

    loop {
        if process_runtime_messages(app, rx, child_stdin, next_id) {
            needs_redraw = true;
        }

        maybe_request_skills_catalog(app, child_stdin, next_id);

        if pending_initial_message.is_some() && can_auto_start_initial_message(app) {
            if let Some(message) = pending_initial_message.take() {
                if crate::app::handlers::command::start_prompt_run(
                    app,
                    child_stdin,
                    next_id,
                    &message,
                ) {
                    app.clear_composer();
                }
                needs_redraw = true;
            }
        }

        if crate::app::handlers::command::try_dispatch_queued_prompt(app, child_stdin, next_id) {
            needs_redraw = true;
        }

        if let Ok(Some(status)) = child.try_wait() {
            app.push_line(LogKind::Runtime, format!("runtime exited: {}", status));
            needs_redraw = true;
            should_exit = true;
        }

        let timeout = Duration::from_millis(50);
        if event::poll(timeout)? {
            match event::read()? {
                Event::Key(key) => {
                    if key.kind != KeyEventKind::Press {
                        continue;
                    }
                    if key_debug {
                        eprintln!("key: {}", KeyDebugLog::from_event(&key));
                    }
                    if key.code == KeyCode::Char('c')
                        && key.modifiers.contains(KeyModifiers::CONTROL)
                    {
                        let now = Instant::now();
                        if let Some(previous) = last_ctrl_c_at {
                            if now.duration_since(previous) <= CTRL_C_FORCE_QUIT_WINDOW {
                                app.push_line(LogKind::Status, "Force quitting...");
                                break;
                            }
                        }
                        if handle_ctrl_c(app, child_stdin, next_id) {
                            last_ctrl_c_at = Some(now);
                            needs_redraw = true;
                            continue;
                        }
                        break;
                    }

                    last_ctrl_c_at = None;

                    if let Some(redraw) =
                        handle_non_main_key(app, key.code, key.modifiers, child_stdin, next_id)
                    {
                        apply_redraw(&mut needs_redraw, redraw);
                        continue;
                    }

                    if handle_main_key(app, key.code, key.modifiers, terminal, child_stdin, next_id)
                    {
                        app.prune_unreferenced_attachments();
                        needs_redraw = true;
                    }
                }
                Event::Paste(text) => {
                    if blocks_input_paste(app) {
                        continue;
                    }
                    if handle_paste(app, &text) {
                        app.prune_unreferenced_attachments();
                        apply_redraw(&mut needs_redraw, true);
                    }
                }
                Event::Mouse(mouse) => {
                    apply_redraw(&mut needs_redraw, handle_mouse_event(app, mouse.kind));
                }
                Event::Resize(_, _) => {
                    needs_redraw = true;
                }
                _ => {}
            }
        }

        let now = Instant::now();
        if app.update_spinner(now) {
            needs_redraw = true;
        }

        if needs_redraw {
            let frame_started = Instant::now();
            let mut followup_redraw = false;
            let screen_size = terminal.size()?;
            let log_changed_for_scrollback = app.log_changed;
            if use_alt_screen {
                let area = Rect::new(0, 0, screen_size.width, screen_size.height);
                if terminal.viewport_area != area {
                    terminal.set_viewport_area(area);
                    terminal.clear()?;
                }
            } else {
                let desired = desired_height(app, screen_size.width, screen_size.height).max(1);
                let min_height = 12_u16;
                let screen_changed = inline_screen_size != Some(screen_size);
                if !inline_initialized {
                    let target_height = desired.max(min_height).min(screen_size.height).max(1);
                    let (area, cursor_pos) =
                        compute_inline_area(terminal.backend_mut(), target_height, screen_size)?;
                    terminal.set_viewport_area(area);
                    terminal.last_known_cursor_pos = cursor_pos;
                    terminal.last_known_screen_size = screen_size;
                    terminal.clear()?;
                    inline_initialized = true;
                    inline_viewport_height = target_height;
                    inline_screen_size = Some(screen_size);
                } else {
                    let mut area = terminal.viewport_area;
                    area.width = screen_size.width;
                    area.height = inline_viewport_height.min(screen_size.height).max(1);
                    let max_y = screen_size.height.saturating_sub(area.height);
                    if area.y > max_y {
                        area.y = max_y;
                    }
                    if screen_changed || area != terminal.viewport_area {
                        terminal.set_viewport_area(area);
                        terminal.clear()?;
                    }
                    inline_viewport_height = area.height;
                    inline_screen_size = Some(screen_size);
                }
                terminal.last_known_screen_size = screen_size;
            }
            let draw_started = Instant::now();
            terminal.draw(|f| draw_ui(f, app))?;
            app.record_perf_frame(frame_started.elapsed(), draw_started.elapsed());
            if !use_alt_screen {
                let effects = apply_terminal_effects(terminal, app, log_changed_for_scrollback)?;
                if effects.request_redraw {
                    followup_redraw = true;
                }
            }
            if activate_pending_confirm_dialog(app) {
                needs_redraw = true;
                continue;
            }
            needs_redraw = followup_redraw;
            app.assert_render_invariants();
        }
        if should_exit {
            break;
        }
    }

    Ok(())
}
