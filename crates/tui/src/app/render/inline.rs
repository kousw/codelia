use crate::app::log_wrap::log_lines_to_lines;
use crate::app::{AppState, CursorPhase, SyncPhase};
use ratatui::backend::Backend;
use ratatui::layout::Rect;
use ratatui::text::Line;
use ratatui::widgets::Widget;
use ratatui::Terminal;
use unicode_width::UnicodeWidthStr;

#[derive(Default)]
pub struct TerminalEffects {
    pub request_redraw: bool,
}

fn insert_history_chunk<B: Backend>(
    terminal: &mut Terminal<B>,
    lines: &[Line<'static>],
    viewport_width: u16,
) -> Result<usize, B::Error> {
    if lines.is_empty() {
        return Ok(0);
    }

    let height = u16::try_from(lines.len()).expect("history chunk height fits in u16");
    terminal.insert_before(height, |buffer| {
        let width = buffer.area.width.min(viewport_width).max(1);
        for (row, line) in lines.iter().enumerate() {
            line.clone()
                .render(Rect::new(0, row as u16, width, 1), buffer);
        }
        // Ratatui 0.30's LF insert_before path emits every cell, unlike frame
        // diffs which skip wide-glyph continuation cells. Printing their spaces
        // advances Crossterm past the real column (and can wrap at the edge).
        // Empty symbols consume no columns; keep actual spaces and styles intact.
        // Only normalize this disposable insertion buffer, never frame buffers.
        for row in buffer.content.chunks_mut(buffer.area.width as usize) {
            let mut continuation = 0;
            for cell in row {
                if continuation > 0 {
                    cell.set_symbol("");
                    continuation -= 1;
                } else {
                    continuation = cell.symbol().width().saturating_sub(1);
                }
            }
        }
    })?;
    Ok(lines.len())
}

pub fn apply_terminal_effects<B: Backend>(
    terminal: &mut Terminal<B>,
    app: &mut AppState,
    log_changed_since_draw: bool,
    viewport_width: u16,
) -> Result<TerminalEffects, B::Error> {
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

    let start = app.render_state.inserted_until;
    // Use the drawn generation verbatim, including on retry after a completed
    // chunk. Rewrapping after advancing the source anchor can change row indices.
    let Some(cache) = app.wrapped_log_cache.as_ref().filter(|cache| {
        !app.log_changed
            && cache.width == usize::from(viewport_width)
            && cache.log_version == app.log_version
    }) else {
        // A too-small viewport can skip layout. Defer until a valid draw rather
        // than committing stale ranges or rebuilding a different generation here.
        return Ok(TerminalEffects::default());
    };
    let rows = &cache.wrapped[start..overflow];
    let mut lines =
        log_lines_to_lines(&rows.iter().map(|row| row.line.clone()).collect::<Vec<_>>());
    // Never commit source text that Line::render would clip. Stop at the first
    // unrenderable row so source progress stays contiguous; a wider draw retries it.
    // This also includes continuation prefixes and user-bubble padding.
    let renderable = lines
        .iter()
        .take_while(|line| line.width() <= usize::from(viewport_width))
        .count();
    lines.truncate(renderable);
    if lines.is_empty() {
        return Ok(TerminalEffects::default());
    }

    app.render_state.cursor_phase = CursorPhase::HiddenDuringScrollbackInsert;
    terminal.hide_cursor()?;
    let max_lines_per_insert = {
        let max_lines = u16::MAX / viewport_width.max(1);
        usize::from(max_lines.max(1))
    };
    for chunk in lines.chunks(max_lines_per_insert) {
        let inserted = insert_history_chunk(terminal, chunk, viewport_width)?;
        app.render_state.inserted_until = app
            .render_state
            .inserted_until
            .saturating_add(inserted)
            .min(overflow);
        app.render_state.committed = rows[app.render_state.inserted_until - start - 1].source_end;
    }

    app.render_state.sync_phase = SyncPhase::InsertedNeedsRedraw;
    app.assert_render_invariants();
    Ok(TerminalEffects {
        request_redraw: true,
    })
}

#[cfg(test)]
mod tests {
    use super::insert_history_chunk;
    use ratatui::backend::{Backend, TestBackend};
    use ratatui::layout::Position;
    use ratatui::style::Style;
    use ratatui::text::Line;
    use ratatui::{Terminal, TerminalOptions, Viewport};

    #[test]
    fn insert_history_chunk_is_noop_for_empty_input() {
        let backend = TestBackend::new(12, 4);
        let mut terminal = Terminal::with_options(
            backend,
            TerminalOptions {
                viewport: Viewport::Inline(4),
            },
        )
        .expect("terminal");

        let inserted = insert_history_chunk(&mut terminal, &[], 12).expect("insert");

        assert_eq!(inserted, 0);
        terminal.backend().assert_buffer_lines([
            "            ",
            "            ",
            "            ",
            "            ",
        ]);
    }

    #[test]
    fn insert_history_chunk_uses_scrollback_when_inline_viewport_fills_screen() {
        let mut backend = TestBackend::new(12, 4);
        backend
            .set_cursor_position(Position::ORIGIN)
            .expect("cursor");
        let mut terminal = Terminal::with_options(
            backend,
            TerminalOptions {
                viewport: Viewport::Inline(4),
            },
        )
        .expect("terminal");

        terminal
            .draw(|frame| {
                let area = frame.area();
                frame
                    .buffer_mut()
                    .set_string(area.x, area.y, "VIEW-LINE-00", Style::default());
                frame
                    .buffer_mut()
                    .set_string(area.x, area.y + 1, "VIEW-LINE-01", Style::default());
                frame
                    .buffer_mut()
                    .set_string(area.x, area.y + 2, "VIEW-LINE-02", Style::default());
                frame
                    .buffer_mut()
                    .set_string(area.x, area.y + 3, "VIEW-LINE-03", Style::default());
            })
            .expect("draw");

        let inserted = insert_history_chunk(
            &mut terminal,
            &[Line::raw("INSERTED-001"), Line::raw("INSERTED-002")],
            12,
        )
        .expect("insert");

        assert_eq!(inserted, 2);
        terminal
            .backend()
            .assert_scrollback_lines(["INSERTED-001", "INSERTED-002"]);
        // LF-based insertion clears the viewport; the required follow-up draw
        // restores it without sending UI chrome into native scrollback.
        terminal
            .draw(|frame| {
                let area = frame.area();
                for (row, text) in [
                    "VIEW-LINE-00",
                    "VIEW-LINE-01",
                    "VIEW-LINE-02",
                    "VIEW-LINE-03",
                ]
                .iter()
                .enumerate()
                {
                    frame.buffer_mut().set_string(
                        area.x,
                        area.y + row as u16,
                        text,
                        Style::default(),
                    );
                }
            })
            .expect("follow-up draw");
        terminal
            .backend()
            .assert_scrollback_lines(["INSERTED-001", "INSERTED-002"]);
        terminal.backend().assert_buffer_lines([
            "VIEW-LINE-00",
            "VIEW-LINE-01",
            "VIEW-LINE-02",
            "VIEW-LINE-03",
        ]);
    }
}
