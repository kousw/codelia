use super::*;
#[test]
fn model_guard_is_negotiated_and_reconciled_unknown_status_replaces_cached_ready() {
    let mut s = State::default();
    assert!(
        crate::application::execute(
            &mut s,
            "/workspace",
            crate::application::Command::SetModel("fixture".into())
        )
        .is_err()
    );
    let init = s.initialize();
    s.handle(json!({"id":init["id"],"result":{"protocol_version":"0","server_capabilities":{"supports_session_model_guard":true}}}));
    s.session = Some("selected".into());
    let model = crate::application::execute(
        &mut s,
        "/workspace",
        crate::application::Command::SetModel("fixture".into()),
    )
    .unwrap();
    assert_eq!(
        model.messages[0]["params"]["expected_session_id"],
        "selected"
    );
    s.worktree_operation = Some(json!({"operation_id":"one","phase":"ready"}));
    let list = s.rpc("worktree.list", json!({}));
    s.handle(json!({"id":list["id"],"result":{"operations":[{"operation_id":"one","phase":"unknown","recorded_phase":"ready"}]}}));
    assert_eq!(s.worktree_operation.as_ref().unwrap()["phase"], "unknown");
    assert!(!s.has_pending("worktree.create"));
}
#[test]
fn new_drafts_are_explicit_and_session_collision_preserves_both_conversations() {
    let mut s = State {
        connected: true,
        model_available: true,
        supports_new_session: true,
        ..Default::default()
    };
    s.conversations
        .entry("persisted-old".into())
        .or_default()
        .draft = "old unsent 日本語".into();
    s.conversation().draft = "new unsent 日本語".into();
    let request = s.start("brand new", "/workspace-one").unwrap();
    assert_eq!(request["params"]["new_session"], true);
    assert!(request["params"].get("session_id").is_none());
    let actions = s.handle(
        json!({"id":request["id"],"result":{"run_id":"bad-run","session_id":"persisted-old"}}),
    );
    assert!(!s.connected);
    assert_eq!(s.key(), "draft-0");
    assert_eq!(s.conversations["persisted-old"].draft, "old unsent 日本語");
    assert_eq!(s.conversations["draft-0"].draft, "new unsent 日本語");
    assert_eq!(actions.len(), 1);
    assert_eq!(actions[0]["method"], "run.cancel");
    assert_eq!(actions[0]["params"]["run_id"], "bad-run");
    assert!(
        s.conversations["draft-0"]
            .rows
            .iter()
            .any(|row| row.title.contains("unknown"))
    );
}

#[test]
fn reconnect_and_late_create_reply_cannot_replay_unknown_operations_or_prompts() {
    let mut s = State {
        connected: true,
        model_available: true,
        supports_new_session: true,
        ..Default::default()
    };
    s.conversation().draft = "retained draft".into();
    let create = s.rpc(
        "worktree.create",
        json!({"operation_id":"one","title":"One","thread_id":"draft-0"}),
    );
    s.start("uncertain write", "/workspace");
    s.active = Some("r".into());
    s.disconnected("lost pipe".into());
    assert_eq!(s.worktree_operation.as_ref().unwrap()["phase"], "unknown");
    assert_eq!(s.conversation().draft, "retained draft");
    s.handle(json!({"id":create["id"],"result":{"operation":{"phase":"ready"}}}));
    assert_eq!(s.worktree_operation.as_ref().unwrap()["phase"], "unknown");
    let initialize = s.initialize();
    let follow=s.handle(json!({"id":initialize["id"],"result":{"protocol_version":"0","server_capabilities":{"supports_new_session":true,"supports_worktrees":true}}}));
    assert!(follow.iter().all(|message| {
        !["run.start", "worktree.create"].contains(&message["method"].as_str().unwrap_or(""))
    }));
    assert_eq!(s.conversation().draft, "retained draft");
}

