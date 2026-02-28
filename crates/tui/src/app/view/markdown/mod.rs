mod language_aliases;

use crate::app::state::{LogColor, LogKind, LogLine, LogSpan, LogTone};
use std::sync::OnceLock;
use syntect::easy::HighlightLines;
use syntect::highlighting::{Theme, ThemeSet};
use syntect::parsing::SyntaxSet;

use super::theme::{inline_palette, syntect_theme_name, InlinePalette};
use language_aliases::language_aliases;

struct HighlightAssets {
    syntax_set: SyntaxSet,
    theme: Theme,
}

// NOTE: syntect highlight assets are intentionally initialized once per process.
// Theme changes applied at runtime update UI colors immediately, but syntect code
// highlighting stays on the initially loaded theme until TUI restart.
static HIGHLIGHT_ASSETS: OnceLock<Option<HighlightAssets>> = OnceLock::new();

fn highlight_assets() -> Option<&'static HighlightAssets> {
    HIGHLIGHT_ASSETS
        .get_or_init(|| {
            let syntax_set = SyntaxSet::load_defaults_newlines();
            let theme_set = ThemeSet::load_defaults();
            let theme = theme_set
                .themes
                .get(syntect_theme_name())
                .cloned()
                .or_else(|| theme_set.themes.get("Solarized (dark)").cloned())
                .or_else(|| theme_set.themes.values().next().cloned())?;
            Some(HighlightAssets { syntax_set, theme })
        })
        .as_ref()
}

fn push_assistant_span(spans: &mut Vec<LogSpan>, text: &str, fg: Option<LogColor>) {
    if text.is_empty() {
        return;
    }
    spans.push(LogSpan::new_with_fg(
        LogKind::Assistant,
        LogTone::Summary,
        text,
        fg,
    ));
}

fn parse_inline_markdown_spans(value: &str) -> Vec<LogSpan> {
    fn parse_with_palette(value: &str, palette: &InlinePalette) -> Vec<LogSpan> {
        let mut spans = Vec::new();
        let mut cursor = 0usize;

        while cursor < value.len() {
            let rest = &value[cursor..];

            if let Some(after_tick) = rest.strip_prefix('`') {
                if let Some(close_rel) = after_tick.find('`') {
                    push_assistant_span(&mut spans, &value[..cursor], None);
                    let code_start = cursor + 1;
                    let code_end = code_start + close_rel;
                    push_assistant_span(
                        &mut spans,
                        &value[code_start..code_end],
                        Some(palette.inline_code),
                    );
                    let next = code_end + 1;
                    let consumed = &value[next..];
                    return [spans, parse_with_palette(consumed, palette)].concat();
                }
            }

            if let Some(after_bold) = rest.strip_prefix("**") {
                if let Some(close_rel) = after_bold.find("**") {
                    push_assistant_span(&mut spans, &value[..cursor], None);
                    let bold_start = cursor + 2;
                    let bold_end = bold_start + close_rel;
                    push_assistant_span(
                        &mut spans,
                        &value[bold_start..bold_end],
                        Some(palette.bold),
                    );
                    let next = bold_end + 2;
                    let consumed = &value[next..];
                    return [spans, parse_with_palette(consumed, palette)].concat();
                }
            }

            let next_char_len = rest.chars().next().map(char::len_utf8).unwrap_or(1);
            cursor += next_char_len;
        }

        push_assistant_span(&mut spans, value, None);
        spans
    }

    parse_with_palette(value, &inline_palette())
}

