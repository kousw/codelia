use crate::app::state::{LogColor, LogKind, LogLine, LogSpan, LogTone};
use std::sync::OnceLock;
use syntect::easy::HighlightLines;
use syntect::highlighting::{Theme, ThemeSet};
use syntect::parsing::SyntaxSet;

struct HighlightAssets {
    syntax_set: SyntaxSet,
    theme: Theme,
}

static HIGHLIGHT_ASSETS: OnceLock<Option<HighlightAssets>> = OnceLock::new();

fn highlight_assets() -> Option<&'static HighlightAssets> {
    HIGHLIGHT_ASSETS
        .get_or_init(|| {
            let syntax_set = SyntaxSet::load_defaults_newlines();
            let theme_set = ThemeSet::load_defaults();
            let theme = theme_set
                .themes
                .get("base16-eighties.dark")
                .cloned()
                .or_else(|| theme_set.themes.values().next().cloned())?;
            Some(HighlightAssets { syntax_set, theme })
        })
        .as_ref()
}

fn strip_markdown_inline(value: &str) -> String {
    // Minimal markdown cleanup: keep content but remove the most common formatting markers.
    let mut out = value.replace("**", "");
    out = out.replace("__", "");
    out = out.replace('`', "");
    out
}

fn parse_fence_language(trimmed: &str) -> Option<String> {
    let rest = trimmed.strip_prefix("```")?.trim();
    if rest.is_empty() {
        return None;
    }
    rest.split_whitespace().next().map(str::to_string)
}

pub(crate) fn highlight_code_line(
    language: Option<&str>,
    line: &str,
    kind: LogKind,
    tone: LogTone,
) -> Option<Vec<LogSpan>> {
    let assets = highlight_assets()?;
    let syntax = syntax_for_language(&assets.syntax_set, language);
    let mut highlighter = HighlightLines::new(syntax, &assets.theme);
    let ranges = highlighter.highlight_line(line, &assets.syntax_set).ok()?;

    if ranges.is_empty() {
        return Some(vec![LogSpan::new(kind, tone, line)]);
    }

    Some(
        ranges
            .into_iter()
            .map(|(style, text)| {
                LogSpan::new_with_fg(
                    kind,
                    tone,
                    text,
                    Some(LogColor::rgb(
                        style.foreground.r,
                        style.foreground.g,
                        style.foreground.b,
                    )),
                )
            })
            .collect(),
    )
}

fn syntax_for_language<'a>(
    syntax_set: &'a SyntaxSet,
    language: Option<&str>,
) -> &'a syntect::parsing::SyntaxReference {
    let Some(token) = language.map(str::trim).filter(|value| !value.is_empty()) else {
        return syntax_set.find_syntax_plain_text();
    };

    let lower = token.to_ascii_lowercase();
    let aliases: &[&str] = match lower.as_str() {
        // Some syntect bundles do not include a dedicated TypeScript syntax.
        // In that case, JavaScript syntax is the closest available parser.
        "ts" => &["ts", "typescript", "js", "javascript"],
        "typescript" => &["typescript", "ts", "js", "javascript"],
        "js" => &["js", "javascript"],
        "rs" => &["rs", "rust"],
        "sh" => &["sh", "bash", "shell"],
        "yml" => &["yml", "yaml"],
        _ => &[&lower],
    };

    for candidate in aliases {
        if let Some(syntax) = syntax_set.find_syntax_by_token(candidate) {
            return syntax;
        }
    }

    for candidate in aliases {
        if let Some(syntax) = syntax_set.find_syntax_by_extension(candidate) {
            return syntax;
        }
    }

    for candidate in aliases {
        if let Some(syntax) = syntax_set.syntaxes().iter().find(|syntax| {
            syntax.name.eq_ignore_ascii_case(candidate)
                || syntax
                    .file_extensions
                    .iter()
                    .any(|ext| ext.eq_ignore_ascii_case(candidate))
        }) {
            return syntax;
        }
    }

    syntax_set.find_syntax_plain_text()
}

fn render_plain_code_lines(lines: &[String]) -> Vec<LogLine> {
    lines
        .iter()
        .map(|line| LogLine::new(LogKind::AssistantCode, line.clone()))
        .collect()
}

