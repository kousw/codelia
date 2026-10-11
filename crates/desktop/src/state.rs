use serde_json::{Value, json};
use std::collections::{HashMap, HashSet, VecDeque};

pub const MODEL_PROVIDERS: [(&str, &str); 6] = [
    ("openai", "OpenAI"),
    ("anthropic", "Anthropic"),
    ("moonshot", "Moonshot"),
    ("zai", "Z.ai"),
    ("xai", "xAI"),
    ("openrouter", "OpenRouter"),
];
#[derive(Clone, Debug, serde::Serialize)]
pub struct ModelChoice {
    pub provider: String,
    pub name: String,
}

#[derive(Clone, Debug)]
pub struct Row {
    pub id: String,
    pub kind: String,
    pub title: String,
    pub body: String,
    pub detail: String,
    pub error: bool,
}

impl Row {
    fn display_bytes(&self) -> usize {
        self.id.len() + self.kind.len() + self.title.len() + self.body.len() + self.detail.len()
    }
}

fn cap_display(text: &mut String, limit: usize, suffix: &str) {
    if text.len() <= limit {
        return;
    }
    let mut end = limit.saturating_sub(suffix.len());
    while !text.is_char_boundary(end) {
        end -= 1;
    }
    text.truncate(end);
    text.push_str(suffix);
}

fn bound_task(mut task: Value) -> Value {
    for key in [
        "name",
        "title",
        "summary",
        "stdout",
        "stderr",
        "failure_message",
    ] {
        if let Some(text) = task[key].as_str() {
            let mut text = text.to_owned();
            if key == "name" || key == "title" {
                cap_display(&mut text, 256, "…");
            } else {
                cap_display(
                    &mut text,
                    65536,
                    "\n[Display truncated; full result remains in runtime storage]",
                );
            }
            task[key] = json!(text);
        }
    }
    task
}

#[derive(Clone, Debug)]
pub struct Request {
    pub id: Value,
    pub method: String,
    pub params: Value,
    pub selected: HashSet<String>,
    pub answer_draft: Option<String>,
}

struct StreamProjection {
    offset: usize,
    invocation: String,
    attempt: u64,
}

#[derive(Default)]
pub struct Conversation {
    streams: HashMap<String, StreamProjection>,
    stream_seen: VecDeque<String>,
    pub rows: Vec<Row>,
    pub draft: String,
    pub selected_model: Option<ModelChoice>,
    pub title: String,
    // Retain unsent text independently of an evicted persisted transcript.
    pub transcript_evicted: bool,
    pub(crate) removed_rows: usize,
    pub(crate) replacement_generation: u64,
    pub(crate) dirty_from: Option<usize>,
    // Runtime events and stored replay are ordered by per-run sequence.
    seen: HashMap<String, i64>,
    recent_runs: VecDeque<String>,
}

#[derive(Default, PartialEq, Eq)]
pub enum Inspector {
    #[default]
    None,
    Changes,
    Task,
}

struct PendingRequest {
    method: String,
    target: Option<String>,
}

pub struct State {
    pub inspector: Inspector,
    pub connected: bool,
    pub session: Option<String>,
    pub sessions: Vec<Value>,
    pub conversations: HashMap<String, Conversation>,
    pub status: String,
    pub active: Option<String>,
    pub busy: bool,
    pub loading: bool,
    pub cancel_pending: bool,
    pub request: Option<Request>,
    pub error: Option<String>,
    pub model: String,
    pub models: Vec<String>,
    pub model_provider: String,
    pub catalog_provider: String,
    pub model_available: bool,
    pub model_error: Option<String>,
    pub supports_run_model: bool,
    model_list_request: Option<String>,
    pub context: Option<f64>,
    pending: HashMap<String, PendingRequest>,
    next_id: u64,
    pub last_prompt: Option<String>,
    pub retryable: bool,
    pub draft_key: String,
    pub draft_epoch: u64,
    pub draft_send_pending: bool,
    pub draft_notice: Option<String>,
    pub run_owner: Option<String>,
    pub tasks: Vec<Value>,
    pub task_detail: Option<Value>,
    pub inspected_task: Option<String>,
    pub supports_subagents: bool,
    pub supports_ui_request_cancel: bool,
    pub supports_worktrees: bool,
    pub supports_new_session: bool,
    pub supports_session_model_guard: bool,
    pub supports_workspace_identity: bool,
    pub worktree_list: Option<Value>,
    pub worktree_operation: Option<Value>,
    pub worktree_error: Option<String>,
    pub show_worktree_details: bool,
    worktree_list_request: Option<String>,
    worktree_intent: Option<Value>,
}

