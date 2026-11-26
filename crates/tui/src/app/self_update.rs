use super::effect::{Effect, UpdateControlAction, UpdateMode as Mode};
use super::state::{LogKind, PickDialogItem, UpdatePickerState};
use super::{AppState, LocalPanel};
use serde::Deserialize;
use std::io::{BufRead, BufReader, Read};
use std::path::PathBuf;
use std::process::{Child, Command, Stdio};
use std::sync::mpsc::{self, Receiver, TryRecvError};
use std::thread;
use std::time::{Duration, Instant};

const RESPONSE_LIMIT: u64 = 4096;
const CONTROL_TIMEOUT: Duration = Duration::from_secs(10);
const STARTUP_PICKER_ID: &str = "local:startup:update-mode";

impl Mode {
    const ALL: [Self; 3] = [Self::Notify, Self::Auto, Self::Off];

    fn id(self) -> &'static str {
        match self {
            Self::Notify => "notify",
            Self::Auto => "auto",
            Self::Off => "off",
        }
    }

    fn label(self) -> &'static str {
        match self {
            Self::Notify => "Notify only",
            Self::Auto => "Automatically update",
            Self::Off => "Off",
        }
    }

    fn detail(self) -> &'static str {
        match self {
            Self::Notify => "Check on startup; install only on request.",
            Self::Auto => "Apply detected updates on a later launch when supported.",
            Self::Off => "Disable background checks and automatic installation.",
        }
    }
}

#[derive(Deserialize)]
#[serde(rename_all = "snake_case")]
enum ModeSource {
    Config,
    Environment,
    Disabled,
}

#[derive(Deserialize)]
struct Status {
    current_version: String,
    channel: String,
    candidate: Option<String>,
    saved_mode: Mode,
    effective_mode: Mode,
    mode_source: ModeSource,
    auto_apply_supported: bool,
}

impl Status {
    fn override_note(&self) -> Option<String> {
        match self.mode_source {
            ModeSource::Config => None,
            ModeSource::Environment => Some(format!(
                "CODELIA_AUTO_UPDATE overrides the saved mode ({}) for this environment.",
                self.effective_mode.id(),
            )),
            ModeSource::Disabled => {
                Some("Automatic update checks are disabled in this environment.".to_string())
            }
        }
    }
}

pub(crate) struct PendingUpdateControl {
    child: Child,
    response: Receiver<Option<Status>>,
    started: Instant,
    action: UpdateControlAction,
}

impl Drop for PendingUpdateControl {
    fn drop(&mut self) {
        if !matches!(self.child.try_wait(), Ok(Some(_))) {
            // Best effort on timeout or TUI exit. Reap the child after a successful kill.
            if self.child.kill().is_ok() {
                let _ = self.child.wait();
            }
        }
    }
}

pub(crate) struct LauncherPaths {
    pub(crate) node: PathBuf,
    pub(crate) entry: PathBuf,
}

impl LauncherPaths {
    pub(crate) fn new(node: PathBuf, entry: PathBuf) -> Option<Self> {
        (node.is_absolute() && entry.is_absolute()).then_some(Self { node, entry })
    }
}

fn request(app: &mut AppState, action: UpdateControlAction) -> Option<Effect> {
    if app.pending_update_control.is_some() {
        app.push_line(
            LogKind::Status,
            "An update settings request is already in progress.",
        );
        return None;
    }
    if app.update_control_launcher.is_none() {
        app.push_line(
            LogKind::Error,
            "Update settings require launching the TUI with codelia.",
        );
        return None;
    }
    Some(Effect::StartUpdateControl(action))
}

pub(crate) fn start(app: &mut AppState, action: UpdateControlAction) {
    if app.pending_update_control.is_some() {
        app.push_line(
            LogKind::Status,
            "An update settings request is already in progress.",
        );
        return;
    }
    let Some(paths) = &app.update_control_launcher else {
        app.push_line(
            LogKind::Error,
            "Update settings require launching the TUI with codelia.",
        );
        return;
    };
    let mut command = Command::new(&paths.node);
    command.arg(&paths.entry).arg("update");
    if let UpdateControlAction::Save(mode) = action {
        command.args(["--tui-set-mode", mode.id()]);
    } else {
        command.arg("--tui-status");
    }
    match command
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::null())
        .spawn()
        .and_then(|child| PendingUpdateControl::new(child, action))
    {
        Ok(pending) => app.pending_update_control = Some(pending),
        Err(_) => app.push_line(
            LogKind::Error,
            "Could not start the local update settings helper.",
        ),
    }
}

