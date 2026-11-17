use super::handlers::command::can_dispatch_prompt_now;
use super::runtime::{send_goal_continue, send_rpc_request, RpcResponse};
use super::state::LogKind;
use super::util::sanitize_paste;
use super::AppState;
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::io::BufWriter;
use std::process::ChildStdin;
use std::time::{Duration, Instant};

type RuntimeStdin = BufWriter<ChildStdin>;
const ACK_TIMEOUT: Duration = Duration::from_secs(5);

#[derive(Debug, Deserialize)]
pub(crate) struct Goal {
    goal_id: String,
    revision: u64,
    activation_id: String,
    pub objective: String,
    pub status: String,
    stop_reason: Option<String>,
    stop_detail: Option<String>,
    token_budget: Option<u64>,
    tokens_used: u64,
    usage_known: bool,
    automatic_runs: u8,
}

#[derive(Debug, Deserialize)]
pub(crate) struct GoalSnapshot {
    session_id: Option<String>,
    pub goal: Option<Goal>,
    pub can_continue: bool,
    accepted_run_id: Option<String>,
    active_run_id: Option<String>,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
pub(crate) struct GoalOffer {
    session_id: String,
    goal_id: String,
    revision: u64,
    continuation_id: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    after_run_id: Option<String>,
}

#[derive(Debug)]
pub(crate) enum GoalNotification {
    Updated(GoalSnapshot),
    Ready(GoalOffer),
}

#[derive(Debug)]
enum Request {
    Sync,
    Inspect,
    Change { bind_new_session: bool },
    Check { deadline: Instant },
}

#[derive(Debug)]
struct Continuation {
    request_id: String,
    offer: GoalOffer,
    check_at: Instant,
}

#[derive(Debug, Default)]
pub(crate) struct GoalUi {
    pub supported: bool,
    snapshot: Option<GoalSnapshot>,
    synced_session: Option<String>,
    offer: Option<GoalOffer>,
    requests: std::collections::HashMap<String, Request>,
    continuation: Option<Continuation>,
    suspended: bool,
}

impl GoalUi {
    pub fn snapshot(&self, session_id: Option<&str>) -> Option<&GoalSnapshot> {
        self.snapshot
            .as_ref()
            .filter(|snapshot| snapshot.session_id.as_deref() == session_id)
    }

    fn clear_continuation(&mut self) {
        self.continuation = None;
        self.requests
            .retain(|_, kind| !matches!(kind, Request::Check { .. }));
    }

    pub fn blocks_prompt(&self) -> bool {
        self.requests
            .values()
            .any(|request| matches!(request, Request::Change { .. } | Request::Check { .. }))
    }

    pub fn status<'a>(&self, snapshot: &'a GoalSnapshot) -> Option<&'a str> {
        let goal = snapshot.goal.as_ref()?;
        Some(
            if self.continuation.is_some()
                && self
                    .requests
                    .values()
                    .any(|request| matches!(request, Request::Check { .. }))
            {
                "checking"
            } else if goal.status == "active" && (!snapshot.can_continue || self.suspended) {
                "resume required"
            } else {
                match goal.status.as_str() {
                    "usage_limited" => "usage limited",
                    "budget_limited" => "budget limited",
                    status => status,
                }
            },
        )
    }
}

fn request(
    app: &mut AppState,
    writer: &mut RuntimeStdin,
    id: String,
    method: &str,
    params: Value,
    kind: Request,
) -> bool {
    if let Err(error) = send_rpc_request(writer, &id, method, params) {
        app.push_error_report("goal send error", error.to_string());
        return false;
    }
    app.goal.requests.insert(id, kind);
    true
}

