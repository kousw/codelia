use crate::app::runtime::{
    send_auth_logout, send_context_inspect, send_mcp_list, send_model_set, send_run_start,
    send_skills_list, send_task_cancel, send_task_list, send_task_status, send_theme_set,
    send_tool_call,
};
use crate::app::state::{
    command_suggestion_rows, parse_theme_name, theme_options, LogKind, ThemeListPanelState,
};
use crate::app::{
    AppState, ErrorDetailMode, ModelListMode, ProviderPickerState, SkillsScopeFilter,
};
use serde_json::json;

use super::{RuntimeStdin, COMMAND_SUGGESTION_LIMIT, MODEL_PROVIDERS, TASKS_USAGE_MESSAGE};

fn parse_scope_filter(value: &str) -> Option<SkillsScopeFilter> {
    match value {
        "all" => Some(SkillsScopeFilter::All),
        "repo" => Some(SkillsScopeFilter::Repo),
        "user" => Some(SkillsScopeFilter::User),
        _ => None,
    }
}

pub(super) fn handle_compact_command<'a>(
    app: &mut AppState,
    child_stdin: &mut RuntimeStdin,
    next_id: &mut impl FnMut() -> String,
    trimmed: &str,
    parts: &mut impl Iterator<Item = &'a str>,
) {
    if parts.next().is_some() {
        app.push_line(LogKind::Error, "usage: /compact");
        return;
    }
    if app.rpc_pending.run_start_id.is_some()
        || app.rpc_pending.run_cancel_id.is_some()
        || app.is_running()
    {
        app.push_line(
            LogKind::Status,
            "Run is still active; wait for completion before running /compact.",
        );
        return;
    }
    app.input.record_history(trimmed);
    app.scroll_from_bottom = 0;
    app.last_assistant_text = None;
    app.push_line(LogKind::User, "> /compact");
    app.update_run_status("starting".to_string());
    app.push_line(LogKind::Status, "Starting forced compaction ...");
    let id = next_id();
    app.rpc_pending.run_start_id = Some(id.clone());
    if let Err(error) = send_run_start(
        child_stdin,
        &id,
        app.runtime_info.session_id.as_deref(),
        json!({ "type": "text", "text": "" }),
        true,
    ) {
        app.rpc_pending.run_start_id = None;
        app.update_run_status("error".to_string());
        app.push_error_report("send error", error.to_string());
    }
}

pub(super) fn handle_model_command<'a>(
    app: &mut AppState,
    child_stdin: &mut RuntimeStdin,
    next_id: &mut impl FnMut() -> String,
    parts: &mut impl Iterator<Item = &'a str>,
) {
    if let Some(model) = parts.next() {
        app.model_list_panel = None;
        app.reasoning_picker = None;
        app.skills_list_panel = None;
        app.theme_list_panel = None;
        let id = next_id();
        app.rpc_pending.model_set_id = Some(id.clone());
        let (provider, name) = model
            .split_once('/')
            .map(|(provider, name)| (Some(provider), name))
            .unwrap_or((app.runtime_info.current_provider.as_deref(), model));
        if let Err(error) = send_model_set(child_stdin, &id, provider, name, None) {
            app.push_error_report("send error", error.to_string());
        }
        return;
    }

    app.model_list_panel = None;
    app.reasoning_picker = None;
    app.skills_list_panel = None;
    app.theme_list_panel = None;
    let providers = MODEL_PROVIDERS
        .iter()
        .map(|provider| provider.to_string())
        .collect::<Vec<_>>();
    let selected = app
        .runtime_info
        .current_provider
        .as_ref()
        .and_then(|current| providers.iter().position(|p| p == current))
        .unwrap_or(0);
    if providers.is_empty() {
        app.push_line(LogKind::Error, "no model providers available");
    } else {
        app.provider_picker = Some(ProviderPickerState {
            providers,
            selected,
            mode: ModelListMode::List,
        });
    }
}

