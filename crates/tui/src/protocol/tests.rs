use super::fixture_support::{client_params, client_result, server_result};
use super::*;
use serde_json::json;

#[derive(Debug, Deserialize)]
struct Fixture {
    case: String,
    route: String,
    method: String,
    message: Value,
    expect: String,
    ts: String,
    #[serde(default)]
    lossy: bool,
}

const FIXTURES: [&str; 6] = [
    include_str!(concat!(
        env!("CARGO_MANIFEST_DIR"),
        "/../../packages/protocol/tests/fixtures/protocol/runtime_to_ui_notification.jsonl"
    )),
    include_str!(concat!(
        env!("CARGO_MANIFEST_DIR"),
        "/../../packages/protocol/tests/fixtures/protocol/runtime_to_ui_request.jsonl"
    )),
    include_str!(concat!(
        env!("CARGO_MANIFEST_DIR"),
        "/../../packages/protocol/tests/fixtures/protocol/runtime_to_ui_response.jsonl"
    )),
    include_str!(concat!(
        env!("CARGO_MANIFEST_DIR"),
        "/../../packages/protocol/tests/fixtures/protocol/ui_to_runtime_request.jsonl"
    )),
    include_str!(concat!(
        env!("CARGO_MANIFEST_DIR"),
        "/../../packages/protocol/tests/fixtures/protocol/ui_to_runtime_notification.jsonl"
    )),
    include_str!(concat!(
        env!("CARGO_MANIFEST_DIR"),
        "/../../packages/protocol/tests/fixtures/protocol/ui_to_runtime_response.jsonl"
    )),
];

fn fixtures() -> Vec<Fixture> {
    FIXTURES
        .iter()
        .flat_map(|file| file.lines())
        .map(|line| serde_json::from_str(line).expect("fixture line"))
        .collect()
}

/// `f64` fields write `1900` as `1900.0`; compare numbers by value.
fn normalize(value: &Value) -> Value {
    match value {
        Value::Number(number) => json!(number.as_f64()),
        Value::Array(items) => Value::Array(items.iter().map(normalize).collect()),
        Value::Object(map) => Value::Object(
            map.iter()
                .map(|(key, value)| (key.clone(), normalize(value)))
                .collect(),
        ),
        other => other.clone(),
    }
}

enum Outcome {
    Typed(Value),
    Unknown(Value),
    Error,
}

fn classify_roundtrip(result: Result<Value, serde_json::Error>, unknown: bool) -> Outcome {
    match result {
        Ok(value) if unknown => Outcome::Unknown(value),
        Ok(value) => Outcome::Typed(value),
        Err(_) => Outcome::Error,
    }
}

fn classified<T: Serialize + DeserializeOwned>(
    payload: Value,
    unknown: impl FnOnce(&T) -> bool,
) -> Outcome {
    match serde_json::from_value::<T>(payload) {
        Ok(value) => classify_roundtrip(serde_json::to_value(&value), unknown(&value)),
        Err(_) => Outcome::Error,
    }
}

/// Inspect the actual fallback variants used by the shared notification
/// fixtures, including open enums nested inside a known tagged event.
fn notification_is_unknown(notification: &ServerNotification) -> bool {
    match notification {
        ServerNotification::Unknown { .. }
        | ServerNotification::RunDiagnostics(RunDiagnosticsNotify::Unknown(_)) => true,
        ServerNotification::RunStatus(status) => matches!(status.status, RunStatus::Unknown(_)),
        ServerNotification::ClientToolCancel(cancel) => {
            matches!(cancel.reason, ClientToolCancelParamsReason::Unknown(_))
        }
        ServerNotification::AgentEvent(notify) => match &notify.event {
            AgentEvent::Unknown(_) | AgentEvent::LlmStatus(LlmStatusEvent::Unknown(_)) => true,
            AgentEvent::LlmStatus(LlmStatusEvent::Buffering(event)) => {
                matches!(event.provider, LlmStatusBufferingEventProvider::Unknown(_))
            }
            AgentEvent::LlmRetry(event) => {
                matches!(event.failure_kind, LlmRetryEventFailureKind::Unknown(_))
            }
            _ => false,
        },
        _ => false,
    }
}

