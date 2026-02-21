use unicode_width::UnicodeWidthChar;

pub fn char_width(ch: char) -> usize {
    UnicodeWidthChar::width(ch).unwrap_or(0).max(1)
}

fn text_width(text: &str) -> usize {
    text.chars().map(char_width).sum()
}

fn take_prefix_within_width(text: &str, width: usize) -> (String, usize) {
    let mut out = String::new();
    let mut used_width = 0usize;
    let mut consumed_chars = 0usize;

    for ch in text.chars() {
        let ch_width = char_width(ch);
        if used_width + ch_width > width && !out.is_empty() {
            break;
        }
        out.push(ch);
        used_width += ch_width;
        consumed_chars += 1;
    }

    (out, consumed_chars)
}

pub fn detect_continuation_prefix(line: &str) -> Option<String> {
    if line.is_empty() {
        return None;
    }

    let mut indent = String::new();
    let mut rest_start = 0usize;
    for (idx, ch) in line.char_indices() {
        if ch == ' ' {
            indent.push(ch);
            rest_start = idx + ch.len_utf8();
            continue;
        }
        rest_start = idx;
        break;
    }

    if rest_start >= line.len() {
        return (!indent.is_empty()).then_some(indent);
    }

    let rest = &line[rest_start..];

    let mut quote_prefix = String::new();
    let mut chars = rest.chars().peekable();
    while let Some(next) = chars.peek().copied() {
        if !matches!(next, '>' | '│') {
            break;
        }
        quote_prefix.push(next);
        chars.next();
        if chars.peek().copied() == Some(' ') {
            quote_prefix.push(' ');
            chars.next();
        }
    }
    if !quote_prefix.is_empty() {
        return Some(format!("{indent}{quote_prefix}"));
    }

    const TASK_LIST_PREFIXES: [&str; 6] =
        ["- [ ] ", "- [x] ", "- [X] ", "* [ ] ", "* [x] ", "* [X] "];
    if let Some(task_prefix) = TASK_LIST_PREFIXES
        .iter()
        .find(|prefix| rest.starts_with(**prefix))
    {
        let continuation = " ".repeat(text_width(task_prefix));
        return Some(format!("{indent}{continuation}"));
    }

    let mut rest_chars = rest.chars();
    if let (Some(marker), Some(space)) = (rest_chars.next(), rest_chars.next()) {
        if matches!(marker, '-' | '*' | '+') && space == ' ' {
            let continuation = " ".repeat(text_width(&format!("{marker}{space}")));
            return Some(format!("{indent}{continuation}"));
        }
    }

    let mut ordered_marker = String::new();
    let mut saw_digit = false;
    let mut ordered_chars = rest.chars().peekable();
    while let Some(ch) = ordered_chars.peek().copied() {
        if ch.is_ascii_digit() {
            ordered_marker.push(ch);
            ordered_chars.next();
            saw_digit = true;
            continue;
        }
        break;
    }
    if saw_digit {
        let punct = ordered_chars.next();
        let trailing_space = ordered_chars.next();
        if matches!(punct, Some('.') | Some(')')) && trailing_space == Some(' ') {
            ordered_marker.push(punct.unwrap_or('.'));
            ordered_marker.push(' ');
            let continuation = " ".repeat(text_width(&ordered_marker));
            return Some(format!("{indent}{continuation}"));
        }
    }

    (!indent.is_empty()).then_some(indent)
}

pub fn wrap_line(line: &str, width: usize) -> Vec<String> {
    if width == 0 {
        return Vec::new();
    }
    let mut lines = Vec::new();
    let mut current = String::new();
    let mut current_width = 0;
    for ch in line.chars() {
        let ch_width = char_width(ch);
        if current_width + ch_width > width && !current.is_empty() {
            lines.push(current);
            current = String::new();
            current_width = 0;
        }
        current.push(ch);
        current_width += ch_width;
    }
    lines.push(current);
    lines
}

pub fn wrap_line_with_continuation(
    line: &str,
    width: usize,
    continuation_prefix: &str,
) -> Vec<String> {
    if width == 0 {
        return Vec::new();
    }
    if line.is_empty() {
        return vec![String::new()];
    }

    let prefix_width = text_width(continuation_prefix);
    if continuation_prefix.is_empty() || prefix_width == 0 || width <= prefix_width {
        return wrap_line(line, width);
    }

    let mut out = Vec::new();
    let mut remaining = line.to_string();
    let mut first_line = true;

    while !remaining.is_empty() {
        let chunk_width = if first_line {
            width
        } else {
            width - prefix_width
        };
        let (chunk, consumed_chars) = take_prefix_within_width(&remaining, chunk_width);
        if chunk.is_empty() || consumed_chars == 0 {
            break;
        }

        if first_line {
            out.push(chunk);
            first_line = false;
        } else {
            out.push(format!("{continuation_prefix}{chunk}"));
        }

        remaining = remaining.chars().skip(consumed_chars).collect();
    }

    if out.is_empty() {
        return vec![line.to_string()];
    }
    out
}

