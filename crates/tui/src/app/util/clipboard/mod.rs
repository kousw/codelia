use crate::app::PendingImageAttachment;
use arboard::{Clipboard, Error as ClipboardError};
use base64::Engine;
use serde_json::Value;
use std::env;
use std::fs;
use std::io::{self, Read, Write};
use std::path::PathBuf;
use std::process::{Child, Command, Stdio};
use std::sync::mpsc::{self, TryRecvError};
use std::thread;
use std::time::{Duration, Instant};

#[cfg(any(target_os = "linux", all(unix, test)))]
mod linux_files;

const MAX_CLIPBOARD_TEXT_BYTES: usize = 1024 * 1024;
const WINDOWS_CLIPBOARD_TEXT_TIMEOUT: Duration = Duration::from_secs(2);
const WINDOWS_CLIPBOARD_TEXT_SCRIPT: &str =
    "[Console]::InputEncoding = [System.Text.Encoding]::UTF8; Set-Clipboard -Value ([Console]::In.ReadToEnd())";

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum ClipboardTextBackend {
    Native,
    WindowsBridge,
}

#[derive(Debug, PartialEq, Eq)]
pub enum ClipboardTextError {
    TooLarge { bytes: usize, max_bytes: usize },
    Unavailable(String),
}

impl std::fmt::Display for ClipboardTextError {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::TooLarge { bytes, max_bytes } => {
                write!(
                    formatter,
                    "selection is too large ({bytes} bytes; max {max_bytes})"
                )
            }
            Self::Unavailable(message) => formatter.write_str(message),
        }
    }
}

#[derive(Debug)]
pub enum ClipboardImageError {
    NotAvailable,
    TooLarge { bytes: usize, max_bytes: usize },
    Clipboard(String),
    Encode(String),
}

impl std::fmt::Display for ClipboardImageError {
    fn fmt(&self, out: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::NotAvailable => out.write_str("No copied files or image found in the clipboard"),
            Self::TooLarge { bytes, max_bytes } => {
                write!(
                    out,
                    "Clipboard image is {bytes} bytes (limit {max_bytes} bytes)"
                )
            }
            Self::Clipboard(message) | Self::Encode(message) => out.write_str(message),
        }
    }
}

pub(crate) enum ClipboardSource {
    Files(Vec<PathBuf>),
    Bitmap(PendingImageAttachment),
}

const WINDOWS_CLIPBOARD_IMAGE_SCRIPT: &str = r#"
$img = Get-Clipboard -Format Image
if ($null -eq $img) { exit 3 }
if ($img.Width -gt 12288 -or $img.Height -gt 12288 -or ([long]$img.Width * $img.Height) -gt 20000000) { exit 4 }
$ms = New-Object System.IO.MemoryStream
$img.Save($ms, [System.Drawing.Imaging.ImageFormat]::Png)
if ($ms.Length -gt 5242880) { exit 4 }
$obj = @{ width = $img.Width; height = $img.Height; base64 = [Convert]::ToBase64String($ms.ToArray()) }
$obj | ConvertTo-Json -Compress
"#;

const WINDOWS_CLIPBOARD_FILES_SCRIPT: &str = r#"
$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = New-Object System.Text.UTF8Encoding($false)
$files = @(Get-Clipboard -Format FileDropList)
if ($files.Count -eq 0) { exit 3 }
if ($files.Count -gt 8) { exit 4 }
$paths = @($files | ForEach-Object { $_.FullName })
ConvertTo-Json -InputObject $paths -Compress
"#;

fn encode_png_rgba(
    width: u32,
    height: u32,
    rgba: &[u8],
    max_bytes: usize,
) -> Result<Vec<u8>, ClipboardImageError> {
    let mut output = PngOutput {
        bytes: Vec::new(),
        max_bytes,
        rejected_size: None,
    };
    let result = (|| {
        let mut encoder = png::Encoder::new(&mut output, width, height);
        encoder.set_color(png::ColorType::Rgba);
        encoder.set_depth(png::BitDepth::Eight);
        let mut writer = encoder.write_header()?;
        writer.write_image_data(rgba)?;
        writer.finish()
    })();
    if let Some(bytes) = output.rejected_size {
        return Err(ClipboardImageError::TooLarge { bytes, max_bytes });
    }
    result.map_err(|error| {
        ClipboardImageError::Encode(format!("Failed to encode clipboard image: {error}"))
    })?;
    Ok(output.bytes)
}

