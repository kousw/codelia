mod project_trust;

use super::{runtime_response::push_shell_stream_preview, RuntimeStdin};
use crate::app::app_state::{ShellRuleRpc, ShellRuleScope};
use crate::app::runtime::{send_rpc_request, send_tool_call, RpcResponse};
use crate::app::state::{LogKind, PickDialogItem, PickDialogState, ShellRulePicker};
use crate::app::AppState;
use serde::Deserialize;
use serde_json::{json, Value};
use std::fmt::Write as _;

const COMMAND: &str = "/permissions";
const USAGE: &str = "Usage /permissions [list|remove|trust|untrust|run <command>]";
const RUN_HINT: &str = "Use /permissions run <command> to try a command and save it if offered.";
const RUN_NOTE: &str = "The command runs once if allowed. A save option shows which arguments the rule covers for commands you run.";
const EXACT_TEMPLATE: &str = "exact-argv/v2";
const PREFIX_TEMPLATE: &str = "argv-prefix/v1";
const CODE_CHANGE_NOTE: &str =
    "A saved rule can skip confirmation for the same command after project code changes.";
const SCOPE_NOTE: &str = "Session rules apply only to the selected session until this runtime exits. Project rules persist for this workspace.";

#[derive(Deserialize)]
struct SavedShellRule {
    id: String,
    template: String,
    origin: String,
    executable: String,
    profile: String,
    scope: ShellRuleScope,
    args: Option<Vec<String>>,
    cwd: Option<String>,
    #[serde(rename = "launchKind")]
    launch_kind: Option<SavedShellLaunch>,
    source: Option<String>,
    argv0: Option<String>,
}

#[derive(Deserialize)]
#[serde(rename_all = "lowercase")]
enum SavedShellLaunch {
    Argv,
    Source,
}

impl SavedShellRule {
    fn into_item(self) -> Option<PickDialogItem> {
        if !rule_id_valid(&self.id) {
            return None;
        }
        let scope = self.scope.as_str();
        let origin = match self.origin.as_str() {
            "parent_agent" => "agent",
            "operator" => "operator",
            _ => "unknown origin",
        };
        let profile = match self.profile.as_str() {
            "investigation" => "investigation",
            "development" => "development",
            _ => "unknown profile",
        };
        let prefix = self.template == PREFIX_TEMPLATE;
        let (label, detail) = if prefix || self.template == EXACT_TEMPLATE {
            let invocation = match (self.launch_kind?, prefix) {
                (SavedShellLaunch::Argv, false) => String::new(),
                (SavedShellLaunch::Source, false) => format!(
                    " · resolved executable {} · Bash source {}",
                    visible_json(json!(self.executable)),
                    visible_json(json!(self.source?)),
                ),
                (kind, true) => format!(
                    " · {} · resolved executable {}",
                    match kind {
                        SavedShellLaunch::Source => "Bash",
                        SavedShellLaunch::Argv => "direct argv",
                    },
                    visible_json(json!(self.executable))
                ),
            };
            let argv = std::iter::once(self.argv0?)
                .chain(self.args?)
                .collect::<Vec<_>>();
            (
                format!("{scope} · {profile} · {origin}"),
                format!(
                    "argv {}{} · cwd {}{invocation}",
                    visible_json(json!(argv)),
                    if prefix {
                        " + any trailing arguments"
                    } else {
                        ""
                    },
                    visible_json(json!(self.cwd?))
                ),
            )
        } else {
            (
                format!("{scope} · Legacy Bun rule"),
                format!(
                    "{} · {} · {profile} · {origin}",
                    match self.template.as_str() {
                        "bun-test-file/v1" => "bun test ./tests/**/*.test.ts",
                        "bun-typecheck/v1" => "bun run typecheck",
                        _ => return None,
                    },
                    visible_json(json!(self.executable))
                ),
            )
        };
        Some(PickDialogItem {
            id: format!("{scope}/{}", self.id),
            label,
            detail: Some(detail),
        })
    }
}

