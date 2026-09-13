use super::inline::apply_terminal_effects;
use crate::app::log_wrap::wrapped_log_range_to_lines;
use crate::app::state::render::LogPosition;
use crate::app::state::{LogKind, LogLine};
use crate::app::view::{desired_height, draw_ui};
use crate::app::{AppState, SyncPhase};
use ratatui::backend::TestBackend;
use ratatui::buffer::Buffer;
use ratatui::{Terminal, TerminalOptions, Viewport};

fn terminal(width: u16) -> Terminal<TestBackend> {
    Terminal::with_options(
        TestBackend::new(width, 12),
        TerminalOptions {
            viewport: Viewport::Inline(12),
        },
    )
    .unwrap()
}

fn tick(terminal: &mut Terminal<TestBackend>, app: &mut AppState) {
    let changed = app.log_changed;
    let mut width = 0;
    terminal
        .draw(|frame| {
            width = frame.area().width;
            draw_ui(frame, app);
        })
        .unwrap();
    apply_terminal_effects(terminal, app, changed, width).unwrap();
}

fn settle(terminal: &mut Terminal<TestBackend>, app: &mut AppState) {
    // Also check that idle redraws don't replay history.
    for _ in 0..3 {
        tick(terminal, app);
    }
    assert_eq!(app.render_state.sync_phase, SyncPhase::Idle);
}

fn logs() -> AppState {
    let mut app = AppState::default();
    for i in 0..20 {
        app.push_line(LogKind::Assistant, format!("{i:02}-{}", "x".repeat(37)));
    }
    app
}

fn visible(app: &mut AppState) -> Vec<String> {
    let width = app.last_wrap_width;
    let start = app.render_state.visible_start;
    let end = app.render_state.visible_end;
    wrapped_log_range_to_lines(app, width, start, end)
        .iter()
        .map(|line| line.spans.iter().map(|s| s.content.as_ref()).collect())
        .collect()
}

fn buffer_rows(buffer: &Buffer) -> Vec<String> {
    (buffer.area.y..buffer.area.bottom())
        .map(|y| {
            (buffer.area.x..buffer.area.right())
                .map(|x| buffer[(x, y)].symbol())
                .collect::<String>()
                .trim_end()
                .to_string()
        })
        .collect()
}

fn expected_logs(range: std::ops::Range<usize>) -> String {
    range
        .map(|i| format!("{i:02}-{}", "x".repeat(37)))
        .collect()
}

#[test]
fn widening_preserves_uninserted_tail_without_replaying_history() {
    let mut terminal = terminal(20);
    let mut app = logs();
    settle(&mut terminal, &mut app);
    assert_eq!(
        app.render_state.committed,
        LogPosition {
            line: 17,
            grapheme: 0
        }
    );
    let history = buffer_rows(terminal.backend().scrollback());
    assert_eq!(history.concat(), expected_logs(0..17));
    terminal.backend_mut().resize(40, 12);
    let resized_history = buffer_rows(terminal.backend().scrollback());
    settle(&mut terminal, &mut app);
    assert_eq!(
        buffer_rows(terminal.backend().scrollback()),
        resized_history
    );
    assert_eq!(visible(&mut app).concat(), expected_logs(17..20));
}

#[test]
fn narrowing_inserts_only_new_logical_content() {
    let mut terminal = terminal(40);
    let mut app = logs();
    settle(&mut terminal, &mut app);
    assert_eq!(
        app.render_state.committed,
        LogPosition {
            line: 14,
            grapheme: 0
        }
    );
    let previous_rows = terminal.backend().scrollback().area.height as usize;
    terminal.backend_mut().resize(20, 12);
    settle(&mut terminal, &mut app);
    let history = buffer_rows(terminal.backend().scrollback());
    // TestBackend does not emulate terminal reflow; inspect only newly inserted rows.
    assert_eq!(history[previous_rows..].concat(), expected_logs(14..17));
    assert_eq!(visible(&mut app).concat(), expected_logs(17..20));
}

#[test]
fn historical_replacements_do_not_skip_or_replay_pending_rows() {
    let mut terminal = terminal(20);
    let mut app = logs();
    settle(&mut terminal, &mut app);
    let history = buffer_rows(terminal.backend().scrollback());
    for replacement in ["short".to_string(), "long".repeat(50)] {
        app.replace_log_line(0, LogLine::new(LogKind::Assistant, replacement));
        settle(&mut terminal, &mut app);
        assert_eq!(buffer_rows(terminal.backend().scrollback()), history);
        assert_eq!(visible(&mut app).concat(), expected_logs(17..20));
    }
}

