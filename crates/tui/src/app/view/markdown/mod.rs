use crate::app::state::{LogKind, LogLine};

fn strip_markdown_inline(value: &str) -> String {
    // Minimal markdown cleanup: keep content but remove the most common formatting markers.
    let mut out = value.replace("**", "");
    out = out.replace("__", "");
    out = out.replace('`', "");
    out
}

pub fn render_markdown_lines(value: &str) -> Vec<LogLine> {
    let mut out = Vec::new();
    let mut in_code_block = false;

    for raw in value.split('\n') {
        let raw = raw.trim_end_matches('\r');
        let trimmed = raw.trim_start();
        if trimmed.starts_with("```") {
            in_code_block = !in_code_block;
            continue;
        }

        if in_code_block {
            out.push(LogLine::new(LogKind::AssistantCode, raw.to_string()));
            continue;
        }

        let mut line = raw.to_string();
        let left_trimmed = line.trim_start();
        if let Some(rest) = left_trimmed.strip_prefix("> ") {
            line = format!("│ {}", rest);
        } else if let Some(rest) = left_trimmed.strip_prefix("- ") {
            line = format!("• {}", rest);
        } else if let Some(rest) = left_trimmed.strip_prefix("* ") {
            line = format!("• {}", rest);
        } else if left_trimmed.starts_with('#') {
            let mut idx = 0;
            for ch in left_trimmed.chars() {
                if ch == '#' {
                    idx += 1;
                    continue;
                }
                break;
            }
            let rest = left_trimmed[idx..].trim_start();
            line = rest.to_string();
        }

        out.push(LogLine::new(
            LogKind::Assistant,
            strip_markdown_inline(&line),
        ));
    }

    if out.is_empty() {
        out.push(LogLine::new(LogKind::Assistant, String::new()));
    }
    out
}
