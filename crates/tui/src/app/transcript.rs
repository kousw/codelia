use crate::app::markdown::render_markdown_lines;
use crate::app::state::{LogKind, LogLine, LogSpan, LogTone};
use unicode_segmentation::UnicodeSegmentation;

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
        lines.extend(render_markdown_lines(content).into_iter().map(|line| {
            let mut spans = vec![LogSpan::new(line.kind(), LogTone::Detail, "  ")];
            spans.extend(
                line.spans()
                    .iter()
                    .map(|span| span.with_tone(LogTone::Detail)),
            );
            LogLine::new_with_spans(spans)
        }));
    }
    lines
}

/// End of text whose existing presentation cannot change as the current line grows.
/// Completed lines are stable. A plain paragraph may also commit complete graphemes,
/// stopping before an unmatched inline marker or an unfinished code line.
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
    let tail = &content[line_start..];
    if in_code || tail.trim_start().starts_with("```") {
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
