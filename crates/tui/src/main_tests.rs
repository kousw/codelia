use crate::app::runtime::RpcResponse;
use crate::app::{AppState, PendingPromptRun, PROMPT_DISPATCH_MAX_ATTEMPTS};
use crate::entry::cli::{
    cli_flag_enabled_from_args, parse_approval_mode_from_args, parse_basic_cli_mode_from_args,
    parse_initial_message_from_args, parse_resume_mode_from_args, parse_sandbox_mode_arg_from_args,
    resolve_version_label_from_versions, BasicCliMode, ResumeMode,
};
use crate::event_loop::runtime::{
    apply_lane_list_result, can_auto_start_initial_message, handle_run_start_response,
    push_bang_stream_preview, truncate_bang_preview_line,
};
use serde_json::json;
use std::time::Instant;

#[test]
fn parse_resume_mode_accepts_picker_and_value() {
    assert_eq!(
        parse_resume_mode_from_args(["--resume"]),
        ResumeMode::Picker
    );
    assert_eq!(
        parse_resume_mode_from_args(["--resume", "abc"]),
        ResumeMode::Id("abc".to_string())
    );
    assert_eq!(
        parse_resume_mode_from_args(["--resume=xyz"]),
        ResumeMode::Id("xyz".to_string())
    );
}

#[test]
fn parse_basic_cli_mode_supports_help_and_version() {
    assert_eq!(
        parse_basic_cli_mode_from_args(["--help"]),
        BasicCliMode::Help
    );
    assert_eq!(parse_basic_cli_mode_from_args(["-h"]), BasicCliMode::Help);
    assert_eq!(
        parse_basic_cli_mode_from_args(["--version"]),
        BasicCliMode::Version
    );
    assert_eq!(
        parse_basic_cli_mode_from_args(["-V"]),
        BasicCliMode::Version
    );
    assert_eq!(
        parse_basic_cli_mode_from_args(["--resume", "abc"]),
        BasicCliMode::Run
    );
}

#[test]
fn cli_flag_enabled_supports_bool_and_equals_forms() {
    assert!(cli_flag_enabled_from_args("--debug", ["--debug"]));
    assert!(cli_flag_enabled_from_args("--debug", ["--debug=true"]));
    assert!(cli_flag_enabled_from_args("--debug", ["--debug=1"]));
    assert!(!cli_flag_enabled_from_args("--debug", ["--debug=false"]));
    assert!(!cli_flag_enabled_from_args("--debug", ["--debug=0"]));
    assert!(!cli_flag_enabled_from_args("--debug", ["--debug=maybe"]));
}

#[test]
fn parse_initial_message_accepts_short_and_long_forms() {
    assert_eq!(
        parse_initial_message_from_args(["--initial-message=hello"]),
        Some("hello".to_string())
    );
    assert_eq!(
        parse_initial_message_from_args(["--initial-message", "hello world"]),
        Some("hello world".to_string())
    );
    assert_eq!(
        parse_initial_message_from_args(["--initial-user-message", "hello"]),
        Some("hello".to_string())
    );
}

#[test]
fn parse_initial_message_ignores_empty() {
    assert_eq!(
        parse_initial_message_from_args(["--initial-message="]),
        None
    );
    assert_eq!(
        parse_initial_message_from_args(["--initial-message", "   "]),
        None
    );
}

#[test]
fn parse_approval_mode_supports_split_and_equals_forms() {
    assert_eq!(
        parse_approval_mode_from_args(["--approval-mode", "trusted"]),
        Ok(Some("trusted".to_string()))
    );
    assert_eq!(
        parse_approval_mode_from_args(["--approval-mode=full-access"]),
        Ok(Some("full-access".to_string()))
    );
    assert_eq!(parse_approval_mode_from_args(["--debug"]), Ok(None));
}

#[test]
fn parse_approval_mode_rejects_missing_values() {
    assert!(parse_approval_mode_from_args(["--approval-mode"]).is_err());
    assert!(parse_approval_mode_from_args(["--approval-mode="]).is_err());
}

#[test]
fn version_label_uses_cli_version_without_tui_suffix() {
    assert_eq!(
        resolve_version_label_from_versions(Some("0.1.12"), "0.1.0"),
        "codelia 0.1.12"
    );
    assert_eq!(
        resolve_version_label_from_versions(Some(" 0.2.0 "), "0.1.0"),
        "codelia 0.2.0"
    );
}

