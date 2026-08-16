use std::env;

use crate::entry::terminal_mode::RequestedTerminalMode;

#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) enum ResumeMode {
    None,
    Picker,
    Id(String),
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum BasicCliMode {
    Run,
    Help,
    Version,
}

pub(crate) fn parse_basic_cli_mode() -> BasicCliMode {
    parse_basic_cli_mode_from_args(env::args().skip(1))
}

pub(crate) fn parse_basic_cli_mode_from_args(
    args: impl IntoIterator<Item = impl AsRef<str>>,
) -> BasicCliMode {
    for arg in args {
        let value = arg.as_ref();
        if value == "-h" || value == "--help" {
            return BasicCliMode::Help;
        }
        if value == "-V" || value == "-v" || value == "--version" {
            return BasicCliMode::Version;
        }
    }
    BasicCliMode::Run
}

pub(crate) fn resolve_version_label() -> String {
    let tui_version = env!("CARGO_PKG_VERSION");
    let cli_version = env::var("CODELIA_CLI_VERSION").ok();
    resolve_version_label_from_versions(cli_version.as_deref(), tui_version)
}

pub(crate) fn resolve_version_label_from_versions(
    cli_version: Option<&str>,
    _tui_version: &str,
) -> String {
    let normalized = cli_version.map(str::trim).filter(|value| !value.is_empty());
    match normalized {
        Some(cli) => format!("codelia {cli}"),
        None => "codelia".to_string(),
    }
}

pub(crate) fn print_basic_help() {
    println!("usage: codelia-tui [options]");
    println!();
    println!("options:");
    println!("  -h, --help                       Show this help");
    println!("  -V, -v, --version                Show version");
    println!("  --debug[=true|false]             Enable debug runtime/RPC log lines");
    println!("  --diagnostics[=true|false]       Enable per-call LLM diagnostics");
    println!("  -r, --resume [session_id]        Resume latest/session picker/session id");
    println!("  --initial-message <text>         Queue initial prompt");
    println!("  --initial-user-message <text>    Alias of --initial-message");
    println!("  --tui-mode <mode>                Terminal mode: auto (default), inline, alternate");
    println!("  --debug-perf[=true|false]        Enable perf panel");
}

pub(crate) fn parse_terminal_mode() -> Result<RequestedTerminalMode, String> {
    let env_value = env::var("CODELIA_TUI_MODE").ok();
    parse_terminal_mode_from_args(env::args().skip(1), env_value.as_deref())
}

pub(crate) fn parse_terminal_mode_from_args(
    args: impl IntoIterator<Item = impl AsRef<str>>,
    env_value: Option<&str>,
) -> Result<RequestedTerminalMode, String> {
    let mut args = args
        .into_iter()
        .map(|arg| arg.as_ref().to_string())
        .peekable();
    let mut selected = None;

    while let Some(arg) = args.next() {
        if let Some(value) = arg.strip_prefix("--tui-mode=") {
            selected = Some(parse_terminal_mode_value(value, "--tui-mode")?);
            continue;
        }
        if arg == "--tui-mode" {
            let Some(value) = args.next() else {
                return Err(terminal_mode_missing_value("--tui-mode"));
            };
            if value.starts_with('-') {
                return Err(terminal_mode_missing_value("--tui-mode"));
            }
            selected = Some(parse_terminal_mode_value(&value, "--tui-mode")?);
        }
    }

    if let Some(selected) = selected {
        return Ok(selected);
    }
    match env_value {
        Some(value) => parse_terminal_mode_value(value, "CODELIA_TUI_MODE"),
        None => Ok(RequestedTerminalMode::default()),
    }
}

fn parse_terminal_mode_value(value: &str, source: &str) -> Result<RequestedTerminalMode, String> {
    if value.trim().is_empty() {
        return Err(terminal_mode_missing_value(source));
    }
    value
        .parse()
        .map_err(|_| format!("{source} must be one of: auto, inline, alternate"))
}

fn terminal_mode_missing_value(source: &str) -> String {
    format!("{source} requires a value: auto, inline, or alternate")
}

pub(crate) fn parse_resume_mode() -> ResumeMode {
    parse_resume_mode_from_args(env::args().skip(1))
}

pub(crate) fn parse_resume_mode_from_args(
    args: impl IntoIterator<Item = impl AsRef<str>>,
) -> ResumeMode {
    let mut args = args
        .into_iter()
        .map(|arg| arg.as_ref().to_string())
        .peekable();
    let mut mode = ResumeMode::None;
    while let Some(arg) = args.next() {
        if let Some(value) = arg.strip_prefix("--resume=") {
            mode = ResumeMode::Id(value.to_string());
            continue;
        }
        if arg == "-r" || arg == "--resume" {
            match args.peek() {
                Some(next) if !next.starts_with('-') => {
                    mode = ResumeMode::Id(next.to_string());
                    let _ = args.next();
                }
                _ => {
                    mode = ResumeMode::Picker;
                }
            }
        }
    }
    mode
}

pub(crate) fn parse_initial_message() -> Option<String> {
    parse_initial_message_from_args(env::args().skip(1))
}

pub(crate) fn parse_approval_mode() -> Result<Option<String>, String> {
    parse_approval_mode_from_args(env::args().skip(1))
}

