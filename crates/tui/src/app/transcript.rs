use crate::app::markdown::{
    render_markdown_lines, render_markdown_single_line, IncrementalMarkdownState,
};
use crate::app::state::{LogKind, LogLine, LogSpan, LogTone};
use unicode_segmentation::UnicodeSegmentation;

pub(crate) fn decorate_assistant_line(line: LogLine) -> LogLine {
    let mut spans = vec![LogSpan::new(line.kind(), LogTone::Detail, "  ")];
    spans.extend(
        line.spans()
            .iter()
            .map(|span| span.with_tone(LogTone::Detail)),
    );
    LogLine::new_with_spans(spans)
}

pub(crate) fn render_single_body_line(raw: &str, reasoning: bool) -> LogLine {
    if reasoning {
        LogLine::new_with_tone(
            LogKind::Reasoning,
            LogTone::Detail,
            raw.trim_end_matches('\r'),
        )
    } else {
        decorate_assistant_line(render_markdown_single_line(raw.trim_end_matches('\r')))
    }
}

#[derive(Debug, Default)]
pub(crate) struct IncrementalReasoningState {
    committed_bytes: usize,
    committed_lines: Vec<LogLine>,
    committed_line_end_bytes: Vec<usize>,
}

impl IncrementalReasoningState {
    pub(crate) fn clear(&mut self) {
        self.committed_bytes = 0;
        self.committed_lines.clear();
        self.committed_line_end_bytes.clear();
    }

    pub(crate) fn committed_bytes(&self) -> usize {
        self.committed_bytes
    }

    pub(crate) fn committed_lines(&self) -> &[LogLine] {
        &self.committed_lines
    }

    pub(crate) fn committed_line_end_bytes(&self) -> &[usize] {
        &self.committed_line_end_bytes
    }

    pub(crate) fn advance(&mut self, trimmed: &str) -> (usize, Vec<LogLine>) {
        if trimmed.len() < self.committed_bytes || !trimmed.is_char_boundary(self.committed_bytes) {
            self.clear();
        }
        let prev_committed = self.committed_lines.len();
        while let Some(nl_rel) = trimmed[self.committed_bytes..].find('\n') {
            let raw_with_cr = &trimmed[self.committed_bytes..self.committed_bytes + nl_rel];
            let raw = raw_with_cr.trim_end_matches('\r');
            let line_end_byte = self.committed_bytes + raw.len();
            self.committed_lines.push(LogLine::new_with_tone(
                LogKind::Reasoning,
                LogTone::Detail,
                raw,
            ));
            self.committed_line_end_bytes.push(line_end_byte);
            self.committed_bytes += nl_rel + 1;
        }
        let tail = trimmed[self.committed_bytes..].trim_end_matches('\r');
        let tail_lines = vec![LogLine::new_with_tone(
            LogKind::Reasoning,
            LogTone::Detail,
            tail,
        )];
        (prev_committed, tail_lines)
    }
}

#[derive(Debug)]
pub(crate) enum IncrementalBodyCache {
    Markdown(IncrementalMarkdownState),
    Reasoning(IncrementalReasoningState),
}

impl IncrementalBodyCache {
    pub(crate) fn new(reasoning: bool) -> Self {
        if reasoning {
            Self::Reasoning(IncrementalReasoningState::default())
        } else {
            Self::Markdown(IncrementalMarkdownState::default())
        }
    }

    pub(crate) fn clear(&mut self) {
        match self {
            Self::Markdown(state) => state.clear(),
            Self::Reasoning(state) => state.clear(),
        }
    }

    pub(crate) fn committed_bytes(&self) -> usize {
        match self {
            Self::Markdown(state) => state.committed_bytes(),
            Self::Reasoning(state) => state.committed_bytes(),
        }
    }

    pub(crate) fn committed_lines(&self) -> &[LogLine] {
        match self {
            Self::Markdown(state) => state.committed_lines(),
            Self::Reasoning(state) => state.committed_lines(),
        }
    }

    pub(crate) fn committed_line_end_bytes(&self) -> &[usize] {
        match self {
            Self::Markdown(state) => state.committed_line_end_bytes(),
            Self::Reasoning(state) => state.committed_line_end_bytes(),
        }
    }

    pub(crate) fn in_code_block(&self) -> bool {
        match self {
            Self::Markdown(state) => state.in_code_block(),
            Self::Reasoning(_) => false,
        }
    }

