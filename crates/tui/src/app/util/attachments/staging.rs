use image::{ImageFormat, ImageReader};
use sha2::{Digest, Sha256};
use std::fmt;
use std::fs::{self, Metadata, OpenOptions};
use std::io::{self, Cursor, Read};
use std::path::Path;
use std::sync::atomic::{AtomicBool, AtomicUsize, Ordering};
use std::sync::Arc;

pub(crate) const MAX_ATTACHMENT_COUNT: usize = 8;
pub(crate) const MAX_IMAGE_COUNT: usize = 3;
pub(crate) const MAX_IMAGE_BYTES: usize = 5 * 1024 * 1024;
pub(crate) const MAX_FILE_BYTES: usize = 32 * 1024 * 1024;
pub(crate) const MAX_MESSAGE_BYTES: usize = 64 * 1024 * 1024;

const MAX_STAGED_BYTES: usize = 128 * 1024 * 1024;
static STAGED_BYTES: AtomicUsize = AtomicUsize::new(0);

struct StagingReservation(usize);

impl StagingReservation {
    fn new(size: usize) -> io::Result<Arc<Self>> {
        STAGED_BYTES
            .fetch_update(Ordering::Relaxed, Ordering::Relaxed, |used| {
                used.checked_add(size)
                    .filter(|total| *total <= MAX_STAGED_BYTES)
            })
            .map_err(|_| io::Error::other("Attachment staging is full (128 MiB)"))?;
        Ok(Arc::new(Self(size)))
    }
}

impl Drop for StagingReservation {
    fn drop(&mut self) {
        STAGED_BYTES.fetch_sub(self.0, Ordering::Relaxed);
    }
}

#[derive(Clone)]
pub(crate) struct StagedAttachment {
    pub bytes: Arc<[u8]>,
    pub sha256: String,
    pub media_type: String,
    pub display_name: String,
    pub dimensions: Option<(u32, u32)>,
    pub origin: &'static str,
    _reservation: Arc<StagingReservation>,
}

impl fmt::Debug for StagedAttachment {
    fn fmt(&self, out: &mut fmt::Formatter<'_>) -> fmt::Result {
        out.debug_struct("StagedAttachment")
            .field("size", &self.bytes.len())
            .field("media_type", &self.media_type)
            .field("dimensions", &self.dimensions)
            .field("origin", &self.origin)
            .finish_non_exhaustive()
    }
}

impl StagedAttachment {
    pub(super) fn from_file(
        path: &Path,
        max_bytes: usize,
        cancelled: &AtomicBool,
    ) -> io::Result<Self> {
        if !path.is_absolute() || !fs::metadata(path)?.is_file() {
            return Err(io::Error::other("Choose a regular local file"));
        }
        let mut options = OpenOptions::new();
        options.read(true);
        // A source swapped for a FIFO between metadata and open must not stall.
        #[cfg(unix)]
        {
            use std::os::unix::fs::OpenOptionsExt;
            options.custom_flags(libc::O_NONBLOCK);
        }
        let mut file = options.open(path)?;
        let before = file.metadata()?;
        if !before.is_file() {
            return Err(io::Error::other("Choose a regular local file"));
        }
        let size = usize::try_from(before.len())
            .ok()
            .filter(|size| *size <= MAX_FILE_BYTES && *size <= max_bytes)
            .ok_or_else(|| io::Error::other("File exceeds the attachment size limit"))?;
        let reservation = StagingReservation::new(size)?;
        let mut bytes = Vec::with_capacity(size);
        let mut remaining = file.by_ref().take(size as u64);
        let mut chunk = [0u8; 64 * 1024];
        loop {
            if cancelled.load(Ordering::Relaxed) {
                return Err(io::Error::new(
                    io::ErrorKind::Interrupted,
                    "Paste cancelled",
                ));
            }
            let read = remaining.read(&mut chunk)?;
            if read == 0 {
                break;
            }
            bytes.extend_from_slice(&chunk[..read]);
        }
        let mut extra = [0u8; 1];
        if bytes.len() != size
            || file.read(&mut extra)? != 0
            || !same_file(&before, &file.metadata()?)
            || !fs::metadata(path).is_ok_and(|after| same_file(&before, &after))
        {
            return Err(io::Error::other(
                "File changed while it was being copied; paste it again",
            ));
        }
        Self::new(file_label(path), bytes, "file", reservation)
    }

