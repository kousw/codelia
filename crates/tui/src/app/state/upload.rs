use crate::app::util::attachments::StagedAttachment;
use serde_json::{json, Value};
use std::collections::HashMap;
use std::time::{Duration, Instant};

#[derive(Debug)]
pub(crate) struct UploadLimits {
    pub(crate) max_chunk_bytes: usize,
    pub(crate) max_file_bytes: usize,
    pub(crate) max_attachments: usize,
    pub(crate) max_message_bytes: usize,
}

impl UploadLimits {
    /// Limits advertised in `initialize`; negative values disable uploads.
    pub(crate) fn from_wire(limits: &crate::protocol::AttachmentUploadLimits) -> Option<Self> {
        Some(Self {
            max_chunk_bytes: usize::try_from(limits.max_chunk_bytes).ok()?,
            max_file_bytes: usize::try_from(limits.max_file_bytes).ok()?,
            max_attachments: usize::try_from(limits.max_attachments).ok()?,
            max_message_bytes: usize::try_from(limits.max_message_bytes).ok()?,
        })
    }
}

#[derive(Clone, Debug, Default)]
pub(crate) struct SubmissionFiles {
    items: HashMap<String, StagedAttachment>,
    pub(crate) steer_target: Option<String>,
    epoch: u64,
    draft_nonce: String,
    // Only the occupied part positions are needed to retry a lost reference.
    positions: Vec<(usize, String)>,
    inline_bytes: usize,
}

impl SubmissionFiles {
    pub(crate) fn new(epoch: u64, draft_nonce: String) -> Self {
        Self {
            epoch,
            draft_nonce,
            ..Self::default()
        }
    }

    pub(crate) fn insert_item(&mut self, position: usize, id: String, file: StagedAttachment) {
        self.items.insert(id.clone(), file);
        self.positions.push((position, id));
    }

    pub(crate) fn set_inline_bytes(&mut self, bytes: usize) {
        self.inline_bytes = bytes;
    }

    pub(crate) fn items(&self) -> &HashMap<String, StagedAttachment> {
        &self.items
    }

    pub(crate) fn is_empty(&self) -> bool {
        self.items.is_empty()
    }

    pub(crate) fn epoch(&self) -> u64 {
        self.epoch
    }

    pub(crate) fn draft_nonce(&self) -> &str {
        &self.draft_nonce
    }

    pub(crate) fn inline_bytes(&self) -> usize {
        self.inline_bytes
    }

    pub(crate) fn belongs_to_session(&self, epoch: u64) -> bool {
        self.items.is_empty() || self.epoch == epoch
    }

    pub(crate) fn retry(&self, input: &mut Value) {
        if let Some(parts) = input["parts"].as_array_mut() {
            for (idx, id) in &self.positions {
                if let Some(slot) = parts.get_mut(*idx) {
                    *slot = json!({"type":"staged_attachment","local_id":id});
                }
            }
        }
    }
}

#[derive(Debug)]
pub(crate) enum UploadStage {
    Begin,
    Chunk(usize),
    Finish,
}

#[derive(Debug)]
pub(crate) struct PendingUpload {
    request: String,
    sent: Instant,
    seq: u64,
    local: String,
    upload: Option<String>,
    stage: UploadStage,
    chunk_bytes: usize,
}

impl PendingUpload {
    pub(crate) fn begin(
        request: String,
        seq: u64,
        local: String,
        chunk_bytes: usize,
        sent: Instant,
    ) -> Self {
        Self {
            request,
            sent,
            seq,
            local,
            upload: None,
            stage: UploadStage::Begin,
            chunk_bytes,
        }
    }

    pub(crate) fn request_id(&self) -> &str {
        &self.request
    }

    pub(crate) fn elapsed(&self) -> Duration {
        self.sent.elapsed()
    }

    pub(crate) fn seq(&self) -> u64 {
        self.seq
    }

    pub(crate) fn local(&self) -> &str {
        &self.local
    }

    pub(crate) fn upload_id(&self) -> Option<&str> {
        self.upload.as_deref()
    }

    pub(crate) fn set_upload_id(&mut self, upload_id: Option<String>) {
        self.upload = upload_id;
    }

    pub(crate) fn stage(&self) -> &UploadStage {
        &self.stage
    }

    pub(crate) fn chunk_bytes(&self) -> usize {
        self.chunk_bytes
    }

    pub(crate) fn advance(&mut self, stage: UploadStage, request: String, sent: Instant) {
        self.stage = stage;
        self.request = request;
        self.sent = sent;
    }
}
