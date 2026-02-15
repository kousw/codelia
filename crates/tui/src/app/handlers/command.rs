use crate::app::runtime::{
    send_auth_logout, send_context_inspect, send_mcp_list, send_model_set, send_run_start,
    send_skills_list,
};
use crate::app::state::{
    command_suggestion_rows, complete_skill_mention as complete_skill_mention_input,
    complete_slash_command as complete_slash_command_input, is_known_command,
    unknown_command_message, InputState, LogKind,
};
use crate::app::util::attachments::{
    build_run_input_payload, referenced_attachment_ids, render_input_text_with_attachment_labels,
};
use crate::app::{
    AppState, ModelListMode, ProviderPickerState, SkillsListItemState, SkillsScopeFilter,
};
use serde_json::json;
use std::io::BufWriter;
use std::process::ChildStdin;

const MODEL_PROVIDERS: &[&str] = &["openai", "anthropic", "openrouter"];
const COMMAND_SUGGESTION_LIMIT: usize = 6;

type RuntimeStdin = BufWriter<ChildStdin>;
pub(crate) fn complete_slash_command(input: &mut InputState) -> bool {
    complete_slash_command_input(input)
}

pub(crate) fn complete_skill_mention(
    input: &mut InputState,
    skills: &[SkillsListItemState],
) -> bool {
    complete_skill_mention_input(input, skills)
}

pub(crate) fn handle_enter(
    app: &mut AppState,
    child_stdin: &mut RuntimeStdin,
    next_id: &mut impl FnMut() -> String,
) -> bool {
    let raw_input = app.input.current().to_string();
    let trimmed = raw_input.trim().to_string();
    if trimmed.is_empty() {
        app.input.clear();
        return true;
    }

    let mut parts = trimmed.split_whitespace();
    let command = parts.next().unwrap_or_default();
    let mut clear_input = true;
    if command == "/compact" {
        handle_compact_command(app, child_stdin, next_id, &trimmed, &mut parts);
    } else if command == "/model" {
        handle_model_command(app, child_stdin, next_id, &mut parts);
    } else if command == "/context" {
        handle_context_command(app, child_stdin, next_id, &mut parts);
    } else if command == "/skills" {
        handle_skills_command(app, child_stdin, next_id, &mut parts);
    } else if command == "/mcp" {
        handle_mcp_command(app, child_stdin, next_id, &mut parts);
    } else if command == "/logout" {
        handle_logout_command(app, child_stdin, next_id, &trimmed, &mut parts);
    } else if command == "/lane" {
        handle_lane_command(app, &mut parts);
    } else if command == "/help" {
        handle_help_command(app, &mut parts);
    } else if !is_known_command(command) && command.starts_with('/') {
        app.push_line(LogKind::Error, unknown_command_message(command));
        clear_input = false;
    } else {
        clear_input = start_prompt_run(app, child_stdin, next_id, &raw_input);
    }

    if clear_input {
        app.clear_composer();
    }
    true
}

fn parse_scope_filter(value: &str) -> Option<SkillsScopeFilter> {
    match value {
        "all" => Some(SkillsScopeFilter::All),
        "repo" => Some(SkillsScopeFilter::Repo),
        "user" => Some(SkillsScopeFilter::User),
        _ => None,
    }
}

fn handle_compact_command<'a>(
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
    if app.pending_run_start_id.is_some() || app.pending_run_cancel_id.is_some() || app.is_running()
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
    app.pending_run_start_id = Some(id.clone());
    if let Err(error) = send_run_start(
        child_stdin,
        &id,
        app.session_id.as_deref(),
        json!({ "type": "text", "text": "" }),
        true,
    ) {
        app.pending_run_start_id = None;
        app.update_run_status("error".to_string());
        app.push_line(LogKind::Error, format!("send error: {error}"));
    }
}

