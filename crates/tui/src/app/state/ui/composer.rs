use crate::app::state::InputState;
use std::collections::BTreeSet;

use super::skills::SkillsListItemState;

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
        usage: "/skills [query] [all|repo|user] [--reload] [--scope <all|repo|user>]",
        summary: "Open skills picker",
    },
    SlashCommandSpec {
        command: "/theme",
        usage: "/theme [theme-name]",
        summary: "Choose and save TUI theme",
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
    SlashCommandSpec {
        command: "/lane",
        usage: "/lane",
        summary: "Open lane interactive flow",
    },
    SlashCommandSpec {
        command: "/errors",
        usage: "/errors [summary|detail|show]",
        summary: "Control error detail rendering",
    },
    SlashCommandSpec {
        command: "/queue",
        usage: "/queue [cancel [id|index]|clear]",
        summary: "Inspect/cancel/clear queued prompts",
    },
];

fn find_command(command: &str) -> Option<&'static SlashCommandSpec> {
    SLASH_COMMANDS.iter().find(|spec| spec.command == command)
}

pub(crate) fn is_known_command(command: &str) -> bool {
    find_command(command).is_some()
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

pub(crate) fn unknown_command_message(command: &str) -> String {
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
    fn command_suggestions_include_errors_command() {
        let rows = command_suggestion_rows("/err", 3);
        assert!(rows.iter().any(|row| row.contains("/errors")));
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