struct PngOutput {
    bytes: Vec<u8>,
    max_bytes: usize,
    rejected_size: Option<usize>,
}

impl Write for PngOutput {
    fn write(&mut self, input: &[u8]) -> io::Result<usize> {
        let size = self.bytes.len().saturating_add(input.len());
        if size > self.max_bytes {
            self.rejected_size = Some(size);
            return Err(io::Error::other("Clipboard PNG exceeds its size limit"));
        }
        self.bytes.write(input)
    }

    fn flush(&mut self) -> io::Result<()> {
        Ok(())
    }
}

fn is_wsl_environment() -> bool {
    if env::var_os("WSL_DISTRO_NAME").is_some() || env::var_os("WSL_INTEROP").is_some() {
        return true;
    }
    fs::read_to_string("/proc/sys/kernel/osrelease")
        .map(|value| value.to_ascii_lowercase().contains("microsoft"))
        .unwrap_or(false)
}

fn write_native_clipboard_text(text: &str) -> Result<(), ClipboardTextError> {
    let mut clipboard = Clipboard::new().map_err(|error| {
        ClipboardTextError::Unavailable(format!("clipboard unavailable: {error}"))
    })?;
    clipboard.set_text(text.to_string()).map_err(|error| {
        ClipboardTextError::Unavailable(format!("clipboard write failed: {error}"))
    })
}

fn stop_child(child: &mut Child) {
    if child.kill().is_ok() {
        let _ = child.wait();
    }
}

fn write_child_stdin_with_timeout(
    mut child: Child,
    input: Vec<u8>,
    timeout: Duration,
) -> Result<(), ClipboardTextError> {
    let Some(mut stdin) = child.stdin.take() else {
        stop_child(&mut child);
        return Err(ClipboardTextError::Unavailable(
            "PowerShell stdin unavailable".to_string(),
        ));
    };
    let started = Instant::now();
    let (write_tx, write_rx) = mpsc::channel();
    thread::spawn(move || {
        let result = stdin.write_all(&input);
        drop(stdin);
        let _ = write_tx.send(result);
    });

    let mut write_finished = false;
    loop {
        if !write_finished {
            match write_rx.try_recv() {
                Ok(Ok(())) => write_finished = true,
                Ok(Err(error)) => {
                    stop_child(&mut child);
                    return Err(ClipboardTextError::Unavailable(format!(
                        "PowerShell stdin write failed: {error}"
                    )));
                }
                Err(TryRecvError::Disconnected) => {
                    stop_child(&mut child);
                    return Err(ClipboardTextError::Unavailable(
                        "PowerShell stdin writer stopped unexpectedly".to_string(),
                    ));
                }
                Err(TryRecvError::Empty) => {}
            }
        }

        match child.try_wait() {
            Ok(Some(status)) if status.success() && write_finished => return Ok(()),
            Ok(Some(status)) if !status.success() => {
                return Err(ClipboardTextError::Unavailable(format!(
                    "powershell.exe exited with status {status}"
                )));
            }
            Ok(Some(_)) | Ok(None) => {}
            Err(error) => {
                stop_child(&mut child);
                return Err(ClipboardTextError::Unavailable(format!(
                    "PowerShell clipboard wait failed: {error}"
                )));
            }
        }

        let elapsed = started.elapsed();
        if elapsed >= timeout {
            stop_child(&mut child);
            return Err(ClipboardTextError::Unavailable(
                "PowerShell clipboard write timed out".to_string(),
            ));
        }
        thread::sleep(Duration::from_millis(10).min(timeout.saturating_sub(elapsed)));
    }
}

