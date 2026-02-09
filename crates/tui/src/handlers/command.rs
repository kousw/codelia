use crate::app::{
    AppState, ModelListMode, ProviderPickerState, SkillsListItemState, SkillsScopeFilter,
};
use crate::input::InputState;
use crate::model::LogKind;
use crate::runtime::{
    send_auth_logout, send_context_inspect, send_mcp_list, send_model_set, send_run_start,
    send_skills_list,
};
use std::collections::BTreeSet;
use std::io::BufWriter;
use std::process::ChildStdin;

const MODEL_PROVIDERS: &[&str] = &["openai", "anthropic"];
const COMMAND_SUGGESTION_LIMIT: usize = 6;

#[derive(Clone, Copy)]
struct SlashCommandSpec {
    command: &'static str,
    usage: &'static str,
    summary: &'static str,
}

const SLASH_COMMANDS: &[SlashCommandSpec] = &[
    SlashCommandSpec {
        command: "/help",
        usage: "/help",
        summary: "Show this help",
    },
    SlashCommandSpec {
        command: "/compact",
        usage: "/compact",
        summary: "Force compaction run",
    },
    SlashCommandSpec {
        command: "/model",
        usage: "/model [provider/]name",
        summary: "Set model or open model picker",
    },
    SlashCommandSpec {
        command: "/context",
        usage: "/context [brief]",
        summary: "Show context snapshot",
    },
    SlashCommandSpec {
        command: "/skills",
        usage: "/skills [query] [all|repo|user] [--reload]",
        summary: "Open skills picker",
    },
    SlashCommandSpec {
        command: "/mcp",
        usage: "/mcp [server-id]",
        summary: "Show MCP server status",
    },
    SlashCommandSpec {
        command: "/logout",
        usage: "/logout",
        summary: "Clear local auth and reset current session",
    },
];

type RuntimeStdin = BufWriter<ChildStdin>;

fn find_command(command: &str) -> Option<&'static SlashCommandSpec> {
    SLASH_COMMANDS.iter().find(|spec| spec.command == command)
}

fn command_suggestions(prefix: &str, limit: usize) -> Vec<&'static SlashCommandSpec> {
    if !prefix.starts_with('/') {
        return Vec::new();
    }

    let mut matches = SLASH_COMMANDS
        .iter()
        .filter(|spec| spec.command.starts_with(prefix))
        .collect::<Vec<_>>();

    // Prefix miss such as `/models` should still hint `/model`.
    if matches.is_empty() {
        matches = SLASH_COMMANDS
            .iter()
            .filter(|spec| prefix.starts_with(spec.command))
            .collect::<Vec<_>>();
    }

    matches.truncate(limit);
    matches
}

fn longest_common_prefix(values: &[&str]) -> String {
    let Some(first) = values.first() else {
        return String::new();
    };
    let mut prefix = (*first).to_string();
    for value in values.iter().skip(1) {
        let mut next = String::new();
        for (a, b) in prefix.chars().zip(value.chars()) {
            if a != b {
                break;
            }
            next.push(a);
        }
        prefix = next;
        if prefix.is_empty() {
            break;
        }
    }
    prefix
}

pub(crate) fn command_suggestion_rows(prefix: &str, limit: usize) -> Vec<String> {
    command_suggestions(prefix, limit)
        .into_iter()
        .map(|spec| format!("{:<22} {}", spec.usage, spec.summary))
        .collect()
}

fn trailing_token_range(value: &str) -> Option<(usize, usize)> {
    if value.is_empty() {
        return None;
    }
    let end = value.len();
    let start = value
        .char_indices()
        .rev()
        .find_map(|(idx, ch)| ch.is_whitespace().then_some(idx + ch.len_utf8()))
        .unwrap_or(0);
    if start >= end {
        return None;
    }
    Some((start, end))
}

pub(crate) fn active_skill_mention_token(value: &str) -> Option<String> {
    let (start, end) = trailing_token_range(value)?;
    let token = &value[start..end];
    if !token.starts_with('$') {
        return None;
    }
    let body = &token[1..];
    if !body
        .chars()
        .all(|ch| ch.is_ascii_lowercase() || ch.is_ascii_digit() || ch == '-')
    {
        return None;
    }
    Some(token.to_string())
}

fn unique_enabled_skill_names(skills: &[SkillsListItemState]) -> Vec<String> {
    let mut names = BTreeSet::new();
    for skill in skills {
        if !skill.enabled {
            continue;
        }
        if !skill.name.is_empty() {
            names.insert(skill.name.to_lowercase());
        }
    }
    names.into_iter().collect()
}

fn matching_skill_names(prefix: &str, skills: &[SkillsListItemState], limit: usize) -> Vec<String> {
    let prefix = prefix.to_lowercase();
    let mut names = unique_enabled_skill_names(skills)
        .into_iter()
        .filter(|name| name.starts_with(&prefix))
        .collect::<Vec<_>>();
    names.truncate(limit);
    names
}

