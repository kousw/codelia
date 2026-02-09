use unicode_width::UnicodeWidthChar;

pub fn char_width(ch: char) -> usize {
    UnicodeWidthChar::width(ch).unwrap_or(0).max(1)
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
    use super::sanitize_paste;

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
