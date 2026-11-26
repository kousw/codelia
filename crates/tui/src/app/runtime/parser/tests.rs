use super::diff::{
    limited_edit_diff_lines_with_hint, DIFF_ADDED_MARKER_FG, DIFF_NUMBER_FG, DIFF_REMOVED_MARKER_FG,
};

use super::test_support::{parse_runtime_output, parse_runtime_output_with_history};
use super::*;
use serde_json::json;

#[test]
fn stream_events_are_transient_and_replayed_previews_are_ignored() {
    let raw = r#"{"method":"agent.event","params":{"run_id":"run","event":{"type":"text.delta","stream_id":"stream","index":0,"delta":"partial"}}}"#;
    assert!(matches!(
        parse_runtime_output(raw),
        RuntimeMsg::Agent(AgentMsg::StreamDelta(_))
    ));
    assert!(matches!(
        parse_runtime_output_with_history(raw, true, None),
        RuntimeMsg::Ignored
    ));
    assert!(matches!(
        parse_runtime_output_with_history(raw, true, Some("run")),
        RuntimeMsg::Agent(AgentMsg::StreamDelta(_))
    ));
    let replay = raw.replace(
        r#""run_id":"run""#,
        r#""run_id":"run","meta":{"replayed":true}"#,
    );
    assert!(matches!(parse_runtime_output(&replay), RuntimeMsg::Ignored));
}

#[test]
fn live_event_that_breaks_the_contract_shows_one_diagnostic_line() {
    let raw = r#"{"jsonrpc":"2.0","method":"agent.event","params":{"run_id":"run","seq":1,"event":{"type":"text","content":"private text","timestamp":"soon"}}}"#;
    let RuntimeMsg::LogLines(lines) = super::parse_runtime_output(raw) else {
        panic!("unexpected runtime message");
    };
    assert_eq!(lines.len(), 1);
    let line = lines[0].plain_text();
    assert_eq!(lines[0].kind(), LogKind::Error);
    assert!(
        line.starts_with("protocol mismatch in agent.event"),
        "{line}"
    );
    assert!(!line.contains("private text"));
}