#[test]
fn legacy_runtime_cannot_silently_accept_a_new_draft_as_its_previous_session() {
    let mut s = State::default();
    let initialize = s.initialize();
    s.handle(
        json!({"id":initialize["id"],"result":{"protocol_version":"0","server_capabilities":{}}}),
    );
    assert!(s.start("new", "/workspace").is_none());
    assert!(!s.busy);
    s.model_available = true; // Fixture represents an acknowledged valid configured model.
    s.session = Some("existing".into());
    assert_eq!(
        s.start("resume", "/workspace").unwrap()["params"]["session_id"],
        "existing"
    );
}
#[test]
fn double_send_and_early_stop_are_serialized() {
    let mut s = State {
        connected: true,
        model_available: true,
        supports_new_session: true,
        ..Default::default()
    };
    let start = s.start("hello", "/tmp").unwrap();
    assert!(s.start("second", "/tmp").is_none());
    assert!(s.cancel().is_none());
    let next = s.handle(json!({"id":start["id"],"result":{"run_id":"r","session_id":"s"}}));
    assert_eq!(next[0]["method"], "run.cancel");
    assert!(s.cancel().is_none());
    s.handle(json!({"method":"run.status","params":{"run_id":"r","status":"cancelled"}}));
    assert!(!s.busy);
    assert_eq!(s.session.as_deref(), Some("s"));
}
#[test]
fn late_events_and_history_are_isolated_and_final_is_not_duplicated() {
    let mut s = State {
        connected: true,
        model_available: true,
        supports_new_session: true,
        ..Default::default()
    };
    s.start("hello", "/tmp");
    s.active = Some("r".into());
    for (run, seq, kind, text) in [
        ("old", 0, "text", "wrong"),
        ("r", 0, "text", "part"),
        ("r", 0, "text", "part"),
        ("r", 1, "final", "complete"),
    ] {
        s.handle(json!({"method":"agent.event","params":{"run_id":run,"seq":seq,"event":{"type":kind,"content":text}}}));
    }
    assert_eq!(s.rows().len(), 2);
    assert_eq!(s.rows()[1].body, "complete");
    assert!(s.choose_session(Some("other".into())).is_none());
    assert!(s.session.is_none());
}
#[test]
fn approval_settles_once_and_disconnect_clears_busy() {
    let mut s = State {
        busy: true,
        ..Default::default()
    };
    s.handle(
        json!({"id":"approval","method":"ui.confirm.request","params":{"title":"Write file"}}),
    );
    assert_eq!(s.answer(json!({"ok":false})).unwrap()["id"], "approval");
    assert!(s.answer(json!({"ok":true})).is_none());
    s.disconnected("closed".into());
    assert!(!s.busy);
    assert!(s.error.is_some());
}

#[test]
fn start_error_releases_busy_and_keeps_retry_input() {
    let mut s = State {
        connected: true,
        model_available: true,
        supports_new_session: true,
        ..Default::default()
    };
    let start = s.start("keep this", "/tmp").unwrap();
    s.cancel();
    s.handle(json!({"id":start["id"],"error":{"message":"failed admission"}}));
    assert!(!s.busy);
    assert_eq!(s.last_prompt.as_deref(), Some("keep this"));
    assert!(s.retryable);
    assert!(s.start("retry explicitly", "/tmp").is_some());
}

#[test]
fn final_after_tool_preserves_intermediate_text_and_tool_order() {
    let mut s = State {
        connected: true,
        model_available: true,
        supports_new_session: true,
        ..Default::default()
    };
    s.start("inspect", "/tmp");
    s.active = Some("r".into());
    let events = [
        json!({"type":"text","content":"Before tool"}),
        json!({"type":"tool_call","tool_call_id":"t","tool":"read","args":{}}),
        json!({"type":"tool_result","tool_call_id":"t","tool":"read","result":"actual file","is_error":false}),
        json!({"type":"final","content":"After tool"}),
    ];
    for (seq, event) in events.into_iter().enumerate() {
        s.handle(json!({"method":"agent.event","params":{"run_id":"r","seq":seq,"event":event}}));
    }
    assert_eq!(
        s.rows().iter().map(|r| r.kind.as_str()).collect::<Vec<_>>(),
        vec!["user", "assistant", "tool", "assistant"]
    );
    assert_eq!(s.rows()[1].body, "Before tool");
    assert_eq!(s.rows()[3].body, "After tool");
}

