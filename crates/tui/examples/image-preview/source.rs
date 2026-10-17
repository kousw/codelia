use image::{DynamicImage, Rgba, RgbaImage};
use std::{io, path::Path};

#[path = "../../src/app/image_preview/decode.rs"]
mod decoder;

pub(super) use decoder::safe_label;
#[cfg(test)]
pub(super) use decoder::{decode, validate_dimensions, MAX_FILE_BYTES};

pub(super) fn load(path: Option<&Path>) -> io::Result<(DynamicImage, String)> {
    match path {
        Some(path) => {
            let loaded = decoder::load_file(path)?;
            Ok((
                loaded.image,
                format!("{} | {} (preview <= 1024 px)", loaded.label, loaded.details),
            ))
        }
        None => Ok((
            demo_image(),
            "In-memory demo (640 x 360); no file or model used".into(),
        )),
    }
}

pub(super) fn demo_image() -> DynamicImage {
    let image = RgbaImage::from_fn(640, 360, |x, y| {
        let circle = (i64::from(x) - 420).pow(2) + (i64::from(y) - 170).pow(2) < 100_i64.pow(2);
        if circle {
            Rgba([249, 180, 62, 255])
        } else if (x / 40 + y / 40) % 2 == 0 {
            Rgba([25, (70 + y / 3) as u8, (110 + x / 8) as u8, 255])
        } else {
            Rgba([18, 40, 66, 255])
        }
    });
    DynamicImage::ImageRgba8(image)
}
