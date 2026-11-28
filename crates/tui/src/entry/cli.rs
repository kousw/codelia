use std::env;

use crate::app::util::debug::debug_config;
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
    let ctx = crate::entry::launch_context::launch_context();
    resolve_version_label_with_builds(
        ctx.cli_version.as_deref(),
        tui_version,
        ctx.cli_build.as_deref(),
        option_env!("CODELIA_TUI_BUILD"),
    )
}

#[cfg(test)]
pub(crate) fn resolve_version_label_from_versions(
    cli_version: Option<&str>,
    tui_version: &str,
) -> String {
    resolve_version_label_with_builds(cli_version, tui_version, None, None)
}

pub(crate) fn resolve_version_label_with_builds(
    cli_version: Option<&str>,
    _tui_version: &str,
    cli_build: Option<&str>,
    tui_build: Option<&str>,
) -> String {
    let normalized = cli_version.map(str::trim).filter(|value| !value.is_empty());
    let base = match normalized {
        Some(cli) => format!("codelia {cli}"),
        None => "codelia".to_string(),
    };
    let cli_id = cli_build.map(str::trim).filter(|value| !value.is_empty());
    let tui_id = tui_build.map(str::trim).filter(|value| !value.is_empty());
    match (cli_id, tui_id) {
        (Some(cli), Some(tui)) if cli == tui => format!("{base} (dev {cli})"),
        (Some(cli), Some(tui)) => format!("{base} (dev cli:{cli} tui:{tui})"),
        (Some(cli), None) => format!("{base} (dev cli:{cli})"),
        (None, Some(tui)) => format!("{base} (dev tui:{tui})"),
        (None, None) => base,
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
    println!(
        "  --color-scheme <dark|light>      Terminal palette scheme (overrides tui.color_scheme)"
    );
    println!(
        "  --image-protocol <mode>          Image preview protocol: halfblocks (default), kitty"
    );
    println!("  --debug-perf[=true|false]        Enable perf panel");
    println!("  --sandbox-mode <mode>            readonly, workspace-write, or full-access");
}

pub(crate) fn parse_terminal_mode() -> Result<RequestedTerminalMode, String> {
    parse_terminal_mode_from_args(env::args().skip(1))
}

pub(crate) fn parse_terminal_mode_from_args(
    args: impl IntoIterator<Item = impl AsRef<str>>,
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

    Ok(selected.unwrap_or_default())
}

pub(crate) fn parse_color_scheme_arg() -> Result<Option<String>, String> {
    parse_mode_value(env::args().skip(1), "--color-scheme", "dark|light")
}

pub(crate) fn parse_image_protocol_arg() -> Result<Option<String>, String> {
    parse_mode_value(env::args().skip(1), "--image-protocol", "halfblocks|kitty")
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

pub(crate) fn parse_sandbox_mode_arg() -> Result<Option<(&'static str, String)>, String> {
    parse_sandbox_mode_arg_from_args(env::args().skip(1))
}

pub(crate) fn parse_sandbox_mode_arg_from_args(
    args: impl IntoIterator<Item = impl AsRef<str>>,
) -> Result<Option<(&'static str, String)>, String> {
    Ok(parse_mode_value(
        args,
        "--sandbox-mode",
        "readonly|workspace-write|full-access",
    )?
    .map(|value| ("--sandbox-mode", value)))
}

fn parse_mode_value(
    args: impl IntoIterator<Item = impl AsRef<str>>,
    flag: &str,
    values: &str,
) -> Result<Option<String>, String> {
    let mut args = args.into_iter();
    while let Some(arg) = args.next() {
        let arg = arg.as_ref();
        if matches!(
            arg,
            "--initial-message"
                | "--initial-user-message"
                | "--tui-mode"
                | "--color-scheme"
                | "--image-protocol"
                | "--sandbox-mode"
        ) && arg != flag
        {
            let _ = args.next();
            continue;
        }
        let selected = if arg == flag {
            args.next()
                .map(|value| value.as_ref().trim().to_owned())
                .unwrap_or_default()
        } else if let Some(value) = arg
            .strip_prefix(flag)
            .and_then(|suffix| suffix.strip_prefix('='))
        {
            value.trim().to_owned()
        } else {
            continue;
        };
        if selected.is_empty() {
            return Err(format!("{flag} requires a value ({values})"));
        }
        if !values.split('|').any(|value| value == selected) {
            return Err(format!("Invalid {flag} (expected {values})"));
        }
        return Ok(Some(selected));
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
            message = args.next();
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

pub(crate) fn debug_print_enabled() -> bool {
    cli_flag_enabled("--debug") || debug_config().debug
}

pub(crate) fn debug_perf_enabled() -> bool {
    cli_flag_enabled("--debug-perf") || debug_config().perf
}

pub(crate) fn diagnostics_enabled() -> bool {
    cli_flag_enabled("--diagnostics") || debug_config().diagnostics
}

#[cfg(test)]
mod tests {
    use super::parse_terminal_mode_from_args;
    use crate::entry::terminal_mode::RequestedTerminalMode;

    #[test]
    fn terminal_mode_supports_split_equals_and_case_insensitive_values() {
        assert_eq!(
            parse_terminal_mode_from_args(["--tui-mode", "inline"]),
            Ok(RequestedTerminalMode::Inline)
        );
        assert_eq!(
            parse_terminal_mode_from_args(["--tui-mode=ALTERNATE"]),
            Ok(RequestedTerminalMode::Alternate)
        );
        assert_eq!(
            parse_terminal_mode_from_args(["--debug"]),
            Ok(RequestedTerminalMode::Auto)
        );
    }

    #[test]
    fn terminal_mode_rejects_missing_and_unknown_values() {
        assert!(parse_terminal_mode_from_args(["--tui-mode"]).is_err());
        assert!(parse_terminal_mode_from_args(["--tui-mode", "--debug"]).is_err());
        assert!(parse_terminal_mode_from_args(["--tui-mode=fullscreen"]).is_err());
    }
}