    pub(crate) fn advance(&mut self, trimmed: &str) -> (usize, Vec<LogLine>) {
        match self {
            Self::Markdown(state) => state.advance(trimmed, decorate_assistant_line),
            Self::Reasoning(state) => state.advance(trimmed),
        }
    }
}

/// One presentation path for live output and canonical assistant events.
pub(crate) fn render_body(content: &str, reasoning: bool) -> Vec<LogLine> {
    if content.trim().is_empty() {
        return Vec::new();
    }
    // A trailing newline is an unfinished next line, not an extra paragraph.
    // Keeping it out also matches Core's trimmed final text at handoff.
    let content = content.trim_end_matches(['\n', '\r']);
    let mut lines = vec![LogLine::new(LogKind::Space, "")];
    if reasoning {
        lines.extend(content.split('\n').map(|line| {
            LogLine::new_with_tone(
                LogKind::Reasoning,
                LogTone::Detail,
                line.trim_end_matches('\r'),
            )
        }));
    } else {
        lines.extend(
            render_markdown_lines(content)
                .into_iter()
                .map(decorate_assistant_line),
        );
    }
    lines
}

/// End of text whose existing presentation cannot change as the current line grows.
/// Completed lines are stable. A plain paragraph may also commit complete graphemes,
/// stopping before an unmatched inline marker or an unfinished code line.
#[cfg(test)]
pub(crate) fn stable_body_prefix(content: &str, reasoning: bool, channel_closed: bool) -> &str {
    if channel_closed {
        return content;
    }
    let line_start = content.rfind('\n').map_or(0, |index| index + 1);
    if reasoning {
        return &content[..line_start
            + content[line_start..]
                .grapheme_indices(true)
                .last()
                .map_or(0, |(index, _)| index)];
    }
    let mut in_code = false;
    for line in content[..line_start].lines() {
        if line.trim_start().starts_with("```") {
            in_code = !in_code;
        }
    }
    stable_body_prefix_with_fence_state(content, reasoning, channel_closed, in_code)
}

/// O(tail) variant of [`stable_body_prefix`] when the caller already tracks
/// whether `content[..line_start]` leaves an open fenced code block.
pub(crate) fn stable_body_prefix_with_fence_state(
    content: &str,
    reasoning: bool,
    channel_closed: bool,
    in_code_before_tail: bool,
) -> &str {
    if channel_closed {
        return content;
    }
    let line_start = content.rfind('\n').map_or(0, |index| index + 1);
    if reasoning {
        return &content[..line_start
            + content[line_start..]
                .grapheme_indices(true)
                .last()
                .map_or(0, |(index, _)| index)];
    }
    let tail = &content[line_start..];
    if in_code_before_tail || tail.trim_start().starts_with("```") {
        return &content[..line_start];
    }
    let mut tick = None;
    let mut bold = None;
    let mut index = 0;
    while index < tail.len() {
        let rest = &tail[index..];
        if rest.starts_with('`') {
            tick = if tick.is_none() { Some(index) } else { None };
        } else if rest.starts_with("**") && tick.is_none() {
            bold = if bold.is_none() { Some(index) } else { None };
            index += 1;
        }
        index += tail[index..].chars().next().map_or(1, char::len_utf8);
    }
    let limit = [tick, bold]
        .into_iter()
        .flatten()
        .min()
        .unwrap_or(tail.len());
    // Retain the last grapheme: the next delta may extend a combining/ZWJ
    // sequence or turn a trailing single '*' into a Markdown delimiter.
    let end = tail[..limit]
        .grapheme_indices(true)
        .last()
        .map_or(line_start, |(index, _)| line_start + index);
    &content[..end]
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn stable_prefix_retains_unfinished_markers_and_code_but_not_whole_paragraphs() {
        assert_eq!(
            stable_body_prefix("hello **unfinished", false, false),
            "hello"
        );
        assert_eq!(
            stable_body_prefix("hello `unfinished", false, false),
            "hello"
        );
        assert_eq!(
            stable_body_prefix("```rust\nlet x = unfinished", false, false),
            "```rust\n"
        );
        assert_eq!(
            stable_body_prefix("日本語の長い段落", false, false),
            "日本語の長い段"
        );
        assert_eq!(
            stable_body_prefix("hello 👨\u{200d}👩\u{200d}👧", false, false),
            "hello "
        );
        assert_eq!(
            stable_body_prefix("hello **unfinished", false, true),
            "hello **unfinished"
        );
    }
}
