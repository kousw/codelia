use crate::app::render::insert_history::insert_history_lines;
use crate::app::view::wrapped_log_range_to_lines;
use crate::app::{AppState, CursorPhase, SyncPhase};
use ratatui::backend::Backend;
use ratatui::layout::{Position, Rect, Size};
use std::io::Write;

pub fn compute_inline_area<B: Backend>(
    backend: &mut B,
    height: u16,
    size: Size,
) -> std::io::Result<(Rect, Position)> {
    let max_height = size.height.min(height);

    let lines_after_cursor = height.saturating_sub(1);
    backend.append_lines(lines_after_cursor)?;
    // Re-read after append_lines so the terminal state and bookkeeping stay aligned.
    let pos = backend.get_cursor_position()?;
    // Inline viewport is always anchored to the bottom of the screen for stable cursor placement.
    let row = size.height.saturating_sub(max_height);

    Ok((
        Rect {
            x: 0,
            y: row,
            width: size.width,
            height: max_height,
        },
        pos,
    ))
}

#[derive(Default)]
pub struct TerminalEffects {
    pub request_redraw: bool,
}

pub fn apply_terminal_effects<B>(
    terminal: &mut crate::app::render::custom_terminal::Terminal<B>,
    app: &mut AppState,
    log_changed_since_draw: bool,
) -> std::io::Result<TerminalEffects>
where
    B: Backend + Write,
{
    if log_changed_since_draw {
        app.request_scrollback_sync();
    }

    if app.scroll_from_bottom > 0 {
        app.assert_render_invariants();
        return Ok(TerminalEffects::default());
    }

    match app.render_state.sync_phase {
        SyncPhase::Idle => {
            app.assert_render_invariants();
            return Ok(TerminalEffects::default());
        }
        SyncPhase::InsertedNeedsRedraw => {
            app.render_state.sync_phase = SyncPhase::Idle;
            app.render_state.cursor_phase = CursorPhase::VisibleAtComposer;
            app.assert_render_invariants();
            return Ok(TerminalEffects::default());
        }
        SyncPhase::NeedsInsert => {}
    }

    let overflow = app
        .render_state
        .visible_start
        .min(app.render_state.wrapped_total);

    if overflow <= app.render_state.inserted_until {
        app.render_state.sync_phase = SyncPhase::Idle;
        app.assert_render_invariants();
        return Ok(TerminalEffects::default());
    }

    let start = app.render_state.inserted_until.min(overflow);
    if start >= overflow {
        app.render_state.inserted_until = overflow;
        app.render_state.sync_phase = SyncPhase::Idle;
        app.assert_render_invariants();
        return Ok(TerminalEffects::default());
    }

    let log_width = terminal.viewport_area.width as usize;
    let lines = wrapped_log_range_to_lines(app, log_width, start, overflow);
    if lines.is_empty() {
        app.render_state.inserted_until = overflow;
        app.render_state.sync_phase = SyncPhase::Idle;
        app.assert_render_invariants();
        return Ok(TerminalEffects::default());
    }
    app.render_state.cursor_phase = CursorPhase::HiddenDuringScrollbackInsert;
    terminal.hide_cursor()?;
    let max_lines_per_insert = {
        let width = terminal.viewport_area.width.max(1);
        let max_lines = u16::MAX / width;
        usize::from(max_lines.max(1))
    };
    for chunk in lines.chunks(max_lines_per_insert) {
        insert_history_lines(terminal, chunk.to_vec())?;
    }
    app.render_state.inserted_until = overflow;
    app.render_state.sync_phase = SyncPhase::InsertedNeedsRedraw;
    app.assert_render_invariants();
    Ok(TerminalEffects {
        request_redraw: true,
    })
}