#[test]
fn large_history_uses_all_available_log_rows_without_u16_wrap() {
    let mut terminal = terminal(40);
    let mut app = AppState::default();
    for _ in 0..65536 {
        app.push_line(LogKind::Assistant, "row");
    }
    terminal.draw(|frame| draw_ui(frame, &mut app)).unwrap();
    assert_eq!(
        app.render_state.visible_end - app.render_state.visible_start,
        6
    );
    assert_eq!(desired_height(&mut app, 40, 12), 12);
}

#[test]
fn partial_line_survives_repeated_resizes_without_loss_or_duplication() {
    let mut terminal = terminal(20);
    let mut app = AppState::default();
    let text = (0..60).map(|i| format!("{i:03}")).collect::<String>();
    app.push_line(LogKind::Assistant, &text);
    settle(&mut terminal, &mut app);
    assert_eq!(
        app.render_state.committed,
        LogPosition {
            line: 0,
            grapheme: 60
        }
    );
    let mut committed_text = buffer_rows(terminal.backend().scrollback()).concat();
    for width in [40, 13, 60, 20, 33] {
        let before = terminal.backend().scrollback().area.height as usize;
        terminal.backend_mut().resize(width, 12);
        settle(&mut terminal, &mut app);
        committed_text.push_str(&buffer_rows(terminal.backend().scrollback())[before..].concat());
        assert_eq!(
            format!("{committed_text}{}", visible(&mut app).concat()),
            text
        );
    }
}

#[test]
fn unicode_grapheme_boundary_survives_rewrap() {
    let mut terminal = terminal(20);
    let mut app = AppState::default();
    let text = "\u{65e5}e\u{301}\u{1f469}\u{200d}\u{1f4bb}".repeat(30);
    app.push_line(LogKind::Assistant, &text);
    settle(&mut terminal, &mut app);
    let committed = app.render_state.committed;
    assert_eq!(committed.line, 0);
    assert!(committed.grapheme > 0);
    // Read the source prefix, since backend wide-cell placeholders are not text.
    use unicode_segmentation::UnicodeSegmentation;
    let prefix: String = text.graphemes(true).take(committed.grapheme).collect();
    terminal.backend_mut().resize(50, 12);
    settle(&mut terminal, &mut app);
    assert_eq!(app.render_state.committed, committed);
    assert_eq!(format!("{prefix}{}", visible(&mut app).concat()), text);
}

#[test]
fn partial_line_revision_replays_changed_prefix_but_not_unchanged_prefix() {
    let mut terminal = terminal(20);
    let mut app = AppState::default();
    app.push_line(LogKind::Assistant, "x".repeat(180));
    settle(&mut terminal, &mut app);
    let committed = app.render_state.committed;
    let revised = format!("{}{}", "x".repeat(committed.grapheme), "new-tail");
    app.replace_log_line(0, LogLine::new(LogKind::Assistant, revised));
    settle(&mut terminal, &mut app);
    assert_eq!(app.render_state.committed, committed);
    assert_eq!(visible(&mut app), ["new-tail"]);
    app.replace_log_line(0, LogLine::new(LogKind::Assistant, "revised-prefix"));
    settle(&mut terminal, &mut app);
    assert_eq!(app.render_state.committed, LogPosition::default());
    assert_eq!(visible(&mut app), ["revised-prefix"]);
}

#[test]
fn clear_log_resets_source_progress_and_allows_new_history() {
    let mut terminal = terminal(40);
    let mut app = logs();
    settle(&mut terminal, &mut app);
    let old_height = terminal.backend().scrollback().area.height as usize;
    app.clear_log();
    assert_eq!(app.render_state.committed, LogPosition::default());
    for i in 0..20 {
        app.push_line(LogKind::Assistant, format!("new-{i}"));
    }
    settle(&mut terminal, &mut app);
    let history = buffer_rows(terminal.backend().scrollback());
    assert_eq!(
        history[old_height..],
        (0..14).map(|i| format!("new-{i}")).collect::<Vec<_>>()
    );
    assert_eq!(
        visible(&mut app),
        (14..20).map(|i| format!("new-{i}")).collect::<Vec<_>>()
    );
}

