use super::{input, runtime};
use crate::app::effect::Effect;
use crate::app::runtime::{RuntimeMsg, RuntimeTx};
use crate::app::self_update::{self, UpdateControlCompletion};
use crate::app::state::LogKind;
use crate::app::util::{attachments::ImportedBatch, PerfMemorySample};
use crate::app::AppState;
use crossterm::event::{Event, KeyCode, KeyEventKind, KeyModifiers};
use std::time::{Duration, Instant};

const CTRL_C_FORCE_QUIT_WINDOW: Duration = Duration::from_secs(2);

#[derive(Debug, Default, Clone, Copy, PartialEq, Eq)]
pub(crate) enum ExitAction {
    #[default]
    None,
    DrawThenExit,
    ExitNow,
}

#[derive(Default)]
pub(crate) struct UpdateResult {
    pub(crate) effects: Vec<Effect>,
    pub(crate) needs_redraw: bool,
    pub(crate) exit: ExitAction,
    pub(crate) skip_post_input_tick: bool,
}

pub(crate) enum Msg<'a> {
    Runtime(RuntimeMsg),
    Local(LocalMsg),
    PreDrawTick {
        startup_pending: bool,
        pending_initial_message: &'a mut Option<String>,
    },
    Terminal(TerminalInput),
    PostInputTick {
        now: Instant,
        startup_pending: bool,
    },
}

pub(crate) enum LocalMsg {
    PollImagePreview,
    UpdateControl(UpdateControlCompletion),
    PollStartupConfirmations,
    ClipboardImportStarted(Result<String, String>),
    ClipboardImported {
        marker: String,
        result: Result<ImportedBatch, String>,
    },
    ClipboardWritten {
        result: Result<usize, String>,
        now: Instant,
    },
    RuntimeExited(String),
    MemorySample(PerfMemorySample),
}

pub(crate) struct TerminalInput {
    pub(crate) event: Event,
    pub(crate) now: Instant,
    pub(crate) startup_pending: bool,
    pub(crate) owned_selection_enabled: bool,
    pub(crate) frame_dirty: bool,
    pub(crate) update_choice_size_matches: bool,
}

pub(crate) fn update(app: &mut AppState, msg: Msg<'_>, tx: &mut dyn RuntimeTx) -> UpdateResult {
    let mut result = UpdateResult::default();
    result.needs_redraw = match msg {
        Msg::Runtime(msg) => runtime::apply_runtime_msg(app, msg, tx),
        Msg::Local(msg) => apply_local(app, msg, &mut result),
        Msg::PreDrawTick {
            startup_pending,
            pending_initial_message,
        } => {
            input::maybe_request_skills_catalog(app, tx);
            if startup_pending {
                return result;
            }

            let mut started = false;
            if runtime::can_auto_start_initial_message(app) {
                if let Some(message) = pending_initial_message.take() {
                    if crate::app::handlers::command::start_prompt_run(app, tx, &message) {
                        app.clear_composer();
                    }
                    started = true;
                }
            }
            let dispatched = crate::app::handlers::command::try_dispatch_queued_prompt(app, tx);
            started || dispatched
        }
        Msg::Terminal(input) => apply_terminal(app, input, tx, &mut result),
        Msg::PostInputTick {
            now,
            startup_pending,
        } => {
            let mut redraw = !startup_pending && crate::app::goal::tick(app, tx, now);
            redraw |= app.update_spinner(now);
            redraw |= app.expire_selection_notice(now);
            redraw
        }
    };
    result
}

fn apply_local(app: &mut AppState, msg: LocalMsg, result: &mut UpdateResult) -> bool {
    match msg {
        LocalMsg::PollImagePreview => {
            // A completed worker cannot reopen a preempted preview.
            let preempted = app.image_preview.is_open() && app.has_interaction_panel();
            if preempted {
                app.image_preview.close();
            }
            let changed = app.image_preview.poll();
            preempted || changed
        }
        LocalMsg::UpdateControl(completion) => {
            self_update::apply_completion(app, completion);
            true
        }
        LocalMsg::PollStartupConfirmations => crate::app::startup_confirmations::poll(app),
        LocalMsg::ClipboardImportStarted(result) => {
            app.apply_clipboard_import_start(result);
            true
        }
        LocalMsg::ClipboardImported { marker, result } => {
            app.complete_clipboard_import(&marker, result);
            true
        }
        LocalMsg::ClipboardWritten { result, now } => {
            let notice = match result {
                Ok(chars) => format!("Copied {chars} chars"),
                Err(error) => format!("Copy failed: {error}"),
            };
            app.set_selection_notice(notice, now);
            true
        }
        LocalMsg::RuntimeExited(status) => {
            app.push_line(LogKind::Runtime, format!("runtime exited: {status}"));
            result.exit = ExitAction::DrawThenExit;
            true
        }
        LocalMsg::MemorySample(sample) => app.record_memory_sample(sample),
    }
}

fn apply_terminal(
    app: &mut AppState,
    input: TerminalInput,
    tx: &mut dyn RuntimeTx,
    result: &mut UpdateResult,
) -> bool {
    match input.event {
        Event::Key(key) => {
            if key.kind != KeyEventKind::Press {
                result.skip_post_input_tick = true;
                return false;
            }
            if app.image_preview.handle_key(key.code, key.modifiers) {
                app.last_ctrl_c_at = None;
                result.skip_post_input_tick = true;
                return true;
            }
            if key.code == KeyCode::Char('c') && key.modifiers.contains(KeyModifiers::CONTROL) {
                result.skip_post_input_tick = true;
                if app.last_ctrl_c_at.is_some_and(|previous| {
                    input.now.duration_since(previous) <= CTRL_C_FORCE_QUIT_WINDOW
                }) {
                    app.push_line(LogKind::Status, "Force quitting...");
                } else if input::handle_ctrl_c(app, tx) {
                    app.last_ctrl_c_at = Some(input.now);
                    return true;
                }
                result.exit = ExitAction::ExitNow;
                return false;
            }
            app.last_ctrl_c_at = None;
            if key.code == KeyCode::Enter && !input.update_choice_size_matches {
                app.render_state.drawn_update_choice = None;
            }
            if let Some(redraw) =
                input::handle_non_main_key(app, key.code, key.modifiers, tx, &mut result.effects)
            {
                redraw
            } else if !input.startup_pending
                && input::handle_main_key(
                    app,
                    key.code,
                    key.modifiers,
                    tx,
                    &mut result.effects,
                    input.now,
                )
            {
                app.prune_unreferenced_attachments();
                true
            } else {
                false
            }
        }
        Event::Paste(text) => {
            let redraw = input::handle_paste(app, &text, input.startup_pending);
            if redraw {
                app.prune_unreferenced_attachments();
            }
            redraw
        }
        Event::Mouse(mouse) => input::handle_mouse_event(
            app,
            mouse,
            input.owned_selection_enabled,
            input.frame_dirty,
            &mut result.effects,
            input.now,
        ),
        Event::Resize(_, _) => {
            app.render_state.drawn_update_choice = None;
            app.clear_text_selection();
            true
        }
        _ => false,
    }
}
