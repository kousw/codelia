use crate::app::runtime::{
    send_auth_logout, send_context_inspect, send_mcp_list, send_model_set, send_run_start,
    send_shell_exec, send_skills_list, send_theme_set, send_tool_call,
};
use crate::app::state::{
    command_suggestion_rows, complete_skill_mention as complete_skill_mention_input,
    complete_slash_command as complete_slash_command_input, is_known_command, parse_theme_name,
    theme_options, unknown_command_message, InputState, LogKind, ThemeListPanelState,
};
use crate::app::util::attachments::{
    build_run_input_payload, referenced_attachment_ids, render_input_text_with_attachment_labels,
};
use crate::app::{
    AppState, ErrorDetailMode, ModelListMode, PendingPromptRun, PendingShellResult,
    ProviderPickerState, SkillsListItemState, SkillsScopeFilter,
};
use serde_json::json;
use std::io::BufWriter;
use std::process::ChildStdin;
use std::time::{Duration, Instant};

const MODEL_PROVIDERS: &[&str] = &["openai", "anthropic", "openrouter"];
const COMMAND_SUGGESTION_LIMIT: usize = 12;
const QUEUE_PREVIEW_MAX_CHARS: usize = 72;
const QUEUE_LIST_LIMIT: usize = 5;
const QUEUE_DISPATCH_RETRY_BACKOFF: Duration = Duration::from_millis(200);
const QUEUE_EMPTY_MESSAGE: &str = "queue is empty";
const QUEUE_USAGE_MESSAGE: &str = "usage: /queue [cancel [id|index]|clear]";
const QUEUE_CANCEL_USAGE_MESSAGE: &str = "usage: /queue cancel [id|index]";
const QUEUE_CLEAR_USAGE_MESSAGE: &str = "usage: /queue clear";

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
    if app.bang_input_mode {
        clear_input = handle_bang_command(app, child_stdin, next_id, &raw_input);
    } else if command == "/compact" {
        handle_compact_command(app, child_stdin, next_id, &trimmed, &mut parts);
    } else if command == "/model" {
        handle_model_command(app, child_stdin, next_id, &mut parts);
    } else if command == "/context" {
        handle_context_command(app, child_stdin, next_id, &mut parts);
    } else if command == "/skills" {
        handle_skills_command(app, child_stdin, next_id, &mut parts);
    } else if command == "/theme" {
        handle_theme_command(app, child_stdin, next_id, &mut parts);
    } else if command == "/mcp" {
        handle_mcp_command(app, child_stdin, next_id, &mut parts);
    } else if command == "/logout" {
        handle_logout_command(app, child_stdin, next_id, &trimmed, &mut parts);
    } else if command == "/lane" {
        handle_lane_command(app, child_stdin, next_id, &mut parts);
    } else if command == "/errors" {
        handle_errors_command(app, &mut parts);
    } else if command == "/queue" {
        handle_queue_command(app, &mut parts);
    } else if command == "/help" {
        handle_help_command(app, &mut parts);
    } else if trimmed.starts_with("!") {
        clear_input = handle_bang_command(app, child_stdin, next_id, &raw_input);
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
        app.push_error_report("send error", error.to_string());
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
        app.theme_list_panel = None;
        let id = next_id();
        app.pending_model_set_id = Some(id.clone());
        let (provider, name) = model
            .split_once('/')
            .map(|(provider, name)| (Some(provider), name))
            .unwrap_or((app.current_provider.as_deref(), model));
        if let Err(error) = send_model_set(child_stdin, &id, provider, name) {
            app.push_error_report("send error", error.to_string());
        }
        return;
    }

    app.model_list_panel = None;
    app.skills_list_panel = None;
    app.theme_list_panel = None;
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
    app.theme_list_panel = None;
    if let Err(error) = send_context_inspect(child_stdin, &id, include_agents, include_skills) {
        app.pending_context_inspect_id = None;
        app.push_error_report("send error", error.to_string());
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
    app.theme_list_panel = None;
    app.pending_skills_query = Some(query);
    app.pending_skills_scope = Some(scope_filter);
    let id = next_id();
    app.pending_skills_list_id = Some(id.clone());
    if let Err(error) = send_skills_list(child_stdin, &id, force_reload) {
        app.pending_skills_list_id = None;
        app.pending_skills_query = None;
        app.pending_skills_scope = None;
        app.push_error_report("send error", error.to_string());
    }
}

