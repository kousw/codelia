use super::InputState;
use crate::app::state::PendingImageAttachment;
use crate::app::util::attachments::{StagedAttachment, IMPORT_ID_PREFIX};
use serde_json::{json, Value};
use std::collections::{HashMap, HashSet};

const TOKEN_PREFIX: &str = "[[codelia-img:";
const TOKEN_SUFFIX: &str = "]]";

#[derive(Clone)]
struct TokenMatch {
    start: usize,
    end: usize,
    attachment_id: String,
}

fn chars_match_literal(chars: &[char], start: usize, literal: &str) -> bool {
    let mut idx = start;
    for ch in literal.chars() {
        if chars.get(idx).copied() != Some(ch) {
            return false;
        }
        idx += 1;
    }
    true
}

fn is_valid_attachment_id(value: &str) -> bool {
    !value.is_empty()
        && value
            .chars()
            .all(|ch| ch.is_ascii_alphanumeric() || ch == '-' || ch == '_')
}

fn parse_token_matches(chars: &[char], nonce: &str) -> Vec<TokenMatch> {
    let prefix_len = TOKEN_PREFIX.chars().count();
    let suffix_len = TOKEN_SUFFIX.chars().count();
    let mut matches = Vec::new();
    let mut idx = 0;

    while idx < chars.len() {
        if !chars_match_literal(chars, idx, TOKEN_PREFIX) {
            idx += 1;
            continue;
        }

        let body_start = idx + prefix_len;
        let mut suffix_at = None;
        let mut probe = body_start;
        while probe + suffix_len <= chars.len() && probe - body_start <= 96 {
            if chars_match_literal(chars, probe, TOKEN_SUFFIX) {
                suffix_at = Some(probe);
                break;
            }
            probe += 1;
        }
        let Some(body_end) = suffix_at else {
            idx += 1;
            continue;
        };

        let body: String = chars[body_start..body_end].iter().collect();
        if let Some((token_nonce, attachment_id)) = body.split_once(':') {
            if token_nonce == nonce && is_valid_attachment_id(attachment_id) {
                let token_end = body_end + suffix_len;
                matches.push(TokenMatch {
                    start: idx,
                    end: token_end,
                    attachment_id: attachment_id.to_string(),
                });
                idx = token_end;
                continue;
            }
        }

        idx += 1;
    }

    matches
}

pub fn make_attachment_token(nonce: &str, attachment_id: &str) -> String {
    format!("{TOKEN_PREFIX}{nonce}:{attachment_id}{TOKEN_SUFFIX}")
}

pub(crate) fn token_span_at(
    input: &InputState,
    nonce: &str,
    cursor: usize,
    include_start: bool,
    include_end: bool,
) -> Option<std::ops::Range<usize>> {
    parse_token_matches(&input.buffer, nonce)
        .into_iter()
        .find(|token| {
            (cursor > token.start || include_start && cursor == token.start)
                && (cursor < token.end || include_end && cursor == token.end)
        })
        .map(|token| token.start..token.end)
}

pub(crate) fn token_span(
    input: &InputState,
    nonce: &str,
    id: &str,
) -> Option<std::ops::Range<usize>> {
    parse_token_matches(&input.buffer, nonce)
        .into_iter()
        .find(|token| token.attachment_id == id)
        .map(|token| token.start..token.end)
}

pub(crate) fn token_spans(
    input: &InputState,
    nonce: &str,
) -> Vec<(String, std::ops::Range<usize>)> {
    parse_token_matches(&input.buffer, nonce)
        .into_iter()
        .map(|token| (token.attachment_id, token.start..token.end))
        .collect()
}

pub fn referenced_attachment_ids(
    input: &str,
    nonce: &str,
    attachments: &HashMap<String, PendingImageAttachment>,
    staged: &HashMap<String, StagedAttachment>,
) -> Vec<String> {
    let chars = input.chars().collect::<Vec<_>>();
    let mut seen = HashSet::new();
    parse_token_matches(&chars, nonce)
        .into_iter()
        .filter_map(|token| {
            if !attachments.contains_key(&token.attachment_id)
                && !staged.contains_key(&token.attachment_id)
            {
                return None;
            }
            if seen.contains(&token.attachment_id) {
                return None;
            }
            seen.insert(token.attachment_id.clone());
            Some(token.attachment_id)
        })
        .collect()
}

