//! Owns subprocess transport and read-only repository observations. No GPUI types.
use crate::{
    application::{self, Command},
    git::{self, GitSnapshot},
    state::State,
    transport::{Runtime, RuntimeOptions},
};
use serde_json::Value;
use std::{
    path::PathBuf,
    sync::mpsc::{self, Receiver},
};
pub struct Workspace {
    pub submitted_draft: Option<(Value, String, String)>,
    pub drafts: Option<crate::draft_controller::Controller>,
    pub last_task_poll: std::time::Instant,
    pub root: PathBuf,
    pub runtime: Option<Runtime>,
    pub state: State,
    pub git: GitSnapshot,
    pub git_loading: bool,
    pub git_rx: Option<Receiver<anyhow::Result<GitSnapshot>>>,
}
impl Workspace {
    pub fn send(&mut self, message: Value) {
        let result = self
            .runtime
            .as_mut()
            .ok_or_else(|| anyhow::anyhow!("Runtime disconnected"))
            .and_then(|rt| rt.send(&message));
        if let Err(error) = result {
            self.disconnected(error.to_string());
        }
    }
    pub fn command(&mut self, command: Command) -> Result<Value, String> {
        if matches!(&command, Command::Cancel)
            && self.state.draft_send_pending
            && let Some(drafts) = &mut self.drafts
        {
            drafts.request_flush(&mut self.state);
            self.state.draft_notice = Some("Send cancelled; draft retained".into());
            return Ok(serde_json::json!({"draft_send_cancelled":true}));
        }
        if let Command::Send(text) = &command
            && let Some(drafts) = &mut self.drafts
        {
            application::validate_send(&self.state, text)?;
            self.state.set_draft(text.clone());
            drafts.stage(
                &mut self.state,
                crate::draft_controller::Action::Send(text.clone()),
            )?;
            return Ok(serde_json::json!({"accepted":true,"saving_draft":true}));
        }
        if matches!(&command, Command::ClearDraft)
            && let Some(drafts) = &mut self.drafts
        {
            application::validate_clear(&self.state)?;
            drafts.stage(&mut self.state, crate::draft_controller::Action::Clear)?;
            return Ok(serde_json::json!({"saving_draft":true}));
        }
        let outcome = application::execute(&mut self.state, &self.root.to_string_lossy(), command)?;
        if let Some(target) = outcome.value["open_workspace"].as_str() {
            // Revalidate cached navigation at use time, including replaced/symlinked paths.
            let common = |root: &std::path::Path| -> Result<PathBuf, String> {
                let output = std::process::Command::new("git")
                    .args(["-c", "core.fsmonitor=false", "-C"])
                    .arg(root)
                    .args(["rev-parse", "--path-format=absolute", "--git-common-dir"])
                    .output()
                    .map_err(|_| "Git worktree verification failed")?;
                if !output.status.success() {
                    return Err("Worktree folder is no longer available".into());
                }
                PathBuf::from(String::from_utf8_lossy(&output.stdout).trim())
                    .canonicalize()
                    .map_err(|_| "Worktree metadata is unavailable".into())
            };
            if common(&self.root)? != common(std::path::Path::new(target))? {
                return Err(
                    "Worktree folder now belongs to another project; refresh before opening".into(),
                );
            }
        }
        for message in outcome.messages {
            self.send(message);
            if !self.state.connected {
                return Err(self
                    .state
                    .error
                    .clone()
                    .unwrap_or_else(|| "Runtime disconnected".into()));
            }
        }
        Ok(outcome.value)
    }
    pub fn poll_drafts(&mut self) -> crate::draft_controller::Update {
        let mut update = self
            .drafts
            .as_mut()
            .map(|drafts| drafts.poll(&mut self.state))
            .unwrap_or_default();
        if let Some(text) = update.send.take() {
            match application::execute(
                &mut self.state,
                &self.root.to_string_lossy(),
                Command::Send(text.clone()),
            ) {
                Ok(outcome) => {
                    for message in outcome.messages {
                        self.submitted_draft =
                            Some((message["id"].clone(), self.state.key(), text.clone()));
                        self.send(message);
                    }
                }
                Err(error) => {
                    self.state.set_draft(text);
                    self.state.error = Some(error);
                    update.restore = true;
                }
            }
        }
        update
    }
    pub fn handle_runtime(&mut self, message: Value) -> (Vec<Value>, bool) {
        let submitted = self
            .submitted_draft
            .as_ref()
            .filter(|(id, _, _)| message.get("id") == Some(id) && message.get("method").is_none());
        let restore = submitted
            .filter(|_| message.get("error").is_some())
            .map(|(_, key, text)| (key.clone(), text.clone()));
        if submitted.is_some() {
            self.submitted_draft = None;
        }
        let follow = self.state.handle(message);
        let mut visible = false;
        if let Some((key, text)) = restore
            && let Some(conversation) = self.state.conversations.get_mut(&key)
            && conversation.draft.is_empty()
        {
            conversation.draft = text;
            self.state.draft_epoch += 1;
            visible = self.state.key() == key;
        }
        (follow, visible)
    }
    pub fn clear_draft(&mut self) -> Result<(), String> {
        self.command(Command::ClearDraft).map(|_| ())
    }
    pub fn stop_drafts(&mut self) -> Option<std::thread::JoinHandle<Result<(), &'static str>>> {
        self.drafts.take().and_then(|drafts| drafts.stop())
    }
    pub fn finish_drafts(&mut self) -> Option<std::thread::JoinHandle<Result<(), &'static str>>> {
        self.drafts.take().and_then(|mut drafts| {
            drafts.cancel_staged(&mut self.state);
            drafts.finish(&self.state)
        })
    }
    pub fn disconnected(&mut self, message: String) -> bool {
        let staged = self.state.draft_send_pending;
        if staged && let Some(drafts) = &mut self.drafts {
            drafts.request_flush(&mut self.state);
        }
        self.state.disconnected(message);
        staged
    }
    pub fn connect(&mut self, options: &RuntimeOptions) {
        if self.state.draft_send_pending
            && let Some(drafts) = &mut self.drafts
        {
            drafts.request_flush(&mut self.state);
        }
        self.runtime = None;
        match Runtime::start(&self.root, options) {
            Ok(rt) => {
                self.runtime = Some(rt);
                self.state.connected = false;
                let msg = self.state.initialize();
                self.send(msg);
            }
            Err(error) => self.state.disconnected(error.to_string()),
        }
    }
    pub fn refresh_git(&mut self) {
        if self.git_loading {
            return;
        }
        self.git_loading = true;
        let root = self.root.clone();
        let (tx, rx) = mpsc::channel();
        self.git_rx = Some(rx);
        std::thread::spawn(move || {
            let _ = tx.send(git::snapshot(&root));
        });
    }
}