fn visible_json(value: Value) -> String {
    let mut visible = String::new();
    for ch in value.to_string().chars() {
        if ch.is_control()
            || matches!(ch, '\u{061c}' | '\u{200e}' | '\u{200f}' | '\u{2028}'..='\u{202e}' | '\u{2066}'..='\u{2069}')
        {
            // These are single UTF-16 code units. Keep the display valid JSON.
            write!(&mut visible, "\\u{:04x}", ch as u32).expect("write to String");
        } else {
            visible.push(ch);
        }
    }
    visible
}

fn rule_id_valid(id: &str) -> bool {
    id.len() == 64
        && id
            .bytes()
            .all(|ch| ch.is_ascii_digit() || matches!(ch, b'a'..=b'f'))
}

fn scope_and_rule_id(value: &str) -> Option<(ShellRuleScope, &str)> {
    let (scope, rule_id) = value.split_once('/')?;
    let scope = match scope {
        "session" => ShellRuleScope::Session,
        "project" => ShellRuleScope::Project,
        _ => return None,
    };
    rule_id_valid(rule_id).then_some((scope, rule_id))
}

pub(crate) fn command(
    app: &mut AppState,
    writer: &mut RuntimeStdin,
    next_id: &mut impl FnMut() -> String,
    args: &str,
) -> bool {
    let args = args.trim_start();
    if let Some(source) = args
        .strip_prefix("run")
        .and_then(|rest| rest.strip_prefix(char::is_whitespace))
    {
        return run(app, writer, next_id, source);
    }
    let session_id = app.runtime_info.session_id.clone();
    let operation = match args.trim() {
        "" | "list" | "remove" => ShellRuleRpc::List {
            choose_removal: args.trim() == "remove",
            session_id,
        },
        "trust" | "untrust" => {
            if !app.runtime_info.supports_project_allow_trust {
                app.push_line(
                    LogKind::Error,
                    "Project allow trust is unavailable in this runtime.",
                );
                return true;
            }
            if app.runtime_info.active_run_id.is_some() {
                app.push_line(
                    LogKind::Status,
                    "Wait for the active run to finish before changing project allow trust.",
                );
                return true;
            }
            ShellRuleRpc::InspectTrust {
                trusted: args.trim() == "trust",
                session_id,
            }
        }
        _ => {
            app.push_line(LogKind::Error, USAGE);
            return false;
        }
    };
    if !app.runtime_info.supports_permissions_rw {
        app.push_line(
            LogKind::Error,
            "Saved shell rules are unavailable in this runtime.",
        );
        return true;
    }
    if app.rpc_pending.shell_rules.is_some() || app.rpc_pending.session_open_id.is_some() {
        app.push_line(
            LogKind::Status,
            "Wait for the pending permissions or session request.",
        );
        return true;
    }
    let id = next_id();
    if let Err(error) = send_rpc_request(writer, &id, "permissions.list", json!({})) {
        app.push_error_report("Could not request saved shell rules", error.to_string());
        return true;
    }
    app.rpc_pending.shell_rules = Some((id, operation));
    true
}

fn supports_run(app: &AppState) -> bool {
    let runtime = &app.runtime_info;
    runtime.supports_permissions_rw
        && runtime.supports_ui_requests
        && runtime.supports_structured_approval
        && runtime.supports_tool_call
        && runtime.supports_shell_exec
}