fn handle_theme_command<'a>(
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
        if !app.supports_theme_set {
            app.push_line(LogKind::Status, "Theme update unavailable");
            return;
        }
        if app.pending_theme_set_id.is_some() {
            app.push_line(LogKind::Status, "Theme update request already running");
            return;
        }
        let id = next_id();
        app.pending_theme_set_id = Some(id.clone());
        if let Err(error) = send_theme_set(child_stdin, &id, target.as_str()) {
            app.pending_theme_set_id = None;
            app.push_error_report("send error", error.to_string());
            return;
        }
        app.theme_list_panel = None;
        return;
    }

    let active = crate::app::view::theme::active_theme_name();

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
    app.theme_list_panel = None;
    if let Err(error) = send_mcp_list(child_stdin, &id, Some("loaded")) {
        app.pending_mcp_list_id = None;
        app.pending_mcp_detail_id = None;
        app.push_error_report("send error", error.to_string());
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

fn queue_age_label(queued_at: Instant, now: Instant) -> String {
    let elapsed = now.saturating_duration_since(queued_at).as_secs();
    if elapsed < 60 {
        return format!("{elapsed}s");
    }
    let minutes = elapsed / 60;
    let seconds = elapsed % 60;
    format!("{minutes}m{seconds:02}s")
}

fn parse_queue_index_token(token: &str) -> Option<usize> {
    let normalized = token.strip_prefix('#').unwrap_or(token);
    normalized
        .parse::<usize>()
        .ok()
        .and_then(|value| value.checked_sub(1))
}

fn handle_queue_cancel_target(app: &mut AppState, target: &str) {
    let trimmed = target.trim();
    if trimmed.is_empty() {
        app.push_line(LogKind::Error, QUEUE_CANCEL_USAGE_MESSAGE);
        return;
    }
    let index = parse_queue_index_token(trimmed);

    let removed = if let Some(index) = index {
        if index < app.pending_prompt_queue.len() {
            app.pending_prompt_queue.remove(index)
        } else {
            None
        }
    } else {
        let id = trimmed.to_ascii_lowercase();
        if let Some(position) = app
            .pending_prompt_queue
            .iter()
            .position(|item| item.queue_id.eq_ignore_ascii_case(&id))
        {
            app.pending_prompt_queue.remove(position)
        } else {
            None
        }
    };

    if let Some(item) = removed {
        app.push_line(
            LogKind::Status,
            format!(
                "Cancelled queued prompt {} (queue={})",
                item.queue_id,
                app.pending_prompt_queue.len()
            ),
        );
    } else {
        app.push_line(LogKind::Status, format!("Queue item not found: {trimmed}"));
    }
}

fn handle_queue_command<'a>(app: &mut AppState, parts: &mut impl Iterator<Item = &'a str>) {
    let Some(subcommand) = parts.next() else {
        if app.pending_prompt_queue.is_empty() {
            app.push_line(LogKind::Status, QUEUE_EMPTY_MESSAGE);
            return;
        }
        let now = Instant::now();
        app.push_line(
            LogKind::Status,
            format!(
                "queue: {} pending (showing first {})",
                app.pending_prompt_queue.len(),
                QUEUE_LIST_LIMIT.min(app.pending_prompt_queue.len())
            ),
        );
        let queue_rows = app
            .pending_prompt_queue
            .iter()
            .take(QUEUE_LIST_LIMIT)
            .enumerate()
            .map(|(index, item)| {
                format!(
                    "  {}. {} [{} ago] {}",
                    index + 1,
                    item.queue_id,
                    queue_age_label(item.queued_at, now),
                    item.preview
                )
            })
            .collect::<Vec<_>>();
        for row in queue_rows {
            app.push_line(LogKind::Status, row);
        }
        if app.pending_prompt_queue.len() > QUEUE_LIST_LIMIT {
            app.push_line(
                LogKind::Status,
                format!(
                    "  ... {} more",
                    app.pending_prompt_queue
                        .len()
                        .saturating_sub(QUEUE_LIST_LIMIT)
                ),
            );
        }
        return;
    };

    match subcommand {
        "cancel" => {
            if app.pending_prompt_queue.is_empty() {
                app.push_line(LogKind::Status, QUEUE_EMPTY_MESSAGE);
                return;
            }
            let rest = parts.collect::<Vec<_>>().join(" ");
            if rest.trim().is_empty() {
                if let Some(item) = app.pending_prompt_queue.pop_front() {
                    app.push_line(
                        LogKind::Status,
                        format!(
                            "Cancelled queued prompt {} (queue={})",
                            item.queue_id,
                            app.pending_prompt_queue.len()
                        ),
                    );
                }
                return;
            }
            handle_queue_cancel_target(app, &rest);
        }
        "clear" => {
            if parts.next().is_some() {
                app.push_line(LogKind::Error, QUEUE_CLEAR_USAGE_MESSAGE);
                return;
            }
            if app.pending_prompt_queue.is_empty() {
                app.push_line(LogKind::Status, QUEUE_EMPTY_MESSAGE);
                return;
            }
            let cleared = app.pending_prompt_queue.len();
            app.pending_prompt_queue.clear();
            app.push_line(LogKind::Status, format!("Cleared queue ({cleared} items)."));
        }
        _ => {
            app.push_line(LogKind::Error, QUEUE_USAGE_MESSAGE);
        }
    }
}