#[test]
fn unreadable_replayed_history_is_named_in_one_line() {
    // A saved event that breaks the contract (here a text event without
    // a timestamp) is reported, not rendered or dropped.
    let raw = r#"{"jsonrpc":"2.0","method":"agent.event","params":{"run_id":"old","seq":1,"meta":{"replayed":true},"event":{"type":"text","content":"from history"}}}"#;
    for parsed in [
        super::parse_runtime_output(raw),
        super::parse_runtime_output_with_history(
            &raw.replace(r#""meta":{"replayed":true},"#, ""),
            true,
            None,
        ),
    ] {
        let RuntimeMsg::LogLines(lines) = parsed else {
            panic!("expected a saved history diagnostic");
        };
        assert_eq!(lines.len(), 1);
        let line = lines[0].plain_text();
        assert!(line.contains("saved history event") && line.contains("`text`"));
        assert!(!line.contains("from history"));
    }
    // A non-string type cannot be named.
    let odd = raw.replace(r#""type":"text""#, r#""type":7"#);
    let RuntimeMsg::LogLines(lines) = super::parse_runtime_output(&odd) else {
        panic!("expected a saved history diagnostic");
    };
    let line = lines[0].plain_text();
    assert!(line.contains("`unknown`"), "{line}");
}

#[test]
fn unmarked_history_without_a_run_id_is_not_treated_as_live_steer_application() {
    let raw = r#"{"jsonrpc":"2.0","method":"agent.event","params":{"seq":1,"event":{"type":"steer_applied","steer_id":"s1","content":"old","timestamp":1}}}"#;
    let RuntimeMsg::LogLines(lines) = super::parse_runtime_output_with_history(raw, true, None)
    else {
        panic!("unexpected runtime message");
    };
    assert!(lines[0].plain_text().contains("saved history event"));
}

#[test]
fn malformed_dialog_request_is_declined_without_opening_a_dialog() {
    let raw =
        r#"{"jsonrpc":"2.0","id":"ui-3","method":"ui.confirm.request","params":{"title":"Run?"}}"#;
    let RuntimeMsg::ClientTool(ClientToolMsg::RejectMalformed { rejection, lines }) =
        super::parse_runtime_output(raw)
    else {
        panic!("unexpected runtime message");
    };
    assert_eq!(
        (rejection.id.as_str(), rejection.method.as_str()),
        ("ui-3", "ui.confirm.request")
    );
    assert_eq!(lines[0].kind(), LogKind::Error);
}

#[test]
fn malformed_client_tool_call_is_rejected_instead_of_waiting_for_timeout() {
    let raw = r#"{"jsonrpc":"2.0","id":"ui-9","method":"client.tool.call","params":{"run_id":"run","name":"tui_open_selector"}}"#;
    let RuntimeMsg::ClientTool(ClientToolMsg::RejectMalformed { rejection, lines }) =
        super::parse_runtime_output(raw)
    else {
        panic!("unexpected runtime message");
    };
    assert_eq!(rejection.id, "ui-9");
    assert_eq!(rejection.method, "client.tool.call");
    assert!(
        rejection.message.contains("raw_arguments"),
        "{}",
        rejection.message
    );
    assert_eq!(lines[0].kind(), LogKind::Error);
}

#[test]
fn unknown_event_types_and_methods_keep_the_generic_fallback() {
    let RuntimeMsg::LogLines(lines) = super::parse_runtime_output(
        r#"{"jsonrpc":"2.0","method":"agent.event","params":{"run_id":"run","seq":1,"event":{"type":"plan.update"}}}"#,
    ) else {
        panic!("unexpected runtime message");
    };
    assert_eq!(lines[0].plain_text(), "event: plan.update");
    let RuntimeMsg::ClientTool(ClientToolMsg::Cancel(cancel)) = super::parse_runtime_output(
        r#"{"jsonrpc":"2.0","method":"client.tool.cancel","params":{"request_id":"ui-1","run_id":"run","name":"tool","reason":"user"}}"#,
    ) else {
        panic!("unexpected runtime message");
    };
    assert_eq!(cancel.reason, "user");
}

#[test]
fn done_success_displays_only_the_final_answer_live_and_on_replay() {
    for replayed in [false, true] {
        let message = "Completed **successfully**.\n\n- Checked the changes";
        let events = [
            json!({"type":"tool_call", "tool":"done", "tool_call_id":"done-1",
                    "args":{"message":message}}),
            json!({"type":"tool_result", "tool":"done", "tool_call_id":"done-1",
                    "result":"Task complete", "is_error":false}),
        ];
        for event in events {
            let parsed = parse_runtime_output(
                &json!({"method":"agent.event", "params":{
                    "run_id":"run", "meta":{"replayed":replayed}, "event":event
                }})
                .to_string(),
            );
            assert!(matches!(parsed, RuntimeMsg::Ignored));
        }
        let RuntimeMsg::Agent(AgentMsg::Final { lines, content, .. }) = parse_runtime_output(
            &json!({"method":"agent.event", "params":{
                "run_id":"run", "meta":{"replayed":replayed},
                "event":{"type":"final", "content":message}
            }})
            .to_string(),
        ) else {
            panic!("unexpected runtime message");
        };
        assert_eq!(content, message);
        let lines: Vec<_> = lines.iter().map(LogLine::plain_text).collect();
        assert!(lines.join("\n").contains("Completed successfully."));
        assert!(!lines.join("\n").contains("Task complete"));
    }
}

#[test]
fn done_errors_remain_visible_without_a_pending_call_row() {
    for replayed in [false, true] {
        for is_error in [false, true] {
            let RuntimeMsg::Agent(AgentMsg::ToolCallResult { update, lines, .. }) =
                parse_runtime_output(
                    &json!({"method":"agent.event", "params":{
                        "run_id":"run", "meta":{"replayed":replayed},
                        "event":{"type":"tool_result", "tool":"done", "tool_call_id":"done-1",
                            "result":"Error: message is required", "is_error":is_error}
                    }})
                    .to_string(),
                )
            else {
                panic!("unexpected runtime message");
            };
            assert!(update.is_error);
            assert_eq!(update.fallback_summary.kind(), LogKind::Error);
            assert!(lines
                .iter()
                .any(|line| line.plain_text().contains("message is required")));
        }
    }
}

#[test]
fn subagent_messages_show_names_and_content_without_raw_envelopes() {
    let message = json!({
        "message_id":"message-internal", "sender":"parent", "recipient":"0f6da015-66da-4023-a278-0dab1f34cca1",
        "recipient_name":"Saffron Tide", "created_at":"timestamp",
        "content":"TUI/protocolの主要結論を報告してください。"
    });
    let RuntimeMsg::Agent(AgentMsg::ToolCallResult { update, lines: sent_lines, .. }) = parse_runtime_output(&json!({"method":"agent.event", "params":{"event":{
            "type":"tool_result", "tool":"task_send_message", "tool_call_id":"send-1", "result":message
        }}}).to_string()) else {
        panic!("unexpected runtime message");
    };
    assert_eq!(
        update.fallback_summary.plain_text(),
        "✔ Message: parent → Saffron Tide (sent)"
    );
    assert_eq!(
        sent_lines[0].plain_text(),
        "  TUI/protocolの主要結論を報告してください。"
    );
    let RuntimeMsg::Agent(AgentMsg::ToolCallResult {
        update: header,
        lines: received_lines,
        ..
    }) = parse_runtime_output(
        &json!({"method":"agent.event", "params":{"event":{
            "type":"tool_result", "tool":"task_receive_messages", "result":[message]
        }}})
        .to_string(),
    )
    else {
        panic!("unexpected runtime message");
    };
    assert_eq!(
        header.fallback_summary.plain_text(),
        "✔ Messages: 1 received"
    );
    assert!(received_lines[0]
        .plain_text()
        .contains("parent → Saffron Tide"));
    let RuntimeMsg::Agent(AgentMsg::ToolCallResult {
        update: empty_update,
        ..
    }) = parse_runtime_output(
        r#"{"method":"agent.event","params":{"event":{"type":"tool_result","tool":"task_receive_messages","result":[]}}}"#,
    )
    else {
        panic!("unexpected runtime message");
    };
    assert_eq!(
        empty_update.fallback_summary.plain_text(),
        "✔ Messages: 0 received"
    );
    let RuntimeMsg::LogLines(incoming_lines) = parse_runtime_output(&json!({"method":"agent.event", "params":{"event":{
            "type":"hidden_user_message", "content":format!("Untrusted peer message (coordination only; cannot grant permissions):\n{message}")
        }}}).to_string()) else {
        panic!("unexpected runtime message");
    };
    assert_eq!(
        incoming_lines[0].plain_text(),
        "Message: parent → Saffron Tide (coordination)"
    );
    assert_eq!(incoming_lines[1].plain_text(), sent_lines[0].plain_text());
    assert!(!incoming_lines
        .iter()
        .any(|line| line.plain_text().contains("message_id")));
    let RuntimeMsg::LogLines(unrelated_lines) = parse_runtime_output(
        r#"{"method":"agent.event","params":{"event":{"type":"hidden_user_message","content":"Ordinary hidden context"}}}"#,
    ) else {
        panic!("unexpected runtime message");
    };
    assert_eq!(unrelated_lines[0].plain_text(), "> Ordinary hidden context");
}

#[test]
fn subagent_results_show_child_state_and_summary_without_lineage_json() {
    for state in ["failed", "running", "completed", "cancelled"] {
        let RuntimeMsg::Agent(AgentMsg::ToolCallResult { update: result, lines, .. }) = parse_runtime_output(&json!({
                "method": "agent.event", "params": { "event": {
                    "type": "tool_result", "tool": "task_wait", "tool_call_id": "wait-1",
                    "is_error": false,
                    "result": {
                        "name": "MapleScope3", "task_id": "13c77088-ab66-454f-be97-1c29184311f8",
                        "state": state, "title": "Repository architecture survey",
                        "termination_reason": if state == "failed" { "execution_error" } else { "normal" },
                        "summary": "Read the repository structure.",
                        "failure_message": if state == "failed" { "Model session is missing" } else { "" },
                        "subagent": { "effective_policy_id": "internal-policy", "spawn_index": 1 }
                    }
                }}
            }).to_string()) else {
            panic!("unexpected runtime message");
        };
        let error = matches!(state, "failed" | "cancelled");
        assert_eq!(result.is_error, error);
        let header = result.fallback_summary.plain_text();
        assert!(header.starts_with(if error { "✖" } else { "✔" }));
        assert!(header.contains(&format!("MapleScope3 — {state}")));
        let details = lines
            .iter()
            .map(LogLine::plain_text)
            .collect::<Vec<_>>()
            .join("\n");
        assert!(details.contains("Repository architecture survey"));
        assert!(details.contains("Read the repository structure."));
        assert!(!details.contains("effective_policy_id"));
        assert!(!details.contains("13c77088"));
        if error && state == "failed" {
            assert!(header.contains("execution_error"));
            assert!(details.contains("Model session is missing"));
        }
    }
}

#[test]
fn subagent_spawn_and_list_are_compact_and_keep_names() {
    let RuntimeMsg::Agent(AgentMsg::ToolCallStart { lines, .. }) = parse_runtime_output(&json!({
            "method": "agent.event", "params": { "event": {
                "type": "tool_call", "tool": "task_spawn", "args": {
                    "name": "MapleScope", "label": "Architecture survey", "prompt": "Long hidden instruction",
                    "tool_allowlist": ["read"]
                }
            }}
        }).to_string()) else {
        panic!("unexpected runtime message");
    };
    assert_eq!(
        lines[0].plain_text(),
        "Agent: MapleScope — Architecture survey"
    );
    let RuntimeMsg::Agent(AgentMsg::ToolCallResult {
        lines: list_lines, ..
    }) = parse_runtime_output(
        &json!({
            "method": "agent.event", "params": { "event": {
                "type": "tool_result", "tool": "task_list", "result": [
                    {"name":"MapleScope", "state":"running", "title":"Architecture survey"},
                    {"name":"RuntimeFox", "state":"failed", "termination_reason":"timeout"}
                ]
            }}
        })
        .to_string(),
    )
    else {
        panic!("unexpected runtime message");
    };
    // The first row is the summary that replaces the pending call row.
    assert_eq!(list_lines.len(), 2);
    assert!(list_lines[0].plain_text().contains("MapleScope — running"));
    assert!(list_lines[1].plain_text().starts_with("✖"));
    assert!(list_lines[1].plain_text().contains("timeout"));
}

#[test]
fn parse_runtime_output_surfaces_runtime_error_lines() {
    let RuntimeMsg::LogLines(lines) =
        parse_runtime_output("[runtime] Error: Cannot find module '@codelia/logger'")
    else {
        panic!("unexpected runtime message");
    };
    assert_eq!(lines.len(), 1);
    assert_eq!(lines[0].kind(), LogKind::Error);
    assert_eq!(
        lines[0].plain_text(),
        "Error: Cannot find module '@codelia/logger'"
    );
}

#[test]
fn parse_runtime_output_keeps_non_error_runtime_lines_as_runtime() {
    let RuntimeMsg::LogLines(lines) = parse_runtime_output("[runtime] runtime started") else {
        panic!("unexpected runtime message");
    };
    assert_eq!(lines.len(), 1);
    assert_eq!(lines[0].kind(), LogKind::Runtime);
    assert_eq!(lines[0].plain_text(), "[runtime] runtime started");
}

#[test]
fn parse_run_status_error_is_rendered_as_error_line() {
    let payload = json!({
        "jsonrpc": "2.0",
        "method": "run.status",
        "params": {
            "status": "error",
            "message": "400 {\"type\":\"error\",\"error\":{\"message\":\"credit too low\"}}"
        }
    })
    .to_string();

    let RuntimeMsg::RunControl(RunControlMsg::Status {
        lines,
        run_error: None,
        ..
    }) = parse_runtime_output(&payload)
    else {
        panic!("unexpected runtime message");
    };
    assert_eq!(lines.len(), 1);
    assert_eq!(lines[0].kind(), LogKind::Error);
    assert!(lines[0].plain_text().contains("runtime status: error -"));
    assert!(lines[0].plain_text().contains("credit too low"));
}

#[test]
fn parse_run_diagnostics_llm_call_as_status_line() {
    let payload = json!({
            "jsonrpc": "2.0",
            "method": "run.diagnostics",
            "params": {
                "run_id": "run-1",
                "kind": "llm_call",
                "call": {
                    "run_id": "run-1",
                    "seq": 2,
                    "provider": "openai",
                    "model": "gpt-5-mini",
                    "request_ts": "2026-02-19T12:00:00.000Z",
                    "response_ts": "2026-02-19T12:00:00.321Z",
                    "latency_ms": 321,
                    "output_tokens_per_second": 93.5,
                    "stop_reason": "tool_use",
                    "usage": {
                        "input_tokens": 100,
                        "output_tokens": 30,
                        "total_tokens": 130,
                        "input_cached_tokens": 40,
                        "input_cache_creation_tokens": 0
                    },
                    "cache": {
                        "hit_state": "hit",
                        "cache_read_tokens": 40,
                        "cache_creation_tokens": 0
                    },
                    "provider_meta_summary": "transport=ws_mode websocket_mode=on chain_reset=true ws_input_mode=full_regenerated"
                }
            }
        })
        .to_string();
    let RuntimeMsg::LogLines(lines) = parse_runtime_output(&payload) else {
        panic!("unexpected runtime message");
    };
    assert_eq!(lines.len(), 1);
    assert_eq!(lines[0].kind(), LogKind::Status);
    let line = lines[0].plain_text();
    assert!(line.contains("diag llm#2 gpt-5-mini"));
    assert!(line.contains("tps=93.5"));
    assert!(line.contains("cache=hit read=40 (40.0%) create=0"));
    assert!(line.contains("meta=transport=ws_mode websocket_mode=on"));
    assert!(line.contains("ws_input_mode=full_regenerated"));
}

#[test]
fn parse_run_metrics_updates_status_without_transcript_lines() {
    for (rate, expected) in [
        (json!(42.25), Some(42.25)),
        (json!(null), None),
        (json!(-1), None),
    ] {
        let payload = json!({
            "method": "run.metrics", "params": {
                "run_id": "run-1", "seq": 2, "output_tokens_per_second": rate
            }
        })
        .to_string();
        let RuntimeMsg::RunControl(RunControlMsg::Metrics(metrics)) =
            parse_runtime_output(&payload)
        else {
            panic!("unexpected runtime message");
        };
        assert_eq!(metrics.run_id, "run-1");
        assert_eq!(metrics.output_tokens_per_second, expected);
    }
}

#[test]
fn parse_run_diagnostics_summary_as_status_line() {
    let payload = json!({
        "jsonrpc": "2.0",
        "method": "run.diagnostics",
        "params": {
            "run_id": "run-1",
            "kind": "run_summary",
            "summary": {
                "total_calls": 3,
                "total_tokens": 300,
                "total_input_tokens": 210,
                "total_output_tokens": 90,
                "total_cached_input_tokens": 50,
                "total_cache_creation_tokens": 10,
                "by_model": {}
            }
        }
    })
    .to_string();
    let RuntimeMsg::LogLines(lines) = parse_runtime_output(&payload) else {
        panic!("unexpected runtime message");
    };
    assert_eq!(lines.len(), 1);
    assert_eq!(lines[0].kind(), LogKind::Status);
    let line = lines[0].plain_text();
    assert!(line.contains("diag run total (cumulative)"));
    assert!(line.contains("calls=3"));
    assert!(line.contains("cache(read/create)=50/10 (23.8%)"));
    assert!(line.contains("calls(hit/miss/unknown)=0/0/3"));
}

#[test]
fn parse_compaction_start_event_as_running_line() {
    let payload = json!({
        "jsonrpc": "2.0",
        "method": "agent.event",
        "params": {
            "event": {
                "type": "compaction_start",
                "timestamp": 123
            }
        }
    })
    .to_string();
    let RuntimeMsg::Agent(AgentMsg::Compaction {
        lines,
        phase: super::CompactionPhase::Started,
    }) = parse_runtime_output(&payload)
    else {
        panic!("unexpected runtime message");
    };
    assert_eq!(lines.len(), 1);
    assert_eq!(lines[0].kind(), LogKind::Compaction);
    assert_eq!(lines[0].plain_text(), "Compaction: running");
}

#[test]
fn parse_llm_retry_event_as_visible_status_line() {
    let payload = json!({
        "jsonrpc": "2.0",
        "method": "agent.event",
        "params": {
            "event": {
                "type": "llm.retry",
                "provider": "moonshot",
                "failure_kind": "rate_limit",
                "next_attempt": 2,
                "max_attempts": 3,
                "delay_ms": 12_000,
                "delay_source": "provider-body",
                "status": 429
            }
        }
    })
    .to_string();
    let RuntimeMsg::Agent(AgentMsg::StreamReset { lines, .. }) = parse_runtime_output(&payload)
    else {
        panic!("unexpected runtime message");
    };
    assert_eq!(lines.len(), 1);
    assert_eq!(lines[0].kind(), LogKind::Status);
    assert_eq!(
        lines[0].plain_text(),
        "LLM retry: moonshot rate_limit in 12s (2/3)"
    );

    let replayed_payload = json!({
        "jsonrpc": "2.0",
        "method": "agent.event",
        "params": {
            "meta": { "replayed": true },
            "event": {
                "type": "llm.retry",
                "provider": "moonshot",
                "failure_kind": "rate_limit",
                "next_attempt": 2,
                "max_attempts": 3,
                "delay_ms": 12_000,
                "delay_source": "provider-body",
                "status": 429
            }
        }
    })
    .to_string();
    let RuntimeMsg::LogLines(replayed_lines) = parse_runtime_output(&replayed_payload) else {
        panic!("expected replayed llm.retry to parse as LogLines");
    };
    assert_eq!(replayed_lines.len(), 1);
    assert_eq!(
        replayed_lines[0].plain_text(),
        "LLM retry: moonshot rate_limit in 12s (2/3)"
    );
}

#[test]
fn provider_metadata_status_is_visible_without_assistant_history_or_raw_payloads() {
    for event in [
        json!({"type":"llm.status", "provider":"openai", "kind":"verification", "verification":"trusted_access_for_cyber", "metadata":"opaque-payload"}),
        json!({"type":"llm.status", "provider":"openai", "kind":"buffering", "active":true, "faster_model":"opaque-payload"}),
    ] {
        let RuntimeMsg::LogLines(lines) = parse_runtime_output(
            &json!({"method":"agent.event", "params":{"event":event}}).to_string(),
        ) else {
            panic!("unexpected runtime message");
        };
        assert_eq!(lines.len(), 1);
        assert_eq!(lines[0].kind(), LogKind::Status);
        assert!(!lines[0].plain_text().contains("opaque-payload"));
    }
    for event in [
        json!({"type":"llm.status", "provider":"openai", "kind":"buffering", "active":false}),
        json!({"type":"llm.status", "provider":"openai", "kind":"verification", "verification":"unknown"}),
        json!({"type":"llm.status", "provider":"anthropic", "kind":"buffering", "active":true}),
    ] {
        let parsed = parse_runtime_output(
            &json!({"method":"agent.event", "params":{"event":event}}).to_string(),
        );
        assert!(matches!(parsed, RuntimeMsg::Ignored));
    }
}

#[test]
fn parse_compaction_complete_event_as_compaction_line() {
    let payload_completed = json!({
        "jsonrpc": "2.0",
        "method": "agent.event",
        "params": {
            "event": {
                "type": "compaction_complete",
                "timestamp": 124,
                "compacted": true
            }
        }
    })
    .to_string();
    let RuntimeMsg::Agent(AgentMsg::Compaction {
        lines,
        phase: super::CompactionPhase::Completed,
    }) = parse_runtime_output(&payload_completed)
    else {
        panic!("unexpected runtime message");
    };
    assert_eq!(lines.len(), 1);
    assert_eq!(lines[0].kind(), LogKind::Compaction);
    assert_eq!(
        lines[0].plain_text(),
        "Compaction: completed (compacted=true)"
    );

    let payload_skipped = json!({
        "jsonrpc": "2.0",
        "method": "agent.event",
        "params": {
            "event": {
                "type": "compaction_complete",
                "timestamp": 125,
                "compacted": false
            }
        }
    })
    .to_string();
    let RuntimeMsg::Agent(AgentMsg::Compaction {
        lines,
        phase: super::CompactionPhase::Completed,
    }) = parse_runtime_output(&payload_skipped)
    else {
        panic!("unexpected runtime message");
    };
    assert_eq!(lines.len(), 1);
    assert_eq!(lines[0].kind(), LogKind::Compaction);
    assert_eq!(
        lines[0].plain_text(),
        "Compaction: skipped (compacted=false)"
    );
}

#[test]
fn lane_create_tool_call_is_summarized_without_seed_body() {
    let payload = json!({
        "jsonrpc": "2.0",
        "method": "agent.event",
        "params": {
            "event": {
                "type": "tool_call",
                "tool": "lane_create",
                "tool_call_id": "tool-1",
                "args": {
                    "task_id": "tui-diff-display-enhancement",
                    "mux_backend": "tmux",
                    "seed_context": "Very long initial text that should not be displayed in full"
                }
            }
        }
    })
    .to_string();
    let RuntimeMsg::Agent(AgentMsg::ToolCallStart { lines, .. }) = parse_runtime_output(&payload)
    else {
        panic!("unexpected runtime message");
    };
    assert_eq!(lines.len(), 1);
    let line = lines[0].plain_text();
    assert!(line.contains("LaneCreate:"));
    assert!(line.contains("task=tui-diff-display-enhancement"));
    assert!(line.contains("+seed"));
    assert!(!line.contains("Very long initial text"));
}

#[test]
fn web_search_tool_call_is_rendered_as_compact_summary() {
    let payload = json!({
        "jsonrpc": "2.0",
        "method": "agent.event",
        "params": {
            "event": {
                "type": "tool_call",
                "tool": "web_search",
                "tool_call_id": "ws-1",
                "args": {
                    "queries": ["latest ai news", "openai"],
                    "sources_count": 9
                }
            }
        }
    })
    .to_string();
    let RuntimeMsg::Agent(AgentMsg::ToolCallStart {
        tool_call_id,
        lines,
        ..
    }) = parse_runtime_output(&payload)
    else {
        panic!("unexpected runtime message");
    };
    assert_eq!(lines.len(), 1);
    assert_eq!(lines[0].plain_text(), "WebSearch: latest ai news | openai");
    assert_eq!(tool_call_id, "ws-1");
}

#[test]
fn webfetch_tool_call_is_rendered_as_compact_summary() {
    let payload = json!({
        "jsonrpc": "2.0",
        "method": "agent.event",
        "params": {
            "event": {
                "type": "tool_call",
                "tool": "webfetch",
                "tool_call_id": "wf-1",
                "args": {
                    "url": "https://example.com/docs/guide?full=1#overview",
                    "output_format": "markdown"
                }
            }
        }
    })
    .to_string();
    let RuntimeMsg::Agent(AgentMsg::ToolCallStart {
        tool_call_id,
        lines,
        ..
    }) = parse_runtime_output(&payload)
    else {
        panic!("unexpected runtime message");
    };
    assert_eq!(lines.len(), 1);
    assert_eq!(lines[0].plain_text(), "WebFetch: example.com/docs/guide");
    assert_eq!(tool_call_id, "wf-1");
}

#[test]
fn todo_patch_tool_call_is_rendered_as_compact_summary() {
    let payload = json!({
        "jsonrpc": "2.0",
        "method": "agent.event",
        "params": {
            "event": {
                "type": "tool_call",
                "tool": "todo_patch",
                "tool_call_id": "todo-c-1",
                "args": {
                    "updates": [
                        {
                            "id": "scope-design",
                            "notes": "Very long detail that should not be rendered inline",
                        }
                    ]
                }
            }
        }
    })
    .to_string();
    let RuntimeMsg::Agent(AgentMsg::ToolCallStart {
        tool_call_id,
        lines,
        ..
    }) = parse_runtime_output(&payload)
    else {
        panic!("unexpected runtime message");
    };
    assert_eq!(lines.len(), 1);
    let line = lines[0].plain_text();
    assert_eq!(line, "TODO: Patch 1 task(s)");
    assert!(!line.contains("scope-design"));
    assert!(!line.contains("notes"));
    assert_eq!(tool_call_id, "todo-c-1");
}

#[test]
fn todo_read_tool_call_is_rendered_as_compact_summary() {
    let payload = json!({
        "jsonrpc": "2.0",
        "method": "agent.event",
        "params": {
            "event": {
                "type": "tool_call",
                "tool": "todo_read",
                "tool_call_id": "todo-read-c-1",
                "args": {}
            }
        }
    })
    .to_string();
    let RuntimeMsg::Agent(AgentMsg::ToolCallStart {
        tool_call_id,
        lines,
        ..
    }) = parse_runtime_output(&payload)
    else {
        panic!("unexpected runtime message");
    };
    assert_eq!(lines.len(), 1);
    assert_eq!(lines[0].plain_text(), "TODO: Read plan");
    assert_eq!(tool_call_id, "todo-read-c-1");
}

#[test]
fn agents_resolve_tool_call_is_rendered_as_compact_summary() {
    let cwd = std::env::current_dir().expect("cwd");
    let target = cwd.join("packages/runtime/src/rpc/history.ts");
    let payload = json!({
        "jsonrpc": "2.0",
        "method": "agent.event",
        "params": {
            "event": {
                "type": "tool_call",
                "tool": "agents_resolve",
                "tool_call_id": "agents-call-1",
                "args": {
                    "path": target.to_string_lossy()
                }
            }
        }
    })
    .to_string();

    let RuntimeMsg::Agent(AgentMsg::ToolCallStart {
        tool_call_id,
        lines,
        ..
    }) = parse_runtime_output(&payload)
    else {
        panic!("unexpected runtime message");
    };
    assert_eq!(lines.len(), 1);
    assert_eq!(
        lines[0].plain_text(),
        "AgentsResolve: packages/runtime/src/rpc/history.ts"
    );
    assert_eq!(tool_call_id, "agents-call-1");
}

#[test]
fn todo_split_tool_calls_report_action_specific_modes() {
    let new_payload = json!({
        "jsonrpc": "2.0",
        "method": "agent.event",
        "params": {
            "event": {
                "type": "tool_call",
                "tool": "todo_new",
                "tool_call_id": "todo-c-2",
                "args": {
                    "todos": [{"id": "a"}, {"id": "b"}]
                }
            }
        }
    })
    .to_string();
    let RuntimeMsg::Agent(AgentMsg::ToolCallStart { lines, .. }) =
        parse_runtime_output(&new_payload)
    else {
        panic!("unexpected runtime message");
    };
    assert_eq!(lines.len(), 1);
    assert_eq!(lines[0].plain_text(), "TODO: Set 2 task(s)");

    let append_payload = json!({
        "jsonrpc": "2.0",
        "method": "agent.event",
        "params": {
            "event": {
                "type": "tool_call",
                "tool": "todo_append",
                "tool_call_id": "todo-c-append",
                "args": {
                    "todos": [{"id": "c"}]
                }
            }
        }
    })
    .to_string();
    let RuntimeMsg::Agent(AgentMsg::ToolCallStart { lines, .. }) =
        parse_runtime_output(&append_payload)
    else {
        panic!("unexpected runtime message");
    };
    assert_eq!(lines.len(), 1);
    assert_eq!(lines[0].plain_text(), "TODO: Append 1 task(s)");

    let clear_payload = json!({
        "jsonrpc": "2.0",
        "method": "agent.event",
        "params": {
            "event": {
                "type": "tool_call",
                "tool": "todo_clear",
                "tool_call_id": "todo-c-3",
                "args": {}
            }
        }
    })
    .to_string();
    let RuntimeMsg::Agent(AgentMsg::ToolCallStart { lines, .. }) =
        parse_runtime_output(&clear_payload)
    else {
        panic!("unexpected runtime message");
    };
    assert_eq!(lines.len(), 1);
    assert_eq!(lines[0].plain_text(), "TODO: Clear tasks");
}

#[test]
fn web_search_tool_result_uses_single_summary_line() {
    let payload = json!({
        "jsonrpc": "2.0",
        "method": "agent.event",
        "params": {
            "event": {
                "type": "tool_result",
                "tool": "web_search",
                "tool_call_id": "ws-1",
                "is_error": false,
                "result": "WebSearch status=completed | queries=latest ai news | openai | sources=9"
            }
        }
    })
    .to_string();
    let RuntimeMsg::Agent(AgentMsg::ToolCallResult { update, lines, .. }) =
        parse_runtime_output(&payload)
    else {
        panic!("unexpected runtime message");
    };
    assert!(lines.is_empty());
    assert_eq!(update.tool_call_id, "ws-1");
    assert_eq!(
        update.fallback_summary.plain_text(),
        "✔ WebSearch: latest ai news | openai"
    );
}

#[test]
fn webfetch_tool_result_uses_single_summary_line() {
    let payload = json!({
        "jsonrpc": "2.0",
        "method": "agent.event",
        "params": {
            "event": {
                "type": "tool_result",
                "tool": "webfetch",
                "tool_call_id": "wf-1",
                "is_error": false,
                "result": {
                    "url": "https://example.com/start",
                    "final_url": "https://example.com/docs/guide?full=1#overview",
                    "status": 200,
                    "output_format": "markdown",
                    "content": "# Hello\n\nLong body omitted",
                    "byte_size": 2048,
                    "duration_ms": 182,
                    "truncated": true
                }
            }
        }
    })
    .to_string();
    let RuntimeMsg::Agent(AgentMsg::ToolCallResult { update, lines, .. }) =
        parse_runtime_output(&payload)
    else {
        panic!("unexpected runtime message");
    };
    assert!(lines.is_empty());
    assert_eq!(update.tool_call_id, "wf-1");
    assert_eq!(
        update.fallback_summary.plain_text(),
        "✔ WebFetch: example.com/docs/guide (2 KB, 182 ms, truncated)"
    );
}

#[test]
fn lane_create_tool_result_shows_compact_hints() {
    let payload = json!({
            "jsonrpc": "2.0",
            "method": "agent.event",
            "params": {
                "event": {
                    "type": "tool_result",
                    "tool": "lane_create",
                    "tool_call_id": "tool-1",
                    "is_error": false,
                    "result": {
                        "ok": true,
                        "lane": {
                            "lane_id": "bf5735ae-58c9-4a7e-af6f-25f7f97e1b7e",
                            "task_id": "tui-diff-display-enhancement",
                            "state": "running",
                            "worktree_path": "/home/user/project/.codelia/worktrees/tui-diff-display-enhancement-bf5735ae"
                        },
                        "hints": {
                            "attach_command": "tmux attach -t 'codelia-lane-bf5735ae'"
                        }
                    }
                }
            }
        })
        .to_string();
    let RuntimeMsg::Agent(AgentMsg::ToolCallResult { lines, .. }) = parse_runtime_output(&payload)
    else {
        panic!("unexpected runtime message");
    };
    let texts = lines.iter().map(LogLine::plain_text).collect::<Vec<_>>();
    assert!(texts.iter().any(|line| line.contains("lane: bf5735ae")));
    assert!(texts
        .iter()
        .any(|line| line.contains("task: tui-diff-display-enhancement")));
    assert!(texts.iter().any(|line| line.contains("state: running")));
    assert!(texts
        .iter()
        .any(|line| line.contains("attach: tmux attach -t")));
    assert!(!texts.iter().any(|line| line.contains("\"ok\":true")));
}

#[test]
fn agents_resolve_tool_result_shows_compact_summary_and_details() {
    let cwd = std::env::current_dir().expect("cwd");
    let target = cwd.join("packages/runtime/src/rpc/history.ts");
    let agents_file = cwd.join("packages/runtime/AGENTS.md");
    let payload = json!({
        "jsonrpc": "2.0",
        "method": "agent.event",
        "params": {
            "event": {
                "type": "tool_result",
                "tool": "agents_resolve",
                "tool_call_id": "agents-result-1",
                "is_error": false,
                "result": {
                    "target_path": target.to_string_lossy(),
                    "resolved_path": target.to_string_lossy(),
                    "count": 1,
                    "files": [
                        {
                            "path": agents_file.to_string_lossy(),
                            "mtime_ms": 1772638723215u64,
                            "size_bytes": 15813u64,
                            "reason": "new"
                        }
                    ]
                }
            }
        }
    })
    .to_string();

    let RuntimeMsg::Agent(AgentMsg::ToolCallResult { update, lines, .. }) =
        parse_runtime_output(&payload)
    else {
        panic!("unexpected runtime message");
    };
    assert_eq!(update.tool_call_id, "agents-result-1");
    assert_eq!(
        update.fallback_summary.plain_text(),
        "✔ AgentsResolve: 1 file(s)"
    );

    let texts = lines.iter().map(LogLine::plain_text).collect::<Vec<_>>();
    assert!(texts
        .iter()
        .any(|line| line.contains("target: packages/runtime/src/rpc/history.ts")));
    assert!(texts
        .iter()
        .any(|line| line.contains("AGENTS: packages/runtime/AGENTS.md (new)")));
    assert!(!texts.iter().any(|line| line.contains("\"mtime_ms\"")));
}

#[test]
fn todo_patch_tool_result_surfaces_task_list_when_available() {
    let payload = json!({
            "jsonrpc": "2.0",
            "method": "agent.event",
            "params": {
                "event": {
                    "type": "tool_result",
                    "tool": "todo_patch",
                    "tool_call_id": "todo-w-1",
                    "is_error": false,
                    "result": "Updated todos (patch): 2 pending, 1 in progress, 0 completed. Next: [plan].\nTodo plan:\n1. [>] [plan] (p1) Planning\n2. [ ] [test] (p2) Add tests\nSummary: 1 pending, 1 in progress, 0 completed\nNext: [plan]"
                }
            }
        })
        .to_string();
    let RuntimeMsg::Agent(AgentMsg::ToolCallResult { update, lines, .. }) =
        parse_runtime_output(&payload)
    else {
        panic!("unexpected runtime message");
    };
    assert_eq!(update.tool_call_id, "todo-w-1");
    assert!(update
        .fallback_summary
        .plain_text()
        .contains("TODO: Updated 2 pending, 1 in progress, 0 completed"));
    assert!(lines
        .iter()
        .any(|line| line.plain_text().contains("1. [>] [plan]")));
    assert!(lines
        .iter()
        .all(|line| !line.plain_text().contains("note:")));
}

#[test]
fn todo_read_tool_result_surfaces_task_list_without_notes() {
    let payload = json!({
            "jsonrpc": "2.0",
            "method": "agent.event",
            "params": {
                "event": {
                    "type": "tool_result",
                    "tool": "todo_read",
                    "tool_call_id": "todo-r-1",
                    "is_error": false,
                    "result": "Todo plan:\n1. [>] [plan] (p1) Planning\n   note: currently executing\n2. [ ] [test] (p2) Add tests\n3. [x] [ship] (p3) Ship\nSummary: 1 pending, 1 in progress, 1 completed\nNext: [plan]"
                }
            }
        })
        .to_string();
    let RuntimeMsg::Agent(AgentMsg::ToolCallResult { update, lines, .. }) =
        parse_runtime_output(&payload)
    else {
        panic!("unexpected runtime message");
    };
    assert_eq!(update.tool_call_id, "todo-r-1");
    assert!(update
        .fallback_summary
        .plain_text()
        .contains("TODO: 1 pending, 1 in progress, 1 completed"));

    let in_progress_line = lines
        .iter()
        .find(|line| line.plain_text().contains("1. [>] [plan]"))
        .expect("in-progress todo line");
    assert_eq!(in_progress_line.kind(), LogKind::TodoInProgress);

    let completed_line = lines
        .iter()
        .find(|line| line.plain_text().contains("3. [x] [ship]"))
        .expect("completed todo line");
    assert_eq!(completed_line.kind(), LogKind::TodoCompleted);

    assert!(lines
        .iter()
        .any(|line| line.plain_text().contains("Next: [plan]")));
    assert!(lines
        .iter()
        .all(|line| !line.plain_text().contains("note: currently executing")));
}

#[test]
fn todo_patch_failed_text_is_classified_as_error() {
    let payload = json!({
        "jsonrpc": "2.0",
        "method": "agent.event",
        "params": {
            "event": {
                "type": "tool_result",
                "tool": "todo_patch",
                "tool_call_id": "todo-w-err-1",
                "is_error": false,
                "result": "Patch failed: unknown todo id(s): missing-task"
            }
        }
    })
    .to_string();

    let RuntimeMsg::Agent(AgentMsg::ToolCallResult { update, lines, .. }) =
        parse_runtime_output(&payload)
    else {
        panic!("unexpected runtime message");
    };
    assert!(update.is_error);
    assert_eq!(update.tool_call_id, "todo-w-err-1");
    assert!(update
        .fallback_summary
        .plain_text()
        .contains("TODO: Patch failed - unknown todo id(s): missing-task"));
    assert!(lines.is_empty());
}

#[test]
fn todo_patch_validation_failure_is_summarized_with_actionable_text() {
    let payload = json!({
            "jsonrpc": "2.0",
            "method": "agent.event",
            "params": {
                "event": {
                    "type": "tool_result",
                    "tool": "todo_patch",
                    "tool_call_id": "todo-w-err-2",
                    "is_error": false,
                    "result": "Error: Tool input validation failed for todo_patch: Unrecognized key(s) in object: 'todos'"
                }
            }
        })
        .to_string();

    let RuntimeMsg::Agent(AgentMsg::ToolCallResult { update, lines, .. }) =
        parse_runtime_output(&payload)
    else {
        panic!("unexpected runtime message");
    };
    assert!(update.is_error);
    assert_eq!(update.tool_call_id, "todo-w-err-2");
    assert_eq!(
        update.fallback_summary.plain_text(),
        "✖ TODO: Invalid patch request - use updates, not todos"
    );
    assert!(lines.is_empty());
}

#[test]
fn todo_tool_results_hide_raw_json_payloads() {
    let payload = json!({
        "jsonrpc": "2.0",
        "method": "agent.event",
        "params": {
            "event": {
                "type": "tool_result",
                "tool": "todo_read",
                "tool_call_id": "todo-r-json-1",
                "is_error": false,
                "result": {
                    "debug": true,
                    "items": [
                        { "id": "plan", "status": "in_progress" }
                    ]
                }
            }
        }
    })
    .to_string();

    let RuntimeMsg::Agent(AgentMsg::ToolCallResult { update, lines, .. }) =
        parse_runtime_output(&payload)
    else {
        panic!("unexpected runtime message");
    };
    let summary = update.fallback_summary.plain_text();
    assert!(!summary.contains("\"debug\""));
    assert!(!summary.contains("\"items\""));
    assert!(lines.is_empty());
}

#[test]
fn shell_tool_call_is_rendered_as_compact_summary() {
    let payload = json!({
        "jsonrpc": "2.0",
        "method": "agent.event",
        "params": {
            "event": {
                "type": "tool_call",
                "tool": "shell",
                "tool_call_id": "shell-call-1",
                "args": {
                    "command": "git status --short",
                    "detached_wait": true
                }
            }
        }
    })
    .to_string();
    let RuntimeMsg::Agent(AgentMsg::ToolCallStart {
        tool_call_id,
        lines,
        ..
    }) = parse_runtime_output(&payload)
    else {
        panic!("unexpected runtime message");
    };
    assert_eq!(lines.len(), 1);
    assert_eq!(
        lines[0].plain_text(),
        "Shell: git status --short (detached wait)"
    );
    assert_eq!(tool_call_id, "shell-call-1");
}

#[test]
fn shell_list_tool_call_is_rendered_as_compact_summary() {
    let payload = json!({
        "jsonrpc": "2.0",
        "method": "agent.event",
        "params": {
            "event": {
                "type": "tool_call",
                "tool": "shell_list",
                "tool_call_id": "shell-list-call-1",
                "args": {
                    "include_terminal": true,
                    "limit": 10,
                    "state": "cancelled"
                }
            }
        }
    })
    .to_string();
    let RuntimeMsg::Agent(AgentMsg::ToolCallStart {
        tool_call_id,
        lines,
        ..
    }) = parse_runtime_output(&payload)
    else {
        panic!("unexpected runtime message");
    };
    assert_eq!(lines.len(), 1);
    assert_eq!(
        lines[0].plain_text(),
        "ShellList: state=cancelled include_terminal=true limit=10"
    );
    assert_eq!(tool_call_id, "shell-list-call-1");
}

#[test]
fn apply_patch_tool_call_is_rendered_as_compact_summary() {
    let payload = json!({
            "jsonrpc": "2.0",
            "method": "agent.event",
            "params": {
                "event": {
                    "type": "tool_call",
                    "tool": "apply_patch",
                    "tool_call_id": "apply-patch-call-1",
                    "args": {
                        "patch": "*** Begin Patch\n*** Update File: demo.txt\n@@\n-old\n+new\n*** End Patch",
                        "dry_run": true
                    }
                }
            }
        })
        .to_string();
    let RuntimeMsg::Agent(AgentMsg::ToolCallStart {
        tool_call_id,
        lines,
        ..
    }) = parse_runtime_output(&payload)
    else {
        panic!("unexpected runtime message");
    };
    assert_eq!(lines.len(), 1);
    assert_eq!(lines[0].plain_text(), "ApplyPatch: 1 file(s) (preview)");
    assert_eq!(tool_call_id, "apply-patch-call-1");
}

#[test]
fn shell_list_tool_result_is_compact_and_muted() {
    let payload = json!({
        "jsonrpc": "2.0",
        "method": "agent.event",
        "params": {
            "event": {
                "type": "tool_result",
                "tool": "shell_list",
                "tool_call_id": "shell-list-result-1",
                "is_error": false,
                "result": {
                    "tasks": [
                        {
                            "key": "build-1234abcd",
                            "label": "build",
                            "command": "bun run typecheck",
                            "state": "running"
                        },
                        {
                            "key": "timeout-bg-97a7a185",
                            "label": "timeout-bg",
                            "command": "bash -lc 'echo timeout-start; sleep 5; echo timeout-end'",
                            "state": "failed",
                            "failure_message": "Command timed out after 2s"
                        }
                    ],
                    "returned": 2,
                    "limit": 10,
                    "state": null,
                    "include_terminal": true
                }
            }
        }
    })
    .to_string();
    let RuntimeMsg::Agent(AgentMsg::ToolCallResult { update, lines, .. }) =
        parse_runtime_output(&payload)
    else {
        panic!("unexpected runtime message");
    };
    assert_eq!(update.tool_call_id, "shell-list-result-1");
    assert_eq!(
        update.fallback_summary.plain_text(),
        "ShellList: 2 task(s), running=1"
    );
    assert_eq!(update.fallback_summary.kind(), LogKind::Shell);
    let texts = lines.iter().map(LogLine::plain_text).collect::<Vec<_>>();
    assert_eq!(
            texts,
            vec![
                "  running | build-1234abcd | build | bun run typecheck".to_string(),
                "  failed | timeout-bg-97a7a185 | timeout-bg | bash -lc 'echo timeout-start; sleep 5; echo timeout-end'".to_string(),
            ]
        );
    assert!(lines.iter().all(|line| line.kind() == LogKind::Shell));
}

#[test]
fn shell_tool_result_shows_compact_summary_and_stdout_without_raw_json() {
    let payload = json!({
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
						"stdout": " M crates/tui/src/app/runtime/parser.rs\n?? crates/tui/src/app/runtime/parser/helpers.rs"
                    }
                }
            }
        })
        .to_string();
    let RuntimeMsg::Agent(AgentMsg::ToolCallResult { update, lines, .. }) =
        parse_runtime_output(&payload)
    else {
        panic!("unexpected runtime message");
    };
    assert_eq!(update.tool_call_id, "shell-result-1");
    assert_eq!(
        update.fallback_summary.plain_text(),
        "✔ Shell: git status --short (12 ms)"
    );
    assert_eq!(update.fallback_summary.kind(), LogKind::Shell);
    let texts = lines.iter().map(LogLine::plain_text).collect::<Vec<_>>();
    assert_eq!(
        texts,
        vec![
            "   M crates/tui/src/app/runtime/parser.rs".to_string(),
            "  ?? crates/tui/src/app/runtime/parser/helpers.rs".to_string(),
        ]
    );
    assert!(lines.iter().all(|line| line.kind() == LogKind::Shell));
}