fn decode(fixture: &Fixture) -> Outcome {
    let method = fixture.method.as_str();
    let payload = |key: &str| fixture.message.get(key).cloned().unwrap_or(Value::Null);
    let roundtrip = |result: Option<Result<Value, serde_json::Error>>| {
        classify_roundtrip(
            result.unwrap_or_else(|| {
                panic!(
                    "{}: method is not catalogued or has no decoder",
                    fixture.case
                )
            }),
            false,
        )
    };
    match fixture.route.as_str() {
        "runtime_to_ui_notification" => match ServerNotification::decode(method, payload("params"))
        {
            Err(_) => Outcome::Error,
            Ok(notification) => {
                assert_eq!(
                    matches!(&notification, ServerNotification::Unknown { .. }),
                    fixture.ts == "skip",
                    "{}: unexpected method fallback",
                    fixture.case,
                );
                classify_roundtrip(
                    Ok(notification.params()),
                    notification_is_unknown(&notification),
                )
            }
        },
        "runtime_to_ui_request" => match ServerRequest::decode(method, payload("params")) {
            Err(_) => Outcome::Error,
            Ok(ServerRequest::Unknown { params, .. }) => Outcome::Unknown(params),
            Ok(request) => Outcome::Typed(request.params()),
        },
        "runtime_to_ui_response" => {
            let result = payload("result");
            match method {
                "initialize" => classified(result, |value: &InitializeResult| {
                    matches!(
                        value.tui.as_ref().and_then(|tui| tui.auto_review.as_ref()),
                        Some(AutoReviewState::Unknown(_))
                    )
                }),
                "theme.set" => classified(result, |value: &ThemeSetResult| {
                    matches!(value.scope, Some(ThemeSetResultScope::Unknown(_)))
                }),
                "auth.login" => classified(result, |value: &AuthLoginResult| {
                    matches!(value, AuthLoginResult::Unknown(_))
                }),
                "model.list" => classified(result, |value: &ModelListResult| {
                    matches!(
                        value.fast,
                        Some(ModelFastMode::ModelSpeedTier(ModelSpeedTier::Unknown(_)))
                    )
                }),
                _ => roundtrip(client_result(method, result)),
            }
        }
        "ui_to_runtime_request" | "ui_to_runtime_notification" => {
            let params = payload("params");
            match method {
                "run.steer" => classified(params, |value: &RunSteerParams| {
                    matches!(value.input, RunInput::Unknown(_))
                }),
                "auth.login" => classified(params, |value: &AuthLoginParams| {
                    matches!(value, AuthLoginParams::Unknown(_))
                }),
                _ => roundtrip(client_params(method, params)),
            }
        }
        "ui_to_runtime_response" => roundtrip(server_result(method, payload("result"))),
        route => panic!("{}: unknown route {route}", fixture.case),
    }
}

#[test]
fn shared_protocol_fixtures_decode_as_declared() {
    let fixtures = fixtures();
    assert!(fixtures.len() > 50, "fixture files are missing samples");
    for fixture in fixtures {
        let label = format!("{} / {} / {}", fixture.route, fixture.method, fixture.case);
        let original = fixture
            .message
            .get("params")
            .or_else(|| fixture.message.get("result"))
            .cloned()
            .unwrap_or(Value::Null);
        let (actual, reencoded) = match decode(&fixture) {
            Outcome::Typed(value) => ("typed", Some(value)),
            Outcome::Unknown(value) => ("unknown", Some(value)),
            Outcome::Error => ("error", None),
        };
        assert_eq!(actual, fixture.expect, "{label}: unexpected decode outcome");
        if let Some(reencoded) = reencoded.filter(|_| !fixture.lossy) {
            assert_eq!(
                normalize(&reencoded),
                normalize(&original),
                "{label}: re-serialization changed the payload"
            );
        }
    }
}

#[test]
fn known_variant_with_a_bad_field_is_an_error_not_unknown() {
    let error = ServerNotification::decode(
        "agent.event",
        json!({"run_id": "r", "seq": 1, "event": {"type": "text", "content": "secret value", "timestamp": "x"}}),
    )
    .unwrap_err();
    let message = error.to_string();
    assert!(
        message.starts_with("protocol mismatch in agent.event"),
        "{message}"
    );
    assert!(message.contains("type \"text\""), "{message}");
    assert!(!message.contains("secret value"));
    assert!(!message.contains("\"x\""), "{message}");
}

