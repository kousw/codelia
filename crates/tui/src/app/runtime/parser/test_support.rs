use serde_json::{json, Map, Value};

fn fill(object: &mut Map<String, Value>, defaults: &[(&str, Value)]) {
    for (key, value) in defaults {
        object.entry(*key).or_insert_with(|| value.clone());
    }
}

fn complete_event(event: &mut Map<String, Value>) {
    let kind = event
        .get("type")
        .and_then(Value::as_str)
        .unwrap_or("")
        .to_owned();
    let kind = kind.as_str();
    match kind {
        "text" | "reasoning" | "hidden_user_message" | "final" => {
            fill(event, &[("content", json!(""))])
        }
        "text.delta" | "reasoning.delta" => fill(
            event,
            &[
                ("delta", json!("")),
                ("stream_id", json!("")),
                ("index", json!(0)),
            ],
        ),
        "llm.retry" => fill(
            event,
            &[
                ("provider", json!("provider")),
                ("failure_kind", json!("provider")),
                ("next_attempt", json!(0)),
                ("max_attempts", json!(0)),
                ("delay_ms", json!(0)),
                ("delay_source", json!("backoff")),
            ],
        ),
        "step_start" => fill(
            event,
            &[
                ("step_id", json!("step")),
                ("title", json!("")),
                ("step_number", json!(0)),
            ],
        ),
        "step_complete" => fill(
            event,
            &[
                ("step_id", json!("step")),
                ("status", json!("completed")),
                ("duration_ms", json!(0)),
            ],
        ),
        "tool_call" => fill(
            event,
            &[
                ("tool", json!("tool")),
                ("args", json!({})),
                ("tool_call_id", json!("call")),
            ],
        ),
        "tool_result" => {
            fill(
                event,
                &[
                    ("tool", json!("tool")),
                    ("result", json!("")),
                    ("tool_call_id", json!("call")),
                ],
            );
            // The runtime sends display text; older tests pass JSON values.
            let text = event
                .get("result")
                .filter(|value| !value.is_string())
                .map(Value::to_string);
            if let Some(text) = text {
                event.insert("result".into(), json!(text));
            }
        }
        "permission.preview" | "permission.ready" => fill(event, &[("tool", json!("tool"))]),
        "compaction_complete" => fill(event, &[("compacted", json!(false))]),
        "steer_applied" => fill(
            event,
            &[("steer_id", json!("steer")), ("content", json!(""))],
        ),
        _ => {}
    }
    if matches!(
        kind,
        "text" | "reasoning" | "compaction_start" | "compaction_complete" | "steer_applied"
    ) {
        fill(event, &[("timestamp", json!(0))]);
    }
}

/// Completes omitted required fields of catalogued messages.
pub(crate) fn complete_message(raw: &str) -> String {
    let Ok(mut value) = serde_json::from_str::<Value>(raw.trim_end()) else {
        return raw.to_string();
    };
    let method = value
        .get("method")
        .and_then(Value::as_str)
        .map(str::to_owned);
    let Some(params) = value.get_mut("params").and_then(Value::as_object_mut) else {
        return raw.to_string();
    };
    match method.as_deref() {
        Some("agent.event") => {
            fill(params, &[("run_id", json!("run")), ("seq", json!(0))]);
            if let Some(event) = params.get_mut("event").and_then(Value::as_object_mut) {
                complete_event(event);
            }
        }
        Some("run.status") => fill(params, &[("run_id", json!("run"))]),
        Some("run.metrics") => fill(params, &[("seq", json!(0))]),
        Some("client.tool.call") => fill(
            params,
            &[
                ("run_id", json!("run")),
                ("name", json!("")),
                ("raw_arguments", json!("")),
            ],
        ),
        Some("client.tool.cancel") => fill(
            params,
            &[
                ("run_id", json!("run")),
                ("name", json!("tool")),
                ("reason", json!("timeout")),
            ],
        ),
        _ => {}
    }
    value.to_string()
}

pub(crate) fn parse_runtime_output(raw: &str) -> super::RuntimeMsg {
    super::parse_runtime_output(&complete_message(raw))
}

pub(crate) fn parse_runtime_output_with_history(
    raw: &str,
    history_pending: bool,
    active_run_id: Option<&str>,
) -> super::RuntimeMsg {
    super::parse_runtime_output_with_history(&complete_message(raw), history_pending, active_run_id)
}