#[test]
fn shell_tool_result_marks_failed_command_as_error() {
    let payload = json!({
        "jsonrpc": "2.0",
        "method": "agent.event",
        "params": {
            "event": {
                "type": "tool_result",
                "tool": "shell",
                "tool_call_id": "shell-result-fail-1",
                "is_error": false,
                "result": {
                    "key": "shell-fail-1",
                    "command": "bun run typecheck",
                    "state": "failed",
                    "exit_code": 2,
                    "failure_message": "Command failed with exit code 2",
                    "stderr": "$ bun run typecheck\n@codelia/runtime typecheck: Exited with code 2"
                }
            }
        }
    })
    .to_string();
    let RuntimeMsg::Agent(AgentMsg::ToolCallResult { update, lines, .. }) =
        parse_runtime_output(&payload)
    else {
        panic!("unexpected runtime message");
    };
    assert_eq!(update.tool_call_id, "shell-result-fail-1");
    assert!(update.is_error);
    assert_eq!(
        update.fallback_summary.plain_text(),
        "✖ Shell failed - bun run typecheck"
    );
    assert_eq!(update.fallback_summary.kind(), LogKind::Error);
    let texts = lines.iter().map(LogLine::plain_text).collect::<Vec<_>>();
    assert_eq!(
        texts,
        vec![
            "  Exit code: 2".to_string(),
            "  Failure: Command failed with exit code 2".to_string(),
            "  Stderr:".to_string(),
            "  $ bun run typecheck".to_string(),
            "  @codelia/runtime typecheck: Exited with code 2".to_string(),
        ]
    );
    assert!(lines.iter().all(|line| line.kind() == LogKind::Error));
}

