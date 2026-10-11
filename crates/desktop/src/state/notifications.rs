use super::*;
impl State {
    pub fn handle(&mut self, message: Value) -> Vec<Value> {
        let mut followup = vec![];
        if message.get("method").is_none() {
            let id = message["id"].as_str().unwrap_or("");
            let Some(request) = self.pending.remove(id) else {
                return followup;
            };
            let method = request.method;
            if method == "worktree.list" && self.worktree_list_request.as_deref() != Some(id) {
                return followup;
            }
            if method == "model.list" && self.model_list_request.as_deref() != Some(id) {
                return followup;
            }
            if let Some(error) = message.get("error") {
                if method == "model.list" {
                    self.model_error = Some(
                        error["message"]
                            .as_str()
                            .unwrap_or("Model catalog unavailable")
                            .into(),
                    );
                    self.models.clear();
                    return followup;
                }

                if method.starts_with("worktree.") {
                    self.worktree_error = Some(
                        error["message"]
                            .as_str()
                            .unwrap_or("Worktree request failed")
                            .into(),
                    );
                    if method == "worktree.list" {
                        self.worktree_list = None;
                    }
                    return followup;
                }
                self.error = Some(
                    error["message"]
                        .as_str()
                        .unwrap_or("Runtime request failed")
                        .into(),
                );
                if method == "initialize" {
                    self.connected = false;
                }
                if method == "run.start" {
                    self.retryable = true;
                    self.busy = false;
                    self.active = None;
                    self.status = "Error".into();
                }
                if method == "session.history" {
                    self.loading = false;
                    self.status = "Error".into();
                }
                if method == "run.cancel" {
                    self.cancel_pending = false;
                    self.status = "Stop failed".into();
                }
                return followup;
            }
            let result = &message["result"];
            match method.as_str() {
                "initialize" => {
                    if result["protocol_version"] != "0" {
                        self.disconnected("Unsupported runtime protocol".into());
                        return followup;
                    }
                    self.connected = true;
                    self.supports_run_model =
                        result["server_capabilities"]["supports_run_model"] == true;
                    self.supports_new_session =
                        result["server_capabilities"]["supports_new_session"] == true;
                    self.supports_session_model_guard =
                        result["server_capabilities"]["supports_session_model_guard"] == true;
                    self.supports_workspace_identity =
                        result["server_capabilities"]["supports_workspace_identity"] == true;
                    self.status = "Ready".into();
                    self.supports_ui_request_cancel =
                        result["server_capabilities"]["supports_ui_request_cancel"] == true;
                    self.supports_subagents = result["server_capabilities"]["supported_task_kinds"]
                        .as_array()
                        .is_some_and(|k| k.iter().any(|v| v == "subagent"));
                    self.supports_worktrees =
                        result["server_capabilities"]["supports_worktrees"] == true;
                    if self.supports_worktrees {
                        followup.push(self.rpc("worktree.list", json!({})));
                    }
                    followup.push(self.rpc(
                        "session.list",
                        json!({"scope":"current_workspace","limit":100}),
                    ));
                    followup.push(self.rpc("model.list", json!({})));
                    followup.push(self.rpc("task.list", json!({"kind":"subagent","limit":100})));
                }
                "session.list" => {
                    self.sessions = result["sessions"].as_array().cloned().unwrap_or_default()
                }
                "worktree.list" => {
                    if let Some(id) = self
                        .worktree_operation
                        .as_ref()
                        .and_then(|op| op["operation_id"].as_str())
                        && let Some(operation) = result["operations"].as_array().and_then(|ops| {
                            ops.iter()
                                .find(|op| op["operation_id"].as_str() == Some(id))
                        })
                    {
                        self.worktree_operation = Some(operation.clone());
                    }
                    self.worktree_list = Some(result.clone());
                    self.worktree_error = None;
                }
                "worktree.create" => {
                    self.worktree_operation = Some(result["operation"].clone());
                    self.worktree_error = result["operation"]["error"].as_str().map(String::from);
                    // A pre-create observation can finish late; always request a newer snapshot.
                    followup.push(self.rpc("worktree.list", json!({})));
                }
                "session.history" => {
                    self.conversation().transcript_evicted = false;
                    let key = self.key();
                    self.bound_transcript(&key);
                    self.loading = false;
                    self.status = "Ready".into();
                    if result["truncated"] == true {
                        self.error = Some(
                            "Showing the latest 2,500 history events; older content is omitted."
                                .into(),
                        );
                    }
                }
                "model.list" => {
                    self.catalog_provider = result["provider"].as_str().unwrap_or("").into();
                    self.model_error = None;
                    if result["catalog_only"] != true {
                        self.model_provider = self.catalog_provider.clone();
                        self.model_available = result["current"].as_str().is_some();
                        self.model = result["current"]
                            .as_str()
                            .unwrap_or("No current model")
                            .into();
                    }
                    self.models = result["models"]
                        .as_array()
                        .map(|m| {
                            m.iter()
                                .filter_map(|v| v.as_str().map(String::from))
                                .collect()
                        })
                        .unwrap_or_default();
                }
                "model.set" => {
                    self.model = result["name"].as_str().unwrap_or("Model updated").into();
                    self.model_provider = result["provider"].as_str().unwrap_or("openai").into();
                    self.model_available = true;
                    self.model_error = None
                }
                "run.start" => {
                    if let Some(session) = result["session_id"].as_str()
                        && self.run_owner.as_ref().is_some_and(|owner| {
                            owner.starts_with("draft-")
                                && owner != session
                                && self.conversations.contains_key(session)
                        })
                    {
                        let run = result["run_id"].as_str().map(str::to_owned);
                        self.disconnected("Runtime reused an existing session for a new draft; both transcripts/drafts are preserved and the outcome is unknown".into());
                        if let Some(run) = run {
                            followup.push(self.rpc("run.cancel",json!({"run_id":run,"reason":"Unexpected session identity collision"})));
                        }
                        return followup;
                    }
                    if let Some(session) = result["session_id"].as_str()
                        && let Some(owner) =
                            self.run_owner.clone().filter(|id| id.starts_with("draft-"))
                    {
                        let selected = self.key() == owner;
                        let draft = self.conversations.remove(&owner).unwrap_or_default();
                        self.conversations.insert(session.into(), draft);
                        self.draft_epoch += 1;
                        self.run_owner = Some(session.into());
                        if selected {
                            self.session = Some(session.into());
                        }
                    }
                    self.active = result["run_id"].as_str().map(String::from);
                    if self.cancel_pending
                        && let Some(run) = self.active.clone()
                    {
                        followup.push(self.rpc("run.cancel", json!({"run_id":run})));
                    }
                }
                "task.list" => {
                    self.tasks = result["tasks"]
                        .as_array()
                        .map(|tasks| tasks.iter().take(100).cloned().map(bound_task).collect())
                        .unwrap_or_default()
                }
                "task.status" | "task.result"
                    if self.inspected_task.as_deref() == result["task_id"].as_str() =>
                {
                    self.task_detail = Some(bound_task(result.clone()));
                }
                "task.spawn" | "task.cancel" => {
                    if self.inspected_task.as_deref() == result["task_id"].as_str() {
                        self.task_detail = Some(bound_task(result.clone()));
                    }
                    followup.push(self.rpc("task.list", json!({"kind":"subagent","limit":100})));
                }
                _ => {}
            }
            return followup;
        }
        let method = message["method"].as_str().unwrap_or("");
        let params = &message["params"];
        if method == "ui.request.cancel" {
            if self
                .request
                .as_ref()
                .is_some_and(|request| request.id == params["request_id"])
            {
                self.request = None;
            }
        } else if method.starts_with("ui.") && method.ends_with(".request") {
            if self.request.is_some() {
                followup.push(json!({"jsonrpc":"2.0","id":message["id"],"error":{"code":-32000,"message":"Desktop already has a pending UI request"}}));
            } else {
                self.request = Some(Request {
                    id: message["id"].clone(),
                    method: method.into(),
                    params: params.clone(),
                    selected: HashSet::new(),
                    answer_draft: None,
                });
            }
        } else if method == "run.status" {
            // Runtime writes run.start acknowledgement before live notifications.
            // Ignore late terminals while idle or awaiting the next admission.
            if self.loading || !self.busy || self.active.is_none() {
                return followup;
            }
            let run = params["run_id"].as_str().unwrap_or("");
            if self.active.as_deref().is_some_and(|id| id != run) {
                return followup;
            }
            let status = params["status"].as_str().unwrap_or("unknown");
            self.status = status.into();
            if ["completed", "error", "cancelled"].contains(&status) {
                let owner = self.run_owner.clone().unwrap_or_else(|| self.key());
                self.conversations
                    .entry(owner)
                    .or_default()
                    .discard_streams();
                self.busy = false;
                self.active = None;
                self.cancel_pending = false;
                // A child confirmation can outlive this parent turn. With the
                // negotiated lifecycle, only a matching cancellation closes it.
                if !self.supports_ui_request_cancel {
                    self.request = None;
                }
                if status == "error" {
                    self.retryable = true;
                    self.error = Some(params["message"].as_str().unwrap_or("Run failed").into());
                }
                followup.push(self.rpc(
                    "session.list",
                    json!({"scope":"current_workspace","limit":100}),
                ));
            }
        } else if method == "run.context" {
            self.context = params["context_left_percent"].as_f64();
        } else if method == "agent.event" {
            if !self.loading && !self.busy {
                return followup;
            }
            if !self.loading && self.active.is_none() {
                return followup;
            }
            let run = params["run_id"].as_str().unwrap_or("").to_owned();
            if !self.loading && self.active.as_deref().is_some_and(|id| id != run) {
                return followup;
            }
            let Some(seq) = params["seq"].as_i64() else {
                return followup;
            };
            if run.is_empty() || run.len() > 256 {
                return followup;
            }
            if params["event"]["tool_call_id"]
                .as_str()
                .is_some_and(|id| id.len() > 256)
            {
                return followup;
            }
            let owner = if self.loading {
                self.key()
            } else {
                self.run_owner.clone().unwrap_or_else(|| self.key())
            };
            if !self
                .conversations
                .entry(owner)
                .or_default()
                .accept_event(&run, seq)
            {
                return followup;
            }
            self.project(&run, seq, &params["event"]);
            let owner = if self.loading {
                self.key()
            } else {
                self.run_owner.clone().unwrap_or_else(|| self.key())
            };
            self.bound_transcript(&owner);
        }
        followup
    }
    fn project(&mut self, run: &str, seq: i64, event: &Value) {
        let kind = event["type"].as_str().unwrap_or("");
        let content = event["content"].as_str().unwrap_or("");
        let owner = if self.loading {
            self.key()
        } else {
            self.run_owner.clone().unwrap_or_else(|| self.key())
        };
        let conversation = self.conversations.entry(owner).or_default();
        if kind == "text.stream" {
            if !self.loading {
                conversation.project_stream(run, event);
            }
            return;
        }
        if let Some(stream) = event["stream_id"].as_str().filter(|s| s.len() <= 128) {
            let id = format!("{run}-stream-{stream}");
            if let Some(index) = conversation.rows.iter().position(|row| row.id == id) {
                if kind == "final" && !conversation.streams.contains_key(&id) {
                    conversation.rows[index].body = content.into();
                    conversation.changed_at(index);
                }
                if kind == "text" || kind == "final" {
                    return;
                }
            }
        }
        let rows = &mut conversation.rows;
        let changed_index = match kind {
            "hidden_user_message" | "tool_call" | "llm.retry" => Some(rows.len()),
            "text" | "final" | "reasoning" => Some(rows.len().saturating_sub(1)),
            "tool_result" | "permission.preview" => {
                let id = format!("{run}-{}", event["tool_call_id"].as_str().unwrap_or("tool"));
                rows.iter().rposition(|row| row.id == id)
            }
            _ => None,
        };
        match kind {
            "hidden_user_message" => rows.push(Row {
                id: format!("{run}-user-{seq}"),
                kind: "user".into(),
                title: "You".into(),
                body: content.into(),
                detail: String::new(),
                error: false,
            }),
            "text" | "final" | "reasoning" => {
                let row_kind = if kind == "reasoning" {
                    "reasoning"
                } else {
                    "assistant"
                };
                let last = rows
                    .last_mut()
                    .filter(|r| r.kind == row_kind && r.id.starts_with(&format!("{run}-")));
                if let Some(row) = last {
                    if kind == "final" {
                        row.body = content.into();
                    } else {
                        row.body.push_str(content);
                    }
                } else {
                    rows.push(Row {
                        // Event identity stays stable when the bounded transcript
                        // drops old rows; current row count is not a unique ID.
                        id: format!("{run}-{row_kind}-{seq}"),
                        kind: row_kind.into(),
                        title: if kind == "reasoning" {
                            "Reasoning"
                        } else {
                            "Codelia"
                        }
                        .into(),
                        body: content.into(),
                        detail: String::new(),
                        error: false,
                    });
                }
            }
            "tool_call" => rows.push(Row {
                id: format!("{run}-{}", event["tool_call_id"].as_str().unwrap_or("tool")),
                kind: "tool".into(),
                title: format!("{} · running", event["tool"].as_str().unwrap_or("Tool")),
                body: String::new(),
                detail: serde_json::to_string_pretty(&event["args"]).unwrap_or_default(),
                error: false,
            }),
            "tool_result" | "permission.preview" => {
                let id = format!("{run}-{}", event["tool_call_id"].as_str().unwrap_or("tool"));
                if let Some(row) = rows.iter_mut().rev().find(|r| r.id == id) {
                    if kind == "tool_result" {
                        row.error = event["is_error"] == true;
                        row.title = format!(
                            "{} · {}",
                            event["tool"].as_str().unwrap_or("Tool"),
                            if row.error { "error" } else { "done" }
                        );
                        let result = event["result"].as_str().unwrap_or("");
                        row.body = serde_json::from_str::<Value>(result)
                            .map(|value| {
                                format!(
                                    "```json\n{}\n```",
                                    serde_json::to_string_pretty(&value).unwrap_or_default()
                                )
                            })
                            .unwrap_or_else(|_| result.into());
                    } else {
                        row.detail.push_str(&format!(
                            "\n{}\n{}",
                            event["summary"].as_str().unwrap_or(""),
                            event["diff"].as_str().unwrap_or("")
                        ));
                    }
                }
            }
            "llm.retry" => rows.push(Row {
                id: format!("{run}-retry-{seq}"),
                kind: "notice".into(),
                title: "Provider retry".into(),
                body: format!(
                    "{} · attempt {} · wait {} ms",
                    event["failure_kind"], event["next_attempt"], event["delay_ms"]
                ),
                detail: String::new(),
                error: false,
            }),
            _ => {}
        }
        if let Some(index) = changed_index {
            conversation.changed_at(index);
        }
    }
}
