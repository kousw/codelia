//! Bounded, local-only preview controller. No runtime or terminal I/O here.
mod decode;
mod policy;
mod worker;

pub(crate) use policy::PreviewPolicy;

use crossterm::event::{KeyCode, KeyModifiers};
use ratatui::{
    buffer::Buffer,
    layout::{Rect, Size},
};
use ratatui_image::{Resize, ResizeEncodeRender};
use std::{
    path::PathBuf,
    sync::{mpsc::TryRecvError, Arc},
};
use worker::{Job, ReadyImage, Work, Worker};

#[derive(Clone)]
pub(crate) enum Source {
    File(PathBuf),
    Attachment { id: String, data_url: Arc<str> },
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) enum PreviewMode {
    Small,
    Modal,
}

#[derive(Default)]
pub(crate) struct ImagePreview {
    pub mode: Option<PreviewMode>,
    pub policy: PreviewPolicy,
    pub label: String,
    pub details: String,
    pub error: Option<String>,
    pub desired_size: Size,
    source: Option<Source>,
    pending: Option<Source>,
    ready: Option<Box<ReadyImage>>,
    worker: Option<Worker>,
    busy: bool,
    generation: u64,
    // User intent changes on close/reopen without discarding cached worker output.
    revision: u64,
}

impl ImagePreview {
    pub fn is_open(&self) -> bool {
        self.mode.is_some()
    }

    pub fn revision(&self) -> u64 {
        self.revision
    }

    pub fn open(&mut self, source: Source) {
        self.details.clear();
        self.generation = self.generation.wrapping_add(1);
        self.revision = self.revision.wrapping_add(1);
        self.label = match &source {
            Source::File(path) => format!("Local: {}", decode::safe_label(&path.to_string_lossy())),
            Source::Attachment { id, .. } => format!("Attachment {}", decode::safe_label(id)),
        };
        self.source = Some(source.clone());
        self.pending = Some(source);
        self.ready = None;
        self.error = None;
        self.desired_size = Size::default();
        self.mode = Some(PreviewMode::Small);
    }

    pub fn reopen(&mut self) -> bool {
        if self.source.is_none() {
            return false;
        }
        self.mode = Some(PreviewMode::Small);
        if self.error.is_some() {
            if let Some(source) = self.source.clone() {
                self.open(source);
            }
        } else {
            self.revision = self.revision.wrapping_add(1);
        }
        true
    }

    pub fn close(&mut self) {
        self.revision = self.revision.wrapping_add(1);
        self.mode = None;
        self.desired_size = Size::default();
    }

    pub fn forget(&mut self) {
        self.close();
        self.generation = self.generation.wrapping_add(1);
        self.source = None;
        self.pending = None;
        self.ready = None;
        self.error = None;
        self.label.clear();
        self.details.clear();
    }

    pub fn handle_key(&mut self, key: KeyCode, modifiers: KeyModifiers) -> bool {
        if !self.is_open() {
            return false;
        }
        match (key, modifiers) {
            (KeyCode::Char('c'), mods) if mods.contains(KeyModifiers::CONTROL) => self.close(),
            (KeyCode::Esc, _) if self.mode == Some(PreviewMode::Modal) => {
                self.mode = Some(PreviewMode::Small)
            }
            (KeyCode::Esc | KeyCode::Char('q') | KeyCode::Char('v'), _) => self.close(),
            (KeyCode::Enter | KeyCode::Char(' '), mods) if mods.is_empty() => {
                self.mode = Some(if self.mode == Some(PreviewMode::Small) {
                    PreviewMode::Modal
                } else {
                    PreviewMode::Small
                });
            }
            _ => {}
        }
        // Preview owns every key, not just its shortcuts.
        true
    }

    pub fn poll(&mut self) -> bool {
        let mut changed = false;
        if let Some(worker) = &self.worker {
            match worker.responses.try_recv() {
                Ok(response) => {
                    self.busy = false;
                    if response.generation == self.generation {
                        match response.result {
                            Ok(ready) => {
                                self.label.clone_from(&ready.label);
                                self.details.clone_from(&ready.details);
                                self.ready = Some(ready);
                            }
                            Err(error) => {
                                self.error = Some(decode::safe_label(&error.to_string()));
                                self.ready = None;
                            }
                        }
                        changed = true;
                    }
                }
                Err(TryRecvError::Disconnected) => {
                    self.worker = None;
                    self.busy = false;
                    self.pending = None;
                    self.ready = None;
                    self.error = Some("Image worker stopped; close and /image to retry".into());
                    return true;
                }
                Err(TryRecvError::Empty) => {}
            }
        }
        if self.busy {
            return changed;
        }
        let work = if let Some(source) = self.pending.take() {
            Some(Work::Load(source, self.policy.clone()))
        } else if self.is_open() && self.desired_size.width > 0 && self.desired_size.height > 0 {
            let size = self.ready.as_ref().and_then(|ready| {
                ready
                    .protocol
                    .needs_resize(&Resize::Fit(None), self.desired_size)
            });
            size.and_then(|size| self.ready.take().map(|ready| Work::Encode(ready, size)))
        } else {
            None
        };
        if let Some(work) = work {
            if self.worker.is_none() {
                match Worker::spawn() {
                    Ok(worker) => self.worker = Some(worker),
                    Err(error) => {
                        self.error = Some(decode::safe_label(&error.to_string()));
                        return true;
                    }
                }
            }
            let job = Job {
                generation: self.generation,
                work,
            };
            if let Some(worker) = &self.worker {
                if worker.requests.try_send(job).is_ok() {
                    self.busy = true;
                } else {
                    self.worker = None;
                    self.error = Some("Image worker unavailable; close and /image to retry".into());
                }
            }
            changed = true;
        }
        changed
    }

    pub fn render_image(&mut self, area: Rect, buffer: &mut Buffer) -> bool {
        self.desired_size = Size::new(
            area.width.min(1024 / self.policy.font.width.max(1)),
            area.height.min(1024 / self.policy.font.height.max(1)),
        );
        if area.is_empty() {
            return false;
        }
        if let Some(ready) = &mut self.ready {
            if ready.encoded {
                // Only rendering here: resize/decode/encode belong to the worker.
                ready.protocol.render(area, buffer);
                return true;
            }
        }
        false
    }
}

#[cfg(test)]
pub(crate) mod tests;