fn handle_errors_command<'a>(app: &mut AppState, parts: &mut impl Iterator<Item = &'a str>) {
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

fn handle_lane_command<'a>(
    app: &mut AppState,
    child_stdin: &mut RuntimeStdin,
    next_id: &mut impl FnMut() -> String,
    parts: &mut impl Iterator<Item = &'a str>,
) {
    if parts.next().is_some() {
        app.push_line(LogKind::Error, "usage: /lane");
        return;
    }
    if !app.supports_tool_call {
        app.push_line(LogKind::Status, "Lane commands unavailable");
        return;
    }
    app.model_list_panel = None;
    app.session_list_panel = None;
    app.context_panel = None;
    app.skills_list_panel = None;
    app.lane_list_panel = None;
    app.theme_list_panel = None;

    let id = next_id();
    app.pending_lane_list_id = Some(id.clone());
    if let Err(error) = send_tool_call(child_stdin, &id, "lane_list", json!({})) {
        app.pending_lane_list_id = None;
        app.push_error_report("send error", error.to_string());
    }
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
        app.push_error_report("send error", error.to_string());
    }
}

fn build_shell_result_prefix(results: &[PendingShellResult]) -> Option<String> {
    if results.is_empty() {
        return None;
    }
    let mut blocks = Vec::with_capacity(results.len());
    for result in results {
        let payload = json!({
            "id": result.id,
            "command_preview": result.command_preview,
            "exit_code": result.exit_code,
            "signal": result.signal,
            "duration_ms": result.duration_ms,
            "stdout": result.stdout,
            "stderr": result.stderr,
            "stdout_excerpt": result.stdout_excerpt,
            "stderr_excerpt": result.stderr_excerpt,
            "stdout_cache_id": result.stdout_cache_id,
            "stderr_cache_id": result.stderr_cache_id,
            "truncated": {
                "stdout": result.truncated_stdout,
                "stderr": result.truncated_stderr,
                "combined": result.truncated_combined,
            },
        });
        let json_text = payload
            .to_string()
            .replace('<', "\\u003c")
            .replace('>', "\\u003e");
        blocks.push(format!("<shell_result>\n{}\n</shell_result>", json_text));
    }
    Some(blocks.join("\n"))
}