impl Default for State {
    fn default() -> Self {
        Self {
            inspector: Inspector::None,
            connected: false,
            session: None,
            sessions: vec![],
            conversations: HashMap::new(),
            status: "Connecting".into(),
            active: None,
            busy: false,
            loading: false,
            cancel_pending: false,
            request: None,
            error: None,
            model: "Model not loaded".into(),
            models: vec![],
            model_provider: String::new(),
            catalog_provider: String::new(),
            model_available: false,
            model_error: None,
            supports_run_model: false,
            model_list_request: None,
            context: None,
            pending: HashMap::new(),
            next_id: 0,
            last_prompt: None,
            retryable: false,
            draft_key: "draft-0".into(),
            draft_epoch: 0,
            draft_send_pending: false,
            draft_notice: None,
            run_owner: None,
            tasks: vec![],
            task_detail: None,
            inspected_task: None,
            supports_subagents: false,
            supports_ui_request_cancel: false,
            supports_worktrees: false,
            supports_new_session: false,
            supports_session_model_guard: false,
            supports_workspace_identity: false,
            worktree_list: None,
            worktree_operation: None,
            worktree_error: None,
            show_worktree_details: false,
            worktree_list_request: None,
            worktree_intent: None,
        }
    }
}

impl State {
    pub fn model_ready(&self) -> bool {
        self.conversations
            .get(&self.key())
            .and_then(|c| c.selected_model.as_ref())
            .is_some()
            || self.model_available
    }
    pub fn model_label(&self) -> String {
        if let Some(choice) = self
            .conversations
            .get(&self.key())
            .and_then(|c| c.selected_model.as_ref())
        {
            format!("{}/{}", choice.provider, choice.name)
        } else if self.model_available {
            format!("{}/{}", self.model_provider, self.model)
        } else {
            "Choose provider / model".into()
        }
    }
    pub fn child_tasks(&self) -> impl Iterator<Item = &Value> {
        self.tasks.iter().filter(|task| task["kind"] == "subagent")
    }
    pub fn key(&self) -> String {
        self.session
            .clone()
            .unwrap_or_else(|| self.draft_key.clone())
    }
    pub fn conversation(&mut self) -> &mut Conversation {
        let key = self.key();
        self.conversations.entry(key).or_default()
    }
    pub fn set_draft(&mut self, text: String) {
        if self.conversation().draft != text {
            self.conversation().draft = text;
            self.draft_epoch += 1;
        }
    }
    pub fn rows(&self) -> &[Row] {
        self.conversations
            .get(&self.key())
            .map(|c| c.rows.as_slice())
            .unwrap_or(&[])
    }
    pub fn has_pending(&self, method: &str) -> bool {
        self.pending
            .values()
            .any(|request| request.method == method)
    }
    pub fn has_pending_target(&self, method: &str, target: &str) -> bool {
        self.pending
            .values()
            .any(|request| request.method == method && request.target.as_deref() == Some(target))
    }
    pub fn rpc(&mut self, method: &str, params: Value) -> Value {
        self.next_id += 1;
        let id = format!("desktop-{}", self.next_id);
        if method == "model.list" {
            self.model_list_request = Some(id.clone());
        }
        if method == "worktree.list" {
            self.worktree_list_request = Some(id.clone());
        }
        if method == "worktree.create" {
            self.worktree_intent = Some(params.clone());
        }
        self.pending.insert(
            id.clone(),
            PendingRequest {
                method: method.into(),
                target: params["task_id"].as_str().map(String::from),
            },
        );
        json!({"jsonrpc":"2.0", "id": id, "method":method, "params":params})
    }
    pub fn initialize(&mut self) -> Value {
        self.model_available = false;
        self.model_error = None;
        self.models.clear();
        self.catalog_provider.clear();
        self.rpc("initialize", json!({"protocol_version":"0","client":{"name":"codelia-desktop","version":"0.1.0"},"ui_capabilities":{"supports_confirm":true,"supports_prompt":true,"supports_pick":true,"supports_markdown":true,"supports_images":false,"supports_permission_preflight_events":true,"supports_ui_request_cancel":true,"supports_text_stream":true}}))
    }
    pub fn start(&mut self, text: &str, root: &str) -> Option<Value> {
        if !self.connected
            || self.busy
            || self.loading
            || self.request.is_some()
            || (self.session.is_none() && !self.supports_new_session)
            || self.has_pending("worktree.list")
            || !self.model_ready()
            || text.trim().is_empty()
        {
            return None;
        }
        if self
            .conversations
            .get(&self.key())
            .is_some_and(|c| c.selected_model.is_some())
            && !self.supports_run_model
        {
            return None;
        }
        self.busy = true;
        self.cancel_pending = false;
        self.status = "Starting".into();
        self.error = None;
        self.retryable = false;
        self.context = None;
        self.run_owner = Some(self.key());
        self.last_prompt = Some(text.into());
        let mut params = json!({"input":{"type":"text","text":text},"ui_context":{"cwd":root,"workspace_root":root},"tools":[crate::client_tool::tool_definition()]});
        if let Some(choice) = self.conversation().selected_model.clone() {
            params["model"] = json!(choice);
        }
        if let Some(id) = &self.session {
            params["session_id"] = json!(id);
        } else {
            params["new_session"] = json!(true);
        }
        if self.supports_workspace_identity
            && let Some(list) = &self.worktree_list
        {
            params["workspace_identity"] = json!({"project_id":list["project_id"],"checkout_id":list["checkout_id"],"root":root});
        }
        let row_id = format!("user-{}", self.next_id);
        let index = self.conversation().rows.len();
        self.conversation().changed_at(index);
        self.conversation().rows.push(Row {
            id: row_id,
            kind: "user".into(),
            title: "You".into(),
            body: text.into(),
            detail: String::new(),
            error: false,
        });
        self.conversation().title = text.chars().take(48).collect();
        let owner = self.key();
        self.bound_transcript(&owner);
        Some(self.rpc("run.start", params))
    }
    pub fn cancel(&mut self) -> Option<Value> {
        if !self.busy || self.cancel_pending {
            return None;
        }
        self.cancel_pending = true;
        self.status = "Stopping".into();
        self.active.clone().map(|id| {
            self.rpc(
                "run.cancel",
                json!({"run_id":id,"reason":"User stopped from desktop"}),
            )
        })
    }
    pub fn disconnected(&mut self, message: String) {
        if self.has_pending("worktree.create")
            && let Some(intent) = &self.worktree_intent
        {
            let mut unknown = intent.clone();
            unknown["phase"] = json!("unknown");
            unknown["error"] = json!(
                "Connection interrupted; creation outcome is unknown. Refresh and inspect this operation ID; nothing is resent."
            );
            self.worktree_operation = Some(unknown);
        }
        if self.busy {
            let owner = self.run_owner.clone().unwrap_or_else(|| self.key());
            let conversation = self.conversations.entry(owner).or_default();
            conversation.rows.push(Row {id:format!("interrupted-{}",self.next_id),kind:"notice".into(),title:"Interrupted · outcome unknown".into(),body:"The connection ended before a confirmed terminal outcome. Inspect history and workspace changes before resending; nothing is replayed automatically.".into(),detail:String::new(),error:true});
            conversation.changed_at(conversation.rows.len() - 1);
        }
        for conversation in self.conversations.values_mut() {
            conversation.discard_streams();
        }
        self.retryable = self.busy && self.last_prompt.is_some();
        self.connected = false;
        self.busy = false;
        self.loading = false;
        self.request = None;
        self.active = None;
        self.pending.clear();
        self.worktree_list = None;
        self.worktree_list_request = None;
        self.status = "Disconnected".into();
        self.error = Some(message);
    }
    pub fn choose_session(&mut self, id: Option<String>) -> Option<Value> {
        // History replay has no session envelope. Serialize replay and live execution.
        if self.busy || self.loading || self.request.is_some() {
            return None;
        }
        self.session = id.clone();
        self.error = None;
        self.last_prompt = None;
        if let Some(id) = id {
            self.loading = true;
            self.status = "Loading history".into();
            self.conversation().clear_transcript();
            self.conversation().transcript_evicted = true;
            Some(self.rpc(
                "session.history",
                json!({"session_id":id,"max_runs":40,"max_events":2500}),
            ))
        } else {
            self.status = "Ready".into();
            None
        }
    }
    pub fn create_thread(&mut self, title: &str) -> String {
        self.next_id += 1;
        let id = format!("draft-{}", uuid::Uuid::new_v4());
        self.conversations.entry(id.clone()).or_default().title = title.chars().take(80).collect();
        id
    }
    pub fn select_cached(&mut self, id: &str) -> bool {
        if self
            .conversations
            .get(id)
            .is_none_or(|c| c.transcript_evicted)
            || self.loading
        {
            return false;
        }
        if id.starts_with("draft-") {
            self.draft_key = id.into();
            self.session = None;
        } else {
            self.session = Some(id.into());
        }
        true
    }
    pub fn draft_slots(&self) -> usize {
        let count = self
            .conversations
            .iter()
            .filter(|(id, c)| id.starts_with("draft-") || !c.draft.is_empty())
            .count();
        // Reserve the selected input slot even before it contains text. An
        // internal agent can create other drafts while the human types here.
        let selected = self.key();
        let selected_counted = self
            .conversations
            .get(&selected)
            .is_some_and(|c| selected.starts_with("draft-") || !c.draft.is_empty());
        count + usize::from(!selected_counted)
    }
    pub fn can_select_draft(&self, id: &str) -> bool {
        self.draft_slots() < 64
            || self
                .conversations
                .get(id)
                .is_some_and(|c| id.starts_with("draft-") || !c.draft.is_empty())
            || self.key() == id
    }
    pub fn save_answer_draft(&mut self, id: &Value, text: String) {
        if let Some(request) = &mut self.request
            && request.id == *id
            && request.method == "ui.prompt.request"
        {
            request.answer_draft = Some(text);
        }
    }
    pub fn answer(&mut self, result: Value) -> Option<Value> {
        let request = self.request.take()?;
        Some(json!({"jsonrpc":"2.0","id":request.id,"result":result}))
    }
}

