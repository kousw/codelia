use super::*;
#[test]
fn worktree_intents_share_ui_route_and_keep_parent_origin_when_human_focus_changes() {
    let mut state = State::default();
    state.connected = true;
    state.model_available = true;
    state.supports_new_session = true;
    state.supports_worktrees = true;
    state.busy = true;
    state.active = Some("parent-run".into());
    state.run_owner = Some("parent-thread".into());
    state.draft_key = "human-draft".into();
    let intent = json!({"action":"create_worktree","operation_id":"review-one","title":"Review","base_ref":"HEAD"});
    let outcome = internal_call(
        &mut state,
        "/repo",
        &json!({"name":"codelia_app","run_id":"parent-run","arguments":intent}),
    )
    .unwrap();
    assert_eq!(outcome.messages[0]["method"], "worktree.create");
    assert_eq!(
        outcome.messages[0]["params"],
        json!({"operation_id":"review-one","title":"Review","base_ref":"HEAD","thread_id":"parent-thread","run_id":"parent-run"})
    );
    assert_eq!(outcome.value["requires_user_confirmation"], true);
    assert_eq!(state.key(), "human-draft");
    assert!(state.worktree_list.is_none());
    assert!(internal(&mut state, "/repo", &intent).is_err());
    let mut ui_state = State::default();
    ui_state.connected = true;
    ui_state.model_available = true;
    ui_state.supports_new_session = true;
    ui_state.supports_worktrees = true;
    let ui = execute(
        &mut ui_state,
        "/repo",
        Command::CreateWorktree {
            operation_id: "review-one".into(),
            title: "Review".into(),
            base_ref: "HEAD".into(),
            origin_thread: "parent-thread".into(),
            run_id: None,
        },
    )
    .unwrap();
    assert_eq!(
        ui.messages[0]["params"]["operation_id"],
        outcome.messages[0]["params"]["operation_id"]
    );
    for invalid in [
        json!({"action":"create_worktree","operation_id":"../escape","title":"Review"}),
        json!({"action":"create_worktree","operation_id":"ok","title":"Review","approve":true}),
        json!({"action":"create_worktree","operation_id":"ok","title":"Review","path":"/arbitrary"}),
        json!({"action":"open_worktree","path":"/repo"}),
    ] {
        assert!(internal(&mut state, "/repo", &invalid).is_err());
    }
}