#[test]
fn version_label_falls_back_without_tui_version_when_cli_is_missing() {
    assert_eq!(
        resolve_version_label_from_versions(None, "0.1.0"),
        "codelia"
    );
    assert_eq!(
        resolve_version_label_from_versions(Some("   "), "0.1.0"),
        "codelia"
    );
}

#[test]
fn truncate_bang_preview_line_appends_marker_when_long() {
    let input = "x".repeat(300);
    let out = truncate_bang_preview_line(&input);
    assert!(out.ends_with("...[truncated]"));
    assert!(out.len() < input.len());
}

#[test]
fn push_bang_stream_preview_emits_runtime_lines_and_truncation_hint() {
    let mut app = AppState::default();
    push_bang_stream_preview(
        &mut app,
        "stdout",
        Some("line1\nline2"),
        true,
        Some("cache-ref-1"),
    );

    let lines = app
        .log
        .iter()
        .map(|line| line.plain_text())
        .collect::<Vec<_>>();
    assert!(lines.iter().any(|line| line.contains("bang stdout:")));
    assert!(lines.iter().any(|line| line.contains("line1")));
    assert!(lines
        .iter()
        .any(|line| line.contains("tool_output_cache ref `cache-ref-1`")));
}

#[test]
fn can_auto_start_initial_message_waits_for_prompt_queue_to_drain() {
    let mut app = AppState::default();
    assert!(can_auto_start_initial_message(&app));

    app.pending_prompt_queue.push_back(PendingPromptRun {
        seq: 1,
        queue_id: "q1".to_string(),
        queued_at: Instant::now(),
        preview: "hello".to_string(),
        user_text: "hello".to_string(),
        display_text: "hello".to_string(),
        image_descriptions: Vec::new(),
        input_payload: json!({"type": "text", "text": "hello"}),
        attachment_count: 0,
        files: Default::default(),
        shell_result_count: 0,
        dispatch_attempts: 0,
    });
    assert!(!can_auto_start_initial_message(&app));

    app.pending_prompt_queue.clear();
    app.dispatching_prompt = Some(PendingPromptRun {
        seq: 2,
        queue_id: "q2".to_string(),
        queued_at: Instant::now(),
        preview: "world".to_string(),
        user_text: "world".to_string(),
        display_text: "world".to_string(),
        image_descriptions: Vec::new(),
        input_payload: json!({"type": "text", "text": "world"}),
        attachment_count: 0,
        files: Default::default(),
        shell_result_count: 0,
        dispatch_attempts: 0,
    });
    assert!(!can_auto_start_initial_message(&app));
}

#[test]
fn run_start_error_requeues_dispatching_prompt() {
    let mut app = AppState::default();
    app.dispatching_prompt = Some(PendingPromptRun {
        seq: 1,
        queue_id: "q9".to_string(),
        queued_at: Instant::now(),
        preview: "queued".to_string(),
        user_text: "queued".to_string(),
        display_text: "queued".to_string(),
        image_descriptions: Vec::new(),
        input_payload: json!({"type": "text", "text": "queued"}),
        attachment_count: 0,
        files: Default::default(),
        shell_result_count: 0,
        dispatch_attempts: 0,
    });
    app.update_run_status("starting".to_string());

    handle_run_start_response(
        &mut app,
        RpcResponse {
            id: "id-1".to_string(),
            result: None,
            error: Some(json!({"code": -32001, "message": "runtime busy"})),
        },
    );

    assert!(app.dispatching_prompt.is_none());
    assert_eq!(app.pending_prompt_queue.len(), 1);
    assert_eq!(
        app.pending_prompt_queue
            .front()
            .map(|item| item.queue_id.as_str()),
        Some("q9")
    );
    assert_eq!(
        app.pending_prompt_queue
            .front()
            .map(|item| item.dispatch_attempts),
        Some(1)
    );
}