impl PendingUpdateControl {
    fn new(child: Child, action: UpdateControlAction) -> std::io::Result<Self> {
        let (sender, response) = mpsc::channel();
        let mut pending = Self {
            child,
            response,
            started: Instant::now(),
            action,
        };
        let stdout = pending.child.stdout.take().expect("piped update stdout");
        // Bound the response and don't block the event loop on a pipe read.
        thread::Builder::new()
            .name("codelia-update-control".to_string())
            .spawn(move || {
                let _ = sender.send(decode_status(stdout));
            })?;
        Ok(pending)
    }

    fn poll(&mut self) -> Option<Option<Status>> {
        match self.child.try_wait() {
            Ok(Some(exit)) if exit.success() => match self.response.try_recv() {
                Ok(status) => Some(status),
                Err(TryRecvError::Empty) if self.started.elapsed() < CONTROL_TIMEOUT => None,
                Err(_) => Some(None),
            },
            Ok(None) if self.started.elapsed() < CONTROL_TIMEOUT => None,
            _ => Some(None),
        }
    }
}

pub(crate) fn open(app: &mut AppState, args: &str) -> Option<Effect> {
    if !args.is_empty() {
        app.push_line(LogKind::Error, "usage: /update");
        return None;
    }
    request(app, UpdateControlAction::Status)
}

pub(crate) fn finish_picker(
    app: &mut AppState,
    panel: UpdatePickerState,
    save: bool,
) -> Option<Effect> {
    let effect = if save {
        Mode::ALL
            .get(panel.selected)
            .and_then(|&mode| request(app, UpdateControlAction::Save(mode)))
    } else {
        None
    };
    if panel.startup {
        app.startup_confirmations
            .answer(super::startup_confirmations::StartupConfirmation::UpdateMode);
    }
    effect
}

pub(crate) struct UpdateControlCompletion {
    action: UpdateControlAction,
    status: Option<Status>,
}

pub(crate) fn poll(app: &mut AppState) -> Option<UpdateControlCompletion> {
    let pending = app.pending_update_control.as_mut()?;
    let status = pending.poll()?;
    let action = pending.action;
    app.pending_update_control = None;
    Some(UpdateControlCompletion { action, status })
}

pub(crate) fn apply_completion(app: &mut AppState, completion: UpdateControlCompletion) {
    let saving = matches!(completion.action, UpdateControlAction::Save(_));
    let status = completion.status;
    let Some(status) = status else {
        let message = if saving {
            "Could not confirm the update mode was saved. Check the global config and its permissions."
        } else {
            "Could not read local update settings."
        };
        app.push_line(LogKind::Error, message);
        return;
    };
    if saving {
        app.push_line(
            LogKind::Status,
            format!(
                "Update mode saved: {}. Applies on future launches; no install was started.",
                status.saved_mode.id()
            ),
        );
        if let Some(note) = status.override_note() {
            app.push_line(LogKind::Status, note);
        }
    } else if !app.has_interaction_panel() {
        app.overlays.local_panel = Some(LocalPanel::UpdatePicker(build_picker(&status)));
    } else {
        app.push_line(
            LogKind::Status,
            "Finish the current dialog before opening /update.",
        );
    }
}

fn decode_status(stdout: impl Read) -> Option<Status> {
    let mut bytes = Vec::new();
    BufReader::new(stdout.take(RESPONSE_LIMIT + 1))
        .read_until(b'\n', &mut bytes)
        .ok()?;
    if bytes.len() as u64 > RESPONSE_LIMIT {
        return None;
    }
    serde_json::from_slice(&bytes).ok()
}

fn inline(value: &str) -> String {
    value
        .chars()
        .filter(char::is_ascii_graphic)
        .take(100)
        .collect()
}

fn build_picker(status: &Status) -> UpdatePickerState {
    let candidate = status
        .candidate
        .as_deref()
        .map_or_else(|| "none cached".to_string(), inline);
    let mut message = format!(
        "Current: {}. Update candidate ({}): {}.",
        inline(&status.current_version),
        inline(&status.channel),
        candidate,
    );
    if let Some(note) = status.override_note() {
        message.push('\n');
        message.push_str(&note);
    }
    if !status.auto_apply_supported {
        message.push_str("\nThis installation does not support automatic installs.");
    }
    mode_picker(
        "local:update-mode",
        "Local CLI updates",
        message,
        status.saved_mode,
        false,
    )
}

pub(crate) fn startup_picker() -> UpdatePickerState {
    mode_picker(
        STARTUP_PICKER_ID,
        "Startup setup: CLI updates",
        "Choose how this CLI handles updates on future launches. Esc to decide later. Nothing is installed now.".to_string(),
        Mode::Notify,
        true,
    )
}