#[test]
fn layout_only_changes_commit_content_once() {
    let mut terminal = terminal(40);
    let mut app = logs();
    settle(&mut terminal, &mut app);
    app.input.buffer = "first\nsecond\nthird".chars().collect();
    settle(&mut terminal, &mut app);
    let history = buffer_rows(terminal.backend().scrollback());
    assert_eq!(
        format!("{}{}", history.concat(), visible(&mut app).concat()),
        expected_logs(0..20)
    );
    app.input.clear();
    settle(&mut terminal, &mut app);
    assert_eq!(buffer_rows(terminal.backend().scrollback()), history);
    assert_eq!(
        format!("{}{}", history.concat(), visible(&mut app).concat()),
        expected_logs(0..20)
    );
}

#[test]
fn alternate_draws_keep_all_log_content_available_without_committing() {
    let mut terminal = Terminal::new(TestBackend::new(40, 12)).unwrap();
    let mut app = logs();
    terminal.draw(|frame| draw_ui(frame, &mut app)).unwrap();
    app.scroll_from_bottom = 14;
    terminal.draw(|frame| draw_ui(frame, &mut app)).unwrap();
    assert_eq!(visible(&mut app).concat(), expected_logs(0..6));
    assert_eq!(app.render_state.committed, LogPosition::default());
    terminal.backend().assert_scrollback_empty();
}

#[test]
fn removing_exactly_the_pending_suffix_does_not_replay_committed_text() {
    let mut terminal = terminal(20);
    let mut app = AppState::default();
    app.push_line(LogKind::Assistant, "x".repeat(180));
    settle(&mut terminal, &mut app);
    let prefix_len = app.render_state.committed.grapheme;
    let history = buffer_rows(terminal.backend().scrollback());
    app.replace_log_line(0, LogLine::new(LogKind::Assistant, "x".repeat(prefix_len)));
    settle(&mut terminal, &mut app);
    assert_eq!(
        app.render_state.committed,
        LogPosition {
            line: 1,
            grapheme: 0
        }
    );
    assert!(visible(&mut app).is_empty());
    assert_eq!(buffer_rows(terminal.backend().scrollback()), history);
}

#[test]
fn blank_rows_advance_logical_progress_once() {
    let mut terminal = terminal(40);
    let mut app = AppState::default();
    for _ in 0..20 {
        app.push_line(LogKind::Assistant, "");
    }
    settle(&mut terminal, &mut app);
    assert_eq!(
        app.render_state.committed,
        LogPosition {
            line: 14,
            grapheme: 0
        }
    );
    assert_eq!(terminal.backend().scrollback().area.height, 14);
    terminal.backend_mut().resize(20, 12);
    settle(&mut terminal, &mut app);
    assert_eq!(terminal.backend().scrollback().area.height, 14);
}

#[test]
fn skipped_small_viewport_draw_defers_insertion_without_losing_progress() {
    let mut terminal = terminal(40);
    let mut app = logs();
    // A real drawn range exists, but hasn't been inserted yet.
    terminal.draw(|frame| draw_ui(frame, &mut app)).unwrap();
    app.push_line(LogKind::Assistant, "latest");
    terminal.backend_mut().resize(40, 3);
    terminal.draw(|frame| draw_ui(frame, &mut app)).unwrap();
    // Ratatui may scroll the old viewport while resizing it. Codelia must not
    // additionally insert from stale metrics after the skipped layout.
    let history_after_resize = buffer_rows(terminal.backend().scrollback());
    apply_terminal_effects(&mut terminal, &mut app, true, 40).unwrap();
    assert_eq!(app.render_state.committed, LogPosition::default());
    assert_eq!(
        buffer_rows(terminal.backend().scrollback()),
        history_after_resize
    );
    terminal.backend_mut().resize(40, 12);
    settle(&mut terminal, &mut app);
    assert_eq!(
        app.render_state.committed,
        LogPosition {
            line: 15,
            grapheme: 0
        }
    );
    assert_eq!(visible(&mut app).last().unwrap(), "latest");
}