pub(crate) fn command(
    app: &mut AppState,
    writer: &mut RuntimeStdin,
    next_id: &mut impl FnMut() -> String,
    args: &str,
) -> bool {
    if !app.goal.supported {
        app.push_line(
            LogKind::Error,
            "Goals are unavailable on this runtime connection.",
        );
        return false;
    }
    let session = app.runtime_info.session_id.clone();
    if args.is_empty() {
        let params = match &session {
            Some(session_id) => json!({"session_id": session_id}),
            None => json!({}),
        };
        return request(app, writer, next_id(), "goal.get", params, Request::Inspect);
    }
    if args == "pause" {
        if !pause(app, writer, next_id, false) {
            app.push_line(LogKind::Status, "No active goal on this connection.");
        }
        return true;
    }
    if app.is_running()
        || app.rpc_pending.run_start_id.is_some()
        || app.rpc_pending.upload.is_some()
        || app.rpc_pending.session_open_id.is_some()
        || app.rpc_pending.session_history_id.is_some()
        || app.goal.blocks_prompt()
    {
        app.push_line(
            LogKind::Status,
            "Wait for the current operation before changing the goal.",
        );
        return false;
    }
    let snapshot = app.goal.snapshot(session.as_deref());
    if session.is_some() && snapshot.is_none() {
        app.push_line(
            LogKind::Status,
            "Waiting for the session goal. Use /goal to refresh.",
        );
        return false;
    }
    let current = snapshot.and_then(|snapshot| snapshot.goal.as_ref());
    let mut params = serde_json::Map::new();
    if let Some(session) = &session {
        params.insert("session_id".into(), json!(session));
    }
    if let Some(goal) = current {
        params.insert("goal_id".into(), json!(goal.goal_id));
        params.insert("revision".into(), json!(goal.revision));
    }
    let subcommand = args.split_whitespace().next().unwrap_or_default();
    let method = match subcommand {
        "resume" | "clear" if args == subcommand && current.is_some() => {
            if subcommand == "resume" {
                "goal.resume"
            } else {
                "goal.clear"
            }
        }
        "resume" | "clear" if args == subcommand => {
            app.push_line(LogKind::Status, "No goal in this session.");
            return true;
        }
        "budget" => {
            let value = args["budget".len()..].trim();
            let budget = if value == "off" {
                Value::Null
            } else if let Ok(tokens) = value.parse::<u64>() {
                if tokens == 0 || tokens > 9_007_199_254_740_991 {
                    app.push_line(LogKind::Error, "Token budget must be a positive integer.");
                    return false;
                }
                json!(tokens)
            } else {
                app.push_line(LogKind::Error, "Usage /goal budget <tokens|off>");
                return false;
            };
            if current.is_none() {
                app.push_line(LogKind::Status, "Set a goal before changing its budget.");
                return true;
            }
            params.insert("token_budget".into(), budget);
            "goal.set"
        }
        _ => {
            params.insert("objective".into(), json!(args));
            "goal.set"
        }
    };
    request(
        app,
        writer,
        next_id(),
        method,
        Value::Object(params),
        Request::Change {
            bind_new_session: session.is_none(),
        },
    )
}

pub(crate) fn pause(
    app: &mut AppState,
    writer: &mut RuntimeStdin,
    next_id: &mut impl FnMut() -> String,
    interrupt: bool,
) -> bool {
    let Some(snapshot) = app.goal.snapshot(app.runtime_info.session_id.as_deref()) else {
        return false;
    };
    let Some(goal) = snapshot.goal.as_ref().filter(|_| snapshot.can_continue) else {
        return false;
    };
    let mut params = json!({"session_id": snapshot.session_id, "goal_id": goal.goal_id, "activation_id": goal.activation_id});
    if interrupt {
        if let Some(id) = app.runtime_info.active_run_id.as_deref() {
            params["run_id"] = json!(id);
        } else if let Some(start) = &app.goal.continuation {
            params["continuation_id"] = json!(start.offer.continuation_id);
        }
    }
    app.goal.suspended = true;
    app.goal.offer = None;
    if request(
        app,
        writer,
        next_id(),
        "goal.pause",
        params,
        Request::Change {
            bind_new_session: false,
        },
    ) {
        app.push_line(LogKind::Status, "Goal pause requested");
    }
    true
}