fn write_windows_clipboard_text(text: &str) -> Result<(), ClipboardTextError> {
    let child = Command::new("powershell.exe")
        .args([
            "-NoProfile",
            "-NonInteractive",
            "-ExecutionPolicy",
            "Bypass",
            "-Command",
            WINDOWS_CLIPBOARD_TEXT_SCRIPT,
        ])
        .stdin(Stdio::piped())
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .spawn()
        .map_err(|error| {
            ClipboardTextError::Unavailable(format!("failed to launch powershell.exe: {error}"))
        })?;
    write_child_stdin_with_timeout(
        child,
        text.as_bytes().to_vec(),
        WINDOWS_CLIPBOARD_TEXT_TIMEOUT,
    )
}

pub fn write_clipboard_text(text: &str) -> Result<ClipboardTextBackend, ClipboardTextError> {
    let bytes = text.len();
    if bytes > MAX_CLIPBOARD_TEXT_BYTES {
        return Err(ClipboardTextError::TooLarge {
            bytes,
            max_bytes: MAX_CLIPBOARD_TEXT_BYTES,
        });
    }
    if is_wsl_environment() {
        return match write_windows_clipboard_text(text) {
            Ok(()) => Ok(ClipboardTextBackend::WindowsBridge),
            Err(windows_error) => write_native_clipboard_text(text)
                .map(|()| ClipboardTextBackend::Native)
                .map_err(|_| windows_error),
        };
    }
    write_native_clipboard_text(text).map(|()| ClipboardTextBackend::Native)
}

fn parse_windows_clipboard_image_json(
    output: &str,
    max_bytes: usize,
) -> Result<PendingImageAttachment, ClipboardImageError> {
    let value: Value = serde_json::from_str(output.trim()).map_err(|error| {
        ClipboardImageError::Clipboard(format!("failed to parse PowerShell image payload: {error}"))
    })?;
    let width = value
        .get("width")
        .and_then(Value::as_u64)
        .and_then(|v| u32::try_from(v).ok())
        .ok_or_else(|| {
            ClipboardImageError::Clipboard("missing width in PowerShell image payload".to_string())
        })?;
    let height = value
        .get("height")
        .and_then(Value::as_u64)
        .and_then(|v| u32::try_from(v).ok())
        .ok_or_else(|| {
            ClipboardImageError::Clipboard("missing height in PowerShell image payload".to_string())
        })?;
    crate::app::image_preview::validate_dimensions(width, height)
        .map_err(|error| ClipboardImageError::Encode(error.to_string()))?;
    let base64_data = value.get("base64").and_then(Value::as_str).ok_or_else(|| {
        ClipboardImageError::Clipboard("missing base64 in PowerShell image payload".to_string())
    })?;
    let encoded = base64::engine::general_purpose::STANDARD
        .decode(base64_data)
        .map_err(|error| {
            ClipboardImageError::Clipboard(format!(
                "failed to decode PowerShell image payload: {error}"
            ))
        })?;
    if encoded.len() > max_bytes {
        return Err(ClipboardImageError::TooLarge {
            bytes: encoded.len(),
            max_bytes,
        });
    }
    Ok(PendingImageAttachment {
        data_url: format!("data:image/png;base64,{base64_data}"),
        width,
        height,
        encoded_bytes: encoded.len(),
    })
}

fn bounded_output(
    command: &mut Command,
    max_bytes: usize,
    timeout: Duration,
) -> io::Result<(std::process::ExitStatus, Vec<u8>)> {
    let mut child = command
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::null())
        .spawn()?;
    let Some(stdout) = child.stdout.take() else {
        stop_child(&mut child);
        return Err(io::Error::other("Clipboard subprocess has no output pipe"));
    };
    let (send, receive) = mpsc::channel();
    thread::spawn(move || {
        let mut bytes = Vec::new();
        let result = stdout
            .take(max_bytes as u64 + 1)
            .read_to_end(&mut bytes)
            .and_then(|_| {
                if bytes.len() > max_bytes {
                    Err(io::Error::other(
                        "Clipboard subprocess output exceeds its size limit",
                    ))
                } else {
                    Ok(bytes)
                }
            });
        let _ = send.send(result);
    });

    let deadline = Instant::now() + timeout;
    let result = (|| {
        let bytes = receive
            .recv_timeout(timeout)
            .map_err(|_| io::Error::other("Clipboard subprocess timed out"))??;
        loop {
            if let Some(status) = child.try_wait()? {
                return Ok((status, bytes));
            }
            if Instant::now() >= deadline {
                return Err(io::Error::other("Clipboard subprocess timed out"));
            }
            thread::sleep(Duration::from_millis(10));
        }
    })();
    if result.is_err() {
        stop_child(&mut child);
    }
    result
}