fn resolve_bang_command(raw_input: &str, bang_mode: bool) -> String {
    let trimmed = raw_input.trim();
    if bang_mode {
        return trimmed.to_string();
    }
    if let Some(rest) = trimmed.strip_prefix('!') {
        return rest.trim().to_string();
    }
    trimmed.to_string()
}

fn handle_bang_command(
    app: &mut AppState,
    child_stdin: &mut RuntimeStdin,
    next_id: &mut impl FnMut() -> String,
    raw_input: &str,
) -> bool {
    if !app.supports_shell_exec {
        app.push_line(LogKind::Status, "Bang shell mode unavailable");
        return false;
    }
    if app.pending_shell_exec_id.is_some() {
        app.push_line(
            LogKind::Status,
            "Bang command is still running; wait for completion.",
        );
        return false;
    }
    let command = resolve_bang_command(raw_input, app.bang_input_mode);
    if command.is_empty() {
        app.push_line(LogKind::Error, "bang command is empty");
        return false;
    }
    let id = next_id();
    app.pending_shell_exec_id = Some(id.clone());
    app.push_line(LogKind::Status, format!("bang exec started: {}", command));
    if let Err(error) = send_shell_exec(child_stdin, &id, &command, None) {
        app.pending_shell_exec_id = None;
        app.push_line(LogKind::Error, format!("send error: {error}"));
        return false;
    }
    true
}

fn truncate_preview(text: &str, max: usize) -> String {
    if max == 0 {
        return String::new();
    }
    let count = text.chars().count();
    if count <= max {
        return text.to_string();
    }
    let take = max.saturating_sub(3);
    let truncated: String = text.chars().take(take).collect();
    format!("{truncated}...")
}

fn build_prompt_preview(input: &str) -> String {
    let first = input
        .lines()
        .map(str::trim)
        .find(|line| !line.is_empty())
        .unwrap_or_default();
    if first.is_empty() {
        return "(empty)".to_string();
    }
    truncate_preview(first, QUEUE_PREVIEW_MAX_CHARS)
}

