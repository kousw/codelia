use std::io;

#[derive(Clone, Debug)]
pub(crate) struct PendingImageAttachment {
    pub data_url: String,
    pub width: u32,
    pub height: u32,
    pub encoded_bytes: usize,
}

pub(crate) const MAX_DIMENSION: u32 = 12_288;
const MAX_PIXELS: u64 = 20_000_000;

pub(crate) fn validate_dimensions(width: u32, height: u32) -> io::Result<()> {
    if width == 0
        || height == 0
        || width > MAX_DIMENSION
        || height > MAX_DIMENSION
        || u64::from(width) * u64::from(height) > MAX_PIXELS
    {
        return Err(io::Error::other(
            "Image dimensions exceed the preview limit (12288 px per side, 20 MP)",
        ));
    }
    Ok(())
}