fn powershell_clipboard_command(script: &str) -> Command {
    let mut command = Command::new("powershell.exe");
    command.args(["-NoProfile", "-NonInteractive", "-STA", "-Command", script]);
    command
}

fn read_windows_clipboard_image_attachment(
    max_bytes: usize,
) -> Result<PendingImageAttachment, ClipboardImageError> {
    let (status, bytes) = bounded_output(
        &mut powershell_clipboard_command(WINDOWS_CLIPBOARD_IMAGE_SCRIPT),
        max_bytes.div_ceil(3) * 4 + 1024,
        Duration::from_secs(4),
    )
    .map_err(|error| ClipboardImageError::Clipboard(error.to_string()))?;
    match status.code() {
        Some(3) => return Err(ClipboardImageError::NotAvailable),
        Some(4) => {
            return Err(ClipboardImageError::Clipboard(
                "Clipboard image exceeds the attachment size or pixel limit".into(),
            ));
        }
        _ if !status.success() => {
            return Err(ClipboardImageError::Clipboard(format!(
                "PowerShell image clipboard read failed ({status})"
            )));
        }
        _ => {}
    }
    parse_windows_clipboard_image_json(&String::from_utf8_lossy(&bytes), max_bytes)
}

fn is_windows_drive_path(path: &str) -> bool {
    matches!(path.as_bytes(), [letter, b':', b'\\' | b'/', ..] if letter.is_ascii_alphabetic())
}

fn windows_paths_to_wsl(
    paths: Vec<String>,
    mut map: impl FnMut(&str) -> io::Result<PathBuf>,
) -> io::Result<Vec<PathBuf>> {
    paths
        .iter()
        .map(|path| {
            if !is_windows_drive_path(path) {
                return Err(io::Error::other(
                    "WSL clipboard paste requires Windows files on a mounted drive",
                ));
            }
            let mapped = map(path)?;
            if !mapped.is_absolute() {
                return Err(io::Error::other(
                    "Cannot map a clipboard file to a mounted WSL path",
                ));
            }
            Ok(mapped)
        })
        .collect()
}

fn read_windows_clipboard_files() -> Result<Vec<PathBuf>, ClipboardImageError> {
    // Launch failure leaves native Linux clipboard paste available in WSL.
    let (status, bytes) = match bounded_output(
        &mut powershell_clipboard_command(WINDOWS_CLIPBOARD_FILES_SCRIPT),
        256 * 1024,
        Duration::from_secs(4),
    ) {
        Ok(result) => result,
        Err(error) if error.kind() == io::ErrorKind::NotFound => return Ok(Vec::new()),
        Err(error) => return Err(ClipboardImageError::Clipboard(error.to_string())),
    };
    match status.code() {
        Some(3) => return Ok(Vec::new()),
        Some(4) => {
            return Err(ClipboardImageError::Clipboard(
                "Clipboard contains more than 8 files".into(),
            ));
        }
        _ if !status.success() => {
            return Err(ClipboardImageError::Clipboard(format!(
                "PowerShell file clipboard read failed ({status})"
            )));
        }
        _ => {}
    }

    let paths: Vec<String> = serde_json::from_slice(&bytes).map_err(|_| {
        ClipboardImageError::Clipboard("PowerShell returned an invalid clipboard file list".into())
    })?;
    windows_paths_to_wsl(paths, |path| {
        let (status, mapped) = bounded_output(
            Command::new("wslpath").args(["-a", "-u", path]),
            32 * 1024,
            Duration::from_secs(2),
        )?;
        if !status.success() {
            return Err(io::Error::other(
                "Cannot map a clipboard file to a mounted WSL path",
            ));
        }
        let mapped = String::from_utf8(mapped).map_err(io::Error::other)?;
        Ok(PathBuf::from(mapped.strip_suffix('\n').unwrap_or(&mapped)))
    })
    .map_err(|error| ClipboardImageError::Clipboard(error.to_string()))
}

