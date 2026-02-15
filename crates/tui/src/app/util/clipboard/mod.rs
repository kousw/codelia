use crate::app::PendingImageAttachment;
use arboard::{Clipboard, Error as ClipboardError};
use base64::Engine;
use serde_json::Value;
use std::env;
use std::fs;
use std::process::Command;

#[derive(Debug)]
pub enum ClipboardImageError {
    NotAvailable,
    TooLarge { bytes: usize, max_bytes: usize },
    Clipboard(String),
    Encode(String),
}

const WINDOWS_CLIPBOARD_IMAGE_SCRIPT: &str = r#"
$img = Get-Clipboard -Format Image
if ($null -eq $img) { exit 3 }
$ms = New-Object System.IO.MemoryStream
$img.Save($ms, [System.Drawing.Imaging.ImageFormat]::Png)
$obj = @{ width = $img.Width; height = $img.Height; base64 = [Convert]::ToBase64String($ms.ToArray()) }
$obj | ConvertTo-Json -Compress
"#;

fn encode_png_rgba(
    width: usize,
    height: usize,
    rgba: &[u8],
) -> Result<Vec<u8>, ClipboardImageError> {
    let width_u32 = u32::try_from(width).map_err(|_| {
        ClipboardImageError::Encode("clipboard image width is too large".to_string())
    })?;
    let height_u32 = u32::try_from(height).map_err(|_| {
        ClipboardImageError::Encode("clipboard image height is too large".to_string())
    })?;
    let mut bytes = Vec::new();
    {
        let mut encoder = png::Encoder::new(&mut bytes, width_u32, height_u32);
        encoder.set_color(png::ColorType::Rgba);
        encoder.set_depth(png::BitDepth::Eight);
        let mut writer = encoder.write_header().map_err(|error| {
            ClipboardImageError::Encode(format!("failed to write PNG header: {error}"))
        })?;
        writer.write_image_data(rgba).map_err(|error| {
            ClipboardImageError::Encode(format!("failed to encode PNG bytes: {error}"))
        })?;
    }
    Ok(bytes)
}

fn is_wsl_environment() -> bool {
    if env::var_os("WSL_DISTRO_NAME").is_some() || env::var_os("WSL_INTEROP").is_some() {
        return true;
    }
    fs::read_to_string("/proc/sys/kernel/osrelease")
        .map(|value| value.to_ascii_lowercase().contains("microsoft"))
        .unwrap_or(false)
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

fn read_windows_clipboard_image_attachment(
    max_bytes: usize,
) -> Result<PendingImageAttachment, ClipboardImageError> {
    let output = Command::new("powershell.exe")
        .args([
            "-NoProfile",
            "-NonInteractive",
            "-ExecutionPolicy",
            "Bypass",
            "-Command",
            WINDOWS_CLIPBOARD_IMAGE_SCRIPT,
        ])
        .output()
        .map_err(|error| {
            ClipboardImageError::Clipboard(format!("failed to launch powershell.exe: {error}"))
        })?;
    if output.status.code() == Some(3) {
        return Err(ClipboardImageError::NotAvailable);
    }
    if !output.status.success() {
        let stderr = String::from_utf8_lossy(&output.stderr);
        let details = stderr.trim();
        if details.is_empty() {
            return Err(ClipboardImageError::Clipboard(format!(
                "powershell.exe exited with status {}",
                output.status
            )));
        }
        return Err(ClipboardImageError::Clipboard(format!(
            "powershell.exe failed: {details}"
        )));
    }
    let stdout = String::from_utf8_lossy(&output.stdout);
    if stdout.trim().is_empty() {
        return Err(ClipboardImageError::Clipboard(
            "PowerShell returned empty clipboard image payload".to_string(),
        ));
    }
    parse_windows_clipboard_image_json(&stdout, max_bytes)
}

pub fn read_clipboard_image_attachment(
    max_bytes: usize,
) -> Result<PendingImageAttachment, ClipboardImageError> {
    let native_result = (|| {
        let mut clipboard =
            Clipboard::new().map_err(|error| ClipboardImageError::Clipboard(error.to_string()))?;
        let image = match clipboard.get_image() {
            Ok(image) => image,
            Err(ClipboardError::ContentNotAvailable) => {
                return Err(ClipboardImageError::NotAvailable)
            }
            Err(error) => return Err(ClipboardImageError::Clipboard(error.to_string())),
        };
        let encoded = encode_png_rgba(image.width, image.height, image.bytes.as_ref())?;
        if encoded.len() > max_bytes {
            return Err(ClipboardImageError::TooLarge {
                bytes: encoded.len(),
                max_bytes,
            });
        }
        let data_url = format!(
            "data:image/png;base64,{}",
            base64::engine::general_purpose::STANDARD.encode(encoded.as_slice())
        );
        let width = u32::try_from(image.width).map_err(|_| {
            ClipboardImageError::Encode("clipboard image width is too large".to_string())
        })?;
        let height = u32::try_from(image.height).map_err(|_| {
            ClipboardImageError::Encode("clipboard image height is too large".to_string())
        })?;
        Ok(PendingImageAttachment {
            data_url,
            width,
            height,
            encoded_bytes: encoded.len(),
        })
    })();

    match native_result {
        Ok(attachment) => Ok(attachment),
        Err(native_error) => {
            if !is_wsl_environment() {
                return Err(native_error);
            }
            match read_windows_clipboard_image_attachment(max_bytes) {
                Ok(attachment) => Ok(attachment),
                Err(ClipboardImageError::NotAvailable) => Err(ClipboardImageError::NotAvailable),
                Err(windows_error) => match native_error {
                    ClipboardImageError::NotAvailable => Err(windows_error),
                    _ => Err(native_error),
                },
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::parse_windows_clipboard_image_json;

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
}
