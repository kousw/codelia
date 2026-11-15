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
    Start {
        run_id: String,
        stream_id: String,
    },
    Delta {
        run_id: String,
        stream_id: String,
        reasoning: bool,
        content: String,
    },
}

#[derive(Debug, Default)]
pub(crate) struct StreamPreview {
    identity: Option<(String, String)>,
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
    pub(crate) fn starts_adjacent_block(&mut self, reasoning: bool, index: u64) -> bool {
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

    pub(crate) fn apply(&mut self, update: StreamUpdate, active_run: Option<&str>) -> bool {
        match update {
            StreamUpdate::Start { run_id, stream_id } if active_run == Some(run_id.as_str()) => {
                let changed = self.clear();
                self.identity = Some((run_id, stream_id));
                changed
            }
            StreamUpdate::Delta {
                run_id,
                stream_id,
                reasoning,
                content,
            } if active_run == Some(run_id.as_str()) && self.matches(&run_id, &stream_id) => {
                if content.is_empty() {
                    return false;
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
            _ => false,
        }
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
    fn start(state: &mut StreamPreview, stream: &str) {
        state.apply(
            StreamUpdate::Start {
                run_id: "run".into(),
                stream_id: stream.into(),
            },
            Some("run"),
        );
    }
    fn delta(state: &mut StreamPreview, run: &str, stream: &str, reasoning: bool, content: &str) {
        state.apply(
            StreamUpdate::Delta {
                run_id: run.into(),
                stream_id: stream.into(),
                reasoning,
                content: content.into(),
            },
            Some("run"),
        );
    }
    #[test]
    fn retains_full_reasoning_and_text_until_their_canonical_handoffs() {
        let mut state = StreamPreview::default();
        start(&mut state, "a");
        let thought = "日本語🙂\n".repeat(10000);
        delta(&mut state, "run", "a", true, &thought);
        delta(&mut state, "run", "a", false, "こん");
        delta(&mut state, "run", "a", false, "にちは");
        assert_eq!(state.segments[0].content, thought);
        assert_eq!(state.segments[1].content, "こんにちは");
        assert!(state.consume(true, &thought));
        assert_eq!(state.segments[0].content, "こんにちは");
        assert!(state.consume(false, "こんにちは"));
        assert!(state.segments.is_empty());
    }
    #[test]
    fn stale_run_attempt_and_inactive_run_cannot_change_current_output() {
        let mut state = StreamPreview::default();
        start(&mut state, "old");
        delta(&mut state, "run", "old", false, "discarded");
        start(&mut state, "new");
        delta(&mut state, "run", "new", false, "current");
        delta(&mut state, "other", "new", false, "stale");
        delta(&mut state, "run", "old", false, "stale");
        assert_eq!(state.segments[0].content, "current");
        state.apply(
            StreamUpdate::Delta {
                run_id: "run".into(),
                stream_id: "new".into(),
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
        start(&mut state, "a");
        delta(&mut state, "run", "a", false, "firstsecond");
        state.consume(false, "first");
        assert_eq!(state.segments[0].content, "second");
        state.consume(false, "second");
        assert!(state.segments.is_empty());
    }
}
