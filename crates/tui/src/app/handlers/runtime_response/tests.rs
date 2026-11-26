use super::apply::apply_runtime_msg;
use super::components::{
    apply_compaction_component_events, clear_component_tracking_for_run,
    register_pending_component_lines, resolve_tool_component_key, take_active_compaction_key,
    tool_component_key, PendingComponentStart, UNKNOWN_RUN_SCOPE,
};
use super::steer::{applied_steer_position, fallback_unconsumed_steers};
use crate::app::handlers::confirm::activate_pending_confirm_dialog;
use crate::app::runtime::parser::test_support::{
    parse_runtime_output, parse_runtime_output_with_history,
};
use crate::app::runtime::{AgentMsg, MockRuntimeTx, RunControlMsg, RuntimeMsg, RuntimeTx};
use crate::app::state::{LogKind, LogLine};
use crate::app::{
    AppState, ConfirmSlot, LocalPanel, LogComponentSpan, PasteTarget, PendingPromptRun, PendingRpc,
    PendingRpcSlot, RuntimeDialogRef, RuntimePickDialog,
};
use crate::event_loop::input::{handle_non_main_key, handle_paste};
use crossterm::event::{KeyCode, KeyModifiers};
use serde_json::json;
use std::time::Instant;

#[test]
fn streaming_partial_survives_cancel_and_final_is_rendered_once() {
    with_runtime_tx(|tx| {
        let mut app = AppState::default();
        app.runtime_info.active_run_id = Some("run".into());
        for event in [
            json!({"type":"text.delta","stream_id":"s","index":0,"delta":""}),
            json!({"type":"text.delta","stream_id":"s","index":0,"delta":"partial"}),
        ] {
            let parsed = parse_runtime_output(
                &json!({"method":"agent.event","params":{"run_id":"run","event":event}})
                    .to_string(),
            );
            apply_runtime_msg(&mut app, parsed, tx);
        }
        app.flush_stream_output();
        assert!(app
            .log
            .iter()
            .any(|line| line.plain_text().contains("partial")));
        assert!(app
            .stream_preview
            .segments()
            .iter()
            .any(|segment| segment.content == "partial"));
        let terminal = parse_runtime_output(
            r#"{"method":"run.status","params":{"run_id":"run","status":"cancelled"}}"#,
        );
        apply_runtime_msg(&mut app, terminal, tx);
        assert!(app.stream_preview.segments().is_empty());
        let final_event = parse_runtime_output(
            r#"{"method":"agent.event","params":{"run_id":"run","event":{"type":"final","content":"canonical answer"}}}"#,
        );
        apply_runtime_msg(&mut app, final_event, tx);
        assert_eq!(
            app.log
                .iter()
                .filter(|line| line.plain_text().contains("canonical answer"))
                .count(),
            1
        );
        app.flush_stream_output();
        assert!(app
            .log
            .iter()
            .any(|line| line.plain_text().contains("partial")));
    });
}

#[test]
fn structured_errors_show_context_only_on_failure_and_keep_safe_details_for_errors_show() {
    with_runtime_tx(|tx| {
        let mut app = AppState::default();
        app.runtime_info.current_model = Some("fixture-model".into());
        let healthy = parse_runtime_output(
            r#"{"method":"run.status","params":{"run_id":"run","status":"running"}}"#,
        );
        apply_runtime_msg(&mut app, healthy, tx);
        assert!(app.last_error_detail.is_none());
        assert!(!app
            .log
            .iter()
            .any(|line| line.plain_text().contains("Next:")));
        let failure = parse_runtime_output(
            r#"{"method":"run.status","params":{"run_id":"run","status":"error","message":"Google request failed.","error":{"name":"ProviderFailureError","message":"Google request failed.","provider":"google","kind":"provider","status":503,"attempts":1,"max_attempts":3,"detail":"The response stream ended before completion.","code":"response_incomplete","hint":"Retry; if it repeats, share /errors show.","stack":"private-stack"}}}"#,
        );
        apply_runtime_msg(&mut app, failure, tx);
        let shown = app
            .log
            .iter()
            .map(LogLine::plain_text)
            .collect::<Vec<_>>()
            .join("\n");
        assert!(shown.contains("HTTP 503"));
        assert!(shown.contains("ended before completion"));
        assert!(shown.contains("Next:"));
        assert!(!shown.contains("private-stack"));
        let details = app.last_error_detail.as_deref().unwrap();
        assert!(details.contains("Provider: google"));
        assert!(details.contains("Model: fixture-model"));
        assert!(details.contains("Code: response_incomplete"));
        assert!(app.show_last_error_detail());
        assert!(app
            .log
            .iter()
            .any(|line| line.plain_text().contains("Code: response_incomplete")));
    });
}

fn feed_event(app: &mut AppState, tx: &mut dyn RuntimeTx, event: serde_json::Value) {
    let parsed = parse_runtime_output(
        &json!({"method":"agent.event","params":{"run_id":"run","event":event}}).to_string(),
    );
    apply_runtime_msg(app, parsed, tx);
}

fn transcript_frame(app: &mut AppState) -> ratatui::buffer::Buffer {
    let mut terminal = ratatui::Terminal::new(ratatui::backend::TestBackend::new(48, 18)).unwrap();
    terminal
        .draw(|frame| crate::app::view::draw_ui(frame, app))
        .unwrap();
    terminal.backend().buffer().clone()
}

#[test]
fn shorter_final_replaces_uncommitted_stream_suffix() {
    with_runtime_tx(|tx| {
        let mut app = AppState::default();
        app.runtime_info.active_run_id = Some("run".into());
        feed_event(
            &mut app,
            tx,
            json!({"type":"text.delta","stream_id":"s","index":0,"delta":"hello wrong"}),
        );
        feed_event(&mut app, tx, json!({"type":"final","content":"hello"}));
        let text = app
            .log
            .iter()
            .map(|line| line.plain_text())
            .collect::<Vec<_>>()
            .join("\n");
        assert!(text.contains("hello"));
        assert!(!text.contains("wrong"));
    });
}

#[test]
fn interleaved_text_and_reasoning_confirm_all_text_segments_once() {
    with_runtime_tx(|tx| {
        let mut app = AppState::default();
        app.runtime_info.active_run_id = Some("run".into());
        for event in [
            json!({"type":"text.delta","stream_id":"s","index":0,"delta":"first"}),
            json!({"type":"reasoning.delta","stream_id":"s","index":0,"delta":"thought"}),
            json!({"type":"text.delta","stream_id":"s","index":1,"delta":"second"}),
            json!({"type":"reasoning","content":"thought"}),
            json!({"type":"final","content":"first\nsecond"}),
        ] {
            feed_event(&mut app, tx, event);
        }
        for value in ["first", "second"] {
            assert_eq!(
                app.log
                    .iter()
                    .filter(|line| line.plain_text().contains(value))
                    .count(),
                1
            );
        }
        assert!(app.stream_preview.segments().is_empty());
    });
}

#[test]
fn public_delta_blocks_join_without_duplicate_canonical_final() {
    with_runtime_tx(|tx| {
        let mut app = AppState::default();
        app.runtime_info.active_run_id = Some("run".into());
        feed_event(
            &mut app,
            tx,
            json!({"type":"text.delta","stream_id":"s","index":0,"delta":"first"}),
        );
        feed_event(
            &mut app,
            tx,
            json!({"type":"text.delta","stream_id":"s","index":1,"delta":"second"}),
        );
        let before = transcript_frame(&mut app);
        feed_event(
            &mut app,
            tx,
            json!({"type":"final","content":"first\nsecond"}),
        );
        assert_eq!(before, transcript_frame(&mut app));
        assert!(app.stream_preview.segments().is_empty());
        assert!(!app
            .log
            .iter()
            .any(|line| line.plain_text().contains("Response revised")));
    });
}

#[test]
fn full_markdown_frame_is_unchanged_at_canonical_final() {
    with_runtime_tx(|tx| {
        let mut app = AppState::default();
        app.update_run_status("running".into());
        app.runtime_info.active_run_id = Some("run".into());
        let content = format!(
            "# Answer\n{}\n```rust\nfn main() {{}}\n```",
            (0..600)
                .map(|i| format!("- item {i}: 日本語🙂 **bold** and `code`\n"))
                .collect::<String>()
        );
        assert!(content.len() > 16384);
        for chunk in content.split_inclusive('\n') {
            feed_event(
                &mut app,
                tx,
                json!({"type":"text.delta","stream_id":"s","index":0,"delta":chunk}),
            );
        }
        let before = transcript_frame(&mut app);
        app.scroll_up(580);
        let scrolled = transcript_frame(&mut app);
        assert_ne!(before, scrolled);
        assert_eq!(scrolled, transcript_frame(&mut app));
        feed_event(&mut app, tx, json!({"type":"final","content":content}));
        assert_eq!(scrolled, transcript_frame(&mut app));
        app.scroll_from_bottom = 0;
        assert_eq!(before, transcript_frame(&mut app));
        assert!(app.stream_preview.segments().is_empty());
        assert!(app.streamed_completion);
        assert!(!app
            .log
            .iter()
            .any(|line| line.plain_text().contains("Run duration:")));
    });
}

#[test]
fn reasoning_handoff_keeps_the_answer_and_its_position() {
    with_runtime_tx(|tx| {
        let mut app = AppState::default();
        app.runtime_info.active_run_id = Some("run".into());
        feed_event(
            &mut app,
            tx,
            json!({"type":"reasoning.delta","stream_id":"s","index":0,"delta":"thinking\nmore thought"}),
        );
        feed_event(
            &mut app,
            tx,
            json!({"type":"text.delta","stream_id":"s","index":0,"delta":"# Result\n- **one**\n- two"}),
        );
        let before = transcript_frame(&mut app);
        feed_event(
            &mut app,
            tx,
            json!({"type":"reasoning","content":"thinking\nmore thought"}),
        );
        assert_eq!(before, transcript_frame(&mut app));
        feed_event(
            &mut app,
            tx,
            json!({"type":"final","content":"# Result\n- **one**\n- two"}),
        );
        assert_eq!(before, transcript_frame(&mut app));
    });
}

#[test]
fn retry_clears_abandoned_transcript_but_replayed_final_does_not_consume_live_output() {
    with_runtime_tx(|tx| {
        let mut app = AppState::default();
        app.runtime_info.active_run_id = Some("run".into());
        feed_event(
            &mut app,
            tx,
            json!({"type":"text.delta","stream_id":"s","index":0,"delta":"partial"}),
        );
        let replay = parse_runtime_output(
            r#"{"method":"agent.event","params":{"run_id":"run","meta":{"replayed":true},"event":{"type":"final","content":"partial"}}}"#,
        );
        apply_runtime_msg(&mut app, replay, tx);
        assert_eq!(app.stream_preview.segments()[0].content, "partial");
        feed_event(
            &mut app,
            tx,
            json!({"type":"llm.retry","provider":"openai","failure_kind":"network","next_attempt":2,"max_attempts":3,"delay_ms":1000}),
        );
        assert!(app.stream_preview.segments().is_empty());
        transcript_frame(&mut app);
        assert!(app
            .wrapped_log_cache
            .as_ref()
            .unwrap()
            .wrapped
            .iter()
            .any(|row| row.line.plain_text().contains("LLM retry")));
    });
}

fn with_runtime_tx(f: impl FnOnce(&mut dyn RuntimeTx)) {
    f(&mut MockRuntimeTx::default());
}

#[test]
fn progress_tool_events_show_only_progress_and_preserve_errors() {
    with_runtime_tx(|tx| {
        let mut app = AppState::default();
        let events = [
            json!({"method":"agent.event", "params":{"event":{
                "type":"tool_call", "tool":"tui_show_progress", "tool_call_id":"p1",
                "args":{"phase":"Build", "current":1, "total":2}
            }}}),
            json!({"jsonrpc":"2.0", "id":"request1", "method":"client.tool.call", "params":{
                "run_id":"run-1", "name":"tui_show_progress",
                "arguments":{"phase":"Build", "current":1, "total":2}, "raw_arguments":"{}"
            }}),
            json!({"method":"agent.event", "params":{"event":{
                "type":"tool_result", "tool":"tui_show_progress", "tool_call_id":"p1",
                "result":"progress shown"
            }}}),
        ];
        for event in events {
            apply_runtime_msg(&mut app, parse_runtime_output(&event.to_string()), tx);
        }
        assert_eq!(app.log.len(), 1);
        let text = app.log[0].plain_text();
        assert!(text.contains("Build") && text.contains("50%"));
        assert!(!text.contains("tui_show_progress"));

        let error = json!({"method":"agent.event", "params":{"event":{
            "type":"tool_result", "tool":"tui_show_progress", "tool_call_id":"p2",
            "is_error":true, "result":"error: unavailable"
        }}});
        apply_runtime_msg(&mut app, parse_runtime_output(&error.to_string()), tx);
        assert!(app
            .log
            .iter()
            .any(|line| line.plain_text().contains("unavailable")));
    });
}