fn handle_model_command<'a>(
    app: &mut AppState,
    child_stdin: &mut RuntimeStdin,
    next_id: &mut impl FnMut() -> String,
    parts: &mut impl Iterator<Item = &'a str>,
) {
    if let Some(model) = parts.next() {
        app.model_list_panel = None;
        app.skills_list_panel = None;
        let id = next_id();
        app.pending_model_set_id = Some(id.clone());
        let (provider, name) = model
            .split_once('/')
            .map(|(provider, name)| (Some(provider), name))
            .unwrap_or((app.current_provider.as_deref(), model));
        if let Err(error) = send_model_set(child_stdin, &id, provider, name) {
            app.push_line(LogKind::Error, format!("send error: {error}"));
        }
        return;
    }

    app.model_list_panel = None;
    app.skills_list_panel = None;
    let providers = MODEL_PROVIDERS
        .iter()
        .map(|provider| provider.to_string())
        .collect::<Vec<_>>();
    let selected = app
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

fn handle_context_command<'a>(
    app: &mut AppState,
    child_stdin: &mut RuntimeStdin,
    next_id: &mut impl FnMut() -> String,
    parts: &mut impl Iterator<Item = &'a str>,
) {
    if !app.supports_context_inspect {
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
    app.pending_context_inspect_id = Some(id.clone());
    app.skills_list_panel = None;
    if let Err(error) = send_context_inspect(child_stdin, &id, include_agents, include_skills) {
        app.pending_context_inspect_id = None;
        app.push_line(LogKind::Error, format!("send error: {error}"));
    }
}

fn handle_skills_command<'a>(
    app: &mut AppState,
    child_stdin: &mut RuntimeStdin,
    next_id: &mut impl FnMut() -> String,
    parts: &mut impl Iterator<Item = &'a str>,
) {
    if !app.supports_skills_list {
        app.push_line(LogKind::Status, "Skills list unavailable");
        return;
    }
    if app.pending_skills_list_id.is_some() {
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
    app.session_list_panel = None;
    app.context_panel = None;
    app.skills_list_panel = None;
    app.pending_skills_query = Some(query);
    app.pending_skills_scope = Some(scope_filter);
    let id = next_id();
    app.pending_skills_list_id = Some(id.clone());
    if let Err(error) = send_skills_list(child_stdin, &id, force_reload) {
        app.pending_skills_list_id = None;
        app.pending_skills_query = None;
        app.pending_skills_scope = None;
        app.push_line(LogKind::Error, format!("send error: {error}"));
    }
}

fn handle_mcp_command<'a>(
    app: &mut AppState,
    child_stdin: &mut RuntimeStdin,
    next_id: &mut impl FnMut() -> String,
    parts: &mut impl Iterator<Item = &'a str>,
) {
    if !app.supports_mcp_list {
        app.push_line(LogKind::Status, "MCP status unavailable");
        return;
    }
    let detail_id = parts.next().map(|value| value.to_string());
    if parts.next().is_some() {
        app.push_line(LogKind::Error, "usage: /mcp [server-id]");
        return;
    }
    let id = next_id();
    app.pending_mcp_list_id = Some(id.clone());
    app.pending_mcp_detail_id = detail_id;
    app.skills_list_panel = None;
    if let Err(error) = send_mcp_list(child_stdin, &id, Some("loaded")) {
        app.pending_mcp_list_id = None;
        app.pending_mcp_detail_id = None;
        app.push_line(LogKind::Error, format!("send error: {error}"));
    }
}

fn handle_help_command<'a>(app: &mut AppState, parts: &mut impl Iterator<Item = &'a str>) {
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

fn handle_lane_command<'a>(app: &mut AppState, parts: &mut impl Iterator<Item = &'a str>) {
    if parts.next().is_some() {
        app.push_line(LogKind::Error, "usage: /lane");
        return;
    }
    app.push_line(LogKind::Status, "Lane tools quick guide:");
    app.push_line(
        LogKind::Status,
        "  - create: lane_create { task_id, seed_context? }",
    );
    app.push_line(LogKind::Status, "  - list: lane_list {}");
    app.push_line(LogKind::Status, "  - status: lane_status { lane_id }");
    app.push_line(
        LogKind::Status,
        "  - close: lane_close { lane_id, remove_worktree? }",
    );
    app.push_line(
        LogKind::Status,
        "After lane_create, use returned hints.attach_command",
    );
    app.push_line(LogKind::Space, "");
}

fn handle_logout_command<'a>(
    app: &mut AppState,
    child_stdin: &mut RuntimeStdin,
    next_id: &mut impl FnMut() -> String,
    trimmed: &str,
    parts: &mut impl Iterator<Item = &'a str>,
) {
    if app.pending_run_start_id.is_some() || app.pending_run_cancel_id.is_some() || app.is_running()
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
    app.pending_logout_id = Some(id.clone());
    if let Err(error) = send_auth_logout(child_stdin, &id, true) {
        app.pending_logout_id = None;
        app.push_line(LogKind::Error, format!("send error: {error}"));
    }
}

fn push_user_prompt_lines(app: &mut AppState, message: &str) {
    let display_text = render_input_text_with_attachment_labels(
        message,
        &app.composer_nonce,
        &app.pending_image_attachments,
    );
    app.push_line(LogKind::User, " ");
    for (index, line) in display_text.lines().enumerate() {
        let prefix = if index == 0 { "> " } else { "  " };
        app.push_line(LogKind::User, format!("{prefix}{line}"));
    }
    for attachment_id in
        referenced_attachment_ids(message, &app.composer_nonce, &app.pending_image_attachments)
    {
        if let Some(image) = app.pending_image_attachments.get(&attachment_id) {
            app.push_line(
                LogKind::User,
                format!(
                    "  [image {}x{} {}KB]",
                    image.width,
                    image.height,
                    image.encoded_bytes / 1024
                ),
            );
        }
    }
    app.push_line(LogKind::User, " ");
}

pub(crate) fn start_prompt_run(
    app: &mut AppState,
    child_stdin: &mut RuntimeStdin,
    next_id: &mut impl FnMut() -> String,
    trimmed: &str,
) -> bool {
    if app.pending_run_start_id.is_some() || app.pending_run_cancel_id.is_some() || app.is_running()
    {
        app.push_line(
            LogKind::Status,
            "Run is still active; wait for completion before sending the next prompt.",
        );
        return false;
    }
    app.input.record_history(trimmed);
    app.scroll_from_bottom = 0;
    app.last_assistant_text = None;
    push_user_prompt_lines(app, trimmed);
    app.update_run_status("starting".to_string());
    let id = next_id();
    app.pending_run_start_id = Some(id.clone());
    let input_payload =
        build_run_input_payload(trimmed, &app.composer_nonce, &app.pending_image_attachments);
    if let Err(error) = send_run_start(
        child_stdin,
        &id,
        app.session_id.as_deref(),
        input_payload,
        false,
    ) {
        app.pending_run_start_id = None;
        app.update_run_status("error".to_string());
        app.push_line(LogKind::Error, format!("send error: {error}"));
        return false;
    }
    true
}