fn apply_snapshot(app: &mut AppState, snapshot: GoalSnapshot) {
    if snapshot.session_id != app.runtime_info.session_id {
        return;
    }
    if app
        .goal
        .snapshot
        .as_ref()
        .zip(snapshot.goal.as_ref())
        .is_some_and(|(previous, next)| {
            previous.session_id == snapshot.session_id
                && previous
                    .goal
                    .as_ref()
                    .is_some_and(|old| old.goal_id == next.goal_id && old.revision > next.revision)
        })
    {
        return;
    }
    if !snapshot.can_continue {
        app.goal.offer = None;
    }
    app.goal.synced_session = snapshot.session_id.clone();
    app.goal.snapshot = Some(snapshot);
}

pub(crate) fn notify(app: &mut AppState, notification: GoalNotification) {
    match notification {
        GoalNotification::Updated(snapshot) => apply_snapshot(app, snapshot),
        GoalNotification::Ready(offer) => {
            if app.runtime_info.session_id.as_deref() == Some(&offer.session_id)
                && app.goal.snapshot.as_ref().is_some_and(|snapshot| {
                    snapshot.can_continue
                        && snapshot.goal.as_ref().is_some_and(|goal| {
                            goal.goal_id == offer.goal_id && goal.revision == offer.revision
                        })
                })
                && !app.goal.suspended
            {
                app.goal.offer = Some(offer);
            }
        }
    }
}

fn display(app: &mut AppState) {
    let Some(snapshot) = app.goal.snapshot(app.runtime_info.session_id.as_deref()) else {
        return;
    };
    let Some(goal) = &snapshot.goal else {
        app.push_line(LogKind::Status, "No goal in this session.");
        return;
    };
    let status = app.goal.status(snapshot).unwrap_or(&goal.status);
    let reason = goal
        .stop_reason
        .as_deref()
        .map(|reason| format!(" · {}", reason.replace('_', " ")))
        .unwrap_or_default();
    let budget = goal
        .token_budget
        .map(|budget| budget.to_string())
        .unwrap_or_else(|| "off".to_owned());
    let usage = if goal.usage_known {
        ""
    } else {
        " known (some usage unavailable)"
    };
    let stop_detail = goal
        .stop_detail
        .as_deref()
        .map(|detail| format!("\n{}", sanitize_paste(detail)))
        .unwrap_or_default();
    let details = format!(
        "Goal {status}{reason}\n{}{stop_detail}\nParent model tokens {}{usage} (uncached input + output) · budget {budget} · automatic runs {}/3",
        sanitize_paste(&goal.objective),
        goal.tokens_used,
        goal.automatic_runs,
    );
    app.push_line(LogKind::Status, details);
}

pub(crate) fn handle_response(app: &mut AppState, response: &RpcResponse) -> bool {
    if app
        .goal
        .continuation
        .as_ref()
        .is_some_and(|start| start.request_id == response.id)
    {
        let run_id = response
            .result
            .as_ref()
            .and_then(|result| result.get("run_id"))
            .and_then(Value::as_str);
        if let Some(run_id) = run_id {
            if app.rpc_pending.run_start_id.as_deref() == Some(&response.id) {
                app.rpc_pending.run_start_id = None;
                app.runtime_info.active_run_id = Some(run_id.to_owned());
                app.update_run_status("running".into());
            }
            app.goal.clear_continuation();
        } else if let Some(error) = &response.error {
            app.goal.clear_continuation();
            app.goal.suspended = true;
            if app.rpc_pending.run_start_id.as_deref() == Some(&response.id) {
                app.rpc_pending.run_start_id = None;
                app.update_run_status("idle".into());
            }
            app.push_error_report("goal continuation", error_message(error));
        }
        return true;
    }
    let Some(kind) = app.goal.requests.remove(&response.id) else {
        return false;
    };
    let snapshot = response
        .result
        .as_ref()
        .and_then(|result| serde_json::from_value::<GoalSnapshot>(result.clone()).ok());
    if let Some(snapshot) = snapshot {
        if matches!(
            kind,
            Request::Inspect
                | Request::Change {
                    bind_new_session: true
                }
        ) && app.runtime_info.session_id.is_none()
        {
            app.runtime_info.session_id.clone_from(&snapshot.session_id);
        }
        if matches!(kind, Request::Change { .. }) && snapshot.can_continue {
            app.goal.suspended = false;
        }
        if matches!(kind, Request::Check { .. }) {
            if let Some(start) = app.goal.continuation.take() {
                let still_starting =
                    app.rpc_pending.run_start_id.as_deref() == Some(&start.request_id);
                if still_starting {
                    app.rpc_pending.run_start_id = None;
                    if let Some(run_id) = &snapshot.active_run_id {
                        app.runtime_info.active_run_id = Some(run_id.clone());
                        app.update_run_status("running".into());
                    } else {
                        app.update_run_status("idle".into());
                    }
                }
                if snapshot.accepted_run_id.is_none() {
                    app.goal.suspended = true;
                    app.goal.offer = None;
                    app.push_line(
                        LogKind::Status,
                        "Goal start could not be confirmed. Use /goal resume to continue.",
                    );
                }
            }
        }
        apply_snapshot(app, snapshot);
        if matches!(kind, Request::Inspect | Request::Change { .. }) {
            display(app);
        }
    } else {
        if matches!(kind, Request::Check { .. }) {
            stop_checking(app);
        }
        let message = response
            .error
            .as_ref()
            .map(error_message)
            .unwrap_or("No goal state returned.");
        app.push_error_report("goal request", message);
    }
    true
}