#[test]
fn replayed_progress_is_restored_only_after_success_without_client_rpc() {
    let mut tx = MockRuntimeTx::default();
    let mut app = AppState::default();
    let events = [
        json!({"type":"tool_call", "tool":"tui_show_progress", "tool_call_id":"p1", "args":{"id":"build", "phase":"Build", "current":1, "total":4}}),
        json!({"type":"tool_result", "tool":"tui_show_progress", "tool_call_id":"p1", "result":"progress shown"}),
        json!({"type":"tool_call", "tool":"tui_show_progress", "tool_call_id":"p2", "args":{"id":"build", "phase":"Build", "status":"completed", "message":"ready"}}),
        json!({"type":"tool_result", "tool":"tui_show_progress", "tool_call_id":"p2", "result":"progress shown"}),
        json!({"type":"tool_call", "tool":"tui_show_progress", "tool_call_id":"p3", "args":{"phase":"not shown"}}),
        json!({"type":"tool_result", "tool":"tui_show_progress", "tool_call_id":"p3", "is_error":true, "result":"error: invalid"}),
    ];
    for (index, event) in events.into_iter().enumerate() {
        let raw = json!({"method":"agent.event", "params": {"run_id":"old-run", "meta":{"replayed":true}, "event":event}}).to_string();
        apply_runtime_msg(&mut app, parse_runtime_output(&raw), &mut tx);
        if index == 0 {
            assert!(app.log.is_empty());
        }
    }
    assert!(app
        .log
        .iter()
        .any(|line| line.plain_text().contains("ready") && line.plain_text().contains("100%")));
    assert!(!app
        .log
        .iter()
        .any(|line| line.plain_text().contains("not shown")));
    assert!(app
        .log
        .iter()
        .any(|line| line.plain_text().contains("invalid")));
    assert!(app.pending_history_progress.is_empty());
    assert!(
        tx.sent.is_empty(),
        "history replay sent client RPC: {:?}",
        tx.sent
    );
}

#[test]
fn legacy_history_fallback_does_not_replay_active_run_events() {
    let event = |run_id: &str| {
        json!({"method":"agent.event", "params":{
        "run_id":run_id, "event":{"type":"tool_call", "tool":"tui_show_progress", "tool_call_id":"p1", "args":{"phase":"Build"}}
    }}).to_string()
    };
    let live = parse_runtime_output_with_history(&event("live"), true, Some("live"));
    assert!(matches!(live, RuntimeMsg::Ignored));
    let replay = parse_runtime_output_with_history(&event("old"), true, Some("live"));
    assert!(matches!(
        replay,
        RuntimeMsg::Agent(AgentMsg::ReplayProgress(_))
    ));
    let explicit = json!({"method":"agent.event", "params":{
        "run_id":"live", "meta":{"replayed":true},
        "event":{"type":"tool_call", "tool":"tui_show_progress", "tool_call_id":"p1", "args":{"phase":"Build"}}
    }}).to_string();
    assert!(matches!(
        parse_runtime_output_with_history(&explicit, true, Some("live")),
        RuntimeMsg::Agent(AgentMsg::ReplayProgress(_))
    ));
}

#[test]
fn replayed_progress_keys_are_isolated_between_runs() {
    with_runtime_tx(|tx| {
        let mut app = AppState::default();
        for run_id in ["run-a", "run-b"] {
            for event in [
                json!({"type":"tool_call", "tool":"tui_show_progress", "tool_call_id":"p1", "args":{"id":"build", "phase":run_id, "current":1, "total":2}}),
                json!({"type":"tool_result", "tool":"tui_show_progress", "tool_call_id":"p1", "result":"progress shown"}),
            ] {
                let raw = json!({"method":"agent.event", "params":{"run_id":run_id, "meta":{"replayed":true}, "event":event}}).to_string();
                apply_runtime_msg(&mut app, parse_runtime_output(&raw), tx);
            }
        }
        assert_eq!(app.log.len(), 2);
        assert!(app.log[0].plain_text().contains("run-a"));
        assert!(app.log[1].plain_text().contains("run-b"));
    });
}

#[test]
fn session_history_replays_legacy_progress_and_clears_pending_tracking() {
    use std::sync::mpsc;
    with_runtime_tx(|tx| {
        let mut app = AppState::default();
        app.rpc_pending
            .insert("history".to_string(), PendingRpc::SessionHistory);
        let (sender, rx) = mpsc::channel();
        for (seq, event) in [
            json!({"type":"tool_call", "tool":"tui_show_progress", "tool_call_id":"p1", "args":{"id":"build", "phase":"Build", "current":1, "total":2}}),
            json!({"type":"tool_result", "tool":"tui_show_progress", "tool_call_id":"p1", "result":"progress shown"}),
        ]
        .into_iter()
        .enumerate()
        {
            sender.send(
                json!({"method":"agent.event", "params":{"run_id":"old-run", "seq":seq, "event":event}})
                    .to_string(),
            )
            .unwrap();
        }
        sender
            .send(
                json!({"jsonrpc":"2.0", "id":"history", "result":{"runs":1,"events_sent":2}})
                    .to_string(),
            )
            .unwrap();
        super::process_runtime_messages(&mut app, &rx, tx);
        assert!(app
            .log
            .iter()
            .any(|line| line.plain_text().contains("Build") && line.plain_text().contains("50%")));
        assert!(app.pending_history_progress.is_empty());
        assert!(!app
            .progress_component_lines
            .keys()
            .any(|key| key.starts_with("history:")));
    });
}

#[test]
fn terminal_run_status_adds_dispatch_cooldown() {
    with_runtime_tx(|tx| {
        let mut app = AppState::default();
        app.pending_prompt_queue.push_back(PendingPromptRun {
            seq: 1,
            queue_id: "q1".to_string(),
            queued_at: Instant::now(),
            preview: "queued".to_string(),
            user_text: "queued".to_string(),
            display_text: "queued".to_string(),
            image_descriptions: Vec::new(),
            input_payload: json!({"type": "text", "text": "queued"}),
            attachment_count: 0,
            files: Default::default(),
            shell_result_count: 0,
            dispatch_attempts: 0,
        });
        app.runtime_info.active_run_id = Some("run-1".to_string());
        let parsed = parse_runtime_output(
            r#"{"method":"run.status","params":{"run_id":"run-1","status":"completed"}}"#,
        );

        assert!(apply_runtime_msg(&mut app, parsed, tx));
        assert!(app.next_queue_dispatch_retry_at.is_some());
        assert!(app.runtime_info.active_run_id.is_none());
        assert_eq!(app.run_status.as_deref(), Some("completed"));
    });
}

#[test]
fn llm_metrics_follow_active_run_and_retain_last_known_values() {
    with_runtime_tx(|tx| {
        let mut app = AppState::default();
        let mut apply = |app: &mut AppState, method: &str, params: serde_json::Value| {
            apply_runtime_msg(
                app,
                parse_runtime_output(&json!({"method": method, "params": params}).to_string()),
                tx,
            );
        };
        apply(
            &mut app,
            "run.status",
            json!({"run_id": "run-1", "status": "running"}),
        );
        apply(
            &mut app,
            "run.context",
            json!({"run_id": "run-1", "context_left_percent": 96}),
        );
        apply(
            &mut app,
            "run.metrics",
            json!({"run_id": "run-1", "output_tokens_per_second": 42.25}),
        );
        assert_eq!(app.runtime_info.last_llm_tps, Some(42.25));
        apply(
            &mut app,
            "run.metrics",
            json!({"run_id": "other", "output_tokens_per_second": 99}),
        );
        assert_eq!(app.runtime_info.last_llm_tps, Some(42.25));
        apply(
            &mut app,
            "run.metrics",
            json!({"run_id": "run-1", "output_tokens_per_second": null}),
        );
        assert_eq!(app.runtime_info.last_llm_tps, Some(42.25));
        apply(
            &mut app,
            "run.metrics",
            json!({"run_id": "run-1", "output_tokens_per_second": 50}),
        );
        apply(
            &mut app,
            "run.status",
            json!({"run_id": "run-1", "status": "completed"}),
        );
        assert_eq!(app.runtime_info.last_llm_tps, Some(50.0));
        assert_eq!(app.context_left_percent, Some(96));
        apply(
            &mut app,
            "run.status",
            json!({"run_id": "run-2", "status": "running"}),
        );
        assert_eq!(app.runtime_info.last_llm_tps, Some(50.0));
        assert_eq!(app.context_left_percent, Some(96));
        apply(
            &mut app,
            "run.metrics",
            json!({"run_id": "run-1", "output_tokens_per_second": 99}),
        );
        assert_eq!(app.runtime_info.last_llm_tps, Some(50.0));
        apply(
            &mut app,
            "run.metrics",
            json!({"run_id": "run-2", "output_tokens_per_second": null}),
        );
        apply(
            &mut app,
            "run.context",
            json!({"run_id": "run-2", "context_left_percent": null}),
        );
        assert_eq!(app.runtime_info.last_llm_tps, Some(50.0));
        assert_eq!(app.context_left_percent, Some(96));
        apply(
            &mut app,
            "run.metrics",
            json!({"run_id": "run-2", "output_tokens_per_second": 0}),
        );
        apply(
            &mut app,
            "run.context",
            json!({"run_id": "run-2", "context_left_percent": 0}),
        );
        assert_eq!(app.runtime_info.last_llm_tps, Some(0.0));
        assert_eq!(app.context_left_percent, Some(0));
    });
}

#[test]
fn client_tool_timeout_clears_matching_choice_dialog_and_pending_id() {
    with_runtime_tx(|tx| {
        let mut app = AppState::default();
        let request = parse_runtime_output(
            &json!({
                "jsonrpc": "2.0",
                "id": "ui_choice_1",
                "method": "client.tool.call",
                "params": {
                    "run_id": "run-1",
                    "name": "tui_ask_user_choice",
                    "arguments": {
                        "title": "Choose next",
                        "choices": [{ "id": "continue", "label": "Continue" }]
                    },
                    "raw_arguments": "{}"
                }
            })
            .to_string(),
        );
        assert!(apply_runtime_msg(&mut app, request, tx));
        assert_eq!(
            app.overlays
                .runtime_dialogs
                .pick
                .as_ref()
                .map(RuntimePickDialog::id),
            Some("ui_choice_1")
        );
        assert!(app
            .rpc_pending
            .client_tool_choice_ids
            .contains("ui_choice_1"));

        let cancellation = parse_runtime_output(
            r#"{"jsonrpc":"2.0","method":"client.tool.cancel","params":{"request_id":"ui_choice_1","run_id":"run-1","name":"tui_ask_user_choice","reason":"timeout"}}"#,
        );
        assert!(apply_runtime_msg(&mut app, cancellation, tx));

        assert!(app.overlays.runtime_dialogs.pick.is_none());
        assert!(!app
            .rpc_pending
            .client_tool_choice_ids
            .contains("ui_choice_1"));
        assert!(!app.selection_input_blocked());
        assert!(app
            .log
            .iter()
            .any(|line| line.plain_text() == "Choice request timed out."));
    });
}

fn receive_confirm(app: &mut AppState, tx: &mut MockRuntimeTx, id: &str) {
    let request = parse_runtime_output(
        &json!({
            "jsonrpc": "2.0",
            "method": "ui.confirm.request",
            "id": id,
            "params": {"title": "Confirm action", "message": "Proceed?", "allow_reason": true}
        })
        .to_string(),
    );
    assert!(apply_runtime_msg(app, request, tx));
    assert!(matches!(
        app.overlays.runtime_dialogs.top(),
        Some(RuntimeDialogRef::Confirm(ConfirmSlot::Pending(state))) if state.id == id
    ));
}

fn dialog_key(app: &mut AppState, tx: &mut MockRuntimeTx, key: KeyCode) -> Option<bool> {
    handle_non_main_key(app, key, KeyModifiers::NONE, tx, &mut Vec::new())
}

#[test]
fn confirm_preempts_client_choice_and_reveals_the_same_selection_on_close() {
    let mut app = AppState::default();
    let mut tx = MockRuntimeTx::default();
    let choice = parse_runtime_output(
        &json!({
            "jsonrpc": "2.0",
            "id": "choice",
            "method": "client.tool.call",
            "params": {
                "run_id": "run-1",
                "name": "tui_ask_user_choice",
                "arguments": {
                    "title": "Choose next",
                    "choices": [
                        {"id": "first", "label": "First"},
                        {"id": "second", "label": "Second"}
                    ]
                },
                "raw_arguments": "{}"
            }
        })
        .to_string(),
    );
    assert!(apply_runtime_msg(&mut app, choice, &mut tx));
    assert_eq!(dialog_key(&mut app, &mut tx, KeyCode::Down), Some(true));

    receive_confirm(&mut app, &mut tx, "confirm");
    assert_eq!(dialog_key(&mut app, &mut tx, KeyCode::Enter), Some(false));
    assert!(tx.sent.is_empty());
    assert!(activate_pending_confirm_dialog(&mut app));
    assert!(matches!(
        app.overlays.runtime_dialogs.top(),
        Some(RuntimeDialogRef::Confirm(ConfirmSlot::Active { .. }))
    ));
    assert_eq!(dialog_key(&mut app, &mut tx, KeyCode::Up), Some(true));
    assert_eq!(dialog_key(&mut app, &mut tx, KeyCode::Enter), Some(true));
    assert_eq!(tx.sent.len(), 1);
    assert_eq!(tx.sent[0]["id"], "confirm");
    assert_eq!(tx.sent[0]["result"]["ok"], true);
    assert!(matches!(
        app.overlays.runtime_dialogs.top(),
        Some(RuntimeDialogRef::Pick(RuntimePickDialog::List(pick))) if pick.id == "choice" && pick.selected == 1
    ));

    assert_eq!(dialog_key(&mut app, &mut tx, KeyCode::Enter), Some(true));
    assert_eq!(tx.sent.len(), 2);
    assert_eq!(tx.sent[1]["id"], "choice");
    assert_eq!(
        tx.sent[1]["result"]["result"]["value"]["selected_id"],
        "second"
    );
    assert!(!app.overlays.runtime_dialogs.is_any_open());
}

