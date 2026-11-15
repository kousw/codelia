use serde_json::Value;

pub(crate) struct RunErrorPresentation {
    pub summary: String,
    pub detail: String,
    pub hint: Option<String>,
}

fn field(value: &Value, key: &str) -> Option<String> {
    value
        .get(key)
        .and_then(Value::as_str)
        .filter(|text| !text.trim().is_empty())
        .map(|text| text.chars().take(600).collect::<String>())
}

/// Error-only display. Runtime supplies safe fields; never render arbitrary JSON or stacks.
pub(super) fn run_error(value: &Value, fallback: &str) -> Option<RunErrorPresentation> {
    if !value.is_object() {
        return None;
    }
    let message = field(value, "message").unwrap_or_else(|| fallback.to_string());
    let mut summary = message.clone();
    if let Some(cause) = field(value, "detail") {
        if !summary.contains(&cause) {
            summary.push_str(&format!(" {cause}"));
        }
    }
    let mut context = Vec::new();
    let mut detail = vec![message];
    for (key, label) in [
        ("name", "Error type"),
        ("provider", "Provider"),
        ("kind", "Category"),
        ("code", "Code"),
    ] {
        if let Some(text) = field(value, key) {
            detail.push(format!("{label}: {text}"));
        }
    }
    if let Some(status) = value
        .get("status")
        .and_then(Value::as_u64)
        .filter(|status| (100..=599).contains(status))
    {
        context.push(format!("HTTP {status}"));
        detail.push(format!("HTTP status: {status}"));
    }
    if let Some(attempts) = value.get("attempts").and_then(Value::as_u64) {
        let text = value
            .get("max_attempts")
            .and_then(Value::as_u64)
            .map_or_else(|| attempts.to_string(), |max| format!("{attempts}/{max}"));
        context.push(format!("attempt {text}"));
        detail.push(format!("Attempts: {text}"));
    }
    if !context.is_empty() {
        summary.push_str(&format!(" ({})", context.join(", ")));
    }
    if let Some(cause) = field(value, "detail") {
        detail.push(format!("Cause: {cause}"));
    }
    let hint = field(value, "hint");
    if let Some(hint) = &hint {
        detail.push(format!("Next: {hint}"));
    }
    Some(RunErrorPresentation {
        summary,
        detail: detail.join("\n"),
        hint,
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;
    #[test]
    fn failure_presentation_includes_safe_cause_http_and_attempts_without_raw_data() {
        let parsed = run_error(&json!({"name":"ProviderFailureError","message":"Google request failed.","provider":"google","kind":"provider","status":503,"attempts":3,"max_attempts":3,"detail":"The response stream ended before completion.","code":"response_incomplete","hint":"Retry shortly.","stack":"private-stack","raw_body":{"api_key":"private-token"}}), "").unwrap();
        assert!(parsed.summary.contains("HTTP 503"));
        assert!(parsed.summary.contains("attempt 3/3"));
        assert!(parsed.summary.contains("ended before completion"));
        assert!(parsed.detail.contains("Code: response_incomplete"));
        assert!(parsed.detail.contains("Error type: ProviderFailureError"));
        assert_eq!(parsed.hint.as_deref(), Some("Retry shortly."));
        assert!(!parsed.detail.contains("private"));
        assert!(!parsed.summary.contains("private"));
    }
}