fn read_native_bitmap(
    clipboard: &mut Clipboard,
    max_bytes: usize,
) -> Result<PendingImageAttachment, ClipboardImageError> {
    let image = clipboard.get_image().map_err(|error| match error {
        ClipboardError::ContentNotAvailable => ClipboardImageError::NotAvailable,
        error => ClipboardImageError::Clipboard(error.to_string()),
    })?;
    let width = u32::try_from(image.width)
        .map_err(|_| ClipboardImageError::Encode("Clipboard image width is too large".into()))?;
    let height = u32::try_from(image.height)
        .map_err(|_| ClipboardImageError::Encode("Clipboard image height is too large".into()))?;
    crate::app::image_preview::validate_dimensions(width, height)
        .map_err(|error| ClipboardImageError::Encode(error.to_string()))?;
    let encoded = encode_png_rgba(width, height, image.bytes.as_ref(), max_bytes)?;
    let data_url = format!(
        "data:image/png;base64,{}",
        base64::engine::general_purpose::STANDARD.encode(&encoded)
    );
    Ok(PendingImageAttachment {
        data_url,
        width,
        height,
        encoded_bytes: encoded.len(),
    })
}

pub(crate) fn read_typed_clipboard(
    max_image_bytes: usize,
) -> Result<ClipboardSource, ClipboardImageError> {
    #[cfg(target_os = "linux")]
    {
        let files = linux_files::read_file_list()?;
        if !files.is_empty() {
            return Ok(ClipboardSource::Files(files));
        }
    }
    let native =
        Clipboard::new().map_err(|error| ClipboardImageError::Clipboard(error.to_string()));
    #[cfg(not(target_os = "linux"))]
    let mut native = native;
    #[cfg(not(target_os = "linux"))]
    if let Ok(clipboard) = &mut native {
        match clipboard.get().file_list() {
            Ok(files) if !files.is_empty() => return Ok(ClipboardSource::Files(files)),
            Ok(_) | Err(ClipboardError::ContentNotAvailable) => {}
            Err(error) => return Err(ClipboardImageError::Clipboard(error.to_string())),
        }
    }

    let wsl = is_wsl_environment();
    // Prefer a native Windows file list to any bitmap variant in WSL too.
    if wsl {
        let files = read_windows_clipboard_files()?;
        if !files.is_empty() {
            return Ok(ClipboardSource::Files(files));
        }
    }
    match native.and_then(|mut clipboard| read_native_bitmap(&mut clipboard, max_image_bytes)) {
        Ok(bitmap) => Ok(ClipboardSource::Bitmap(bitmap)),
        Err(error) if wsl => match read_windows_clipboard_image_attachment(max_image_bytes) {
            Ok(bitmap) => Ok(ClipboardSource::Bitmap(bitmap)),
            Err(ClipboardImageError::NotAvailable) => Err(ClipboardImageError::NotAvailable),
            Err(windows_error) => match error {
                ClipboardImageError::NotAvailable => Err(windows_error),
                _ => Err(error),
            },
        },
        Err(error) => Err(error),
    }
}

#[cfg(test)]
mod tests {
    use super::{
        parse_windows_clipboard_image_json, write_child_stdin_with_timeout, ClipboardTextError,
        MAX_CLIPBOARD_TEXT_BYTES, WINDOWS_CLIPBOARD_TEXT_SCRIPT,
    };
    use std::process::{Command, Stdio};
    use std::time::{Duration, Instant};

    #[test]
    fn parse_windows_clipboard_image_payload_success() {
        let attachment = parse_windows_clipboard_image_json(
            r#"{"width":10,"height":20,"base64":"iVBORw0KGgo="}"#,
            1024,
        )
        .expect("expected attachment");
        assert_eq!(attachment.width, 10);
        assert_eq!(attachment.height, 20);
        assert_eq!(attachment.encoded_bytes, 8);
        assert!(attachment.data_url.starts_with("data:image/png;base64,"));
    }