#[test]
fn confirm_preempts_prompt_and_preserves_its_buffer_and_cursor() {
    let mut app = AppState::default();
    let mut tx = MockRuntimeTx::default();
    let prompt = parse_runtime_output(
        r#"{"jsonrpc":"2.0","id":"prompt","method":"ui.prompt.request","params":{"title":"Input","message":"Enter value","default_value":"abc"}}"#,
    );
    assert!(apply_runtime_msg(&mut app, prompt, &mut tx));
    assert_eq!(
        dialog_key(&mut app, &mut tx, KeyCode::Char('d')),
        Some(true)
    );
    assert_eq!(dialog_key(&mut app, &mut tx, KeyCode::Left), Some(true));

    receive_confirm(&mut app, &mut tx, "confirm");
    assert_eq!(
        dialog_key(&mut app, &mut tx, KeyCode::Char('x')),
        Some(false)
    );
    assert_eq!(app.paste_target(false), PasteTarget::Blocked);
    assert!(!handle_paste(&mut app, "blocked while pending", false));
    assert!(activate_pending_confirm_dialog(&mut app));
    assert_eq!(dialog_key(&mut app, &mut tx, KeyCode::Tab), Some(true));
    assert!(!handle_paste(&mut app, "blocked while active", false));
    assert_eq!(
        dialog_key(&mut app, &mut tx, KeyCode::Char('n')),
        Some(true)
    );
    assert_eq!(dialog_key(&mut app, &mut tx, KeyCode::Enter), Some(true));
    assert_eq!(tx.sent[0]["result"]["reason"], "n");

    let Some(RuntimeDialogRef::Prompt(prompt)) = app.overlays.runtime_dialogs.top() else {
        panic!("prompt should regain focus");
    };
    assert_eq!(prompt.state.id, "prompt");
    assert_eq!(prompt.input.current(), "abcd");
    assert_eq!(prompt.input.cursor, 3);
    assert!(handle_paste(&mut app, "!", false));
    assert_eq!(dialog_key(&mut app, &mut tx, KeyCode::Enter), Some(true));
    assert_eq!(tx.sent.len(), 2);
    assert_eq!(tx.sent[1]["id"], "prompt");
    assert_eq!(tx.sent[1]["result"]["value"], "abc!d");
    assert!(app.input.current().is_empty());
}

#[test]
fn replacement_confirm_waits_for_activation_and_starts_with_empty_reason() {
    let mut app = AppState::default();
    let mut tx = MockRuntimeTx::default();
    assert!(!activate_pending_confirm_dialog(&mut app));
    receive_confirm(&mut app, &mut tx, "superseded-pending");
    receive_confirm(&mut app, &mut tx, "superseded-active");
    assert!(activate_pending_confirm_dialog(&mut app));
    assert_eq!(dialog_key(&mut app, &mut tx, KeyCode::Tab), Some(true));
    assert_eq!(
        dialog_key(&mut app, &mut tx, KeyCode::Char('x')),
        Some(true)
    );
    assert!(!activate_pending_confirm_dialog(&mut app));
    assert_eq!(
        app.overlays
            .runtime_dialogs
            .active_confirm()
            .unwrap()
            .1
            .current(),
        "x"
    );

    receive_confirm(&mut app, &mut tx, "replacement");
    assert_eq!(
        dialog_key(&mut app, &mut tx, KeyCode::Char('y')),
        Some(false)
    );
    assert!(tx.sent.is_empty());
    assert!(app.input.current().is_empty());
    assert!(activate_pending_confirm_dialog(&mut app));
    assert!(app
        .overlays
        .runtime_dialogs
        .active_confirm()
        .unwrap()
        .1
        .current()
        .is_empty());
    assert_eq!(
        dialog_key(&mut app, &mut tx, KeyCode::Char('y')),
        Some(true)
    );
    assert_eq!(tx.sent.len(), 1);
    assert_eq!(tx.sent[0]["id"], "replacement");
    assert_eq!(tx.sent[0]["result"]["ok"], true);
    assert!(!app.overlays.runtime_dialogs.is_any_open());
}

#[test]
fn stale_client_tool_cancel_leaves_active_choice_untouched() {
    with_runtime_tx(|tx| {
        let mut app = AppState::default();
        let request = parse_runtime_output(
            r#"{"jsonrpc":"2.0","id":"ui_choice_active","method":"client.tool.call","params":{"run_id":"run-1","name":"tui_ask_user_choice","arguments":{"title":"Choose next","choices":[{"id":"continue","label":"Continue"}]},"raw_arguments":"{}"}}"#,
        );
        assert!(apply_runtime_msg(&mut app, request, tx));

        let stale_cancellation = parse_runtime_output(
            r#"{"jsonrpc":"2.0","method":"client.tool.cancel","params":{"request_id":"ui_choice_stale","run_id":"run-1","name":"tui_ask_user_choice","reason":"timeout"}}"#,
        );
        assert!(apply_runtime_msg(&mut app, stale_cancellation, tx));

        assert_eq!(
            app.overlays
                .runtime_dialogs
                .pick
                .as_ref()
                .map(RuntimePickDialog::id),
            Some("ui_choice_active")
        );
        assert!(app
            .rpc_pending
            .client_tool_choice_ids
            .contains("ui_choice_active"));
    });
}

#[test]
fn subagent_failure_replaces_wait_header_with_named_failure() {
    with_runtime_tx(|tx| {
        let mut app = AppState::default();
        app.push_line(LogKind::ToolCall, "Wait for agent: 13c77088");
        app.pending_component_lines.insert(
            tool_component_key(UNKNOWN_RUN_SCOPE, "wait-1"),
            LogComponentSpan::single(0),
        );
        let parsed = parse_runtime_output(&json!({
            "method":"agent.event", "params":{"event":{
                "type":"tool_result", "tool":"task_wait", "tool_call_id":"wait-1",
                "is_error":false,
                "result":{"name":"MapleScope3", "state":"failed", "termination_reason":"execution_error", "failure_message":"Model session is missing"}
            }}
        }).to_string());
        assert!(apply_runtime_msg(&mut app, parsed, tx));
        assert_eq!(
            app.log[0].plain_text(),
            "✖ Agent: MapleScope3 — failed (execution_error)"
        );
        assert_eq!(app.log[1].plain_text(), "  Model session is missing");
    });
}

#[test]
fn shell_tool_result_replaces_pending_shell_call_with_fallback_summary() {
    with_runtime_tx(|tx| {
        let mut app = AppState::default();
        app.push_line(LogKind::ToolCall, "Shell: git status --short");
        app.pending_component_lines.insert(
            tool_component_key(UNKNOWN_RUN_SCOPE, "shell-result-1"),
            LogComponentSpan::single(0),
        );

        let parsed = parse_runtime_output(
            &json!({
                "jsonrpc": "2.0",
                "method": "agent.event",
                "params": {
                    "event": {
                        "type": "tool_result",
                        "tool": "shell",
                        "tool_call_id": "shell-result-1",
                        "is_error": false,
                        "result": {
                            "key": "shell-1234abcd",
                            "command": "git status --short",
                            "state": "completed",
                            "exit_code": 0,
                            "duration_ms": 12,
                            "stdout": " M crates/tui/src/app/runtime/parser.rs"
                        }
                    }
                }
            })
            .to_string(),
        );

        assert!(apply_runtime_msg(&mut app, parsed, tx));
        assert_eq!(
            app.log[0].plain_text(),
            "✔ Shell: git status --short (12 ms)"
        );
        assert_eq!(app.log[0].spans()[0].kind, LogKind::ToolResult);
        assert_eq!(app.log[0].spans()[2].kind, LogKind::ToolCall);
        assert_eq!(app.log[0].spans()[4].kind, LogKind::Assistant);
        assert_eq!(
            app.log[1].plain_text(),
            "   M crates/tui/src/app/runtime/parser.rs"
        );
    });
}

#[test]
fn denied_shell_reports_reason_once_and_preserves_safe_call_context() {
    with_runtime_tx(|tx| {
        for (command, reason, expected_header) in [
            (
                "git status --short",
                "review_unavailable: The review request timed out.",
                "✖ Shell: git status --short",
            ),
            (
                "echo mock-credential",
                "review_evidence_credential: The review evidence matches a credential detector. Evidence location: command arguments.",
                "✖ Shell: command held before review",
            ),
        ] {
            let mut app = AppState::default();
            let call = json!({
                "method": "agent.event",
                "params": { "event": {
                    "type": "tool_call", "tool": "shell", "tool_call_id": "shell-1",
                    "args": { "command": command }
                }}
            });
            let result = json!({
                "method": "agent.event",
                "params": { "event": {
                    "type": "tool_result", "tool": "shell", "tool_call_id": "shell-1",
                    "is_error": true,
                    "result": format!("Permission denied: {reason} Do not repeat this request without new evidence or updated instructions. Otherwise report the blocker.")
                }}
            });

            for event in [call, result] {
                let parsed = parse_runtime_output(&event.to_string());
                assert!(apply_runtime_msg(&mut app, parsed, tx));
            }

            assert_eq!(app.log.len(), 2);
            assert_eq!(app.log[0].plain_text(), expected_header);
            assert_eq!(app.log[1].plain_text(), format!("  {reason}"));
        }
    });
}

#[test]
fn webfetch_tool_result_replaces_pending_call_with_fallback_summary() {
    with_runtime_tx(|tx| {
        let mut app = AppState::default();
        app.push_line(LogKind::ToolCall, "WebFetch: www.google.com");
        app.pending_component_lines.insert(
            tool_component_key(UNKNOWN_RUN_SCOPE, "webfetch-result-1"),
            LogComponentSpan::single(0),
        );

        let parsed = parse_runtime_output(
            &json!({
                "jsonrpc": "2.0",
                "method": "agent.event",
                "params": {
                    "event": {
                        "type": "tool_result",
                        "tool": "webfetch",
                        "tool_call_id": "webfetch-result-1",
                        "is_error": false,
                        "result": {
                            "url": "https://www.google.com",
                            "final_url": "https://www.google.com/",
                            "status": 200,
                            "output_format": "text",
                            "content": "Google",
                            "byte_size": 50000,
                            "duration_ms": 227,
                            "truncated": true
                        }
                    }
                }
            })
            .to_string(),
        );

        assert!(apply_runtime_msg(&mut app, parsed, tx));
        assert_eq!(
            app.log[0].plain_text(),
            "✔ WebFetch: www.google.com/ (49 KB, 227 ms, truncated)"
        );
        assert_eq!(app.log[0].kind(), LogKind::ToolResult);
        assert_eq!(app.log[0].spans()[0].kind, LogKind::ToolResult);
        assert_eq!(app.log[0].spans()[2].kind, LogKind::ToolCall);
        assert_eq!(app.log[0].spans()[4].kind, LogKind::Assistant);
    });
}

#[test]
fn non_shell_tool_result_keeps_existing_summary_and_only_adds_status_icon() {
    with_runtime_tx(|tx| {
        let mut app = AppState::default();
        app.push_line(LogKind::ToolCall, "Read: crates/tui/src/main.rs");
        app.pending_component_lines.insert(
            tool_component_key(UNKNOWN_RUN_SCOPE, "read-result-1"),
            LogComponentSpan::single(0),
        );

        let parsed = parse_runtime_output(
            &json!({
                "jsonrpc": "2.0",
                "method": "agent.event",
                "params": {
                    "event": {
                        "type": "tool_result",
                        "tool": "read",
                        "tool_call_id": "read-result-1",
                        "is_error": false,
                        "result": "first line\nsecond line"
                    }
                }
            })
            .to_string(),
        );

        assert!(apply_runtime_msg(&mut app, parsed, tx));
        assert_eq!(app.log[0].plain_text(), "✔ Read: crates/tui/src/main.rs");
        assert_eq!(app.log.len(), 1);
    });
}

#[test]
fn apply_patch_tool_result_suppresses_duplicate_diff_after_permission_preview() {
    with_runtime_tx(|tx| {
        let mut app = AppState::default();
        app.push_line(LogKind::ToolCall, "ApplyPatch: 1 file(s)");
        app.pending_component_lines.insert(
            tool_component_key(UNKNOWN_RUN_SCOPE, "tool-apply-1"),
            LogComponentSpan::single(0),
        );

        let preview = parse_runtime_output(
            r#"{"method":"agent.event","params":{"event":{"type":"permission.preview","tool":"apply_patch","tool_call_id":"tool-apply-1","diff":"--- a/demo.txt\n+++ b/demo.txt\n@@ -1 +1 @@\n-old line\n+new line"}}}"#,
        );
        assert!(apply_runtime_msg(&mut app, preview, tx));
        let preview_len = app.log.len();

        let result = parse_runtime_output(
            r#"{"method":"agent.event","params":{"event":{"type":"tool_result","tool":"apply_patch","tool_call_id":"tool-apply-1","result":{"summary":"Applied patch to 1 file(s)","diff":"--- a/demo.txt\n+++ b/demo.txt\n@@ -1 +1 @@\n-old line\n+new line"}}}}"#,
        );
        assert!(apply_runtime_msg(&mut app, result, tx));

        assert_eq!(app.log.len(), preview_len);
        assert_eq!(app.log[0].plain_text(), "✔ ApplyPatch: 1 file(s)");
        assert_eq!(
            app.log
                .iter()
                .filter(|line| line.plain_text().contains("+ new line"))
                .count(),
            1
        );
    });
}

#[test]
fn permission_ready_replay_with_same_tool_call_id_is_suppressed() {
    with_runtime_tx(|tx| {
        let mut app = AppState::default();
        let first = parse_runtime_output(
            r#"{"method":"agent.event","params":{"event":{"type":"permission.ready","tool":"shell","tool_call_id":"shell-confirm-1"}}}"#,
        );
        assert!(apply_runtime_msg(&mut app, first, tx));
        let first_len = app.log.len();
        assert!(app
            .log
            .iter()
            .any(|line| line.plain_text() == "Review shell changes, then choose Allow or Deny"));

        let second = parse_runtime_output(
            r#"{"method":"agent.event","params":{"event":{"type":"permission.ready","tool":"shell","tool_call_id":"shell-confirm-1"}}}"#,
        );
        assert!(apply_runtime_msg(&mut app, second, tx));

        assert_eq!(app.log.len(), first_len);
        assert_eq!(
            app.log
                .iter()
                .filter(
                    |line| line.plain_text() == "Review shell changes, then choose Allow or Deny"
                )
                .count(),
            1
        );
    });
}

