mod app;
mod entry;
mod event_loop;
use crate::app::PendingRpc;
use codelia_protocol as protocol;

use crate::app::runtime::{
    send_initialize, shutdown_runtime, spawn_runtime, RuntimeLaunchConfig, RuntimeTx,
    StdioRuntimeTx,
};
use crate::app::view::desired_height;
use crate::entry::launch_context::launch_context;
use crate::entry::run_loop::{run_tui_loop, RunLoopTerminal, WakeHub};

use crate::entry::bootstrap::{
    apply_resume_startup, build_initial_app, request_initial_model_list,
};
use crate::entry::cli::{
    debug_perf_enabled, debug_print_enabled, diagnostics_enabled, parse_basic_cli_mode,
    parse_color_scheme_arg, parse_image_protocol_arg, parse_initial_message, parse_resume_mode,
    parse_sandbox_mode_arg, parse_terminal_mode, print_basic_help, resolve_version_label,
    BasicCliMode,
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
    let requested_color_scheme = parse_color_scheme_arg()
        .map_err(|message| std::io::Error::new(std::io::ErrorKind::InvalidInput, message))?;
    if let Some(scheme) = requested_color_scheme.as_deref() {
        crate::app::theme::apply_color_scheme(scheme);
    }
    crate::app::markdown::warm_highlight_assets();
    let requested_image_protocol = parse_image_protocol_arg()
        .map_err(|message| std::io::Error::new(std::io::ErrorKind::InvalidInput, message))?;
    let sandbox_mode = parse_sandbox_mode_arg()
        .map_err(|message| std::io::Error::new(std::io::ErrorKind::InvalidInput, message))?;
    let runtime_launch = launch_context()
        .runtime
        .as_ref()
        .map(|runtime| RuntimeLaunchConfig {
            command: &runtime.command,
            args: &runtime.args,
        });
    let wake_hub = WakeHub::new();
    let (mut child, mut child_stdin, rx) = spawn_runtime(
        runtime_launch.as_ref(),
        sandbox_mode
            .as_ref()
            .map(|(flag, mode)| (*flag, mode.as_str())),
        Some(wake_hub.runtime_notifier()),
    )?;
    let run_result = (|| -> Result<(), Box<dyn std::error::Error>> {
        let mut tx = StdioRuntimeTx::new(&mut child_stdin);
        let initialize_id = tx.next_id();
        send_initialize(&mut tx, &initialize_id)?;

        let mut app = build_initial_app(
            debug_print,
            debug_perf,
            diagnostics,
            pending_initial_message.as_deref(),
        );
        if debug_print {
            app.push_line(
                crate::app::state::LogKind::Status,
                format!(
                    "terminal mode: requested={} resolved={} reason={}",
                    terminal_selection.requested,
                    terminal_selection.resolved,
                    terminal_selection.reason
                ),
            );
        }
        app.terminal_uses_alternate_screen = terminal_mode.uses_alternate_screen();
        app.cli_color_scheme_override = requested_color_scheme.is_some();
        app.cli_image_protocol_override = requested_image_protocol.is_some();
        app.rpc_pending
            .insert(initialize_id, PendingRpc::Initialize);
        app.image_preview.policy = crate::entry::terminal::image_preview_policy(
            terminal_mode,
            requested_image_protocol.as_deref(),
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
        let mut restore_guard = TerminalRestoreGuard::new(terminal_mode)
            .with_preview_image(app.image_preview.policy.kitty_id);
        let mut terminal = setup_terminal(terminal_mode, inline_height)?;
        app.mouse_capture_enabled = terminal_mode.default_mouse_capture();
        set_mouse_capture(&mut terminal, app.mouse_capture_enabled);
        request_initial_model_list(&mut app, &mut tx);
        apply_resume_startup(&mut app, &mut tx, resume_mode);

        let loop_result = run_tui_loop(
            &mut app,
            RunLoopTerminal::new(&mut terminal, terminal_mode),
            &rx,
            &mut child,
            &mut tx,
            &mut pending_initial_message,
            wake_hub,
        );
        restore_guard.set_preview_image(app.image_preview.policy.kitty_id);

        if terminal_mode.uses_inline_scrollback() {
            restore_inline_cursor(&mut terminal);
        }
        loop_result
    })();
    let shutdown_result =
        shutdown_runtime(&mut child, child_stdin, std::time::Duration::from_secs(5));
    run_result?;
    shutdown_result?;
    Ok(())
}

#[cfg(test)]
mod main_tests;
