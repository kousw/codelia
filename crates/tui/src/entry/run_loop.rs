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
use std::collections::VecDeque;
use std::io;
use std::process::Child;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{mpsc, Arc};
use std::thread;
use std::time::{Duration, Instant};

const DEBUG_PERF_MEMORY_SAMPLE_INTERVAL: Duration = Duration::from_secs(1);
const EVENT_POLL_TIMEOUT: Duration = Duration::from_millis(50);
const INPUT_THREAD_POLL_SLICE: Duration = Duration::from_millis(25);

enum WakeEvent {
    Terminal(io::Result<Event>),
    Runtime,
    ClipboardWritten(Result<usize, String>),
}

/// Unified wakeup channel bridging runtime reader threads, async clipboard
/// writes, and the terminal input thread so `run_loop` wakes in <1ms on any
/// arrival instead of stalling up to `EVENT_POLL_TIMEOUT`.
pub(crate) struct WakeHub {
    tx: mpsc::Sender<WakeEvent>,
    rx: mpsc::Receiver<WakeEvent>,
    runtime_pending: Arc<AtomicBool>,
}

impl WakeHub {
    pub(crate) fn new() -> Self {
        let (tx, rx) = mpsc::channel();
        Self {
            tx,
            rx,
            runtime_pending: Arc::new(AtomicBool::new(false)),
        }
    }

    pub(crate) fn runtime_notifier(&self) -> Arc<dyn Fn() + Send + Sync> {
        let tx = self.tx.clone();
        let pending = Arc::clone(&self.runtime_pending);
        Arc::new(move || {
            if !pending.swap(true, Ordering::AcqRel) {
                let _ = tx.send(WakeEvent::Runtime);
            }
        })
    }
}

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
    wake_hub: WakeHub,
) -> Result<(), Box<dyn std::error::Error>> {
    let mut io = ProductionIo::new(child, wake_hub)?;
    run_loop(
        app,
        terminal_session.terminal,
        terminal_session.mode,
        rx,
        tx,
        pending_initial_message,
        &mut io,
    )
}

trait LoopIo<B: Backend> {
    fn before_runtime_drain(&mut self) {}
    fn poll_event(
        &mut self,
        terminal: &mut Terminal<B>,
        timeout: Duration,
    ) -> io::Result<Option<Event>>;
    fn poll_local_completions(&mut self) -> Vec<LocalMsg> {
        Vec::new()
    }
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
    wake_tx: mpsc::Sender<WakeEvent>,
    wake_rx: mpsc::Receiver<WakeEvent>,
    runtime_pending: Arc<AtomicBool>,
    has_unread_runtime_wake: bool,
    pending_terminal: VecDeque<io::Result<Event>>,
    pending_local: VecDeque<LocalMsg>,
    input_stop: Arc<AtomicBool>,
    input_thread: Option<thread::JoinHandle<()>>,
    clipboard_tx: Option<mpsc::Sender<String>>,
}

impl<'a> ProductionIo<'a> {
    fn new(child: &'a mut Child, wake_hub: WakeHub) -> io::Result<Self> {
        let input_stop = Arc::new(AtomicBool::new(false));
        let stop_flag = Arc::clone(&input_stop);
        let input_tx = wake_hub.tx.clone();
        let input_thread = thread::Builder::new()
            .name("codelia-tui-input".to_string())
            .spawn(move || {
                while !stop_flag.load(Ordering::Acquire) {
                    match event::poll(INPUT_THREAD_POLL_SLICE) {
                        Ok(true) => {
                            if input_tx.send(WakeEvent::Terminal(event::read())).is_err() {
                                break;
                            }
                        }
                        Ok(false) => {}
                        Err(error) => {
                            let _ = input_tx.send(WakeEvent::Terminal(Err(error)));
                            break;
                        }
                    }
                }
            })?;
        Ok(Self {
            child,
            wake_tx: wake_hub.tx,
            wake_rx: wake_hub.rx,
            runtime_pending: wake_hub.runtime_pending,
            has_unread_runtime_wake: false,
            pending_terminal: VecDeque::new(),
            pending_local: VecDeque::new(),
            input_stop,
            input_thread: Some(input_thread),
            clipboard_tx: None,
        })
    }