#[test]
fn run_start_error_pauses_prompt_after_max_attempts() {
    let mut app = AppState::default();
    app.dispatching_prompt = Some(PendingPromptRun {
        seq: 1,
        queue_id: "q10".to_string(),
        queued_at: Instant::now(),
        preview: "queued".to_string(),
        user_text: "queued".to_string(),
        display_text: "queued".to_string(),
        image_descriptions: Vec::new(),
        input_payload: json!({"type": "text", "text": "queued"}),
        attachment_count: 0,
        files: Default::default(),
        shell_result_count: 0,
        dispatch_attempts: PROMPT_DISPATCH_MAX_ATTEMPTS - 1,
    });

    handle_run_start_response(
        &mut app,
        RpcResponse {
            id: "id-2".to_string(),
            result: None,
            error: Some(json!({"code": -32001, "message": "runtime busy"})),
        },
    );

    assert!(app.dispatching_prompt.is_none());
    assert_eq!(app.pending_prompt_queue.len(), 1);
    assert_eq!(app.pending_prompt_queue[0].queue_id, "q10");
    assert!(app
        .log
        .iter()
        .any(|line| line.plain_text().contains("Paused queued prompt q10")));
}

#[test]
fn apply_lane_list_result_adds_new_lane_row() {
    let mut app = AppState::default();
    let payload = json!({
        "lanes": [
            {
                "lane_id": "lane-a",
                "task_id": "task-a",
                "state": "running",
                "mux_backend": "tmux"
            }
        ]
    });

    apply_lane_list_result(&mut app, &payload);

    let panel = app.lane_list_panel.expect("lane panel present");
    assert_eq!(panel.rows.len(), 2);
    assert_eq!(panel.rows[1], "+ New lane");
}

#[test]
fn sandbox_mode_flag_takes_precedence_over_legacy_mode() {
    assert_eq!(
        parse_sandbox_mode_arg_from_args(["--approval-mode=trusted", "--sandbox-mode", "readonly"]),
        Ok(Some(("--sandbox-mode", "readonly".into()))),
    );
    assert_eq!(
        parse_sandbox_mode_arg_from_args(["--approval-mode", "trusted"]),
        Ok(Some(("--approval-mode", "trusted".into()))),
    );
    assert_eq!(
        parse_sandbox_mode_arg_from_args(["--initial-message", "--sandbox-mode=full-access"]),
        Ok(None),
    );
}

mod layer_boundary_guard {
    use std::fs;
    use std::path::{Path, PathBuf};

    #[derive(Debug, PartialEq, Eq)]
    enum TokenKind {
        Ident(String),
        ColonColon,
        LBrace,
        RBrace,
        LBracket,
        RBracket,
        LParen,
        RParen,
        Semi,
        Comma,
        Hash,
        Other,
    }

    #[derive(Debug)]
    struct Token {
        kind: TokenKind,
        line: usize,
    }