fn run(
    app: &mut AppState,
    writer: &mut RuntimeStdin,
    next_id: &mut impl FnMut() -> String,
    source: &str,
) -> bool {
    if source.trim().is_empty() {
        app.push_line(LogKind::Error, USAGE);
        return false;
    }
    if !supports_run(app) {
        app.push_line(
            LogKind::Error,
            "Running a command from /permissions is unavailable in this runtime.",
        );
        return false;
    }
    if !super::can_dispatch_prompt_now(app)
        || app.runtime_info.active_run_id.is_some()
        || app.dispatching_prompt.is_some()
        || app.rpc_pending.has_auto_start_blockers()
        || app.active_shell_wait_task_id.is_some()
    {
        app.push_line(
            LogKind::Status,
            "Wait for Codelia to become idle before running a /permissions command.",
        );
        return false;
    }
    let id = next_id();
    let operation = ShellRuleRpc::Run {
        session_id: app.runtime_info.session_id.clone(),
    };
    if let Err(error) = send_tool_call(writer, &id, "shell", json!({"command": source})) {
        app.push_error_report("Could not submit the shell command", error.to_string());
        return false;
    }
    app.rpc_pending.shell_rules = Some((id, operation));
    app.push_line(LogKind::Status, RUN_NOTE);
    true
}

fn log_error(app: &mut AppState, error: Value) {
    let detail = error
        .get("message")
        .and_then(Value::as_str)
        .unwrap_or("Runtime request failed.");
    app.push_error_report(COMMAND, detail.to_string());
}

fn session_is_current(app: &AppState, session_id: Option<&str>) -> bool {
    session_id == app.runtime_info.session_id.as_deref()
        && app.rpc_pending.session_open_id.is_none()
}

pub(crate) fn response(app: &mut AppState, operation: ShellRuleRpc, response: RpcResponse) {
    if let ShellRuleRpc::Run { session_id } = &operation {
        if !session_is_current(app, session_id.as_deref()) {
            app.push_line(
                LogKind::Status,
                "The session changed while the /permissions command was pending.",
            );
            return;
        }
    }
    if let Some(error) = response.error {
        log_error(app, error);
        return;
    }
    let Some(result) = response.result else {
        app.push_line(
            LogKind::Error,
            "The runtime did not report a permissions result.",
        );
        return;
    };
    match operation {
        ShellRuleRpc::InspectTrust {
            trusted,
            session_id,
        } => project_trust::confirm(app, &result, trusted, session_id),
        ShellRuleRpc::SetTrust {
            trusted,
            workspace,
            session_id,
        } => project_trust::acknowledge(app, &result, trusted, workspace, session_id),
        ShellRuleRpc::Run { .. } => run_response(app, &result),
        ShellRuleRpc::List {
            choose_removal,
            session_id,
        } => list_response(app, result, choose_removal, session_id),
        ShellRuleRpc::RemoveTool { tool } => {
            if result.get("remembered_tool").and_then(Value::as_str) == Some(tool.as_str())
                && result.get("scope").and_then(Value::as_str) == Some("project")
                && matches!(result.get("removed").and_then(Value::as_u64), Some(0 | 1))
            {
                app.push_line(
                    LogKind::Status,
                    format!(
                        "Personal workspace permission cleared for {}.",
                        visible_json(json!(tool))
                    ),
                );
            } else {
                app.push_line(
                    LogKind::Error,
                    "The runtime did not confirm removal of the personal tool permission.",
                );
            }
        }
        ShellRuleRpc::Remove { rule_id, scope } => {
            if result.get("scope").and_then(Value::as_str) != Some(scope.as_str())
                || result.get("launch_rule_id").and_then(Value::as_str) != Some(&rule_id)
            {
                app.push_line(
                    LogKind::Error,
                    "The runtime did not confirm the selected shell rule.",
                );
                return;
            }
            match result.get("removed").and_then(Value::as_u64) {
                Some(1) => app.push_line(
                    LogKind::Status,
                    format!("Removed the {} shell rule.", scope.as_str()),
                ),
                Some(0) => app.push_line(
                    LogKind::Status,
                    "The selected shell rule is already absent.",
                ),
                _ => app.push_line(
                    LogKind::Error,
                    "The runtime did not confirm shell rule removal.",
                ),
            }
        }
    }
}