fn make_prompt_submission(app: &AppState, raw_input: &str) -> PendingPromptRun {
    let user_text = raw_input.trim().to_string();
    let shell_result_count = app.pending_shell_results.len();
    let final_input =
        if let Some(shell_prefix) = build_shell_result_prefix(&app.pending_shell_results) {
            format!("{shell_prefix}\n\n{user_text}")
        } else {
            user_text.clone()
        };
    let attachment_count = referenced_attachment_ids(
        &user_text,
        &app.composer_nonce,
        &app.pending_image_attachments,
    )
    .len();
    let input_payload = build_run_input_payload(
        &final_input,
        &app.composer_nonce,
        &app.pending_image_attachments,
    );
    PendingPromptRun {
        queue_id: String::new(),
        queued_at: Instant::now(),
        preview: build_prompt_preview(&user_text),
        user_text,
        input_payload,
        attachment_count,
        shell_result_count,
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

fn dispatch_prompt_submission(
    app: &mut AppState,
    child_stdin: &mut RuntimeStdin,
    next_id: &mut impl FnMut() -> String,
    submission: &PendingPromptRun,
) -> bool {
    app.input.record_history(&submission.user_text);
    app.scroll_from_bottom = 0;
    app.last_assistant_text = None;
    push_user_prompt_lines(app, &submission.user_text);
    app.update_run_status("starting".to_string());
    let id = next_id();
    app.pending_run_start_id = Some(id.clone());
    if let Err(error) = send_run_start(
        child_stdin,
        &id,
        app.session_id.as_deref(),
        submission.input_payload.clone(),
        false,
    ) {
        app.pending_run_start_id = None;
        app.update_run_status("error".to_string());
        app.push_error_report("send error", error.to_string());
        return false;
    }
    true
}

pub(crate) fn can_dispatch_prompt_now(app: &AppState) -> bool {
    if app.pending_run_start_id.is_some() || app.pending_run_cancel_id.is_some() || app.is_running()
    {
        return false;
    }
    app.confirm_dialog.is_none()
        && app.pending_confirm_dialog.is_none()
        && app.prompt_dialog.is_none()
        && app.pick_dialog.is_none()
        && app.provider_picker.is_none()
        && app.model_picker.is_none()
        && app.model_list_panel.is_none()
        && app.session_list_panel.is_none()
        && app.lane_list_panel.is_none()
        && app.context_panel.is_none()
        && app.skills_list_panel.is_none()
        && app.theme_list_panel.is_none()
}

pub(crate) fn try_dispatch_queued_prompt(
    app: &mut AppState,
    child_stdin: &mut RuntimeStdin,
    next_id: &mut impl FnMut() -> String,
) -> bool {
    if app.dispatching_prompt.is_some() || app.pending_prompt_queue.is_empty() {
        return false;
    }
    if !can_dispatch_prompt_now(app) {
        return false;
    }
    if let Some(retry_at) = app.next_queue_dispatch_retry_at {
        if Instant::now() < retry_at {
            return false;
        }
    }

    let Some(next_prompt) = app.pending_prompt_queue.pop_front() else {
        return false;
    };
    let queue_id = next_prompt.queue_id.clone();
    app.dispatching_prompt = Some(next_prompt);

    let sent = if let Some(dispatching) = app.dispatching_prompt.clone() {
        dispatch_prompt_submission(app, child_stdin, next_id, &dispatching)
    } else {
        false
    };

    if sent {
        app.next_queue_dispatch_retry_at = None;
        app.push_line(
            LogKind::Status,
            format!(
                "Dispatching queued prompt {} (queue={})",
                queue_id,
                app.pending_prompt_queue.len()
            ),
        );
        return true;
    }

    if let Some(failed) = app.dispatching_prompt.take() {
        app.pending_prompt_queue.push_front(failed);
    }
    app.next_queue_dispatch_retry_at = Some(Instant::now() + QUEUE_DISPATCH_RETRY_BACKOFF);
    app.push_line(
        LogKind::Status,
        format!(
            "Queued prompt dispatch failed; will retry (queue={})",
            app.pending_prompt_queue.len()
        ),
    );
    true
}

pub(crate) fn start_prompt_run(
    app: &mut AppState,
    child_stdin: &mut RuntimeStdin,
    next_id: &mut impl FnMut() -> String,
    raw_input: &str,
) -> bool {
    // Keep a single submission path: always snapshot+enqueue first, then opportunistically
    // dispatch immediately when gates are open.
    let mut submission = make_prompt_submission(app, raw_input);
    if submission.user_text.is_empty() {
        return false;
    }

    let was_blocked = !can_dispatch_prompt_now(app);
    submission.queue_id = format!("q{}", app.next_prompt_queue_id);
    app.next_prompt_queue_id = app.next_prompt_queue_id.saturating_add(1);
    app.pending_prompt_queue.push_back(submission.clone());
    if submission.shell_result_count > 0 {
        app.pending_shell_results.clear();
    }

    if was_blocked {
        app.push_line(
            LogKind::Status,
            format!(
                "Queued prompt {} (queue={})",
                submission.queue_id,
                app.pending_prompt_queue.len()
            ),
        );
    }

    let _ = try_dispatch_queued_prompt(app, child_stdin, next_id);
    true
}

#[cfg(test)]
mod tests {
    use super::{
        build_shell_result_prefix, handle_enter, resolve_bang_command, try_dispatch_queued_prompt,
        QUEUE_EMPTY_MESSAGE,
    };
    use crate::app::util::attachments::make_attachment_token;
    use crate::app::{AppState, PendingShellResult};
    use std::io::{BufWriter, Write};
    use std::process::Stdio;

    fn with_runtime_writer<T>(f: impl FnOnce(&mut BufWriter<std::process::ChildStdin>) -> T) -> T {
        #[cfg(windows)]
        let mut command = {
            let mut command = std::process::Command::new("cmd");
            command.args(["/C", "more"]);
            command
        };
        #[cfg(not(windows))]
        let mut command = std::process::Command::new("cat");

        let mut child = command
            .stdin(Stdio::piped())
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .spawn()
            .expect("spawn runtime writer helper");

        let child_stdin = child.stdin.take().expect("child stdin");
        let mut runtime_writer = BufWriter::new(child_stdin);
        let out = f(&mut runtime_writer);

        let _ = runtime_writer.flush();
        let _ = child.kill();
        let _ = child.wait();
        out
    }

    #[test]
    fn shell_result_prefix_escapes_angle_brackets() {
        let result = PendingShellResult {
            id: "shell_1".to_string(),
            command_preview: "echo <tag>".to_string(),
            exit_code: Some(0),
            signal: None,
            duration_ms: 10,
            stdout: Some("ok".to_string()),
            stderr: None,
            stdout_excerpt: None,
            stderr_excerpt: None,
            stdout_cache_id: None,
            stderr_cache_id: None,
            truncated_stdout: false,
            truncated_stderr: false,
            truncated_combined: false,
        };
        let prefix = build_shell_result_prefix(&[result]).expect("prefix");
        assert!(prefix.contains("<shell_result>"));
        assert!(prefix.contains("\\u003ctag\\u003e"));
    }

    #[test]
    fn resolve_bang_command_strips_single_prefix_outside_mode() {
        assert_eq!(resolve_bang_command("!git status", false), "git status");
        assert_eq!(resolve_bang_command("!!echo", false), "!echo");
    }

    #[test]
    fn resolve_bang_command_uses_raw_text_in_bang_mode() {
        assert_eq!(resolve_bang_command("echo hi", true), "echo hi");
        assert_eq!(resolve_bang_command("!echo hi", true), "!echo hi");
    }

    #[test]
    fn enqueue_while_run_active_snapshots_payload_and_clears_shell_results_once() {
        with_runtime_writer(|writer| {
            let mut app = AppState::default();
            app.supports_shell_exec = true;
            app.update_run_status("running".to_string());
            app.pending_shell_results.push(PendingShellResult {
                id: "shell_1".to_string(),
                command_preview: "echo hi".to_string(),
                exit_code: Some(0),
                signal: None,
                duration_ms: 1,
                stdout: Some("hi".to_string()),
                stderr: None,
                stdout_excerpt: None,
                stderr_excerpt: None,
                stdout_cache_id: None,
                stderr_cache_id: None,
                truncated_stdout: false,
                truncated_stderr: false,
                truncated_combined: false,
            });

            let attachment_id = app.next_image_attachment_id();
            app.add_pending_image_attachment(
                attachment_id.clone(),
                crate::app::PendingImageAttachment {
                    data_url: "data:image/png;base64,AAAA".to_string(),
                    width: 10,
                    height: 10,
                    encoded_bytes: 1024,
                },
            );
            let token = make_attachment_token(&app.composer_nonce, &attachment_id);
            app.input.set_from(&format!("hello {token}"));

            let mut seq = 0_u64;
            let mut next_id = || {
                seq += 1;
                format!("id-{seq}")
            };
            assert!(handle_enter(&mut app, writer, &mut next_id));
            assert_eq!(app.pending_prompt_queue.len(), 1);
            assert!(app.pending_shell_results.is_empty());
            assert!(app.input.current().is_empty());
            assert!(app.pending_image_attachments.is_empty());

            let queued = app.pending_prompt_queue.front().expect("queued");
            assert_eq!(queued.shell_result_count, 1);
            assert_eq!(queued.attachment_count, 1);
            assert_eq!(queued.queue_id, "q1");
            let parts = queued
                .input_payload
                .get("parts")
                .and_then(|value| value.as_array())
                .expect("parts payload");
            assert!(parts
                .iter()
                .any(|part| part.get("type").and_then(|v| v.as_str()) == Some("image_url")));

            app.update_run_status("completed".to_string());
            assert!(try_dispatch_queued_prompt(&mut app, writer, &mut next_id));
            assert_eq!(app.pending_prompt_queue.len(), 0);
            assert!(app.dispatching_prompt.is_some());
            assert!(app.pending_run_start_id.is_some());
        });
    }

    #[test]
    fn queue_commands_cancel_and_clear() {
        with_runtime_writer(|writer| {
            let mut app = AppState::default();
            app.update_run_status("running".to_string());

            let mut seq = 0_u64;
            let mut next_id = || {
                seq += 1;
                format!("id-{seq}")
            };

            app.input.set_from("first");
            assert!(handle_enter(&mut app, writer, &mut next_id));
            app.input.set_from("second");
            assert!(handle_enter(&mut app, writer, &mut next_id));
            app.input.set_from("third");
            assert!(handle_enter(&mut app, writer, &mut next_id));
            assert_eq!(app.pending_prompt_queue.len(), 3);

            app.input.set_from("/queue cancel q2");
            assert!(handle_enter(&mut app, writer, &mut next_id));
            assert_eq!(app.pending_prompt_queue.len(), 2);
            assert_eq!(
                app.pending_prompt_queue
                    .iter()
                    .map(|item| item.queue_id.as_str())
                    .collect::<Vec<_>>(),
                vec!["q1", "q3"]
            );

            app.input.set_from("/queue cancel");
            assert!(handle_enter(&mut app, writer, &mut next_id));
            assert_eq!(app.pending_prompt_queue.len(), 1);
            assert_eq!(
                app.pending_prompt_queue
                    .front()
                    .map(|item| item.queue_id.as_str()),
                Some("q3")
            );

            app.input.set_from("/queue clear");
            assert!(handle_enter(&mut app, writer, &mut next_id));
            assert!(app.pending_prompt_queue.is_empty());

            app.input.set_from("/queue");
            assert!(handle_enter(&mut app, writer, &mut next_id));
            assert!(app
                .log
                .iter()
                .any(|line| line.plain_text().contains(QUEUE_EMPTY_MESSAGE)));
        });
    }

    #[test]
    fn queued_dispatch_is_fifo() {
        with_runtime_writer(|writer| {
            let mut app = AppState::default();
            app.update_run_status("running".to_string());

            let mut seq = 0_u64;
            let mut next_id = || {
                seq += 1;
                format!("id-{seq}")
            };

            app.input.set_from("first");
            assert!(handle_enter(&mut app, writer, &mut next_id));
            app.input.set_from("second");
            assert!(handle_enter(&mut app, writer, &mut next_id));
            assert_eq!(app.pending_prompt_queue.len(), 2);

            app.update_run_status("completed".to_string());
            assert!(try_dispatch_queued_prompt(&mut app, writer, &mut next_id));
            assert_eq!(
                app.dispatching_prompt
                    .as_ref()
                    .map(|item| item.queue_id.as_str()),
                Some("q1")
            );
            assert_eq!(
                app.pending_prompt_queue
                    .front()
                    .map(|item| item.queue_id.as_str()),
                Some("q2")
            );

            app.dispatching_prompt = None;
            app.pending_run_start_id = None;
            app.update_run_status("completed".to_string());
            assert!(try_dispatch_queued_prompt(&mut app, writer, &mut next_id));
            assert_eq!(
                app.dispatching_prompt
                    .as_ref()
                    .map(|item| item.queue_id.as_str()),
                Some("q2")
            );
        });
    }

    #[test]
    fn idle_submit_still_dispatches_immediately_via_queue_path() {
        with_runtime_writer(|writer| {
            let mut app = AppState::default();
            let mut seq = 0_u64;
            let mut next_id = || {
                seq += 1;
                format!("id-{seq}")
            };

            app.input.set_from("hello");
            assert!(handle_enter(&mut app, writer, &mut next_id));
            assert!(app.pending_prompt_queue.is_empty());
            assert!(app.dispatching_prompt.is_some());
            assert!(app.pending_run_start_id.is_some());
        });
    }
}