mod notifications;
#[cfg(test)]
mod tests;

impl State {
    pub(super) fn bound_transcript(&mut self, key: &str) {
        let Some(conversation) = self.conversations.get_mut(key) else {
            return;
        };
        for row in &mut conversation.rows {
            cap_display(&mut row.title, 256, "…");
            for text in [&mut row.body, &mut row.detail] {
                cap_display(
                    text,
                    65536,
                    "\n[Display truncated; full result remains in runtime storage]",
                );
            }
        }
        let mut bytes: usize = conversation.rows.iter().map(Row::display_bytes).sum();
        let mut remove = 0;
        while conversation.rows.len() - remove > 2500 || bytes > 4 * 1024 * 1024 {
            bytes = bytes.saturating_sub(conversation.rows[remove].display_bytes());
            remove += 1;
        }
        if remove > 0 {
            conversation.rows.drain(..remove);
            conversation.removed_rows += remove;
            conversation.dirty_from = conversation
                .dirty_from
                .map(|index| index.saturating_sub(remove));
        }
        // Keep at most eight loaded persisted transcripts. Draft text is never evicted.
        // Evicted sessions remain available via runtime session.history.
        let selected = self.key();
        let mut inactive: Vec<_> = self
            .conversations
            .iter()
            .filter(|(id, c)| {
                !id.starts_with("draft-")
                    && **id != selected
                    && self.run_owner.as_ref() != Some(*id)
                    && !c.transcript_evicted
            })
            .map(|(id, _)| id.clone())
            .collect();
        inactive.sort();
        let persisted = self
            .conversations
            .iter()
            .filter(|(id, c)| !id.starts_with("draft-") && !c.transcript_evicted)
            .count();
        for id in inactive.into_iter().take(persisted.saturating_sub(8)) {
            if let Some(c) = self.conversations.get_mut(&id)
                && !c.draft.is_empty()
            {
                c.clear_transcript();
                c.transcript_evicted = true;
            } else {
                self.conversations.remove(&id);
            }
        }
    }
}