#[test]
fn compaction_start_uses_run_scoped_sequence_key() {
    let mut app = AppState::default();
    app.runtime_info.active_run_id = Some("run-1".to_string());
    let mut incoming = vec![LogLine::new(LogKind::Compaction, "Compaction: running")];
    let mut starts: Vec<PendingComponentStart> = Vec::new();

    apply_compaction_component_events(
        &mut app,
        &mut incoming,
        &mut starts,
        crate::app::runtime::CompactionPhase::Started,
    );

    assert_eq!(incoming.len(), 1);
    assert_eq!(incoming[0].plain_text(), "Compaction: running");
    assert_eq!(starts.len(), 1);
    assert_eq!(starts[0].0, "run:run-1:compaction#1");
    assert_eq!(starts[0].1, LogKind::Compaction);
}

#[test]
fn compaction_complete_replaces_active_component_line() {
    let mut app = AppState::default();
    app.runtime_info.active_run_id = Some("run-1".to_string());
    app.push_line(LogKind::Compaction, "Compaction: running");
    app.pending_component_lines.insert(
        "run:run-1:compaction#1".to_string(),
        LogComponentSpan::single(0),
    );
    app.active_compaction_component_by_scope
        .insert("run-1".to_string(), "run:run-1:compaction#1".to_string());

    let mut incoming = vec![LogLine::new(
        LogKind::Compaction,
        "Compaction: completed (compacted=true)",
    )];
    let mut starts: Vec<PendingComponentStart> = Vec::new();

    apply_compaction_component_events(
        &mut app,
        &mut incoming,
        &mut starts,
        crate::app::runtime::CompactionPhase::Completed,
    );

    assert!(incoming.is_empty());
    assert_eq!(app.log.len(), 1);
    assert_eq!(
        app.log[0].plain_text(),
        "Compaction: completed (compacted=true)"
    );
    assert!(!app
        .pending_component_lines
        .contains_key("run:run-1:compaction#1"));
}

#[test]
fn compaction_complete_keeps_line_when_active_component_is_missing() {
    let mut app = AppState::default();
    let mut incoming = vec![LogLine::new(
        LogKind::Compaction,
        "Compaction: skipped (compacted=false)",
    )];
    let mut starts: Vec<PendingComponentStart> = Vec::new();

    apply_compaction_component_events(
        &mut app,
        &mut incoming,
        &mut starts,
        crate::app::runtime::CompactionPhase::Completed,
    );

    assert_eq!(incoming.len(), 1);
    assert_eq!(
        incoming[0].plain_text(),
        "Compaction: skipped (compacted=false)"
    );
    assert!(app.log.is_empty());
}

#[test]
fn register_pending_component_lines_stores_tool_component_span() {
    let mut app = AppState::default();
    app.push_line(LogKind::ToolCall, "Bash: pwd");

    register_pending_component_lines(
        &mut app,
        0,
        vec![(tool_component_key("run-1", "tool-1"), LogKind::ToolCall)],
    );

    assert_eq!(
        app.pending_component_lines
            .get("run:run-1:tool:tool-1")
            .copied(),
        Some(LogComponentSpan::single(0))
    );
}

#[test]
fn resolve_tool_component_key_matches_suffix_across_scopes_and_picks_latest_span() {
    let mut app = AppState::default();
    app.pending_component_lines.insert(
        "run:run-a:tool:tool-7".to_string(),
        LogComponentSpan::single(2),
    );
    app.pending_component_lines.insert(
        "run:run-b:tool:tool-7".to_string(),
        LogComponentSpan::single(9),
    );

    let resolved = resolve_tool_component_key(&app, "tool-7");

    assert_eq!(resolved.as_deref(), Some("run:run-b:tool:tool-7"));
}

#[test]
fn compaction_start_twice_increments_sequence_and_tracks_latest_active_key() {
    let mut app = AppState::default();
    app.runtime_info.active_run_id = Some("run-9".to_string());
    let mut first = vec![LogLine::new(LogKind::Compaction, "Compaction: running")];
    let mut second = vec![LogLine::new(LogKind::Compaction, "Compaction: running")];
    let mut starts: Vec<PendingComponentStart> = Vec::new();

    apply_compaction_component_events(
        &mut app,
        &mut first,
        &mut starts,
        crate::app::runtime::CompactionPhase::Started,
    );
    apply_compaction_component_events(
        &mut app,
        &mut second,
        &mut starts,
        crate::app::runtime::CompactionPhase::Started,
    );

    assert_eq!(starts.len(), 2);
    assert_eq!(starts[0].0, "run:run-9:compaction#1");
    assert_eq!(starts[1].0, "run:run-9:compaction#2");
    assert_eq!(
        app.active_compaction_component_by_scope
            .get("run-9")
            .map(String::as_str),
        Some("run:run-9:compaction#2")
    );
}

#[test]
fn clear_component_tracking_for_run_clears_run_scoped_compaction_state() {
    let mut app = AppState::default();
    app.compaction_sequence_by_scope
        .insert("run-1".to_string(), 7);
    app.compaction_sequence_by_scope
        .insert("run-2".to_string(), 3);
    app.active_compaction_component_by_scope
        .insert("run-1".to_string(), "run:run-1:compaction#7".to_string());
    app.active_compaction_component_by_scope
        .insert("run-2".to_string(), "run:run-2:compaction#3".to_string());
    app.pending_component_lines.insert(
        "run:run-1:tool:tool-1".to_string(),
        LogComponentSpan::single(0),
    );
    app.pending_component_lines.insert(
        "run:run-1:compaction#7".to_string(),
        LogComponentSpan::single(1),
    );
    app.pending_component_lines.insert(
        "run:run-2:tool:tool-9".to_string(),
        LogComponentSpan::single(2),
    );

    clear_component_tracking_for_run(&mut app, "run-1");

    assert!(!app.compaction_sequence_by_scope.contains_key("run-1"));
    assert_eq!(
        app.compaction_sequence_by_scope.get("run-2").copied(),
        Some(3)
    );
    assert!(!app
        .active_compaction_component_by_scope
        .contains_key("run-1"));
    assert_eq!(
        app.active_compaction_component_by_scope
            .get("run-2")
            .map(String::as_str),
        Some("run:run-2:compaction#3")
    );
    assert!(!app
        .pending_component_lines
        .contains_key("run:run-1:tool:tool-1"));
    assert!(!app
        .pending_component_lines
        .contains_key("run:run-1:compaction#7"));
    assert!(app
        .pending_component_lines
        .contains_key("run:run-2:tool:tool-9"));
}

#[test]
fn take_active_compaction_key_only_crosses_scope_for_unknown_run_scope() {
    let mut app = AppState::default();
    app.active_compaction_component_by_scope
        .insert("run-a".to_string(), "run:run-a:compaction#2".to_string());

    let non_unknown = take_active_compaction_key(&mut app, "run-b");
    assert!(non_unknown.is_none());
    assert_eq!(
        app.active_compaction_component_by_scope
            .get("run-a")
            .map(String::as_str),
        Some("run:run-a:compaction#2")
    );

    let unknown = take_active_compaction_key(&mut app, UNKNOWN_RUN_SCOPE);
    assert_eq!(unknown.as_deref(), Some("run:run-a:compaction#2"));
    assert!(app.active_compaction_component_by_scope.is_empty());
}

#[test]
fn register_pending_component_lines_tracks_multiple_components_in_order() {
    let mut app = AppState::default();
    app.push_line(LogKind::ToolCall, "Bash: pwd");
    app.push_line(LogKind::Compaction, "Compaction: running");

    register_pending_component_lines(
        &mut app,
        0,
        vec![
            (tool_component_key("run-1", "tool-1"), LogKind::ToolCall),
            ("run:run-1:compaction#1".to_string(), LogKind::Compaction),
        ],
    );

    assert_eq!(
        app.pending_component_lines
            .get("run:run-1:tool:tool-1")
            .copied(),
        Some(LogComponentSpan::single(0))
    );
    assert_eq!(
        app.pending_component_lines
            .get("run:run-1:compaction#1")
            .copied(),
        Some(LogComponentSpan::single(1))
    );
}

#[test]
fn steer_applied_removes_in_flight_steer_and_unconsumed_steers_fallback_ordered() {
    use crate::app::InFlightSteer;

    with_runtime_tx(|tx| {
        let mut app = AppState::default();
        app.update_run_status("running".to_string());
        app.runtime_info.active_run_id = Some("run-1".to_string());

        app.in_flight_steers.push_back(InFlightSteer {
            client_steer_id: "cs-1".to_string(),
            server_steer_id: Some("s1".to_string()),
            unverified_steer_id: None,
            run_id: "run-1".to_string(),
            submitted_at: Instant::now(),
            submission: PendingPromptRun {
                seq: 1,
                queue_id: String::new(),
                queued_at: Instant::now(),
                preview: "applied steer".to_string(),
                user_text: "applied steer".to_string(),
                display_text: "applied steer [Image 1]".to_string(),
                image_descriptions: vec!["  [image 10x20 1KB]".to_string()],
                input_payload: json!({"type":"text","text":"applied steer"}),
                attachment_count: 0,
                files: Default::default(),
                shell_result_count: 0,
                dispatch_attempts: 0,
            },
        });
        app.in_flight_steers.push_back(InFlightSteer {
            client_steer_id: "cs-2".to_string(),
            server_steer_id: Some("s2".to_string()),
            unverified_steer_id: None,
            run_id: "run-1".to_string(),
            submitted_at: Instant::now(),
            submission: PendingPromptRun {
                seq: 2,
                queue_id: String::new(),
                queued_at: Instant::now(),
                preview: "unconsumed steer".to_string(),
                user_text: "unconsumed steer".to_string(),
                display_text: "unconsumed steer".to_string(),
                image_descriptions: Vec::new(),
                input_payload: json!({"type":"text","text":"unconsumed steer"}),
                attachment_count: 0,
                files: Default::default(),
                shell_result_count: 0,
                dispatch_attempts: 0,
            },
        });
        app.pending_prompt_queue.push_back(PendingPromptRun {
            seq: 3,
            queue_id: "q1".to_string(),
            queued_at: Instant::now(),
            preview: "later queued".to_string(),
            user_text: "later queued".to_string(),
            display_text: "later queued".to_string(),
            image_descriptions: Vec::new(),
            input_payload: json!({"type":"text","text":"later queued"}),
            attachment_count: 0,
            files: Default::default(),
            shell_result_count: 0,
            dispatch_attempts: 0,
        });

        let applied = parse_runtime_output(
            r#"{"method":"agent.event","params":{"run_id":"run-1","event":{"type":"steer_applied","steer_id":"s1","content":"RAW_MODEL_PAYLOAD"}}}"#,
        );
        apply_runtime_msg(&mut app, applied, tx);
        assert_eq!(app.in_flight_steers.len(), 1);
        let transcript = app
            .log
            .iter()
            .map(LogLine::plain_text)
            .collect::<Vec<_>>()
            .join("\n");
        assert!(transcript.contains("> applied steer [Image 1]"));
        assert!(transcript.contains("[image 10x20 1KB]"));
        assert!(!transcript.contains("RAW_MODEL_PAYLOAD"));
        assert_eq!(
            app.in_flight_steers[0].server_steer_id.as_deref(),
            Some("s2")
        );

        let completed = parse_runtime_output(
            r#"{"method":"run.status","params":{"run_id":"run-1","status":"completed","unconsumed_steer_ids":["s2"]}}"#,
        );
        apply_runtime_msg(&mut app, completed, tx);

        assert!(app.in_flight_steers.is_empty());
        assert_eq!(app.pending_prompt_queue.len(), 2);
        assert_eq!(app.pending_prompt_queue[0].user_text, "unconsumed steer");
        assert_eq!(app.pending_prompt_queue[1].user_text, "later queued");
    });
}

#[test]
fn image_model_responses_require_status_only_for_get() {
    use crate::app::runtime::RpcResponse;

    with_runtime_tx(|tx| {
        for (payload, missing) in [
            (
                json!({"message": "status", "state": "available"}),
                "requested_mode",
            ),
            (
                json!({"message": "status", "requested_mode": "custom"}),
                "state",
            ),
        ] {
            let mut app = AppState::default();
            app.rpc_pending
                .insert("get".into(), PendingRpc::ImageModelGet);
            assert!(super::handle_rpc_response(
                &mut app,
                RpcResponse {
                    id: "get".into(),
                    result: Some(payload),
                    error: None
                },
                tx,
            ));
            assert!(!app.rpc_pending.has_slot(PendingRpcSlot::ImageModelGet));
            assert!(app.log.iter().any(|line| {
                line.plain_text()
                    .contains("protocol mismatch in image.model.get")
                    && line.plain_text().contains(missing)
            }));
        }

        let mut app = AppState::default();
        app.rpc_pending
            .insert("configure".into(), PendingRpc::ImageModelConfigure);
        assert!(super::handle_rpc_response(
            &mut app,
            RpcResponse {
                id: "configure".into(),
                result: Some(json!({"message": "Image settings unchanged."})),
                error: None
            },
            tx,
        ));
        assert!(!app
            .rpc_pending
            .has_slot(PendingRpcSlot::ImageModelConfigure));
        assert!(app
            .log
            .iter()
            .any(|line| line.plain_text() == "Image settings unchanged."));
    });
}