#[test]
fn shell_status_tool_result_is_compact() {
    let payload = json!({
        "jsonrpc": "2.0",
        "method": "agent.event",
        "params": {
            "event": {
                "type": "tool_result",
                "tool": "shell_status",
                "tool_call_id": "shell-status-1",
                "is_error": false,
                "result": {
                    "key": "build-1234abcd",
                    "command": "npm run dev",
                    "state": "running"
                }
            }
        }
    })
    .to_string();
    let RuntimeMsg::Agent(AgentMsg::ToolCallResult { update, lines, .. }) =
        parse_runtime_output(&payload)
    else {
        panic!("unexpected runtime message");
    };
    assert_eq!(update.tool_call_id, "shell-status-1");
    assert_eq!(
        update.fallback_summary.plain_text(),
        "✔ Shell status: running - npm run dev"
    );
    assert_eq!(update.fallback_summary.kind(), LogKind::Shell);
    let texts = lines.iter().map(LogLine::plain_text).collect::<Vec<_>>();
    assert_eq!(
        texts,
        vec![
            "  Key: build-1234abcd".to_string(),
            "  State: running".to_string(),
        ]
    );
}

#[test]
fn shell_logs_tool_result_surfaces_body_without_json_wrapper() {
    let payload = json!({
        "jsonrpc": "2.0",
        "method": "agent.event",
        "params": {
            "event": {
                "type": "tool_result",
                "tool": "shell_logs",
                "tool_call_id": "shell-logs-1",
                "is_error": false,
                "result": {
                    "task_id": "shell-task-3",
                    "stream": "stdout",
                    "live": false,
                    "cache_id": "cache-123",
                    "content": "line-1\nline-2"
                }
            }
        }
    })
    .to_string();
    let RuntimeMsg::Agent(AgentMsg::ToolCallResult { update, lines, .. }) =
        parse_runtime_output(&payload)
    else {
        panic!("unexpected runtime message");
    };
    assert_eq!(update.tool_call_id, "shell-logs-1");
    assert_eq!(
        update.fallback_summary.plain_text(),
        "✔ Shell logs: stdout (cached)"
    );
    let texts = lines.iter().map(LogLine::plain_text).collect::<Vec<_>>();
    assert_eq!(texts, vec!["  line-1".to_string(), "  line-2".to_string()]);
    assert_eq!(update.fallback_summary.kind(), LogKind::Shell);
    assert!(lines.iter().all(|line| line.kind() == LogKind::Shell));
}

