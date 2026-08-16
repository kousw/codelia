use std::env;
use std::fmt;
use std::fs;
use std::str::FromStr;

#[derive(Debug, Default, Clone, Copy, PartialEq, Eq)]
pub(crate) enum RequestedTerminalMode {
    #[default]
    Auto,
    Inline,
    Alternate,
}

impl fmt::Display for RequestedTerminalMode {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str(match self {
            Self::Auto => "auto",
            Self::Inline => "inline",
            Self::Alternate => "alternate",
        })
    }
}

impl FromStr for RequestedTerminalMode {
    type Err = String;

    fn from_str(value: &str) -> Result<Self, Self::Err> {
        match value.trim().to_ascii_lowercase().as_str() {
            "auto" => Ok(Self::Auto),
            "inline" => Ok(Self::Inline),
            "alternate" => Ok(Self::Alternate),
            _ => Err(format!(
                "invalid terminal mode `{value}` (expected auto|inline|alternate)"
            )),
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum ResolvedTerminalMode {
    Inline,
    Alternate,
}

impl ResolvedTerminalMode {
    pub(crate) fn uses_alternate_screen(self) -> bool {
        matches!(self, Self::Alternate)
    }

    pub(crate) fn uses_inline_scrollback(self) -> bool {
        matches!(self, Self::Inline)
    }

    pub(crate) fn default_mouse_capture(self) -> bool {
        self.uses_alternate_screen()
    }
}

impl fmt::Display for ResolvedTerminalMode {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str(match self {
            Self::Inline => "inline",
            Self::Alternate => "alternate",
        })
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum TerminalModeReason {
    ExplicitInline,
    ExplicitAlternate,
    WindowsConpty,
    WslConpty,
    NativeScrollback,
}

impl fmt::Display for TerminalModeReason {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str(match self {
            Self::ExplicitInline => "explicit-inline",
            Self::ExplicitAlternate => "explicit-alternate",
            Self::WindowsConpty => "windows-conpty",
            Self::WslConpty => "wsl-conpty",
            Self::NativeScrollback => "native-scrollback",
        })
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) struct TerminalModeSelection {
    pub(crate) requested: RequestedTerminalMode,
    pub(crate) resolved: ResolvedTerminalMode,
    pub(crate) reason: TerminalModeReason,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) struct TerminalEnvironmentFacts {
    pub(crate) is_windows: bool,
    pub(crate) is_wsl: bool,
}

impl TerminalEnvironmentFacts {
    pub(crate) fn capture() -> Self {
        let wsl_interop = env::var("WSL_INTEROP").ok();
        let wsl_distro_name = env::var("WSL_DISTRO_NAME").ok();
        let kernel_release = if cfg!(target_os = "linux") {
            fs::read_to_string("/proc/sys/kernel/osrelease").ok()
        } else {
            None
        };

        Self::from_indicators(
            cfg!(target_os = "windows"),
            wsl_interop.as_deref(),
            wsl_distro_name.as_deref(),
            kernel_release.as_deref(),
        )
    }

    pub(crate) fn from_indicators(
        is_windows: bool,
        wsl_interop: Option<&str>,
        wsl_distro_name: Option<&str>,
        kernel_release: Option<&str>,
    ) -> Self {
        let has_value = |value: Option<&str>| value.is_some_and(|value| !value.trim().is_empty());
        let kernel_release = kernel_release.unwrap_or_default().to_ascii_lowercase();
        let is_wsl = !is_windows
            && (has_value(wsl_interop)
                || has_value(wsl_distro_name)
                || kernel_release.contains("microsoft")
                || kernel_release.contains("wsl"));

        Self { is_windows, is_wsl }
    }
}

pub(crate) fn resolve_terminal_mode(
    requested: RequestedTerminalMode,
    facts: TerminalEnvironmentFacts,
) -> TerminalModeSelection {
    let (resolved, reason) = match requested {
        RequestedTerminalMode::Inline => (
            ResolvedTerminalMode::Inline,
            TerminalModeReason::ExplicitInline,
        ),
        RequestedTerminalMode::Alternate => (
            ResolvedTerminalMode::Alternate,
            TerminalModeReason::ExplicitAlternate,
        ),
        RequestedTerminalMode::Auto if facts.is_windows => (
            ResolvedTerminalMode::Alternate,
            TerminalModeReason::WindowsConpty,
        ),
        RequestedTerminalMode::Auto if facts.is_wsl => (
            ResolvedTerminalMode::Alternate,
            TerminalModeReason::WslConpty,
        ),
        RequestedTerminalMode::Auto => (
            ResolvedTerminalMode::Inline,
            TerminalModeReason::NativeScrollback,
        ),
    };

    TerminalModeSelection {
        requested,
        resolved,
        reason,
    }
}

#[cfg(test)]
mod tests {
    use super::{
        resolve_terminal_mode, RequestedTerminalMode, ResolvedTerminalMode,
        TerminalEnvironmentFacts, TerminalModeReason,
    };

    fn facts(is_windows: bool, is_wsl: bool) -> TerminalEnvironmentFacts {
        TerminalEnvironmentFacts { is_windows, is_wsl }
    }

    #[test]
    fn environment_facts_detect_wsl_without_process_env_mutation() {
        assert_eq!(
            TerminalEnvironmentFacts::from_indicators(false, Some("/run/WSL/1"), None, None),
            facts(false, true)
        );
        assert!(
            TerminalEnvironmentFacts::from_indicators(
                false,
                None,
                None,
                Some("5.15.146.1-microsoft-standard-WSL2")
            )
            .is_wsl
        );
        assert!(
            !TerminalEnvironmentFacts::from_indicators(
                false,
                Some("  "),
                Some(""),
                Some("6.12.0-linux")
            )
            .is_wsl
        );
    }

    #[test]
    fn resolver_uses_conservative_auto_policy() {
        let windows = resolve_terminal_mode(RequestedTerminalMode::Auto, facts(true, false));
        assert_eq!(windows.resolved, ResolvedTerminalMode::Alternate);
        assert_eq!(windows.reason, TerminalModeReason::WindowsConpty);

        let wsl = resolve_terminal_mode(RequestedTerminalMode::Auto, facts(false, true));
        assert_eq!(wsl.resolved, ResolvedTerminalMode::Alternate);
        assert_eq!(wsl.reason, TerminalModeReason::WslConpty);

        let unix = resolve_terminal_mode(RequestedTerminalMode::Auto, facts(false, false));
        assert_eq!(unix.resolved, ResolvedTerminalMode::Inline);
        assert_eq!(unix.reason, TerminalModeReason::NativeScrollback);
    }

    #[test]
    fn explicit_request_overrides_environment() {
        let inline = resolve_terminal_mode(RequestedTerminalMode::Inline, facts(true, false));
        assert_eq!(inline.resolved, ResolvedTerminalMode::Inline);
        assert_eq!(inline.reason, TerminalModeReason::ExplicitInline);

        let alternate =
            resolve_terminal_mode(RequestedTerminalMode::Alternate, facts(false, false));
        assert_eq!(alternate.resolved, ResolvedTerminalMode::Alternate);
        assert_eq!(alternate.reason, TerminalModeReason::ExplicitAlternate);
    }

    #[test]
    fn resolved_mode_controls_scrollback_and_mouse_defaults() {
        assert!(ResolvedTerminalMode::Inline.uses_inline_scrollback());
        assert!(!ResolvedTerminalMode::Inline.uses_alternate_screen());
        assert!(!ResolvedTerminalMode::Inline.default_mouse_capture());

        assert!(!ResolvedTerminalMode::Alternate.uses_inline_scrollback());
        assert!(ResolvedTerminalMode::Alternate.uses_alternate_screen());
        assert!(ResolvedTerminalMode::Alternate.default_mouse_capture());
    }
}
