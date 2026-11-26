use super::state::{LogKind, PickDialogItem, PickDialogState};
use super::AppState;
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

#[derive(Clone, Copy, Debug, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
enum Mode {
    Notify,
    Auto,
    Off,
}

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
    saving: bool,
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

fn start(app: &mut AppState, save: Option<Mode>) {
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
    if let Some(mode) = save {
        command.args(["--tui-set-mode", mode.id()]);
    } else {
        command.arg("--tui-status");
    }
    match command
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::null())
        .spawn()
        .and_then(|child| PendingUpdateControl::new(child, save.is_some()))
    {
        Ok(pending) => app.pending_update_control = Some(pending),
        Err(_) => app.push_line(
            LogKind::Error,
            "Could not start the local update settings helper.",
        ),
    }
}

impl PendingUpdateControl {
    fn new(child: Child, saving: bool) -> std::io::Result<Self> {
        let (sender, response) = mpsc::channel();
        let mut pending = Self {
            child,
            response,
            started: Instant::now(),
            saving,
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

pub(crate) fn open(app: &mut AppState, args: &str) {
    if !args.is_empty() {
        app.push_line(LogKind::Error, "usage: /update");
        return;
    }
    start(app, None);
}

pub(crate) fn finish_picker(app: &mut AppState, panel: PickDialogState, save: bool) {
    if save {
        if let Some(mode) = Mode::ALL.get(panel.selected).copied() {
            start(app, Some(mode));
        }
    }
    if is_startup_picker(&panel) {
        app.startup_confirmations
            .answer(super::startup_confirmations::StartupConfirmation::UpdateMode);
    }
}

pub(crate) fn is_startup_picker(panel: &PickDialogState) -> bool {
    panel.local_update_picker && panel.id == STARTUP_PICKER_ID
}

pub(crate) fn poll(app: &mut AppState) -> bool {
    let Some(status) = app
        .pending_update_control
        .as_mut()
        .and_then(|job| job.poll())
    else {
        return false;
    };
    let Some(pending) = app.pending_update_control.take() else {
        return false;
    };
    let Some(status) = status else {
        let message = if pending.saving {
            "Could not confirm the update mode was saved. Check the global config and its permissions."
        } else {
            "Could not read local update settings."
        };
        app.push_line(LogKind::Error, message);
        return true;
    };
    if pending.saving {
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
        app.runtime_dialogs.pick = Some(build_picker(&status));
    } else {
        app.push_line(
            LogKind::Status,
            "Finish the current dialog before opening /update.",
        );
    }
    true
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

fn build_picker(status: &Status) -> PickDialogState {
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
    )
}

pub(crate) fn startup_picker() -> PickDialogState {
    mode_picker(
        STARTUP_PICKER_ID,
        "Startup setup: CLI updates",
        "Choose how this CLI handles updates on future launches. Esc to decide later. Nothing is installed now.".to_string(),
        Mode::Notify,
    )
}

fn mode_picker(id: &str, title: &str, message: String, selected: Mode) -> PickDialogState {
    PickDialogState {
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
        multi: false,
        chosen: Vec::new(),
        approval: false,
        review_offset: None,
        shell_rule_picker: None,
        local_update_picker: true,
    }
}

#[cfg(test)]
mod tests {
    use super::LauncherPaths;
    use std::path::PathBuf;

    #[test]
    fn launcher_paths_require_absolute_node_and_entry() {
        assert!(
            LauncherPaths::new(PathBuf::from("node"), PathBuf::from("/abs/entry.js")).is_none()
        );
        assert!(
            LauncherPaths::new(PathBuf::from("/usr/bin/node"), PathBuf::from("entry.js")).is_none()
        );
        let valid = LauncherPaths::new(
            PathBuf::from("/usr/bin/node"),
            PathBuf::from("/opt/codelia/cli.js"),
        );
        assert!(valid.is_some());
    }
}