#[test]
fn shell_wait_tool_result_is_compact() {
    let payload = json!({
        "jsonrpc": "2.0",
        "method": "agent.event",
        "params": {
            "event": {
                "type": "tool_result",
                "tool": "shell_wait",
                "tool_call_id": "shell-wait-1",
                "is_error": false,
                "result": {
                    "key": "shell-wait-1",
                    "command": "npm test",
                    "state": "completed",
                    "exit_code": 0,
                    "duration_ms": 245
                }
            }
        }
    })
    .to_string();
    let RuntimeMsg::Agent(AgentMsg::ToolCallResult { update, lines, .. }) =
        parse_runtime_output(&payload)
    else {
        panic!("unexpected runtime message");
    };
    assert_eq!(update.tool_call_id, "shell-wait-1");
    assert_eq!(
        update.fallback_summary.plain_text(),
        "✔ Shell wait: completed - npm test (245 ms)"
    );
    assert_eq!(update.fallback_summary.kind(), LogKind::Shell);
    let texts = lines.iter().map(LogLine::plain_text).collect::<Vec<_>>();
    assert!(texts.is_empty());
}

#[test]
fn shell_wait_tool_result_preserves_failed_state() {
    let payload = json!({
        "jsonrpc": "2.0",
        "method": "agent.event",
        "params": {
            "event": {
                "type": "tool_result",
                "tool": "shell_wait",
                "tool_call_id": "shell-wait-fail-1",
                "is_error": false,
                "result": {
                    "key": "shell-wait-fail-1",
                    "command": "npm test",
                    "state": "failed",
                    "exit_code": 7
                }
            }
        }
    })
    .to_string();
    let RuntimeMsg::Agent(AgentMsg::ToolCallResult { update, lines, .. }) =
        parse_runtime_output(&payload)
    else {
        panic!("unexpected runtime message");
    };
    assert_eq!(update.tool_call_id, "shell-wait-fail-1");
    assert!(update.is_error);
    assert_eq!(
        update.fallback_summary.plain_text(),
        "✖ Shell wait: failed - npm test"
    );
    assert_eq!(update.fallback_summary.kind(), LogKind::Error);
    let texts = lines.iter().map(LogLine::plain_text).collect::<Vec<_>>();
    assert_eq!(
        texts,
        vec!["  State: failed".to_string(), "  Exit code: 7".to_string(),]
    );
    assert!(lines.iter().all(|line| line.kind() == LogKind::Error));
}

