use crate::app::state::render::LogPosition;
use crate::app::state::stream_preview::{StreamSegment, StreamUpdate};
use crate::app::state::{LogKind, LogLine};
use crate::app::transcript::{render_body, render_single_body_line, stable_body_prefix};
use crate::app::AppState;
use unicode_segmentation::UnicodeSegmentation;

impl AppState {
    pub(crate) fn apply_stream_update(&mut self, update: StreamUpdate) {
        let StreamUpdate::Append {
            ref run_id,
            ref stream_id,
            ref content,
            ..
        } = update;
        if !content.is_empty()
            && self.runtime_info.active_run_id.as_deref() == Some(run_id.as_str())
            && !self.stream_preview.matches(run_id, stream_id)
            && !self.stream_preview.is_retired(run_id, stream_id)
        {
            self.flush_stream_output();
        }
        if self
            .stream_preview
            .apply(update, self.runtime_info.active_run_id.as_deref())
        {
            self.stream_dirty = true;
            self.log_changed = true;
        }
    }

    pub(crate) fn flush_stream_output(&mut self) {
        if !std::mem::take(&mut self.stream_dirty) {
            return;
        }
        let started = std::time::Instant::now();
        // Runtime may drain many token events in one tick. Parse and highlight
        // incrementally once before drawing, handoff or reset rather than once per token.
        let mut segments = std::mem::take(self.stream_preview.segments_mut());
        let count = segments.len();
        for (index, segment) in segments.iter_mut().enumerate() {
            let channel_closed = index + 1 < count;
            if segment.content.trim().is_empty() {
                segment.reset_render_cache();
                self.truncate_stream_rows(segment, 0);
                segment.stable_end = None;
                continue;
            }
            let (trimmed_len, prev_committed, tail_lines) = {
                let trimmed = segment.content.trim_end_matches(['\n', '\r']);
                let trimmed_len = trimmed.len();
                let (prev_committed, tail_lines) = segment.render_cache.advance(trimmed);
                (trimmed_len, prev_committed, tail_lines)
            };
            let committed_len = segment.render_cache.committed_lines().len();
            let total_body_len = 1 + committed_len + tail_lines.len();

            // Write offset 0 (leading Space) if not yet synced.
            if segment.synced_committed_rows == 0 {
                self.write_stream_row(segment, 0, &LogLine::new(LogKind::Space, ""));
            }

            // Write any newly committed lines (starting from the earlier of
            // prev_committed and synced_committed_rows - 1).
            let synced_content = segment.synced_committed_rows.saturating_sub(1);
            let start_committed = prev_committed.min(synced_content);
            for content_idx in start_committed..committed_len {
                let line = segment.render_cache.committed_lines()[content_idx].clone();
                self.write_stream_row(segment, 1 + content_idx, &line);
            }
            segment.synced_committed_rows = 1 + committed_len;

            // Write the mutable trailing line(s) (0 or 1 line).
            for (tail_idx, line) in tail_lines.iter().enumerate() {
                self.write_stream_row(segment, 1 + committed_len + tail_idx, line);
            }
            self.truncate_stream_rows(segment, total_body_len);

            segment.stable_end =
                self.compute_stable_end(segment, trimmed_len, &tail_lines, channel_closed);
        }
        *self.stream_preview.segments_mut() = segments;
        self.perf.record_stream_flush(started.elapsed());
    }

    fn compute_stable_end(
        &self,
        segment: &StreamSegment,
        full_trimmed_len: usize,
        tail_lines: &[LogLine],
        channel_closed: bool,
    ) -> Option<LogPosition> {
        let prefix = stable_body_prefix(&segment.content, segment.reasoning, channel_closed);
        if prefix.trim().is_empty() {
            return segment
                .row_indices
                .first()
                .map(|&line| LogPosition { line, grapheme: 0 });
        }
        let stable_trimmed = prefix.trim_end_matches(['\n', '\r']);
        if stable_trimmed.len() == full_trimmed_len {
            return None;
        }
        let committed_bytes = segment.render_cache.committed_bytes();
        let committed_len = segment.render_cache.committed_lines().len();
        if stable_trimmed.len() <= committed_bytes {
            let end_bytes = segment.render_cache.committed_line_end_bytes();
            let stable_committed = end_bytes.partition_point(|&end| end <= stable_trimmed.len());
            if stable_committed == 0 {
                // Edge case before any committed content line (e.g. opening fence only):
                // `prefix` is tiny, so compare against reference render_body(prefix).
                let stable = render_body(prefix, segment.reasoning);
                let body_prefix_len = (stable.len() + 1).min(segment.row_indices.len());
                for offset in 0..body_prefix_len {
                    let source_line = segment.row_indices[offset];
                    let Some(body_line) = self.log.get(source_line) else {
                        break;
                    };
                    let Some(prefix_line) = stable.get(offset) else {
                        return Some(LogPosition {
                            line: source_line,
                            grapheme: 0,
                        });
                    };
                    if body_line != prefix_line {
                        let grapheme = common_grapheme_prefix(body_line, prefix_line);
                        return Some(LogPosition {
                            line: source_line,
                            grapheme,
                        });
                    }
                }
                return segment
                    .row_indices
                    .get(stable.len())
                    .map(|&line| LogPosition { line, grapheme: 0 });
            }
            return segment
                .row_indices
                .get(1 + stable_committed)
                .map(|&line| LogPosition { line, grapheme: 0 });
        }

        // `stable_trimmed` extends into the single trailing line past `committed_bytes`.
        let tail_offset = 1 + committed_len;
        let &source_line = segment.row_indices.get(tail_offset)?;
        if segment.render_cache.in_code_block() {
            return Some(LogPosition {
                line: source_line,
                grapheme: 0,
            });
        }
        let body_tail = tail_lines.first()?;
        let stable_tail_raw = &stable_trimmed[committed_bytes..];
        let stable_tail_line = render_single_body_line(stable_tail_raw, segment.reasoning);
        if body_tail == &stable_tail_line {
            return None;
        }
        let grapheme = common_grapheme_prefix(body_tail, &stable_tail_line);
        Some(LogPosition {
            line: source_line,
            grapheme,
        })
    }

