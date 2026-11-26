mod clipboard_import;
mod staging;

pub(crate) use clipboard_import::{ClipboardImport, ImportedBatch};
pub(crate) use staging::StagedAttachment;
pub(crate) use staging::{MAX_ATTACHMENT_COUNT, MAX_IMAGE_COUNT, MAX_MESSAGE_BYTES};

pub(crate) const IMPORT_ID_PREFIX: &str = "paste-";