    fn tokenize(source: &str) -> Vec<Token> {
        let bytes = source.as_bytes();
        let mut i = 0usize;
        let mut line = 1usize;
        let mut tokens = Vec::new();

        while i < bytes.len() {
            let b = bytes[i];
            if b == b'\n' {
                line += 1;
                i += 1;
                continue;
            }
            if b.is_ascii_whitespace() {
                i += 1;
                continue;
            }
            // Line comment
            if b == b'/' && bytes.get(i + 1) == Some(&b'/') {
                i += 2;
                while i < bytes.len() && bytes[i] != b'\n' {
                    i += 1;
                }
                continue;
            }
            // Nested block comment
            if b == b'/' && bytes.get(i + 1) == Some(&b'*') {
                i += 2;
                let mut depth = 1usize;
                while i < bytes.len() && depth > 0 {
                    if bytes[i] == b'\n' {
                        line += 1;
                        i += 1;
                    } else if bytes[i] == b'/' && bytes.get(i + 1) == Some(&b'*') {
                        depth += 1;
                        i += 2;
                    } else if bytes[i] == b'*' && bytes.get(i + 1) == Some(&b'/') {
                        depth -= 1;
                        i += 2;
                    } else {
                        i += 1;
                    }
                }
                continue;
            }
            // Raw string literal: r"...", r#"..."#, br"...", br#"..."#
            if (b == b'r' || (b == b'b' && bytes.get(i + 1) == Some(&b'r')))
                && (i == 0 || !bytes[i - 1].is_ascii_alphanumeric() && bytes[i - 1] != b'_')
            {
                let mut probe = if b == b'b' { i + 2 } else { i + 1 };
                let mut hashes = 0usize;
                while bytes.get(probe) == Some(&b'#') {
                    hashes += 1;
                    probe += 1;
                }
                if bytes.get(probe) == Some(&b'"') {
                    i = probe + 1;
                    while i < bytes.len() {
                        if bytes[i] == b'\n' {
                            line += 1;
                            i += 1;
                        } else if bytes[i] == b'"'
                            && bytes[i + 1..].len() >= hashes
                            && bytes[i + 1..i + 1 + hashes].iter().all(|c| *c == b'#')
                        {
                            i += 1 + hashes;
                            break;
                        } else {
                            i += 1;
                        }
                    }
                    tokens.push(Token {
                        kind: TokenKind::Other,
                        line,
                    });
                    continue;
                }
            }
            // Byte string literal: b"..."
            if b == b'b' && bytes.get(i + 1) == Some(&b'"') {
                i += 2;
                while i < bytes.len() {
                    if bytes[i] == b'\\' {
                        i += 2;
                    } else if bytes[i] == b'\n' {
                        line += 1;
                        i += 1;
                    } else if bytes[i] == b'"' {
                        i += 1;
                        break;
                    } else {
                        i += 1;
                    }
                }
                tokens.push(Token {
                    kind: TokenKind::Other,
                    line,
                });
                continue;
            }
            // Normal string literal
            if b == b'"' {
                i += 1;
                while i < bytes.len() {
                    if bytes[i] == b'\\' {
                        i += 2;
                    } else if bytes[i] == b'\n' {
                        line += 1;
                        i += 1;
                    } else if bytes[i] == b'"' {
                        i += 1;
                        break;
                    } else {
                        i += 1;
                    }
                }
                tokens.push(Token {
                    kind: TokenKind::Other,
                    line,
                });
                continue;
            }
            // Char / byte-char literal (skip without consuming lifetimes like `'a`)
            if b == b'\'' || (b == b'b' && bytes.get(i + 1) == Some(&b'\'')) {
                let start = if b == b'b' { i + 1 } else { i };
                let after = if bytes.get(start + 1) == Some(&b'\\') {
                    // Escape sequence inside char literal: scan up to closing '\'' on same line
                    let mut p = start + 2;
                    while p < bytes.len() && bytes[p] != b'\'' && bytes[p] != b'\n' {
                        p += 1;
                    }
                    (bytes.get(p) == Some(&b'\'')).then_some(p + 1)
                } else {
                    // Single Unicode scalar followed immediately by '\''
                    source[start + 1..].chars().next().and_then(|ch| {
                        let end = start + 1 + ch.len_utf8();
                        (bytes.get(end) == Some(&b'\'')).then_some(end + 1)
                    })
                };
                if let Some(next_i) = after {
                    i = next_i;
                    tokens.push(Token {
                        kind: TokenKind::Other,
                        line,
                    });
                    continue;
                }
            }
            if b == b':' && bytes.get(i + 1) == Some(&b':') {
                tokens.push(Token {
                    kind: TokenKind::ColonColon,
                    line,
                });
                i += 2;
                continue;
            }
            if b.is_ascii_alphabetic() || b == b'_' {
                let start = i;
                i += 1;
                while i < bytes.len() && (bytes[i].is_ascii_alphanumeric() || bytes[i] == b'_') {
                    i += 1;
                }
                tokens.push(Token {
                    kind: TokenKind::Ident(source[start..i].to_owned()),
                    line,
                });
                continue;
            }
            let kind = match b {
                b'{' => TokenKind::LBrace,
                b'}' => TokenKind::RBrace,
                b'[' => TokenKind::LBracket,
                b']' => TokenKind::RBracket,
                b'(' => TokenKind::LParen,
                b')' => TokenKind::RParen,
                b';' => TokenKind::Semi,
                b',' => TokenKind::Comma,
                b'#' => TokenKind::Hash,
                _ => TokenKind::Other,
            };
            tokens.push(Token { kind, line });
            i += 1;
        }
        tokens
    }

    fn skip_balanced(tokens: &[Token], mut idx: usize, open: TokenKind, close: TokenKind) -> usize {
        if tokens.get(idx).map(|t| &t.kind) != Some(&open) {
            return idx;
        }
        let mut depth = 0usize;
        while idx < tokens.len() {
            if tokens[idx].kind == open {
                depth += 1;
            } else if tokens[idx].kind == close {
                depth -= 1;
                if depth == 0 {
                    return idx + 1;
                }
            }
            idx += 1;
        }
        idx
    }