fn run_response(app: &mut AppState, result: &Value) {
    let output = &result["result"];
    let Some(state) = output["state"].as_str().filter(|_| result["ok"] == true) else {
        app.push_line(LogKind::Error, "The runtime did not report a shell result.");
        return;
    };
    let mut status = format!("Command {state}");
    if let Some(exit) = output["exit_code"].as_i64() {
        write!(&mut status, " (exit {exit})").expect("write to String");
    }
    app.push_line(LogKind::Status, status);
    if let Some(detail) = output["failure_message"]
        .as_str()
        .or_else(|| output["cancellation_reason"].as_str())
    {
        app.push_error_report("Shell command", detail);
    }
    for (stream, cache, heading) in [
        ("stdout", "stdout_cache_id", "Command stdout"),
        ("stderr", "stderr_cache_id", "Command stderr"),
    ] {
        let cache_id = output[cache].as_str();
        push_shell_stream_preview(
            app,
            heading,
            output[stream].as_str(),
            cache_id.is_some(),
            cache_id,
        );
    }
}

fn list_response(
    app: &mut AppState,
    mut result: Value,
    choose_removal: bool,
    session_id: Option<String>,
) {
    if !session_is_current(app, session_id.as_deref()) {
        app.push_line(
            LogKind::Status,
            "The session changed. Run /permissions again.",
        );
        return;
    }
    if !choose_removal
        && (app.runtime_info.supports_project_allow_trust
            || result.get("project_allow_trust").is_some())
    {
        project_trust::list(app, &result);
    }
    let shell_rows = result.get_mut("launch_rules").map(Value::take);
    let shells_available = matches!(shell_rows, Some(Value::Array(_)));
    let mut items = Vec::new();
    if let Some(Value::Array(rows)) = shell_rows {
        let count = rows.len();
        items.extend(
            rows.into_iter()
                .filter_map(|row| serde_json::from_value::<SavedShellRule>(row).ok())
                .filter_map(SavedShellRule::into_item),
        );
        if items.len() != count {
            app.push_line(LogKind::Error, "Some saved shell rules could not be read.");
        }
    } else {
        app.push_line(
            LogKind::Error,
            "Saved shell rules are unavailable in this workspace.",
        );
    }
    let shell_count = items.len();
    if let Some(tools) = result.get("remembered_tools").and_then(Value::as_array) {
        items.extend(tools.iter().filter_map(|item| {
            let tool = item.get("tool")?.as_str().filter(|name| !name.is_empty())?;
            Some(PickDialogItem {
                id: format!("tool/{tool}"),
                label: visible_json(json!(tool)),
                detail: Some("Personal remembered tool permission for this workspace".to_owned()),
            })
        }));
        if items.len() - shell_count != tools.len() {
            app.push_line(
                LogKind::Error,
                "Some remembered tool permissions could not be read.",
            );
        }
    }
    if items.is_empty() {
        if shells_available {
            app.push_line(LogKind::Status, "No saved permissions.");
            if supports_run(app) {
                app.push_line(LogKind::Status, RUN_HINT);
            }
        }
        return;
    }
    if choose_removal {
        if app.pick_dialog.is_some() || app.confirm_dialog.is_some() || app.prompt_dialog.is_some()
        {
            app.push_line(
                LogKind::Status,
                "Finish the current dialog, then run /permissions remove again.",
            );
            return;
        }
        app.pick_dialog = Some(picker(
            ShellRulePicker::Choose { session_id },
            "Remove a saved rule [D details]",
            Some("Enter selects a rule. Esc closes the picker.".to_owned()),
            items,
        ));
        return;
    }
    app.push_line(
        LogKind::Status,
        if shell_count == items.len() {
            "Saved shell rules"
        } else {
            "Saved permissions"
        },
    );
    for item in items {
        app.push_line(
            LogKind::Status,
            format!("  {} · {}", item.label, item.detail.unwrap_or_default()),
        );
    }
    if shell_count > 0 {
        app.push_line(LogKind::Status, SCOPE_NOTE);
        app.push_line(LogKind::Status, CODE_CHANGE_NOTE);
    }
    app.push_line(
        LogKind::Status,
        "Run /permissions remove to revoke a saved rule.",
    );
    if supports_run(app) {
        app.push_line(LogKind::Status, RUN_HINT);
    }
}