#[test]
fn unknown_event_type_and_enum_values_are_kept() {
    let ServerNotification::AgentEvent(notify) = ServerNotification::decode(
        "agent.event",
        json!({"run_id": "r", "seq": 1, "event": {"type": "plan.update", "steps": []}}),
    )
    .unwrap() else {
        panic!("agent.event");
    };
    assert!(matches!(notify.event, AgentEvent::Unknown(_)));
    let ServerNotification::RunStatus(status) =
        ServerNotification::decode("run.status", json!({"run_id": "r", "status": "suspended"}))
            .unwrap()
    else {
        panic!("run.status");
    };
    assert_eq!(status.status, RunStatus::Unknown("suspended".into()));
    assert_eq!(status.status.as_str(), "suspended");
}

#[test]
fn nested_llm_status_splits_on_kind() {
    let event: AgentEvent = serde_json::from_value(json!({
        "type": "llm.status", "provider": "openai", "kind": "buffering", "active": true
    }))
    .unwrap();
    let AgentEvent::LlmStatus(LlmStatusEvent::Buffering(buffering)) = event else {
        panic!("buffering");
    };
    assert!(buffering.active);
}

#[test]
fn token_budget_keeps_absent_null_and_value_apart() {
    for (budget, expected) in [
        (Patch::Absent, json!({"objective": "x"})),
        (Patch::Null, json!({"objective": "x", "token_budget": null})),
        (
            Patch::Value(10),
            json!({"objective": "x", "token_budget": 10}),
        ),
    ] {
        let params = GoalSetParams {
            objective: Some("x".into()),
            token_budget: budget.clone(),
            ..Default::default()
        };
        assert_eq!(serde_json::to_value(&params).unwrap(), expected);
        let decoded: GoalSetParams = serde_json::from_value(expected).unwrap();
        assert_eq!(decoded.token_budget, budget);
    }
}

#[test]
fn boolean_tag_selects_the_variant_and_is_written_back() {
    let success = ClientToolCallResult::Success(ClientToolCallSuccess {
        result: Some(json!({"type": "text", "text": "done"})),
    });
    let line = reply_line::<methods::ClientToolCall>("ui-1", &success);
    let value: Value = serde_json::from_str(&line).unwrap();
    assert_eq!(
        value,
        json!({"jsonrpc": "2.0", "id": "ui-1", "result": {"ok": true, "result": {"type": "text", "text": "done"}}})
    );
    let failure: ClientToolCallResult =
        serde_json::from_value(json!({"ok": false, "error": "busy"})).unwrap();
    assert_eq!(
        failure,
        ClientToolCallResult::Failure(ClientToolCallFailure {
            error: "busy".into()
        })
    );
    assert!(serde_json::from_value::<ClientToolCallResult>(json!({"error": "x"})).is_err());
}

#[test]
fn request_lines_carry_the_catalogued_method() {
    let line = request_line::<methods::ThemeSet>(
        "7",
        &ThemeSetParams {
            name: "ocean".into(),
        },
    );
    assert!(line.ends_with('\n'));
    let value: Value = serde_json::from_str(&line).unwrap();
    assert_eq!(
        value,
        json!({"jsonrpc": "2.0", "id": "7", "method": "theme.set", "params": {"name": "ocean"}})
    );
    assert_eq!(
        <methods::ThemeSet as ClientRequest>::CAPABILITY,
        Some("supports_theme_set")
    );
}

#[test]
fn classify_distinguishes_requests_notifications_and_responses() {
    assert!(matches!(
        IncomingMessage::classify(
            &json!({"jsonrpc": "2.0", "id": "1", "method": "client.tool.call", "params": {}})
        ),
        Some(IncomingMessage::Request { .. })
    ));
    assert!(matches!(
        IncomingMessage::classify(&json!({"jsonrpc": "2.0", "method": "run.status", "params": {}})),
        Some(IncomingMessage::Notification { .. })
    ));
    assert!(matches!(
        IncomingMessage::classify(&json!({"jsonrpc": "2.0", "id": "1", "error": {"code": -32602}})),
        Some(IncomingMessage::Response {
            result: None,
            error: Some(_),
            ..
        })
    ));
    assert_eq!(IncomingMessage::classify(&json!({"id": "1"})), None);
}