#[test]
fn worktree_observations_reject_late_snapshots_and_never_redirect_threads_on_creation() {
    let mut state = State::default();
    state.connected = true;
    state.model_available = true;
    state.supports_new_session = true;
    state.supports_worktrees = true;
    let old = state.rpc("worktree.list", json!({}));
    let create = execute(
        &mut state,
        "/repo",
        Command::CreateWorktree {
            operation_id: "review".into(),
            title: "Review".into(),
            base_ref: "HEAD".into(),
            origin_thread: "draft-0".into(),
            run_id: None,
        },
    )
    .unwrap();
    let follow = state.handle(json!({"id":create.messages[0]["id"],"result":{"operation":{"phase":"ready","path":"/review"}}}));
    assert_eq!(follow[0]["method"], "worktree.list");
    let list = json!({"project_id":"project","current_path":"/repo","worktrees":[{"path":"/review","available":true},{"path":"/missing","available":false}]});
    state.handle(json!({"id":follow[0]["id"],"result":list}));
    state.handle(json!({"id":old["id"],"result":{"worktrees":[]}}));
    assert_eq!(
        state.worktree_list.as_ref().unwrap()["worktrees"]
            .as_array()
            .unwrap()
            .len(),
        2
    );
    assert_eq!(state.key(), "draft-0");
    assert_eq!(
        execute(&mut state, "/repo", Command::OpenWorktree("/review".into()))
            .unwrap()
            .value["open_workspace"],
        "/review"
    );
    assert!(
        execute(
            &mut state,
            "/repo",
            Command::OpenWorktree("/missing".into())
        )
        .is_err()
    );
    assert!(
        execute(
            &mut state,
            "/repo",
            Command::OpenWorktree("/arbitrary".into())
        )
        .is_err()
    );
    state.disconnected("test disconnect".into());
    assert!(state.worktree_list.is_none());
    assert!(execute(&mut state, "/repo", Command::OpenWorktree("/review".into())).is_err());
}
#[test]
fn internal_agent_can_create_and_focus_without_redirecting_the_active_run() {
    let mut state = State::default();
    state.connected = true;
    state.model_available = true;
    state.supports_new_session = true;
    execute(&mut state, "/tmp", Command::Send("first".into())).unwrap();
    let owner = state.run_owner.clone();
    let result = internal(
        &mut state,
        "/tmp",
        &json!({"action":"create_thread","title":"Review"}),
    )
    .unwrap();
    internal(
        &mut state,
        "/tmp",
        &json!({"action":"select_thread","thread_id":result.value["thread_id"]}),
    )
    .unwrap();
    assert_eq!(state.run_owner, owner);
    assert!(state.busy);
    assert!(state.session.is_none());
    assert!(execute(&mut state, "/tmp", Command::Send("second".into())).is_err());
}
#[test]
fn ui_tool_cannot_approve_execute_rpc_or_change_auth() {
    let mut state = State::default();
    for action in ["approve", "auth.logout", "run.start", "delete_thread"] {
        assert!(internal(&mut state, "/tmp", &json!({"action":action})).is_err());
    }
}
#[test]
fn client_tool_requires_an_active_run_and_valid_bounded_arguments() {
    let mut state = State::default();
    let args = json!({"action":"create_thread","title":"Review"});
    assert!(
        internal_call(
            &mut state,
            "/tmp",
            &json!({"name":"codelia_app","arguments":args})
        )
        .is_err()
    );
    assert!(state.conversations.is_empty());
    state.connected = true;
    state.model_available = true;
    state.supports_new_session = true;
    state.busy = true;
    state.active = Some("current".into());
    assert!(
        internal_call(
            &mut state,
            "/tmp",
            &json!({"name":"codelia_app","run_id":"old","arguments":args})
        )
        .is_err()
    );
    assert!(
        internal_call(
            &mut state,
            "/tmp",
            &json!({"name":"codelia_app","run_id":"current","arguments":args})
        )
        .is_ok()
    );
    for invalid in [
        json!({"action":"create_thread","title":"x".repeat(81)}),
        json!({"action":"create_thread","title":"Review","approve":true}),
        json!({"action":"status","thread_id":"irrelevant"}),
    ] {
        assert!(internal(&mut state, "/tmp", &invalid).is_err());
    }
}
#[test]
fn independent_child_cancels_are_not_silently_dropped() {
    let mut state = State::default();
    let first = execute(&mut state, "/tmp", Command::CancelTask("alpha".into())).unwrap();
    let second = execute(&mut state, "/tmp", Command::CancelTask("beta".into())).unwrap();
    assert_eq!(first.messages.len(), 1);
    assert_eq!(second.messages.len(), 1);
    assert!(
        execute(&mut state, "/tmp", Command::CancelTask("alpha".into()))
            .unwrap()
            .messages
            .is_empty()
    );
    state.handle(json!({"id":first.messages[0]["id"],"error":{"message":"try again"}}));
    assert_eq!(
        execute(&mut state, "/tmp", Command::CancelTask("alpha".into()))
            .unwrap()
            .messages
            .len(),
        1
    );
}
#[test]
fn history_loading_is_rejected_while_a_ui_request_is_pending() {
    let mut state = State::default();
    state.handle(json!({"id":"approval","method":"ui.confirm.request","params":{}}));
    assert!(execute(&mut state, "/tmp", Command::LoadSession("s".into())).is_err());
    assert!(!state.loading);
}
#[test]
fn unsent_draft_limit_preserves_existing_text() {
    let mut state = State::default();
    state.conversation().draft = "Keep this unsent text".into();
    for _ in 0..63 {
        execute(&mut state, "/tmp", Command::CreateThread("Review".into())).unwrap();
    }
    assert!(execute(&mut state, "/tmp", Command::CreateThread("Another".into())).is_err());
    assert_eq!(state.conversation().draft, "Keep this unsent text");
}
#[test]
fn agent_and_human_panel_commands_stay_with_their_workspace() {
    let mut background = State::default();
    background.connected = true;
    background.model_available = true;
    background.supports_new_session = true;
    background.busy = true;
    background.active = Some("background".into());
    let mut foreground = State::default();
    execute(
        &mut foreground,
        "/foreground",
        Command::TaskStatus("child".into()),
    )
    .unwrap();
    internal_call(
        &mut background,
        "/background",
        &json!({"name":"codelia_app","run_id":"background","arguments":{"action":"open_changes"}}),
    )
    .unwrap();
    assert!(background.inspector == crate::state::Inspector::Changes);
    assert!(foreground.inspector == crate::state::Inspector::Task);
    execute(&mut background, "/background", Command::CloseInspector).unwrap();
    assert!(background.inspector == crate::state::Inspector::None);
    background.cancel_pending = true;
    assert!(internal_call(&mut background, "/background", &json!({"name":"codelia_app","run_id":"background","arguments":{"action":"open_changes"}})).is_err());
}