pub(super) fn handle_context_command<'a>(
    app: &mut AppState,
    child_stdin: &mut RuntimeStdin,
    next_id: &mut impl FnMut() -> String,
    parts: &mut impl Iterator<Item = &'a str>,
) {
    if !app.runtime_info.supports_context_inspect {
        app.push_line(LogKind::Status, "Context inspect unavailable");
        return;
    }
    let first_arg = parts.next();
    let (include_agents, include_skills) = match first_arg {
        None => (true, true),
        Some("brief") => (false, false),
        Some(_) => {
            app.push_line(LogKind::Error, "usage: /context [brief]");
            return;
        }
    };
    if parts.next().is_some() {
        app.push_line(LogKind::Error, "usage: /context [brief]");
        return;
    }
    let id = next_id();
    app.rpc_pending.context_inspect_id = Some(id.clone());
    app.skills_list_panel = None;
    app.theme_list_panel = None;
    if let Err(error) = send_context_inspect(child_stdin, &id, include_agents, include_skills) {
        app.rpc_pending.context_inspect_id = None;
        app.push_error_report("send error", error.to_string());
    }
}

pub(super) fn handle_skills_command<'a>(
    app: &mut AppState,
    child_stdin: &mut RuntimeStdin,
    next_id: &mut impl FnMut() -> String,
    parts: &mut impl Iterator<Item = &'a str>,
) {
    if !app.runtime_info.supports_skills_list {
        app.push_line(LogKind::Status, "Skills list unavailable");
        return;
    }
    if app.rpc_pending.skills_list_id.is_some() {
        app.push_line(LogKind::Status, "Skills list request already running");
        return;
    }

    let mut query_parts = Vec::new();
    let mut scope_filter = SkillsScopeFilter::All;
    let mut has_scope = false;
    let mut force_reload = false;
    let mut pending_scope_value = false;

    for part in parts {
        if pending_scope_value {
            let Some(parsed) = parse_scope_filter(part) else {
                app.push_line(
                    LogKind::Error,
                    "usage: /skills [query] [all|repo|user] [--reload] [--scope <all|repo|user>]",
                );
                return;
            };
            scope_filter = parsed;
            has_scope = true;
            pending_scope_value = false;
            continue;
        }

        if part == "--reload" {
            force_reload = true;
            continue;
        }
        if part == "--scope" {
            pending_scope_value = true;
            continue;
        }
        if let Some(value) = part.strip_prefix("--scope=") {
            let Some(parsed) = parse_scope_filter(value) else {
                app.push_line(
                    LogKind::Error,
                    "usage: /skills [query] [all|repo|user] [--reload] [--scope <all|repo|user>]",
                );
                return;
            };
            scope_filter = parsed;
            has_scope = true;
            continue;
        }
        if !has_scope {
            if let Some(parsed) = parse_scope_filter(part) {
                scope_filter = parsed;
                has_scope = true;
                continue;
            }
        }
        query_parts.push(part.to_string());
    }

    if pending_scope_value {
        app.push_line(
            LogKind::Error,
            "usage: /skills [query] [all|repo|user] [--reload] [--scope <all|repo|user>]",
        );
        return;
    }

    let query = query_parts.join(" ");
    app.model_list_panel = None;
    app.reasoning_picker = None;
    app.session_list_panel = None;
    app.context_panel = None;
    app.skills_list_panel = None;
    app.theme_list_panel = None;
    app.rpc_pending.skills_query = Some(query);
    app.rpc_pending.skills_scope = Some(scope_filter);
    let id = next_id();
    app.rpc_pending.skills_list_id = Some(id.clone());
    if let Err(error) = send_skills_list(child_stdin, &id, force_reload) {
        app.rpc_pending.skills_list_id = None;
        app.rpc_pending.skills_query = None;
        app.rpc_pending.skills_scope = None;
        app.push_error_report("send error", error.to_string());
    }
}