    fn drain_ready_wakes(&mut self) {
        while let Ok(item) = self.wake_rx.try_recv() {
            match item {
                WakeEvent::Terminal(ev) => self.pending_terminal.push_back(ev),
                WakeEvent::Runtime => {
                    // Preserve the wake until the next runtime drain; clearing
                    // `runtime_pending` here would drop wakes that arrived after
                    // `drain_runtime_messages` finished.
                    self.has_unread_runtime_wake = true;
                }
                WakeEvent::ClipboardWritten(result) => {
                    self.pending_local.push_back(LocalMsg::ClipboardWritten {
                        result,
                        now: Instant::now(),
                    });
                }
            }
        }
    }

    fn ensure_clipboard_worker(&mut self) -> io::Result<&mpsc::Sender<String>> {
        if self.clipboard_tx.is_none() {
            let (tx, rx) = mpsc::channel::<String>();
            let wake_tx = self.wake_tx.clone();
            spawn_clipboard_worker(rx, wake_tx, |text| {
                write_clipboard_text(text)
                    .map(|_| text.chars().count())
                    .map_err(|error| error.to_string())
            })?;
            self.clipboard_tx = Some(tx);
        }
        Ok(self.clipboard_tx.as_ref().expect("clipboard worker sender"))
    }
}

fn spawn_clipboard_worker<F>(
    rx: mpsc::Receiver<String>,
    wake_tx: mpsc::Sender<WakeEvent>,
    mut writer: F,
) -> io::Result<thread::JoinHandle<()>>
where
    F: FnMut(&str) -> Result<usize, String> + Send + 'static,
{
    thread::Builder::new()
        .name("codelia-clipboard-write".to_string())
        .spawn(move || {
            while let Ok(text) = rx.recv() {
                let result = writer(&text);
                if wake_tx.send(WakeEvent::ClipboardWritten(result)).is_err() {
                    break;
                }
            }
        })
}

impl Drop for ProductionIo<'_> {
    fn drop(&mut self) {
        self.clipboard_tx.take();
        self.input_stop.store(true, Ordering::Release);
        if let Some(handle) = self.input_thread.take() {
            let _ = handle.join();
        }
    }
}