pub fn build_run_input_payload(
    input: &str,
    nonce: &str,
    attachments: &HashMap<String, PendingImageAttachment>,
    staged: &HashMap<String, StagedAttachment>,
) -> Value {
    let chars = input.chars().collect::<Vec<_>>();
    let token_matches = parse_token_matches(&chars, nonce);
    let mut parts: Vec<Value> = Vec::new();
    let mut current_text = String::new();
    let mut src_index = 0;
    let mut used = HashSet::new();

    for token in token_matches {
        if token.start > src_index {
            current_text.extend(chars[src_index..token.start].iter());
        }

        let part = if staged.contains_key(&token.attachment_id) {
            Some(json!({ "type": "staged_attachment", "local_id": token.attachment_id }))
        } else {
            attachments.get(&token.attachment_id).map(|image| {
                json!({
                    "type": "image_url",
                    "image_url": {
                        "url": image.data_url,
                        "media_type": "image/png",
                        "detail": "auto"
                    }
                })
            })
        };
        if let Some(part) = part.filter(|_| used.insert(token.attachment_id)) {
            if !current_text.is_empty() {
                parts.push(json!({ "type": "text", "text": current_text }));
                current_text = String::new();
            }
            parts.push(part);
        } else {
            current_text.extend(chars[token.start..token.end].iter());
        }

        src_index = token.end;
    }

    if src_index < chars.len() {
        current_text.extend(chars[src_index..].iter());
    }

    if parts.is_empty() {
        return json!({ "type": "text", "text": current_text });
    }

    if !current_text.is_empty() {
        parts.push(json!({ "type": "text", "text": current_text }));
    }

    json!({ "type": "parts", "parts": parts })
}

pub fn render_input_with_attachment_labels(
    input: &InputState,
    nonce: &str,
    attachments: &HashMap<String, PendingImageAttachment>,
    staged: &HashMap<String, StagedAttachment>,
) -> InputState {
    let chars = &input.buffer;
    let token_matches = parse_token_matches(chars, nonce);
    if token_matches.is_empty() {
        let mut clone = InputState::default();
        clone.buffer = input.buffer.clone();
        clone.cursor = input.cursor.min(clone.buffer.len());
        return clone;
    }

    let mut output = String::new();
    let mut cursor_display = 0usize;
    let mut cursor_mapped = false;
    let cursor_src = input.cursor.min(chars.len());
    let mut src_index = 0usize;
    let mut label_by_id: HashMap<String, usize> = HashMap::new();
    let mut next_label = 1usize;

    for token in token_matches {
        if token.start > src_index {
            if !cursor_mapped {
                if cursor_src <= token.start {
                    cursor_display += cursor_src.saturating_sub(src_index);
                    cursor_mapped = true;
                } else {
                    cursor_display += token.start.saturating_sub(src_index);
                }
            }
            output.extend(chars[src_index..token.start].iter());
        }

        let label = if let Some(attachment) = staged.get(&token.attachment_id) {
            Some(attachment_label(attachment))
        } else if token.attachment_id.starts_with(IMPORT_ID_PREFIX) {
            Some("[Loading clipboard…]".to_owned())
        } else if attachments.contains_key(&token.attachment_id) {
            let label_index = if let Some(existing) = label_by_id.get(&token.attachment_id) {
                *existing
            } else {
                let assigned = next_label;
                label_by_id.insert(token.attachment_id.clone(), assigned);
                next_label = next_label.saturating_add(1);
                assigned
            };
            Some(format!("[Image {label_index}]"))
        } else {
            None
        };
        if let Some(label) = label {
            let label_len = label.chars().count();
            output.push_str(&label);

            if !cursor_mapped {
                if cursor_src <= token.start {
                    cursor_mapped = true;
                } else if cursor_src < token.end {
                    cursor_display += label_len;
                    cursor_mapped = true;
                } else {
                    cursor_display += label_len;
                }
            }
        } else {
            if !cursor_mapped {
                if cursor_src <= token.start {
                    cursor_mapped = true;
                } else if cursor_src < token.end {
                    cursor_display += cursor_src.saturating_sub(token.start);
                    cursor_mapped = true;
                } else {
                    cursor_display += token.end.saturating_sub(token.start);
                }
            }
            output.extend(chars[token.start..token.end].iter());
        }

        src_index = token.end;
    }

    if src_index < chars.len() {
        if !cursor_mapped {
            cursor_display += cursor_src.saturating_sub(src_index);
            cursor_mapped = true;
        }
        output.extend(chars[src_index..].iter());
    }

    if !cursor_mapped {
        cursor_display = output.chars().count();
    }

    let mut display = InputState::default();
    display.set_from(&output);
    display.cursor = cursor_display.min(display.buffer.len());
    display
}