#[test]
fn user_scrollback_pauses_commits_across_resize_until_return_to_bottom() {
    let mut terminal = terminal(40);
    let mut app = logs();
    settle(&mut terminal, &mut app);
    let committed = app.render_state.committed;
    let old_height = terminal.backend().scrollback().area.height as usize;
    app.scroll_from_bottom = 3;
    terminal.backend_mut().resize(20, 12);
    tick(&mut terminal, &mut app);
    assert_eq!(app.render_state.committed, committed);
    assert_eq!(
        terminal.backend().scrollback().area.height as usize,
        old_height
    );
    app.scroll_from_bottom = 0;
    settle(&mut terminal, &mut app);
    let history = buffer_rows(terminal.backend().scrollback());
    assert_eq!(history[old_height..].concat(), expected_logs(14..17));
    assert_eq!(visible(&mut app).concat(), expected_logs(17..20));
}

#[test]
fn layout_growth_during_followup_draw_does_not_leave_an_uncommitted_gap() {
    let mut terminal = terminal(40);
    let mut app = logs();
    tick(&mut terminal, &mut app);
    assert_eq!(app.render_state.sync_phase, SyncPhase::InsertedNeedsRedraw);
    app.input.buffer = "first\nsecond\nthird".chars().collect();
    tick(&mut terminal, &mut app);
    let history = buffer_rows(terminal.backend().scrollback());
    assert_eq!(
        format!("{}{}", history.concat(), visible(&mut app).concat()),
        expected_logs(0..20)
    );
}

#[test]
fn wide_continuations_preserve_following_ascii_with_ratatui_widths() {
    let mut terminal = terminal(40);
    let mut app = AppState::default();
    let samples = ["\u{65e5}\u{16ff0}ABC", "\u{2630}ABC", "\u{1fae9}ABC"];
    for i in 0..20 {
        app.push_line(
            LogKind::Assistant,
            format!("{i:03}-{}", samples[i % samples.len()]),
        );
    }
    settle(&mut terminal, &mut app);
    let history = buffer_rows(terminal.backend().scrollback());
    assert!(
        !history.is_empty(),
        "exercise insertion, not only the viewport"
    );
    let output = history
        .into_iter()
        .chain(visible(&mut app))
        .collect::<Vec<_>>();
    let expected = (0..20)
        .map(|i| format!("{i:03}-{}", samples[i % samples.len()]))
        .collect::<Vec<_>>();
    assert_eq!(output, expected);
}

#[test]
fn clipped_rows_wait_for_widening_without_committing_source() {
    for (kind, width) in [
        (LogKind::Assistant, 1),
        (LogKind::User, 1),
        (LogKind::User, 2),
        (LogKind::User, 3),
    ] {
        let mut terminal = terminal(width);
        let mut app = AppState::default();
        let text = "\u{65e5}".repeat(80);
        app.push_line(kind, &text);
        for _ in 0..3 {
            tick(&mut terminal, &mut app);
        }
        assert_eq!(app.render_state.committed, LogPosition::default());
        assert!(buffer_rows(terminal.backend().scrollback()).is_empty());
        terminal.backend_mut().resize(20, 12);
        let history_before = buffer_rows(terminal.backend().scrollback()).len();
        settle(&mut terminal, &mut app);
        let history = buffer_rows(terminal.backend().scrollback());
        let output = format!(
            "{}{}",
            history[history_before..].concat(),
            visible(&mut app).concat()
        );
        assert_eq!(output.chars().filter(|c| *c == '\u{65e5}').count(), 80);
    }
}

#[test]
fn oversized_continuation_row_blocks_only_the_unrenderable_suffix() {
    let mut terminal = terminal(3);
    let mut app = AppState::default();
    app.push_line(LogKind::Assistant, "ok");
    app.push_line(LogKind::Assistant, format!("- {}", "\u{65e5}".repeat(80)));
    for _ in 0..3 {
        tick(&mut terminal, &mut app);
    }
    let committed_prefix = buffer_rows(terminal.backend().scrollback()).concat();
    assert!(committed_prefix.starts_with("ok"));
    assert!(app.render_state.committed.line < 2);
    terminal.backend_mut().resize(20, 12);
    let before = buffer_rows(terminal.backend().scrollback()).len();
    settle(&mut terminal, &mut app);
    let history = buffer_rows(terminal.backend().scrollback());
    let output = format!(
        "{committed_prefix}{}{}",
        history[before..].concat(),
        visible(&mut app).concat()
    );
    assert_eq!(output.chars().filter(|c| *c == '\u{65e5}').count(), 80);
}