fn picker(
    action: ShellRulePicker,
    title: &str,
    message: Option<String>,
    items: Vec<PickDialogItem>,
) -> PickDialogState {
    let chosen = vec![false; items.len()];
    PickDialogState {
        id: "codelia:shell-rules".to_owned(),
        title: title.to_owned(),
        message,
        items,
        selected: 0,
        multi: false,
        chosen,
        approval: false,
        review_offset: None,
        shell_rule_picker: Some(action),
    }
}

pub(crate) fn select(
    app: &mut AppState,
    writer: &mut RuntimeStdin,
    next_id: &mut impl FnMut() -> String,
    picker_state: PickDialogState,
) {
    let (confirming, session_id) = match picker_state.shell_rule_picker {
        Some(ShellRulePicker::Trust {
            trusted,
            workspace,
            revision,
            session_id,
        }) => {
            if picker_state
                .items
                .get(picker_state.selected)
                .map(|item| item.id.as_str())
                != Some("apply")
            {
                return;
            }
            if !session_is_current(app, session_id.as_deref())
                || app.runtime_info.active_run_id.is_some()
                || app.rpc_pending.shell_rules.is_some()
            {
                app.push_line(
                    LogKind::Status,
                    "The session changed or is busy. Run /permissions again when idle.",
                );
                return;
            }
            let id = next_id();
            if let Err(error) = send_rpc_request(
                writer,
                &id,
                "permissions.projectTrust.set",
                json!({"workspace":workspace,"trusted":trusted,"expected_revision":revision}),
            ) {
                app.push_error_report("Could not change project allow trust", error.to_string());
                return;
            }
            app.rpc_pending.shell_rules = Some((
                id,
                ShellRuleRpc::SetTrust {
                    trusted,
                    workspace,
                    session_id,
                },
            ));
            return;
        }
        Some(ShellRulePicker::Choose { session_id }) => (false, session_id),
        Some(ShellRulePicker::Confirm { session_id }) => (true, session_id),
        None => return,
    };
    if !session_is_current(app, session_id.as_deref()) {
        app.push_line(
            LogKind::Status,
            "The session changed. Run /permissions again.",
        );
        return;
    }
    let Some(item) = picker_state.items.get(picker_state.selected) else {
        return;
    };
    let (params, operation) = if let Some(tool) = item.id.strip_prefix("tool/") {
        (
            json!({"remembered_tool": tool, "scope": "project"}),
            ShellRuleRpc::RemoveTool {
                tool: tool.to_owned(),
            },
        )
    } else if let Some((scope, rule_id)) = scope_and_rule_id(&item.id) {
        (
            json!({ "launch_rule_id": rule_id, "scope": scope.as_str() }),
            ShellRuleRpc::Remove {
                rule_id: rule_id.to_owned(),
                scope,
            },
        )
    } else {
        return;
    };
    if !confirming {
        app.pick_dialog = Some(picker(
            ShellRulePicker::Confirm { session_id },
            "Remove this rule? [D details]",
            Some(format!(
                "{}\n{}",
                item.label,
                item.detail.as_deref().unwrap_or_default()
            )),
            vec![
                PickDialogItem {
                    id: "cancel".to_owned(),
                    label: "Cancel".to_owned(),
                    detail: None,
                },
                PickDialogItem {
                    id: item.id.clone(),
                    label: "Remove rule".to_owned(),
                    detail: None,
                },
            ],
        ));
        return;
    }
    if app.rpc_pending.shell_rules.is_some() {
        app.push_line(LogKind::Status, "Wait for the pending permissions request.");
        return;
    }
    let id = next_id();
    if let Err(error) = send_rpc_request(writer, &id, "permissions.remove", params) {
        app.push_error_report("Could not request permission removal", error.to_string());
        return;
    }
    app.rpc_pending.shell_rules = Some((id, operation));
}