fn mode_picker(
    id: &str,
    title: &str,
    message: String,
    selected: Mode,
    startup: bool,
) -> UpdatePickerState {
    UpdatePickerState {
        id: id.to_string(),
        title: title.to_string(),
        message: Some(message),
        items: Mode::ALL
            .into_iter()
            .map(|mode| PickDialogItem {
                id: mode.id().to_string(),
                label: mode.label().to_string(),
                detail: Some(mode.detail().to_string()),
            })
            .collect(),
        selected: Mode::ALL
            .iter()
            .position(|&mode| mode == selected)
            .unwrap_or(0),
        startup,
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::app::handlers::command::handle_enter;
    use crate::app::runtime::MockRuntimeTx;
    use crate::app::startup_confirmations::{self, StartupConfirmations};

    fn launcher() -> LauncherPaths {
        let root = std::env::temp_dir();
        LauncherPaths::new(root.join("node"), root.join("cli.js")).unwrap()
    }

    #[test]
    fn launcher_paths_require_absolute_node_and_entry() {
        let valid = launcher();
        assert!(LauncherPaths::new(PathBuf::from("node"), valid.entry).is_none());
        assert!(LauncherPaths::new(valid.node, PathBuf::from("entry.js")).is_none());
    }

    #[test]
    fn command_emits_status_effect_and_extra_args_show_usage() {
        let mut app = AppState {
            update_control_launcher: Some(launcher()),
            ..AppState::default()
        };
        let mut tx = MockRuntimeTx::default();
        let mut effects = Vec::new();
        app.input.set_from("/update");
        assert!(handle_enter(&mut app, &mut tx, &mut effects));
        assert_eq!(
            effects.pop(),
            Some(Effect::StartUpdateControl(UpdateControlAction::Status))
        );
        assert!(app.input.current().is_empty());
        assert!(app.pending_update_control.is_none());
        app.input.set_from("/update extra");
        assert!(handle_enter(&mut app, &mut tx, &mut effects));
        assert!(effects.is_empty());
        assert!(tx.sent.is_empty());
        assert_eq!(app.log.last().unwrap().plain_text(), "usage: /update");
    }

    #[test]
    fn picker_save_and_cancel_answer_startup_confirmation() {
        for save in [true, false] {
            let mut app = AppState {
                update_control_launcher: Some(launcher()),
                startup_confirmations: StartupConfirmations::from_list(&["update-mode".into()]),
                ..AppState::default()
            };
            assert!(startup_confirmations::poll(&mut app));
            let Some(LocalPanel::UpdatePicker(mut picker)) = app.overlays.local_panel.take() else {
                panic!("expected startup picker");
            };
            picker.selected = 1;
            assert_eq!(
                finish_picker(&mut app, picker, save),
                save.then_some(Effect::StartUpdateControl(UpdateControlAction::Save(
                    Mode::Auto
                ))),
            );
            assert!(app.pending_update_control.is_none());
            assert!(!startup_confirmations::poll(&mut app));
            assert!(!app.startup_confirmations.is_pending());
        }
    }

    fn status() -> Status {
        Status {
            current_version: "1.2.3".into(),
            channel: "latest".into(),
            candidate: Some("1.2.4".into()),
            saved_mode: Mode::Auto,
            effective_mode: Mode::Off,
            mode_source: ModeSource::Environment,
            auto_apply_supported: true,
        }
    }

    #[test]
    fn save_completion_reports_override_and_failure() {
        let mut app = AppState::default();
        let action = UpdateControlAction::Save(Mode::Auto);
        apply_completion(
            &mut app,
            UpdateControlCompletion {
                action,
                status: Some(status()),
            },
        );
        assert!(app.log[0]
            .plain_text()
            .starts_with("Update mode saved: auto."));
        assert!(app.log[1]
            .plain_text()
            .contains("overrides the saved mode (off)"));
        apply_completion(
            &mut app,
            UpdateControlCompletion {
                action,
                status: None,
            },
        );
        let error = app.log.last().unwrap();
        assert_eq!(error.kind(), LogKind::Error);
        assert!(error
            .plain_text()
            .contains("Could not confirm the update mode was saved"));
    }

    #[test]
    fn status_completion_opens_picker_only_without_an_interaction_panel() {
        for busy in [false, true] {
            let mut app = AppState::default();
            if busy {
                app.overlays.local_panel = Some(LocalPanel::UpdatePicker(startup_picker()));
            }
            apply_completion(
                &mut app,
                UpdateControlCompletion {
                    action: UpdateControlAction::Status,
                    status: Some(status()),
                },
            );
            let Some(LocalPanel::UpdatePicker(picker)) = app.overlays.local_panel else {
                panic!("expected update picker");
            };
            assert_eq!(picker.startup, busy);
            if busy {
                assert_eq!(
                    app.log.last().unwrap().plain_text(),
                    "Finish the current dialog before opening /update."
                );
            } else {
                assert_eq!(picker.selected, 1);
                assert!(picker.message.unwrap().contains("Current: 1.2.3"));
            }
        }
    }
}
