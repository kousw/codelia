use serde_json::Value;

use super::common::{format_u64_with_commas, truncate_line};

const MAX_ARG_LENGTH: usize = 160;

fn json_string_array(value: Option<&Value>) -> Vec<String> {
    value
        .and_then(Value::as_array)
        .map(|entries| {
            entries
                .iter()
                .filter_map(Value::as_str)
                .map(str::trim)
                .filter(|entry| !entry.is_empty())
                .map(ToString::to_string)
                .collect()
        })
        .unwrap_or_default()
}

pub(super) fn web_search_queries_from_value(value: &Value) -> Vec<String> {
    let direct = json_string_array(value.get("queries"));
    if !direct.is_empty() {
        return direct;
    }
    value
        .get("action")
        .map(|action| json_string_array(action.get("queries")))
        .unwrap_or_default()
}

fn web_search_queries_from_text(raw: &str) -> Vec<String> {
    let Some(start) = raw.find("queries=") else {
        return Vec::new();
    };
    let mut queries_part = &raw[start + "queries=".len()..];
    for marker in [
        " | sources=",
        " | source_count=",
        " | status=",
        " | engine=",
    ] {
        if let Some(index) = queries_part.find(marker) {
            queries_part = &queries_part[..index];
            break;
        }
    }
    queries_part
        .split(" | ")
        .map(str::trim)
        .filter(|entry| !entry.is_empty())
        .map(ToString::to_string)
        .collect()
}

pub(super) fn web_search_summary_detail(queries: &[String]) -> String {
    if queries.is_empty() {
        return "Summary".to_string();
    }
    truncate_line(&queries.join(" | "), MAX_ARG_LENGTH)
}

pub(super) fn web_search_summary_from_result(raw: &str, is_error: bool) -> String {
    let queries = if let Ok(value) = serde_json::from_str::<Value>(raw) {
        web_search_queries_from_value(&value)
    } else {
        web_search_queries_from_text(raw)
    };
    if queries.is_empty() {
        return if is_error {
            "WebSearch: Failed".to_string()
        } else {
            "WebSearch: Summary".to_string()
        };
    }
    format!("WebSearch: {}", web_search_summary_detail(&queries))
}

fn compact_url_target(url: &str, max: usize) -> String {
    let trimmed = url.trim();
    if trimmed.is_empty() {
        return "(no url)".to_string();
    }
    let without_scheme = trimmed
        .split_once("://")
        .map(|(_, rest)| rest)
        .unwrap_or(trimmed);
    let without_fragment = without_scheme.split('#').next().unwrap_or(without_scheme);
    let without_query = without_fragment
        .split('?')
        .next()
        .unwrap_or(without_fragment);
    truncate_line(without_query, max)
}

fn format_byte_size(value: u64) -> String {
    const UNITS: [&str; 5] = ["B", "KB", "MB", "GB", "TB"];
    if value < 1024 {
        return format!("{} B", format_u64_with_commas(value));
    }

    let mut size = value as f64;
    let mut unit_index = 0usize;
    while size >= 1024.0 && unit_index < UNITS.len() - 1 {
        size /= 1024.0;
        unit_index += 1;
    }

    let formatted = if size >= 10.0 || (size.fract() - 0.0).abs() < f64::EPSILON {
        format!("{size:.0}")
    } else {
        format!("{size:.1}")
    };
    format!("{formatted} {}", UNITS[unit_index])
}

pub(super) fn webfetch_summary_detail(url: &str) -> String {
    compact_url_target(url, MAX_ARG_LENGTH)
}

pub(super) fn webfetch_summary_from_result(parsed: &Value) -> Option<String> {
    let target = parsed
        .get("final_url")
        .and_then(|value| value.as_str())
        .or_else(|| parsed.get("url").and_then(|value| value.as_str()))
        .map(|value| compact_url_target(value, 120))?;

    let mut parts = Vec::new();
    if let Some(byte_size) = parsed.get("byte_size").and_then(|value| value.as_u64()) {
        parts.push(format_byte_size(byte_size));
    }
    if let Some(duration_ms) = parsed.get("duration_ms").and_then(|value| {
        value
            .as_u64()
            .or_else(|| value.as_i64().and_then(|n| u64::try_from(n).ok()))
    }) {
        parts.push(format!("{duration_ms} ms"));
    }
    if parsed
        .get("truncated")
        .and_then(|value| value.as_bool())
        .unwrap_or(false)
    {
        parts.push("truncated".to_string());
    }

    let detail = if parts.is_empty() {
        target
    } else {
        format!("{target} ({})", parts.join(", "))
    };
    Some(format!("WebFetch: {detail}"))
}