pub fn sanitize_paste(value: &str) -> String {
    let mut out = String::new();
    let mut chars = value.chars().peekable();
    while let Some(ch) = chars.next() {
        match ch {
            // Preserve line breaks for both LF and CR(LF) sources.
            '\r' => {
                if chars.peek().copied() != Some('\n') {
                    out.push('\n');
                }
            }
            // Expand tabs so the terminal doesn't interpret them as cursor jumps.
            '\t' => out.push_str("    "),
            c if c.is_control() && c != '\n' => out.push(' '),
            _ => out.push(ch),
        }
    }
    out
}

pub fn sanitize_for_tui(value: &str) -> String {
    // Tool results and code blocks can include tabs, carriage returns, or ANSI escape sequences.
    // If we render those raw, the terminal can move the cursor and "draw into" the next line.
    let mut out = String::new();
    let mut col = 0_usize;
    let tab_width = 4_usize;
    let mut chars = value.chars().peekable();

    while let Some(ch) = chars.next() {
        match ch {
            // Strip common ANSI escape sequences (CSI/OSC).
            '\x1b' => {
                let Some(next) = chars.peek().copied() else {
                    continue;
                };

                if next == '[' {
                    // CSI: ESC [ ... final_byte
                    chars.next();
                    for seq in chars.by_ref() {
                        let code = seq as u32;
                        if (0x40..=0x7e).contains(&code) {
                            break;
                        }
                    }
                    continue;
                }

                if next == ']' {
                    // OSC: ESC ] ... BEL or ST (ESC \)
                    chars.next();
                    loop {
                        match chars.next() {
                            None => break,
                            Some('\x07') => break,
                            Some('\x1b') => {
                                if chars.peek().copied() == Some('\\') {
                                    chars.next();
                                    break;
                                }
                            }
                            _ => {}
                        }
                    }
                    continue;
                }

                // Fallback: skip one extra char (e.g. charset selection).
                let _ = chars.next();
                continue;
            }
            '\t' => {
                // Expand tabs to spaces so rendering can't jump the cursor.
                let next_stop = ((col / tab_width) + 1) * tab_width;
                let spaces = next_stop.saturating_sub(col).max(1);
                for _ in 0..spaces {
                    out.push(' ');
                }
                col += spaces;
            }
            '\r' => {
                // Drop CR to avoid cursor jump / line rewriting behaviour.
            }
            c if c.is_control() => {
                // Keep layout stable for other control characters.
                out.push(' ');
                col += 1;
            }
            c => {
                out.push(c);
                col += char_width(c);
            }
        }
    }

    out
}

#[cfg(test)]
mod tests {
    use super::{detect_continuation_prefix, sanitize_paste, wrap_line_with_continuation};

    #[test]
    fn detect_continuation_prefix_for_unordered_list() {
        assert_eq!(detect_continuation_prefix("- item"), Some("  ".to_string()));
        assert_eq!(
            detect_continuation_prefix("  * item"),
            Some("    ".to_string())
        );
    }

    #[test]
    fn detect_continuation_prefix_for_ordered_and_quote() {
        assert_eq!(
            detect_continuation_prefix("12. item"),
            Some("    ".to_string())
        );
        assert_eq!(
            detect_continuation_prefix("> quote"),
            Some("> ".to_string())
        );
        assert_eq!(
            detect_continuation_prefix("│ quote"),
            Some("│ ".to_string())
        );
    }

    #[test]
    fn detect_continuation_prefix_for_task_and_nested_task_list() {
        assert_eq!(
            detect_continuation_prefix("- [ ] task item"),
            Some("      ".to_string())
        );
        assert_eq!(
            detect_continuation_prefix("  * [x] nested task item"),
            Some("        ".to_string())
        );
    }

    #[test]
    fn wrap_line_with_continuation_applies_prefix_after_first_row() {
        let wrapped = wrap_line_with_continuation("- abcdefghij", 8, "  ");
        assert_eq!(wrapped, vec!["- abcdef", "  ghij"]);
    }

    #[test]
    fn wrap_line_with_continuation_handles_cjk_text() {
        let wrapped = wrap_line_with_continuation("- 日本語日本語日本語", 10, "  ");
        assert!(wrapped.len() >= 2);
        assert!(wrapped[1].starts_with("  "));
    }

    #[test]
    fn sanitize_paste_preserves_blank_lines() {
        let value = "line1\n\nline2\n\nline3";
        assert_eq!(sanitize_paste(value), value);
    }

    #[test]
    fn sanitize_paste_keeps_regular_multiline_structure() {
        let value = "line1\nline2\n\nline3";
        assert_eq!(sanitize_paste(value), value);
    }

    #[test]
    fn sanitize_paste_normalizes_controls_and_preserves_trailing_newline() {
        let value = "a\r\n\r\nb\tc\x07\r\n";
        assert_eq!(sanitize_paste(value), "a\n\nb    c \n");
    }

    #[test]
    fn sanitize_paste_preserves_cr_only_newlines() {
        let value = "line1\rline2\r\rline3";
        assert_eq!(sanitize_paste(value), "line1\nline2\n\nline3");
    }

    #[test]
    fn sanitize_paste_normalizes_crlf_newlines() {
        let value = "line1\r\nline2\r\n";
        assert_eq!(sanitize_paste(value), "line1\nline2\n");
    }
}