    /// The unconfirmed tail may change Markdown presentation; all preceding rows
    /// can enter native history while generation is still running.
    pub(crate) fn stream_commit_boundary(&self) -> LogPosition {
        self.stream_preview
            .segments()
            .iter()
            .filter_map(|segment| segment.stable_end)
            .min()
            .unwrap_or(LogPosition {
                line: self.log.len(),
                grapheme: 0,
            })
    }

    fn write_stream_row(&mut self, segment: &mut StreamSegment, offset: usize, line: &LogLine) {
        if let Some(index) = segment.row_indices.get(offset).copied() {
            if self.log.get(index) != Some(line) {
                let committed = self.render_state.committed;
                self.replace_log_line(index, line.clone());
                // A temporarily empty suffix does not finish this logical
                // line: later deltas may append to it again.
                if committed.line == index
                    && committed.grapheme > 0
                    && line.plain_text().graphemes(true).count() == committed.grapheme
                {
                    self.render_state.committed = committed;
                }
            }
        } else {
            debug_assert_eq!(segment.row_indices.len(), offset);
            segment.row_indices.push(self.log.len());
            self.extend_lines(vec![line.clone()]);
        }
    }

    fn truncate_stream_rows(&mut self, segment: &mut StreamSegment, keep_len: usize) {
        if segment.row_indices.len() <= keep_len {
            return;
        }
        for index in segment.row_indices.drain(keep_len..).rev() {
            let start = LogPosition {
                line: index,
                grapheme: 0,
            };
            if index + 1 == self.log.len() && start >= self.render_state.committed {
                self.log.pop();
                self.mark_log_dirty_from(self.log.len());
            } else {
                // An unrelated status can follow the mutable line. Keep source
                // indices stable rather than removing a row from the middle.
                self.replace_log_line(index, LogLine::new(LogKind::Space, ""));
            }
        }
    }

    fn update_stream_rows(&mut self, segment: &mut StreamSegment, body: &[LogLine]) {
        for (offset, line) in body.iter().enumerate() {
            self.write_stream_row(segment, offset, line);
        }
        self.truncate_stream_rows(segment, body.len());
    }

    pub(crate) fn clear_stream_output(&mut self) {
        self.flush_stream_output();
        // Already displayed text is evidence. Native history cannot be erased
        // on retry/cancel; release the mutable tail and retain the observed attempt.
        if self.stream_preview.clear() {
            self.log_changed = true;
        }
    }

    pub(crate) fn reconcile_stream_output(
        &mut self,
        reasoning: bool,
        canonical: &str,
        lines: &mut Vec<LogLine>,
    ) -> bool {
        self.reconcile_output(reasoning, canonical, lines, true)
    }

    pub(crate) fn reconcile_final_output(
        &mut self,
        canonical: &str,
        lines: &mut Vec<LogLine>,
    ) -> bool {
        self.flush_stream_output();
        // final joins all text blocks in the attempt, including those separated by reasoning.
        let mut combined: Option<StreamSegment> = None;
        let mut remaining = Vec::new();
        for segment in std::mem::take(self.stream_preview.segments_mut()) {
            if segment.reasoning {
                remaining.push(segment);
            } else if let Some(first) = combined.as_mut() {
                first.content.push('\n');
                first.content.push_str(&segment.content);
                first.row_indices.extend(segment.row_indices);
                first.canonical_prefix_consumed |= segment.canonical_prefix_consumed;
                first.reset_render_cache();
            } else {
                combined = Some(segment);
            }
        }
        if let Some(segment) = combined {
            remaining.insert(0, segment);
        }
        *self.stream_preview.segments_mut() = remaining;
        self.reconcile_output(false, canonical, lines, false)
    }

