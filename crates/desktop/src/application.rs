//! Application commands shared by human UI and the runtime's internal client tool.
//! Depends on state only. No GPUI types, process spawning or filesystem writes.
use crate::state::State;
use serde::Deserialize;
use serde_json::{Value, json};

#[derive(Deserialize)]
#[serde(tag = "action", rename_all = "snake_case", deny_unknown_fields)]
enum AppAction {
    ListThreads,
    Status,
    CreateThread {
        title: String,
    },
    SelectThread {
        thread_id: String,
    },
    OpenChanges,
    ListWorktrees,
    CreateWorktree {
        operation_id: String,
        title: String,
        base_ref: Option<String>,
    },
}

pub enum Command {
    Send(String),
    ClearDraft,
    Cancel,
    CreateThread(String),
    SelectThread(String),
    LoadSession(String),
    Answer(Value),
    ListTasks,
    TaskStatus(String),
    CancelTask(String),
    #[cfg(test)]
    SetModel(String),
    ListModels(String),
    ChooseModel {
        provider: String,
        name: String,
    },
    OpenChanges,
    CloseInspector,
    ListWorktrees,
    CreateWorktree {
        operation_id: String,
        title: String,
        base_ref: String,
        origin_thread: String,
        run_id: Option<String>,
    },
    OpenWorktree(String),
}
pub struct Outcome {
    pub messages: Vec<Value>,
    pub value: Value,
}
pub fn validate_clear(state: &State) -> Result<(), String> {
    if state.busy || state.loading || state.request.is_some() {
        Err("Wait for the current operation before clearing the draft".into())
    } else {
        Ok(())
    }
}
pub fn validate_send(state: &State, text: &str) -> Result<(), String> {
    if !state.connected
        || state.busy
        || state.loading
        || state.request.is_some()
        || state.has_pending("worktree.list")
        || text.trim().is_empty()
    {
        return Err("Workspace busy, loading or disconnected".into());
    }
    if !state.model_ready() {
        return Err("Choose a provider and model before sending".into());
    }
    if state
        .conversations
        .get(&state.key())
        .is_some_and(|c| c.selected_model.is_some())
        && !state.supports_run_model
    {
        return Err("Reconnect to a runtime supporting thread model selection".into());
    }
    if state.session.is_none() && !state.supports_new_session {
        return Err("Runtime cannot create isolated new sessions; update/reconnect before sending this draft".into());
    }
    if state
        .conversations
        .get(&state.key())
        .is_some_and(|c| c.transcript_evicted)
    {
        return Err(
            "Reload this session history before sending; its unsent draft is preserved".into(),
        );
    }
    if text.len() > 256 * 1024 {
        return Err(
            "Prompt exceeds 256 KiB; provide a shorter request or reference a workspace file"
                .into(),
        );
    }
    Ok(())
}
pub fn execute(state: &mut State, root: &str, command: Command) -> Result<Outcome, String> {
    let mut messages = vec![];
    let value = match command {
        Command::Send(text) => {
            validate_send(state, &text)?;
            messages.push(
                state
                    .start(&text, root)
                    .ok_or("Workspace busy, loading or disconnected")?,
            );
            json!({"accepted":true})
        }
        Command::ClearDraft => {
            validate_clear(state)?;
            state.set_draft(String::new());
            json!({"cleared":true})
        }
        Command::Cancel => {
            if let Some(msg) = state.cancel() {
                messages.push(msg);
            }
            json!({"stop_requested":state.cancel_pending})
        }
        Command::CreateThread(title) => {
            if state.loading {
                return Err("Wait for history replay".into());
            }
            if title.trim().is_empty() || title.chars().count() > 80 {
                return Err("Thread title must contain 1–80 characters".into());
            }
            if state.draft_slots() >= 64 {
                return Err("64 unsent drafts are already open; send an existing draft before creating another".into());
            }
            let id = state.create_thread(&title);
            json!({"thread_id":id,"persistence":"empty tab in memory; nonempty draft saved locally; runtime session on first send"})
        }
        Command::SelectThread(id) => {
            if !state.can_select_draft(&id) {
                return Err("64 unsent drafts are already open; send an existing draft before opening another session".into());
            }
            if state
                .conversations
                .get(&id)
                .is_some_and(|c| c.transcript_evicted)
            {
                messages.push(
                    state
                        .choose_session(Some(id.clone()))
                        .ok_or("Wait for the run or pending input before reloading this session")?,
                );
                json!({"selected":id,"loading":true})
            } else {
                if !state.select_cached(&id) {
                    return Err("Thread is not loaded; use session history when idle".into());
                }
                json!({"selected":id})
            }
        }
        Command::LoadSession(id) => {
            if !state.can_select_draft(&id) {
                return Err("64 unsent drafts are already open; send an existing draft before opening another session".into());
            }
            if state.busy || state.loading || state.request.is_some() {
                return Err("Stop the run before loading history".into());
            }
            messages.push(
                state
                    .choose_session(Some(id))
                    .ok_or("History replay was not admitted")?,
            );
            json!({"loading":true})
        }
        Command::Answer(result) => {
            messages.push(state.answer(result).ok_or("UI request already settled")?);
            json!({"answered":true})
        }
        Command::ListTasks => {
            if !state.has_pending("task.list") {
                messages.push(state.rpc("task.list", json!({"kind":"subagent","limit":100})));
            }
            json!({"requested":true})
        }
        Command::TaskStatus(id) => {
            state.inspector = crate::state::Inspector::Task;
            if state.inspected_task.as_ref() != Some(&id) {
                state.task_detail = None;
            }
            state.inspected_task = Some(id.clone());
            if !state.has_pending_target("task.status", &id) {
                messages.push(state.rpc("task.status", json!({"task_id":id})));
            }
            json!({"requested":true})
        }
        Command::CancelTask(id) => {
            if !state.has_pending_target("task.cancel", &id) {
                messages.push(state.rpc("task.cancel", json!({"task_id":id})));
            }
            json!({"requested":true})
        }
        Command::ListModels(provider) => {
            if !state.connected || state.busy || state.loading {
                return Err("Connect and stop the run before selecting a model".into());
            }
            if !crate::state::MODEL_PROVIDERS
                .iter()
                .any(|(id, _)| *id == provider)
            {
                return Err("Choose a supported provider".into());
            }
            state.catalog_provider = provider.clone();
            state.models.clear();
            state.model_error = None;
            messages.push(state.rpc(
                "model.list",
                json!({"provider":provider,"catalog_only":true}),
            ));
            json!({"requested":true})
        }
        Command::ChooseModel { provider, name } => {
            if !state.connected
                || !state.supports_run_model
                || state.busy
                || state.loading
                || state.has_pending("model.list")
            {
                return Err("Connect to a current runtime and wait before choosing a model".into());
            }
            if provider != state.catalog_provider || !state.models.contains(&name) {
                return Err("Choose a model from this provider's list".into());
            }
            state.conversation().selected_model =
                Some(crate::state::ModelChoice { provider, name });
            state.model_error = None;
            json!({"selected":true,"scope":"this thread; applied on Send; config/auth unchanged"})
        }
        #[cfg(test)]
        Command::SetModel(name) => {
            if !state.supports_session_model_guard {
                return Err("This runtime cannot safely change the selected thread's model; update/reconnect it".into());
            }
            if state.busy || state.loading {
                return Err("Stop the run before changing model".into());
            }
            messages.push(state.rpc(
                "model.set",
                json!({"name":name,"scope":"session","expected_session_id":state.session}),
            ));
            json!({"requested":true})
        }
        Command::OpenChanges => {
            state.inspector = crate::state::Inspector::Changes;
            json!({"panel":"changes"})
        }
        Command::CloseInspector => {
            state.inspector = crate::state::Inspector::None;
            json!({"panel":"closed"})
        }
        Command::ListWorktrees => {
            if !state.connected || !state.supports_worktrees {
                return Err("Local worktree management unavailable".into());
            }
            if !state.has_pending("worktree.list") {
                messages.push(state.rpc("worktree.list", json!({})));
            }
            json!({"requested":true,"cached":state.worktree_list,"last_operation":state.worktree_operation})
        }
        Command::CreateWorktree {
            operation_id,
            title,
            base_ref,
            origin_thread,
            run_id,
        } => {
            if !state.connected
                || !state.supports_worktrees
                || state.loading
                || state.request.is_some()
            {
                return Err("Wait for the current input/history, or reconnect to a runtime with worktree support".into());
            }
            if operation_id.is_empty()
                || operation_id.len() > 64
                || !operation_id
                    .bytes()
                    .all(|c| c.is_ascii_lowercase() || c.is_ascii_digit() || c == b'-')
                || operation_id.starts_with('-')
                || title.trim().is_empty()
                || title.chars().count() > 80
                || base_ref.is_empty()
                || base_ref.len() > 256
                || base_ref.starts_with('-')
                || base_ref.contains(['\n', '\r', '\0'])
                || origin_thread.is_empty()
                || origin_thread.len() > 256
            {
                return Err("Invalid worktree intent: use a stable operation ID, title, committed base ref and exact origin thread".into());
            }
            if state.has_pending("worktree.create") {
                return Err("A worktree create request is already pending; wait before sending another intent".into());
            }
            if run_id
                .as_deref()
                .is_some_and(|run| state.active.as_deref() != Some(run) || state.cancel_pending)
            {
                return Err("Worktree intent belongs to an inactive run".into());
            }
            let mut params = json!({"operation_id":operation_id,"title":title,"base_ref":base_ref,"thread_id":origin_thread});
            if let Some(run_id) = run_id {
                params["run_id"] = json!(run_id);
            }
            state.worktree_error = None;
            messages.push(state.rpc("worktree.create", params));
            json!({"requested":true,"operation_id":operation_id,"requires_user_confirmation":true,"execution":"asynchronous; inspect list_worktrees cached operations for result; never assume created"})
        }
        Command::OpenWorktree(path) => {
            if !state.connected
                || state.worktree_list.as_ref().is_none_or(|list| {
                    !list["worktrees"].as_array().is_some_and(|items| {
                        items
                            .iter()
                            .any(|item| item["path"] == path && item["available"] == true)
                    })
                })
            {
                return Err("Refresh and choose an available worktree from this project".into());
            }
            json!({"open_workspace":path})
        }
    };
    Ok(Outcome { messages, value })
}
pub fn internal(state: &mut State, root: &str, args: &Value) -> Result<Outcome, String> {
    let fields = args
        .as_object()
        .ok_or("codelia_app arguments must be an object")?;
    let allowed: &[&str] = match args["action"].as_str() {
        Some("create_thread") => &["action", "title"],
        Some("select_thread") => &["action", "thread_id"],
        Some("create_worktree") => &["action", "operation_id", "title", "base_ref"],
        Some("list_threads" | "status" | "open_changes" | "list_worktrees") => &["action"],
        _ => return Err("Unknown app action".into()),
    };
    if fields.keys().any(|key| !allowed.contains(&key.as_str())) {
        return Err("Unexpected codelia_app argument for this action".into());
    }
    if args["title"]
        .as_str()
        .is_some_and(|s| s.chars().take(81).count() > 80)
        || args["thread_id"].as_str().is_some_and(|s| s.len() > 256)
    {
        return Err("codelia_app title or thread_id exceeds its documented bound".into());
    }
    let action: AppAction = serde_json::from_value(args.clone())
        .map_err(|_| "Invalid codelia_app arguments; use the documented action and its fields")?;
    match action {
        AppAction::ListThreads => Ok(Outcome {
            messages: vec![],
            value: json!({"workspace_path":root,"project_id":state.worktree_list.as_ref().map(|v|&v["project_id"]),"loaded":state.conversations.iter().map(|(id,c)|json!({"thread_id":id,"title":c.title,"workspace_path":root,"history_loaded":!c.transcript_evicted,"running":state.busy&&state.run_owner.as_deref()==Some(id)})).collect::<Vec<_>>(),"sessions":state.sessions,"selected":state.key()}),
        }),
        AppAction::Status => Ok(Outcome {
            messages: vec![],
            value: json!({"workspace_path":root,"project_id":state.worktree_list.as_ref().map(|v|&v["project_id"]),"connected":state.connected,"status":state.status,"active_run":state.active,"run_thread":state.run_owner,"selected_thread":state.key(),"tasks":state.tasks}),
        }),
        AppAction::CreateThread { title } => execute(state, root, Command::CreateThread(title)),
        AppAction::SelectThread { thread_id } => {
            if thread_id.is_empty() || thread_id.len() > 256 {
                return Err("Use an exact loaded thread_id of at most 256 bytes".into());
            }
            execute(state, root, Command::SelectThread(thread_id))
        }
        AppAction::OpenChanges => execute(state, root, Command::OpenChanges),
        AppAction::ListWorktrees => execute(state, root, Command::ListWorktrees),
        AppAction::CreateWorktree {
            operation_id,
            title,
            base_ref,
        } => {
            let origin_thread = state
                .run_owner
                .clone()
                .ok_or("Worktree intent requires an active parent thread")?;
            let run_id = state
                .active
                .clone()
                .ok_or("Worktree intent requires an active parent run")?;
            execute(
                state,
                root,
                Command::CreateWorktree {
                    operation_id,
                    title,
                    base_ref: base_ref.unwrap_or_else(|| "HEAD".into()),
                    origin_thread,
                    run_id: Some(run_id),
                },
            )
        }
    }
}

pub fn internal_call(state: &mut State, root: &str, params: &Value) -> Result<Outcome, String> {
    if state.connected
        && state.busy
        && !state.cancel_pending
        && params["name"] == "codelia_app"
        && state
            .active
            .as_deref()
            .is_some_and(|run| !run.is_empty() && params["run_id"].as_str() == Some(run))
    {
        internal(state, root, &params["arguments"])
    } else {
        Err("Unknown client tool or inactive run".into())
    }
}

#[cfg(test)]
#[path = "application_tests.rs"]
mod tests;
