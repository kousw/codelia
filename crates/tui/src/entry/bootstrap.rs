use crate::app::handlers::panels::{
    request_session_history, request_session_list, request_session_open,
};
use crate::app::runtime::send_model_list;
use crate::app::state::LogKind;
use crate::app::{AppState, ModelListMode};
use crate::entry::cli::{resolve_version_label, ResumeMode};
use std::io::BufWriter;
use std::path::Path;
use std::process::ChildStdin;

const MAX_UPDATE_NOTICE_BYTES: u64 = 8 * 1024;
const MAX_UPDATE_NOTICES: usize = 4;
const MAX_UPDATE_NOTICE_CHARS: usize = 300;

fn sanitize_notice_line(raw: &str) -> Option<String> {
    let cleaned: String = raw
        .chars()
        .map(|ch| if ch.is_control() { ' ' } else { ch })
        .collect();
    let trimmed = cleaned.trim();
    if trimmed.is_empty() {
        return None;
    }
    let truncated: String = trimmed.chars().take(MAX_UPDATE_NOTICE_CHARS).collect();
    Some(truncated)
}

pub(crate) fn read_update_notices_from_path(path: &Path) -> Vec<String> {
    let Ok(meta) = std::fs::symlink_metadata(path) else {
        return Vec::new();
    };
    if !meta.file_type().is_file() || meta.len() > MAX_UPDATE_NOTICE_BYTES {
        return Vec::new();
    }
    let Ok(raw) = std::fs::read_to_string(path) else {
        return Vec::new();
    };
    let Ok(parsed) = serde_json::from_str::<serde_json::Value>(&raw) else {
        return Vec::new();
    };
    let Some(items) = parsed.get("notices").and_then(|v| v.as_array()) else {
        return Vec::new();
    };
    items
        .iter()
        .filter_map(|item| item.as_str().and_then(sanitize_notice_line))
        .take(MAX_UPDATE_NOTICES)
        .collect()
}

fn load_startup_update_notices() -> Vec<String> {
    let Some(file) = crate::entry::launch_context::launch_context()
        .update_notice_file
        .as_deref()
    else {
        return Vec::new();
    };
    if file.trim().is_empty() {
        return Vec::new();
    }
    read_update_notices_from_path(Path::new(file))
}

const LOGO_LINES: [&str; 7] = [
    "┌─────────────────────────────────────┐",
    "│                                     │",
    "│     █▀▀ █▀█ █▀▄ █▀▀ █░░ █ ▄▀█       │",
    "│     █▄▄ █▄█ █▄▀ ██▄ █▄▄ █ █▀█       │",
    "│                                     │",
    "│       Your Coding Companion         │",
    "└─────────────────────────────────────┘",
];

type RuntimeStdin = BufWriter<ChildStdin>;

pub(crate) fn build_initial_app(
    debug_print: bool,
    debug_perf: bool,
    diagnostics: bool,
    pending_initial_message: Option<&str>,
) -> AppState {
    let mut app = AppState::default();
    let launch = crate::entry::launch_context::launch_context();
    app.update_control_launcher =
        crate::app::self_update::LauncherPaths::from_launch_context(launch);
    if app.update_control_launcher.is_some() {
        app.startup_confirmations =
            crate::app::startup_confirmations::StartupConfirmations::from_launch_context(launch);
    }
    app.enable_debug_print = debug_print;
    app.debug_perf_enabled = debug_perf;

    for line in LOGO_LINES {
        app.push_line(LogKind::System, line);
    }
    app.push_line(LogKind::Space, "");
    app.push_line(LogKind::System, "Welcome to Codelia!");
    app.push_line(
        LogKind::System,
        format!("Version: {}", resolve_version_label()),
    );
    app.push_line(LogKind::Space, "");

    let update_notices = load_startup_update_notices();
    if !update_notices.is_empty() {
        for notice in update_notices {
            app.push_line(LogKind::Status, notice);
        }
        app.push_line(LogKind::Space, "");
    }

    if pending_initial_message.is_some() {
        app.push_line(
            LogKind::Status,
            "Queued initial prompt (`--initial-message`).",
        );
        app.push_line(LogKind::Space, "");
    }
    if app.enable_debug_print {
        app.push_line(
            LogKind::Status,
            "Debug logs enabled (`--debug` or CODELIA_DEBUG=1)",
        );
        app.push_line(LogKind::Space, "");
    }
    if app.debug_perf_enabled {
        app.push_line(
            LogKind::Status,
            "Debug perf panel enabled (`--debug-perf` or CODELIA_DEBUG_PERF=1)",
        );
        app.push_line(LogKind::Space, "");
    }
    if diagnostics {
        app.push_line(
            LogKind::Status,
            "Run diagnostics enabled (`--diagnostics` or CODELIA_DIAGNOSTICS=1)",
        );
        app.push_line(LogKind::Space, "");
    }

    app
}

