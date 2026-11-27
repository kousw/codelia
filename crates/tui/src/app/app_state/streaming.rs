use crate::app::state::render::LogPosition;
use crate::app::state::stream_preview::{StreamSegment, StreamUpdate};
use crate::app::state::{LogKind, LogLine};
use crate::app::transcript::{render_body, stable_body_prefix};
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
            self.mark_log_changed();
        }
    }

    pub(crate) fn flush_stream_output(&mut self) {
        if !std::mem::take(&mut self.stream_dirty) {
            return;
        }
        let started = std::time::Instant::now();
        // Runtime may drain many token events in one tick. Parse and highlight
        // once before drawing, handoff or reset rather than once per token.
        let mut segments = std::mem::take(self.stream_preview.segments_mut());
        let count = segments.len();
        for (index, segment) in segments.iter_mut().enumerate() {
            let body = render_body(&segment.content, segment.reasoning);
            self.update_stream_rows(segment, &body);
            let stable = render_body(
                stable_body_prefix(&segment.content, segment.reasoning, index + 1 < count),
                segment.reasoning,
            );
            segment.stable_end = stable_boundary(&body, &stable, &segment.row_indices);
        }
        *self.stream_preview.segments_mut() = segments;
        self.mark_log_changed();
        self.perf.record_stream_flush(started.elapsed());
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

    fn update_stream_rows(&mut self, segment: &mut StreamSegment, body: &[LogLine]) {
        for (offset, line) in body.iter().enumerate() {
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
                segment.row_indices.push(self.log.len());
                self.extend_lines(vec![line.clone()]);
            }
        }
        for index in segment.row_indices.drain(body.len()..).rev() {
            let start = LogPosition {
                line: index,
                grapheme: 0,
            };
            if index + 1 == self.log.len() && start >= self.render_state.committed {
                self.log.pop();
                self.mark_log_changed();
            } else {
                // An unrelated status can follow the mutable line. Keep source
                // indices stable rather than removing a row from the middle.
                self.replace_log_line(index, LogLine::new(LogKind::Space, ""));
            }
        }
    }

    pub(crate) fn clear_stream_output(&mut self) {
        self.flush_stream_output();
        // Already displayed text is evidence. Native history cannot be erased
        // on retry/cancel; release the mutable tail and retain the observed attempt.
        if self.stream_preview.clear() {
            self.mark_log_changed();
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
                self.update_stream_rows(segment, &body);
                lines.clear();
            }
        }
        *self.stream_preview.segments_mut() = segments;
        self.stream_preview.consume(reasoning, canonical);
        self.mark_log_changed();
        true
    }
}

fn stable_boundary(body: &[LogLine], stable: &[LogLine], indices: &[usize]) -> Option<LogPosition> {
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
        let full = line.plain_text();
        let partial = prefix.plain_text();
        let grapheme = full
            .graphemes(true)
            .zip(partial.graphemes(true))
            .take_while(|(a, b)| a == b)
            .count();
        return Some(LogPosition {
            line: source_line,
            grapheme,
        });
    }
    None
}