pub(super) fn handle_theme_command<'a>(
    app: &mut AppState,
    child_stdin: &mut RuntimeStdin,
    next_id: &mut impl FnMut() -> String,
    parts: &mut impl Iterator<Item = &'a str>,
) {
    let arg = parts.next();
    if parts.next().is_some() {
        app.push_line(LogKind::Error, "usage: /theme [theme-name]");
        return;
    }

    let options = theme_options();
    if options.is_empty() {
        app.push_line(LogKind::Error, "theme options unavailable");
        return;
    }

    if let Some(value) = arg {
        let Some(target) = parse_theme_name(value) else {
            app.push_line(LogKind::Error, format!("unknown theme: {value}"));
            return;
        };
        if !app.runtime_info.supports_theme_set {
            app.push_line(LogKind::Status, "Theme update unavailable");
            return;
        }
        if app.rpc_pending.theme_set_id.is_some() {
            app.push_line(LogKind::Status, "Theme update request already running");
            return;
        }
        let id = next_id();
        app.rpc_pending.theme_set_id = Some(id.clone());
        if let Err(error) = send_theme_set(child_stdin, &id, target.as_str()) {
            app.rpc_pending.theme_set_id = None;
            app.push_error_report("send error", error.to_string());
            return;
        }
        app.theme_list_panel = None;
        return;
    }

    let active = crate::app::theme::active_theme_name();

    let mut rows = Vec::with_capacity(options.len());
    let mut theme_ids = Vec::with_capacity(options.len());
    let mut selected = 0_usize;
    for (index, option) in options.iter().enumerate() {
        let id = option.name.as_str();
        let aliases = option.name.aliases();
        let alias_suffix = if aliases.is_empty() {
            String::new()
        } else {
            format!(" (alias: {})", aliases.join(","))
        };
        let marker = if option.name == active { "✓" } else { " " };
        rows.push(format!(
            "{marker} {:<8} - {}{}",
            id, option.preview, alias_suffix
        ));
        theme_ids.push(id.to_string());
        if option.name == active {
            selected = index;
        }
    }

    let header = "Enter: apply & save theme  Esc: close".to_string();

    app.model_list_panel = None;
    app.reasoning_picker = None;
    app.session_list_panel = None;
    app.context_panel = None;
    app.skills_list_panel = None;
    app.lane_list_panel = None;
    app.provider_picker = None;
    app.model_picker = None;
    app.theme_list_panel = Some(ThemeListPanelState {
        title: "Theme picker".to_string(),
        header,
        rows,
        theme_ids,
        selected,
    });
}

pub(super) fn handle_mcp_command<'a>(
    app: &mut AppState,
    child_stdin: &mut RuntimeStdin,
    next_id: &mut impl FnMut() -> String,
    parts: &mut impl Iterator<Item = &'a str>,
) {
    if !app.runtime_info.supports_mcp_list {
        app.push_line(LogKind::Status, "MCP status unavailable");
        return;
    }
    let detail_id = parts.next().map(|value| value.to_string());
    if parts.next().is_some() {
        app.push_line(LogKind::Error, "usage: /mcp [server-id]");
        return;
    }
    let id = next_id();
    app.rpc_pending.mcp_list_id = Some(id.clone());
    app.rpc_pending.mcp_detail_id = detail_id;
    app.skills_list_panel = None;
    app.theme_list_panel = None;
    if let Err(error) = send_mcp_list(child_stdin, &id, Some("loaded")) {
        app.rpc_pending.mcp_list_id = None;
        app.rpc_pending.mcp_detail_id = None;
        app.push_error_report("send error", error.to_string());
    }
}

pub(super) fn handle_help_command<'a>(
    app: &mut AppState,
    parts: &mut impl Iterator<Item = &'a str>,
) {
    if parts.next().is_some() {
        app.push_line(LogKind::Error, "usage: /help");
        return;
    }
    app.push_line(LogKind::Status, "Commands:");
    for row in command_suggestion_rows("/", COMMAND_SUGGESTION_LIMIT) {
        app.push_line(LogKind::Status, format!("  {row}"));
    }
    app.push_line(LogKind::Space, "");
}

pub(super) fn handle_tasks_command<'a>(
    app: &mut AppState,
    child_stdin: &mut RuntimeStdin,
    next_id: &mut impl FnMut() -> String,
    parts: &mut impl Iterator<Item = &'a str>,
) {
    if !app.runtime_info.supports_tasks {
        app.push_line(LogKind::Status, "Tasks unavailable");
        return;
    }

    match parts.next() {
        None | Some("list") => {
            if parts.next().is_some() {
                app.push_line(LogKind::Error, TASKS_USAGE_MESSAGE);
                return;
            }
            let id = next_id();
            app.rpc_pending.task_list_id = Some(id.clone());
            if let Err(error) = send_task_list(child_stdin, &id) {
                app.rpc_pending.task_list_id = None;
                app.push_error_report("send error", error.to_string());
            }
        }
        Some("show") => {
            let Some(task_id) = parts.next() else {
                app.push_line(LogKind::Error, TASKS_USAGE_MESSAGE);
                return;
            };
            if parts.next().is_some() {
                app.push_line(LogKind::Error, TASKS_USAGE_MESSAGE);
                return;
            }
            let id = next_id();
            app.rpc_pending.task_status_id = Some(id.clone());
            if let Err(error) = send_task_status(child_stdin, &id, task_id) {
                app.rpc_pending.task_status_id = None;
                app.push_error_report("send error", error.to_string());
            }
        }
        Some("cancel") => {
            let Some(task_id) = parts.next() else {
                app.push_line(LogKind::Error, TASKS_USAGE_MESSAGE);
                return;
            };
            if parts.next().is_some() {
                app.push_line(LogKind::Error, TASKS_USAGE_MESSAGE);
                return;
            }
            let id = next_id();
            app.rpc_pending.task_cancel_id = Some(id.clone());
            if let Err(error) = send_task_cancel(child_stdin, &id, task_id) {
                app.rpc_pending.task_cancel_id = None;
                app.push_error_report("send error", error.to_string());
            }
        }
        Some(_) => {
            app.push_line(LogKind::Error, TASKS_USAGE_MESSAGE);
        }
    }
}