#[test]
fn shell_wait_tool_result_marks_still_running_compactly() {
    let payload = json!({
        "jsonrpc": "2.0",
        "method": "agent.event",
        "params": {
            "event": {
                "type": "tool_result",
                "tool": "shell_wait",
                "tool_call_id": "shell-wait-2",
                "is_error": false,
                "result": {
                    "key": "shell-wait-2",
                    "command": "npm test",
                    "state": "running",
                    "still_running": true
                }
            }
        }
    })
    .to_string();
    let RuntimeMsg::Agent(AgentMsg::ToolCallResult { update, lines, .. }) =
        parse_runtime_output(&payload)
    else {
        panic!("unexpected runtime message");
    };
    assert_eq!(update.tool_call_id, "shell-wait-2");
    assert_eq!(
        update.fallback_summary.plain_text(),
        "✔ Shell wait: still running - npm test"
    );
    assert_eq!(update.fallback_summary.kind(), LogKind::Shell);
    let texts = lines.iter().map(LogLine::plain_text).collect::<Vec<_>>();
    assert_eq!(texts, vec!["  State: running".to_string()]);
}

#[test]
fn shell_result_tool_result_surfaces_final_output_without_json_wrapper() {
    let payload = json!({
        "jsonrpc": "2.0",
        "method": "agent.event",
        "params": {
            "event": {
                "type": "tool_result",
                "tool": "shell_result",
                "tool_call_id": "shell-final-1",
                "is_error": false,
                "result": {
                    "key": "shell-final-1",
                    "command": "npm test",
                    "state": "completed",
                    "exit_code": 0,
                        "stdout": "tests passed"
                }
            }
        }
    })
    .to_string();
    let RuntimeMsg::Agent(AgentMsg::ToolCallResult { update, lines, .. }) =
        parse_runtime_output(&payload)
    else {
        panic!("unexpected runtime message");
    };
    assert_eq!(update.tool_call_id, "shell-final-1");
    assert_eq!(
        update.fallback_summary.plain_text(),
        "✔ Shell result: completed - npm test"
    );
    assert_eq!(update.fallback_summary.kind(), LogKind::Shell);
    let texts = lines.iter().map(LogLine::plain_text).collect::<Vec<_>>();
    assert_eq!(texts, vec!["  tests passed".to_string(),]);
    assert!(lines.iter().all(|line| line.kind() == LogKind::Shell));
}

#[test]
fn shell_result_tool_result_preserves_failed_state() {
    let payload = json!({
        "jsonrpc": "2.0",
        "method": "agent.event",
        "params": {
            "event": {
                "type": "tool_result",
                "tool": "shell_result",
                "tool_call_id": "shell-final-fail-1",
                "is_error": false,
                "result": {
                    "key": "shell-final-fail-1",
                    "command": "npm test",
                    "state": "failed",
                    "exit_code": 7
                }
            }
        }
    })
    .to_string();
    let RuntimeMsg::Agent(AgentMsg::ToolCallResult { update, lines, .. }) =
        parse_runtime_output(&payload)
    else {
        panic!("unexpected runtime message");
    };
    assert_eq!(update.tool_call_id, "shell-final-fail-1");
    assert!(update.is_error);
    assert_eq!(
        update.fallback_summary.plain_text(),
        "✖ Shell result: failed - npm test"
    );
    assert_eq!(update.fallback_summary.kind(), LogKind::Error);
    let texts = lines.iter().map(LogLine::plain_text).collect::<Vec<_>>();
    assert_eq!(texts, vec!["  Exit code: 7".to_string(),]);
    assert!(lines.iter().all(|line| line.kind() == LogKind::Error));
}

#[test]
fn shell_result_tool_result_keeps_full_log_prefix_inside_output() {
    let payload = json!({
        "jsonrpc": "2.0",
        "method": "agent.event",
        "params": {
            "event": {
                "type": "tool_result",
                "tool": "shell_result",
                "tool_call_id": "shell-final-full-log-1",
                "is_error": false,
                "result": {
                    "key": "shell-final-full-log-1",
                    "command": "npm test",
                    "state": "completed",
                    "exit_code": 0,
                        "stdout": "Full log: still command output\nnext line"
                }
            }
        }
    })
    .to_string();
    let RuntimeMsg::Agent(AgentMsg::ToolCallResult { update, lines, .. }) =
        parse_runtime_output(&payload)
    else {
        panic!("unexpected runtime message");
    };
    assert_eq!(update.tool_call_id, "shell-final-full-log-1");
    let texts = lines.iter().map(LogLine::plain_text).collect::<Vec<_>>();
    assert_eq!(
        texts,
        vec![
            "  Full log: still command output".to_string(),
            "  next line".to_string(),
        ]
    );
}

#[test]
fn shell_result_tool_preview_uses_head_tail_truncation() {
    let stdout = (1..=12)
        .map(|idx| format!("line-{idx}"))
        .collect::<Vec<_>>()
        .join("\n");
    let payload = json!({
        "jsonrpc": "2.0",
        "method": "agent.event",
        "params": {
            "event": {
                "type": "tool_result",
                "tool": "shell_result",
                "tool_call_id": "shell-final-truncated-1",
                "is_error": false,
                "result": {
                    "key": "shell-final-truncated-1",
                    "command": "npm test",
                    "state": "completed",
                    "exit_code": 0,
                        "stdout": stdout
                }
            }
        }
    })
    .to_string();
    let RuntimeMsg::Agent(AgentMsg::ToolCallResult { update, lines, .. }) =
        parse_runtime_output(&payload)
    else {
        panic!("unexpected runtime message");
    };
    assert_eq!(update.tool_call_id, "shell-final-truncated-1");
    assert_eq!(update.fallback_summary.kind(), LogKind::Shell);
    let texts = lines.iter().map(LogLine::plain_text).collect::<Vec<_>>();
    assert_eq!(
        texts,
        vec![
            "  line-1".to_string(),
            "  line-2".to_string(),
            "  line-3".to_string(),
            "  ... (7 line(s) omitted) ...".to_string(),
            "  line-11".to_string(),
            "  line-12".to_string(),
        ]
    );
}

