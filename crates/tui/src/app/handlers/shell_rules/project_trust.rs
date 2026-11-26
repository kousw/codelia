use super::{picker, session_is_current, visible_json};
use crate::app::state::{LogKind, PickDialogItem, ShellRulePicker};
use crate::app::{AppState, LocalPanel};
use crate::protocol::{
    PermissionRuleSpec, PermissionsListResult, ProjectAllowTrust, ProjectAllowTrustSetResult,
};
use serde_json::json;

fn rule_text(rules: &[PermissionRuleSpec]) -> String {
    if rules.is_empty() {
        return "No project allow entries.".to_owned();
    }
    rules
        .iter()
        .map(|rule| visible_json(json!(rule)))
        .collect::<Vec<_>>()
        .join("\n")
}

fn trust_snapshot(app: &mut AppState, result: &PermissionsListResult) -> Option<ProjectAllowTrust> {
    let snapshot = result
        .project_allow_trust
        .clone()
        .filter(|snapshot| !snapshot.workspace.is_empty() && !snapshot.revision.is_empty());
    if snapshot.is_none() {
        app.push_line(
            LogKind::Error,
            "The runtime could not read this workspace’s project allow trust.",
        );
    }
    snapshot
}

pub(super) fn list(app: &mut AppState, result: &PermissionsListResult) {
    if let Some(snapshot) = trust_snapshot(app, result) {
        app.push_line(
            LogKind::Status,
            format!(
                "Project allow entries for {} · {}",
                visible_json(json!(snapshot.workspace)),
                if snapshot.trusted {
                    "trusted"
                } else {
                    "inactive"
                }
            ),
        );
        for line in rule_text(&snapshot.rules).lines() {
            app.push_line(LogKind::Status, line);
        }
        app.push_line(
            LogKind::Status,
            if !app.runtime_info.supports_project_allow_trust {
                "Saving or revoking project trust is unavailable on this runtime."
            } else if snapshot.trusted {
                "Use /permissions untrust to deactivate project allow entries."
            } else {
                "Use /permissions trust to review and activate project allow entries."
            },
        );
    }
}

pub(super) fn confirm(
    app: &mut AppState,
    result: &PermissionsListResult,
    trusted: bool,
    session_id: Option<String>,
) {
    if !session_is_current(app, session_id.as_deref()) {
        app.push_line(
            LogKind::Status,
            "The session changed. Run /permissions again.",
        );
        return;
    }
    let Some(snapshot) = trust_snapshot(app, result) else {
        return;
    };
    if snapshot.trusted == trusted {
        app.push_line(
            LogKind::Status,
            if trusted {
                "Project allow entries are already trusted."
            } else {
                "Project allow entries are already inactive."
            },
        );
        return;
    }
    if app.overlays.runtime_dialogs.is_any_open()
        || matches!(
            app.overlays.local_panel,
            Some(LocalPanel::UpdatePicker(_) | LocalPanel::ShellRulePicker(_))
        )
    {
        app.push_line(
            LogKind::Status,
            "Finish the current dialog, then run /permissions again.",
        );
        return;
    }
    let workspace = snapshot.workspace;
    let message = format!(
        "Workspace {}\n{}\n{}",
        visible_json(json!(&workspace)),
        if trusted {
            "Allow the current entries and future edits to this workspace’s permissions.allow until you revoke trust."
        } else {
            "Deactivate this workspace’s permissions.allow until you grant trust again."
        },
        rule_text(&snapshot.rules)
    );
    app.overlays.local_panel = Some(picker(
        ShellRulePicker::Trust {
            trusted,
            workspace,
            revision: snapshot.revision,
            session_id,
        },
        if trusted {
            "Trust project allow entries? [D details]"
        } else {
            "Revoke project allow trust? [D details]"
        },
        Some(message),
        vec![
            PickDialogItem {
                id: "cancel".to_owned(),
                label: "Cancel".to_owned(),
                detail: None,
            },
            PickDialogItem {
                id: "apply".to_owned(),
                label: if trusted {
                    "Trust current and future entries"
                } else {
                    "Revoke project allow trust"
                }
                .to_owned(),
                detail: None,
            },
        ],
    ));
}

pub(super) fn acknowledge(
    app: &mut AppState,
    result: &ProjectAllowTrustSetResult,
    trusted: bool,
    workspace: String,
    session_id: Option<String>,
) {
    if !session_is_current(app, session_id.as_deref())
        || result.workspace != workspace
        || result.trusted != trusted
    {
        app.push_line(
            LogKind::Error,
            "Check /permissions list to verify the workspace’s current trust state.",
        );
        return;
    }
    app.push_line(
        LogKind::Status,
        if trusted {
            "Trusted current and future project allow entries for this workspace."
        } else {
            "Revoked project allow trust for this workspace."
        },
    );
}