#[test]
fn shared_steer_trace_decodes_through_the_typed_path() {
    let trace = include_str!(concat!(
        env!("CARGO_MANIFEST_DIR"),
        "/../../packages/protocol/tests/fixtures/steer-cancel.jsonl"
    ));
    for line in trace.lines() {
        let value: Value = serde_json::from_str(line).unwrap();
        let Some(IncomingMessage::Notification { method, params }) =
            IncomingMessage::classify(&value)
        else {
            panic!("notification");
        };
        let decoded = ServerNotification::decode(&method, params).unwrap();
        assert!(
            !matches!(decoded, ServerNotification::Unknown { .. }),
            "{method}"
        );
    }
}

#[test]
fn redaction_keeps_kinds_and_field_names() {
    assert_eq!(
        redact_values("invalid type: string \"a \\\"b\\\"\", expected i64"),
        "invalid type: string, expected i64"
    );
    assert_eq!(
        redact_values("type \"text\": invalid type: integer `5`, expected a string"),
        "type \"text\": invalid type: integer, expected a string"
    );
    assert_eq!(
        redact_values("missing field `run_id`"),
        "missing field `run_id`"
    );
}

#[test]
fn positional_arrays_fail_at_top_level_and_nested_object_positions() {
    assert!(decode_result::<methods::RunSteer>(json!([true, "s1"])).is_err());
    assert!(
        ServerRequest::decode("ui.confirm.request", json!(["run", "Confirm", "Continue?"]))
            .is_err()
    );
    assert!(decode_result::<methods::Initialize>(json!({
        "protocol_version": "0", "server": ["runtime", "1"]
    }))
    .is_err());
}

#[test]
fn safe_integer_wire_values_decode_by_value_and_encode_as_integers() {
    for (spelling, expected) in [
        ("1", 1),
        ("1.0", 1),
        ("1e0", 1),
        ("9007199254740991", 9_007_199_254_740_991_i64),
        ("9007199254740991.0", 9_007_199_254_740_991),
        ("-9007199254740991", -9_007_199_254_740_991),
        ("-9007199254740991.0", -9_007_199_254_740_991),
    ] {
        let raw = format!(
            r#"{{"run_id":"r","seq":{spelling},"event":{{"type":"final","content":"done"}}}}"#
        );
        // Follow the same intermediate Value decode as the live receiver.
        let params = serde_json::from_str(&raw).unwrap();
        let notification = ServerNotification::decode("agent.event", params).unwrap();
        assert_eq!(notification.params()["seq"], json!(expected), "{spelling}");
    }
    for spelling in [
        "1.5",
        "9007199254740992",
        "-9007199254740992",
        "9007199254740992e0",
        "-9007199254740992.0",
    ] {
        let raw = format!(
            r#"{{"run_id":"r","seq":{spelling},"event":{{"type":"final","content":"done"}}}}"#
        );
        let params = serde_json::from_str(&raw).unwrap();
        assert!(
            ServerNotification::decode("agent.event", params).is_err(),
            "{spelling}"
        );
    }
}

#[test]
fn subagent_depth_accepts_only_numeric_one_and_encodes_as_integer() {
    let parse = |depth: &str| {
        serde_json::from_str::<SubagentLineage>(&format!(
            r#"{{"tree_id":"t","node_id":"n","parent_node_id":"p","owner_session_id":"s","depth":{depth},"context_mode":"fresh","spawn_index":1,"effective_policy_id":"p","workspace_lease_id":"w"}}"#
        ))
    };
    for spelling in ["1", "1.0", "1e0"] {
        let lineage = parse(spelling).unwrap();
        assert_eq!(serde_json::to_value(lineage).unwrap()["depth"], json!(1));
    }
    for spelling in ["0", "2", "1.5", "9007199254740991", r#""1""#, "null"] {
        assert!(parse(spelling).is_err(), "{spelling}");
    }
}