#[test]
fn acknowledgement_and_events_stay_with_original_thread_after_selection() {
    let mut s = State {
        connected: true,
        model_available: true,
        supports_new_session: true,
        ..Default::default()
    };
    let start = s.start("owner", "/tmp").unwrap();
    let other = s.create_thread("other");
    assert!(s.select_cached(&other));
    s.handle(json!({"id":start["id"],"result":{"run_id":"r","session_id":"persisted-owner"}}));
    s.handle(json!({"method":"agent.event","params":{"run_id":"r","seq":0,"event":{"type":"final","content":"belongs to owner"}}}));
    assert_eq!(s.key(), other);
    assert!(s.rows().is_empty());
    assert_eq!(
        s.conversations["persisted-owner"].rows[1].body,
        "belongs to owner"
    );
}

#[test]
fn transcript_caps_bytes_without_splitting_japanese_and_keeps_drafts() {
    let mut s = State {
        session: Some("selected".into()),
        ..Default::default()
    };
    for i in 0..12 {
        s.conversations
            .insert(format!("session-{i}"), Conversation::default());
    }
    let c = s.conversations.entry("selected".into()).or_default();
    for i in 0..100 {
        c.rows.push(Row {
            id: format!("row-{i}"),
            kind: "assistant".into(),
            title: "Codelia".into(),
            body: "日本語".repeat(10000),
            detail: String::new(),
            error: false,
        });
    }
    s.conversations
        .entry("draft-keep".into())
        .or_default()
        .draft = "unsent text".into();
    s.bound_transcript("selected");
    assert!(
        s.rows()
            .iter()
            .map(|r| r.body.len() + r.detail.len())
            .sum::<usize>()
            <= 4 * 1024 * 1024
    );
    assert!(s.rows().iter().all(|r| r.body.ends_with("storage]")));
    assert!(
        s.conversations
            .keys()
            .filter(|id| !id.starts_with("draft-"))
            .count()
            <= 8
    );
    assert_eq!(s.conversations["draft-keep"].draft, "unsent text");
}

#[test]
fn selected_child_ignores_late_other_child_status() {
    let mut s = State {
        inspected_task: Some("new-child".into()),
        ..Default::default()
    };
    let old = s.rpc("task.status", json!({"task_id":"old-child"}));
    let new = s.rpc("task.status", json!({"task_id":"new-child"}));
    s.handle(json!({"id":new["id"],"result":{"task_id":"new-child","state":"completed"}}));
    s.handle(json!({"id":old["id"],"result":{"task_id":"old-child","state":"running"}}));
    assert_eq!(s.task_detail.unwrap()["task_id"], "new-child");
}

#[test]
fn transcript_row_identity_survives_eviction_within_one_run() {
    let mut s = State {
        connected: true,
        model_available: true,
        supports_new_session: true,
        ..Default::default()
    };
    s.start("long interleaved conversation", "/tmp");
    s.active = Some("r".into());
    for i in 0..1400 {
        for (offset, event) in [
            json!({"type":"tool_call","tool_call_id":format!("t-{i}"),"tool":"read","args":{}}),
            json!({"type":"tool_result","tool_call_id":format!("t-{i}"),"tool":"read","result":"actual result"}),
            json!({"type":"text","content":"After the tool"}),
        ].into_iter().enumerate() {
            s.handle(json!({"method":"agent.event","params":{"run_id":"r","seq":i*3+offset,"event":event}}));
        }
    }
    assert_eq!(s.rows().len(), 2500);
    let ids: HashSet<_> = s.rows().iter().map(|row| &row.id).collect();
    assert_eq!(
        ids.len(),
        s.rows().len(),
        "visible row IDs must remain unique after older rows are evicted"
    );
}

#[test]
fn long_run_duplicates_and_hidden_context_keep_identity() {
    let mut s = State {
        connected: true,
        model_available: true,
        supports_new_session: true,
        ..Default::default()
    };
    s.start("long", "/tmp");
    s.active = Some("r".into());
    for seq in 0..10001 {
        s.handle(json!({"method":"agent.event","params":{"run_id":"r","seq":seq,"event":{"type":"text","content":"x"}}}));
    }
    let before = s.rows().last().unwrap().body.clone();
    s.handle(json!({"method":"agent.event","params":{"run_id":"r","seq":0,"event":{"type":"text","content":"DUPLICATE"}}}));
    assert_eq!(s.rows().last().unwrap().body, before);
    for seq in 10001..10003 {
        s.handle(json!({"method":"agent.event","params":{"run_id":"r","seq":seq,"event":{"type":"hidden_user_message","content":"child message"}}}));
    }
    let ids: HashSet<_> = s.rows().iter().map(|r| &r.id).collect();
    assert_eq!(ids.len(), s.rows().len());
}

