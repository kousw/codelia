//! Bridges pure draft projection to one background storage worker. No GPUI or direct disk I/O.
use crate::{
    draft_store::{Event, Worker},
    drafts::DraftSnapshot,
    state::State,
    transport::RuntimeOptions,
};
use std::{
    path::PathBuf,
    thread::JoinHandle,
    time::{Duration, Instant},
};
const WAIT: &str = "Wait for draft recovery before sending or clearing";
pub enum Action {
    Send(String),
    Clear,
}
struct Pending {
    token: u64,
    key: String,
    text: String,
    action: Action,
}
struct Flight {
    seq: u64,
    snapshot: DraftSnapshot,
    consume_token: Option<u64>,
}
#[derive(Default)]
pub struct Update {
    pub changed: bool,
    pub restore: bool,
    pub send: Option<String>,
}
pub struct Controller {
    worker: Option<Worker>,
    loaded: bool,
    failed: bool,
    invalid: bool,
    epoch: u64,
    key: String,
    dirty_at: Option<Instant>,
    dirty_since: Option<Instant>,
    next: u64,
    action_token: u64,
    flight: Option<Flight>,
    pending: Option<Pending>,
    saved: Option<DraftSnapshot>,
    flush: bool,
}
impl Controller {
    pub fn start(root: PathBuf, options: RuntimeOptions) -> Self {
        Self {
            worker: Some(Worker::start(root, options)),
            loaded: false,
            failed: false,
            invalid: false,
            epoch: 0,
            key: String::new(),
            dirty_at: None,
            dirty_since: None,
            next: 0,
            action_token: 0,
            flight: None,
            pending: None,
            saved: None,
            flush: false,
        }
    }
    pub fn stage(&mut self, state: &mut State, action: Action) -> Result<(), String> {
        if !self.loaded || self.failed {
            return Err(state.draft_notice.clone().unwrap_or_else(|| WAIT.into()));
        }
        if self.pending.is_some() || state.loading || state.busy || state.request.is_some() {
            return Err("Wait for the current operation before changing this draft".into());
        }
        let text = state.conversation().draft.clone();
        self.action_token += 1;
        state.draft_send_pending = matches!(&action, Action::Send(_));
        self.pending = Some(Pending {
            token: self.action_token,
            key: state.key(),
            text,
            action,
        });
        state.loading = true;
        state.draft_notice = Some("Saving draft change…".into());
        Ok(())
    }
    pub fn observe(&mut self, state: &State) {
        let key = state.key();
        if self.epoch != state.draft_epoch || self.key != key {
            self.epoch = state.draft_epoch;
            self.key = key;
            self.dirty_at = Some(Instant::now());
            self.dirty_since.get_or_insert_with(Instant::now);
            self.invalid = false;
        }
    }
    pub fn poll(&mut self, state: &mut State) -> Update {
        let mut update = Update::default();
        let events: Vec<_> = self
            .worker
            .as_ref()
            .map(|w| w.output.try_iter().take(4).collect())
            .unwrap_or_default();
        for event in events {
            update.changed = true;
            match event {
                Event::Loaded(Ok(snapshot)) => {
                    self.saved = Some(snapshot.clone());
                    update.restore |= snapshot.restore(state);
                    self.loaded = true;
                    self.observe(state);
                    state.draft_notice = Some("Drafts recovered".into());
                }
                Event::Loaded(Err(error)) => {
                    self.failed = true;
                    state.draft_notice = Some(error.into());
                }
                Event::Saved(seq, result) => {
                    let Some(flight) = self.flight.take().filter(|flight| flight.seq == seq) else {
                        continue;
                    };
                    match result {
                        Ok(()) => {
                            self.saved = Some(flight.snapshot);
                            state.draft_notice = Some("Draft saved".into());
                            if flight.consume_token.is_some()
                                && flight.consume_token
                                    == self.pending.as_ref().map(|pending| pending.token)
                                && let Some(pending) = self.pending.take()
                            {
                                state.loading = false;
                                state.draft_send_pending = false;
                                if state.key() == pending.key {
                                    state.set_draft(String::new());
                                    update.restore = true;
                                    if let Action::Send(text) = pending.action {
                                        update.send = Some(text);
                                    }
                                } else {
                                    state.draft_notice =
                                        Some("Draft target changed; nothing was sent".into());
                                }
                            }
                        }
                        Err(error) => {
                            self.failed = true;
                            state.draft_notice = Some(error.into());
                            if let Some(pending) = self.pending.take() {
                                state.loading = false;
                                state.draft_send_pending = false;
                                if let Some(c) = state.conversations.get_mut(&pending.key) {
                                    c.draft = pending.text;
                                    state.draft_epoch += 1;
                                    update.restore = true;
                                }
                            }
                        }
                    }
                }
            }
        }
        self.observe(state);
        if self.loaded
            && !self.failed
            && self.flight.is_none()
            && (self.flush
                || self
                    .dirty_since
                    .is_some_and(|time| time.elapsed() >= Duration::from_secs(2))
                || self.pending.is_some()
                || self
                    .dirty_at
                    .is_some_and(|t| t.elapsed() >= Duration::from_millis(250)))
        {
            let skip = self.pending.as_ref().map(|pending| pending.key.as_str());
            if !DraftSnapshot::fits(state, skip) {
                self.invalid = true;
                self.flush = false;
                self.dirty_at = None;
                self.dirty_since = None;
                state.draft_notice = Some(
                    "Draft exceeds save limits; input retained. Shorten it or clear a draft."
                        .into(),
                );
                if self.pending.take().is_some() {
                    state.loading = false;
                    state.draft_send_pending = false;
                    update.restore = true;
                }
                update.changed = true;
                return update;
            }
            let mut snapshot = DraftSnapshot::capture(state);
            let consumes = self.pending.is_some();
            if let Some(p) = &self.pending {
                snapshot.drafts.remove(&p.key);
            }
            if !snapshot.validate() {
                self.invalid = true;
                state.draft_notice = Some(
                    "Draft is too large to save (256 KiB per thread, 4 MiB total); text stays here"
                        .into(),
                );
                if self.pending.take().is_some() {
                    state.loading = false;
                    state.draft_send_pending = false;
                    update.restore = true;
                }
                self.dirty_at = None;
                self.dirty_since = None;
                update.changed = true;
            } else if self.saved.as_ref() == Some(&snapshot) && !consumes {
                self.dirty_at = None;
                self.dirty_since = None;
                self.flush = false;
            } else {
                self.next += 1;
                let result = self
                    .worker
                    .as_ref()
                    .ok_or("Draft worker unavailable")
                    .and_then(|w| w.save(self.next, snapshot.clone()));
                match result {
                    Ok(()) => {
                        self.flight = Some(Flight {
                            seq: self.next,
                            snapshot,
                            consume_token: self.pending.as_ref().map(|pending| pending.token),
                        });
                        self.dirty_at = None;
                        self.dirty_since = None;
                        self.flush = false;
                        state.draft_notice = Some("Saving draft…".into());
                    }
                    Err(error) => {
                        self.failed = true;
                        state.draft_notice = Some(error.into());
                        if self.pending.take().is_some() {
                            state.loading = false;
                            state.draft_send_pending = false;
                            update.restore = true;
                        }
                    }
                }
                update.changed = true;
            }
        }
        update
    }
    pub fn request_flush(&mut self, state: &mut State) {
        self.cancel_staged(state);
        self.flush = true;
    }
    pub fn failed(&self) -> bool {
        self.failed || self.invalid
    }
    pub fn flushed(&self, state: &State) -> bool {
        self.loaded
            && !self.failed
            && self.flight.is_none()
            && self.pending.is_none()
            && self
                .saved
                .as_ref()
                .is_some_and(|saved| saved.matches(state))
    }
    pub fn stop(self) -> Option<JoinHandle<Result<(), &'static str>>> {
        self.worker.and_then(|worker| worker.stop())
    }
    pub fn cancel_staged(&mut self, state: &mut State) {
        if let Some(pending) = self.pending.take() {
            if let Some(c) = state.conversations.get_mut(&pending.key) {
                c.draft = pending.text;
                state.draft_epoch += 1;
            }
            state.loading = false;
            state.draft_send_pending = false;
        }
    }
    pub fn finish(self, state: &State) -> Option<JoinHandle<Result<(), &'static str>>> {
        // Cancels a staged send on quit; final input replaces its removal, never dispatches it.
        if !DraftSnapshot::fits(state, None) {
            let handle = self.worker.and_then(|worker| worker.stop());
            return Some(std::thread::spawn(move || {
                if let Some(handle) = handle {
                    let _ = handle.join();
                }
                Err("Draft exceeds save limits; input retained")
            }));
        }
        let mut snapshot = DraftSnapshot::capture(state);
        if let Some(p) = self.pending
            && !p.text.is_empty()
        {
            snapshot.drafts.insert(
                p.key,
                crate::drafts::DraftText {
                    text: p.text,
                    title: String::new(),
                },
            );
        }
        if let Some(worker) = self.worker {
            worker.finish(snapshot, !self.loaded)
        } else if self.failed {
            Some(std::thread::spawn(|| {
                Err("Draft not saved; input retained")
            }))
        } else {
            None
        }
    }
}
