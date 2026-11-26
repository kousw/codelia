use super::{new_composer_nonce, AppState};
use crate::app::state::input::attachments::{
    make_attachment_token, referenced_attachment_ids, token_span, token_spans,
};
use crate::app::state::LogKind;
use crate::app::util::attachments::{
    ImportedBatch, IMPORT_ID_PREFIX, MAX_ATTACHMENT_COUNT, MAX_IMAGE_COUNT, MAX_MESSAGE_BYTES,
};
use std::collections::HashSet;

#[derive(Default)]
struct AttachmentSize {
    files: usize,
    images: usize,
    bytes: usize,
}

impl AttachmentSize {
    fn allows(&self, added: Self) -> bool {
        self.files + added.files <= MAX_ATTACHMENT_COUNT
            && self.images + added.images <= MAX_IMAGE_COUNT
            && self.bytes + added.bytes <= MAX_MESSAGE_BYTES
    }
}

impl AppState {
    fn next_attachment_id(&mut self, prefix: &str) -> String {
        self.next_attachment_id = self.next_attachment_id.saturating_add(1);
        format!("{prefix}{}", self.next_attachment_id)
    }

    pub fn start_clipboard_import(&mut self) {
        let marker = self.next_attachment_id(IMPORT_ID_PREFIX);
        match self
            .clipboard_import
            .start(marker.clone(), self.runtime_info.supports_attachment_upload)
        {
            Ok(()) => self
                .input
                .insert_str(&make_attachment_token(&self.composer_nonce, &marker)),
            Err(error) => self.push_line(LogKind::Status, error.to_string()),
        }
    }

    pub fn poll_clipboard_import(&mut self) -> bool {
        let results = self.clipboard_import.poll();
        let changed = !results.is_empty();
        for (marker, result) in results {
            self.complete_clipboard_import(&marker, result);
        }
        changed
    }

    fn complete_clipboard_import(&mut self, marker: &str, result: Result<ImportedBatch, String>) {
        let Some(range) = token_span(&self.input, &self.composer_nonce, marker) else {
            return;
        };
        let imported = match result {
            Ok(imported) => imported,
            Err(error) => {
                self.input.replace_range(range, "");
                self.push_line(LogKind::Status, format!("Clipboard paste: {error}"));
                return;
            }
        };

        let size = match &imported {
            ImportedBatch::Files(files) => AttachmentSize {
                files: files.len(),
                images: files
                    .iter()
                    .filter(|file| file.dimensions.is_some())
                    .count(),
                bytes: files.iter().map(|file| file.bytes.len()).sum(),
            },
            ImportedBatch::Bitmap(image) => AttachmentSize {
                files: 1,
                images: 1,
                bytes: image.encoded_bytes,
            },
        };
        if !self.composer_attachment_size().allows(size) {
            self.input.replace_range(range, "");
            self.push_line(
                LogKind::Error,
                format!("Clipboard batch exceeds the message limit of {MAX_ATTACHMENT_COUNT} attachments, {MAX_IMAGE_COUNT} images or 64 MiB"),
            );
            return;
        }

        let replacement = match imported {
            ImportedBatch::Files(files) => {
                let mut tokens = String::new();
                for file in files {
                    let id = self.next_attachment_id("file-");
                    tokens.push_str(&make_attachment_token(&self.composer_nonce, &id));
                    self.pending_staged_attachments.insert(id, file);
                }
                tokens
            }
            ImportedBatch::Bitmap(image) => {
                let id = self.next_image_attachment_id();
                let token = make_attachment_token(&self.composer_nonce, &id);
                self.add_pending_image_attachment(id, image);
                token
            }
        };
        self.input.replace_range(range, &replacement);
    }

    pub fn has_pending_clipboard_import(&self) -> bool {
        self.clipboard_import
            .markers()
            .any(|id| token_span(&self.input, &self.composer_nonce, id).is_some())
    }

    pub fn referenced_attachment_ids(&self) -> Vec<String> {
        referenced_attachment_ids(
            &self.input.current(),
            &self.composer_nonce,
            &self.pending_image_attachments,
            &self.pending_staged_attachments,
        )
    }

    pub fn referenced_attachment_count(&self) -> usize {
        self.referenced_attachment_ids().len()
    }

