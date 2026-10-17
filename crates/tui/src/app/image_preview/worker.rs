use std::{
    io,
    sync::mpsc::{self, Receiver, SyncSender},
    thread,
};

use base64::Engine;
use image::Rgba;
use ratatui::layout::Size;
use ratatui_image::{protocol::StatefulProtocol, Resize, ResizeEncodeRender};

use super::{decode, PreviewPolicy, Source};

pub(super) struct ReadyImage {
    pub protocol: StatefulProtocol,
    pub label: String,
    pub details: String,
    pub encoded: bool,
}

pub(super) enum Work {
    Load(Source, PreviewPolicy),
    Encode(Box<ReadyImage>, Size),
}

pub(super) struct Job {
    pub generation: u64,
    pub work: Work,
}

pub(super) struct Response {
    pub generation: u64,
    pub result: io::Result<Box<ReadyImage>>,
}

pub(super) struct Worker {
    pub requests: SyncSender<Job>,
    pub responses: Receiver<Response>,
}

impl Worker {
    pub fn spawn() -> io::Result<Self> {
        let (requests, rx) = mpsc::sync_channel::<Job>(1);
        let (tx, responses) = mpsc::sync_channel(1);
        thread::Builder::new()
            .name("codelia-image-preview".into())
            .spawn(move || {
                while let Ok(job) = rx.recv() {
                    let response = Response {
                        generation: job.generation,
                        result: execute(job.work),
                    };
                    if tx.send(response).is_err() {
                        break;
                    }
                }
            })?;
        // The channels own the worker lifetime. Drop never joins a decoder on
        // the UI thread; disconnection makes it exit after its one bounded job.
        Ok(Self {
            requests,
            responses,
        })
    }
}

fn execute(work: Work) -> io::Result<Box<ReadyImage>> {
    match work {
        Work::Load(source, policy) => {
            let loaded = match source {
                Source::File(path) => decode::load_file(&path)?,
                Source::Attachment { data_url, id } => {
                    if data_url.len() > (decode::MAX_FILE_BYTES as usize).div_ceil(3) * 4 + 64 {
                        return Err(io::Error::other("Image attachment exceeds 8 MiB"));
                    }
                    let (header, body) = data_url
                        .split_once(',')
                        .ok_or_else(|| io::Error::other("Invalid image data URL"))?;
                    if !matches!(
                        header,
                        "data:image/png;base64"
                            | "data:image/jpeg;base64"
                            | "data:image/gif;base64"
                            | "data:image/webp;base64"
                    ) {
                        return Err(io::Error::other("Unsupported image attachment type"));
                    }
                    let bytes = base64::engine::general_purpose::STANDARD
                        .decode(body)
                        .map_err(io::Error::other)?;
                    let (image, width, height) = decode::decode(&bytes)?;
                    decode::LoadedImage {
                        image,
                        label: format!("Attachment {}", decode::safe_label(&id)),
                        details: format!("{width} x {height} | {} bytes", bytes.len()),
                    }
                }
            };
            Ok(Box::new(ReadyImage {
                protocol: StatefulProtocol::new(
                    loaded.image,
                    policy.font,
                    Some(Rgba([0, 0, 0, 255])),
                    policy.protocol_type(),
                ),
                label: loaded.label,
                details: loaded.details,
                encoded: false,
            }))
        }
        Work::Encode(mut ready, size) => {
            ready.protocol.resize_encode(&Resize::Fit(None), size);
            if let Some(result) = ready.protocol.last_encoding_result() {
                result.map_err(io::Error::other)?;
            }
            ready.encoded = true;
            Ok(ready)
        }
    }
}
