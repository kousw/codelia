use super::formatters::push_rpc_error;
use crate::app::runtime::RpcResponse;
use crate::app::state::LogKind;
use crate::app::AppState;
use serde_json::Value;

pub(super) fn handle(app: &mut AppState, response: RpcResponse) {
    if let Some(error) = response.error {
        push_rpc_error(app, "/auto-approve", &error);
        return;
    }
    let Some(result) = response.result else {
        app.push_line(
            LogKind::Error,
            "The runtime did not report an Auto approve status.",
        );
        return;
    };
    let (kind, message) = status(&result);
    if push_confined_status(
        app,
        result.get("state").and_then(Value::as_str),
        result
            .get("confined_launch_enabled")
            .and_then(Value::as_bool),
        result.get("confined_launch_issue").and_then(Value::as_str),
        result.get("issue").and_then(Value::as_str),
    ) {
        return;
    }
    let label = result.get("label").and_then(Value::as_str);
    if result.get("state").and_then(Value::as_str) == Some("active") {
        let mode = match result.get("mode").and_then(Value::as_str) {
            Some("follow") => Some("Follow chat provider"),
            Some("pin") => Some("Custom model"),
            _ => None,
        };
        let selection = mode
            .into_iter()
            .chain(label)
            .collect::<Vec<_>>()
            .join(" · ");
        if !selection.is_empty() {
            app.push_line(kind, format!("{message} {selection}"));
            return;
        }
    }
    app.push_line(kind, message);
}

pub(super) fn push_confined_status(
    app: &mut AppState,
    reviewer_state: Option<&str>,
    confined_enabled: Option<bool>,
    confined_issue: Option<&str>,
    reviewer_issue: Option<&str>,
) -> bool {
    match confined_enabled {
        Some(false) => {
            app.push_line(LogKind::Status, "Auto approve is off for this workspace.");
            if confined_issue.is_some() {
                app.push_line(
                    LogKind::Error,
                    "The workspace Auto approve setting could not be verified.",
                );
            } else if matches!(
                reviewer_issue,
                Some("review_reconfigure_required" | "review_config_unavailable")
            ) {
                app.push_line(LogKind::Status, unavailable_message(reviewer_issue));
            }
            true
        }
        Some(true) if reviewer_state != Some("active") => {
            app.push_line(
                LogKind::Status,
                "Auto approve is on for confined parent shell launches.",
            );
            if reviewer_state == Some("unavailable") {
                app.push_line(
                    LogKind::Status,
                    unavailable_message(reviewer_issue.or(Some("review_config_unavailable"))),
                );
            }
            true
        }
        _ => false,
    }
}

pub(super) fn unavailable_message(issue: Option<&str>) -> &'static str {
    match issue {
        Some("review_chat_provider_unresolved") => {
            "The Auto approve review model is waiting for the chat provider to resolve."
        }
        Some("review_chat_provider_unsupported") => {
            "The Auto approve review model is unavailable for this chat provider."
        }
        Some("unregistered_review_model") => {
            "The Auto approve review model is unavailable. Choose a registered provider and model."
        }
        Some("review_reconfigure_required") => {
            "Run /auto-approve to update your saved Auto approve settings."
        }
        Some("review_auth_unavailable") => {
            "The Auto approve review model needs authentication for the selected provider."
        }
        Some("review_auth_incompatible") => {
            "The Auto approve review model does not support the current authentication method."
        }
        Some("review_config_unavailable") => {
            "The Auto approve review model settings could not be verified."
        }
        _ => "Auto approve is unavailable. Check the user settings.",
    }
}

fn status(result: &Value) -> (LogKind, &'static str) {
    match result.get("state").and_then(Value::as_str) {
        Some("off") => (LogKind::Status, "Auto approve is off."),
        Some("active") => (LogKind::Status, "Auto approve is on."),
        Some("unavailable") => {
            let issue = result.get("issue").and_then(Value::as_str);
            let kind = if issue == Some("review_chat_provider_unresolved") {
                LogKind::Status
            } else {
                LogKind::Error
            };
            (kind, unavailable_message(issue))
        }
        _ => (
            LogKind::Error,
            "The runtime did not report an Auto approve status.",
        ),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn reviewer_authentication_error_keeps_enabled_workspace_visible() {
        let mut app = AppState::default();
        handle(
            &mut app,
            RpcResponse {
                id: "review".into(),
                result: Some(
                    serde_json::json!({"state": "unavailable", "confined_launch_enabled": true, "issue": "review_auth_unavailable"}),
                ),
                error: None,
            },
        );
        assert_eq!(app.log.len(), 2);
        assert!(app.log[0].plain_text().contains("Auto approve is on"));
        assert!(app.log[1].plain_text().contains("needs authentication"));
    }

    #[test]
    fn active_selection_is_reported_in_one_line() {
        let mut app = AppState::default();
        handle(
            &mut app,
            RpcResponse {
                id: "review".into(),
                result: Some(serde_json::json!({
                    "state": "active",
                    "mode": "pin",
                    "label": "Google / gemini-4-hydrogen (Experimental / decision quality untested)",
                    "details": ["Destination https://generativelanguage.googleapis.com/v1beta/interactions",
                                "Billing uses the configured Google API account."]
                })),
                error: None,
            },
        );
        let rendered = app
            .log
            .iter()
            .map(|line| line.plain_text())
            .collect::<Vec<_>>()
            .join("\n");
        assert_eq!(rendered.lines().count(), 1);
        assert!(rendered.starts_with("Auto approve is on."));
        assert!(rendered.contains("Custom model"));
        assert!(rendered.contains("Experimental / decision quality untested"));
    }

    #[test]
    fn status_identifies_authentication_problems() {
        for (issue, expected) in [
            (
                "review_auth_unavailable",
                "The Auto approve review model needs authentication for the selected provider.",
            ),
            (
                "review_auth_incompatible",
                "The Auto approve review model does not support the current authentication method.",
            ),
        ] {
            let mut app = AppState::default();
            handle(
                &mut app,
                RpcResponse {
                    id: "review".into(),
                    result: Some(serde_json::json!({"state": "unavailable", "issue": issue})),
                    error: None,
                },
            );
            assert_eq!(app.log.last().unwrap().plain_text(), expected);
        }
    }

    #[test]
    fn off_workspace_reports_unverifiable_reviewer_config_issue() {
        let mut app = AppState::default();
        handle(
            &mut app,
            RpcResponse {
                id: "review".into(),
                result: Some(serde_json::json!({
                    "state": "unavailable",
                    "confined_launch_enabled": false,
                    "issue": "review_config_unavailable"
                })),
                error: None,
            },
        );
        assert_eq!(app.log.len(), 2);
        assert!(app.log[0].plain_text().contains("Auto approve is off"));
        assert!(app.log[1]
            .plain_text()
            .contains("review model settings could not be verified"));
    }
}