#[test]
fn evicted_session_reloads_history_without_discarding_its_unsent_draft() {
    let mut state = State::default();
    state.session = Some("selected".into());
    for i in 0..12 {
        state
            .conversations
            .entry(format!("session-{i:02}"))
            .or_default();
    }
    state.conversations.get_mut("session-00").unwrap().draft = "Continue researching 続き".into();
    state.conversation();
    state.bound_transcript("selected");
    assert!(state.conversations["session-00"].transcript_evicted);
    let selected = execute(
        &mut state,
        "/tmp",
        Command::SelectThread("session-00".into()),
    )
    .unwrap();
    assert_eq!(selected.messages.len(), 1);
    assert_eq!(selected.messages[0]["method"], "session.history");
    assert!(state.loading);
    assert_eq!(state.conversation().draft, "Continue researching 続き");
    state.handle(json!({"method":"agent.event","params":{"run_id":"prior-run","seq":1,"event":{"type":"text","content":"Actual persisted response"}}}));
    state.handle(json!({"id":selected.messages[0]["id"],"result":{"truncated":false}}));
    assert!(!state.loading);
    assert!(!state.conversation().transcript_evicted);
    assert_eq!(state.rows()[0].body, "Actual persisted response");
    assert_eq!(state.conversation().draft, "Continue researching 続き");
    assert!(
        execute(
            &mut state,
            "/tmp",
            Command::SelectThread("session-00".into())
        )
        .unwrap()
        .messages
        .is_empty(),
        "A genuinely cached transcript must not replay again"
    );
    state
        .conversations
        .insert("empty-persisted".into(), Default::default());
    assert!(
        execute(
            &mut state,
            "/tmp",
            Command::SelectThread("empty-persisted".into())
        )
        .unwrap()
        .messages
        .is_empty(),
        "A loaded empty session is different from an evicted transcript"
    );
}

#[test]
fn evicted_history_waits_for_parent_and_child_approval_without_losing_draft() {
    let mut state = State::default();
    let c = state
        .conversations
        .entry("saved-session".into())
        .or_default();
    c.draft = "Do not discard".into();
    c.transcript_evicted = true;
    state.busy = true;
    assert!(
        execute(
            &mut state,
            "/tmp",
            Command::SelectThread("saved-session".into())
        )
        .is_err()
    );
    state.busy = false;
    state.handle(
        json!({"id":"child-approval","method":"ui.confirm.request","params":{"task_id":"child"}}),
    );
    assert!(
        execute(
            &mut state,
            "/tmp",
            Command::SelectThread("saved-session".into())
        )
        .is_err()
    );
    assert!(!state.loading);
    assert_eq!(state.conversations["saved-session"].draft, "Do not discard");
}

#[test]
fn persisted_drafts_share_the_unsent_admission_limit() {
    let mut state = State::default();
    for i in 0..64 {
        state
            .conversations
            .entry(format!("saved-{i}"))
            .or_default()
            .draft = format!("Unsent {i}");
    }
    assert!(execute(&mut state, "/tmp", Command::CreateThread("New".into())).is_err());
    assert!(
        execute(
            &mut state,
            "/tmp",
            Command::LoadSession("new-persisted".into())
        )
        .is_err()
    );
    state
        .conversations
        .insert("empty".into(), Default::default());
    assert!(execute(&mut state, "/tmp", Command::SelectThread("empty".into())).is_err());
    assert!(execute(&mut state, "/tmp", Command::SelectThread("saved-0".into())).is_ok());
    assert_eq!(state.draft_slots(), 64);
    assert_eq!(state.conversations["saved-0"].draft, "Unsent 0");
}

#[test]
fn failed_history_replay_keeps_draft_and_requires_reload_before_send() {
    let mut state = State::default();
    state.connected = true;
    state.model_available = true;
    state.supports_new_session = true;
    state.conversations.entry("saved".into()).or_default().draft = "Unsent followup".into();
    let load = execute(&mut state, "/tmp", Command::LoadSession("saved".into())).unwrap();
    state.handle(
        json!({"id":load.messages[0]["id"],"error":{"message":"History temporarily unavailable"}}),
    );
    assert!(!state.loading);
    assert!(execute(&mut state, "/tmp", Command::Send("Unsent followup".into())).is_err());
    assert_eq!(state.conversation().draft, "Unsent followup");
    let retry = execute(&mut state, "/tmp", Command::SelectThread("saved".into())).unwrap();
    assert_eq!(retry.messages[0]["method"], "session.history");
}

#[test]
fn empty_selected_persisted_input_keeps_a_reserved_draft_slot() {
    let mut state = State::default();
    state.session = Some("selected-persisted".into());
    state.conversation();
    for _ in 0..63 {
        execute(
            &mut state,
            "/tmp",
            Command::CreateThread("Other draft".into()),
        )
        .unwrap();
    }
    assert!(execute(&mut state, "/tmp", Command::CreateThread("Overflow".into())).is_err());
    state.conversation().draft = "Human typed while agent created drafts".into();
    assert_eq!(state.draft_slots(), 64);
}
