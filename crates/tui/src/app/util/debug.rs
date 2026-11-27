use std::fs::OpenOptions;
use std::io::Write;
use std::path::PathBuf;
use std::sync::OnceLock;

#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub(crate) struct DebugConfig {
    pub(crate) debug: bool,
    pub(crate) rpc: bool,
    pub(crate) ws: bool,
    pub(crate) perf: bool,
    pub(crate) keys: bool,
    pub(crate) diff: bool,
    pub(crate) diagnostics: bool,
    pub(crate) provider_log: bool,
    pub(crate) session_dump: bool,
    pub(crate) ansi_syntax: bool,
    pub(crate) dir: Option<PathBuf>,
}

static DEBUG_CONFIG: OnceLock<DebugConfig> = OnceLock::new();

pub(crate) fn debug_config() -> &'static DebugConfig {
    DEBUG_CONFIG.get_or_init(|| {
        let raw_debug = std::env::var("CODELIA_DEBUG").ok();
        let raw_dir = std::env::var("CODELIA_DEBUG_DIR").ok();
        parse_debug_config(raw_debug.as_deref(), raw_dir.as_deref())
    })
}

pub(crate) fn parse_debug_config(raw_debug: Option<&str>, raw_dir: Option<&str>) -> DebugConfig {
    let dir = raw_dir
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(PathBuf::from);
    let mut cfg = DebugConfig {
        dir,
        ..DebugConfig::default()
    };
    let Some(raw) = raw_debug.map(str::trim).filter(|value| !value.is_empty()) else {
        return cfg;
    };
    let lower = raw.to_ascii_lowercase();
    if matches!(lower.as_str(), "0" | "false" | "off" | "no") {
        return cfg;
    }

    for part in lower.split(',') {
        let token = part.trim();
        if token.is_empty() || matches!(token, "0" | "false" | "off" | "no") {
            continue;
        }
        match token {
            "1" | "true" | "on" | "yes" | "debug" => {
                cfg.debug = true;
                cfg.rpc = true;
                cfg.ws = true;
            }
            "*" | "all" => {
                // Deliberately excludes disk dumps (`provider-log`, `session-dump`) unless named.
                cfg.debug = true;
                cfg.rpc = true;
                cfg.ws = true;
                cfg.perf = true;
                cfg.keys = true;
                cfg.diff = true;
                cfg.diagnostics = true;
            }
            "rpc" => {
                cfg.rpc = true;
                cfg.debug = true;
            }
            "ws" => {
                cfg.ws = true;
                cfg.debug = true;
            }
            "perf" => cfg.perf = true,
            "keys" | "key" => cfg.keys = true,
            "diff" | "diff-highlight" => cfg.diff = true,
            "diagnostics" | "diag" => cfg.diagnostics = true,
            "provider-log" | "provider_log" => cfg.provider_log = true,
            "session-dump" | "session_dump" => cfg.session_dump = true,
            "ansi-syntax" | "ansi_syntax" => cfg.ansi_syntax = true,
            _ => {}
        }
    }
    cfg
}

/// Appends one debug line to `<CODELIA_DEBUG_DIR>/<filename>` when `CODELIA_DEBUG_DIR` is set.
/// Returns `true` if written to disk, `false` if no debug dir is configured or write failed.
pub(crate) fn append_debug_file_line(filename: &str, line: &str) -> bool {
    let Some(dir) = debug_config().dir.as_deref() else {
        return false;
    };
    if std::fs::create_dir_all(dir).is_err() {
        return false;
    }
    let path = dir.join(filename);
    let Ok(mut file) = OpenOptions::new().create(true).append(true).open(path) else {
        return false;
    };
    writeln!(file, "{line}").is_ok()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_general_and_topic_flags_matching_ts_logger() {
        let off = parse_debug_config(Some("0"), None);
        assert!(!off.debug && !off.perf && !off.keys);

        let general = parse_debug_config(Some("1"), None);
        assert!(general.debug && general.rpc && general.ws);
        assert!(!general.perf && !general.provider_log && !general.session_dump);

        let topics = parse_debug_config(
            Some("perf, keys, diff-highlight, diagnostics, ansi-syntax"),
            Some(" /tmp/codelia-dbg "),
        );
        assert!(!topics.debug);
        assert!(
            topics.perf && topics.keys && topics.diff && topics.diagnostics && topics.ansi_syntax
        );
        assert_eq!(topics.dir, Some(PathBuf::from("/tmp/codelia-dbg")));

        let all = parse_debug_config(Some("all"), None);
        assert!(all.debug && all.perf && all.keys && all.diff && all.diagnostics);
        assert!(!all.provider_log && !all.session_dump);
    }
}
