use super::*;
use crate::app::effect::{UpdateControlAction, UpdateMode};
use crate::app::image_preview::PreviewMode;
use crate::app::runtime::MockRuntimeTx;
use crate::app::state::LogKind;
use crossterm::event::{KeyEvent, KeyModifiers, MouseButton, MouseEvent, MouseEventKind};
use ratatui::backend::TestBackend;
use std::collections::VecDeque;
use std::convert::Infallible;
use std::sync::mpsc;

type TestTerminal = Terminal<TestBackend>;

#[derive(Debug, PartialEq, Eq)]
enum Step {
    Draw,
    Input,
    Sample,
    Effect(Effect),
}

struct TestIo {
    events: VecDeque<Event>,
    frames: Vec<String>,
    steps: Vec<Step>,
    now: Instant,
    resize_at_enter: bool,
    clipboard_error: Option<&'static str>,
    clipboard_import_start: Option<Result<&'static str, &'static str>>,
}

impl TestIo {
    fn new(events: impl IntoIterator<Item = Event>) -> Self {
        Self {
            events: events.into_iter().collect(),
            frames: Vec::new(),
            steps: Vec::new(),
            now: Instant::now(),
            resize_at_enter: false,
            clipboard_error: None,
            clipboard_import_start: None,
        }
    }

    fn run(&mut self, app: &mut AppState, lines: &[&str], initial: Option<&str>) -> MockRuntimeTx {
        let (sender, receiver) = mpsc::channel();
        for line in lines {
            sender.send((*line).into()).unwrap();
        }
        let mut terminal = Terminal::new(TestBackend::new(100, 24)).unwrap();
        let mut tx = MockRuntimeTx::default();
        run_loop(
            app,
            &mut terminal,
            ResolvedTerminalMode::Alternate,
            &receiver,
            &mut tx,
            &mut initial.map(str::to_owned),
            self,
        )
        .unwrap();
        assert!(self.events.is_empty());
        tx
    }
}

impl LoopIo<TestBackend> for TestIo {
    fn poll_event(
        &mut self,
        terminal: &mut TestTerminal,
        timeout: Duration,
    ) -> io::Result<Option<Event>> {
        assert_eq!(timeout, Duration::from_millis(50));
        self.steps.push(Step::Input);
        self.now += Duration::from_millis(50);
        let event = self.events.pop_front().expect("child should have exited");
        if self.resize_at_enter && matches!(&event, Event::Key(k) if k.code == KeyCode::Enter) {
            terminal.backend_mut().resize(99, 24);
        }
        Ok(Some(event))
    }

    fn child_exit(&mut self) -> Option<String> {
        self.events.is_empty().then(|| "exit status: 0".into())
    }

    fn child_pid(&self) -> u32 {
        123
    }

    fn now(&self) -> Instant {
        self.now
    }

    fn memory_sample(&mut self) -> PerfMemorySample {
        self.steps.push(Step::Sample);
        PerfMemorySample::default()
    }

    fn execute(
        &mut self,
        _: &mut TestTerminal,
        _: &mut AppState,
        effect: Effect,
    ) -> Option<LocalMsg> {
        let completion = match &effect {
            Effect::WriteClipboard { text } => {
                let result = self
                    .clipboard_error
                    .map_or_else(|| Ok(text.chars().count()), |msg| Err(msg.into()));
                Some(LocalMsg::ClipboardWritten {
                    result,
                    now: self.now(),
                })
            }
            Effect::StartClipboardImport => self.clipboard_import_start.map(|result| {
                LocalMsg::ClipboardImportStarted(result.map(str::to_owned).map_err(str::to_owned))
            }),
            _ => None,
        };
        self.steps.push(Step::Effect(effect));
        completion
    }

    fn synchronized_draw(
        &mut self,
        terminal: &mut TestTerminal,
        draw: impl FnOnce(&mut TestTerminal) -> Result<DrawOutcome, Infallible>,
    ) -> Result<DrawOutcome, Infallible> {
        self.steps.push(Step::Draw);
        let outcome = draw(terminal)?;
        self.frames.push(
            terminal
                .backend()
                .buffer()
                .content
                .iter()
                .map(|cell| cell.symbol())
                .collect(),
        );
        Ok(outcome)
    }
}

fn key(code: KeyCode) -> Event {
    Event::Key(KeyEvent::new(code, KeyModifiers::NONE))
}

fn ctrl_c() -> Event {
    Event::Key(KeyEvent::new(KeyCode::Char('c'), KeyModifiers::CONTROL))
}

const CONFIRM: &str = r#"{"jsonrpc":"2.0","id":"confirm-1","method":"ui.confirm.request","params":{"title":"Phase five confirmation","message":"Proceed?"}}"#;

