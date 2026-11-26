use super::{LogKind, LogLine};
use serde_json::Value;

/// Presentation only: never modify the canonical input sent to the model.
pub fn user_message_lines(text: &str, descriptions: &[String]) -> Vec<LogLine> {
    let mut lines = vec![LogLine::new(LogKind::User, " ")];
    for (index, line) in text.lines().enumerate() {
        let prefix = if index == 0 { "> " } else { "  " };
        lines.push(LogLine::new(LogKind::User, format!("{prefix}{line}")));
    }
    lines.extend(
        descriptions
            .iter()
            .map(|line| LogLine::new(LogKind::User, line.clone())),
    );
    lines.push(LogLine::new(LogKind::User, " "));
    lines
}

fn summarize_shell_prefix(text: &str) -> String {
    let mut remaining = text.trim();
    let mut summaries = Vec::new();
    while let Some(body) = remaining.strip_prefix("<shell_result>\n") {
        let Some((json, tail)) = body.split_once("\n</shell_result>") else {
            break;
        };
        let Ok(value) = serde_json::from_str::<Value>(json) else {
            break;
        };
        // Match the generated shell-result envelope, not arbitrary tagged prose.
        let (Some(_), Some(command), Some(_)) = (
            value.get("id").and_then(Value::as_str),
            value.get("command_preview").and_then(Value::as_str),
            value.get("duration_ms").and_then(Value::as_u64),
        ) else {
            break;
        };
        let command = command
            .chars()
            .take(120)
            .collect::<String>()
            .replace(['\n', '\r'], " ");
        summaries.push(format!("[Shell result: {command}]"));
        remaining = tail.trim_start();
    }
    if summaries.is_empty() {
        return text.to_string();
    }
    if !remaining.is_empty() {
        summaries.push(remaining.to_string());
    }
    summaries.join("\n")
}

/// History replay and non-local clients have no composer snapshot to render.
pub fn steer_message_lines(content: Option<&Value>) -> Vec<LogLine> {
    let text = match content {
        Some(Value::String(text)) => summarize_shell_prefix(text),
        Some(Value::Array(parts)) => parts
            .iter()
            .filter_map(|part| match part.get("type").and_then(Value::as_str) {
                Some("text") => part
                    .get("text")
                    .and_then(Value::as_str)
                    .map(summarize_shell_prefix),
                Some("image_url" | "image_ref") => Some("[image]".to_string()),
                Some("attachment_ref") => {
                    let reference = &part["attachment_ref"];
                    let name: String = reference["display_name"]
                        .as_str()
                        .unwrap_or("file")
                        .chars()
                        .filter(|ch| !ch.is_control())
                        .take(180)
                        .collect();
                    Some(format!("[File: {name}]"))
                }
                Some("document") => Some("[document]".to_string()),
                _ => None,
            })
            .collect::<Vec<_>>()
            .join("\n"),
        _ => String::new(),
    };
    user_message_lines(
        if text.trim().is_empty() {
            "(steer)"
        } else {
            text.trim()
        },
        &[],
    )
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn replay_summarizes_shell_output_without_changing_content() {
        let text = format!(
            "<shell_result>\n{}\n</shell_result>\n\ncheck this",
            json!({
                "id":"shell_1", "command_preview":"cargo test", "duration_ms":10,
                "stdout":"very long output\n".repeat(1000)
            })
        );
        let content = json!([{ "type":"text", "text":text }, {
            "type":"image_url", "image_url":{"url":"data:image/png;base64,AAAA"}
        }]);
        let lines = steer_message_lines(Some(&content));
        let displayed = lines
            .iter()
            .map(LogLine::plain_text)
            .collect::<Vec<_>>()
            .join("\n");
        assert!(displayed.contains("[Shell result: cargo test]"));
        assert!(displayed.contains("check this"));
        assert!(displayed.contains("[image]"));
        assert!(!displayed.contains("very long output"));
        assert!(!displayed.contains("base64"));
        assert_eq!(content[0]["text"], text);
    }

    #[test]
    fn ordinary_tagged_text_is_preserved() {
        let text = "<shell_result>\nexplain this tag\n</shell_result>";
        assert_eq!(summarize_shell_prefix(text), text);
    }
}
