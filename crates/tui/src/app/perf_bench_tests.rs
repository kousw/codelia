use crate::app::frame::draw_frame;
use crate::app::state::stream_preview::StreamUpdate;
use crate::app::state::LogKind;
use crate::app::AppState;
use ratatui::backend::TestBackend;
use ratatui::{Terminal, TerminalOptions, Viewport};
use std::time::Instant;

fn seed_large_transcript(app: &mut AppState, count: usize) {
    for i in 0..count {
        let kind = match i % 5 {
            0 => LogKind::User,
            1 => LogKind::Assistant,
            2 => LogKind::AssistantCode,
            3 => LogKind::ToolResult,
            _ => LogKind::Status,
        };
        app.push_line(
            kind,
            format!(
                "  line {i:04}: const entry = compute_metric(session_id, delta_ms, cache_ratio); // sample payload"
            ),
        );
    }
}

fn streaming_chunks() -> Vec<String> {
    let mut chunks = Vec::new();
    chunks.push(
        "# Performance Report\n\nHere is a **streaming** `Rust` example:\n\n```rust\n".to_string(),
    );
    for i in 0..160 {
        chunks.push(format!(
            "pub fn step_{i:03}(input: &[u64], acc: u64) -> u64 {{ input.iter().fold(acc, |a, b| a.wrapping_add(*b)) }}\n"
        ));
    }
    chunks.push(
        "```\n\nSummary paragraph after the code block with **bold** and `inline code`.\n"
            .to_string(),
    );
    chunks
}

#[test]
fn stress_streaming_on_large_transcript_alternate_and_inline() {
    let chunks = streaming_chunks();

    // 1. Alternate mode stress (5,000 existing log lines + 162 streaming chunks, drawing each chunk)
    let mut alt_app = AppState::default();
    alt_app.runtime_info.active_run_id = Some("run-bench".into());
    seed_large_transcript(&mut alt_app, 5_000);
    let mut alt_terminal = Terminal::new(TestBackend::new(100, 30)).expect("alt terminal");
    draw_frame(&mut alt_terminal, &mut alt_app, false).expect("initial draw");

    let alt_started = Instant::now();
    for chunk in &chunks {
        alt_app.apply_stream_update(StreamUpdate::Append {
            run_id: "run-bench".into(),
            stream_id: "s-1".into(),
            index: 0,
            reasoning: false,
            content: chunk.clone(),
        });
        let frame_started = Instant::now();
        let outcome = draw_frame(&mut alt_terminal, &mut alt_app, false).expect("draw");
        alt_app.record_perf_frame(frame_started.elapsed(), outcome.draw_elapsed);
    }
    let alt_total_ms = alt_started.elapsed().as_secs_f64() * 1000.0;

    // 2. Inline scrollback stress (2,000 existing log lines + 162 streaming chunks)
    let mut inline_app = AppState::default();
    inline_app.runtime_info.active_run_id = Some("run-bench-inline".into());
    seed_large_transcript(&mut inline_app, 2_000);
    let mut inline_terminal = Terminal::with_options(
        TestBackend::new(100, 24),
        TerminalOptions {
            viewport: Viewport::Inline(24),
        },
    )
    .expect("inline terminal");
    draw_frame(&mut inline_terminal, &mut inline_app, true).expect("initial inline draw");

    let inline_started = Instant::now();
    for chunk in &chunks {
        inline_app.apply_stream_update(StreamUpdate::Append {
            run_id: "run-bench-inline".into(),
            stream_id: "s-2".into(),
            index: 0,
            reasoning: false,
            content: chunk.clone(),
        });
        let frame_started = Instant::now();
        let outcome = draw_frame(&mut inline_terminal, &mut inline_app, true).expect("inline draw");
        inline_app.record_perf_frame(frame_started.elapsed(), outcome.draw_elapsed);
    }
    let inline_total_ms = inline_started.elapsed().as_secs_f64() * 1000.0;

    eprintln!(
        "[bench:alt] total={alt_total_ms:.1}ms frame(p95/max)={:.2}/{:.2}ms flush(p95/max)={:.2}/{:.2}ms wrap_miss(p95/max/n)={:.2}/{:.2}ms/{}",
        alt_app.perf.frame.p95_ms(),
        alt_app.perf.frame.max_ms(),
        alt_app.perf.stream_flush.p95_ms(),
        alt_app.perf.stream_flush.max_ms(),
        alt_app.perf.wrap_miss.p95_ms(),
        alt_app.perf.wrap_miss.max_ms(),
        alt_app.perf.wrap_cache_misses,
    );
    eprintln!(
        "[bench:inline] total={inline_total_ms:.1}ms frame(p95/max)={:.2}/{:.2}ms flush(p95/max)={:.2}/{:.2}ms wrap_miss(p95/max/n)={:.2}/{:.2}ms/{}",
        inline_app.perf.frame.p95_ms(),
        inline_app.perf.frame.max_ms(),
        inline_app.perf.stream_flush.p95_ms(),
        inline_app.perf.stream_flush.max_ms(),
        inline_app.perf.wrap_miss.p95_ms(),
        inline_app.perf.wrap_miss.max_ms(),
        inline_app.perf.wrap_cache_misses,
    );

    assert!(alt_app.log.len() > 5_160);
    assert!(inline_app.log.len() > 2_160);
    assert!(inline_app.render_state.inserted_until > 0);
}
