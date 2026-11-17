use super::ClipboardImageError;
use std::io;
use std::os::unix::ffi::OsStringExt;
use std::path::PathBuf;

#[cfg(target_os = "linux")]
mod native;

#[cfg(target_os = "linux")]
pub(super) use native::read_file_list;

const URI_LIST: &str = "text/uri-list";
const GNOME_LIST: &str = "x-special/gnome-copied-files";
const MAX_URI_LIST_BYTES: usize = 256 * 1024;
const MAX_PATHS: usize = 8;

fn parse_file_list(bytes: &[u8], mime_type: &str) -> Result<Vec<PathBuf>, ClipboardImageError> {
    if bytes.len() > MAX_URI_LIST_BYTES {
        return Err(ClipboardImageError::Clipboard(
            "Clipboard file list is too large".into(),
        ));
    }
    let mut lines = bytes
        .split(|byte| *byte == b'\n')
        .map(|line| line.strip_suffix(b"\r").unwrap_or(line));
    if mime_type == GNOME_LIST && !matches!(lines.next(), Some(b"copy" | b"cut")) {
        return Err(ClipboardImageError::Clipboard(
            "Invalid copied-file selection".into(),
        ));
    }
    let mut paths = Vec::new();
    for line in lines.filter(|line| !line.is_empty() && !line.starts_with(b"#")) {
        if paths.len() == MAX_PATHS {
            return Err(ClipboardImageError::Clipboard(
                "Clipboard contains more than 8 files".into(),
            ));
        }
        let path = file_uri_path(line)
            .map_err(|error| ClipboardImageError::Clipboard(error.to_string()))?;
        paths.push(path);
    }
    Ok(paths)
}

fn file_uri_path(uri: &[u8]) -> io::Result<PathBuf> {
    let remote = || io::Error::other("Clipboard selection must contain local file URLs");
    let path = uri.strip_prefix(b"file://").ok_or_else(remote)?;
    let path = path.strip_prefix(b"localhost").unwrap_or(path);
    if !path.starts_with(b"/")
        || path.starts_with(b"//")
        || path.contains(&b'?')
        || path.contains(&b'#')
    {
        return Err(remote());
    }
    let mut decoded = Vec::with_capacity(path.len());
    let mut input = path.iter().copied();
    while let Some(byte) = input.next() {
        let value = if byte == b'%' {
            let mut hex = || {
                input
                    .next()
                    .and_then(|value| char::from(value).to_digit(16))
            };
            let high = hex().ok_or_else(remote)?;
            let low = hex().ok_or_else(remote)?;
            ((high << 4) | low) as u8
        } else {
            byte
        };
        if value == 0 {
            return Err(remote());
        }
        decoded.push(value);
    }
    if decoded.starts_with(b"//") {
        return Err(remote());
    }
    Ok(PathBuf::from(std::ffi::OsString::from_vec(decoded)))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_typed_uri_lists_preserving_names_and_order() {
        let paths = parse_file_list(
            b"# copied files\r\nfile:///tmp/%E6%97%A5%E6%9C%AC%20report%5C1.txt\r\nfile://localhost/tmp/last%0D\r\n",
            URI_LIST,
        ).unwrap();
        assert_eq!(
            paths,
            [
                PathBuf::from("/tmp/日本 report\\1.txt"),
                PathBuf::from("/tmp/last\r")
            ]
        );
        let paths = parse_file_list(b"copy\nfile:///tmp/one\nfile:///tmp/two", GNOME_LIST).unwrap();
        assert_eq!(
            paths,
            [PathBuf::from("/tmp/one"), PathBuf::from("/tmp/two")]
        );
    }

    #[test]
    fn rejects_nonlocal_or_malformed_items_in_the_whole_typed_batch() {
        for invalid in [
            "https://example.test/file",
            "file://server/share",
            "file:////server/share",
            "file:///%2fserver/share",
            "file:///tmp/null%00",
            "file:///tmp/unencoded#fragment",
            "file:///tmp/bad%qx",
            "/tmp/plain-path",
        ] {
            assert!(parse_file_list(
                format!("file:///tmp/valid\r\n{invalid}").as_bytes(),
                URI_LIST
            )
            .is_err());
        }
    }
}