pub(crate) fn skill_suggestion_rows(
    token: &str,
    skills: &[SkillsListItemState],
    limit: usize,
) -> Vec<String> {
    let prefix = token.strip_prefix('$').unwrap_or(token);
    let names = matching_skill_names(prefix, skills, limit);
    names
        .into_iter()
        .map(|name| {
            let (scope, description) = skills
                .iter()
                .find(|skill| skill.enabled && skill.name.eq_ignore_ascii_case(&name))
                .map(|skill| (skill.scope.as_str(), skill.description.as_str()))
                .unwrap_or(("user", ""));
            format!("${:<24} [{:<4}] {}", name, scope, description)
        })
        .collect()
}

fn complete_command_text(value: &str) -> Option<String> {
    let token_start = value
        .char_indices()
        .find_map(|(idx, ch)| (!ch.is_whitespace()).then_some(idx))?;
    if !value[token_start..].starts_with('/') {
        return None;
    }

    let token_end = value[token_start..]
        .char_indices()
        .find_map(|(idx, ch)| ch.is_whitespace().then_some(token_start + idx))
        .unwrap_or(value.len());
    if token_end < value.len() {
        return None;
    }

    let token = &value[token_start..token_end];
    if token.is_empty() {
        return None;
    }

    let matches = command_suggestions(token, SLASH_COMMANDS.len());
    if matches.is_empty() {
        return None;
    }

    let completed = if matches.len() == 1 {
        matches[0].command.to_string()
    } else {
        let commands = matches.iter().map(|spec| spec.command).collect::<Vec<_>>();
        let prefix = longest_common_prefix(&commands);
        if prefix.chars().count() <= token.chars().count() {
            return None;
        }
        prefix
    };

    let mut out = String::new();
    out.push_str(&value[..token_start]);
    out.push_str(&completed);
    if matches.len() == 1 {
        out.push(' ');
    }
    Some(out)
}

pub(crate) fn complete_slash_command(input: &mut InputState) -> bool {
    let current = input.current();
    let Some(completed) = complete_command_text(&current) else {
        return false;
    };
    if completed == current {
        return false;
    }
    input.set_from(&completed);
    true
}

fn complete_skill_mention_text(value: &str, skills: &[SkillsListItemState]) -> Option<String> {
    let (token_start, token_end) = trailing_token_range(value)?;
    if token_end < value.len() {
        return None;
    }
    let token = &value[token_start..token_end];
    let prefix = token.strip_prefix('$')?;
    if !prefix
        .chars()
        .all(|ch| ch.is_ascii_lowercase() || ch.is_ascii_digit() || ch == '-')
    {
        return None;
    }

    let matches = matching_skill_names(prefix, skills, usize::MAX);
    if matches.is_empty() {
        return None;
    }

    let completed = if matches.len() == 1 {
        matches[0].clone()
    } else {
        let names = matches.iter().map(|name| name.as_str()).collect::<Vec<_>>();
        let common = longest_common_prefix(&names);
        if common.chars().count() <= prefix.chars().count() {
            return None;
        }
        common
    };

    let mut out = String::new();
    out.push_str(&value[..token_start]);
    out.push('$');
    out.push_str(&completed);
    if matches.len() == 1 {
        out.push(' ');
    }
    Some(out)
}

pub(crate) fn complete_skill_mention(
    input: &mut InputState,
    skills: &[SkillsListItemState],
) -> bool {
    let current = input.current();
    let Some(completed) = complete_skill_mention_text(&current, skills) else {
        return false;
    };
    if completed == current {
        return false;
    }
    input.set_from(&completed);
    true
}