#[derive(Clone, Copy, Default)]
pub(crate) struct TranscriptSnapshot {
    pub count: usize,
    pub removed: usize,
    pub generation: u64,
}

#[derive(Debug, Default, PartialEq, Eq)]
pub(crate) struct ScrollSync {
    pub replace: bool,
    pub removed: usize,
    pub appended: usize,
    pub remeasure: Option<std::ops::Range<usize>>,
}
impl ScrollSync {
    pub fn between(
        before: TranscriptSnapshot,
        after: TranscriptSnapshot,
        dirty_from: Option<usize>,
    ) -> Self {
        let removed = after
            .removed
            .saturating_sub(before.removed)
            .min(before.count);
        let remaining = before.count - removed;
        if before.generation != after.generation
            || after.removed < before.removed
            || after.count < remaining
        {
            return Self {
                replace: true,
                ..Default::default()
            };
        }
        Self {
            removed,
            appended: after.count - remaining,
            remeasure: dirty_from
                .filter(|start| *start < after.count)
                .map(|start| start..after.count),
            ..Default::default()
        }
    }
    pub fn changed(&self) -> bool {
        self.replace || self.removed > 0 || self.appended > 0 || self.remeasure.is_some()
    }
}

impl Conversation {
    pub(crate) fn snapshot(&self) -> TranscriptSnapshot {
        TranscriptSnapshot {
            count: self.rows.len(),
            removed: self.removed_rows,
            generation: self.replacement_generation,
        }
    }
    fn clear_transcript(&mut self) {
        self.rows.clear();
        self.streams.clear();
        self.stream_seen.clear();
        self.seen.clear();
        self.recent_runs.clear();
        self.removed_rows = 0;
        self.replacement_generation += 1;
        self.dirty_from = None;
    }
    fn discard_streams(&mut self) {
        if self.streams.is_empty() {
            return;
        }
        let ids: HashSet<_> = self.streams.keys().cloned().collect();
        self.rows.retain(|row| !ids.contains(&row.id));
        self.streams.clear();
        self.replacement_generation += 1;
        self.dirty_from = Some(0);
    }
    fn project_stream(&mut self, run: &str, event: &Value) {
        let Some(stream) = event["stream_id"]
            .as_str()
            .filter(|s| !s.is_empty() && s.len() <= 128)
        else {
            return;
        };
        if event["attempt"].as_u64().is_none_or(|a| a == 0)
            || !event["invocation_id"]
                .as_str()
                .is_some_and(|i| !i.is_empty() && i.len() <= 128)
        {
            return;
        }
        let id = format!("{run}-stream-{stream}");
        let phase = event["phase"].as_str().unwrap_or("");
        if phase == "start" {
            if !self.streams.is_empty() || self.stream_seen.contains(&id) {
                return;
            }
            self.stream_seen.push_back(id.clone());
            if self.stream_seen.len() > 64 {
                self.stream_seen.pop_front();
            }
            self.streams.insert(
                id.clone(),
                StreamProjection {
                    offset: 0,
                    invocation: event["invocation_id"].as_str().unwrap().into(),
                    attempt: event["attempt"].as_u64().unwrap(),
                },
            );
            self.changed_at(self.rows.len());
            self.rows.push(Row {
                id,
                kind: "assistant".into(),
                title: "Codelia · writing".into(),
                body: String::new(),
                detail: String::new(),
                error: false,
            });
            return;
        }
        let Some(active) = self.streams.get(&id) else {
            return;
        };
        if event["invocation_id"].as_str() != Some(active.invocation.as_str())
            || event["attempt"].as_u64() != Some(active.attempt)
        {
            return;
        }
        let offset = active.offset;
        let Some(index) = self.rows.iter().position(|row| row.id == id) else {
            self.streams.remove(&id);
            return;
        };
        let row = &mut self.rows[index];
        match phase {
            "delta" => {
                let Some(content) = event["content"].as_str() else {
                    return;
                };
                if event["offset"].as_u64() != Some(offset as u64)
                    || content.len() > 32768
                    || offset + content.len() > 2 * 1024 * 1024
                {
                    return;
                }
                row.body.push_str(content);
                cap_display(
                    &mut row.body,
                    65536,
                    "\n[Display truncated; canonical answer follows]",
                );
                self.streams.get_mut(&id).unwrap().offset = offset + content.len();
            }
            "commit" => {
                let Some(content) = event["content"].as_str() else {
                    return;
                };
                row.body = content.into();
                row.title = "Codelia".into();
                self.streams.remove(&id);
            }
            "discard" => {
                self.rows.remove(index);
                self.streams.remove(&id);
                self.replacement_generation += 1;
            }
            _ => return,
        }
        self.changed_at(index);
    }
    pub(super) fn changed_at(&mut self, index: usize) {
        self.dirty_from = Some(self.dirty_from.map_or(index, |old| old.min(index)));
    }
    fn accept_event(&mut self, run: &str, seq: i64) -> bool {
        if self.seen.get(run).is_some_and(|seen| seq <= *seen) {
            return false;
        }
        if !self.seen.contains_key(run) {
            if self.recent_runs.len() >= 64
                && let Some(old) = self.recent_runs.pop_front()
            {
                self.seen.remove(&old);
            }
            self.recent_runs.push_back(run.into());
        }
        self.seen.insert(run.into(), seq);
        true
    }
}