    #[cfg(test)]
    pub(crate) fn from_bytes(
        display_name: String,
        bytes: Vec<u8>,
        origin: &'static str,
    ) -> io::Result<Self> {
        if bytes.len() > MAX_FILE_BYTES {
            return Err(io::Error::other("File exceeds the attachment size limit"));
        }
        let reservation = StagingReservation::new(bytes.len())?;
        Self::new(display_name, bytes, origin, reservation)
    }

    fn new(
        display_name: String,
        bytes: Vec<u8>,
        origin: &'static str,
        reservation: Arc<StagingReservation>,
    ) -> io::Result<Self> {
        let (media_type, dimensions) = describe(&bytes)?;
        Ok(Self {
            sha256: format!("{:x}", Sha256::digest(&bytes)),
            bytes: bytes.into(),
            display_name,
            media_type: media_type.to_owned(),
            dimensions,
            origin,
            _reservation: reservation,
        })
    }
}

fn same_file(before: &Metadata, after: &Metadata) -> bool {
    if before.len() != after.len()
        || before.modified().ok() != after.modified().ok()
        || !after.is_file()
    {
        return false;
    }
    #[cfg(unix)]
    {
        use std::os::unix::fs::MetadataExt;
        before.dev() == after.dev()
            && before.ino() == after.ino()
            && before.ctime() == after.ctime()
            && before.ctime_nsec() == after.ctime_nsec()
    }
    #[cfg(not(unix))]
    {
        before.created().ok() == after.created().ok()
    }
}

pub(super) fn file_label(path: &Path) -> String {
    let name = path.file_name().unwrap_or_default().to_string_lossy();
    let mut label = String::new();
    for ch in name.trim().chars() {
        let ch = if ch.is_control()
            || matches!(
                ch,
                '/' | '\\'
                    | '\u{061c}'
                    | '\u{200e}'..='\u{200f}'
                    | '\u{2028}'..='\u{202e}'
                    | '\u{2066}'..='\u{2069}'
            ) {
            '�'
        } else {
            ch
        };
        if label.len() + ch.len_utf8() > 255 {
            break;
        }
        label.push(ch);
    }
    if label.is_empty() || matches!(label.as_str(), "." | "..") {
        "attachment".into()
    } else {
        label
    }
}

fn describe(bytes: &[u8]) -> io::Result<(&'static str, Option<(u32, u32)>)> {
    let format = image::guess_format(bytes).ok();
    let image_type = match format {
        Some(ImageFormat::Png) => Some("image/png"),
        Some(ImageFormat::Jpeg) => Some("image/jpeg"),
        Some(ImageFormat::WebP) => Some("image/webp"),
        Some(ImageFormat::Gif) => Some("image/gif"),
        _ => None,
    };
    if let Some(media_type) = image_type {
        if bytes.len() > MAX_IMAGE_BYTES {
            return Err(io::Error::other("Image exceeds the 5 MiB attachment limit"));
        }
        let mut reader = ImageReader::with_format(Cursor::new(bytes), format.unwrap());
        let mut limits = image::Limits::default();
        limits.max_image_width = Some(12_288);
        limits.max_image_height = Some(12_288);
        limits.max_alloc = Some(128 * 1024 * 1024);
        reader.limits(limits);
        let (width, height) = reader.into_dimensions().map_err(io::Error::other)?;
        crate::app::util::image::validate_dimensions(width, height)?;
        Ok((media_type, Some((width, height))))
    } else {
        let is_text = format.is_none()
            && std::str::from_utf8(bytes).is_ok_and(|value| {
                value
                    .chars()
                    .all(|ch| !ch.is_control() || matches!(ch, '\t' | '\n' | '\r'))
            });
        Ok((
            if is_text {
                "text/plain"
            } else {
                "application/octet-stream"
            },
            None,
        ))
    }
}