#[test]
fn model_supplied_titles_and_initial_prompt_obey_display_bounds() {
    let mut s = State {
        connected: true,
        model_available: true,
        supports_new_session: true,
        ..Default::default()
    };
    s.start(&"日本語".repeat(15000), "/tmp");
    assert!(s.rows()[0].body.len() <= 65536);
    s.active = Some("r".into());
    s.handle(json!({"method":"agent.event","params":{"run_id":"r","seq":1,"event":{"type":"tool_call","tool_call_id":"tool","tool":"😀".repeat(20000),"args":{}}}}));
    assert!(s.rows().last().unwrap().title.len() <= 256);
    let before = s.rows().len();
    s.handle(json!({"method":"agent.event","params":{"run_id":"r","seq":2,"event":{"type":"tool_call","tool_call_id":"x".repeat(257),"tool":"read","args":{}}}}));
    assert_eq!(s.rows().len(), before);
}

#[test]
fn child_confirmation_outlives_parent_stop_and_only_matching_cancel_closes_it() {
    let mut s = State {
        connected: true,
        model_available: true,
        supports_new_session: true,
        busy: true,
        active: Some("parent".into()),
        supports_ui_request_cancel: true,
        ..Default::default()
    };
    s.handle(json!({"id":"child-approval","method":"ui.confirm.request","params":{"run_id":"parent","task_id":"child","title":"Child write"}}));
    s.handle(json!({"method":"run.status","params":{"run_id":"parent","status":"cancelled"}}));
    assert!(!s.busy);
    assert_eq!(s.request.as_ref().unwrap().params["task_id"], "child");
    s.handle(json!({"method":"ui.request.cancel","params":{"request_id":"stale-parent-approval","reason":"aborted"}}));
    assert!(s.request.is_some());
    s.handle(json!({"method":"ui.request.cancel","params":{"request_id":"child-approval","reason":"aborted"}}));
    assert!(s.request.is_none());
    s.handle(
        json!({"id":"next-child","method":"ui.confirm.request","params":{"task_id":"next-child"}}),
    );
    s.handle(json!({"method":"ui.request.cancel","params":{"request_id":"child-approval","reason":"aborted"}}));
    assert_eq!(s.request.as_ref().unwrap().id, "next-child");
}

#[test]
fn selected_child_result_text_is_bounded_without_changing_task_identity() {
    let mut s = State {
        inspected_task: Some("child".into()),
        ..Default::default()
    };
    let request = s.rpc("task.status", json!({"task_id":"child"}));
    s.handle(json!({"id":request["id"],"result":{"task_id":"child","state":"completed","name":"😀".repeat(500),"summary":"日本語".repeat(20000)}}));
    let detail = s.task_detail.unwrap();
    assert_eq!(detail["task_id"], "child");
    assert_eq!(detail["state"], "completed");
    assert!(detail["name"].as_str().unwrap().len() <= 256);
    assert!(detail["summary"].as_str().unwrap().len() <= 65536);
    assert!(
        detail["summary"]
            .as_str()
            .unwrap()
            .contains("Display truncated")
    );
}

#[test]
#[ignore = "manual performance probe; timing is hardware dependent"]
fn transcript_performance_probe() {
    let mut s = State {
        connected: true,
        model_available: true,
        supports_new_session: true,
        ..Default::default()
    };
    s.start("long transcript", "/tmp");
    s.active = Some("r".into());
    let begin = std::time::Instant::now();
    for i in 0..5000 {
        s.handle(json!({"method":"agent.event","params":{"run_id":"r","seq":i*2,"event":{"type":"tool_call","tool_call_id":format!("t-{i}"),"tool":"read","args":{"file_path":"fixture.txt"}}}}));
        s.handle(json!({"method":"agent.event","params":{"run_id":"r","seq":i*2+1,"event":{"type":"tool_result","tool_call_id":format!("t-{i}"),"tool":"read","result":"日本語".repeat(150)}}}));
    }
    let bytes: usize = s.rows().iter().map(|r| r.body.len() + r.detail.len()).sum();
    assert!(s.rows().len() <= 2500);
    assert!(bytes <= 4 * 1024 * 1024);
    eprintln!(
        "PERF: 10000 real-format notifications in {:?}; retained {} rows / {} text bytes (debug projection, excludes GPUI rendering)",
        begin.elapsed(),
        s.rows().len(),
        bytes
    );
}

