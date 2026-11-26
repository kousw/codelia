use crate::app::effect::Effect;
use crate::app::frame::{draw_frame, DrawOutcome};
use crate::app::handlers::confirm::activate_pending_confirm_dialog;
use crate::app::runtime::RuntimeTx;
use crate::app::self_update;
use crate::app::util::{sample_memory, write_clipboard_text, PerfMemorySample};
use crate::app::{AppState, LocalPanel};
use crate::entry::terminal::{
    set_mouse_capture, with_synchronized_update, TerminalBackend, TuiTerminal,
};
use crate::entry::terminal_mode::ResolvedTerminalMode;
use crate::event_loop::runtime::{drain_runtime_messages, RuntimeReceiver};
use crate::event_loop::update::{update, ExitAction, LocalMsg, Msg, TerminalInput, UpdateResult};
use crossterm::event::{self, Event, KeyCode, KeyEventKind};
use ratatui::{backend::Backend, Terminal};
use std::io;
use std::process::Child;
use std::time::{Duration, Instant};

const DEBUG_PERF_MEMORY_SAMPLE_INTERVAL: Duration = Duration::from_secs(1);
const EVENT_POLL_TIMEOUT: Duration = Duration::from_millis(50);

pub(crate) struct RunLoopTerminal<'a> {
    terminal: &'a mut TuiTerminal,
    mode: ResolvedTerminalMode,
}

impl<'a> RunLoopTerminal<'a> {
    pub(crate) fn new(terminal: &'a mut TuiTerminal, mode: ResolvedTerminalMode) -> Self {
        Self { terminal, mode }
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
    run_loop(
        app,
        terminal_session.terminal,
        terminal_session.mode,
        rx,
        tx,
        pending_initial_message,
        &mut ProductionIo {
            child,
            key_debug: std::env::var("CODELIA_TUI_KEY_DEBUG").ok().as_deref() == Some("1"),
        },
    )
}

trait LoopIo<B: Backend> {
    fn poll_event(
        &mut self,
        terminal: &mut Terminal<B>,
        timeout: Duration,
    ) -> io::Result<Option<Event>>;
    fn child_exit(&mut self) -> Option<String>;
    fn child_pid(&self) -> u32;
    fn now(&self) -> Instant;
    fn memory_sample(&mut self) -> PerfMemorySample {
        sample_memory(Some(self.child_pid()))
    }
    fn execute(
        &mut self,
        terminal: &mut Terminal<B>,
        app: &mut AppState,
        effect: Effect,
    ) -> Option<LocalMsg>;
    fn synchronized_draw(
        &mut self,
        terminal: &mut Terminal<B>,
        draw: impl FnOnce(&mut Terminal<B>) -> Result<DrawOutcome, B::Error>,
    ) -> Result<DrawOutcome, B::Error>;
}

struct ProductionIo<'a> {
    child: &'a mut Child,
    key_debug: bool,
}

impl LoopIo<TerminalBackend> for ProductionIo<'_> {
    fn poll_event(&mut self, _: &mut TuiTerminal, timeout: Duration) -> io::Result<Option<Event>> {
        if !event::poll(timeout)? {
            return Ok(None);
        }
        let event = event::read()?;
        if self.key_debug {
            if let Event::Key(key) = &event {
                if key.kind == KeyEventKind::Press {
                    eprintln!(
                        "key: code={:?} mods={:?} kind={:?}",
                        key.code, key.modifiers, key.kind
                    );
                }
            }
        }
        Ok(Some(event))
    }

    fn child_exit(&mut self) -> Option<String> {
        self.child
            .try_wait()
            .ok()
            .flatten()
            .map(|status| status.to_string())
    }

    fn child_pid(&self) -> u32 {
        self.child.id()
    }

    fn now(&self) -> Instant {
        Instant::now()
    }

    fn execute(
        &mut self,
        terminal: &mut TuiTerminal,
        app: &mut AppState,
        effect: Effect,
    ) -> Option<LocalMsg> {
        match effect {
            Effect::SetMouseCapture(enabled) => set_mouse_capture(terminal, enabled),
            Effect::WriteClipboard { text } => {
                let result = write_clipboard_text(&text)
                    .map(|_| text.chars().count())
                    .map_err(|error| error.to_string());
                return Some(LocalMsg::ClipboardWritten {
                    result,
                    now: self.now(),
                });
            }
            Effect::StartClipboardImport => {
                return Some(LocalMsg::ClipboardImportStarted(
                    app.start_clipboard_import(),
                ));
            }
            Effect::StartUpdateControl(action) => self_update::start(app, action),
        }
        None
    }

    fn synchronized_draw(
        &mut self,
        terminal: &mut TuiTerminal,
        draw: impl FnOnce(&mut TuiTerminal) -> Result<DrawOutcome, io::Error>,
    ) -> Result<DrawOutcome, io::Error> {
        with_synchronized_update(terminal, draw)
    }
}