pub fn render_input_text_with_attachment_labels(
    input: &str,
    nonce: &str,
    attachments: &HashMap<String, PendingImageAttachment>,
    staged: &HashMap<String, StagedAttachment>,
) -> String {
    let mut state = InputState::default();
    state.set_from(input);
    render_input_with_attachment_labels(&state, nonce, attachments, staged).current()
}

fn attachment_label(attachment: &StagedAttachment) -> String {
    let name = &attachment.display_name;
    if attachment.dimensions.is_some() {
        format!("[Image {name}]")
    } else {
        let media_type = &attachment.media_type;
        let size = attachment.bytes.len();
        format!("[File {name} · {media_type} · {size} B]")
    }
}

#[cfg(test)]
mod tests {
    use super::{
        build_run_input_payload, make_attachment_token, render_input_with_attachment_labels,
    };
    use crate::app::state::InputState;
    use crate::app::state::PendingImageAttachment;
    use serde_json::json;
    use std::collections::HashMap;

    fn sample_image() -> PendingImageAttachment {
        PendingImageAttachment {
            data_url: "data:image/png;base64,AAAA".to_string(),
            width: 10,
            height: 10,
            encoded_bytes: 32,
        }
    }

    #[test]
    fn payload_keeps_text_image_text_order() {
        let nonce = "abc";
        let token = make_attachment_token(nonce, "img1");
        let input = format!("before {token} after");
        let mut attachments = HashMap::new();
        attachments.insert("img1".to_string(), sample_image());

        let payload = build_run_input_payload(&input, nonce, &attachments, &HashMap::new());
        assert_eq!(
            payload,
            json!({
                "type": "parts",
                "parts": [
                    { "type": "text", "text": "before " },
                    {
                        "type": "image_url",
                        "image_url": {
                            "url": "data:image/png;base64,AAAA",
                            "media_type": "image/png",
                            "detail": "auto"
                        }
                    },
                    { "type": "text", "text": " after" }
                ]
            })
        );
    }

    #[test]
    fn payload_only_uses_first_duplicate_token_occurrence() {
        let nonce = "abc";
        let token = make_attachment_token(nonce, "img1");
        let input = format!("{token} + {token}");
        let mut attachments = HashMap::new();
        attachments.insert("img1".to_string(), sample_image());

        let payload = build_run_input_payload(&input, nonce, &attachments, &HashMap::new());
        assert_eq!(
            payload,
            json!({
                "type": "parts",
                "parts": [
                    {
                        "type": "image_url",
                        "image_url": {
                            "url": "data:image/png;base64,AAAA",
                            "media_type": "image/png",
                            "detail": "auto"
                        }
                    },
                    { "type": "text", "text": " + [[codelia-img:abc:img1]]" }
                ]
            })
        );
    }

    #[test]
    fn renderer_shows_image_labels() {
        let nonce = "abc";
        let token = make_attachment_token(nonce, "img1");
        let mut input = InputState::default();
        input.set_from(&format!("hello {token}"));
        input.cursor = input.buffer.len();
        let mut attachments = HashMap::new();
        attachments.insert("img1".to_string(), sample_image());

        let rendered =
            render_input_with_attachment_labels(&input, nonce, &attachments, &HashMap::new());
        assert_eq!(rendered.current(), "hello [Image 1]");
    }
}