#[test]
fn late_terminal_and_text_cannot_finish_a_run_before_admission_ack() {
    let mut s = State {
        connected: true,
        model_available: true,
        supports_new_session: true,
        ..Default::default()
    };
    s.start("next", "/tmp");
    s.handle(json!({"method":"run.status","params":{"run_id":"old","status":"completed"}}));
    s.handle(json!({"method":"agent.event","params":{"run_id":"old","seq":1,"event":{"type":"final","content":"wrong old result"}}}));
    assert!(s.busy);
    assert_eq!(s.rows().len(), 1);
    assert_eq!(s.status, "Starting");
}

#[test]
fn transcript_eviction_preserves_unsent_persisted_session_text() {
    let mut s = State {
        session: Some("selected".into()),
        ..Default::default()
    };
    for i in 0..12 {
        let c = s
            .conversations
            .entry(format!("session-{i:02}"))
            .or_default();
        c.title = format!("Session {i}");
        c.rows.push(Row {
            id: format!("row-{i}"),
            kind: "assistant".into(),
            title: "Codelia".into(),
            body: "Prior response".into(),
            detail: String::new(),
            error: false,
        });
    }
    s.conversation();
    s.conversations.get_mut("session-00").unwrap().draft = "Unsent Japanese: 続きを調べて".into();
    s.conversation();
    s.bound_transcript("selected");
    assert_eq!(
        s.conversations.get("session-00").map(|c| c.draft.as_str()),
        Some("Unsent Japanese: 続きを調べて")
    );
    assert_eq!(s.conversations["session-00"].title, "Session 0");
    assert!(
        s.conversations["session-00"].rows.is_empty(),
        "Only the inactive transcript should be evicted"
    );
}

#[test]
fn front_eviction_keeps_the_same_retained_row_as_scroll_anchor() {
    let mut s = State {
        connected: true,
        model_available: true,
        supports_new_session: true,
        ..Default::default()
    };
    let start = s.start("Long history", "/tmp").unwrap();
    s.handle(
        json!({"id":start["id"],"result":{"run_id":"run-scroll","session_id":"session-scroll"}}),
    );
    for seq in 0..2499 {
        s.handle(json!({"method":"agent.event","params":{"run_id":"run-scroll","seq":seq,"event":{"type":"hidden_user_message","content":if seq % 2 == 0 { "Short".to_owned() } else { "Variable height\n".repeat(20) }}}}));
    }
    let c = s.conversation();
    let before = c.snapshot();
    c.dirty_from = None;
    let anchor = c.rows[1000].id.clone();
    let mut retained_ids: Vec<_> = c.rows.iter().map(|r| r.id.clone()).collect();
    for seq in 2499..2599 {
        s.handle(json!({"method":"agent.event","params":{"run_id":"run-scroll","seq":seq,"event":{"type":"hidden_user_message","content":"More history"}}}));
    }
    let c = s.conversation();
    let after = c.snapshot();
    let sync = ScrollSync::between(before, after, c.dirty_from.take());
    assert!(
        !sync.replace,
        "Front eviction must not force tail following"
    );
    assert_eq!(sync.removed, 100);
    assert_eq!(sync.appended, 100);
    retained_ids.drain(..sync.removed);
    retained_ids.extend(
        c.rows[c.rows.len() - sync.appended..]
            .iter()
            .map(|r| r.id.clone()),
    );
    assert_eq!(
        retained_ids,
        c.rows.iter().map(|r| r.id.clone()).collect::<Vec<_>>()
    );
    assert_eq!(retained_ids[1000 - sync.removed], anchor);
    assert!(
        !ScrollSync::between(after, c.snapshot(), c.dirty_from.take()).changed(),
        "An unchanged poll must not invalidate measurements or redraw"
    );
}