    fn is_test_only_cfg_attr(attr_tokens: &[Token]) -> bool {
        // Expect `[cfg(test)]` or `[cfg(all(..., test, ...))]`.
        if attr_tokens.len() < 5 {
            return false;
        }
        if !matches!(&attr_tokens[0].kind, TokenKind::LBracket)
            || !matches!(&attr_tokens[1].kind, TokenKind::Ident(s) if s == "cfg")
            || !matches!(&attr_tokens[2].kind, TokenKind::LParen)
        {
            return false;
        }
        let inner = &attr_tokens[3..attr_tokens.len().saturating_sub(2)];
        if inner.len() == 1 && matches!(&inner[0].kind, TokenKind::Ident(s) if s == "test") {
            return true;
        }
        if inner.len() >= 4
            && matches!(&inner[0].kind, TokenKind::Ident(s) if s == "all")
            && matches!(&inner[1].kind, TokenKind::LParen)
        {
            let mut depth = 0usize;
            for tok in &inner[2..inner.len() - 1] {
                match &tok.kind {
                    TokenKind::LParen => depth += 1,
                    TokenKind::RParen => depth = depth.saturating_sub(1),
                    TokenKind::Ident(s) if depth == 0 && s == "test" => return true,
                    _ => {}
                }
            }
        }
        false
    }

    fn skip_item(tokens: &[Token], mut idx: usize) -> usize {
        // Skip stacked outer attributes on the same item.
        while tokens.get(idx).map(|t| &t.kind) == Some(&TokenKind::Hash)
            && tokens.get(idx + 1).map(|t| &t.kind) == Some(&TokenKind::LBracket)
        {
            idx = skip_balanced(tokens, idx + 1, TokenKind::LBracket, TokenKind::RBracket);
        }
        while idx < tokens.len() {
            match tokens[idx].kind {
                TokenKind::Semi => return idx + 1,
                TokenKind::LBrace => {
                    return skip_balanced(tokens, idx, TokenKind::LBrace, TokenKind::RBrace);
                }
                _ => idx += 1,
            }
        }
        idx
    }

    fn expand_use_tree(
        tokens: &[Token],
        mut idx: usize,
        prefix: &[String],
        out: &mut Vec<(usize, Vec<String>)>,
    ) -> usize {
        let mut current = prefix.to_vec();
        let start_line = tokens.get(idx).map_or(1, |t| t.line);
        while idx < tokens.len() {
            match &tokens[idx].kind {
                TokenKind::Ident(ident) => {
                    if ident == "as" {
                        // Skip alias target (`as Foo` or `as _`).
                        idx += 2;
                        break;
                    }
                    if ident != "self" {
                        current.push(ident.clone());
                    }
                    idx += 1;
                    if tokens.get(idx).map(|t| &t.kind) == Some(&TokenKind::ColonColon) {
                        idx += 1;
                    } else {
                        break;
                    }
                }
                TokenKind::ColonColon => {
                    idx += 1;
                }
                TokenKind::LBrace => {
                    idx += 1;
                    while idx < tokens.len()
                        && tokens[idx].kind != TokenKind::RBrace
                        && tokens[idx].kind != TokenKind::Semi
                    {
                        let before = idx;
                        idx = expand_use_tree(tokens, idx, &current, out);
                        if tokens.get(idx).map(|t| &t.kind) == Some(&TokenKind::Comma) {
                            idx += 1;
                        } else if idx == before {
                            // Consume glob (`*`) or any unexpected token inside braces so parsing always makes progress.
                            idx += 1;
                        }
                    }
                    if tokens.get(idx).map(|t| &t.kind) == Some(&TokenKind::RBrace) {
                        idx += 1;
                    }
                    return idx;
                }
                _ => break,
            }
        }
        if !current.is_empty() {
            out.push((start_line, current));
        }
        idx
    }

    fn normalize_path(module_path: &[String], raw: &[String]) -> Option<Vec<String>> {
        match raw.first().map(String::as_str) {
            Some("crate") => Some(raw.to_vec()),
            Some("super") => {
                let mut supers = 0usize;
                while raw.get(supers).map(String::as_str) == Some("super") {
                    supers += 1;
                }
                if supers > module_path.len() {
                    return None;
                }
                let mut resolved = vec!["crate".to_owned()];
                resolved.extend_from_slice(&module_path[..module_path.len() - supers]);
                resolved.extend_from_slice(&raw[supers..]);
                Some(resolved)
            }
            _ => None,
        }
    }

