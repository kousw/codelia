use super::handlers::command::can_dispatch_prompt_now;
use super::runtime::{send_goal_continue, send_request, GoalNotification, RpcResponse, RuntimeTx};
use super::state::LogKind;
use super::util::sanitize_paste;
use super::AppState;
use serde_json::Value;
use std::time::{Duration, Instant};

const ACK_TIMEOUT: Duration = Duration::from_secs(5);

pub(crate) use crate::protocol::GoalSnapshot;
use crate::protocol::{
    methods, GoalGetParams, GoalOffer, GoalPauseParams, GoalSetParams, GoalStatus, GoalTarget,
    Patch,
};

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
            } else if goal.status == GoalStatus::Active
                && (!snapshot.can_continue || self.suspended)
            {
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

/// Goal requests; every result is a `GoalSnapshot`.
enum GoalRequest {
    Get(GoalGetParams),
    Set(GoalSetParams),
    Pause(GoalPauseParams),
    Resume(GoalTarget),
    Clear(GoalTarget),
}

fn request(
    app: &mut AppState,
    tx: &mut dyn RuntimeTx,
    request: GoalRequest,
    kind: Request,
) -> bool {
    let id = tx.next_id();
    let sent = match &request {
        GoalRequest::Get(params) => send_request::<methods::GoalGet>(tx, &id, params),
        GoalRequest::Set(params) => send_request::<methods::GoalSet>(tx, &id, params),
        GoalRequest::Pause(params) => send_request::<methods::GoalPause>(tx, &id, params),
        GoalRequest::Resume(params) => send_request::<methods::GoalResume>(tx, &id, params),
        GoalRequest::Clear(params) => send_request::<methods::GoalClear>(tx, &id, params),
    };
    if let Err(error) = sent {
        app.push_error_report("goal send error", error.to_string());
        return false;
    }
    app.goal.requests.insert(id, kind);
    true
}

pub(crate) fn command(app: &mut AppState, tx: &mut dyn RuntimeTx, args: &str) -> bool {
    if !app.goal.supported {
        app.push_line(
            LogKind::Error,
            "Goals are unavailable on this runtime connection.",
        );
        return false;
    }
    let session = app.runtime_info.session_id.clone();
    if args.is_empty() {
        let params = GoalGetParams {
            session_id: session.clone(),
            continuation_id: None,
        };
        return request(app, tx, GoalRequest::Get(params), Request::Inspect);
    }
    if args == "pause" {
        if !pause(app, tx, false) {
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
    let kind = Request::Change {
        bind_new_session: session.is_none(),
    };
    let subcommand = args.split_whitespace().next().unwrap_or_default();
    let mut params = GoalSetParams {
        session_id: session.clone(),
        goal_id: current.map(|goal| goal.goal_id.clone()),
        revision: current.map(|goal| goal.revision),
        ..Default::default()
    };
    match (subcommand, current) {
        ("resume" | "clear", Some(goal)) if args == subcommand => {
            let target = GoalTarget {
                session_id: goal.session_id.clone(),
                goal_id: goal.goal_id.clone(),
                revision: goal.revision,
            };
            let goal_request = if subcommand == "resume" {
                GoalRequest::Resume(target)
            } else {
                GoalRequest::Clear(target)
            };
            return request(app, tx, goal_request, kind);
        }
        ("resume" | "clear", None) if args == subcommand => {
            app.push_line(LogKind::Status, "No goal in this session.");
            return true;
        }
        ("budget", _) => {
            let value = args["budget".len()..].trim();
            params.token_budget = if value == "off" {
                Patch::Null
            } else if let Ok(tokens) = value.parse::<u64>() {
                if tokens == 0 || tokens > 9_007_199_254_740_991 {
                    app.push_line(LogKind::Error, "Token budget must be a positive integer.");
                    return false;
                }
                Patch::Value(tokens as i64)
            } else {
                app.push_line(LogKind::Error, "Usage /goal budget <tokens|off>");
                return false;
            };
            if current.is_none() {
                app.push_line(LogKind::Status, "Set a goal before changing its budget.");
                return true;
            }
        }
        _ => params.objective = Some(args.to_owned()),
    }
    request(app, tx, GoalRequest::Set(params), kind)
}

pub(crate) fn pause(app: &mut AppState, tx: &mut dyn RuntimeTx, interrupt: bool) -> bool {
    let Some(snapshot) = app.goal.snapshot(app.runtime_info.session_id.as_deref()) else {
        return false;
    };
    let Some(goal) = snapshot.goal.as_ref().filter(|_| snapshot.can_continue) else {
        return false;
    };
    let mut params = GoalPauseParams {
        session_id: goal.session_id.clone(),
        goal_id: goal.goal_id.clone(),
        activation_id: goal.activation_id.clone(),
        run_id: None,
        continuation_id: None,
    };
    if interrupt {
        if let Some(id) = app.runtime_info.active_run_id.as_deref() {
            params.run_id = Some(id.to_owned());
        } else if let Some(start) = &app.goal.continuation {
            params.continuation_id = Some(start.offer.continuation_id.clone());
        }
    }
    app.goal.suspended = true;
    app.goal.offer = None;
    if request(
        app,
        tx,
        GoalRequest::Pause(params),
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
    let status = app.goal.status(snapshot).unwrap_or(goal.status.as_str());
    let reason = goal
        .stop_reason
        .as_ref()
        .map(|reason| format!(" · {}", reason.as_str().replace('_', " ")))
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
        let run_id = match response
            .result
            .clone()
            .map(crate::protocol::decode_result::<methods::GoalContinue>)
        {
            Some(Ok(result)) => Some(result.run_id),
            Some(Err(error)) => {
                // The status check that follows resolves the continuation.
                app.push_line(LogKind::Error, error.to_string());
                None
            }
            None => None,
        };
        if let Some(run_id) = run_id {
            if app.rpc_pending.run_start_id.as_deref() == Some(&response.id) {
                app.rpc_pending.run_start_id = None;
                app.runtime_info.active_run_id = Some(run_id);
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
    let snapshot =
        match response.result.clone().map(|result| {
            crate::protocol::DecodeError::decode::<GoalSnapshot>("goal result", result)
        }) {
            Some(Ok(snapshot)) => Some(snapshot),
            Some(Err(error)) => {
                app.push_line(LogKind::Error, error.to_string());
                None
            }
            None => None,
        };
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

pub(crate) fn tick(app: &mut AppState, tx: &mut dyn RuntimeTx, now: Instant) -> bool {
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
            let params = GoalGetParams {
                session_id: Some(start.offer.session_id.clone()),
                continuation_id: Some(start.offer.continuation_id.clone()),
            };
            if !request(
                app,
                tx,
                GoalRequest::Get(params),
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
                tx,
                GoalRequest::Get(GoalGetParams {
                    session_id: Some(session),
                    continuation_id: None,
                }),
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
    let id = tx.next_id();
    app.rpc_pending.run_start_id = Some(id.clone());
    app.update_run_status("starting".into());
    let sent = send_goal_continue(tx, &id, &offer);
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
    use serde_json::json;

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

    #[test]
    fn goal_continue_send_failure_keeps_run_start_id_and_schedules_immediate_check() {
        let mut app = AppState::default();
        app.goal.supported = true;
        app.runtime_info.session_id = Some("session".into());
        app.goal.synced_session = Some("session".into());
        app.goal.offer = Some(
            serde_json::from_value(json!({
                "session_id": "session",
                "goal_id": "goal",
                "revision": 1,
                "continuation_id": "continuation",
            }))
            .unwrap(),
        );
        let mut tx = crate::app::runtime::MockRuntimeTx::default();
        tx.fail_next = Some(std::io::ErrorKind::BrokenPipe);
        let now = Instant::now();

        assert!(tick(&mut app, &mut tx, now));
        assert_eq!(app.rpc_pending.run_start_id.as_deref(), Some("1"));
        assert_eq!(app.run_status.as_deref(), Some("starting"));
        let continuation = app
            .goal
            .continuation
            .as_ref()
            .expect("continuation kept for verification");
        assert_eq!(continuation.request_id, "1");
        assert_eq!(continuation.check_at, now);
        assert!(tx.sent.is_empty());
    }
}