#[test]
fn byte_eviction_removes_front_rows_without_resetting_scroll_follow_mode() {
    let mut s = State {
        session: Some("bytes".into()),
        ..Default::default()
    };
    let c = s.conversation();
    for i in 0..100 {
        c.rows.push(Row {
            id: format!("row-{i}"),
            kind: "tool".into(),
            title: "Tool".into(),
            body: "Small".into(),
            detail: String::new(),
            error: false,
        });
    }
    let before = c.snapshot();
    for row in &mut c.rows {
        row.body = "x".repeat(65536);
    }
    c.changed_at(0);
    s.bound_transcript("bytes");
    let c = s.conversation();
    let after = c.snapshot();
    let sync = ScrollSync::between(before, after, c.dirty_from.take());
    assert!(after.count < before.count);
    assert!(!sync.replace);
    assert_eq!(sync.removed, before.count - after.count);
    assert_eq!(sync.appended, 0);
    assert_eq!(sync.remeasure, Some(0..after.count));
}

#[test]
fn runtime_answer_drafts_stay_with_their_workspace_and_exact_request() {
    let mut first = State::default();
    let mut second = State::default();
    first.handle(json!({"id":"first","method":"ui.prompt.request","params":{"multiline":true,"default_value":"original"}}));
    second.handle(json!({"id":"second","method":"ui.prompt.request","params":{"secret":true}}));
    first.save_answer_draft(&json!("first"), "途中の回答\n日本語".into());
    second.save_answer_draft(&json!("second"), "synthetic answer".into());
    // A stale input binding cannot overwrite a different request or workspace.
    first.save_answer_draft(&json!("second"), "wrong".into());
    assert_eq!(
        first.request.as_ref().unwrap().answer_draft.as_deref(),
        Some("途中の回答\n日本語")
    );
    assert_eq!(
        second.request.as_ref().unwrap().answer_draft.as_deref(),
        Some("synthetic answer")
    );
    first.save_answer_draft(&json!("first"), String::new());
    assert_eq!(
        first.request.as_ref().unwrap().answer_draft.as_deref(),
        Some("")
    );
    assert_eq!(first.answer(json!({"value":""})).unwrap()["id"], "first");
    first.handle(
        json!({"id":"new","method":"ui.prompt.request","params":{"default_value":"new default"}}),
    );
    first.save_answer_draft(&json!("first"), "late previous answer".into());
    assert_eq!(first.request.as_ref().unwrap().answer_draft, None);
    second.handle(json!({"method":"ui.request.cancel","params":{"request_id":"second"}}));
    assert!(second.request.is_none());
    assert!(first.request.is_some());
}

#[test]
fn live_text_retries_reconcile_canonical_and_ignore_late_attempts() {
    let mut s = State {
        connected: true,
        model_available: true,
        supports_new_session: true,
        ..Default::default()
    };
    s.start("hello", "/tmp");
    s.active = Some("r".into());
    let mut seq = 0;
    let mut event = |s: &mut State, stream: &str, phase: &str, content: &str, offset: usize| {
        seq += 1;
        s.handle(json!({"method":"agent.event","params":{"run_id":"r","seq":seq,"event":{"type":"text.stream","invocation_id":if content == "wrong invocation" {"other"} else {"i"},"attempt":if content == "wrong attempt" {99} else {1},"stream_id":stream,"phase":phase,"content":content,"offset":offset}}}));
    };
    event(&mut s, "a", "start", "", 0);
    event(&mut s, "a", "delta", "失敗", 0);
    event(&mut s, "a", "delta", "duplicate", 0);
    assert_eq!(s.rows()[1].body, "失敗");
    event(&mut s, "a", "discard", "", 0);
    event(&mut s, "b", "start", "", 0);
    event(&mut s, "a", "delta", "late", 6);
    event(&mut s, "b", "delta", "wrong invocation", 0);
    event(&mut s, "b", "delta", "wrong attempt", 0);
    event(&mut s, "b", "delta", "日", 0);
    event(&mut s, "b", "delta", "本語", 3);
    assert_eq!(s.rows()[1].body, "日本語");
    event(&mut s, "b", "commit", "日本語の確定応答", 0);
    seq += 1;
    s.handle(json!({"method":"agent.event","params":{"run_id":"r","seq":seq,"event":{"type":"final","content":"日本語の確定応答","stream_id":"b"}}}));
    assert_eq!(s.rows().len(), 2);
    assert_eq!(s.rows()[1].body, "日本語の確定応答");
    s.handle(json!({"method":"run.status","params":{"run_id":"r","status":"completed"}}));
    assert_eq!(s.rows().len(), 2);
}