pub(crate) fn parse_approval_mode_from_args(
    args: impl IntoIterator<Item = impl AsRef<str>>,
) -> Result<Option<String>, String> {
    let mut args = args
        .into_iter()
        .map(|arg| arg.as_ref().to_string())
        .peekable();
    while let Some(arg) = args.next() {
        if let Some(value) = arg.strip_prefix("--approval-mode=") {
            let trimmed = value.trim();
            if trimmed.is_empty() {
                return Err(
                    "--approval-mode requires a value (minimal|trusted|full-access)".to_string(),
                );
            }
            return Ok(Some(trimmed.to_string()));
        }
        if arg == "--approval-mode" {
            let Some(next) = args.next() else {
                return Err(
                    "--approval-mode requires a value (minimal|trusted|full-access)".to_string(),
                );
            };
            let trimmed = next.trim();
            if trimmed.is_empty() {
                return Err(
                    "--approval-mode requires a value (minimal|trusted|full-access)".to_string(),
                );
            }
            return Ok(Some(trimmed.to_string()));
        }
    }
    Ok(None)
}

pub(crate) fn parse_initial_message_from_args(
    args: impl IntoIterator<Item = impl AsRef<str>>,
) -> Option<String> {
    let mut args = args
        .into_iter()
        .map(|arg| arg.as_ref().to_string())
        .peekable();
    let mut message: Option<String> = None;
    while let Some(arg) = args.next() {
        if let Some(value) = arg.strip_prefix("--initial-message=") {
            message = Some(value.to_string());
            continue;
        }
        if let Some(value) = arg.strip_prefix("--initial-user-message=") {
            message = Some(value.to_string());
            continue;
        }
        if arg == "--initial-message" || arg == "--initial-user-message" {
            if let Some(next) = args.peek() {
                if !next.starts_with('-') {
                    message = Some(next.to_string());
                    let _ = args.next();
                }
            }
        }
    }
    message.filter(|value| !value.trim().is_empty())
}

fn parse_bool_like(value: &str) -> Option<bool> {
    match value.trim().to_ascii_lowercase().as_str() {
        "1" | "true" | "yes" | "on" => Some(true),
        "0" | "false" | "no" | "off" => Some(false),
        _ => None,
    }
}

pub(crate) fn cli_flag_enabled_from_args(
    flag: &str,
    args: impl IntoIterator<Item = impl AsRef<str>>,
) -> bool {
    args.into_iter().any(|arg| {
        let value = arg.as_ref();
        if value == flag {
            return true;
        }
        let prefix = format!("{flag}=");
        if let Some(raw) = value.strip_prefix(&prefix) {
            return parse_bool_like(raw).unwrap_or(false);
        }
        false
    })
}

pub(crate) fn cli_flag_enabled(flag: &str) -> bool {
    cli_flag_enabled_from_args(flag, env::args().skip(1))
}

fn env_truthy(key: &str) -> bool {
    std::env::var(key)
        .ok()
        .as_deref()
        .map(|value| value == "1" || value.eq_ignore_ascii_case("true"))
        .unwrap_or(false)
}

pub(crate) fn debug_print_enabled() -> bool {
    cli_flag_enabled("--debug") || env_truthy("CODELIA_DEBUG")
}

pub(crate) fn debug_perf_enabled() -> bool {
    cli_flag_enabled("--debug-perf") || env_truthy("CODELIA_DEBUG_PERF")
}

pub(crate) fn diagnostics_enabled() -> bool {
    cli_flag_enabled("--diagnostics") || env_truthy("CODELIA_DIAGNOSTICS")
}

#[cfg(test)]
mod tests {
    use super::parse_terminal_mode_from_args;
    use crate::entry::terminal_mode::RequestedTerminalMode;

    #[test]
    fn terminal_mode_supports_split_equals_and_case_insensitive_values() {
        assert_eq!(
            parse_terminal_mode_from_args(["--tui-mode", "inline"], None),
            Ok(RequestedTerminalMode::Inline)
        );
        assert_eq!(
            parse_terminal_mode_from_args(["--tui-mode=ALTERNATE"], None),
            Ok(RequestedTerminalMode::Alternate)
        );
        assert_eq!(
            parse_terminal_mode_from_args(["--debug"], None),
            Ok(RequestedTerminalMode::Auto)
        );
    }

    #[test]
    fn terminal_mode_prefers_cli_over_environment() {
        assert_eq!(
            parse_terminal_mode_from_args(["--tui-mode=inline"], Some("alternate")),
            Ok(RequestedTerminalMode::Inline)
        );
        assert_eq!(
            parse_terminal_mode_from_args(["--debug"], Some("alternate")),
            Ok(RequestedTerminalMode::Alternate)
        );
    }

    #[test]
    fn terminal_mode_rejects_missing_and_unknown_values() {
        assert!(parse_terminal_mode_from_args(["--tui-mode"], None).is_err());
        assert!(parse_terminal_mode_from_args(["--tui-mode", "--debug"], None).is_err());
        assert!(parse_terminal_mode_from_args(["--tui-mode=fullscreen"], None).is_err());
        assert!(parse_terminal_mode_from_args(["--debug"], Some("regular")).is_err());
    }
}