    fn reconcile_output(
        &mut self,
        reasoning: bool,
        canonical: &str,
        lines: &mut Vec<LogLine>,
        partial: bool,
    ) -> bool {
        self.flush_stream_output();
        let Some(index) = self
            .stream_preview
            .segments()
            .iter()
            .position(|segment| segment.reasoning == reasoning)
        else {
            return false;
        };
        let mut segments = std::mem::take(self.stream_preview.segments_mut());
        let segment = &mut segments[index];
        let matches = (partial && segment.content.starts_with(canonical))
            || segment.content.trim() == canonical.trim();
        if partial && !matches {
            // A complete event can include a block that never streamed (e.g. redacted thinking).
            // Provisional indices cannot identify canonical blocks; leave pending segments intact.
            *self.stream_preview.segments_mut() = segments;
            return false;
        }
        if matches {
            // The entire received response is already rendered, including any
            // later canonical messages in this channel. Do not append it again.
            lines.clear();
        } else {
            let body = render_body(canonical, reasoning);
            let committed = self.render_state.committed;
            let changes_committed = segment.canonical_prefix_consumed
                || segment.row_indices.iter().enumerate().any(|(offset, row)| {
                    let old = self.log.get(*row);
                    let new = body.get(offset);
                    if (LogPosition {
                        line: row + 1,
                        grapheme: 0,
                    }) <= committed
                    {
                        old != new
                    } else if committed.line == *row && committed.grapheme > 0 {
                        let old_text = old.map(LogLine::plain_text).unwrap_or_default();
                        let new_text = new.map(LogLine::plain_text).unwrap_or_default();
                        old_text
                            .graphemes(true)
                            .take(committed.grapheme)
                            .ne(new_text.graphemes(true).take(committed.grapheme))
                    } else {
                        false
                    }
                });
            if changes_committed {
                // Canonical correction of an already observed prefix must remain
                // visible; do not silently overwrite immutable native history.
                lines.insert(
                    0,
                    LogLine::new(LogKind::Status, "Response revised after streaming:"),
                );
            } else {
                segment.reset_render_cache();
                self.update_stream_rows(segment, &body);
                lines.clear();
            }
        }
        *self.stream_preview.segments_mut() = segments;
        self.stream_preview.consume(reasoning, canonical);
        self.log_changed = true;
        true
    }
}

fn common_grapheme_prefix(a: &LogLine, b: &LogLine) -> usize {
    let full = a.plain_text();
    let partial = b.plain_text();
    full.graphemes(true)
        .zip(partial.graphemes(true))
        .take_while(|(x, y)| x == y)
        .count()
}

#[cfg(test)]
mod incremental_stream_tests {
    use super::*;
    use crate::app::state::stream_preview::StreamUpdate;

    fn reference_stable_boundary(
        body: &[LogLine],
        stable: &[LogLine],
        indices: &[usize],
    ) -> Option<LogPosition> {
        for (offset, line) in body.iter().enumerate() {
            let source_line = indices[offset];
            let Some(prefix) = stable.get(offset) else {
                return Some(LogPosition {
                    line: source_line,
                    grapheme: 0,
                });
            };
            if line == prefix {
                continue;
            }
            return Some(LogPosition {
                line: source_line,
                grapheme: common_grapheme_prefix(line, prefix),
            });
        }
        None
    }

    #[test]
    fn incremental_flush_matches_full_render_body_and_stable_boundary_for_all_inputs() {
        let cases: &[(&str, bool)] = &[
            ("hello **unfinished", false),
            ("hello `unfinished", false),
            ("```rust\nlet x = unfinished", false),
            (
                "```rust\nfn main() {\n    let x = 1;\n}\n```\n\nAfter **bold** and `code`.",
                false,
            ),
            (
                "line1\n\nline2\n\n```ts\nconst a = 1;\n\nconst b = 2;\n```\nend",
                false,
            ),
            (
                "# Heading\n- item 1\n  * item 2\n> quote\n日本語 👨\u{200d}👩\u{200d}👧",
                false,
            ),
            ("```rust", false),
            ("   \n\n", false),
            ("step 1\nstep 2\n日本語の長い段落", true),
        ];

        for &(full_text, reasoning) in cases {
            let mut app = AppState::default();
            app.runtime_info.active_run_id = Some("run-eq".into());

            // Stream character-by-character (UTF-8 boundaries) and verify EVERY step!
            let chars: Vec<char> = full_text.chars().collect();
            let mut accumulated = String::new();
            for chunk in chars.chunks(3) {
                let piece: String = chunk.iter().collect();
                accumulated.push_str(&piece);
                app.apply_stream_update(StreamUpdate::Append {
                    run_id: "run-eq".into(),
                    stream_id: "s-eq".into(),
                    index: 0,
                    reasoning,
                    content: piece,
                });
                app.flush_stream_output();

                let expected_body = render_body(&accumulated, reasoning);
                assert_eq!(
                    app.log, expected_body,
                    "log mismatch for reasoning={reasoning} content={accumulated:?}"
                );
                let expected_stable = render_body(
                    stable_body_prefix(&accumulated, reasoning, false),
                    reasoning,
                );
                let seg = &app.stream_preview.segments()[0];
                let expected_end =
                    reference_stable_boundary(&expected_body, &expected_stable, &seg.row_indices);
                assert_eq!(
                    seg.stable_end, expected_end,
                    "stable_end mismatch for reasoning={reasoning} content={accumulated:?}"
                );
            }
        }
    }
}
