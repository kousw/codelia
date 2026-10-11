use crate::application::{self, Command};
use crate::{
    git::GitSnapshot,
    runtime_adapter::Workspace,
    state::{ScrollSync, State, TranscriptSnapshot},
    transport::{Incoming, RuntimeOptions},
};
use gpui_kit::component::{
    input::{InputState, TextareaState},
    message_scroller::MessageScrollerState,
};
use gpui_kit::*;
use serde_json::{Value, json};
use std::{
    collections::{HashMap, HashSet},
    path::PathBuf,
    time::Duration,
};
actions!(codelia, [Send, Quit]);

pub struct Desktop {
    pub(crate) workspaces: Vec<Workspace>,
    pub(crate) selected: usize,
    pub(crate) runtime_options: RuntimeOptions,
    pub(crate) composer: Entity<TextareaState>,
    pub(crate) answer: Entity<InputState>,
    pub(crate) answer_multiline: Entity<TextareaState>,
    pub(crate) expanded: HashSet<String>,
    pub(crate) show_models: bool,
    pub(crate) show_sidebar: bool,
    pub(crate) collapsed: HashSet<String>,
    pub(crate) closing: bool,
    pub(crate) draft_restore_after_quit: bool,
    pub(crate) focus: FocusHandle,
    request_binding: Option<(usize, Value)>,
    pub(crate) scrolls: HashMap<(usize, String), Entity<MessageScrollerState>>,
    scroll_revisions: HashMap<(usize, String), TranscriptSnapshot>,
    _poll: Task<()>,
}
impl Desktop {
    pub fn new(
        root: PathBuf,
        runtime_options: RuntimeOptions,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) -> Self {
        let composer = cx.new(|cx| {
            TextareaState::new(window, cx)
                .placeholder("Ask Codelia to inspect, implement, or explain…")
        });
        let answer = cx.new(|cx| InputState::new(window, cx));
        let answer_multiline = cx.new(|cx| TextareaState::new(window, cx));
        let poll = cx.spawn_in(window, async move |this, cx| {
            loop {
                cx.background_executor()
                    .timer(Duration::from_millis(32))
                    .await;
                if let Err(error) = this.update_in(cx, |this, window, cx| this.poll(window, cx)) {
                    eprintln!("codelia-desktop poll failed: {error}");
                    break;
                }
            }
        });
        let mut this = Self {
            workspaces: vec![],
            selected: 0,
            runtime_options,
            composer,
            answer,
            answer_multiline,
            expanded: HashSet::new(),
            show_models: false,
            show_sidebar: true,
            collapsed: HashSet::new(),
            closing: false,
            draft_restore_after_quit: false,
            focus: cx.focus_handle(),
            request_binding: None,
            scrolls: HashMap::new(),
            scroll_revisions: HashMap::new(),
            _poll: poll,
        };
        cx.on_app_quit(|this, cx| {
            this.save_draft(cx);
            let drafts: Vec<_> = this
                .workspaces
                .iter_mut()
                .filter_map(|ws| ws.finish_drafts())
                .collect();
            let runtimes: Vec<_> = this
                .workspaces
                .iter_mut()
                .filter_map(|ws| ws.runtime.as_mut().and_then(|rt| rt.shutdown()))
                .collect();
            cx.background_executor().spawn(async move {
                for draft in drafts {
                    if !matches!(draft.join(), Ok(Ok(()))) {
                        eprintln!("codelia-desktop: draft flush failed; no draft content logged");
                    }
                }
                for runtime in runtimes {
                    let _ = runtime.join();
                }
            })
        })
        .detach();
        let weak = cx.weak_entity();
        window.on_window_should_close(cx, move |_, cx| {
            let _ = weak.update(cx, |this, cx| this.request_quit(cx));
            false
        });
        this.open_workspace(root, window, cx);
        this
    }
    pub(crate) fn request_quit(&mut self, cx: &mut Context<Self>) {
        if self.closing {
            return;
        }
        self.save_draft(cx);
        self.closing = true;
        self.draft_restore_after_quit = true;
        for ws in &mut self.workspaces {
            if let Some(drafts) = &mut ws.drafts {
                drafts.request_flush(&mut ws.state);
            }
        }
        cx.notify();
    }
    pub(crate) fn quit_without_saving(&mut self, cx: &mut Context<Self>) {
        if self.closing {
            return;
        }
        self.closing = true;
        self.finish_runtime_quit(cx);
        cx.notify();
    }
    fn finish_runtime_quit(&mut self, cx: &mut Context<Self>) {
        let drafts: Vec<_> = self
            .workspaces
            .iter_mut()
            .filter_map(|ws| ws.stop_drafts())
            .collect();
        let runtimes: Vec<_> = self
            .workspaces
            .iter_mut()
            .filter_map(|ws| ws.runtime.as_mut().and_then(|rt| rt.shutdown()))
            .collect();
        let cleanup = cx.background_executor().spawn(async move {
            for draft in drafts {
                let _ = draft.join();
            }
            for runtime in runtimes {
                let _ = runtime.join();
            }
        });
        cx.spawn(async move |_, cx| {
            cleanup.await;
            cx.update(|cx| cx.quit());
        })
        .detach();
    }
    pub(crate) fn ws(&mut self) -> &mut Workspace {
        &mut self.workspaces[self.selected]
    }
    pub(crate) fn save_draft(&mut self, cx: &App) {
        if self.workspaces.is_empty() {
            return;
        }
        self.save_answer_draft(cx);
        let text = self.composer.read(cx).value().to_string();
        self.ws().state.set_draft(text);
    }
    pub(crate) fn restore_draft(&mut self, window: &mut Window, cx: &mut Context<Self>) {
        let text = self.ws().state.conversation().draft.clone();
        self.composer
            .update(cx, |state, cx| state.set_value(text, window, cx));
        self.sync_request_input(window, cx);
    }
    fn save_answer_draft(&mut self, cx: &App) {
        let Some((index, id)) = self.request_binding.clone() else {
            return;
        };
        let Some(request) = self.workspaces[index]
            .state
            .request
            .as_ref()
            .filter(|request| request.id == id && request.method == "ui.prompt.request")
        else {
            return;
        };
        let text = if request.params["multiline"] == true && request.params["secret"] != true {
            self.answer_multiline.read(cx).value().to_string()
        } else {
            self.answer.read(cx).value().to_string()
        };
        if request.answer_draft.as_deref() != Some(text.as_str()) {
            self.workspaces[index].state.save_answer_draft(&id, text);
        }
    }
    fn sync_request_input(&mut self, window: &mut Window, cx: &mut Context<Self>) -> bool {
        let request = self.workspaces[self.selected].state.request.clone();
        let binding = request.as_ref().map(|r| (self.selected, r.id.clone()));
        if binding == self.request_binding {
            return false;
        }
        self.request_binding = binding;
        self.answer = cx.new(|cx| {
            InputState::new(window, cx)
                .masked(request.as_ref().is_some_and(|r| r.params["secret"] == true))
        });
        self.answer_multiline = cx.new(|cx| TextareaState::new(window, cx));
        if let Some(request) = request {
            // An explicitly cleared answer is Some(""); do not reinsert its default.
            let text = request.answer_draft.unwrap_or_else(|| {
                request.params["default_value"]
                    .as_str()
                    .unwrap_or("")
                    .to_owned()
            });
            self.answer
                .update(cx, |state, cx| state.set_value(text.clone(), window, cx));
            if request.params["secret"] != true {
                self.answer_multiline
                    .update(cx, |state, cx| state.set_value(text, window, cx));
            }
        }
        true
    }
    pub(crate) fn open_workspace(
        &mut self,
        root: PathBuf,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) {
        let root = match root.canonicalize() {
            Ok(root) if root.is_dir() => root,
            _ => {
                if !self.workspaces.is_empty() {
                    self.ws().state.error = Some("Select an existing workspace folder".into());
                }
                cx.notify();
                return;
            }
        };
        if !self.workspaces.is_empty() {
            self.save_draft(cx);
        }
        if let Some(index) = self.workspaces.iter().position(|ws| ws.root == root) {
            self.selected = index;
        } else {
            if self.workspaces.len() >= 8 {
                self.ws().state.error = Some("Eight workspaces are already open. Restart the app to release inactive runtimes.".into());
                return;
            }
            let mut ws = Workspace {
                submitted_draft: None,
                drafts: Some(crate::draft_controller::Controller::start(
                    root.clone(),
                    self.runtime_options.clone(),
                )),
                root,
                last_task_poll: std::time::Instant::now(),
                runtime: None,
                state: State::default(),
                git: GitSnapshot::default(),
                git_loading: false,
                git_rx: None,
            };
            ws.state.draft_key = format!("draft-{}", uuid::Uuid::new_v4());
            ws.connect(&self.runtime_options);
            ws.refresh_git();
            self.workspaces.push(ws);
            self.selected = self.workspaces.len() - 1;
        }
        self.restore_draft(window, cx);
        self.composer.focus_handle(cx).focus(window, cx);
        cx.notify();
    }
    pub(crate) fn pick_workspace(&mut self, window: &mut Window, cx: &mut Context<Self>) {
        let picker = cx.prompt_for_paths(PathPromptOptions {
            files: false,
            directories: true,
            multiple: false,
            prompt: Some("Open workspace".into()),
        });
        cx.spawn_in(window, async move |this, cx| match picker.await {
            Ok(Ok(Some(paths))) => {
                if let Some(path) = paths.first() {
                    let path = path.clone();
                    let _ = this
                        .update_in(cx, |this, window, cx| this.open_workspace(path, window, cx));
                }
            }
            Ok(Ok(None)) => {}
            _ => {
                let _ = this.update(cx, |this, cx| {
                    if !this.workspaces.is_empty() {
                        this.ws().state.error = Some("Folder picker failed".into());
                    }
                    cx.notify();
                });
            }
        })
        .detach();
    }
    fn poll(&mut self, window: &mut Window, cx: &mut Context<Self>) {
        if self.workspaces.is_empty() {
            if self.closing {
                self.finish_runtime_quit(cx);
            }
            return;
        }
        if self.draft_restore_after_quit {
            self.draft_restore_after_quit = false;
            self.restore_draft(window, cx);
        }
        self.save_answer_draft(cx);
        let before_key = self.workspaces[self.selected].state.key();
        let composer_text = self.composer.read(cx).value().to_string();
        // Incoming client tools can select another thread before cache eviction.
        // Make current human text visible to both eviction and draft admission.
        self.workspaces[self.selected]
            .state
            .set_draft(composer_text.clone());
        let mut restore_selected = false;
        let mut changed = false;
        for (index, ws) in self.workspaces.iter_mut().enumerate() {
            let incoming: Vec<_> = ws
                .runtime
                .as_ref()
                .map(|rt| rt.incoming.try_iter().take(128).collect())
                .unwrap_or_default();
            for event in incoming {
                changed = true;

                let was_busy = ws.state.busy;
                match event {
                    Incoming::Message(message) => {
                        if message["method"] == "client.tool.call" {
                            let params = &message["params"];
                            let result = application::internal_call(
                                &mut ws.state,
                                &ws.root.to_string_lossy(),
                                params,
                            );
                            let result = match result {
                                Ok(outcome) => {
                                    for message in outcome.messages {
                                        ws.send(message);
                                    }
                                    json!({"ok":true,"result":outcome.value})
                                }
                                Err(error) => json!({"ok":false,"error":error}),
                            };
                            ws.send(json!({"jsonrpc":"2.0","id":message["id"],"result":result}));
                        } else {
                            let (follow, restore) = ws.handle_runtime(message);
                            restore_selected |= index == self.selected && restore;
                            for next in follow {
                                ws.send(next);
                            }
                        }
                    }
                    Incoming::Closed(message) => {
                        restore_selected |= index == self.selected && ws.disconnected(message);
                        ws.runtime = None;
                    }
                }
                if was_busy && !ws.state.busy {
                    ws.refresh_git();
                }
            }
            if let Some(rx) = &ws.git_rx
                && let Ok(result) = rx.try_recv()
            {
                changed = true;
                ws.git_loading = false;
                ws.git_rx = None;
                match result {
                    Ok(snapshot) => ws.git = snapshot,
                    Err(error) => {
                        // A failed refresh invalidates the previous observation.
                        ws.git = GitSnapshot {
                            error: Some(error.to_string()),
                            ..Default::default()
                        };
                    }
                }
            }
            if ws.last_task_poll.elapsed() > Duration::from_secs(1)
                && ws.state.connected
                && (ws.state.busy
                    || ws
                        .state
                        .child_tasks()
                        .any(|task| task["state"] == "running" || task["state"] == "queued"))
            {
                let _ = ws.command(Command::ListTasks);
                ws.last_task_poll = std::time::Instant::now();
            }
            let draft_update = ws.poll_drafts();
            changed |= draft_update.changed;
            restore_selected |= index == self.selected && draft_update.restore;
            let key = (index, ws.state.key());
            let conversation = ws.state.conversation();
            let after = conversation.snapshot();
            let dirty_from = conversation.dirty_from.take();
            let scroll = self
                .scrolls
                .entry(key.clone())
                .or_insert_with(|| cx.new(|cx| MessageScrollerState::new(after.count, cx)))
                .clone();
            let before = self
                .scroll_revisions
                .insert(key, after)
                .unwrap_or(TranscriptSnapshot {
                    count: scroll.read(cx).item_count(),
                    ..after
                });
            let sync = ScrollSync::between(before, after, dirty_from);
            if sync.changed() {
                changed = true;
                scroll.update(cx, |state, cx| {
                    if sync.replace {
                        state.reset(after.count, cx);
                    } else {
                        if sync.removed > 0 {
                            state.splice(0..sync.removed, 0, cx);
                        }
                        if sync.appended > 0 {
                            state.append(sync.appended, cx);
                        }
                        if let Some(range) = sync.remeasure {
                            state.remeasure_items(range, cx);
                        }
                    }
                });
            }
        }
        if restore_selected {
            self.restore_draft(window, cx);
            if self.ws().state.request.is_none() && !self.ws().state.loading {
                self.composer.focus_handle(cx).focus(window, cx);
            }
        } else if self.workspaces[self.selected].state.key() != before_key {
            // A client-tool selection uses the same command as the sidebar.
            // Preserve typed text even when the selected thread changes during a run.
            if let Some(conversation) = self.workspaces[self.selected]
                .state
                .conversations
                .get_mut(&before_key)
            {
                conversation.draft = composer_text;
            } else if before_key.starts_with("draft-")
                && self.workspaces[self.selected].state.run_owner.as_ref()
                    == Some(&self.workspaces[self.selected].state.key())
            {
                self.workspaces[self.selected].state.conversation().draft = composer_text;
            }
            self.restore_draft(window, cx);
        }
        let retained: HashSet<_> = self
            .workspaces
            .iter()
            .enumerate()
            .flat_map(|(index, ws)| {
                ws.state
                    .conversations
                    .keys()
                    .map(move |key| (index, key.clone()))
            })
            .collect();
        self.scrolls
            .retain(|key, _| retained.contains(key) || self.workspaces[key.0].state.key() == key.1);
        self.scroll_revisions
            .retain(|key, _| self.scrolls.contains_key(key));
        changed |= self.sync_request_input(window, cx);
        if self.closing {
            let failed = self
                .workspaces
                .iter()
                .any(|ws| ws.drafts.as_ref().is_some_and(|drafts| drafts.failed()));
            if failed {
                self.closing = false;
                for ws in &mut self.workspaces {
                    if ws.drafts.as_ref().is_some_and(|drafts| drafts.failed()) {
                        ws.state.draft_notice=Some("Draft not saved. Window kept open; inspect storage or quit without saving.".into());
                    }
                }
                self.ws().state.error=Some("Draft saving failed. Inspect the workspace with an unsaved draft before closing.".into());
                changed = true;
            } else if self.workspaces.iter().all(|ws| {
                ws.drafts
                    .as_ref()
                    .is_none_or(|drafts| drafts.flushed(&ws.state))
            }) {
                self.finish_runtime_quit(cx);
            }
        }
        if changed {
            cx.notify();
        }
    }
    pub(crate) fn clear_draft(&mut self, window: &mut Window, cx: &mut Context<Self>) {
        if self.closing {
            return;
        }
        self.save_draft(cx);
        match self.ws().clear_draft() {
            Ok(()) if self.ws().drafts.is_none() => self.restore_draft(window, cx),
            Ok(()) => {}
            Err(error) => self.ws().state.error = Some(error),
        }
        cx.notify();
    }
    pub(crate) fn send_prompt(&mut self, window: &mut Window, cx: &mut Context<Self>) {
        if self.closing || self.workspaces.is_empty() {
            return;
        }
        let text = self.composer.read(cx).value().to_string();
        match self.ws().command(Command::Send(text)) {
            Ok(_) => {
                self.composer
                    .update(cx, |state, cx| state.set_value("", window, cx));
                if !self.ws().state.loading {
                    self.ws().state.set_draft(String::new());
                }
                self.composer.focus_handle(cx).focus(window, cx);
            }
            Err(error) => self.ws().state.error = Some(error),
        }
        cx.notify();
    }
    pub(crate) fn select_session(
        &mut self,
        id: Option<String>,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) {
        if self.ws().state.loading || (id.is_some() && self.ws().state.busy) {
            return;
        }
        self.save_draft(cx);
        if let Some(id) = id {
            if let Err(error) = self.ws().command(Command::LoadSession(id)) {
                self.ws().state.error = Some(error);
            }
        } else {
            if let Ok(value) = self
                .ws()
                .command(Command::CreateThread("New thread".into()))
            {
                let id = value["thread_id"].as_str().unwrap_or("").to_owned();
                let _ = self.ws().command(Command::SelectThread(id));
            }
        }
        self.restore_draft(window, cx);
        self.composer.focus_handle(cx).focus(window, cx);
        cx.notify();
    }
    pub(crate) fn reply(&mut self, result: Value, cx: &mut Context<Self>) {
        if let Err(error) = self.ws().command(Command::Answer(result)) {
            self.ws().state.error = Some(error);
        }
        cx.notify();
    }
}

#[cfg(all(test, feature = "ui-tests"))]
#[path = "ui_tests.rs"]
mod ui_tests;