pub(super) fn handle_errors_command<'a>(
    app: &mut AppState,
    parts: &mut impl Iterator<Item = &'a str>,
) {
    match parts.next() {
        None => {
            app.push_line(
                LogKind::Status,
                format!(
                    "Error detail mode: {} (/errors summary|detail|show)",
                    app.error_detail_mode.label()
                ),
            );
        }
        Some("summary") => {
            if parts.next().is_some() {
                app.push_line(LogKind::Error, "usage: /errors [summary|detail|show]");
                return;
            }
            app.set_error_detail_mode(ErrorDetailMode::Summary);
            app.push_line(LogKind::Status, "Error detail mode set to summary.");
        }
        Some("detail") => {
            if parts.next().is_some() {
                app.push_line(LogKind::Error, "usage: /errors [summary|detail|show]");
                return;
            }
            app.set_error_detail_mode(ErrorDetailMode::Detail);
            app.push_line(LogKind::Status, "Error detail mode set to detail.");
        }
        Some("show") => {
            if parts.next().is_some() {
                app.push_line(LogKind::Error, "usage: /errors [summary|detail|show]");
                return;
            }
            let _ = app.show_last_error_detail();
        }
        Some(_) => {
            app.push_line(LogKind::Error, "usage: /errors [summary|detail|show]");
        }
    }
}

pub(super) fn handle_lane_command<'a>(
    app: &mut AppState,
    child_stdin: &mut RuntimeStdin,
    next_id: &mut impl FnMut() -> String,
    parts: &mut impl Iterator<Item = &'a str>,
) {
    if parts.next().is_some() {
        app.push_line(LogKind::Error, "usage: /lane");
        return;
    }
    if !app.runtime_info.supports_tool_call {
        app.push_line(LogKind::Status, "Lane commands unavailable");
        return;
    }
    app.model_list_panel = None;
    app.reasoning_picker = None;
    app.session_list_panel = None;
    app.context_panel = None;
    app.skills_list_panel = None;
    app.lane_list_panel = None;
    app.theme_list_panel = None;

    let id = next_id();
    app.rpc_pending.lane_list_id = Some(id.clone());
    if let Err(error) = send_tool_call(child_stdin, &id, "lane_list", json!({})) {
        app.rpc_pending.lane_list_id = None;
        app.push_error_report("send error", error.to_string());
    }
}

pub(super) fn handle_logout_command<'a>(
    app: &mut AppState,
    child_stdin: &mut RuntimeStdin,
    next_id: &mut impl FnMut() -> String,
    trimmed: &str,
    parts: &mut impl Iterator<Item = &'a str>,
) {
    if app.rpc_pending.run_start_id.is_some()
        || app.rpc_pending.run_cancel_id.is_some()
        || app.is_running()
    {
        app.push_line(
            LogKind::Status,
            "Run is still active; wait for completion before running /logout.",
        );
        return;
    }

    if parts.next().is_some() {
        app.push_line(LogKind::Error, "usage: /logout");
        return;
    }

    app.input.record_history(trimmed);
    app.push_line(LogKind::User, "> /logout");
    let id = next_id();
    app.rpc_pending.logout_id = Some(id.clone());
    if let Err(error) = send_auth_logout(child_stdin, &id, true) {
        app.rpc_pending.logout_id = None;
        app.push_error_report("send error", error.to_string());
    }
}