#[test]
fn stopped_or_disconnected_live_text_is_removed_from_its_owner() {
    for disconnect in [false, true] {
        let mut s = State {
            connected: true,
            model_available: true,
            supports_new_session: true,
            ..Default::default()
        };
        s.start("hello", "/tmp");
        s.active = Some("r".into());
        s.handle(json!({"method":"agent.event","params":{"run_id":"r","seq":1,"event":{"type":"text.stream","invocation_id":"i","attempt":1,"stream_id":"a","phase":"start"}}}));
        s.handle(json!({"method":"agent.event","params":{"run_id":"r","seq":2,"event":{"type":"text.stream","invocation_id":"i","attempt":1,"stream_id":"a","phase":"delta","offset":0,"content":"unfinished"}}}));
        if disconnect {
            s.disconnected("offline".into());
        } else {
            s.handle(json!({"method":"run.status","params":{"run_id":"r","status":"cancelled"}}));
        }
        assert_eq!(s.rows().len(), if disconnect { 2 } else { 1 });
        assert!(s.rows().iter().all(|row| row.kind != "assistant"));
        assert_eq!(s.rows()[0].body, "hello");
    }
}

#[test]
fn invalid_provider_recovers_by_exact_catalog_choice_without_cross_thread_or_config_rpc() {
    let mut s = State {
        connected: true,
        supports_new_session: true,
        supports_run_model: true,
        ..Default::default()
    };
    let unavailable = s.rpc("model.list", json!({}));
    s.handle(json!({"id":unavailable["id"],"error":{"message":"unsupported provider: home"}}));
    assert!(!s.model_ready());
    assert!(
        crate::application::execute(
            &mut s,
            "/workspace",
            crate::application::Command::Send("日本語の依頼".into())
        )
        .is_err()
    );
    let older = crate::application::execute(
        &mut s,
        "/workspace",
        crate::application::Command::ListModels("anthropic".into()),
    )
    .unwrap()
    .messages
    .remove(0);
    let latest = crate::application::execute(
        &mut s,
        "/workspace",
        crate::application::Command::ListModels("openai".into()),
    )
    .unwrap()
    .messages
    .remove(0);
    assert_eq!(
        latest["params"],
        json!({"provider":"openai","catalog_only":true})
    );
    s.handle(json!({"id":older["id"],"result":{"provider":"anthropic","catalog_only":true,"models":["stale"]}}));
    assert_eq!(s.catalog_provider, "openai");
    assert!(s.models.is_empty());
    s.handle(json!({"id":latest["id"],"result":{"provider":"openai","catalog_only":true,"models":["gpt-6.1-sol"]}}));
    assert!(!s.model_ready(), "catalog listing does not select a model");
    s.set_draft("retained 日本語".into());
    let first = s.key();
    let choice = crate::application::execute(
        &mut s,
        "/workspace",
        crate::application::Command::ChooseModel {
            provider: "openai".into(),
            name: "gpt-6.1-sol".into(),
        },
    )
    .unwrap();
    assert!(
        choice.messages.is_empty(),
        "choosing never writes config or dispatches RPC"
    );
    assert!(s.model_ready());
    let next = s.create_thread("another");
    assert_ne!(next, first);
    assert!(s.select_cached(&next));
    assert!(
        !s.model_ready(),
        "new draft does not inherit another draft's choice"
    );
    assert!(s.start("must not send", "/workspace").is_none());
    s.draft_key = first;
    let run = s.start("explicit", "/workspace").unwrap();
    assert_eq!(
        run["params"]["model"],
        json!({"provider":"openai","name":"gpt-6.1-sol"})
    );
    assert_eq!(run["params"]["new_session"], true);
    s.tasks = vec![
        json!({"kind":"shell","title":"ls"}),
        json!({"kind":"subagent","task_id":"child"}),
        json!({"title":"untyped"}),
    ];
    assert_eq!(s.child_tasks().count(), 1);
    assert_eq!(
        crate::application::execute(&mut s, "/workspace", crate::application::Command::ListTasks)
            .unwrap()
            .messages[0]["params"]["kind"],
        "subagent"
    );
}