#[test]
fn pre_draw_tick_starts_initial_run_and_post_input_tick_follows_input() {
    let mut io = TestIo::new([key(KeyCode::Char('x'))]);
    let mut app = AppState {
        debug_perf_enabled: true,
        ..AppState::default()
    };
    let tx = io.run(&mut app, &[], Some("initial prompt"));
    assert_eq!(tx.sent[0]["method"], "run.start");
    assert!(io.frames[0].contains("initial prompt"));
    assert!(!io.frames[0].contains("❯ x"));
    assert_eq!(app.input.current(), "x");
    assert_eq!(
        io.steps,
        [Step::Draw, Step::Input, Step::Sample, Step::Draw]
    );
}

#[test]
fn release_preview_key_and_single_ctrl_c_skip_post_input_tick() {
    for kind in ["release", "preview", "ctrl-c"] {
        let mut app = AppState {
            debug_perf_enabled: true,
            ..AppState::default()
        };
        let event = match kind {
            "release" => Event::Key(KeyEvent::new_with_kind(
                KeyCode::Char('x'),
                KeyModifiers::NONE,
                KeyEventKind::Release,
            )),
            "preview" => {
                app.image_preview.mode = Some(PreviewMode::Small);
                key(KeyCode::Esc)
            }
            "ctrl-c" => {
                app.runtime_info.active_run_id = Some("active".into());
                ctrl_c()
            }
            _ => unreachable!(),
        };
        let mut io = TestIo::new([event]);
        app.run_status = Some("running".into());
        app.spinner_last_tick = io.now - Duration::from_millis(200);
        let tx = io.run(&mut app, &[], None);
        assert_eq!(io.steps, [Step::Draw, Step::Input, Step::Draw], "{kind}");
        assert_eq!(app.spinner_index, 0, "{kind} must skip PostInputTick");
        assert!(app.input.current().is_empty());
        assert!(!app.image_preview.is_open());
        assert_eq!(tx.sent.len(), usize::from(kind == "ctrl-c"));
    }
}

#[test]
fn blocked_paste_still_runs_post_input_tick() {
    let mut io = TestIo::new([Event::Paste("blocked".into())]);
    let mut app = AppState {
        debug_perf_enabled: true,
        ..AppState::default()
    };
    app.run_status = Some("running".into());
    app.spinner_last_tick = io.now - Duration::from_millis(200);
    let tx = io.run(&mut app, &[CONFIRM], None);
    assert_eq!(
        io.steps,
        [
            Step::Draw,
            Step::Draw,
            Step::Input,
            Step::Sample,
            Step::Draw
        ]
    );
    assert_eq!(
        app.spinner_index, 1,
        "blocked paste must run PostInputTick and advance spinner"
    );
    assert!(app.input.current().is_empty());
    assert!(tx.sent.is_empty());
}

#[test]
fn confirm_is_drawn_on_second_frame_before_the_first_input() {
    let mut io = TestIo::new([key(KeyCode::Char('y'))]);
    let mut app = AppState::default();
    let tx = io.run(&mut app, &[CONFIRM], None);
    assert_eq!(io.steps, [Step::Draw, Step::Draw, Step::Input, Step::Draw]);
    assert!(!io.frames[0].contains("Phase five confirmation"));
    assert!(io.frames[1].contains("Phase five confirmation"));
    assert!(!io.frames[2].contains("Phase five confirmation"));
    assert_eq!(
        tx.sent,
        [
            serde_json::json!({"jsonrpc":"2.0","id":"confirm-1","result":{"ok":true,"remember":false}})
        ]
    );
}

#[test]
fn confirm_promotion_with_child_exit_draws_twice_and_logs_exit_once() {
    let mut io = TestIo::new([]);
    let mut app = AppState {
        enable_debug_print: true,
        ..AppState::default()
    };
    let tx = io.run(&mut app, &[CONFIRM], None);
    assert_eq!(io.steps, [Step::Draw, Step::Draw]);
    assert!(tx.sent.is_empty());
    let exit_logs = app
        .log
        .iter()
        .filter(|line| line.plain_text() == "runtime exited: exit status: 0")
        .count();
    assert_eq!(exit_logs, 1);
    assert!(io.frames[1].contains("Phase five confirmation"));
    assert!(io.frames[1].contains("runtime exited: exit status: 0"));
}

#[test]
fn runtime_exit_draws_final_frame_and_second_ctrl_c_exits_without_drawing() {
    let mut io = TestIo::new([]);
    let mut app = AppState {
        enable_debug_print: true,
        ..AppState::default()
    };
    io.run(&mut app, &[], None);
    assert_eq!(io.steps, [Step::Draw]);
    assert!(io.frames[0].contains("runtime exited: exit status: 0"));

    let mut io = TestIo::new([ctrl_c(), ctrl_c()]);
    app.runtime_info.active_run_id = Some("active".into());
    let tx = io.run(&mut app, &[], None);
    assert_eq!(io.steps, [Step::Draw, Step::Input, Step::Draw, Step::Input]);
    assert_eq!(tx.sent.len(), 1);
    assert_eq!(tx.sent[0]["method"], "run.cancel");
    assert_eq!(app.log.last().unwrap().plain_text(), "Force quitting...");
    assert!(io.frames.iter().all(|f| !f.contains("Force quitting")));
}

