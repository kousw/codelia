use super::inline::apply_terminal_effects;
use crate::app::view::draw_ui;
use crate::app::{AppState, SyncPhase};
use ratatui::backend::Backend;
use ratatui::Terminal;
use std::time::{Duration, Instant};

#[derive(Default)]
pub(crate) struct DrawOutcome {
    pub request_redraw: bool,
    pub draw_elapsed: Duration,
}

/// One bounded render cycle: at most one insertion pass and two draws.
/// A resize during restoration may schedule another cycle, but cannot insert
/// again after the final draw and leave the composer cleared before input polling.
pub(crate) fn draw_frame<B: Backend>(
    terminal: &mut Terminal<B>,
    app: &mut AppState,
    inline_scrollback: bool,
) -> Result<DrawOutcome, B::Error> {
    let changed = app.log_changed;
    let mut width = 1;
    let started = Instant::now();
    terminal.draw(|frame| {
        width = frame.area().width.max(1);
        draw_ui(frame, app);
    })?;
    let mut outcome = DrawOutcome {
        draw_elapsed: started.elapsed(),
        ..DrawOutcome::default()
    };
    if !inline_scrollback {
        return Ok(outcome);
    }
    let effects = apply_terminal_effects(terminal, app, changed, width)?;
    if effects.request_redraw {
        let started = Instant::now();
        terminal.draw(|frame| draw_ui(frame, app))?;
        outcome.draw_elapsed += started.elapsed();
        // draw_ui may discover more overflow if the terminal changed size. Leave
        // it pending rather than performing another destructive insertion here.
        match app.render_state.sync_phase {
            SyncPhase::InsertedNeedsRedraw => app.render_state.sync_phase = SyncPhase::Idle,
            SyncPhase::NeedsInsert => outcome.request_redraw = true,
            SyncPhase::Idle => {}
        }
    }
    app.assert_render_invariants();
    Ok(outcome)
}
