mod app;
mod entry;
mod event_loop;

use crate::app::runtime::{send_initialize, spawn_runtime};
use crate::entry::run_loop::run_tui_loop;

use crate::entry::bootstrap::{
    apply_resume_startup, build_initial_app, request_initial_model_list,
};
use crate::entry::cli::{
    debug_perf_enabled, debug_print_enabled, diagnostics_enabled, parse_approval_mode,
    parse_basic_cli_mode, parse_initial_message, parse_resume_mode, print_basic_help,
    resolve_version_label, BasicCliMode,
};
use crate::entry::terminal::{
    restore_inline_cursor, set_mouse_capture, setup_terminal, TerminalRestoreGuard,
};

#[cfg(test)]
use crate::entry::cli::{
    cli_flag_enabled_from_args, parse_approval_mode_from_args, parse_basic_cli_mode_from_args,
    parse_initial_message_from_args, parse_resume_mode_from_args,
    resolve_version_label_from_versions, ResumeMode,
};

fn main() -> Result<(), Box<dyn std::error::Error>> {
    match parse_basic_cli_mode() {
        BasicCliMode::Help => {
            print_basic_help();
            return Ok(());
        }
        BasicCliMode::Version => {
            println!("{}", resolve_version_label());
            return Ok(());
        }
        BasicCliMode::Run => {}
    }
    let resume_mode = parse_resume_mode();
    let mut pending_initial_message = parse_initial_message();
    let debug_print = debug_print_enabled();
    let debug_perf = debug_perf_enabled();
    let diagnostics = diagnostics_enabled();
    let approval_mode = parse_approval_mode()
        .map_err(|message| std::io::Error::new(std::io::ErrorKind::InvalidInput, message))?;
    let (mut child, mut child_stdin, rx) = spawn_runtime(diagnostics, approval_mode.as_deref())?;

    let mut rpc_id = 0_u64;
    let mut next_id = || {
        rpc_id += 1;
        rpc_id.to_string()
    };

    send_initialize(&mut child_stdin, &next_id())?;

    let use_alt_screen = false;
    let _restore_guard = TerminalRestoreGuard::new(use_alt_screen);
    let mut terminal = setup_terminal(use_alt_screen)?;
    let mut app = build_initial_app(
        debug_print,
        debug_perf,
        diagnostics,
        pending_initial_message.as_deref(),
    );
    app.mouse_capture_enabled = use_alt_screen;
    set_mouse_capture(&mut terminal, app.mouse_capture_enabled);
    request_initial_model_list(&mut app, &mut child_stdin, &mut next_id);
    apply_resume_startup(&mut app, &mut child_stdin, &mut next_id, resume_mode);

    run_tui_loop(
        &mut app,
        &mut terminal,
        &rx,
        &mut child,
        &mut child_stdin,
        &mut next_id,
        &mut pending_initial_message,
        use_alt_screen,
    )?;

    let _ = child.kill();
    if !use_alt_screen {
        restore_inline_cursor(&mut terminal);
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::{
        cli_flag_enabled_from_args, parse_approval_mode_from_args, parse_basic_cli_mode_from_args,
        parse_initial_message_from_args, parse_resume_mode_from_args,
        resolve_version_label_from_versions, BasicCliMode, ResumeMode,
    };
    use crate::app::runtime::RpcResponse;
    use crate::app::{AppState, PendingPromptRun, PROMPT_DISPATCH_MAX_ATTEMPTS};
    use crate::event_loop::runtime::{
        apply_lane_list_result, can_auto_start_initial_message, handle_run_start_response,
        push_bang_stream_preview, truncate_bang_preview_line,
    };
    use serde_json::json;
    use std::time::Instant;

    #[test]
    fn parse_resume_mode_accepts_picker_and_value() {
        assert_eq!(
            parse_resume_mode_from_args(["--resume"]),
            ResumeMode::Picker
        );
        assert_eq!(
            parse_resume_mode_from_args(["--resume", "abc"]),
            ResumeMode::Id("abc".to_string())
        );
        assert_eq!(
            parse_resume_mode_from_args(["--resume=xyz"]),
            ResumeMode::Id("xyz".to_string())
        );
    }

    #[test]
    fn parse_basic_cli_mode_supports_help_and_version() {
        assert_eq!(
            parse_basic_cli_mode_from_args(["--help"]),
            BasicCliMode::Help
        );
        assert_eq!(parse_basic_cli_mode_from_args(["-h"]), BasicCliMode::Help);
        assert_eq!(
            parse_basic_cli_mode_from_args(["--version"]),
            BasicCliMode::Version
        );
        assert_eq!(
            parse_basic_cli_mode_from_args(["-V"]),
            BasicCliMode::Version
        );
        assert_eq!(
            parse_basic_cli_mode_from_args(["--resume", "abc"]),
            BasicCliMode::Run
        );
    }

    #[test]
    fn cli_flag_enabled_supports_bool_and_equals_forms() {
        assert!(cli_flag_enabled_from_args("--debug", ["--debug"]));
        assert!(cli_flag_enabled_from_args("--debug", ["--debug=true"]));
        assert!(cli_flag_enabled_from_args("--debug", ["--debug=1"]));
        assert!(!cli_flag_enabled_from_args("--debug", ["--debug=false"]));
        assert!(!cli_flag_enabled_from_args("--debug", ["--debug=0"]));
        assert!(!cli_flag_enabled_from_args("--debug", ["--debug=maybe"]));
    }

    #[test]
    fn parse_initial_message_accepts_short_and_long_forms() {
        assert_eq!(
            parse_initial_message_from_args(["--initial-message=hello"]),
            Some("hello".to_string())
        );
        assert_eq!(
            parse_initial_message_from_args(["--initial-message", "hello world"]),
            Some("hello world".to_string())
        );
        assert_eq!(
            parse_initial_message_from_args(["--initial-user-message", "hello"]),
            Some("hello".to_string())
        );
    }

    #[test]
    fn parse_initial_message_ignores_empty() {
        assert_eq!(
            parse_initial_message_from_args(["--initial-message="]),
            None
        );
        assert_eq!(
            parse_initial_message_from_args(["--initial-message", "   "]),
            None
        );
    }

    #[test]
    fn parse_approval_mode_supports_split_and_equals_forms() {
        assert_eq!(
            parse_approval_mode_from_args(["--approval-mode", "trusted"]),
            Ok(Some("trusted".to_string()))
        );
        assert_eq!(
            parse_approval_mode_from_args(["--approval-mode=full-access"]),
            Ok(Some("full-access".to_string()))
        );
        assert_eq!(parse_approval_mode_from_args(["--debug"]), Ok(None));
    }

    #[test]
    fn parse_approval_mode_rejects_missing_values() {
        assert!(parse_approval_mode_from_args(["--approval-mode"]).is_err());
        assert!(parse_approval_mode_from_args(["--approval-mode="]).is_err());
    }

    #[test]
    fn version_label_uses_cli_version_without_tui_suffix() {
        assert_eq!(
            resolve_version_label_from_versions(Some("0.1.12"), "0.1.0"),
            "codelia 0.1.12"
        );
        assert_eq!(
            resolve_version_label_from_versions(Some(" 0.2.0 "), "0.1.0"),
            "codelia 0.2.0"
        );
    }

    #[test]
    fn version_label_falls_back_without_tui_version_when_cli_is_missing() {
        assert_eq!(
            resolve_version_label_from_versions(None, "0.1.0"),
            "codelia"
        );
        assert_eq!(
            resolve_version_label_from_versions(Some("   "), "0.1.0"),
            "codelia"
        );
    }

    #[test]
    fn truncate_bang_preview_line_appends_marker_when_long() {
        let input = "x".repeat(300);
        let out = truncate_bang_preview_line(&input);
        assert!(out.ends_with("...[truncated]"));
        assert!(out.len() < input.len());
    }

    #[test]
    fn push_bang_stream_preview_emits_runtime_lines_and_truncation_hint() {
        let mut app = AppState::default();
        push_bang_stream_preview(
            &mut app,
            "stdout",
            Some("line1\nline2"),
            true,
            Some("cache-ref-1"),
        );

        let lines = app
            .log
            .iter()
            .map(|line| line.plain_text())
            .collect::<Vec<_>>();
        assert!(lines.iter().any(|line| line.contains("bang stdout:")));
        assert!(lines.iter().any(|line| line.contains("line1")));
        assert!(lines
            .iter()
            .any(|line| line.contains("tool_output_cache ref `cache-ref-1`")));
    }

    #[test]
    fn can_auto_start_initial_message_waits_for_prompt_queue_to_drain() {
        let mut app = AppState::default();
        assert!(can_auto_start_initial_message(&app));

        app.pending_prompt_queue.push_back(PendingPromptRun {
            queue_id: "q1".to_string(),
            queued_at: Instant::now(),
            preview: "hello".to_string(),
            user_text: "hello".to_string(),
            input_payload: json!({"type": "text", "text": "hello"}),
            attachment_count: 0,
            shell_result_count: 0,
            dispatch_attempts: 0,
        });
        assert!(!can_auto_start_initial_message(&app));

        app.pending_prompt_queue.clear();
        app.dispatching_prompt = Some(PendingPromptRun {
            queue_id: "q2".to_string(),
            queued_at: Instant::now(),
            preview: "world".to_string(),
            user_text: "world".to_string(),
            input_payload: json!({"type": "text", "text": "world"}),
            attachment_count: 0,
            shell_result_count: 0,
            dispatch_attempts: 0,
        });
        assert!(!can_auto_start_initial_message(&app));
    }

    #[test]
    fn run_start_error_requeues_dispatching_prompt() {
        let mut app = AppState::default();
        app.dispatching_prompt = Some(PendingPromptRun {
            queue_id: "q9".to_string(),
            queued_at: Instant::now(),
            preview: "queued".to_string(),
            user_text: "queued".to_string(),
            input_payload: json!({"type": "text", "text": "queued"}),
            attachment_count: 0,
            shell_result_count: 0,
            dispatch_attempts: 0,
        });
        app.update_run_status("starting".to_string());

        handle_run_start_response(
            &mut app,
            RpcResponse {
                id: "id-1".to_string(),
                result: None,
                error: Some(json!({"message": "runtime busy"})),
            },
        );

        assert!(app.dispatching_prompt.is_none());
        assert_eq!(app.pending_prompt_queue.len(), 1);
        assert_eq!(
            app.pending_prompt_queue
                .front()
                .map(|item| item.queue_id.as_str()),
            Some("q9")
        );
        assert_eq!(
            app.pending_prompt_queue
                .front()
                .map(|item| item.dispatch_attempts),
            Some(1)
        );
    }

    #[test]
    fn run_start_error_drops_prompt_after_max_attempts() {
        let mut app = AppState::default();
        app.dispatching_prompt = Some(PendingPromptRun {
            queue_id: "q10".to_string(),
            queued_at: Instant::now(),
            preview: "queued".to_string(),
            user_text: "queued".to_string(),
            input_payload: json!({"type": "text", "text": "queued"}),
            attachment_count: 0,
            shell_result_count: 0,
            dispatch_attempts: PROMPT_DISPATCH_MAX_ATTEMPTS - 1,
        });

        handle_run_start_response(
            &mut app,
            RpcResponse {
                id: "id-2".to_string(),
                result: None,
                error: Some(json!({"message": "invalid model"})),
            },
        );

        assert!(app.dispatching_prompt.is_none());
        assert!(app.pending_prompt_queue.is_empty());
        assert!(app
            .log
            .iter()
            .any(|line| line.plain_text().contains("Dropping queued prompt q10")));
    }

    #[test]
    fn apply_lane_list_result_adds_new_lane_row() {
        let mut app = AppState::default();
        let payload = json!({
            "lanes": [
                {
                    "lane_id": "lane-a",
                    "task_id": "task-a",
                    "state": "running",
                    "mux_backend": "tmux"
                }
            ]
        });

        apply_lane_list_result(&mut app, &payload);

        let panel = app.lane_list_panel.expect("lane panel present");
        assert_eq!(panel.rows.len(), 2);
        assert_eq!(panel.rows[1], "+ New lane");
    }
}