pub(crate) fn request_initial_model_list(
    app: &mut AppState,
    child_stdin: &mut RuntimeStdin,
    next_id: &mut impl FnMut() -> String,
) {
    let id = next_id();
    app.rpc_pending.model_list_id = Some(id.clone());
    app.rpc_pending.model_list_mode = Some(ModelListMode::Silent);
    if let Err(error) = send_model_list(child_stdin, &id, None, false) {
        app.push_error_report("send error", error.to_string());
    }
}

pub(crate) fn apply_resume_startup(
    app: &mut AppState,
    child_stdin: &mut RuntimeStdin,
    next_id: &mut impl FnMut() -> String,
    resume_mode: ResumeMode,
) {
    match resume_mode {
        ResumeMode::Id(session_id) => {
            let short_id: String = session_id.chars().take(8).collect();
            app.runtime_info.session_id = Some(session_id);
            app.push_line(LogKind::Status, format!("Resume session {short_id}"));
            app.push_line(LogKind::Space, "");
            if let Some(session_id) = app.runtime_info.session_id.clone() {
                request_session_open(app, child_stdin, next_id, &session_id);
                request_session_history(app, child_stdin, next_id, &session_id);
            }
        }
        ResumeMode::Picker => {
            app.push_line(
                LogKind::Status,
                "Resume picker: Current workspace only. Press A to show all sessions.",
            );
            app.push_line(LogKind::Space, "");
            request_session_list(app, child_stdin, next_id, false);
        }
        ResumeMode::None => {}
    }
}

#[cfg(test)]
mod tests {
    use super::read_update_notices_from_path;
    use std::fs;
    use std::time::{SystemTime, UNIX_EPOCH};

    fn temp_path(name: &str) -> std::path::PathBuf {
        let nanos = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap_or_default()
            .as_nanos();
        std::env::temp_dir().join(format!("codelia-tui-notice-{name}-{nanos}.json"))
    }

    #[test]
    fn reads_sanitized_update_notices_and_caps_count() {
        let path = temp_path("valid");
        fs::write(
            &path,
            r#"{"notices":["Updated 0.1.0 -> 0.1.1\n\u001b[31m","   ","line 2","line 3","line 4","line 5"]}"#,
        )
        .expect("write notice fixture");
        let notices = read_update_notices_from_path(&path);
        let _ = fs::remove_file(&path);
        assert_eq!(
            notices,
            vec!["Updated 0.1.0 -> 0.1.1  [31m", "line 2", "line 3", "line 4",]
        );
    }

    #[test]
    fn ignores_missing_malformed_or_oversized_notice_files() {
        let missing = temp_path("missing");
        assert!(read_update_notices_from_path(&missing).is_empty());

        let malformed = temp_path("malformed");
        fs::write(&malformed, "{not json").expect("write malformed fixture");
        assert!(read_update_notices_from_path(&malformed).is_empty());
        let _ = fs::remove_file(&malformed);

        let huge = temp_path("huge");
        fs::write(&huge, format!(r#"{{"notices":["{}"]}}"#, "a".repeat(9000)))
            .expect("write huge fixture");
        assert!(read_update_notices_from_path(&huge).is_empty());
        let _ = fs::remove_file(&huge);
    }
}