fn error_message(error: &Value) -> &str {
    error
        .get("message")
        .and_then(Value::as_str)
        .unwrap_or("Goal request failed.")
}

fn stop_checking(app: &mut AppState) {
    if let Some(start) = app.goal.continuation.take() {
        if app.rpc_pending.run_start_id.as_deref() == Some(&start.request_id) {
            app.rpc_pending.run_start_id = None;
            app.update_run_status("idle".into());
        }
    }
    app.goal.clear_continuation();
    app.goal.suspended = true;
    app.goal.offer = None;
}

fn expire_confirmation(app: &mut AppState, now: Instant) -> bool {
    // Admission may be waiting on the user's onboarding or approval dialog.
    if app.has_interaction_panel() {
        for kind in app.goal.requests.values_mut() {
            if let Request::Check { deadline } = kind {
                *deadline = now + ACK_TIMEOUT;
            }
        }
        return false;
    }
    let expired = app
        .goal
        .requests
        .values()
        .any(|kind| matches!(kind, Request::Check { deadline } if now >= *deadline));
    if expired {
        stop_checking(app);
        app.push_line(
            LogKind::Status,
            "Goal start confirmation timed out. Use /goal to check its state before resuming.",
        );
    }
    expired
}

pub(crate) fn tick(
    app: &mut AppState,
    writer: &mut RuntimeStdin,
    next_id: &mut impl FnMut() -> String,
    now: Instant,
) -> bool {
    if !app.goal.supported {
        return false;
    }
    if expire_confirmation(app, now) {
        return true;
    }
    if let Some(start) = &app.goal.continuation {
        if now >= start.check_at
            && !app
                .goal
                .requests
                .values()
                .any(|request| matches!(request, Request::Check { .. }))
        {
            let params = json!({"session_id": start.offer.session_id, "continuation_id": start.offer.continuation_id});
            if !request(
                app,
                writer,
                next_id(),
                "goal.get",
                params,
                Request::Check {
                    deadline: now + ACK_TIMEOUT,
                },
            ) {
                stop_checking(app);
            }
            return true;
        }
        return false;
    }
    let session = app.runtime_info.session_id.clone();
    if session != app.goal.synced_session && app.rpc_pending.session_open_id.is_none() {
        app.goal.snapshot = None;
        app.goal.offer = None;
        app.goal.suspended = false;
        app.goal.synced_session.clone_from(&session);
        if let Some(session) = session {
            return request(
                app,
                writer,
                next_id(),
                "goal.get",
                json!({"session_id": session}),
                Request::Sync,
            );
        }
        return true;
    }
    if app.goal.offer.is_none() || !can_continue_now(app) {
        return false;
    }
    let Some(offer) = app.goal.offer.take() else {
        return false;
    };
    let id = next_id();
    app.rpc_pending.run_start_id = Some(id.clone());
    app.update_run_status("starting".into());
    let sent = send_goal_continue(writer, &id, &offer);
    let check_at = match sent {
        Ok(()) => now + ACK_TIMEOUT,
        Err(error) => {
            app.push_error_report("goal start send error", error.to_string());
            now
        }
    };
    app.goal.continuation = Some(Continuation {
        request_id: id,
        offer,
        check_at,
    });
    true
}

