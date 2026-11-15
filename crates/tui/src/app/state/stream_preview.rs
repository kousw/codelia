use crate::app::state::render::LogPosition;

#[derive(Debug)]
pub(crate) enum StreamUpdate {
    /// Published delta protocol starts an attempt with its first chunk.
    Append {
        run_id: String,
        stream_id: String,
        index: u64,
        reasoning: bool,
        content: String,
    },
}

#[derive(Debug, Default)]
pub(crate) struct StreamPreview {
    identity: Option<(String, String)>,
    retired_streams: Vec<String>,
    last_block: Option<(bool, u64)>,
    segments: Vec<StreamSegment>,
}

#[derive(Debug)]
pub(crate) struct StreamSegment {
    pub reasoning: bool,
    pub content: String,
    pub row_indices: Vec<usize>,
    pub stable_end: Option<LogPosition>,
    pub canonical_prefix_consumed: bool,
}

impl StreamPreview {
    fn starts_adjacent_block(&mut self, reasoning: bool, index: u64) -> bool {
        let split = self
            .last_block
            .is_some_and(|(kind, previous)| kind == reasoning && previous != index);
        self.last_block = Some((reasoning, index));
        split
    }
    pub(crate) fn clear(&mut self) -> bool {
        let changed = !self.segments.is_empty();
        *self = Self::default();
        changed
    }

    pub(crate) fn segments(&self) -> &[StreamSegment] {
        &self.segments
    }

    pub(crate) fn segments_mut(&mut self) -> &mut Vec<StreamSegment> {
        &mut self.segments
    }

    pub(crate) fn is_retired(&self, run_id: &str, stream_id: &str) -> bool {
        self.identity
            .as_ref()
            .is_some_and(|(active_run, _)| active_run == run_id)
            && self
                .retired_streams
                .iter()
                .any(|retired| retired == stream_id)
    }

    pub(crate) fn apply(&mut self, update: StreamUpdate, active_run: Option<&str>) -> bool {
        let StreamUpdate::Append {
            run_id,
            stream_id,
            index,
            reasoning,
            mut content,
        } = update;
        if content.is_empty() || active_run != Some(run_id.as_str()) {
            return false;
        }
        if !self.matches(&run_id, &stream_id) {
            if self.is_retired(&run_id, &stream_id) {
                return false;
            }
            let retired = match self.identity.take() {
                Some((prev_run, prev_stream)) if prev_run == run_id => {
                    let mut retired = std::mem::take(&mut self.retired_streams);
                    retired.push(prev_stream);
                    retired
                }
                _ => Vec::new(),
            };
            self.clear();
            self.retired_streams = retired;
            self.identity = Some((run_id, stream_id));
        }
        if self.starts_adjacent_block(reasoning, index) {
            content.insert(0, '\n');
        }
        // Keep raw chunks until rendering: control sequences and Markdown can span chunks.
        if let Some(last) = self
            .segments
            .last_mut()
            .filter(|last| last.reasoning == reasoning)
        {
            last.content.push_str(&content);
        } else {
            self.segments.push(StreamSegment {
                reasoning,
                content,
                row_indices: Vec::new(),
                stable_end: None,
                canonical_prefix_consumed: false,
            });
        }
        true
    }

    pub(crate) fn matches(&self, run_id: &str, stream_id: &str) -> bool {
        self.identity
            .as_ref()
            .is_some_and(|(run, stream)| run == run_id && stream == stream_id)
    }

    pub(crate) fn consume(&mut self, reasoning: bool, canonical: &str) -> bool {
        let Some(index) = self
            .segments
            .iter()
            .position(|segment| segment.reasoning == reasoning)
        else {
            return false;
        };
        let segment = &mut self.segments[index];
        if let Some(remaining) = segment.content.strip_prefix(canonical) {
            if !remaining.trim().is_empty() {
                segment.content = remaining.to_string();
                segment.canonical_prefix_consumed = true;
                return true;
            }
        }
        // Exact prefix matches support multiple canonical messages in one channel.
        // Otherwise canonical normalization wins; never leave a duplicate preview behind.
        self.segments.remove(index);
        true
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    fn append(
        state: &mut StreamPreview,
        run: &str,
        stream: &str,
        index: u64,
        reasoning: bool,
        content: &str,
    ) {
        state.apply(
            StreamUpdate::Append {
                run_id: run.into(),
                stream_id: stream.into(),
                index,
                reasoning,
                content: content.into(),
            },
            Some("run"),
        );
    }
    #[test]
    fn retains_full_reasoning_and_text_until_their_canonical_handoffs() {
        let mut state = StreamPreview::default();
        let thought = "日本語🙂\n".repeat(10000);
        append(&mut state, "run", "a", 0, true, &thought);
        append(&mut state, "run", "a", 1, false, "こん");
        append(&mut state, "run", "a", 1, false, "にちは");
        assert_eq!(state.segments[0].content, thought);
        assert_eq!(state.segments[1].content, "こんにちは");
        assert!(state.consume(true, &thought));
        assert_eq!(state.segments[0].content, "こんにちは");
        assert!(state.consume(false, "こんにちは"));
        assert!(state.segments.is_empty());
    }
    #[test]
    fn adjacent_blocks_in_same_channel_join_with_newline_per_stream_only() {
        let mut state = StreamPreview::default();
        append(&mut state, "run", "a", 0, false, "first");
        append(&mut state, "run", "a", 1, false, "second");
        assert_eq!(state.segments[0].content, "first\nsecond");
        append(&mut state, "run", "b", 2, false, "fresh");
        assert_eq!(state.segments.len(), 1);
        assert_eq!(state.segments[0].content, "fresh");
    }
    #[test]
    fn stale_run_attempt_and_inactive_run_cannot_change_current_output() {
        let mut state = StreamPreview::default();
        append(&mut state, "run", "old", 0, false, "discarded");
        append(&mut state, "run", "new", 0, false, "current");
        append(&mut state, "other", "new", 0, false, "stale");
        append(&mut state, "run", "old", 0, false, "stale");
        assert_eq!(state.segments[0].content, "current");
        state.apply(
            StreamUpdate::Append {
                run_id: "run".into(),
                stream_id: "new".into(),
                index: 0,
                reasoning: false,
                content: "inactive run".into(),
            },
            None,
        );
        assert_eq!(state.segments[0].content, "current");
        assert!(state.clear());
    }
    #[test]
    fn canonical_messages_consume_prefixes_without_dropping_later_messages() {
        let mut state = StreamPreview::default();
        append(&mut state, "run", "a", 0, false, "firstsecond");
        state.consume(false, "first");
        assert_eq!(state.segments[0].content, "second");
        state.consume(false, "second");
        assert!(state.segments.is_empty());
    }
}