#[test]
fn shell_cancel_tool_result_is_compact() {
    let payload = json!({
        "jsonrpc": "2.0",
        "method": "agent.event",
        "params": {
            "event": {
                "type": "tool_result",
                "tool": "shell_cancel",
                "tool_call_id": "shell-cancel-1",
                "is_error": false,
                "result": {
                    "key": "shell-cancel-1",
                    "command": "npm run dev",
                    "state": "cancelled",
                    "cancellation_reason": "cancelled"
                }
            }
        }
    })
    .to_string();
    let RuntimeMsg::Agent(AgentMsg::ToolCallResult { update, lines, .. }) =
        parse_runtime_output(&payload)
    else {
        panic!("unexpected runtime message");
    };
    assert_eq!(update.tool_call_id, "shell-cancel-1");
    assert!(update.is_error);
    assert_eq!(
        update.fallback_summary.plain_text(),
        "✖ Shell cancelled - npm run dev"
    );
    assert_eq!(update.fallback_summary.kind(), LogKind::Error);
    let texts = lines.iter().map(LogLine::plain_text).collect::<Vec<_>>();
    assert_eq!(
        texts,
        vec![
            "  Key: shell-cancel-1".to_string(),
            "  State: cancelled".to_string(),
            "  Cancellation: cancelled".to_string(),
        ]
    );
    assert!(lines.iter().all(|line| line.kind() == LogKind::Error));
}

#[test]
fn parse_runtime_output_formats_edit_tool_result_with_diff_body() {
    let raw = r#"{"method":"agent.event","params":{"event":{"type":"tool_result","tool":"edit","result":{"summary":"updated file","diff":"--- a/demo.txt\n+++ b/demo.txt\n@@ -1,2 +1,2 @@\n-old line\n+new line\n context line"}}}}"#;
    let RuntimeMsg::Agent(AgentMsg::ToolCallResult { update, lines, .. }) =
        parse_runtime_output(raw)
    else {
        panic!("unexpected runtime message");
    };

    // The summary row replaces the pending tool call row.
    let summary = update.fallback_summary;
    assert_eq!(summary.kind(), LogKind::ToolResult);
    assert!(summary.plain_text().contains("edit updated file"));
    assert!(lines
        .iter()
        .any(|line| line.plain_text().contains("- old line")));
    assert!(lines
        .iter()
        .any(|line| line.plain_text().contains("+ new line")));
}

#[test]
fn parse_runtime_output_formats_write_tool_result_with_diff_body() {
    let raw = r#"{"method":"agent.event","params":{"event":{"type":"tool_result","tool":"write","result":{"summary":"Wrote 42 bytes to demo.txt","diff":"--- /dev/null\n+++ demo.txt\n@@ -0,0 +1,2 @@\n+hello\n+world","file_path":"demo.txt"}}}}"#;
    let RuntimeMsg::Agent(AgentMsg::ToolCallResult { update, lines, .. }) =
        parse_runtime_output(raw)
    else {
        panic!("unexpected runtime message");
    };

    let summary = update.fallback_summary;
    assert_eq!(summary.kind(), LogKind::ToolResult);
    assert!(summary
        .plain_text()
        .contains("write Wrote 42 bytes to demo.txt"));
    assert!(lines
        .iter()
        .any(|line| line.plain_text().contains("+ hello")));
    assert!(lines
        .iter()
        .any(|line| line.plain_text().contains("+ world")));
}

#[test]
fn parse_runtime_output_formats_apply_patch_tool_result_with_diff_body() {
    let raw = r#"{"method":"agent.event","params":{"event":{"type":"tool_result","tool":"apply_patch","result":{"summary":"Applied patch to 1 file(s)","diff":"--- a/demo.txt\n+++ b/demo.txt\n@@ -1 +1 @@\n-old line\n+new line"}}}}"#;
    let RuntimeMsg::Agent(AgentMsg::ToolCallResult { update, lines, .. }) =
        parse_runtime_output(raw)
    else {
        panic!("unexpected runtime message");
    };

    let summary = update.fallback_summary;
    assert_eq!(summary.kind(), LogKind::ToolResult);
    assert!(summary
        .plain_text()
        .contains("apply_patch Applied patch to 1 file(s)"));
    assert!(lines
        .iter()
        .any(|line| line.plain_text().contains("- old line")));
    assert!(lines
        .iter()
        .any(|line| line.plain_text().contains("+ new line")));
}

#[test]
fn parse_runtime_output_write_diff_uses_write_specific_truncation_limit() {
    let mut diff = String::from("--- /dev/null\n+++ demo.txt\n@@ -0,0 +1,40 @@\n");
    for idx in 1..=40 {
        diff.push_str(&format!("+line {idx:02}\n"));
    }
    let raw = serde_json::json!({
        "method": "agent.event",
        "params": {
            "event": {
                "type": "tool_result",
                "tool": "write",
                "result": {
                    "summary": "Wrote",
                    "diff": diff,
                    "file_path": "demo.txt"
                }
            }
        }
    })
    .to_string();
    let RuntimeMsg::Agent(AgentMsg::ToolCallResult { lines, .. }) = parse_runtime_output(&raw)
    else {
        panic!("unexpected runtime message");
    };

    assert!(lines
        .iter()
        .any(|line| line.plain_text().contains("+ line 01")));
    assert!(lines
        .iter()
        .any(|line| line.plain_text().contains("+ line 40")));
    assert!(lines
        .iter()
        .any(|line| line.plain_text().contains("diff lines omitted")));
    assert!(!lines.iter().any(|line| line.plain_text() == "  ..."));
    assert!(!lines
        .iter()
        .any(|line| line.plain_text().contains("+ line 16")));
}

#[test]
fn parse_runtime_output_permission_preview_tracks_tool_call_diff_metadata() {
    let raw = r#"{"method":"agent.event","params":{"event":{"type":"permission.preview","tool":"edit","tool_call_id":"tool-1","diff":"--- a/demo.txt\n+++ b/demo.txt\n@@ -1 +1 @@\n-old line\n+new line"}}}"#;
    let RuntimeMsg::Agent(AgentMsg::PermissionPreview {
        update: Some(update),
        ..
    }) = parse_runtime_output(raw)
    else {
        panic!("unexpected runtime message");
    };
    assert_eq!(update.tool_call_id, "tool-1");
    assert!(update.has_diff);
    assert!(!update.truncated);
    let fingerprint = update.diff_fingerprint.expect("diff fingerprint");
    assert!(fingerprint.contains("--- a/demo.txt"));
    assert!(fingerprint.contains("+new line"));
}

#[test]
fn parse_runtime_output_edit_tool_result_tracks_diff_metadata_by_tool_call() {
    let raw = r#"{"method":"agent.event","params":{"event":{"type":"tool_result","tool":"edit","tool_call_id":"tool-1","result":{"summary":"updated file","diff":"--- a/demo.txt\n+++ b/demo.txt\n@@ -1 +1 @@\n-old line\n+new line"}}}}"#;
    let RuntimeMsg::Agent(AgentMsg::ToolCallResult { update, lines, .. }) =
        parse_runtime_output(raw)
    else {
        panic!("unexpected runtime message");
    };
    assert_eq!(update.tool_call_id, "tool-1");
    assert_eq!(update.tool, "edit");
    let fingerprint = update.edit_diff_fingerprint.expect("edit diff fingerprint");
    assert!(fingerprint.contains("--- a/demo.txt"));
    assert!(fingerprint.contains("+new line"));
    assert!(lines
        .iter()
        .any(|line| line.plain_text().contains("+ new line")));
}

#[test]
fn parse_runtime_output_apply_patch_tool_result_tracks_diff_metadata_by_tool_call() {
    let raw = r#"{"method":"agent.event","params":{"event":{"type":"tool_result","tool":"apply_patch","tool_call_id":"tool-2","result":{"summary":"Applied patch to 1 file(s)","diff":"--- a/demo.txt\n+++ b/demo.txt\n@@ -1 +1 @@\n-old line\n+new line"}}}}"#;
    let RuntimeMsg::Agent(AgentMsg::ToolCallResult { update, lines, .. }) =
        parse_runtime_output(raw)
    else {
        panic!("unexpected runtime message");
    };
    assert_eq!(update.tool_call_id, "tool-2");
    assert_eq!(update.tool, "apply_patch");
    let fingerprint = update
        .edit_diff_fingerprint
        .expect("apply_patch diff fingerprint");
    assert!(fingerprint.contains("--- a/demo.txt"));
    assert!(fingerprint.contains("+new line"));
    assert!(lines
        .iter()
        .any(|line| line.plain_text().contains("+ new line")));
}

#[test]
fn parse_runtime_output_formats_structured_permission_preview_with_diff() {
    let raw = r#"{"method":"agent.event","params":{"event":{"type":"permission.preview","tool":"edit","diff":"--- a/demo.txt\n+++ b/demo.txt\n@@ -1 +1 @@\n-old line\n+new line","truncated":true}}}"#;
    let RuntimeMsg::Agent(AgentMsg::PermissionPreview {
        update: None,
        lines,
    }) = parse_runtime_output(raw)
    else {
        panic!("unexpected runtime message");
    };
    assert_eq!(lines[0].kind(), LogKind::Space);
    assert_eq!(lines[1].kind(), LogKind::Status);
    assert!(lines[1]
        .plain_text()
        .contains("Proposed edit changes (preview)"));
    assert_eq!(lines[2].kind(), LogKind::DiffRemoved);
    assert_eq!(lines[3].kind(), LogKind::DiffAdded);
    assert_eq!(
        lines.last().map(LogLine::plain_text),
        Some("  ...".to_string())
    );
}

#[test]
fn parse_runtime_output_formats_structured_permission_preview_with_summary() {
    let raw = r#"{"method":"agent.event","params":{"event":{"type":"permission.preview","tool":"write","summary":"Preview unavailable: dry-run failed"}}}"#;
    let RuntimeMsg::Agent(AgentMsg::PermissionPreview {
        update: None,
        lines,
    }) = parse_runtime_output(raw)
    else {
        panic!("unexpected runtime message");
    };
    assert_eq!(lines[0].kind(), LogKind::Space);
    assert_eq!(lines[1].kind(), LogKind::Status);
    assert!(lines[1]
        .plain_text()
        .contains("Proposed write changes (preview)"));
    assert_eq!(lines[2].kind(), LogKind::DiffMeta);
    assert_eq!(
        lines[2].plain_text(),
        "  Preview unavailable: dry-run failed"
    );
}