fn run_loop<B: Backend, I: LoopIo<B>>(
    app: &mut AppState,
    terminal: &mut Terminal<B>,
    mode: ResolvedTerminalMode,
    rx: &RuntimeReceiver,
    tx: &mut dyn RuntimeTx,
    pending_initial_message: &mut Option<String>,
    io: &mut I,
) -> Result<(), Box<dyn std::error::Error>>
where
    B::Error: 'static,
{
    app.last_ctrl_c_at = None;
    let mut needs_redraw = true;
    let mut exit = ExitAction::None;
    let mut pending_mouse_capture = None;
    let mut update_choice_size = None;
    let mut last_memory_sample_at = io.now() - DEBUG_PERF_MEMORY_SAMPLE_INTERVAL;

    let apply_result = |terminal: &mut Terminal<B>,
                        app: &mut AppState,
                        tx: &mut dyn RuntimeTx,
                        io: &mut I,
                        pending_mouse_capture: &mut Option<Effect>,
                        needs_redraw: &mut bool,
                        exit: &mut ExitAction,
                        result: UpdateResult|
     -> bool {
        if result.exit == ExitAction::ExitNow {
            *exit = ExitAction::ExitNow;
            return true;
        }
        if result.exit == ExitAction::DrawThenExit {
            *exit = ExitAction::DrawThenExit;
        }
        *needs_redraw |= result.needs_redraw;
        for effect in result.effects {
            if matches!(effect, Effect::SetMouseCapture(_)) {
                // Keep terminal mode writes next to the draw they affect.
                *pending_mouse_capture = Some(effect);
            } else if let Some(completion) = io.execute(terminal, app, effect) {
                let nested = update(app, Msg::Local(completion), tx);
                debug_assert!(nested.effects.is_empty());
                if nested.exit != ExitAction::None {
                    *exit = nested.exit;
                }
                *needs_redraw |= nested.needs_redraw;
            }
        }
        false
    };

    loop {
        needs_redraw |= drain_runtime_messages(app, rx, tx, |app, msg, tx| {
            let result = update(app, Msg::Runtime(msg), tx);
            let redraw = result.needs_redraw;
            let _ = apply_result(
                terminal,
                app,
                tx,
                io,
                &mut pending_mouse_capture,
                &mut needs_redraw,
                &mut exit,
                result,
            );
            redraw
        });
        let result = update(app, Msg::Local(LocalMsg::PollImagePreview), tx);
        let _ = apply_result(
            terminal,
            app,
            tx,
            io,
            &mut pending_mouse_capture,
            &mut needs_redraw,
            &mut exit,
            result,
        );
        if let Some(completion) = self_update::poll(app) {
            let result = update(app, Msg::Local(LocalMsg::UpdateControl(completion)), tx);
            let _ = apply_result(
                terminal,
                app,
                tx,
                io,
                &mut pending_mouse_capture,
                &mut needs_redraw,
                &mut exit,
                result,
            );
        }
        let result = update(app, Msg::Local(LocalMsg::PollStartupConfirmations), tx);
        let _ = apply_result(
            terminal,
            app,
            tx,
            io,
            &mut pending_mouse_capture,
            &mut needs_redraw,
            &mut exit,
            result,
        );
        for (marker, result) in app.clipboard_import.poll() {
            let result = update(
                app,
                Msg::Local(LocalMsg::ClipboardImported { marker, result }),
                tx,
            );
            let _ = apply_result(
                terminal,
                app,
                tx,
                io,
                &mut pending_mouse_capture,
                &mut needs_redraw,
                &mut exit,
                result,
            );
        }

        let startup_pending = app.startup_confirmations.is_pending();
        let result = update(
            app,
            Msg::PreDrawTick {
                startup_pending,
                pending_initial_message,
            },
            tx,
        );
        let _ = apply_result(
            terminal,
            app,
            tx,
            io,
            &mut pending_mouse_capture,
            &mut needs_redraw,
            &mut exit,
            result,
        );
        if exit == ExitAction::None {
            if let Some(status) = io.child_exit() {
                let result = update(app, Msg::Local(LocalMsg::RuntimeExited(status)), tx);
                let _ = apply_result(
                    terminal,
                    app,
                    tx,
                    io,
                    &mut pending_mouse_capture,
                    &mut needs_redraw,
                    &mut exit,
                    result,
                );
            }
        }

        if let Some(effect) = pending_mouse_capture.take() {
            if let Some(completion) = io.execute(terminal, app, effect) {
                let result = update(app, Msg::Local(completion), tx);
                let _ = apply_result(
                    terminal,
                    app,
                    tx,
                    io,
                    &mut pending_mouse_capture,
                    &mut needs_redraw,
                    &mut exit,
                    result,
                );
            }
        }

        if needs_redraw {
            let frame_started = io.now();
            let size_before = if !app.overlays.runtime_dialogs.is_any_open()
                && matches!(app.overlays.local_panel, Some(LocalPanel::UpdatePicker(_)))
            {
                terminal.size().ok()
            } else {
                None
            };
            let outcome = io.synchronized_draw(terminal, |terminal| {
                draw_frame(terminal, app, mode.uses_inline_scrollback())
            })?;
            update_choice_size = size_before.filter(|size| {
                app.render_state.drawn_update_choice.is_some()
                    && terminal.size().ok() == Some(*size)
            });
            app.record_perf_frame(io.now().duration_since(frame_started), outcome.draw_elapsed);
            if activate_pending_confirm_dialog(app) {
                needs_redraw = true;
                continue;
            }
            needs_redraw = outcome.request_redraw;
            app.assert_render_invariants();
        }
        if exit == ExitAction::DrawThenExit {
            break;
        }

        if let Some(event) = io.poll_event(terminal, EVENT_POLL_TIMEOUT)? {
            let update_choice_size_matches = !matches!(
                &event, Event::Key(key) if key.kind == KeyEventKind::Press && key.code == KeyCode::Enter
            ) || app.image_preview.is_open()
                || app.render_state.drawn_update_choice.is_none()
                || (update_choice_size.is_some() && terminal.size().ok() == update_choice_size);
            let input = TerminalInput {
                event,
                now: io.now(),
                startup_pending,
                owned_selection_enabled: mode == ResolvedTerminalMode::Alternate,
                frame_dirty: needs_redraw,
                update_choice_size_matches,
            };
            let result = update(app, Msg::Terminal(input), tx);
            let skip_post_input_tick = result.skip_post_input_tick;
            if apply_result(
                terminal,
                app,
                tx,
                io,
                &mut pending_mouse_capture,
                &mut needs_redraw,
                &mut exit,
                result,
            ) {
                break;
            }
            if skip_post_input_tick {
                continue;
            }
        }

        let now = io.now();
        let result = update(
            app,
            Msg::PostInputTick {
                now,
                startup_pending,
            },
            tx,
        );
        let _ = apply_result(
            terminal,
            app,
            tx,
            io,
            &mut pending_mouse_capture,
            &mut needs_redraw,
            &mut exit,
            result,
        );
        if app.debug_perf_enabled
            && now.duration_since(last_memory_sample_at) >= DEBUG_PERF_MEMORY_SAMPLE_INTERVAL
        {
            last_memory_sample_at = now;
            let sample = io.memory_sample();
            let result = update(app, Msg::Local(LocalMsg::MemorySample(sample)), tx);
            let _ = apply_result(
                terminal,
                app,
                tx,
                io,
                &mut pending_mouse_capture,
                &mut needs_redraw,
                &mut exit,
                result,
            );
        }
    }

    Ok(())
}

#[cfg(test)]
mod tests;
