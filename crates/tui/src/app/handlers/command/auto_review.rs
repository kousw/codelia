use super::RuntimeStdin;
use crate::app::runtime::send_rpc_request;
use crate::app::state::LogKind;
use crate::app::AppState;
use serde_json::json;

fn action(args: &str) -> Option<&'static str> {
    match args {
        "" => Some("pick"),
        "status" => Some("status"),
        "off" => Some("off"),
        _ => None,
    }
}

pub(super) fn handle(
    app: &mut AppState,
    writer: &mut RuntimeStdin,
    next_id: &mut impl FnMut() -> String,
    args: &str,
) {
    let Some(action) = action(args) else {
        app.push_line(LogKind::Error, "usage: /auto-approve [status|off]");
        return;
    };
    if !app.runtime_info.supports_auto_review_configure {
        app.push_line(
            LogKind::Error,
            "Auto approve settings are unavailable in this runtime.",
        );
        return;
    }
    if app.rpc_pending.auto_review_id.is_some()
        || (action == "pick" && app.runtime_info.active_run_id.is_some())
    {
        app.push_line(
            LogKind::Status,
            "Wait for the current run or Auto approve setup to finish.",
        );
        return;
    }
    let id = next_id();
    app.rpc_pending.auto_review_id = Some(id.clone());
    if let Err(error) = send_rpc_request(
        writer,
        &id,
        "auto_review.configure",
        json!({"action": action}),
    ) {
        app.rpc_pending.auto_review_id = None;
        app.push_error_report("send Auto approve request", error.to_string());
    }
}

#[cfg(test)]
mod tests {
    use super::action;

    #[test]
    fn reviewer_routes_are_selected_in_the_picker() {
        assert_eq!(action(""), Some("pick"));
        assert_eq!(action("status"), Some("status"));
        assert_eq!(action("off"), Some("off"));
        assert_eq!(action("google"), None);
        assert_eq!(action("off extra"), None);
    }
}
