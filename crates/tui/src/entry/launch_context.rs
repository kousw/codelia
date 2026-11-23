//! Private launcher -> TUI handoff.
//!
//! The `codelia` launcher passes values it owns as one JSON argument instead of
//! environment variables, so they do not leak into the runtime and its
//! children. The TUI never reads these values from the environment.

use serde::Deserialize;
use std::env;
use std::sync::OnceLock;

pub(crate) const LAUNCH_CONTEXT_FLAG: &str = "--internal-launch-context";

#[derive(Debug, Default, Clone, PartialEq, Eq, Deserialize)]
pub(crate) struct RuntimeLaunch {
    pub(crate) command: String,
    #[serde(default)]
    pub(crate) args: Vec<String>,
}

#[derive(Debug, Default, Clone, PartialEq, Eq, Deserialize)]
pub(crate) struct UpdateControl {
    pub(crate) node: String,
    pub(crate) entry: String,
}

/// Unknown fields are ignored so the launcher can add values first.
#[derive(Debug, Default, Clone, PartialEq, Eq, Deserialize)]
pub(crate) struct LaunchContext {
    #[serde(default)]
    pub(crate) cli_version: Option<String>,
    #[serde(default)]
    pub(crate) runtime: Option<RuntimeLaunch>,
    #[serde(default)]
    pub(crate) update_notice_file: Option<String>,
    #[serde(default)]
    pub(crate) update_control: Option<UpdateControl>,
    #[serde(default)]
    pub(crate) startup_confirmations: Vec<String>,
}

/// Uses the first occurrence. A missing or invalid value yields the default
/// context; an invalid value is reported once on stderr.
pub(crate) fn parse_launch_context_from_args(
    args: impl IntoIterator<Item = impl AsRef<str>>,
) -> Result<LaunchContext, String> {
    let prefix = format!("{LAUNCH_CONTEXT_FLAG}=");
    let Some(raw) = args
        .into_iter()
        .find_map(|arg| arg.as_ref().strip_prefix(&prefix).map(str::to_owned))
    else {
        return Ok(LaunchContext::default());
    };
    serde_json::from_str(&raw).map_err(|error| format!("invalid {LAUNCH_CONTEXT_FLAG}: {error}"))
}

pub(crate) fn launch_context() -> &'static LaunchContext {
    static CONTEXT: OnceLock<LaunchContext> = OnceLock::new();
    CONTEXT.get_or_init(|| {
        parse_launch_context_from_args(env::args().skip(1)).unwrap_or_else(|message| {
            eprintln!("[codelia-tui] {message}");
            LaunchContext::default()
        })
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_first_context_and_ignores_unknown_fields() {
        let context = parse_launch_context_from_args([
            "--debug",
            r#"--internal-launch-context={"cli_version":"1.2.3","runtime":{"command":"/n","args":["/r.cjs"]},"update_notice_file":"/tmp/n.json","update_control":{"node":"/n","entry":"/e"},"startup_confirmations":["update-mode"],"future":1}"#,
            r#"--internal-launch-context={"cli_version":"9.9.9"}"#,
        ])
        .expect("valid context");
        assert_eq!(context.cli_version.as_deref(), Some("1.2.3"));
        assert_eq!(
            context.runtime,
            Some(RuntimeLaunch {
                command: "/n".to_owned(),
                args: vec!["/r.cjs".to_owned()],
            })
        );
        assert_eq!(context.update_notice_file.as_deref(), Some("/tmp/n.json"));
        assert_eq!(
            context.update_control,
            Some(UpdateControl {
                node: "/n".to_owned(),
                entry: "/e".to_owned(),
            })
        );
        assert_eq!(context.startup_confirmations, vec!["update-mode"]);
    }

    #[test]
    fn missing_context_is_default_and_invalid_context_is_an_error() {
        assert_eq!(
            parse_launch_context_from_args(["--resume"]),
            Ok(LaunchContext::default())
        );
        assert!(parse_launch_context_from_args(["--internal-launch-context=nope"]).is_err());
        assert_eq!(
            parse_launch_context_from_args(["--internal-launch-context"]),
            Ok(LaunchContext::default())
        );
    }
}