#[test]
fn parse_runtime_output_formats_structured_permission_ready_as_status_summary() {
    let raw = r#"{"method":"agent.event","params":{"event":{"type":"permission.ready","tool":"edit","tool_call_id":"tool-1"}}}"#;
    let RuntimeMsg::Agent(AgentMsg::PermissionReady { update, lines }) = parse_runtime_output(raw)
    else {
        panic!("unexpected runtime message");
    };
    assert_eq!(lines[0].kind(), LogKind::Space);
    assert_eq!(lines[1].kind(), LogKind::Status);
    assert_eq!(
        lines[1].plain_text(),
        "Review edit changes, then choose Allow or Deny"
    );
    assert_eq!(
        update.as_ref().map(|update| update.tool_call_id.as_str()),
        Some("tool-1")
    );
}

#[test]
fn parse_runtime_output_hides_legacy_permission_raw_args_text_event() {
    let raw = r#"{"method":"agent.event","params":{"event":{"type":"text","content":"Permission request raw args (lane_create):\n{\"task_id\":\"t1\"}"}}}"#;
    let parsed = parse_runtime_output(raw);
    assert!(matches!(parsed, RuntimeMsg::Ignored));
}

#[test]
fn parse_runtime_output_preserves_code_block_syntax_spans_after_prefix() {
    let raw = r#"{"method":"agent.event","params":{"event":{"type":"text","content":"```rust\nfn main() {}\n```"}}}"#;
    let RuntimeMsg::Agent(AgentMsg::Text { lines, .. }) = parse_runtime_output(raw) else {
        panic!("unexpected runtime message");
    };

    assert_eq!(lines.len(), 2);
    let code = &lines[1];
    assert_eq!(code.kind(), LogKind::AssistantCode);
    assert_eq!(code.spans()[0].text, "  ");
    assert!(code.spans().iter().skip(1).any(|span| span.fg.is_some()));
}

#[test]
fn parse_runtime_output_preserves_typescript_fence_language_hint() {
    let raw = r#"{"method":"agent.event","params":{"event":{"type":"text","content":"```typescript\nconst value: number = 1;\n```"}}}"#;
    let RuntimeMsg::Agent(AgentMsg::Text { lines, .. }) = parse_runtime_output(raw) else {
        panic!("unexpected runtime message");
    };

    assert_eq!(lines.len(), 2);
    let code = &lines[1];
    assert_eq!(code.kind(), LogKind::AssistantCode);
    assert_eq!(code.spans()[0].text, "  ");
    assert!(code.spans().iter().skip(1).any(|span| span.fg.is_some()));
}

#[test]
fn permission_preview_diff_fenced_code_uses_code_block_background_with_diff_overlay() {
    let raw = r#"{"method":"agent.event","params":{"event":{"type":"permission.preview","tool":"write","diff":"--- a/demo.md\n+++ b/demo.md\n@@ -1,4 +1,4 @@\n ```ts\n-const value = 1;\n+const value = 2;\n ```"}}}"#;
    let RuntimeMsg::Agent(AgentMsg::PermissionPreview {
        update: None,
        lines,
    }) = parse_runtime_output(raw)
    else {
        panic!("unexpected runtime message");
    };

    let added_line = lines
        .iter()
        .find(|line| line.plain_text().contains("+ const value = 2;"))
        .expect("added diff line");
    assert_eq!(added_line.kind(), LogKind::DiffAdded);
    assert!(added_line
        .spans()
        .iter()
        .any(|span| span.kind == LogKind::DiffAdded));
}

#[test]
fn permission_preview_diff_uses_file_extension_for_non_fenced_syntax_highlight() {
    let raw = r#"{"method":"agent.event","params":{"event":{"type":"permission.preview","tool":"edit","diff":"--- a/demo-write-edit.ts\n+++ b/demo-write-edit.ts\n@@ -1,2 +1,2 @@\n-const retries = 1;\n+const retries = 3;"}}}"#;
    let RuntimeMsg::Agent(AgentMsg::PermissionPreview {
        update: None,
        lines,
    }) = parse_runtime_output(raw)
    else {
        panic!("unexpected runtime message");
    };

    let added_line = lines
        .iter()
        .find(|line| line.plain_text().contains("+ const retries = 3;"))
        .expect("added ts line");
    assert_eq!(added_line.kind(), LogKind::DiffAdded);
    assert!(added_line.spans().iter().any(|span| span.fg.is_some()));
}

#[test]
fn permission_preview_diff_uses_file_path_hint_when_headers_are_missing() {
    let raw = r#"{"method":"agent.event","params":{"event":{"type":"permission.preview","tool":"write","file_path":"demo-write-edit.ts","diff":"@@ -1 +1 @@\n-const retries = 1;\n+const retries = 3;"}}}"#;
    let RuntimeMsg::Agent(AgentMsg::PermissionPreview {
        update: None,
        lines,
    }) = parse_runtime_output(raw)
    else {
        panic!("unexpected runtime message");
    };

    let added_line = lines
        .iter()
        .find(|line| line.plain_text().contains("+ const retries = 3;"))
        .expect("added ts line");
    assert_eq!(added_line.kind(), LogKind::DiffAdded);
    assert!(added_line.spans().iter().any(|span| span.fg.is_some()));
}

#[test]
fn permission_preview_diff_ts_write_case_emits_colored_spans() {
    let raw = r#"{"method":"agent.event","params":{"event":{"type":"permission.preview","tool":"write","file_path":"demo-write-edit-4.ts","diff":"--- demo-write-edit-4.ts\n+++ demo-write-edit-4.ts\n@@ -0,0 +1,3 @@\n+export type Item = {\n+  id: string;\n+  score: number;"}}}"#;
    let RuntimeMsg::Agent(AgentMsg::PermissionPreview {
        update: None,
        lines,
    }) = parse_runtime_output(raw)
    else {
        panic!("unexpected runtime message");
    };

    let added_line = lines
        .iter()
        .find(|line| line.plain_text().contains("+ export type Item"))
        .expect("added write line");
    assert_eq!(added_line.kind(), LogKind::DiffAdded);
    assert!(added_line.spans().iter().any(|span| span.fg.is_some()));
}

#[test]
fn permission_preview_diff_uses_explicit_language_hint() {
    let raw = r#"{"method":"agent.event","params":{"event":{"type":"permission.preview","tool":"edit","file_path":"notes.unknown","language":"rust","diff":"@@ -1 +1 @@\n-fn old() {}\n+fn new() {}"}}}"#;
    let RuntimeMsg::Agent(AgentMsg::PermissionPreview {
        update: None,
        lines,
    }) = parse_runtime_output(raw)
    else {
        panic!("unexpected runtime message");
    };

    let added_line = lines
        .iter()
        .find(|line| line.plain_text().contains("+ fn new() {}"))
        .expect("added rust line");
    assert_eq!(added_line.kind(), LogKind::DiffAdded);
    assert!(added_line.spans().iter().any(|span| span.fg.is_some()));
}

#[test]
fn permission_preview_diff_styles_line_numbers_and_markers() {
    let raw = r#"{"method":"agent.event","params":{"event":{"type":"permission.preview","tool":"edit","diff":"--- a/demo.txt\n+++ b/demo.txt\n@@ -1 +1 @@\n-old line\n+new line"}}}"#;
    let RuntimeMsg::Agent(AgentMsg::PermissionPreview {
        update: None,
        lines,
    }) = parse_runtime_output(raw)
    else {
        panic!("unexpected runtime message");
    };

    let removed_line = lines
        .iter()
        .find(|line| line.plain_text().contains("- old line"))
        .expect("removed line");
    let added_line = lines
        .iter()
        .find(|line| line.plain_text().contains("+ new line"))
        .expect("added line");

    assert_eq!(removed_line.spans()[1].fg, Some(DIFF_NUMBER_FG));
    assert_eq!(added_line.spans()[1].fg, Some(DIFF_NUMBER_FG));
    assert_eq!(removed_line.spans()[2].fg, Some(DIFF_REMOVED_MARKER_FG));
    assert_eq!(added_line.spans()[2].fg, Some(DIFF_ADDED_MARKER_FG));
}

#[test]
fn limited_edit_diff_lines_truncates_output() {
    let diff = "--- a.txt\n+++ b.txt\n@@ -1 +1 @@\n-old\n+new";
    let (lines, truncated) = limited_edit_diff_lines_with_hint(diff, 1, None);
    assert!(truncated);
    assert_eq!(lines.len(), 1);
}

#[test]
fn parse_runtime_output_parses_live_and_replayed_steer_applied() {
    let RuntimeMsg::Agent(AgentMsg::SteerApplied {
        steer_id, lines, ..
    }) = parse_runtime_output(
        r#"{"method":"agent.event","params":{"run_id":"run-1","event":{"type":"steer_applied","steer_id":"s1","content":[{"type":"text","text":"focus here"},{"type":"image_url","image_url":{"url":"data:image/png;base64,AA"}}]}}}"#,
    )
    else {
        panic!("unexpected runtime message");
    };
    assert_eq!(steer_id, "s1");
    assert!(lines.iter().any(|line| line.plain_text() == "> focus here"));
    assert!(lines.iter().any(|line| line.plain_text() == "  [image]"));

    let RuntimeMsg::LogLines(lines) = parse_runtime_output(
        r#"{"method":"agent.event","params":{"run_id":"run-1","meta":{"replayed":true},"event":{"type":"steer_applied","steer_id":"s1","content":"old steer"}}}"#,
    ) else {
        panic!("unexpected runtime message");
    };
    assert!(lines.iter().any(|line| line.plain_text() == "> old steer"));
}

#[test]
fn parse_runtime_output_parses_unconsumed_steer_ids_on_terminal_run_status() {
    let RuntimeMsg::RunControl(RunControlMsg::Status {
        status,
        unconsumed_steer_ids,
        ..
    }) = parse_runtime_output(
        r#"{"method":"run.status","params":{"run_id":"run-1","status":"completed","unconsumed_steer_ids":["s2","s3"]}}"#,
    )
    else {
        panic!("unexpected runtime message");
    };
    assert_eq!(status, "completed");
    assert_eq!(
        unconsumed_steer_ids,
        vec!["s2".to_string(), "s3".to_string()]
    );

    let RuntimeMsg::RunControl(RunControlMsg::Status {
        status,
        unconsumed_steer_ids,
        ..
    }) = parse_runtime_output(
        r#"{"method":"run.status","params":{"run_id":"run-1","status":"error","message":"boom","unconsumed_steer_ids":["s4"],"error":{"name":"Error","message":"boom"}}}"#,
    )
    else {
        panic!("unexpected runtime message");
    };
    assert_eq!(status, "error");
    assert_eq!(unconsumed_steer_ids, vec!["s4".to_string()]);
}