fn render_highlighted_code_lines(lines: &[String], language: Option<&str>) -> Option<Vec<LogLine>> {
    let assets = highlight_assets()?;
    let syntax = syntax_for_language(&assets.syntax_set, language);
    let mut highlighter = HighlightLines::new(syntax, &assets.theme);

    let mut rendered = Vec::with_capacity(lines.len());
    for line in lines {
        if line.is_empty() {
            rendered.push(LogLine::new(LogKind::AssistantCode, ""));
            continue;
        }

        let ranges = match highlighter.highlight_line(line, &assets.syntax_set) {
            Ok(ranges) => ranges,
            Err(_) => return None,
        };
        if ranges.is_empty() {
            rendered.push(LogLine::new(LogKind::AssistantCode, line.clone()));
            continue;
        }

        let spans = ranges
            .into_iter()
            .map(|(style, text)| {
                LogSpan::new_with_fg(
                    LogKind::AssistantCode,
                    LogTone::Summary,
                    text,
                    Some(LogColor::rgb(
                        style.foreground.r,
                        style.foreground.g,
                        style.foreground.b,
                    )),
                )
            })
            .collect::<Vec<_>>();
        rendered.push(LogLine::new_with_spans(spans));
    }

    Some(rendered)
}

fn render_code_block_lines(lines: &[String], language: Option<&str>) -> Vec<LogLine> {
    render_highlighted_code_lines(lines, language).unwrap_or_else(|| render_plain_code_lines(lines))
}

pub fn render_markdown_lines(value: &str) -> Vec<LogLine> {
    let mut out = Vec::new();
    let mut in_code_block = false;
    let mut code_block_language: Option<String> = None;
    let mut code_block_lines: Vec<String> = Vec::new();

    for raw in value.split('\n') {
        let raw = raw.trim_end_matches('\r');
        let trimmed = raw.trim_start();
        if trimmed.starts_with("```") {
            if in_code_block {
                let mut code_lines =
                    render_code_block_lines(&code_block_lines, code_block_language.as_deref());
                out.append(&mut code_lines);
                code_block_lines.clear();
                code_block_language = None;
                in_code_block = false;
            } else {
                in_code_block = true;
                code_block_language = parse_fence_language(trimmed);
            }
            continue;
        }

        if in_code_block {
            code_block_lines.push(raw.to_string());
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

    if in_code_block {
        let mut code_lines =
            render_code_block_lines(&code_block_lines, code_block_language.as_deref());
        out.append(&mut code_lines);
    }

    if out.is_empty() {
        out.push(LogLine::new(LogKind::Assistant, String::new()));
    }
    out
}

#[cfg(test)]
mod tests {
    use super::{
        highlight_assets, highlight_code_line, render_markdown_lines, syntax_for_language,
    };
    use crate::app::state::{LogColor, LogKind};

    #[test]
    fn fenced_code_block_uses_assistant_code_lines() {
        let lines = render_markdown_lines("```\nlet x = 1;\n```");
        assert_eq!(lines.len(), 1);
        assert_eq!(lines[0].kind(), LogKind::AssistantCode);
    }

    #[test]
    fn fenced_code_block_with_known_language_adds_token_foreground_colors() {
        let lines = render_markdown_lines("```rust\nfn main() {}\n```");
        assert_eq!(lines.len(), 1);
        assert_eq!(lines[0].kind(), LogKind::AssistantCode);
        assert!(lines[0].spans().iter().any(|span| span.fg.is_some()));
    }

    #[test]
    fn highlight_code_line_supports_ts_alias() {
        let spans = highlight_code_line(
            Some("ts"),
            "const value = 42;",
            LogKind::AssistantCode,
            crate::app::state::LogTone::Detail,
        )
        .expect("highlight spans");

        assert!(spans.iter().any(|span| span.fg.is_some()));
    }

    #[test]
    fn ts_token_resolves_non_plain_syntax() {
        let assets = highlight_assets().expect("highlight assets");
        let syntax = syntax_for_language(&assets.syntax_set, Some("ts"));
        assert_ne!(syntax.name, "Plain Text");
    }

    #[test]
    fn highlight_code_line_ts_emits_multiple_distinct_foregrounds() {
        let spans = highlight_code_line(
            Some("ts"),
            "export type Entry = { key: string; enabled: boolean; };",
            LogKind::AssistantCode,
            crate::app::state::LogTone::Detail,
        )
        .expect("highlight spans");

        let mut colors: Vec<LogColor> = Vec::new();
        for span in spans {
            let Some(color) = span.fg else {
                continue;
            };
            if colors.iter().all(|existing| existing != &color) {
                colors.push(color);
            }
        }
        assert!(colors.len() >= 2);
    }
}