#[test]
fn shared_steer_cancel_trace_returns_only_pending_submissions_in_order() {
    use crate::app::InFlightSteer;

    let trace = include_str!(concat!(
        env!("CARGO_MANIFEST_DIR"),
        "/../../packages/protocol/tests/fixtures/steer-cancel.jsonl"
    ));
    with_runtime_tx(|tx| {
        let mut events = trace.lines().map(parse_runtime_output);
        let mut app = AppState::default();
        let running = events.next().unwrap();
        assert!(
            matches!(&running, RuntimeMsg::RunControl(RunControlMsg::Status { status, .. }) if status == "running")
        );
        apply_runtime_msg(&mut app, running, tx);
        let run_id = app.runtime_info.active_run_id.clone().unwrap();

        let submission = |seq, server_id: &str, text: &str| InFlightSteer {
            client_steer_id: format!("c-{seq}"),
            server_steer_id: (!server_id.is_empty()).then(|| server_id.into()),
            unverified_steer_id: None,
            run_id: run_id.clone(),
            submitted_at: Instant::now(),
            submission: PendingPromptRun {
                seq,
                queue_id: String::new(),
                queued_at: Instant::now(),
                preview: text.into(),
                user_text: text.into(),
                display_text: text.into(),
                image_descriptions: Vec::new(),
                input_payload: json!({"type":"text","text":text}),
                attachment_count: 0,
                files: Default::default(),
                shell_result_count: 0,
                dispatch_attempts: 0,
            },
        };
        app.in_flight_steers
            .push_back(submission(1, "", "focus on tests"));
        let applied = events.next().unwrap();
        let RuntimeMsg::Agent(AgentMsg::SteerApplied {
            steer_id,
            client_id,
            ..
        }) = &applied
        else {
            panic!("expected applied steer");
        };
        assert_eq!(steer_id, "s1");
        assert_eq!(client_id.as_deref(), Some("c-1"));
        apply_runtime_msg(&mut app, applied, tx);
        assert!(app.in_flight_steers.is_empty());
        assert!(app.pending_prompt_queue.is_empty());

        app.in_flight_steers.extend([
            submission(2, "", "follow up 1"),
            submission(3, "s3", "follow up 2"),
        ]);
        super::run_control::handle_run_steer_response(
            &mut app,
            "c-2".into(),
            crate::app::runtime::RpcResponse {
                id: "missing-ack".into(),
                result: None,
                error: None,
            },
        );
        assert_eq!(
            app.in_flight_steers[0].submission.dispatch_attempts,
            crate::app::PROMPT_DISPATCH_MAX_ATTEMPTS
        );
        let cancelled = events.next().unwrap();
        let RuntimeMsg::RunControl(RunControlMsg::Status {
            status,
            run_id: status_run_id,
            unconsumed_steer_ids,
            unconsumed_client_steer_ids,
            ..
        }) = &cancelled
        else {
            panic!("expected cancelled run status");
        };
        assert_eq!(status, "cancelled");
        assert_eq!(status_run_id.as_ref(), Some(&run_id));
        assert_eq!(unconsumed_steer_ids, &["s2", "s3"]);
        assert_eq!(
            unconsumed_client_steer_ids.as_deref(),
            Some(["c-2".to_owned()].as_slice())
        );
        apply_runtime_msg(&mut app, cancelled, tx);
        assert!(events.next().is_none());
        assert!(app.in_flight_steers.is_empty());
        assert_eq!(
            app.pending_prompt_queue
                .iter()
                .map(|item| item.user_text.as_str())
                .collect::<Vec<_>>(),
            ["follow up 1", "follow up 2"]
        );
        assert_eq!(app.pending_prompt_queue[0].dispatch_attempts, 0);
    });
}

#[test]
fn steer_applied_and_cancel_fallback_match_server_steer_id_without_client_id_collision() {
    use crate::app::InFlightSteer;

    with_runtime_tx(|tx| {
        let mut app = AppState::default();
        app.update_run_status("running".to_string());
        app.runtime_info.active_run_id = Some("run-1".to_string());

        let client_id_1 = app.allocate_client_steer_id();
        let client_id_2 = app.allocate_client_steer_id();
        assert_eq!(client_id_1, "cs-1");
        assert_eq!(client_id_2, "cs-2");

        // Simulate swapped server IDs (e.g. client cs-1 got s2, client cs-2 got s1),
        // plus verify that even if a test/custom client ID ever looked like "s1",
        // steer_applied only matches server_steer_id.
        app.in_flight_steers.push_back(InFlightSteer {
            client_steer_id: client_id_1,
            server_steer_id: Some("s2".to_string()),
            unverified_steer_id: None,
            run_id: "run-1".to_string(),
            submitted_at: Instant::now(),
            submission: PendingPromptRun {
                seq: 1,
                queue_id: String::new(),
                queued_at: Instant::now(),
                preview: "steer one".to_string(),
                user_text: "steer one".to_string(),
                display_text: "steer one".to_string(),
                image_descriptions: Vec::new(),
                input_payload: json!({"type":"text","text":"steer one"}),
                attachment_count: 0,
                files: Default::default(),
                shell_result_count: 0,
                dispatch_attempts: 0,
            },
        });
        app.in_flight_steers.push_back(InFlightSteer {
            client_steer_id: client_id_2,
            server_steer_id: Some("s1".to_string()),
            unverified_steer_id: None,
            run_id: "run-1".to_string(),
            submitted_at: Instant::now(),
            submission: PendingPromptRun {
                seq: 2,
                queue_id: String::new(),
                queued_at: Instant::now(),
                preview: "steer two".to_string(),
                user_text: "steer two".to_string(),
                display_text: "steer two".to_string(),
                image_descriptions: Vec::new(),
                input_payload: json!({"type":"text","text":"steer two"}),
                attachment_count: 0,
                files: Default::default(),
                shell_result_count: 0,
                dispatch_attempts: 0,
            },
        });

        // s1 is applied; only the entry with server_steer_id == "s1" ("steer two") is removed.
        let applied = parse_runtime_output(
            r#"{"method":"agent.event","params":{"run_id":"run-1","event":{"type":"steer_applied","steer_id":"s1","content":"steer two"}}}"#,
        );
        apply_runtime_msg(&mut app, applied, tx);
        assert_eq!(app.in_flight_steers.len(), 1);
        assert_eq!(app.in_flight_steers[0].submission.user_text, "steer one");

        // Run is cancelled with unconsumed s2; only "steer one" falls back to queue.
        let cancelled = parse_runtime_output(
            r#"{"method":"run.status","params":{"run_id":"run-1","status":"cancelled","unconsumed_steer_ids":["s2"]}}"#,
        );
        apply_runtime_msg(&mut app, cancelled, tx);

        assert!(app.in_flight_steers.is_empty());
        assert_eq!(app.pending_prompt_queue.len(), 1);
        assert_eq!(app.pending_prompt_queue[0].user_text, "steer one");
    });
}

fn in_flight(
    client: &str,
    confirmed: Option<&str>,
    unverified: Option<&str>,
    text: &str,
    attempts: u32,
) -> crate::app::InFlightSteer {
    crate::app::InFlightSteer {
        client_steer_id: client.to_string(),
        server_steer_id: confirmed.map(str::to_owned),
        unverified_steer_id: unverified.map(str::to_owned),
        run_id: "run-1".to_string(),
        submitted_at: Instant::now(),
        submission: PendingPromptRun {
            seq: 1,
            queue_id: String::new(),
            queued_at: Instant::now(),
            preview: text.to_string(),
            user_text: text.to_string(),
            display_text: text.to_string(),
            image_descriptions: Vec::new(),
            input_payload: json!({"type":"text","text":text}),
            attachment_count: 0,
            files: Default::default(),
            shell_result_count: 0,
            dispatch_attempts: attempts,
        },
    }
}

#[test]
fn inconsistent_applied_steer_ids_keep_matching_candidates_paused_after_run_end() {
    use crate::app::PROMPT_DISPATCH_MAX_ATTEMPTS as PAUSED;

    with_runtime_tx(|tx| {
        for (client_id, client_attempts) in [("unknown", 0), ("cs-1", PAUSED)] {
            let mut app = AppState::default();
            app.runtime_info.active_run_id = Some("run-1".into());
            app.in_flight_steers.extend([
                in_flight("cs-1", Some("s1"), None, "client match", 0),
                in_flight("cs-2", Some("s2"), None, "confirmed server match", 0),
                in_flight("cs-3", None, Some("s2"), "unverified server match", 0),
            ]);
            let applied = parse_runtime_output(
                &json!({
                    "method": "agent.event",
                    "params": {"run_id": "run-1", "event": {
                        "type": "steer_applied", "steer_id": "s2",
                        "client_steer_id": client_id, "content": "applied input"
                    }}
                })
                .to_string(),
            );
            apply_runtime_msg(&mut app, applied, tx);
            assert_eq!(app.in_flight_steers.len(), 3, "{client_id}");
            assert!(app.log.iter().any(|line| {
                matches!(line.kind(), LogKind::Error)
                    && line
                        .plain_text()
                        .contains("inconsistent client and server IDs")
            }));
            let completed = parse_runtime_output(
                r#"{"method":"run.status","params":{"run_id":"run-1","status":"completed"}}"#,
            );
            apply_runtime_msg(&mut app, completed, tx);
            let attempts: Vec<_> = app
                .pending_prompt_queue
                .iter()
                .map(|prompt| (prompt.user_text.as_str(), prompt.dispatch_attempts))
                .collect();
            assert_eq!(
                attempts,
                [
                    ("client match", client_attempts),
                    ("confirmed server match", PAUSED),
                    ("unverified server match", PAUSED),
                ],
                "{client_id}"
            );
        }
    });
}

#[test]
fn applied_steer_with_matching_client_id_can_arrive_before_its_acknowledgement() {
    let mut app = AppState::default();
    app.in_flight_steers
        .push_back(in_flight("cs-1", None, None, "pending acknowledgement", 0));

    assert_eq!(
        applied_steer_position(&mut app, "run-1", "s1", Some("cs-1")),
        Some(0)
    );
}

#[test]
fn a_confirmed_steer_id_wins_over_one_read_from_a_malformed_result() {
    use crate::app::PROMPT_DISPATCH_MAX_ATTEMPTS;
    with_runtime_tx(|tx| {
        let mut app = AppState::default();
        app.runtime_info.active_run_id = Some("run-1".to_string());
        // A's result was malformed but carried s1; B's valid result confirmed s1.
        app.in_flight_steers.push_back(in_flight(
            "cs-1",
            None,
            Some("s1"),
            "steer A",
            PROMPT_DISPATCH_MAX_ATTEMPTS,
        ));
        app.in_flight_steers
            .push_back(in_flight("cs-2", Some("s1"), None, "steer B", 0));
        let applied = parse_runtime_output(
            r#"{"method":"agent.event","params":{"run_id":"run-1","event":{"type":"steer_applied","steer_id":"s1","content":"steer B"}}}"#,
        );
        apply_runtime_msg(&mut app, applied, tx);
        assert_eq!(app.in_flight_steers.len(), 1);
        assert_eq!(app.in_flight_steers[0].submission.user_text, "steer A");

        let completed = parse_runtime_output(
            r#"{"method":"run.status","params":{"run_id":"run-1","status":"completed"}}"#,
        );
        apply_runtime_msg(&mut app, completed, tx);
        // B was applied and is gone; A returns paused, never resent automatically.
        assert_eq!(app.pending_prompt_queue.len(), 1);
        assert_eq!(app.pending_prompt_queue[0].user_text, "steer A");
        assert_eq!(
            app.pending_prompt_queue[0].dispatch_attempts,
            PROMPT_DISPATCH_MAX_ATTEMPTS
        );
    });
}

#[test]
fn terminal_unconsumed_ids_retry_only_confirmed_or_unique_unverified_steers() {
    use crate::app::PROMPT_DISPATCH_MAX_ATTEMPTS as PAUSED;

    let mut app = AppState::default();
    let mut other_run = in_flight("cs-7", None, Some("unique"), "other run", PAUSED);
    other_run.run_id = "run-2".into();
    app.in_flight_steers.extend([
        in_flight("cs-1", None, Some("unique"), "unique", PAUSED),
        in_flight("cs-2", None, Some("ambiguous"), "ambiguous A", PAUSED),
        in_flight("cs-3", None, Some("ambiguous"), "ambiguous B", PAUSED),
        in_flight("cs-4", None, Some("confirmed"), "unverified", PAUSED),
        in_flight("cs-5", Some("confirmed"), None, "confirmed", PAUSED),
        other_run,
    ]);

    fallback_unconsumed_steers(
        &mut app,
        Some("run-1"),
        &["unique".into(), "ambiguous".into(), "confirmed".into()],
        None,
    );
    let attempts = app
        .pending_prompt_queue
        .iter()
        .map(|prompt| (prompt.user_text.as_str(), prompt.dispatch_attempts))
        .collect::<std::collections::BTreeMap<_, _>>();
    assert_eq!(
        attempts,
        std::collections::BTreeMap::from([
            ("unique", 0),
            ("ambiguous A", PAUSED),
            ("ambiguous B", PAUSED),
            ("unverified", PAUSED),
            ("confirmed", 0),
        ])
    );
    assert_eq!(app.in_flight_steers.len(), 1);
    assert_eq!(app.in_flight_steers[0].run_id, "run-2");
}

#[test]
fn malformed_secret_prompt_is_declined_without_opening_the_input_dialog() {
    let mut tx = MockRuntimeTx::default();
    let mut app = AppState::default();
    let parsed = crate::app::runtime::parse_runtime_output(
        r#"{"jsonrpc":"2.0","id":"ui-1","method":"ui.prompt.request","params":{"title":"Secret","message":"Enter password","secret":null}}"#,
    );
    apply_runtime_msg(&mut app, parsed, &mut tx);
    assert!(app.overlays.runtime_dialogs.prompt.is_none());
    let [reply] = tx.sent.as_slice() else {
        panic!("expected one prompt reply");
    };
    assert_eq!(
        *reply,
        json!({"jsonrpc":"2.0","id":"ui-1","result":{"value":null}})
    );
}

