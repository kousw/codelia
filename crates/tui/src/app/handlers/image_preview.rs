use crate::app::{image_preview::Source, state::LogKind, AppState};
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
    let source = app
        .referenced_attachment_ids()
        .into_iter()
        .rev()
        .find_map(|id| {
            if let Some(file) = app.pending_staged_attachments.get(&id) {
                return file.dimensions.map(|_| Source::Staged(file.clone()));
            }
            let image = app.pending_image_attachments.get(&id)?;
            Some(Source::Attachment {
                id,
                data_url: image.data_url.as_str().into(),
            })
        });
    if let Some(source) = source {
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