fn unknown_command_message(command: &str) -> String {
    let suggestions = command_suggestions(command, 2)
        .into_iter()
        .map(|spec| spec.command)
        .collect::<Vec<_>>();
    if suggestions.is_empty() {
        return format!("command not found: {command} (type /help)");
    }
    if suggestions.len() == 1 {
        return format!(
            "command not found: {command} (did you mean {}?)",
            suggestions[0]
        );
    }
    format!(
        "command not found: {command} (did you mean {} or {}?)",
        suggestions[0], suggestions[1]
    )
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
    } else if command == "/help" {
        handle_help_command(app, &mut parts);
    } else if find_command(command).is_none() && command.starts_with('/') {
        app.push_line(LogKind::Error, unknown_command_message(command));
        clear_input = false;
    } else {
        start_prompt_run(app, child_stdin, next_id, &raw_input);
    }

    if clear_input {
        app.input.clear();
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
    if let Err(error) = send_run_start(child_stdin, &id, app.session_id.as_deref(), "", true) {
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
    app.push_line(LogKind::User, " ");
    for (index, line) in message.lines().enumerate() {
        let prefix = if index == 0 { "> " } else { "  " };
        app.push_line(LogKind::User, format!("{prefix}{line}"));
    }
    app.push_line(LogKind::User, " ");
}

fn start_prompt_run(
    app: &mut AppState,
    child_stdin: &mut RuntimeStdin,
    next_id: &mut impl FnMut() -> String,
    trimmed: &str,
) {
    if app.pending_run_start_id.is_some() || app.pending_run_cancel_id.is_some() || app.is_running()
    {
        app.push_line(
            LogKind::Status,
            "Run is still active; wait for completion before sending the next prompt.",
        );
        return;
    }
    app.input.record_history(trimmed);
    app.scroll_from_bottom = 0;
    app.last_assistant_text = None;
    push_user_prompt_lines(app, trimmed);
    app.update_run_status("starting".to_string());
    let id = next_id();
    app.pending_run_start_id = Some(id.clone());
    if let Err(error) = send_run_start(child_stdin, &id, app.session_id.as_deref(), trimmed, false)
    {
        app.pending_run_start_id = None;
        app.update_run_status("error".to_string());
        app.push_line(LogKind::Error, format!("send error: {error}"));
    }
}

#[cfg(test)]
mod tests {
    use super::{
        active_skill_mention_token, command_suggestion_rows, complete_command_text,
        complete_skill_mention_text, longest_common_prefix, skill_suggestion_rows,
        unknown_command_message,
    };
    use crate::app::SkillsListItemState;

    fn skill_item(name: &str, description: &str, enabled: bool) -> SkillsListItemState {
        SkillsListItemState {
            name: name.to_string(),
            description: description.to_string(),
            path: format!("/tmp/{name}/SKILL.md"),
            scope: "repo".to_string(),
            enabled,
        }
    }

    #[test]
    fn command_suggestions_include_model_for_models_typo() {
        let rows = command_suggestion_rows("/models", 3);
        assert!(rows.iter().any(|row| row.contains("/model")));
    }

    #[test]
    fn command_suggestions_include_skills_prefix() {
        let rows = command_suggestion_rows("/sk", 3);
        assert!(rows.iter().any(|row| row.contains("/skills")));
    }

    #[test]
    fn unknown_command_message_with_hint() {
        let message = unknown_command_message("/models");
        assert!(message.contains("did you mean /model?"));
    }

    #[test]
    fn unknown_command_message_without_hint() {
        let message = unknown_command_message("/totally-unknown");
        assert!(message.contains("command not found: /totally-unknown"));
        assert!(message.contains("type /help"));
    }

    #[test]
    fn tab_completion_unique_match_adds_space() {
        let completed = complete_command_text("/log").expect("completion");
        assert_eq!(completed, "/logout ");
    }

    #[test]
    fn tab_completion_common_prefix() {
        let completed = complete_command_text("/c").expect("completion");
        assert_eq!(completed, "/co");
    }

    #[test]
    fn tab_completion_no_change_when_already_max_common_prefix() {
        let completed = complete_command_text("/co");
        assert!(completed.is_none());
    }

    #[test]
    fn tab_completion_ignores_non_command_input() {
        let completed = complete_command_text("hello");
        assert!(completed.is_none());
    }

    #[test]
    fn longest_prefix_empty_for_no_values() {
        assert_eq!(longest_common_prefix(&[]), "");
    }

    #[test]
    fn skill_suggestions_for_trailing_token() {
        let token = active_skill_mention_token("please use $co").expect("token");
        assert_eq!(token, "$co");
    }

    #[test]
    fn skill_suggestions_none_without_dollar_prefix() {
        assert!(active_skill_mention_token("please use co").is_none());
    }

    #[test]
    fn skill_suggestion_rows_match_prefix() {
        let skills = vec![
            skill_item("code-refactoring", "Refactoring best practices", true),
            skill_item("code-simplifier", "Simplify code", true),
            skill_item("jujutsu", "Version control", true),
        ];
        let rows = skill_suggestion_rows("$code", &skills, 6);
        assert!(rows.iter().any(|row| row.contains("$code-refactoring")));
        assert!(rows.iter().any(|row| row.contains("$code-simplifier")));
        assert!(!rows.iter().any(|row| row.contains("$jujutsu")));
    }

    #[test]
    fn tab_completion_skill_unique_adds_space() {
        let skills = vec![skill_item("code-refactoring", "Refactoring", true)];
        let completed =
            complete_skill_mention_text("please use $code-r", &skills).expect("completion");
        assert_eq!(completed, "please use $code-refactoring ");
    }

    #[test]
    fn tab_completion_skill_common_prefix() {
        let skills = vec![
            skill_item("code-refactoring", "Refactoring", true),
            skill_item("code-review", "Review", true),
        ];
        let completed = complete_skill_mention_text("$code-", &skills).expect("completion");
        assert_eq!(completed, "$code-re");
        let completed = complete_skill_mention_text("$co", &skills).expect("completion");
        assert_eq!(completed, "$code-re");
    }

    #[test]
    fn tab_completion_skill_ignores_disabled() {
        let skills = vec![
            skill_item("code-refactoring", "Refactoring", false),
            skill_item("code-review", "Review", true),
        ];
        let completed = complete_skill_mention_text("$code-r", &skills).expect("completion");
        assert_eq!(completed, "$code-review ");
    }
}
