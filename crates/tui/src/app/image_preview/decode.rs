use std::{
    fs::{self, OpenOptions},
    io::{self, Cursor, Read},
    path::Path,
};

use image::{DynamicImage, ImageFormat, ImageReader};

pub(crate) const MAX_FILE_BYTES: u64 = 8 * 1024 * 1024;
const MAX_DIMENSION: u32 = 4096;
const MAX_PIXELS: u64 = 16 * 1024 * 1024;
const MAX_DECODE_BYTES: u64 = 96 * 1024 * 1024;
const PREVIEW_DIMENSION: u32 = 1024;

pub(crate) struct LoadedImage {
    pub image: DynamicImage,
    pub label: String,
    pub details: String,
}

pub(crate) fn safe_label(text: &str) -> String {
    text.chars()
        .take(1024)
        .flat_map(|ch| {
            if ch.is_control() || matches!(ch, '\u{202a}'..='\u{202e}' | '\u{2066}'..='\u{2069}') {
                ch.escape_default().collect::<Vec<_>>()
            } else {
                vec![ch]
            }
        })
        .collect()
}

pub(crate) fn load_file(path: &Path) -> io::Result<LoadedImage> {
    if !fs::metadata(path)?.is_file() {
        return Err(io::Error::other("Choose a regular local image file"));
    }
    let mut options = OpenOptions::new();
    options.read(true);
    // Avoid blocking on a FIFO swapped in between metadata and open on Unix.
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        options.custom_flags(libc::O_NONBLOCK);
    }
    let file = options.open(path)?;
    let metadata = file.metadata()?;
    if !metadata.is_file() || metadata.len() > MAX_FILE_BYTES {
        return Err(io::Error::other(
            "Image must be a regular file of at most 8 MiB",
        ));
    }
    let mut bytes = Vec::new();
    file.take(MAX_FILE_BYTES + 1).read_to_end(&mut bytes)?;
    let (image, width, height) = decode(&bytes)?;
    let resolved = path.canonicalize()?;
    Ok(LoadedImage {
        image,
        label: safe_label(&resolved.to_string_lossy()),
        details: format!("{width} x {height} | {} bytes", bytes.len()),
    })
}

fn reader(bytes: &[u8]) -> io::Result<ImageReader<Cursor<&[u8]>>> {
    let mut reader = ImageReader::new(Cursor::new(bytes)).with_guessed_format()?;
    if !matches!(
        reader.format(),
        Some(ImageFormat::Png | ImageFormat::Jpeg | ImageFormat::Gif | ImageFormat::WebP)
    ) {
        return Err(io::Error::other(
            "Supported formats: PNG, JPEG, GIF (first frame), WebP",
        ));
    }
    let mut limits = image::Limits::default();
    limits.max_image_width = Some(MAX_DIMENSION);
    limits.max_image_height = Some(MAX_DIMENSION);
    limits.max_alloc = Some(MAX_DECODE_BYTES);
    reader.limits(limits);
    Ok(reader)
}

pub(crate) fn validate_dimensions(width: u32, height: u32) -> io::Result<()> {
    if width == 0
        || height == 0
        || width > MAX_DIMENSION
        || height > MAX_DIMENSION
        || u64::from(width) * u64::from(height) > MAX_PIXELS
    {
        return Err(io::Error::other(
            "Image dimensions exceed the preview limit (4096 px per side, 16 MP)",
        ));
    }
    Ok(())
}

pub(crate) fn decode(bytes: &[u8]) -> io::Result<(DynamicImage, u32, u32)> {
    if bytes.len() as u64 > MAX_FILE_BYTES {
        return Err(io::Error::other("Image exceeds 8 MiB"));
    }
    let (width, height) = reader(bytes)?.into_dimensions().map_err(io::Error::other)?;
    validate_dimensions(width, height)?;
    let decoded = reader(bytes)?.decode().map_err(io::Error::other)?;
    let preview = if width > PREVIEW_DIMENSION || height > PREVIEW_DIMENSION {
        decoded.thumbnail(PREVIEW_DIMENSION, PREVIEW_DIMENSION)
    } else {
        decoded
    }
    .to_rgba8();
    Ok((DynamicImage::ImageRgba8(preview), width, height))
}