impl LoopIo<TerminalBackend> for ProductionIo<'_> {
    fn before_runtime_drain(&mut self) {
        self.runtime_pending.store(false, Ordering::Release);
        self.has_unread_runtime_wake = false;
    }

    fn poll_event(&mut self, _: &mut TuiTerminal, timeout: Duration) -> io::Result<Option<Event>> {
        if let Some(event) = self.pending_terminal.pop_front() {
            return event.map(Some);
        }
        if self.has_unread_runtime_wake
            || self.runtime_pending.load(Ordering::Acquire)
            || !self.pending_local.is_empty()
        {
            self.has_unread_runtime_wake = false;
            return Ok(None);
        }
        if timeout.is_zero() {
            self.drain_ready_wakes();
            return self.pending_terminal.pop_front().transpose();
        }
        match self.wake_rx.recv_timeout(timeout) {
            Ok(WakeEvent::Terminal(event)) => event.map(Some),
            Ok(WakeEvent::Runtime) => Ok(None),
            Ok(WakeEvent::ClipboardWritten(result)) => {
                self.pending_local.push_back(LocalMsg::ClipboardWritten {
                    result,
                    now: self.now(),
                });
                Ok(None)
            }
            Err(mpsc::RecvTimeoutError::Timeout) | Err(mpsc::RecvTimeoutError::Disconnected) => {
                Ok(None)
            }
        }
    }

    fn poll_local_completions(&mut self) -> Vec<LocalMsg> {
        self.drain_ready_wakes();
        self.pending_local.drain(..).collect()
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
                let send_result = self
                    .ensure_clipboard_worker()
                    .map_err(|error| format!("clipboard worker failed: {error}"))
                    .and_then(|tx| {
                        tx.send(text)
                            .map_err(|_| "clipboard worker channel closed".to_string())
                    });
                if let Err(error) = send_result {
                    self.clipboard_tx = None;
                    return Some(LocalMsg::ClipboardWritten {
                        result: Err(error),
                        now: self.now(),
                    });
                }
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

struct LoopState {
    needs_redraw: bool,
    exit: ExitAction,
    pending_mouse_capture: Option<Effect>,
    update_choice_size: Option<ratatui::layout::Size>,
    last_memory_sample_at: Instant,
    was_debug_perf_enabled: bool,
}

impl LoopState {
    fn new(now: Instant, debug_perf_enabled: bool) -> Self {
        Self {
            needs_redraw: true,
            exit: ExitAction::None,
            pending_mouse_capture: None,
            update_choice_size: None,
            last_memory_sample_at: now - DEBUG_PERF_MEMORY_SAMPLE_INTERVAL,
            was_debug_perf_enabled: debug_perf_enabled,
        }
    }

    fn apply<B: Backend, I: LoopIo<B>>(
        &mut self,
        terminal: &mut Terminal<B>,
        app: &mut AppState,
        tx: &mut dyn RuntimeTx,
        io: &mut I,
        result: UpdateResult,
    ) -> bool {
        if result.exit == ExitAction::ExitNow {
            self.exit = ExitAction::ExitNow;
            return true;
        }
        if result.exit == ExitAction::DrawThenExit {
            self.exit = ExitAction::DrawThenExit;
        }
        self.needs_redraw |= result.needs_redraw;
        for effect in result.effects {
            if matches!(effect, Effect::SetMouseCapture(_)) {
                // Keep terminal mode writes next to the draw they affect.
                self.pending_mouse_capture = Some(effect);
            } else {
                self.execute_effect(terminal, app, tx, io, effect);
            }
        }
        false
    }

    fn execute_effect<B: Backend, I: LoopIo<B>>(
        &mut self,
        terminal: &mut Terminal<B>,
        app: &mut AppState,
        tx: &mut dyn RuntimeTx,
        io: &mut I,
        effect: Effect,
    ) {
        let started = io.now();
        let completion = io.execute(terminal, app, effect);
        app.perf.record_effect(io.now().duration_since(started));
        if let Some(completion) = completion {
            let nested = update(app, Msg::Local(completion), tx);
            debug_assert!(nested.effects.is_empty());
            if nested.exit != ExitAction::None {
                self.exit = nested.exit;
            }
            self.needs_redraw |= nested.needs_redraw;
        }
    }

    fn dispatch<B: Backend, I: LoopIo<B>>(
        &mut self,
        terminal: &mut Terminal<B>,
        app: &mut AppState,
        tx: &mut dyn RuntimeTx,
        io: &mut I,
        msg: Msg<'_>,
    ) -> bool {
        let result = update(app, msg, tx);
        self.apply(terminal, app, tx, io, result)
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
    let mut state = LoopState::new(io.now(), app.debug_perf_enabled);

    loop {
        let active_started = io.now();
        let mut active_work = false;
        io.before_runtime_drain();
        let drain = drain_runtime_messages(app, rx, tx, |app, msg, tx| {
            let result = update(app, Msg::Runtime(msg), tx);
            let redraw = result.needs_redraw;
            let _ = state.apply(terminal, app, tx, io, result);
            redraw
        });
        state.needs_redraw |= drain.needs_redraw;
        active_work |= drain.needs_redraw;
        let _ = state.dispatch(
            terminal,
            app,
            tx,
            io,
            Msg::Local(LocalMsg::PollImagePreview),
        );
        if let Some(completion) = self_update::poll(app) {
            let _ = state.dispatch(
                terminal,
                app,
                tx,
                io,
                Msg::Local(LocalMsg::UpdateControl(completion)),
            );
        }
        let _ = state.dispatch(
            terminal,
            app,
            tx,
            io,
            Msg::Local(LocalMsg::PollStartupConfirmations),
        );
        for (marker, result) in app.clipboard_import.poll() {
            let _ = state.dispatch(
                terminal,
                app,
                tx,
                io,
                Msg::Local(LocalMsg::ClipboardImported { marker, result }),
            );
        }
        for local_msg in io.poll_local_completions() {
            active_work = true;
            let _ = state.dispatch(terminal, app, tx, io, Msg::Local(local_msg));
        }

        let startup_pending = app.startup_confirmations.is_pending();
        let _ = state.dispatch(
            terminal,
            app,
            tx,
            io,
            Msg::PreDrawTick {
                startup_pending,
                pending_initial_message,
            },
        );
        if state.exit == ExitAction::ExitNow {
            break;
        }
        if state.exit == ExitAction::None {
            if let Some(status) = io.child_exit() {
                let _ = state.dispatch(
                    terminal,
                    app,
                    tx,
                    io,
                    Msg::Local(LocalMsg::RuntimeExited(status)),
                );
            }
        }

        if let Some(effect) = state.pending_mouse_capture.take() {
            state.execute_effect(terminal, app, tx, io, effect);
        }

        if state.needs_redraw {
            active_work = true;
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
            state.update_choice_size = size_before.filter(|size| {
                app.render_state.drawn_update_choice.is_some()
                    && terminal.size().ok() == Some(*size)
            });
            app.record_perf_frame(io.now().duration_since(frame_started), outcome.draw_elapsed);
            if activate_pending_confirm_dialog(app) {
                state.needs_redraw = true;
                app.perf
                    .record_tick(io.now().duration_since(active_started));
                continue;
            }
            state.needs_redraw = outcome.request_redraw;
            app.assert_render_invariants();
        }
        if active_work {
            app.perf
                .record_tick(io.now().duration_since(active_started));
        }
        if state.exit == ExitAction::DrawThenExit {
            break;
        }

        let mut post_poll_work = false;
        let mut post_poll_started = io.now();
        let poll_timeout = if drain.hit_cap {
            Duration::ZERO
        } else {
            EVENT_POLL_TIMEOUT
        };
        if let Some(event) = io.poll_event(terminal, poll_timeout)? {
            post_poll_started = io.now();
            post_poll_work = true;
            if let Some(line) = format_debug_key_event(app, &event) {
                if !crate::app::util::debug::append_debug_file_line("tui-keys.log", &line) {
                    app.push_line(crate::app::state::LogKind::Status, line);
                    state.needs_redraw = true;
                }
            }
            let update_choice_size_matches = !matches!(
                &event, Event::Key(key) if key.kind == KeyEventKind::Press && key.code == KeyCode::Enter
            ) || app.image_preview.is_open()
                || app.render_state.drawn_update_choice.is_none()
                || (state.update_choice_size.is_some()
                    && terminal.size().ok() == state.update_choice_size);
            let input = TerminalInput {
                event,
                now: io.now(),
                startup_pending,
                owned_selection_enabled: mode == ResolvedTerminalMode::Alternate,
                frame_dirty: state.needs_redraw,
                update_choice_size_matches,
            };
            let result = update(app, Msg::Terminal(input), tx);
            let skip_post_input_tick = result.skip_post_input_tick;
            if state.apply(terminal, app, tx, io, result) {
                break;
            }
            if skip_post_input_tick {
                app.perf
                    .record_tick(io.now().duration_since(post_poll_started));
                continue;
            }
        }

        let now = io.now();
        let _ = state.dispatch(
            terminal,
            app,
            tx,
            io,
            Msg::PostInputTick {
                now,
                startup_pending,
            },
        );
        if app.debug_perf_enabled && !state.was_debug_perf_enabled {
            state.last_memory_sample_at = now - DEBUG_PERF_MEMORY_SAMPLE_INTERVAL;
        }
        state.was_debug_perf_enabled = app.debug_perf_enabled;
        if app.debug_perf_enabled
            && now.duration_since(state.last_memory_sample_at) >= DEBUG_PERF_MEMORY_SAMPLE_INTERVAL
        {
            state.last_memory_sample_at = now;
            let sample = io.memory_sample();
            let _ = state.dispatch(
                terminal,
                app,
                tx,
                io,
                Msg::Local(LocalMsg::MemorySample(sample)),
            );
        }
        if post_poll_work {
            app.perf
                .record_tick(io.now().duration_since(post_poll_started));
        }
    }

    Ok(())
}

fn format_debug_key_event(app: &AppState, event: &Event) -> Option<String> {
    if !crate::app::util::debug::debug_config().keys {
        return None;
    }
    format_key_trace_line(app, event)
}

fn format_key_trace_line(app: &AppState, event: &Event) -> Option<String> {
    if app
        .overlays
        .runtime_dialogs
        .prompt
        .as_ref()
        .is_some_and(|prompt| prompt.state.secret)
    {
        return None;
    }
    let Event::Key(key) = event else {
        return None;
    };
    if key.kind != KeyEventKind::Press {
        return None;
    }
    Some(format!(
        "key: code={:?} mods={:?} kind={:?}",
        key.code, key.modifiers, key.kind
    ))
}

#[cfg(test)]
mod tests;
