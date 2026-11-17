use super::staging::{
    file_label, StagedAttachment, MAX_ATTACHMENT_COUNT, MAX_IMAGE_BYTES, MAX_IMAGE_COUNT,
    MAX_MESSAGE_BYTES,
};
use crate::app::util::clipboard::{read_typed_clipboard, ClipboardSource};
use crate::app::PendingImageAttachment;
use std::io;
use std::path::PathBuf;
use std::sync::{
    atomic::{AtomicBool, Ordering},
    mpsc::{self, Receiver, TryRecvError},
    Arc,
};
use std::thread;
use std::time::{Duration, Instant};

const MAX_IMPORTS: usize = 2;
const IMPORT_TIMEOUT: Duration = Duration::from_secs(30);

pub(crate) enum ImportedBatch {
    Files(Vec<StagedAttachment>),
    Bitmap(PendingImageAttachment),
}

type ImportResult = Result<ImportedBatch, String>;

struct ImportJob {
    marker: String,
    cancelled: Arc<AtomicBool>,
    result: Receiver<ImportResult>,
    deadline: Instant,
}

#[derive(Default)]
pub(crate) struct ClipboardImport {
    jobs: Vec<ImportJob>,
}

impl ClipboardImport {
    pub fn start(&mut self, marker: String, supports_upload: bool) -> io::Result<()> {
        if self.jobs.len() >= MAX_IMPORTS {
            return Err(io::Error::other(
                "Two clipboard imports are already in progress",
            ));
        }

        let cancelled = Arc::new(AtomicBool::new(false));
        let active = Arc::clone(&cancelled);
        let (send, result) = mpsc::channel();
        thread::Builder::new()
            .name("codelia-clipboard-import".into())
            .spawn(move || {
                let result = import_clipboard(supports_upload, active.as_ref());
                if !active.load(Ordering::Relaxed) {
                    let _ = send.send(result);
                }
            })?;
        self.jobs.push(ImportJob {
            marker,
            cancelled,
            result,
            deadline: Instant::now() + IMPORT_TIMEOUT,
        });
        Ok(())
    }

    pub fn markers(&self) -> impl Iterator<Item = &str> {
        self.jobs
            .iter()
            .filter(|job| !job.cancelled.load(Ordering::Relaxed))
            .map(|job| job.marker.as_str())
    }

    pub fn cancel_missing(&self, has_marker: impl Fn(&str) -> bool) {
        for job in &self.jobs {
            if !has_marker(&job.marker) {
                job.cancelled.store(true, Ordering::Relaxed);
            }
        }
    }

    pub fn poll(&mut self) -> Vec<(String, ImportResult)> {
        let mut completed = Vec::new();
        self.jobs.retain(|job| {
            let result = match job.result.try_recv() {
                Ok(result) => result,
                Err(TryRecvError::Disconnected) => {
                    Err("Clipboard import stopped unexpectedly".into())
                }
                Err(TryRecvError::Empty) => {
                    if Instant::now() >= job.deadline
                        && !job.cancelled.swap(true, Ordering::Relaxed)
                    {
                        completed
                            .push((job.marker.clone(), Err("Clipboard import timed out".into())));
                    }
                    // Keep the worker slot occupied until a blocked OS read returns.
                    return true;
                }
            };
            if !job.cancelled.load(Ordering::Relaxed) {
                completed.push((job.marker.clone(), result));
            }
            false
        });
        completed
    }
}

impl Drop for ClipboardImport {
    fn drop(&mut self) {
        self.cancel_missing(|_| false);
    }
}

fn import_clipboard(supports_upload: bool, cancelled: &AtomicBool) -> ImportResult {
    match read_typed_clipboard(MAX_IMAGE_BYTES).map_err(|error| error.to_string())? {
        ClipboardSource::Bitmap(bitmap) => Ok(ImportedBatch::Bitmap(bitmap)),
        ClipboardSource::Files(paths) if supports_upload => {
            import_files(paths, cancelled).map(ImportedBatch::Files)
        }
        ClipboardSource::Files(_) => Err(
            "This runtime cannot accept copied files. Update the runtime to attach them.".into(),
        ),
    }
}

fn import_files(
    paths: Vec<PathBuf>,
    cancelled: &AtomicBool,
) -> Result<Vec<StagedAttachment>, String> {
    if paths.len() > MAX_ATTACHMENT_COUNT {
        return Err(format!(
            "Clipboard contains more than {MAX_ATTACHMENT_COUNT} files"
        ));
    }

    let mut files = Vec::with_capacity(paths.len());
    let mut bytes_left = MAX_MESSAGE_BYTES;
    let mut image_count = 0;
    for path in paths {
        if cancelled.load(Ordering::Relaxed) {
            return Err("Paste cancelled".into());
        }
        let file = StagedAttachment::from_file(&path, bytes_left, cancelled)
            .map_err(|error| format!("{}: {error}", file_label(&path)))?;
        bytes_left -= file.bytes.len();
        image_count += usize::from(file.dimensions.is_some());
        if image_count > MAX_IMAGE_COUNT {
            return Err(format!(
                "{}: Only {MAX_IMAGE_COUNT} images can be attached to a message",
                file.display_name
            ));
        }
        files.push(file);
    }
    Ok(files)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;
    use std::time::{SystemTime, UNIX_EPOCH};

    #[test]
    fn copied_bytes_are_immutable_and_failed_batch_is_atomic() {
        let suffix = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap()
            .as_nanos();
        let directory =
            std::env::temp_dir().join(format!("codelia-clipboard-{}-{suffix}", std::process::id()));
        fs::create_dir(&directory).unwrap();
        let path = directory.join("日 report.png");
        let original = b"line one\r\nline two\r\n";
        fs::write(&path, original).unwrap();
        let cancelled = AtomicBool::default();
        let batch = import_files(vec![path.clone()], &cancelled).unwrap();
        let file = &batch[0];
        assert_eq!(file.media_type, "text/plain");
        assert_eq!(file.display_name, "日 report.png");
        assert_eq!(&*file.bytes, original);
        fs::write(&path, [0xFF, 0x00, b'A']).unwrap();
        assert_eq!(&*file.bytes, original);
        assert_ne!(
            import_files(vec![path.clone()], &cancelled).unwrap()[0].sha256,
            file.sha256
        );
        let error = import_files(vec![path, directory.clone()], &cancelled).unwrap_err();
        assert!(error.contains("regular local file"));
        fs::remove_dir_all(directory).unwrap();
    }
}