#[test]
fn an_unreadable_steer_applied_pauses_the_run_steers() {
    use crate::app::PROMPT_DISPATCH_MAX_ATTEMPTS;
    with_runtime_tx(|tx| {
        for run_id in [Some(json!("run-1")), None, Some(json!(10))] {
            let mut app = AppState::default();
            app.runtime_info.active_run_id = Some("run-1".to_string());
            app.in_flight_steers
                .push_back(in_flight("cs-1", Some("s1"), None, "steer A", 0));
            // Strict parser: the live event lacks the required timestamp.
            let mut notification = json!({
                "jsonrpc":"2.0", "method":"agent.event",
                "params":{"seq":4,"event":{"type":"steer_applied","steer_id":"s1","content":"steer A"}}
            });
            if let Some(run_id) = run_id {
                notification["params"]["run_id"] = run_id;
            }
            let applied = crate::app::runtime::parse_runtime_output(&notification.to_string());
            assert!(matches!(
                applied,
                RuntimeMsg::Agent(AgentMsg::UnreadableSteerApplied { .. })
            ));
            apply_runtime_msg(&mut app, applied, tx);
            assert_eq!(app.in_flight_steers.len(), 1);

            let completed = parse_runtime_output(
                r#"{"method":"run.status","params":{"run_id":"run-1","status":"completed"}}"#,
            );
            apply_runtime_msg(&mut app, completed, tx);
            assert_eq!(app.pending_prompt_queue.len(), 1);
            assert_eq!(
                app.pending_prompt_queue[0].dispatch_attempts,
                PROMPT_DISPATCH_MAX_ATTEMPTS
            );
        }
    });
}

#[test]
fn ignored_runtime_lines_do_not_request_redraw() {
    let mut app = AppState::default();
    let mut tx = MockRuntimeTx::default();
    let initial_log_len = app.log.len();
    let (sender, rx) = std::sync::mpsc::channel();
    for raw in [
        "  ",
        r#"{"jsonrpc":"2.0","method":"auth.login.status","params":{"login_id":"login","provider":"openai","method":"device_code","status":"completed"}}"#,
    ] {
        let msg = crate::app::runtime::parse_runtime_output(raw);
        assert!(matches!(msg, RuntimeMsg::Ignored));
        assert!(!apply_runtime_msg(&mut app, msg, &mut tx));
        sender.send(raw.to_owned()).unwrap();
    }
    assert!(!super::process_runtime_messages(&mut app, &rx, &mut tx));
    assert_eq!(app.log.len(), initial_log_len);
    assert!(tx.sent.is_empty());
}

#[test]
fn malformed_server_request_logs_diagnostic_and_replies_once() {
    let mut tx = MockRuntimeTx::default();
    let mut app = AppState::default();
    for (id, method, params) in [
        ("ui-1", "ui.confirm.request", json!({"title":"Run?"})),
        (
            "ui-2",
            "client.tool.call",
            json!({"run_id":"run","name":"tui_open_selector"}),
        ),
    ] {
        let raw = json!({"jsonrpc":"2.0","id":id,"method":method,"params":params}).to_string();
        let msg = crate::app::runtime::parse_runtime_output(&raw);
        assert!(matches!(
            msg,
            RuntimeMsg::ClientTool(crate::app::runtime::ClientToolMsg::RejectMalformed { .. })
        ));
        assert!(apply_runtime_msg(&mut app, msg, &mut tx));
        let line = app.log.last().unwrap();
        assert_eq!(line.kind(), LogKind::Error);
        assert!(line.plain_text().contains(method));
    }
    assert!(app.overlays.runtime_dialogs.confirm.is_none());
    assert!(app.overlays.runtime_dialogs.pick.is_none());
    assert_eq!(tx.sent.len(), 2);
    let decline = &tx.sent[0];
    assert_eq!(decline["id"], "ui-1");
    assert_eq!(decline["result"]["ok"], false);
    let failure = &tx.sent[1];
    assert_eq!(failure["id"], "ui-2");
    assert!(failure["result"]["error"]
        .as_str()
        .unwrap()
        .contains("raw_arguments"));
}

#[test]
fn replay_only_progress_bypasses_pending_tool_component_tracking() {
    let mut tx = MockRuntimeTx::default();
    let mut app = AppState::default();
    let events = [
        json!({"type":"tool_call","tool":"tui_show_progress","tool_call_id":"p1","args":{"id":"build","phase":"Build","current":1,"total":2}}),
        json!({"type":"tool_result","tool":"tui_show_progress","tool_call_id":"p1","result":"progress shown"}),
    ];
    for event in events {
        let msg = parse_runtime_output(
            &json!({"method":"agent.event","params":{"run_id":"old","meta":{"replayed":true},"event":event}}).to_string(),
        );
        assert!(matches!(
            &msg,
            RuntimeMsg::Agent(AgentMsg::ReplayProgress(_))
        ));
        assert!(apply_runtime_msg(&mut app, msg, &mut tx));
        assert!(app.pending_component_lines.is_empty());
    }
    assert!(app.pending_history_progress.is_empty());
    assert!(app
        .log
        .iter()
        .any(|line| line.plain_text().contains("Build")));
    assert!(tx.sent.is_empty());
}

#[test]
fn runtime_batch_refreshes_run_and_history_context_after_each_line() {
    use crate::app::runtime::parser::test_support::complete_message;

    let mut app = AppState::default();
    app.rpc_pending
        .insert("history".to_owned(), PendingRpc::SessionHistory);
    let mut tx = MockRuntimeTx::default();
    let (sender, rx) = std::sync::mpsc::channel();
    for raw in [
        r#"{"method":"run.status","params":{"run_id":"live","status":"running"}}"#,
        r#"{"method":"agent.event","params":{"run_id":"live","event":{"type":"text.delta","stream_id":"s","index":0,"delta":"live output"}}}"#,
        r#"{"jsonrpc":"2.0","id":"history","result":{"runs":1,"events_sent":0}}"#,
        r#"{"method":"agent.event","params":{"run_id":"old","event":{"type":"tool_call","tool":"tui_show_progress","tool_call_id":"p1","args":{"phase":"Build"}}}}"#,
    ] {
        sender.send(complete_message(raw)).unwrap();
    }
    assert!(super::process_runtime_messages(&mut app, &rx, &mut tx));
    assert!(!app.rpc_pending.has_slot(PendingRpcSlot::SessionHistory));
    assert_eq!(app.stream_preview.segments()[0].content, "live output");
    assert!(app.pending_history_progress.is_empty());
}

#[test]
fn replayed_llm_retry_preserves_live_stream_preview() {
    let mut app = AppState::default();
    let mut tx = MockRuntimeTx::default();
    app.runtime_info.active_run_id = Some("live".to_owned());

    let delta = parse_runtime_output(
        r#"{"method":"agent.event","params":{"run_id":"live","event":{"type":"text.delta","stream_id":"s","index":0,"delta":"in progress"}}}"#,
    );
    apply_runtime_msg(&mut app, delta, &mut tx);
    assert_eq!(app.stream_preview.segments()[0].content, "in progress");

    let replayed_retry = parse_runtime_output(
        r#"{"method":"agent.event","params":{"run_id":"live","meta":{"replayed":true},"event":{"type":"llm.retry","provider":"openai","failure_kind":"rate_limit","next_attempt":2,"max_attempts":3,"delay_ms":1000,"delay_source":"backoff"}}}"#,
    );
    assert!(matches!(replayed_retry, RuntimeMsg::LogLines(_)));
    assert!(apply_runtime_msg(&mut app, replayed_retry, &mut tx));
    assert_eq!(app.stream_preview.segments()[0].content, "in progress");
    assert!(app
        .log
        .last()
        .is_some_and(|line| line.plain_text().contains("LLM retry:")));
}

#[test]
fn filtered_debug_lines_and_batch_cap_preserve_redraw_and_tick_boundary() {
    let mut app = AppState::default();
    let mut tx = MockRuntimeTx::default();
    let (sender, rx) = std::sync::mpsc::channel();

    // Filtered debug-only LogLines still requests redraw (parity with previous behavior).
    sender.send("[runtime] debug line".to_owned()).unwrap();
    assert!(super::process_runtime_messages(&mut app, &rx, &mut tx));
    assert!(app.log.is_empty());

    // 300 ignored lines hit the per-tick cap, force a redraw, and defer line #301 to the next tick.
    for _ in 0..300 {
        sender.send(" ".to_owned()).unwrap();
    }
    sender
        .send(crate::app::runtime::parser::test_support::complete_message(
            r#"{"method":"agent.event","params":{"run_id":"r1","event":{"type":"text","content":"deferred visible"}}}"#,
        ))
        .unwrap();
    assert!(super::process_runtime_messages(&mut app, &rx, &mut tx));
    assert!(app.log.is_empty());

    assert!(super::process_runtime_messages(&mut app, &rx, &mut tx));
    assert!(app
        .log
        .iter()
        .any(|line| line.plain_text().contains("deferred visible")));
}

#[test]
fn pending_confirm_draw_preserves_underlying_prompt_until_activated_then_restores() {
    use crate::app::handlers::confirm::activate_pending_confirm_dialog;
    use crate::app::view::draw_ui;
    use crate::event_loop::input::handle_non_main_key;
    use crossterm::event::{KeyCode, KeyModifiers};
    use ratatui::{backend::TestBackend, Terminal};

    let render_text = |terminal: &mut Terminal<TestBackend>, app: &mut AppState| -> String {
        terminal.draw(|frame| draw_ui(frame, app)).unwrap();
        let buffer = terminal.backend().buffer();
        (0..buffer.area.height)
            .map(|y| {
                (0..buffer.area.width)
                    .map(|x| buffer[(x, y)].symbol())
                    .collect::<String>()
            })
            .collect::<Vec<_>>()
            .join("\n")
    };

    let mut terminal = Terminal::new(TestBackend::new(80, 20)).unwrap();
    let mut app = AppState::default();
    let mut tx = MockRuntimeTx::default();
    app.input.set_from("composer-draft-marker");

    let prompt_msg = parse_runtime_output(
        &json!({
            "jsonrpc": "2.0",
            "id": "prompt-1",
            "method": "ui.prompt.request",
            "params": {
                "title": "API Key Prompt",
                "message": "Enter token",
                "default_value": "typed-token"
            }
        })
        .to_string(),
    );
    apply_runtime_msg(&mut app, prompt_msg, &mut tx);

    let confirm_msg = parse_runtime_output(
        &json!({
            "jsonrpc": "2.0",
            "id": "confirm-1",
            "method": "ui.confirm.request",
            "params": {
                "title": "Allow Shell",
                "message": "Run rm -rf?"
            }
        })
        .to_string(),
    );
    apply_runtime_msg(&mut app, confirm_msg, &mut tx);

    // Frame 1 (Pending): keeps rendering the underlying prompt and editor, NOT composer or confirm.
    let frame1 = render_text(&mut terminal, &mut app);
    assert!(frame1.contains("API Key Prompt"), "{frame1}");
    assert!(frame1.contains("typed-token"), "{frame1}");
    assert!(!frame1.contains("composer-draft-marker"), "{frame1}");
    assert!(!frame1.contains("Allow Shell"), "{frame1}");

    // Frame 2 (Active): renders confirm dialog.
    assert!(activate_pending_confirm_dialog(&mut app));
    let frame2 = render_text(&mut terminal, &mut app);
    assert!(frame2.contains("Allow Shell"), "{frame2}");
    assert!(!frame2.contains("API Key Prompt"), "{frame2}");

    // Resolving confirm restores the prompt and its buffer on Frame 3.
    assert_eq!(
        handle_non_main_key(
            &mut app,
            KeyCode::Char('y'),
            KeyModifiers::NONE,
            &mut tx,
            &mut Vec::new()
        ),
        Some(true)
    );
    let frame3 = render_text(&mut terminal, &mut app);
    assert!(frame3.contains("API Key Prompt"), "{frame3}");
    assert!(frame3.contains("typed-token"), "{frame3}");
    assert!(!frame3.contains("Allow Shell"), "{frame3}");
}

#[test]
fn pending_or_active_confirm_over_update_picker_clears_drawn_update_choice() {
    use crate::app::handlers::confirm::activate_pending_confirm_dialog;
    use crate::app::view::draw_ui;
    use ratatui::{backend::TestBackend, Terminal};

    let mut terminal = Terminal::new(TestBackend::new(80, 20)).unwrap();
    let mut app = AppState::default();
    let mut tx = MockRuntimeTx::default();
    app.overlays.local_panel = Some(LocalPanel::UpdatePicker(
        crate::app::self_update::startup_picker(),
    ));

    terminal.draw(|frame| draw_ui(frame, &mut app)).unwrap();
    assert!(app.render_state.drawn_update_choice.is_some());

    let confirm_msg = parse_runtime_output(
        &json!({
            "jsonrpc": "2.0",
            "id": "confirm-upd",
            "method": "ui.confirm.request",
            "params": { "title": "Confirm", "message": "Proceed?" }
        })
        .to_string(),
    );
    apply_runtime_msg(&mut app, confirm_msg, &mut tx);
    terminal.draw(|frame| draw_ui(frame, &mut app)).unwrap();
    assert!(app.render_state.drawn_update_choice.is_none());

    assert!(activate_pending_confirm_dialog(&mut app));
    terminal.draw(|frame| draw_ui(frame, &mut app)).unwrap();
    assert!(app.render_state.drawn_update_choice.is_none());
}

