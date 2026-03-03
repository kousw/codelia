use crate::app::handlers::panels::request_session_history;
use crate::app::runtime::{send_model_list, send_session_list};
use crate::app::state::LogKind;
use crate::app::{AppState, ModelListMode};
use crate::entry::cli::{resolve_version_label, ResumeMode};
use std::io::BufWriter;
use std::process::ChildStdin;

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
    app.pending_model_list_id = Some(id.clone());
    app.pending_model_list_mode = Some(ModelListMode::Silent);
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
            app.session_id = Some(session_id);
            app.push_line(LogKind::Status, format!("Resume session {short_id}"));
            app.push_line(LogKind::Space, "");
            if let Some(session_id) = app.session_id.clone() {
                request_session_history(app, child_stdin, next_id, &session_id);
            }
        }
        ResumeMode::Picker => {
            let id = next_id();
            app.pending_session_list_id = Some(id.clone());
            if let Err(error) = send_session_list(child_stdin, &id, Some(50)) {
                app.push_error_report("send error", error.to_string());
            }
        }
        ResumeMode::None => {}
    }
}
