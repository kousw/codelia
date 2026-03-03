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
mod main_tests;