#[test]
fn runtime_pick_or_prompt_over_update_picker_clears_drawn_update_choice() {
    use crate::app::view::draw_ui;
    use ratatui::{backend::TestBackend, Terminal};

    for request in [
        pick_request("Pick"),
        parse_runtime_output(
            r#"{"jsonrpc":"2.0","id":"prompt","method":"ui.prompt.request","params":{"title":"Prompt","message":"Enter value"}}"#,
        ),
    ] {
        let mut terminal = Terminal::new(TestBackend::new(80, 20)).unwrap();
        let mut app = AppState::default();
        let mut tx = MockRuntimeTx::default();
        app.overlays.local_panel = Some(LocalPanel::UpdatePicker(
            crate::app::self_update::startup_picker(),
        ));
        terminal.draw(|frame| draw_ui(frame, &mut app)).unwrap();
        assert!(app.render_state.drawn_update_choice.is_some());

        assert!(apply_runtime_msg(&mut app, request, &mut tx));
        terminal.draw(|frame| draw_ui(frame, &mut app)).unwrap();
        assert!(app.render_state.drawn_update_choice.is_none());
        assert!(matches!(
            app.overlays.local_panel,
            Some(LocalPanel::UpdatePicker(_))
        ));
    }
}

#[test]
fn startup_update_picker_yields_and_reopens_after_runtime_pick() {
    use crate::app::startup_confirmations::{self, StartupConfirmations};

    let mut app = AppState::default();
    let mut tx = MockRuntimeTx::default();
    app.startup_confirmations = StartupConfirmations::from_list(&["update-mode".into()]);
    assert!(startup_confirmations::poll(&mut app));

    assert!(apply_runtime_msg(&mut app, pick_request("Pick"), &mut tx));
    assert!(startup_confirmations::poll(&mut app));
    assert!(app.overlays.local_panel.is_none());
    assert!(!startup_confirmations::poll(&mut app));
    assert!(app.startup_confirmations.is_pending());

    let cancellation = parse_runtime_output(
        r#"{"jsonrpc":"2.0","method":"ui.pick.cancelled","params":{"id":"runtime-pick"}}"#,
    );
    assert!(apply_runtime_msg(&mut app, cancellation, &mut tx));
    assert!(startup_confirmations::poll(&mut app));
    assert!(matches!(
        &app.overlays.local_panel,
        Some(LocalPanel::UpdatePicker(picker)) if picker.startup
    ));
    assert!(tx.sent.is_empty());
}

#[test]
fn delayed_lane_list_response_preserves_live_runtime_prompt_and_pick_behind_confirm() {
    use crate::app::handlers::confirm::activate_pending_confirm_dialog;
    use crate::event_loop::input::handle_non_main_key;
    use crossterm::event::{KeyCode, KeyModifiers};

    let mut app = AppState::default();
    let mut tx = MockRuntimeTx::default();

    for raw in [
        json!({
            "jsonrpc": "2.0",
            "id": "pick-live",
            "method": "ui.pick.request",
            "params": { "title": "Pick", "items": [{"id": "opt-a", "label": "Option A"}] }
        }),
        json!({
            "jsonrpc": "2.0",
            "id": "prompt-live",
            "method": "ui.prompt.request",
            "params": { "title": "Prompt", "message": "Value", "default_value": "keep-me" }
        }),
        json!({
            "jsonrpc": "2.0",
            "id": "confirm-live",
            "method": "ui.confirm.request",
            "params": { "title": "Confirm", "message": "Proceed?" }
        }),
    ] {
        let msg = parse_runtime_output(&raw.to_string());
        apply_runtime_msg(&mut app, msg, &mut tx);
    }

    // Async /lane response arrives while runtime dialogs are open.
    super::lane::apply_lane_list_result(&mut app, &json!({"lanes": []}));
    assert!(matches!(
        app.overlays.local_panel,
        Some(crate::app::LocalPanel::LaneList(_))
    ));
    assert!(app.overlays.runtime_dialogs.prompt.is_some());
    assert!(app.overlays.runtime_dialogs.pick.is_some());

    // Confirm -> Prompt -> Pick all still resolve with their original IDs and input.
    assert!(activate_pending_confirm_dialog(&mut app));
    assert_eq!(
        handle_non_main_key(
            &mut app,
            KeyCode::Char('y'),
            KeyModifiers::NONE,
            &mut tx,
            &mut Vec::new()
        ),
        Some(true)
    );
    assert_eq!(
        handle_non_main_key(
            &mut app,
            KeyCode::Enter,
            KeyModifiers::NONE,
            &mut tx,
            &mut Vec::new()
        ),
        Some(true)
    );
    assert_eq!(
        handle_non_main_key(
            &mut app,
            KeyCode::Enter,
            KeyModifiers::NONE,
            &mut tx,
            &mut Vec::new()
        ),
        Some(true)
    );

    assert_eq!(tx.sent.len(), 3);
    assert_eq!(tx.sent[0]["id"], "confirm-live");
    assert_eq!(tx.sent[1]["id"], "prompt-live");
    assert_eq!(tx.sent[1]["result"]["value"], "keep-me");
    assert_eq!(tx.sent[2]["id"], "pick-live");
    assert_eq!(tx.sent[2]["result"]["ids"], json!(["opt-a"]));
}

#[test]
fn text_paste_targets_prompt_above_pick_even_during_startup() {
    let mut app = AppState::default();
    let mut tx = MockRuntimeTx::default();
    app.input.set_from("composer draft");
    assert_eq!(app.paste_target(true), PasteTarget::Blocked);
    assert!(!handle_paste(&mut app, "blocked during startup", true));

    for raw in [
        r#"{"jsonrpc":"2.0","id":"pick","method":"ui.pick.request","params":{"title":"Pick","items":[{"id":"option","label":"Option"}]}}"#,
        r#"{"jsonrpc":"2.0","id":"prompt","method":"ui.prompt.request","params":{"title":"Input","message":"Enter value"}}"#,
    ] {
        assert!(apply_runtime_msg(
            &mut app,
            parse_runtime_output(raw),
            &mut tx
        ));
    }
    assert!(app.overlays.runtime_dialogs.pick.is_some());
    for (startup_pending, text) in [(false, "normal"), (true, " startup")] {
        assert_eq!(
            app.paste_target(startup_pending),
            PasteTarget::RuntimePrompt
        );
        assert!(handle_paste(&mut app, text, startup_pending));
    }
    let prompt = app.overlays.runtime_dialogs.prompt.as_ref().unwrap();
    assert_eq!(prompt.input.current(), "normal startup");
    assert_eq!(app.input.current(), "composer draft");
    assert_eq!(app.overlays.paste_target(true, false), PasteTarget::Blocked);
}

#[test]
fn alt_v_in_prompt_shows_the_composer_notice_without_importing() {
    let mut app = AppState::default();
    let mut tx = MockRuntimeTx::default();
    let prompt = parse_runtime_output(
        r#"{"jsonrpc":"2.0","id":"prompt","method":"ui.prompt.request","params":{"title":"Input","message":"Enter value","default_value":"draft"}}"#,
    );
    assert!(apply_runtime_msg(&mut app, prompt, &mut tx));

    let mut effects = Vec::new();
    assert_eq!(
        handle_non_main_key(
            &mut app,
            KeyCode::Char('v'),
            KeyModifiers::ALT,
            &mut tx,
            &mut effects,
        ),
        Some(true)
    );
    assert!(effects.is_empty());
    let notice = app.log.last().expect("clipboard notice");
    assert_eq!(notice.kind(), LogKind::Status);
    assert_eq!(
        notice.plain_text(),
        "File and image paste is available in the chat composer."
    );
    let prompt = app.overlays.runtime_dialogs.prompt.as_ref().unwrap();
    assert_eq!(prompt.input.current(), "draft");
    assert!(!app.has_pending_clipboard_import());
}

#[test]
fn client_context_panels_replace_local_panel_and_preserve_other_tiers() {
    let mut app = AppState::default();
    let mut tx = MockRuntimeTx::default();
    app.overlays.queue_focus = Some(crate::app::QueueSteerPicker {
        run_id: "run-1".into(),
        queue_id: "q1".into(),
    });
    for raw in [
        r#"{"jsonrpc":"2.0","id":"pick","method":"ui.pick.request","params":{"title":"Pick","items":[{"id":"option","label":"Option"}]}}"#,
        r#"{"jsonrpc":"2.0","id":"prompt","method":"ui.prompt.request","params":{"title":"Input","message":"Enter value","default_value":"draft"}}"#,
    ] {
        assert!(apply_runtime_msg(
            &mut app,
            parse_runtime_output(raw),
            &mut tx
        ));
    }
    receive_confirm(&mut app, &mut tx, "confirm");

    for (name, args, expected_row) in [
        (
            "tui_open_selector",
            json!({"items":[{"label":"Option A"}]}),
            "Option A",
        ),
        (
            "tui_preview_artifact",
            json!({"content":"Preview body"}),
            "Preview body",
        ),
    ] {
        app.overlays.local_panel = Some(LocalPanel::ThemeList(crate::app::ThemeListPanelState {
            title: "Themes".into(),
            header: String::new(),
            rows: vec![],
            theme_ids: vec![],
            selected: 0,
        }));
        let request = parse_runtime_output(
            &json!({
                "jsonrpc": "2.0",
                "id": name,
                "method": "client.tool.call",
                "params": {
                    "run_id": "run-1",
                    "name": name,
                    "arguments": args,
                    "raw_arguments": "{}"
                }
            })
            .to_string(),
        );
        assert!(apply_runtime_msg(&mut app, request, &mut tx));
        let Some(LocalPanel::Context(panel)) = &app.overlays.local_panel else {
            panic!("context panel expected after {name}");
        };
        assert_eq!(panel.rows, [expected_row]);
        let dialogs = &app.overlays.runtime_dialogs;
        assert!(matches!(
            dialogs.confirm,
            Some(ConfirmSlot::Pending(ref confirm)) if confirm.id == "confirm"
        ));
        assert_eq!(dialogs.prompt.as_ref().unwrap().state.id, "prompt");
        assert_eq!(dialogs.prompt.as_ref().unwrap().input.current(), "draft");
        assert_eq!(dialogs.pick.as_ref().unwrap().id(), "pick");
        let queue_focus = app.overlays.queue_focus.as_ref().unwrap();
        assert_eq!(queue_focus.run_id, "run-1");
        assert_eq!(queue_focus.queue_id, "q1");
        assert!(!app.queue_picker_focused());
    }
}

fn pick_request(title: &str) -> RuntimeMsg {
    parse_runtime_output(
        &json!({
            "jsonrpc": "2.0",
            "id": "runtime-pick",
            "method": "ui.pick.request",
            "params": {
                "title": title,
                "items": [{ "id": "model-id", "label": "Display Model" }]
            }
        })
        .to_string(),
    )
}

fn ask_user_choice_request() -> RuntimeMsg {
    parse_runtime_output(
        r#"{"jsonrpc":"2.0","id":"client-choice","method":"client.tool.call","params":{"run_id":"run-1","name":"tui_ask_user_choice","arguments":{"title":"Choose next","choices":[{"id":"continue","label":"Continue"}]},"raw_arguments":"{}"}}"#,
    )
}

#[test]
fn onboarding_model_pick_cancels_only_on_matching_id() {
    let mut app = AppState::default();
    let mut tx = MockRuntimeTx::default();
    assert!(apply_runtime_msg(
        &mut app,
        pick_request("Select model (openai)"),
        &mut tx
    ));

    for id in ["stale-pick", "runtime-pick"] {
        let cancellation = parse_runtime_output(
            &json!({"jsonrpc":"2.0","method":"ui.pick.cancelled","params":{"id":id}}).to_string(),
        );
        assert!(apply_runtime_msg(&mut app, cancellation, &mut tx));
        if id == "stale-pick" {
            assert!(matches!(
                app.overlays.runtime_dialogs.pick,
                Some(RuntimePickDialog::OnboardingModelList { ref request_id, .. })
                    if request_id == "runtime-pick"
            ));
        } else {
            assert!(app.overlays.runtime_dialogs.pick.is_none());
        }
    }
    assert!(tx.sent.is_empty());
}