#[test]
fn update_picker_requires_a_drawn_choice_in_the_current_size() {
    for resized in [false, true] {
        let mut app = AppState {
            update_control_launcher: self_update::LauncherPaths::new(
                std::env::temp_dir().join("node"),
                std::env::temp_dir().join("cli"),
            ),
            ..AppState::default()
        };
        app.overlays.local_panel = Some(LocalPanel::UpdatePicker(self_update::startup_picker()));
        let mut io = TestIo::new([key(KeyCode::Enter)]);
        io.resize_at_enter = resized;
        let tx = io.run(&mut app, &[], None);
        assert!(tx.sent.is_empty());
        assert!(app.pending_update_control.is_none());
        assert_eq!(app.overlays.local_panel.is_some(), resized);
        let saves = io
            .steps
            .iter()
            .filter(|step| {
                **step
                    == Step::Effect(Effect::StartUpdateControl(UpdateControlAction::Save(
                        UpdateMode::Notify,
                    )))
            })
            .count();
        assert_eq!(saves, usize::from(!resized));
    }
}

#[test]
fn resize_message_clears_drawn_choice_and_selection_before_the_next_draw() {
    let mut app = AppState::default();
    let mut tx = MockRuntimeTx::default();
    app.overlays.local_panel = Some(LocalPanel::UpdatePicker(self_update::startup_picker()));
    app.render_state.drawn_update_choice = Some(("local:startup:update-mode".into(), 0));
    let now = Instant::now();
    app.set_selection_notice("old selection", now);
    let input = |event| {
        Msg::Terminal(TerminalInput {
            event,
            now,
            startup_pending: false,
            owned_selection_enabled: true,
            frame_dirty: false,
            update_choice_size_matches: true,
        })
    };
    assert!(update(&mut app, input(Event::Resize(99, 24)), &mut tx).needs_redraw);
    assert!(app.render_state.drawn_update_choice.is_none());
    assert!(app.selection_notice.is_none());
    assert!(update(&mut app, input(key(KeyCode::Enter)), &mut tx)
        .effects
        .is_empty());
    assert!(app.overlays.local_panel.is_some());
    assert!(tx.sent.is_empty());
}

#[test]
fn f2_synchronizes_mouse_capture_before_draw_and_alt_v_requests_import() {
    use crate::app::state::input::attachments::make_attachment_token;

    for outcome in [Ok("paste-1"), Err("clipboard empty")] {
        let mut io = TestIo::new([
            key(KeyCode::F(2)),
            Event::Key(KeyEvent::new(KeyCode::Char('v'), KeyModifiers::ALT)),
        ]);
        io.clipboard_import_start = Some(outcome);
        let mut app = AppState {
            mouse_capture_enabled: true,
            debug_perf_enabled: true,
            ..AppState::default()
        };
        let tx = io.run(&mut app, &[], None);
        assert_eq!(
            io.steps,
            [
                Step::Draw,
                Step::Input,
                Step::Sample,
                Step::Effect(Effect::SetMouseCapture(false)),
                Step::Draw,
                Step::Input,
                Step::Effect(Effect::StartClipboardImport),
                Step::Draw,
            ]
        );
        assert!(!app.mouse_capture_enabled);
        assert!(tx.sent.is_empty());
        match outcome {
            Ok(marker) => assert_eq!(
                app.input.current(),
                make_attachment_token(&app.composer_nonce, marker)
            ),
            Err(message) => {
                assert!(app.input.current().is_empty());
                assert!(app.log.iter().any(|line| line.plain_text() == message));
            }
        }
    }
}

#[test]
fn owned_selection_copy_requests_clipboard_write_and_applies_result() {
    let mouse = |kind, column| {
        Event::Mouse(MouseEvent {
            kind,
            column,
            row: 0,
            modifiers: KeyModifiers::NONE,
        })
    };
    for error in [None, Some("no clipboard")] {
        let mut app = AppState {
            mouse_capture_enabled: true,
            ..AppState::default()
        };
        app.push_line(LogKind::Assistant, "selectable transcript");
        let mut io = TestIo::new([
            mouse(MouseEventKind::Down(MouseButton::Left), 0),
            mouse(MouseEventKind::Up(MouseButton::Left), 9),
            Event::Key(KeyEvent::new_with_kind(
                KeyCode::Char('x'),
                KeyModifiers::NONE,
                KeyEventKind::Release,
            )),
        ]);
        io.clipboard_error = error;
        let tx = io.run(&mut app, &[], None);
        let text = io
            .steps
            .iter()
            .find_map(|step| match step {
                Step::Effect(Effect::WriteClipboard { text }) => Some(text),
                _ => None,
            })
            .expect("clipboard effect");
        assert_eq!(text, "selectable");
        let expected = error.map_or("Copied 10 chars".into(), |e| format!("Copy failed: {e}"));
        assert!(io.frames[2].contains(&expected), "{}", io.frames[2]);
        assert!(tx.sent.is_empty());
    }
}