    pub fn next_image_attachment_id(&mut self) -> String {
        self.next_attachment_id("img")
    }

    pub fn add_pending_image_attachment(
        &mut self,
        id: String,
        attachment: super::PendingImageAttachment,
    ) {
        self.pending_image_attachments.insert(id, attachment);
    }

    fn composer_attachment_size(&self) -> AttachmentSize {
        let mut size = AttachmentSize::default();
        for id in self.referenced_attachment_ids() {
            size.files += 1;
            if let Some(file) = self.pending_staged_attachments.get(&id) {
                size.bytes += file.bytes.len();
                size.images += usize::from(file.dimensions.is_some());
            } else if let Some(image) = self.pending_image_attachments.get(&id) {
                size.bytes += image.encoded_bytes;
                size.images += 1;
            }
        }
        size
    }

    pub fn prune_unreferenced_attachments(&mut self) {
        let tokens = token_spans(&self.input, &self.composer_nonce);
        let ids: HashSet<_> = tokens.iter().map(|(id, _)| id.as_str()).collect();
        self.clipboard_import.cancel_missing(|id| ids.contains(id));
        self.pending_image_attachments
            .retain(|id, _| ids.contains(id.as_str()));
        self.pending_staged_attachments
            .retain(|id, _| ids.contains(id.as_str()));
        self.prune_stale_attachment_tokens();
    }

    fn prune_stale_attachment_tokens(&mut self) {
        for (id, range) in token_spans(&self.input, &self.composer_nonce)
            .into_iter()
            .rev()
        {
            if !self.pending_image_attachments.contains_key(&id)
                && !self.pending_staged_attachments.contains_key(&id)
                && !self.clipboard_import.markers().any(|marker| marker == id)
            {
                self.input.replace_range(range, "");
            }
        }
    }

    pub fn discard_composer_attachments(&mut self) {
        self.clipboard_import.cancel_missing(|_| false);
        self.pending_image_attachments.clear();
        self.pending_staged_attachments.clear();
        self.prune_stale_attachment_tokens();
        self.input.history_saved = None;
        self.input.history_index = None;
        self.composer_nonce = new_composer_nonce();
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::app::state::input::attachments::render_input_text_with_attachment_labels;
    use crate::app::util::attachments::StagedAttachment;

    fn complete(app: &mut AppState, marker: &str, name: &str) {
        let file =
            StagedAttachment::from_bytes(name.into(), b"first line".to_vec(), "file").unwrap();
        app.complete_clipboard_import(marker, Ok(ImportedBatch::Files(vec![file])));
    }

    #[test]
    fn ready_batches_keep_marker_order_with_edits_and_reverse_completion() {
        let mut app = AppState::default();
        let first = make_attachment_token(&app.composer_nonce, "paste-1");
        let second = make_attachment_token(&app.composer_nonce, "paste-2");
        app.input.set_from(&format!("left {first} {second} right"));
        app.input.cursor = "left ".len();
        app.input.insert_str("edited ");
        complete(&mut app, "paste-2", "second.txt");
        complete(&mut app, "paste-1", "first.txt");
        let display = render_input_text_with_attachment_labels(
            &app.input.current(),
            &app.composer_nonce,
            &app.pending_image_attachments,
            &app.pending_staged_attachments,
        );
        assert_eq!(display, "left edited [File first.txt · text/plain · 10 B] [File second.txt · text/plain · 10 B] right");
        assert_eq!(app.input.cursor, "left edited ".len());
    }

    #[test]
    fn failed_and_discarded_markers_preserve_draft_text() {
        let mut app = AppState::default();
        let first = make_attachment_token(&app.composer_nonce, "paste-1");
        let second = make_attachment_token(&app.composer_nonce, "paste-2");
        app.input.set_from(&format!("a{first}b{second}c"));
        app.complete_clipboard_import("paste-1", Err("test error".into()));
        assert_eq!(app.input.current(), format!("ab{second}c"));
        app.discard_composer_attachments();
        complete(&mut app, "paste-2", "late.txt");
        assert_eq!(app.input.current(), "abc");
        assert!(app.pending_staged_attachments.is_empty());
    }
}