    fn module_path_for(relative: &Path) -> Vec<String> {
        let mut parts: Vec<String> = relative
            .components()
            .map(|c| c.as_os_str().to_string_lossy().into_owned())
            .collect();
        if let Some(last) = parts.last_mut() {
            if let Some(stem) = last.strip_suffix(".rs") {
                *last = stem.to_owned();
            }
        }
        if matches!(
            parts.last().map(String::as_str),
            Some("mod" | "main" | "lib")
        ) {
            parts.pop();
        }
        parts
    }

    fn extract_production_paths(relative: &Path, source: &str) -> Vec<(usize, Vec<String>)> {
        let tokens = tokenize(source);
        let module_path = module_path_for(relative);
        let mut raw_paths = Vec::new();
        let mut idx = 0usize;

        while idx < tokens.len() {
            // Skip `#[cfg(test)]` and `#[cfg(all(..., test, ...))]` items.
            if tokens[idx].kind == TokenKind::Hash
                && tokens.get(idx + 1).map(|t| &t.kind) == Some(&TokenKind::LBracket)
            {
                let end = skip_balanced(&tokens, idx + 1, TokenKind::LBracket, TokenKind::RBracket);
                if is_test_only_cfg_attr(&tokens[idx + 1..end]) {
                    idx = skip_item(&tokens, end);
                    continue;
                }
                idx = end;
                continue;
            }
            if matches!(&tokens[idx].kind, TokenKind::Ident(s) if s == "use") {
                idx += 1;
                idx = expand_use_tree(&tokens, idx, &[], &mut raw_paths);
                if tokens.get(idx).map(|t| &t.kind) == Some(&TokenKind::Semi) {
                    idx += 1;
                }
                continue;
            }
            if matches!(&tokens[idx].kind, TokenKind::Ident(s) if s == "crate" || s == "super")
                && tokens.get(idx + 1).map(|t| &t.kind) == Some(&TokenKind::ColonColon)
            {
                let line = tokens[idx].line;
                let mut chain = Vec::new();
                while let Some(TokenKind::Ident(seg)) = tokens.get(idx).map(|t| &t.kind) {
                    chain.push(seg.clone());
                    idx += 1;
                    if tokens.get(idx).map(|t| &t.kind) == Some(&TokenKind::ColonColon) {
                        idx += 1;
                    } else {
                        break;
                    }
                }
                raw_paths.push((line, chain));
                continue;
            }
            idx += 1;
        }

        raw_paths
            .into_iter()
            .filter_map(|(line, raw)| normalize_path(&module_path, &raw).map(|p| (line, p)))
            .collect()
    }

    fn path_starts_with(path: &[String], prefix: &[&str]) -> bool {
        path.len() >= prefix.len()
            && path
                .iter()
                .zip(prefix.iter())
                .all(|(seg, expected)| seg == expected)
    }

    pub(super) fn check_file(relative: &Path, source: &str) -> Vec<String> {
        let paths = extract_production_paths(relative, source);
        let mut violations = Vec::new();
        let mut record = |line: usize, path: &[String], reason: &str| {
            violations.push(format!(
                "{}:{line} references {} ({reason})",
                relative.display(),
                path.join("::")
            ));
        };

        for (line, path) in &paths {
            if relative.starts_with("app/util") {
                if path_starts_with(path, &["crate", "app"])
                    && !path_starts_with(path, &["crate", "app", "util"])
                {
                    record(*line, path, "app/util may only reference crate::app::util");
                }
            }
            if relative.starts_with("app/state") {
                for forbidden in [
                    &["crate", "app", "view"][..],
                    &["crate", "app", "render"][..],
                    &["crate", "app", "handlers"][..],
                    &["crate", "app", "frame"][..],
                ] {
                    if path_starts_with(path, forbidden) {
                        record(*line, path, "app/state layer violation");
                    }
                }
            }
            if relative.starts_with("app/app_state") {
                for forbidden in [
                    &["crate", "app", "handlers"][..],
                    &["crate", "app", "view"][..],
                    &["crate", "app", "render"][..],
                    &["crate", "app", "frame"][..],
                ] {
                    if path_starts_with(path, forbidden) {
                        record(*line, path, "app/app_state layer violation");
                    }
                }
            }
            if relative.starts_with("app/render") {
                for forbidden in [
                    &["crate", "app", "view"][..],
                    &["crate", "app", "handlers"][..],
                    &["crate", "app", "frame"][..],
                ] {
                    if path_starts_with(path, forbidden) {
                        record(*line, path, "app/render layer violation");
                    }
                }
            }
            if relative.starts_with("app/view") {
                for forbidden in [
                    &["crate", "app", "handlers"][..],
                    &["crate", "app", "render"][..],
                    &["crate", "app", "frame"][..],
                ] {
                    if path_starts_with(path, forbidden) {
                        record(*line, path, "app/view layer violation");
                    }
                }
            }
            if relative.starts_with("app/runtime") {
                for forbidden in [
                    &["crate", "app", "view"][..],
                    &["crate", "app", "handlers"][..],
                    &["crate", "app", "goal"][..],
                    &["crate", "app", "frame"][..],
                ] {
                    if path_starts_with(path, forbidden) {
                        record(*line, path, "app/runtime layer violation");
                    }
                }
            }
            if relative.starts_with("app") {
                for forbidden in [&["crate", "entry"][..], &["crate", "event_loop"][..]] {
                    if path_starts_with(path, forbidden) {
                        record(*line, path, "app must not depend on entry/event_loop");
                    }
                }
            }
            if relative.starts_with("event_loop") && path_starts_with(path, &["crate", "entry"]) {
                record(*line, path, "event_loop must not depend on entry");
            }
        }
        violations
    }