    #[test]
    fn parse_windows_clipboard_image_payload_checks_limit() {
        let error = parse_windows_clipboard_image_json(
            r#"{"width":10,"height":20,"base64":"iVBORw0KGgo="}"#,
            1,
        )
        .expect_err("expected size error");
        match error {
            super::ClipboardImageError::TooLarge { bytes, max_bytes } => {
                assert_eq!(bytes, 8);
                assert_eq!(max_bytes, 1);
            }
            other => panic!("unexpected error: {other:?}"),
        }
    }

    #[test]
    fn clipboard_png_writer_stops_at_the_byte_limit() {
        let pixel = [245, 179, 80, 255];
        let png = super::encode_png_rgba(1, 1, &pixel, 1024).unwrap();
        assert_eq!(&png[..8], b"\x89PNG\r\n\x1a\n");
        assert!(matches!(
            super::encode_png_rgba(1, 1, &pixel, png.len() - 1),
            Err(super::ClipboardImageError::TooLarge { .. })
        ));
    }

    #[test]
    fn wsl_maps_typed_windows_drive_paths_and_rejects_unc() {
        use std::path::PathBuf;

        let copied = String::from(r"C:\Users\日本 語\report [1].txt");
        let mapped = super::windows_paths_to_wsl(vec![copied.clone()], |path| {
            assert_eq!(path, copied);
            Ok(PathBuf::from("/mnt/c/Users/日本 語/report [1].txt"))
        })
        .unwrap();
        assert_eq!(
            mapped,
            [PathBuf::from("/mnt/c/Users/日本 語/report [1].txt")]
        );
        for path in [
            r"\\host\share\report.txt",
            r"C:report.txt",
            "/tmp/report.txt",
        ] {
            assert!(super::windows_paths_to_wsl(vec![path.into()], |_| panic!(
                "cannot map {path}"
            ))
            .is_err());
        }
    }

    #[test]
    fn powershell_text_script_sets_utf8_before_reading_stdin() {
        let encoding = WINDOWS_CLIPBOARD_TEXT_SCRIPT
            .find("InputEncoding")
            .expect("InputEncoding assignment");
        let read = WINDOWS_CLIPBOARD_TEXT_SCRIPT
            .find("ReadToEnd")
            .expect("stdin read");
        assert!(encoding < read);
        assert!(!WINDOWS_CLIPBOARD_TEXT_SCRIPT.contains("${"));
    }

    #[test]
    fn clipboard_text_stdin_round_trips_cjk_and_emoji_as_utf8() {
        let text = "日本語 👩‍💻 🚀";
        assert_eq!(String::from_utf8(text.as_bytes().to_vec()).unwrap(), text);
    }

    #[test]
    fn clipboard_text_limit_is_measured_in_utf8_bytes() {
        let text = "界".repeat(MAX_CLIPBOARD_TEXT_BYTES / 3 + 1);
        let error = super::write_clipboard_text(&text).expect_err("oversized text");
        assert!(matches!(
            error,
            ClipboardTextError::TooLarge {
                max_bytes: MAX_CLIPBOARD_TEXT_BYTES,
                ..
            }
        ));
    }

    #[test]
    fn clipboard_text_stall_child() {
        if std::env::var_os("CODELIA_TEST_CLIPBOARD_STALL").is_some() {
            std::thread::sleep(Duration::from_secs(5));
        }
    }

    #[test]
    fn clipboard_timeout_includes_stalled_stdin_delivery() {
        let child = Command::new(std::env::current_exe().expect("test executable"))
            .arg("clipboard_text_stall_child")
            .env("CODELIA_TEST_CLIPBOARD_STALL", "1")
            .stdin(Stdio::piped())
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .spawn()
            .expect("spawn stalled clipboard child");
        let started = Instant::now();

        let error = write_child_stdin_with_timeout(
            child,
            vec![b'x'; MAX_CLIPBOARD_TEXT_BYTES],
            Duration::from_millis(100),
        )
        .expect_err("stalled stdin must time out");

        assert!(started.elapsed() < Duration::from_secs(2));
        assert!(error.to_string().contains("timed out"));
    }
}