fn apply_heading_tint(mut spans: Vec<LogSpan>) -> Vec<LogSpan> {
    let palette = inline_palette();
    for span in &mut spans {
        if span.fg.is_none() {
            span.fg = Some(palette.heading);
        }
    }
    spans
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

fn is_plain_text_syntax(syntax: &syntect::parsing::SyntaxReference) -> bool {
    syntax.name.eq_ignore_ascii_case("Plain Text")
}

fn syntax_for_language<'a>(
    syntax_set: &'a SyntaxSet,
    language: Option<&str>,
) -> &'a syntect::parsing::SyntaxReference {
    let Some(token) = language.map(str::trim).filter(|value| !value.is_empty()) else {
        return syntax_set.find_syntax_plain_text();
    };

    let aliases = language_aliases(token);

    for candidate in &aliases {
        if let Some(syntax) = syntax_set.find_syntax_by_token(candidate) {
            if !is_plain_text_syntax(syntax) {
                return syntax;
            }
        }
    }

    for candidate in &aliases {
        if let Some(syntax) = syntax_set.find_syntax_by_extension(candidate) {
            if !is_plain_text_syntax(syntax) {
                return syntax;
            }
        }
    }

    for candidate in &aliases {
        if let Some(syntax) = syntax_set.syntaxes().iter().find(|syntax| {
            syntax.name.eq_ignore_ascii_case(candidate)
                || syntax
                    .file_extensions
                    .iter()
                    .any(|ext| ext.eq_ignore_ascii_case(candidate))
        }) {
            if !is_plain_text_syntax(syntax) {
                return syntax;
            }
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

        let line_with_newline = format!("{line}\n");
        let ranges = match highlighter.highlight_line(&line_with_newline, &assets.syntax_set) {
            Ok(ranges) => ranges,
            Err(_) => return None,
        };
        if ranges.is_empty() {
            rendered.push(LogLine::new(LogKind::AssistantCode, line.clone()));
            continue;
        }

        let spans = ranges
            .into_iter()
            .filter_map(|(style, text)| {
                let text = text.strip_suffix('\n').unwrap_or(text);
                if text.is_empty() {
                    return None;
                }
                Some(LogSpan::new_with_fg(
                    LogKind::AssistantCode,
                    LogTone::Summary,
                    text,
                    Some(LogColor::rgb(
                        style.foreground.r,
                        style.foreground.g,
                        style.foreground.b,
                    )),
                ))
            })
            .collect::<Vec<_>>();
        if spans.is_empty() {
            rendered.push(LogLine::new(LogKind::AssistantCode, line.clone()));
            continue;
        }
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
        let mut is_heading = false;
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
            is_heading = true;
        }

        let mut spans = parse_inline_markdown_spans(&line);
        if is_heading {
            spans = apply_heading_tint(spans);
        }
        out.push(LogLine::new_with_spans(spans));
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
        highlight_assets, highlight_code_line, inline_palette, render_markdown_lines,
        syntax_for_language,
    };
    use crate::app::state::{LogColor, LogKind};
    use crate::app::view::theme::inline_palette_for;

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
    fn highlight_code_line_supports_tsx_alias() {
        let spans = highlight_code_line(
            Some("tsx"),
            "const node = <div>{value}</div>;",
            LogKind::AssistantCode,
            crate::app::state::LogTone::Detail,
        )
        .expect("highlight spans");

        assert!(spans.iter().any(|span| span.fg.is_some()));
    }

    #[test]
    fn highlight_code_line_supports_bash_alias() {
        let spans = highlight_code_line(
            Some("bash"),
            "echo hello && pwd",
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
    fn typescript_prefers_non_plain_syntax_over_plain_text_token_match() {
        let assets = highlight_assets().expect("highlight assets");
        let syntax = syntax_for_language(&assets.syntax_set, Some("typescript"));
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

    #[test]
    fn highlight_code_line_typescript_emits_multiple_distinct_foregrounds() {
        let spans = highlight_code_line(
            Some("typescript"),
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

    #[test]
    fn render_markdown_lines_highlights_multiple_fenced_languages() {
        let lines = render_markdown_lines(
            "```typescript\nexport type Entry = { key: string; enabled: boolean; };\n```\n\n```tsx\nconst node = <div>{value}</div>;\n```",
        );
        let mut colors: Vec<LogColor> = Vec::new();
        for line in lines
            .iter()
            .filter(|line| line.kind() == LogKind::AssistantCode)
        {
            for span in line.spans() {
                let Some(color) = span.fg else {
                    continue;
                };
                if colors.iter().all(|existing| existing != &color) {
                    colors.push(color);
                }
            }
        }
        assert!(colors.len() >= 2);
    }

    #[test]
    fn inline_bold_marks_text_with_theme_color_and_strips_markers() {
        let lines = render_markdown_lines("hello **world**");
        assert_eq!(lines.len(), 1);
        let spans = lines[0].spans();
        assert_eq!(lines[0].plain_text(), "hello world");
        assert_eq!(spans.len(), 2);
        assert_eq!(spans[0].text, "hello ");
        assert_eq!(spans[0].fg, None);
        assert_eq!(spans[1].text, "world");
        assert_eq!(spans[1].fg, Some(inline_palette().bold));
    }

    #[test]
    fn inline_code_marks_text_with_theme_color_and_strips_markers() {
        let lines = render_markdown_lines("run `bun test`");
        assert_eq!(lines.len(), 1);
        let spans = lines[0].spans();
        assert_eq!(lines[0].plain_text(), "run bun test");
        assert_eq!(spans.len(), 2);
        assert_eq!(spans[0].text, "run ");
        assert_eq!(spans[0].fg, None);
        assert_eq!(spans[1].text, "bun test");
        assert_eq!(spans[1].fg, Some(inline_palette().inline_code));
    }

    #[test]
    fn heading_marks_plain_text_with_heading_theme_color() {
        let lines = render_markdown_lines("## release note");
        assert_eq!(lines.len(), 1);
        let spans = lines[0].spans();
        assert_eq!(lines[0].plain_text(), "release note");
        assert_eq!(spans.len(), 1);
        assert_eq!(spans[0].text, "release note");
        assert_eq!(spans[0].fg, Some(inline_palette().heading));
    }

    #[test]
    fn rose_palette_is_available() {
        let palette = inline_palette_for("rose");
        assert_eq!(palette.heading, LogColor::rgb(201, 112, 130));
        assert_eq!(palette.bold, LogColor::rgb(222, 161, 175));
        assert_eq!(palette.inline_code, LogColor::rgb(207, 188, 202));
    }

    #[test]
    fn sakura_palette_is_available() {
        let palette = inline_palette_for("sakura");
        assert_eq!(palette.heading, LogColor::rgb(232, 152, 176));
        assert_eq!(palette.bold, LogColor::rgb(244, 193, 210));
        assert_eq!(palette.inline_code, LogColor::rgb(232, 208, 220));
    }

    #[test]
    fn mauve_palette_is_available() {
        let palette = inline_palette_for("mauve");
        assert_eq!(palette.heading, LogColor::rgb(195, 144, 201));
        assert_eq!(palette.bold, LogColor::rgb(218, 182, 224));
        assert_eq!(palette.inline_code, LogColor::rgb(208, 193, 217));
    }

    #[test]
    fn plum_palette_is_available() {
        let palette = inline_palette_for("plum");
        assert_eq!(palette.heading, LogColor::rgb(165, 118, 173));
        assert_eq!(palette.bold, LogColor::rgb(191, 156, 199));
        assert_eq!(palette.inline_code, LogColor::rgb(186, 174, 197));
    }

    #[test]
    fn iris_palette_is_available() {
        let palette = inline_palette_for("iris");
        assert_eq!(palette.heading, LogColor::rgb(157, 140, 214));
        assert_eq!(palette.bold, LogColor::rgb(188, 176, 234));
        assert_eq!(palette.inline_code, LogColor::rgb(190, 186, 221));
    }

    #[test]
    fn crimson_palette_is_available() {
        let palette = inline_palette_for("crimson");
        assert_eq!(palette.heading, LogColor::rgb(200, 107, 123));
        assert_eq!(palette.bold, LogColor::rgb(217, 138, 154));
        assert_eq!(palette.inline_code, LogColor::rgb(193, 176, 205));
    }

    #[test]
    fn wine_palette_is_available() {
        let palette = inline_palette_for("wine");
        assert_eq!(palette.heading, LogColor::rgb(176, 122, 143));
        assert_eq!(palette.bold, LogColor::rgb(199, 154, 170));
        assert_eq!(palette.inline_code, LogColor::rgb(187, 178, 202));
    }
}
