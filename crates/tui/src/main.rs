mod app;
mod entry;
mod event_loop;

use crate::app::runtime::{send_initialize, spawn_runtime};
use crate::app::view::desired_height;
use crate::entry::run_loop::{run_tui_loop, RunLoopTerminal};

use crate::entry::bootstrap::{
    apply_resume_startup, build_initial_app, request_initial_model_list,
};
use crate::entry::cli::{
    debug_perf_enabled, debug_print_enabled, diagnostics_enabled, parse_approval_mode,
    parse_basic_cli_mode, parse_initial_message, parse_resume_mode, parse_terminal_mode,
    print_basic_help, resolve_version_label, BasicCliMode,
};
use crate::entry::terminal::{
    restore_inline_cursor, set_mouse_capture, setup_terminal, TerminalRestoreGuard,
};
use crate::entry::terminal_mode::{resolve_terminal_mode, TerminalEnvironmentFacts};

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
    let requested_terminal_mode = parse_terminal_mode()
        .map_err(|message| std::io::Error::new(std::io::ErrorKind::InvalidInput, message))?;
    let terminal_selection =
        resolve_terminal_mode(requested_terminal_mode, TerminalEnvironmentFacts::capture());
    let terminal_mode = terminal_selection.resolved;
    let resume_mode = parse_resume_mode();
    let mut pending_initial_message = parse_initial_message();
    let debug_print = debug_print_enabled();
    let debug_perf = debug_perf_enabled();
    let diagnostics = diagnostics_enabled();
    let approval_mode = parse_approval_mode()
        .map_err(|message| std::io::Error::new(std::io::ErrorKind::InvalidInput, message))?;
    if debug_print {
        eprintln!(
            "terminal mode: requested={} resolved={} reason={}",
            terminal_selection.requested, terminal_selection.resolved, terminal_selection.reason
        );
    }
    let (mut child, mut child_stdin, rx) = spawn_runtime(diagnostics, approval_mode.as_deref())?;
    let run_result = (|| -> Result<(), Box<dyn std::error::Error>> {
        let mut rpc_id = 0_u64;
        let mut next_id = || {
            rpc_id += 1;
            rpc_id.to_string()
        };

        send_initialize(&mut child_stdin, &next_id())?;

        let mut app = build_initial_app(
            debug_print,
            debug_perf,
            diagnostics,
            pending_initial_message.as_deref(),
        );
        let inline_height = if terminal_mode.uses_inline_scrollback() {
            let (terminal_width, terminal_height) = crossterm::terminal::size()?;
            desired_height(&mut app, terminal_width, terminal_height)
                .max(12)
                .min(terminal_height)
                .max(1)
        } else {
            1
        };
        let _restore_guard = TerminalRestoreGuard::new(terminal_mode);
        let mut terminal = setup_terminal(terminal_mode, inline_height)?;
        app.mouse_capture_enabled = terminal_mode.default_mouse_capture();
        set_mouse_capture(&mut terminal, app.mouse_capture_enabled);
        request_initial_model_list(&mut app, &mut child_stdin, &mut next_id);
        apply_resume_startup(&mut app, &mut child_stdin, &mut next_id, resume_mode);

        let loop_result = run_tui_loop(
            &mut app,
            RunLoopTerminal::new(&mut terminal, terminal_mode),
            &rx,
            &mut child,
            &mut child_stdin,
            &mut next_id,
            &mut pending_initial_message,
        );

        if terminal_mode.uses_inline_scrollback() {
            restore_inline_cursor(&mut terminal);
        }
        loop_result
    })();
    let _ = child.kill();
    run_result
}

#[cfg(test)]
mod main_tests;
