use crate::app::handlers::confirm::activate_pending_confirm_dialog;
use crate::app::render::frame::draw_frame;
use crate::app::runtime::RuntimeTx;
use crate::app::state::LogKind;
use crate::app::util::sample_memory;
use crate::app::AppState;
use crate::entry::terminal::{with_synchronized_update, TuiTerminal};
use crate::entry::terminal_mode::ResolvedTerminalMode;
use crate::event_loop::input::{
    apply_redraw, blocks_input_paste, handle_ctrl_c, handle_main_key, handle_mouse_event,
    handle_non_main_key, handle_paste, maybe_request_skills_catalog,
};
use crate::event_loop::runtime::{can_auto_start_initial_message, process_runtime_messages};
use crate::event_loop::RuntimeReceiver;
use crossterm::event::{self, Event, KeyCode, KeyEventKind, KeyModifiers};
use std::fmt;
use std::process::Child;
use std::time::{Duration, Instant};

const CTRL_C_FORCE_QUIT_WINDOW: Duration = Duration::from_secs(2);
const DEBUG_PERF_MEMORY_SAMPLE_INTERVAL: Duration = Duration::from_secs(1);

pub(crate) struct RunLoopTerminal<'a> {
    terminal: &'a mut TuiTerminal,
    mode: ResolvedTerminalMode,
}

impl<'a> RunLoopTerminal<'a> {
    pub(crate) fn new(terminal: &'a mut TuiTerminal, mode: ResolvedTerminalMode) -> Self {
        Self { terminal, mode }
    }
}

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
    terminal_session: RunLoopTerminal<'_>,
    rx: &RuntimeReceiver,
    child: &mut Child,
    tx: &mut dyn RuntimeTx,
    pending_initial_message: &mut Option<String>,
) -> Result<(), Box<dyn std::error::Error>> {
    let RunLoopTerminal {
        terminal,
        mode: terminal_mode,
    } = terminal_session;
    let mut needs_redraw = true;
    let mut should_exit = false;
    let mut update_choice_size = None;
    let key_debug = std::env::var("CODELIA_TUI_KEY_DEBUG").ok().as_deref() == Some("1");
    let mut last_ctrl_c_at: Option<Instant> = None;
    let mut last_memory_sample_at = Instant::now() - DEBUG_PERF_MEMORY_SAMPLE_INTERVAL;

    loop {
        if process_runtime_messages(app, rx, tx) {
            needs_redraw = true;
        }

        // Runtime dialogs take precedence; worker completion never reopens a
        // preview closed while loading or preempted by another interaction.
        if app.image_preview.is_open() && app.has_interaction_panel() {
            app.image_preview.close();
            needs_redraw = true;
        }
        needs_redraw |= app.image_preview.poll();
        needs_redraw |= crate::app::self_update::poll(app);
        needs_redraw |= crate::app::startup_confirmations::poll(app);
        needs_redraw |= app.poll_clipboard_import();

        maybe_request_skills_catalog(app, tx);

        let startup_pending = app.startup_confirmations.is_pending();
        if !startup_pending
            && pending_initial_message.is_some()
            && can_auto_start_initial_message(app)
        {
            if let Some(message) = pending_initial_message.take() {
                if crate::app::handlers::command::start_prompt_run(app, tx, &message) {
                    app.clear_composer();
                }
                needs_redraw = true;
            }
        }

        if !startup_pending && crate::app::handlers::command::try_dispatch_queued_prompt(app, tx) {
            needs_redraw = true;
        }

        if let Ok(Some(status)) = child.try_wait() {
            app.push_line(LogKind::Runtime, format!("runtime exited: {}", status));
            needs_redraw = true;
            should_exit = true;
        }

        // Paint runtime dialogs and the current selection before routing another key.
        if needs_redraw {
            let frame_started = Instant::now();
            let inline_scrollback = terminal_mode.uses_inline_scrollback();
            let size_before = if app
                .pick_dialog
                .as_ref()
                .is_some_and(|pick| pick.local_update_picker)
            {
                terminal.size().ok()
            } else {
                None
            };
            let outcome = with_synchronized_update(terminal, |terminal| {
                draw_frame(terminal, app, inline_scrollback)
            })?;
            update_choice_size = size_before.filter(|size| {
                app.render_state.drawn_update_choice.is_some()
                    && terminal.size().ok() == Some(*size)
            });
            app.record_perf_frame(frame_started.elapsed(), outcome.draw_elapsed);
            if activate_pending_confirm_dialog(app) {
                needs_redraw = true;
                continue;
            }
            needs_redraw = outcome.request_redraw;
            app.assert_render_invariants();
        }
        if should_exit {
            break;
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
                    if app.image_preview.handle_key(key.code, key.modifiers) {
                        last_ctrl_c_at = None;
                        needs_redraw = true;
                        continue;
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
                        if handle_ctrl_c(app, tx) {
                            last_ctrl_c_at = Some(now);
                            needs_redraw = true;
                            continue;
                        }
                        break;
                    }

                    last_ctrl_c_at = None;

                    if key.code == KeyCode::Enter
                        && app.render_state.drawn_update_choice.is_some()
                        && (update_choice_size.is_none()
                            || terminal.size().ok() != update_choice_size)
                    {
                        app.render_state.drawn_update_choice = None;
                    }
                    if let Some(redraw) = handle_non_main_key(app, key.code, key.modifiers, tx) {
                        apply_redraw(&mut needs_redraw, redraw);
                    } else if !startup_pending
                        && handle_main_key(app, key.code, key.modifiers, terminal, tx)
                    {
                        app.prune_unreferenced_attachments();
                        needs_redraw = true;
                    }
                }
                Event::Paste(text) => {
                    if (startup_pending && app.prompt_dialog.is_none()) || blocks_input_paste(app) {
                        continue;
                    }
                    if handle_paste(app, &text) {
                        app.prune_unreferenced_attachments();
                        apply_redraw(&mut needs_redraw, true);
                    }
                }
                Event::Mouse(mouse) => {
                    let redraw = handle_mouse_event(
                        app,
                        mouse,
                        terminal_mode == ResolvedTerminalMode::Alternate,
                        needs_redraw,
                    );
                    apply_redraw(&mut needs_redraw, redraw);
                }
                Event::Resize(_, _) => {
                    app.render_state.drawn_update_choice = None;
                    app.clear_text_selection();
                    needs_redraw = true;
                }
                _ => {}
            }
        }

        let now = Instant::now();
        if !startup_pending && crate::app::goal::tick(app, tx, now) {
            needs_redraw = true;
        }
        if app.update_spinner(now) {
            needs_redraw = true;
        }
        if app.expire_selection_notice(now) {
            needs_redraw = true;
        }
        if app.debug_perf_enabled
            && now.duration_since(last_memory_sample_at) >= DEBUG_PERF_MEMORY_SAMPLE_INTERVAL
        {
            last_memory_sample_at = now;
            if app.record_memory_sample(sample_memory(Some(child.id()))) {
                needs_redraw = true;
            }
        }
    }

    Ok(())
}
