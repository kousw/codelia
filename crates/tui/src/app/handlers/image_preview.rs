use crate::app::{
    image_preview::Source, state::LogKind, util::attachments::referenced_attachment_ids, AppState,
};
use std::path::PathBuf;

pub(crate) fn handle_command(app: &mut AppState, arguments: &str) {
    if arguments.trim().is_empty() {
        if !app.image_preview.reopen() {
            app.push_line(LogKind::Status, "usage: /image <local-path> (quotes allowed); Alt+I previews the last composer image");
        }
        return;
    }
    let path = match parse_path(arguments) {
        Ok(path) => path,
        Err(message) => {
            app.push_line(LogKind::Error, message);
            return;
        }
    };
    app.clear_text_selection();
    app.image_preview.open(Source::File(path));
}

fn parse_path(arguments: &str) -> Result<PathBuf, &'static str> {
    let parts = shell_words::split(arguments)
        .map_err(|_| "Invalid path quoting; usage: /image <local-path>")?;
    if parts.len() != 1 || parts[0].is_empty() {
        return Err("usage: /image <local-path> (quote paths containing spaces)");
    }
    let path = &parts[0];
    if path.contains("://") || path.starts_with("data:") {
        return Err("/image opens TUI-local files only, not URLs or runtime/SSH paths");
    }
    if let Some(rest) = path.strip_prefix("~/") {
        let home = std::env::var_os("HOME")
            .or_else(|| std::env::var_os("USERPROFILE"))
            .ok_or("Cannot resolve home directory; use an absolute local path")?;
        return Ok(PathBuf::from(home).join(rest));
    }
    Ok(PathBuf::from(path))
}

pub(crate) fn preview_composer_image(app: &mut AppState) {
    let ids = referenced_attachment_ids(
        &app.input.current(),
        &app.composer_nonce,
        &app.pending_image_attachments,
    );
    let source = ids.last().and_then(|id| {
        app.pending_image_attachments
            .get(id)
            .map(|attachment| (id, attachment))
    });
    if let Some((id, attachment)) = source {
        if attachment.data_url.len() > 12 * 1024 * 1024 {
            app.push_line(
                LogKind::Error,
                "Image attachment exceeds preview size limit",
            );
            return;
        }
        let source = Source::Attachment {
            id: id.clone(),
            data_url: attachment.data_url.as_str().into(),
        };
        app.clear_text_selection();
        app.image_preview.open(source);
    } else if !app.image_preview.reopen() {
        app.push_line(
            LogKind::Status,
            "No composer image to preview. Paste an image first, or use /image <local-path>.",
        );
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn local_paths_are_explicit_and_never_downloaded_or_executed() {
        assert_eq!(parse_path("'a b.png'").unwrap(), PathBuf::from("a b.png"));
        assert_eq!(
            parse_path("'$(touch nope).png'").unwrap(),
            PathBuf::from("$(touch nope).png")
        );
        for invalid in [
            "a b",
            "'unfinished",
            "https://example.test/a.png",
            "ssh://host/a.png",
            "data:image/png;base64,AAAA",
            "''",
        ] {
            assert!(parse_path(invalid).is_err(), "{invalid}");
        }
    }
}