    pub(super) fn rust_sources(dir: &Path, files: &mut Vec<PathBuf>) {
        for entry in fs::read_dir(dir).unwrap() {
            let entry = entry.unwrap();
            let path = entry.path();
            if entry.file_type().unwrap().is_dir() {
                rust_sources(&path, files);
            } else if path.extension().is_some_and(|ext| ext == "rs") {
                let name = entry.file_name();
                let name = name.to_string_lossy();
                if name != "tests.rs" && name != "test_support.rs" && !name.ends_with("_tests.rs") {
                    files.push(path);
                }
            }
        }
    }
}

#[test]
fn tui_production_dependencies_follow_layer_boundaries() {
    use std::fs;
    use std::path::Path;

    let root = Path::new(env!("CARGO_MANIFEST_DIR")).join("src");
    let mut files = Vec::new();
    layer_boundary_guard::rust_sources(&root, &mut files);
    files.sort_unstable();

    let mut violations = Vec::new();
    for file in files {
        let relative = file.strip_prefix(&root).unwrap();
        let source = fs::read_to_string(&file).unwrap();
        violations.extend(layer_boundary_guard::check_file(relative, &source));
    }
    assert!(violations.is_empty(), "{}", violations.join("\n"));
}

#[test]
fn layer_boundary_guard_catches_grouped_relative_and_root_imports() {
    use std::path::Path;

    // Grouped import in util
    let v = layer_boundary_guard::check_file(
        Path::new("app/util/foo.rs"),
        "use crate::app::{state::InputState, frame::draw_frame};\n",
    );
    assert_eq!(v.len(), 2, "{v:?}");

    // Relative super:: escape from util/sub.rs to app/state
    let v = layer_boundary_guard::check_file(
        Path::new("app/util/sub/mod.rs"),
        "use super::super::state::LogKind;\n",
    );
    assert_eq!(v.len(), 1, "{v:?}");

    // App-root re-export referenced from util
    let v = layer_boundary_guard::check_file(
        Path::new("app/util/bar.rs"),
        "use crate::app::ModelListMode;\n",
    );
    assert_eq!(v.len(), 1, "{v:?}");

    // String literals and URLs inside mid-file #[cfg(test)] must not cause false positives or drift
    let v = layer_boundary_guard::check_file(
        Path::new("app/util/clean.rs"),
        r#"
#[cfg(test)]
mod tests {
    use crate::app::handlers::command;
    const URL: &str = "https://example.com/{not_a_brace}";
}
const MSG: &str = "crate::app::state";
use crate::app::util::image::validate_dimensions;
"#,
    );
    assert!(v.is_empty(), "{v:?}");

    // Production violation after mid-file #[cfg(test)] with URL string must still be caught
    let v = layer_boundary_guard::check_file(
        Path::new("app/util/leak.rs"),
        r#"
#[cfg(test)]
mod tests {
    const URL: &str = "https://example.com/{}";
}
use crate::app::frame::draw_frame;
"#,
    );
    assert_eq!(v.len(), 1, "{v:?}");
}