fn can_continue_now(app: &AppState) -> bool {
    !app.goal.suspended
        && app.goal.requests.is_empty()
        && !app.rpc_pending.has_auto_start_blockers()
        && app.pending_prompt_queue.is_empty()
        && app.dispatching_prompt.is_none()
        && app.rpc_pending.upload.is_none()
        && !app.has_pending_clipboard_import()
        && app.rpc_pending.run_steer_ids.is_empty()
        && app.in_flight_steers.is_empty()
        && !app.has_interaction_panel()
        && can_dispatch_prompt_now(app)
        && app.input.current().is_empty()
        && app.referenced_attachment_count() == 0
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::app::{PendingPromptRun, PROMPT_DISPATCH_MAX_ATTEMPTS};

    #[test]
    fn paused_queue_and_pending_steer_take_priority_over_goal() {
        let mut app = AppState::default();
        let now = Instant::now();
        assert!(can_continue_now(&app));
        app.pending_prompt_queue.push_back(PendingPromptRun {
            seq: 1,
            queue_id: "queued".into(),
            queued_at: now,
            preview: "user work".into(),
            user_text: "user work".into(),
            display_text: "user work".into(),
            image_descriptions: Vec::new(),
            input_payload: json!({"type": "text", "text": "user work"}),
            attachment_count: 0,
            files: Default::default(),
            shell_result_count: 0,
            dispatch_attempts: PROMPT_DISPATCH_MAX_ATTEMPTS,
        });
        assert!(!can_continue_now(&app));
        app.pending_prompt_queue.clear();
        app.rpc_pending
            .run_steer_ids
            .insert("request".into(), "steer".into());
        assert!(!can_continue_now(&app));
        app.rpc_pending.run_steer_ids.clear();
        assert!(can_continue_now(&app));
    }

    #[test]
    fn missing_confirmation_releases_composer_and_requires_resume() {
        let mut app = AppState::default();
        let deadline = Instant::now() + ACK_TIMEOUT;
        app.goal
            .requests
            .insert("check".into(), Request::Check { deadline });
        assert!(!expire_confirmation(
            &mut app,
            deadline - Duration::from_millis(1)
        ));
        assert!(app.goal.blocks_prompt());
        assert!(expire_confirmation(&mut app, deadline));
        assert!(!app.goal.blocks_prompt());
        assert!(app.goal.suspended);
    }

    #[test]
    fn checking_uses_matching_receipt_after_missing_start_reply() {
        let mut app = AppState::default();
        app.runtime_info.session_id = Some("session".into());
        app.rpc_pending.run_start_id = Some("start".into());
        app.goal.continuation = Some(Continuation {
            request_id: "start".into(),
            check_at: Instant::now(),
            offer: serde_json::from_value(json!({
                "session_id": "session", "goal_id": "goal", "revision": 1,
                "continuation_id": "continuation",
            }))
            .unwrap(),
        });
        app.goal.requests.insert(
            "check".into(),
            Request::Check {
                deadline: Instant::now() + ACK_TIMEOUT,
            },
        );
        let checked = RpcResponse {
            id: "check".into(),
            result: Some(json!({
                "session_id": "session", "can_continue": true, "goal": null,
                "accepted_run_id": "run", "active_run_id": "run",
            })),
            error: None,
        };
        assert!(handle_response(&mut app, &checked));
        assert_eq!(app.runtime_info.active_run_id.as_deref(), Some("run"));
        assert!(app.goal.continuation.is_none());
        assert!(app.rpc_pending.run_start_id.is_none());
    }
}