#[test]
fn onboarding_model_pick_survives_local_panel_replacements_and_replies_once() {
    let mut app = AppState::default();
    let mut tx = MockRuntimeTx::default();
    assert!(apply_runtime_msg(
        &mut app,
        pick_request("Select model (openai)"),
        &mut tx
    ));
    assert!(matches!(
        app.overlays.runtime_dialogs.pick,
        Some(RuntimePickDialog::OnboardingModelList { .. })
    ));

    app.rpc_pending.insert(
        "sess-list".to_owned(),
        PendingRpc::SessionList { show_all: false },
    );
    let session_list =
        parse_runtime_output(r#"{"jsonrpc":"2.0","id":"sess-list","result":{"sessions":[]}}"#);
    assert!(apply_runtime_msg(&mut app, session_list, &mut tx));
    assert!(matches!(
        app.overlays.local_panel,
        Some(LocalPanel::SessionList(_))
    ));

    let selector = parse_runtime_output(
        r#"{"jsonrpc":"2.0","id":"selector","method":"client.tool.call","params":{"run_id":"run-1","name":"tui_open_selector","arguments":{"items":[{"label":"Option A"}]},"raw_arguments":"{}"}}"#,
    );
    assert!(apply_runtime_msg(&mut app, selector, &mut tx));
    assert!(matches!(
        app.overlays.local_panel,
        Some(LocalPanel::Context(_))
    ));
    assert_eq!(tx.sent[0]["id"], "selector");
    assert_eq!(tx.sent[0]["result"]["ok"], true);

    assert_eq!(
        handle_non_main_key(
            &mut app,
            KeyCode::Enter,
            KeyModifiers::NONE,
            &mut tx,
            &mut Vec::new()
        ),
        Some(true)
    );
    assert!(app.overlays.runtime_dialogs.pick.is_none());
    assert!(matches!(
        app.overlays.local_panel,
        Some(LocalPanel::Context(_))
    ));
    assert_eq!(
        handle_non_main_key(
            &mut app,
            KeyCode::Enter,
            KeyModifiers::NONE,
            &mut tx,
            &mut Vec::new()
        ),
        Some(true)
    );
    assert_eq!(tx.sent.len(), 2);
    assert_eq!(tx.sent[1]["id"], "runtime-pick");
    assert_eq!(tx.sent[1]["result"]["ids"], json!(["model-id"]));
}

#[test]
fn runtime_pick_rejects_later_client_tool_choice() {
    for title in ["Pick", "Select model (openai)"] {
        let mut app = AppState::default();
        let mut tx = MockRuntimeTx::default();
        assert!(apply_runtime_msg(&mut app, pick_request(title), &mut tx));
        assert!(apply_runtime_msg(
            &mut app,
            ask_user_choice_request(),
            &mut tx
        ));
        assert_eq!(tx.sent.len(), 1);
        assert_eq!(tx.sent[0]["id"], "client-choice");
        assert_eq!(tx.sent[0]["result"]["error"], "pick dialog is busy");
        assert!(app.rpc_pending.client_tool_choice_ids.is_empty());
        assert_eq!(
            app.overlays.runtime_dialogs.pick.as_ref().unwrap().id(),
            "runtime-pick"
        );
    }
}

#[test]
fn runtime_pick_declines_and_untracks_displaced_client_tool_choice() {
    for title in ["Pick", "Select model (openai)"] {
        let mut app = AppState::default();
        let mut tx = MockRuntimeTx::default();
        assert!(apply_runtime_msg(
            &mut app,
            ask_user_choice_request(),
            &mut tx
        ));
        assert!(tx.sent.is_empty());
        assert!(app
            .rpc_pending
            .client_tool_choice_ids
            .contains("client-choice"));

        assert!(apply_runtime_msg(&mut app, pick_request(title), &mut tx));
        assert!(app.rpc_pending.client_tool_choice_ids.is_empty());
        assert_eq!(tx.sent.len(), 1);
        assert_eq!(tx.sent[0]["id"], "client-choice");
        assert_eq!(tx.sent[0]["result"]["error"], "choice superseded");
        assert_eq!(
            app.overlays.runtime_dialogs.pick.as_ref().unwrap().id(),
            "runtime-pick"
        );

        let cancellation = parse_runtime_output(
            r#"{"jsonrpc":"2.0","method":"client.tool.cancel","params":{"request_id":"client-choice","run_id":"run-1","name":"tui_ask_user_choice","reason":"timeout"}}"#,
        );
        assert!(apply_runtime_msg(&mut app, cancellation, &mut tx));
        assert_eq!(
            handle_non_main_key(
                &mut app,
                KeyCode::Enter,
                KeyModifiers::NONE,
                &mut tx,
                &mut Vec::new()
            ),
            Some(true)
        );
        assert_eq!(tx.sent.len(), 2);
        assert_eq!(tx.sent[1]["id"], "runtime-pick");
        assert_eq!(tx.sent[1]["result"]["ids"], json!(["model-id"]));
    }
}

#[test]
fn local_update_and_shell_rule_pickers_block_client_tool_choice() {
    use crate::app::state::{ShellRulePicker, ShellRulePickerState};

    let panels = [
        LocalPanel::UpdatePicker(crate::app::self_update::startup_picker()),
        LocalPanel::ShellRulePicker(ShellRulePickerState {
            title: "Rules".into(),
            message: None,
            items: vec![],
            selected: 0,
            kind: ShellRulePicker::Choose { session_id: None },
            review_offset: None,
        }),
    ];
    for panel in panels {
        let mut app = AppState::default();
        let mut tx = MockRuntimeTx::default();
        app.overlays.local_panel = Some(panel);
        assert!(apply_runtime_msg(
            &mut app,
            ask_user_choice_request(),
            &mut tx
        ));
        assert_eq!(tx.sent.len(), 1);
        assert_eq!(tx.sent[0]["id"], "client-choice");
        assert_eq!(tx.sent[0]["result"]["error"], "pick dialog is busy");
        assert!(app.overlays.runtime_dialogs.pick.is_none());
        assert!(app.overlays.local_panel.is_some());
        assert!(app.rpc_pending.client_tool_choice_ids.is_empty());
    }
}

#[test]
fn silent_model_list_preserves_open_skills_panel_and_alt_v_does_not_type_into_skills_search() {
    use crate::event_loop::input::handle_non_main_key;
    use crossterm::event::{KeyCode, KeyModifiers};

    let mut app = AppState::default();
    let mut tx = MockRuntimeTx::default();
    app.overlays.local_panel = Some(LocalPanel::SkillsList(crate::app::SkillsListPanelState {
        title: "Skills".into(),
        header: String::new(),
        rows: vec!["alpha".into()],
        filtered_indices: vec![0],
        items: vec![crate::app::SkillsListItemState {
            name: "alpha".into(),
            scope: "repo".into(),
            path: "/repo/.agents/skills/alpha/SKILL.md".into(),
            description: "desc".into(),
            enabled: true,
        }],
        selected: 0,
        search_query: "al".into(),
        scope_filter: crate::app::SkillsScopeFilter::All,
    }));

    // Background silent model.list must leave the open SkillsList panel intact.
    app.rpc_pending.insert(
        "ml-silent".to_owned(),
        PendingRpc::ModelList {
            mode: crate::app::ModelListMode::Silent,
            scope: crate::app::ModelSetScope::Config,
        },
    );
    let ml_resp = parse_runtime_output(
        &json!({
            "jsonrpc": "2.0",
            "id": "ml-silent",
            "result": { "provider": "openai", "models": ["gpt-6-luna"], "current": "gpt-6-luna" }
        })
        .to_string(),
    );
    assert!(apply_runtime_msg(&mut app, ml_resp, &mut tx));
    assert!(matches!(
        app.overlays.local_panel,
        Some(LocalPanel::SkillsList(_))
    ));

    // Alt+v while SkillsList is open is consumed without mutating search_query or selection.
    assert_eq!(
        handle_non_main_key(
            &mut app,
            KeyCode::Char('v'),
            KeyModifiers::ALT,
            &mut tx,
            &mut Vec::new()
        ),
        Some(false)
    );
    let Some(LocalPanel::SkillsList(panel)) = &app.overlays.local_panel else {
        panic!("skills panel should remain open");
    };
    assert_eq!(panel.search_query, "al");
    assert_eq!(panel.selected, 0);
}

#[test]
fn ui_pick_cancelled_does_not_close_client_tool_choice_even_with_matching_id() {
    use crate::event_loop::input::handle_non_main_key;
    use crossterm::event::{KeyCode, KeyModifiers};

    let mut app = AppState::default();
    let mut tx = MockRuntimeTx::default();
    assert!(apply_runtime_msg(
        &mut app,
        ask_user_choice_request(),
        &mut tx
    ));
    assert!(app.overlays.runtime_dialogs.pick.is_some());

    // A server ui.pick.cancelled must never cancel a ClientToolChoice (which belongs to client.tool.cancel).
    let cancelled = parse_runtime_output(
        r#"{"jsonrpc":"2.0","method":"ui.pick.cancelled","params":{"id":"client-choice"}}"#,
    );
    assert!(apply_runtime_msg(&mut app, cancelled, &mut tx));
    assert!(app.overlays.runtime_dialogs.pick.is_some());
    assert!(app
        .rpc_pending
        .client_tool_choice_ids
        .contains("client-choice"));

    // User can still answer the client tool choice normally.
    assert_eq!(
        handle_non_main_key(
            &mut app,
            KeyCode::Enter,
            KeyModifiers::NONE,
            &mut tx,
            &mut Vec::new()
        ),
        Some(true)
    );
    assert_eq!(tx.sent.len(), 1);
    assert_eq!(tx.sent[0]["id"], "client-choice");
    assert_eq!(tx.sent[0]["result"]["ok"], true);
    assert_eq!(
        tx.sent[0]["result"]["result"]["value"]["selected_id"],
        "continue"
    );
}

#[test]
fn overlapping_ui_pick_request_keeps_first_open_and_declines_second() {
    use crate::event_loop::input::handle_non_main_key;
    use crossterm::event::{KeyCode, KeyModifiers};

    let mut app = AppState::default();
    let mut tx = MockRuntimeTx::default();

    let first = parse_runtime_output(
        &json!({
            "jsonrpc": "2.0",
            "id": "pick-1",
            "method": "ui.pick.request",
            "params": {
                "title": "First pick",
                "items": [{ "id": "one", "label": "One" }],
                "multi": false
            }
        })
        .to_string(),
    );
    let second = parse_runtime_output(
        &json!({
            "jsonrpc": "2.0",
            "id": "pick-2",
            "method": "ui.pick.request",
            "params": {
                "title": "Second pick",
                "items": [{ "id": "two", "label": "Two" }],
                "multi": false
            }
        })
        .to_string(),
    );

    assert!(apply_runtime_msg(&mut app, first, &mut tx));
    assert!(tx.sent.is_empty());

    // Second server pick is declined immediately; first remains active and answerable.
    assert!(apply_runtime_msg(&mut app, second, &mut tx));
    assert_eq!(tx.sent.len(), 1);
    assert_eq!(tx.sent[0]["id"], "pick-2");
    assert_eq!(tx.sent[0]["result"]["ids"], json!([]));
    assert_eq!(
        app.overlays.runtime_dialogs.pick.as_ref().unwrap().id(),
        "pick-1"
    );

    assert_eq!(
        handle_non_main_key(
            &mut app,
            KeyCode::Enter,
            KeyModifiers::NONE,
            &mut tx,
            &mut Vec::new()
        ),
        Some(true)
    );
    assert_eq!(tx.sent.len(), 2);
    assert_eq!(tx.sent[1]["id"], "pick-1");
    assert_eq!(tx.sent[1]["result"]["ids"], json!(["one"]));
}

#[test]
fn local_lane_action_picker_esc_sends_no_rpc_and_survives_runtime_dialog_preemption() {
    use crate::app::state::{LaneActionPickerState, PickDialogItem};
    use crate::event_loop::input::handle_non_main_key;
    use crossterm::event::{KeyCode, KeyModifiers};

    let mut app = AppState::default();
    let mut tx = MockRuntimeTx::default();
    app.overlays.local_panel = Some(LocalPanel::LaneActionPicker(LaneActionPickerState {
        lane_id: "lane-1".into(),
        title: "Lane: lane-1".into(),
        items: vec![PickDialogItem {
            id: "focus".into(),
            label: "Focus".into(),
            detail: None,
        }],
        selected: 0,
    }));

    // A runtime prompt preempts without clobbering the local lane action picker.
    let prompt = parse_runtime_output(
        &json!({
            "jsonrpc": "2.0",
            "id": "prompt-1",
            "method": "ui.prompt.request",
            "params": { "title": "Token", "message": "Enter token" }
        })
        .to_string(),
    );
    assert!(apply_runtime_msg(&mut app, prompt, &mut tx));
    assert!(matches!(
        app.overlays.local_panel,
        Some(LocalPanel::LaneActionPicker(_))
    ));

    // Dismissing the runtime prompt reveals the local lane action picker again.
    assert_eq!(
        handle_non_main_key(
            &mut app,
            KeyCode::Esc,
            KeyModifiers::NONE,
            &mut tx,
            &mut Vec::new()
        ),
        Some(true)
    );
    assert_eq!(tx.sent.len(), 1);
    assert_eq!(tx.sent[0]["id"], "prompt-1");
    assert!(matches!(
        app.overlays.local_panel,
        Some(LocalPanel::LaneActionPicker(_))
    ));

    // Esc on local LaneActionPicker closes it without sending any RPC.
    assert_eq!(
        handle_non_main_key(
            &mut app,
            KeyCode::Esc,
            KeyModifiers::NONE,
            &mut tx,
            &mut Vec::new()
        ),
        Some(true)
    );
    assert!(app.overlays.local_panel.is_none());
    assert_eq!(tx.sent.len(), 1);
}

#[test]
fn local_update_and_shell_rule_pickers_block_selector_and_preview_client_tools() {
    use crate::app::state::{ShellRulePicker, ShellRulePickerState};

    let selector_req = || {
        parse_runtime_output(
            &json!({
                "jsonrpc": "2.0",
                "id": "client-selector",
                "method": "client.tool.call",
                "params": {
                    "run_id": "run-1",
                    "name": "tui_open_selector",
                    "arguments": {
                        "title": "Select",
                        "items": [{ "id": "a", "label": "Alpha" }]
                    }
                }
            })
            .to_string(),
        )
    };
    let preview_req = || {
        parse_runtime_output(
            &json!({
                "jsonrpc": "2.0",
                "id": "client-preview",
                "method": "client.tool.call",
                "params": {
                    "run_id": "run-1",
                    "name": "tui_preview_artifact",
                    "arguments": {
                        "title": "Preview",
                        "content": "hello"
                    }
                }
            })
            .to_string(),
        )
    };

    for make_panel in [
        || LocalPanel::UpdatePicker(crate::app::self_update::startup_picker()),
        || {
            LocalPanel::ShellRulePicker(ShellRulePickerState {
                title: "Rules".into(),
                message: None,
                items: vec![],
                selected: 0,
                kind: ShellRulePicker::Choose { session_id: None },
                review_offset: None,
            })
        },
    ] {
        for (req, expected_id) in [
            (selector_req(), "client-selector"),
            (preview_req(), "client-preview"),
        ] {
            let mut app = AppState::default();
            let mut tx = MockRuntimeTx::default();
            app.overlays.local_panel = Some(make_panel());
            assert!(apply_runtime_msg(&mut app, req, &mut tx));
            assert_eq!(tx.sent.len(), 1);
            assert_eq!(tx.sent[0]["id"], expected_id);
            assert_eq!(tx.sent[0]["result"]["error"], "pick dialog is busy");
            assert!(matches!(
                app.overlays.local_panel,
                Some(LocalPanel::UpdatePicker(_) | LocalPanel::ShellRulePicker(_))
            ));
        }
    }
}
