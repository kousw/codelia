//! Clipboard file transfer is driven by one acknowledged RPC at a time.
//! Keep the submission in the queue so cancellation and retry own the same snapshot.
use super::prompt;
use crate::app::runtime::{send_request, RpcResponse, RuntimeTx};
use crate::app::state::upload::{PendingUpload, SubmissionFiles, UploadStage};
use crate::app::state::LogKind;
use crate::app::{AppState, PendingPromptRun, PROMPT_DISPATCH_MAX_ATTEMPTS};
use crate::protocol::{
    methods, AttachmentUploadBeginParams, AttachmentUploadChunkParams, AttachmentUploadIdParams,
};
use base64::{engine::general_purpose::STANDARD, Engine};
use serde_json::{json, Value};
use std::time::{Duration, Instant};

fn marker(part: &Value) -> Option<&str> {
    (part["type"] == "staged_attachment")
        .then(|| part["local_id"].as_str())
        .flatten()
}

pub(super) fn snapshot(app: &AppState, input: &Value) -> SubmissionFiles {
    let mut files = SubmissionFiles::new(
        app.runtime_info.attachment_session_epoch,
        app.composer_nonce.clone(),
    );
    for (index, part) in input["parts"].as_array().into_iter().flatten().enumerate() {
        if let Some(id) = marker(part) {
            if let Some(file) = app.pending_staged_attachments.get(id) {
                files.insert_item(index, id.to_owned(), file.clone());
            }
        }
    }
    // Bitmap-only inputs use the legacy image path. Mixed submissions share the byte budget.
    if !files.is_empty() {
        let inline_bytes = input["parts"]
            .as_array()
            .into_iter()
            .flatten()
            .filter_map(|p| {
                p["image_url"]["url"]
                    .as_str()?
                    .split_once(',')
                    .map(|(_, data)| data)
            })
            .map(|data| {
                (data.len() / 4 * 3).saturating_sub(
                    data.bytes()
                        .rev()
                        .take(2)
                        .take_while(|b| *b == b'=')
                        .count(),
                )
            })
            .sum();
        files.set_inline_bytes(inline_bytes);
    }
    files
}

fn pause(app: &mut AppState, seq: u64, message: &str) {
    if let Some(item) = app.pending_prompt_queue.iter_mut().find(|p| p.seq == seq) {
        item.dispatch_attempts = PROMPT_DISPATCH_MAX_ATTEMPTS;
        let id = item.queue_id.clone();
        app.push_line(
            LogKind::Error,
            format!("Paused {id}: {message}. Use /queue retry or /queue cancel {id}."),
        );
    }
}

fn cancel(tx: &mut dyn RuntimeTx, upload: Option<&str>) {
    if let Some(id) = upload {
        let params = AttachmentUploadIdParams {
            upload_id: id.to_owned(),
        };
        let id = tx.next_id();
        let _ = send_request::<methods::AttachmentUploadCancel>(tx, &id, &params);
    }
}

enum UploadRequest {
    Begin(AttachmentUploadBeginParams),
    Chunk(AttachmentUploadChunkParams),
    Finish(AttachmentUploadIdParams),
}

fn request(
    app: &mut AppState,
    tx: &mut dyn RuntimeTx,
    pending: PendingUpload,
    request: UploadRequest,
) {
    let id = pending.request_id().to_owned();
    let sent = match &request {
        UploadRequest::Begin(params) => {
            send_request::<methods::AttachmentUploadBegin>(tx, &id, params)
        }
        UploadRequest::Chunk(params) => {
            send_request::<methods::AttachmentUploadChunk>(tx, &id, params)
        }
        UploadRequest::Finish(params) => {
            send_request::<methods::AttachmentUploadFinish>(tx, &id, params)
        }
    };
    if let Err(error) = sent {
        pause(app, pending.seq(), &error.to_string());
    } else {
        app.rpc_pending.set_upload(pending);
    }
}

fn eligible(app: &AppState, item: &PendingPromptRun) -> bool {
    item.dispatch_attempts < PROMPT_DISPATCH_MAX_ATTEMPTS
        && item.files.epoch() == app.runtime_info.attachment_session_epoch
}

// None delegates to ordinary run.start dispatch. Some(false) waits for a gate.
pub fn drive(app: &mut AppState, tx: &mut dyn RuntimeTx) -> Option<bool> {
    if let Some(p) = app.rpc_pending.upload() {
        if p.elapsed() >= Duration::from_secs(30) {
            let p = app.rpc_pending.take_upload().unwrap();
            cancel(tx, p.upload_id());
            pause(app, p.seq(), "attachment upload timed out");
            return Some(true);
        }
        return Some(false);
    }

    let current = app.runtime_info.active_run_id.clone();
    let running = app.is_running();
    for item in &mut app.pending_prompt_queue {
        if item.files.steer_target.is_some() && (item.files.steer_target != current || !running) {
            item.files.steer_target = None;
        }
    }
    let pos = if app.is_running() {
        app.pending_prompt_queue
            .iter()
            .position(|p| p.files.steer_target.is_some())?
    } else {
        if !prompt::can_dispatch_prompt_now(app) || app.dispatching_prompt.is_some() {
            return None;
        }
        0
    };
    let item = app.pending_prompt_queue.get(pos)?;
    if item.files.is_empty() && item.files.steer_target.is_none() {
        return None;
    }
    if !eligible(app, item) {
        if item.dispatch_attempts < PROMPT_DISPATCH_MAX_ATTEMPTS {
            pause(
                app,
                item.seq,
                "session changed; cancel and paste again in the intended session",
            );
            return Some(true);
        }
        return Some(false);
    }
    let local = item.input_payload["parts"]
        .as_array()
        .and_then(|parts| parts.iter().find_map(marker));
    let Some(local) = local else {
        if let Some(run_id) = item.files.steer_target.clone() {
            let mut item = app.pending_prompt_queue.remove(pos).unwrap();
            item.files.steer_target = None;
            prompt::send_ready_steer(app, tx, &run_id, item);
            return Some(true);
        }
        return None;
    };
    let seq = item.seq;
    let Some(limits) = app
        .runtime_info
        .attachment_upload_limits
        .as_ref()
        .filter(|_| app.runtime_info.supports_attachment_upload)
    else {
        pause(app, seq, "runtime does not accept pasted files");
        return Some(true);
    };
    let Some(file) = item.files.items().get(local) else {
        pause(app, seq, "staged file is unavailable");
        return Some(true);
    };
    if limits.max_chunk_bytes == 0
        || item.attachment_count > limits.max_attachments
        || item
            .files
            .items()
            .values()
            .any(|f| f.bytes.len() > limits.max_file_bytes)
        || item.files.inline_bytes()
            + item
                .files
                .items()
                .values()
                .map(|f| f.bytes.len())
                .sum::<usize>()
            > limits.max_message_bytes
    {
        pause(app, seq, "attachments exceed runtime limits");
        return Some(true);
    }
    let params = AttachmentUploadBeginParams {
        upload_key: format!("{}-{}-{}", item.files.draft_nonce(), seq, local),
        display_name: file.display_name.clone(),
        byte_size: file.bytes.len() as i64,
        sha256: file.sha256.clone(),
        session_id: app.runtime_info.session_id.clone(),
    };
    let pending = PendingUpload::begin(
        tx.next_id(),
        seq,
        local.to_string(),
        limits.max_chunk_bytes.min(256 * 1024),
        Instant::now(),
    );
    request(app, tx, pending, UploadRequest::Begin(params));
    Some(true)
}

/// A decoded acknowledgement for the stage the upload expected.
enum Ack {
    Offset(usize),
    Attachment(String),
}

/// Decodes the result for the expected stage; `None` means it broke the contract.
fn decode_ack(app: &mut AppState, expected: &UploadStage, result: Value) -> Option<Ack> {
    use crate::protocol::decode_result;
    let decoded = match expected {
        UploadStage::Begin => decode_result::<methods::AttachmentUploadBegin>(result)
            .map(|r| usize::try_from(r.offset).ok().map(Ack::Offset)),
        UploadStage::Chunk(_) => decode_result::<methods::AttachmentUploadChunk>(result)
            .map(|r| usize::try_from(r.offset).ok().map(Ack::Offset)),
        UploadStage::Finish => decode_result::<methods::AttachmentUploadFinish>(result)
            .map(|r| Some(Ack::Attachment(r.attachment_id))),
    };
    decoded.unwrap_or_else(|error| {
        app.push_line(LogKind::Error, error.to_string());
        None
    })
}

pub(crate) fn handle_response(
    app: &mut AppState,
    mut p: PendingUpload,
    response: &RpcResponse,
    tx: &mut dyn RuntimeTx,
) {
    let ack = match (&response.error, &response.result) {
        (None, Some(result)) => {
            if matches!(p.stage(), UploadStage::Begin) {
                // Read the id before decoding so a rejected begin is still cancelled.
                p.set_upload_id(
                    result["upload_id"]
                        .as_str()
                        .filter(|s| !s.is_empty())
                        .map(str::to_owned),
                );
            }
            decode_ack(app, p.stage(), result.clone())
        }
        _ => None,
    };
    let Some(pos) = app
        .pending_prompt_queue
        .iter()
        .position(|item| item.seq == p.seq() && eligible(app, item))
    else {
        cancel(tx, p.upload_id());
        return;
    };
    if let Some(error) = &response.error {
        cancel(tx, p.upload_id());
        pause(
            app,
            p.seq(),
            error["message"]
                .as_str()
                .unwrap_or("attachment transfer rejected"),
        );
        return;
    }
    let item = &mut app.pending_prompt_queue[pos];
    if matches!(p.stage(), UploadStage::Finish) {
        if let Some(Ack::Attachment(id)) =
            ack.filter(|ack| matches!(ack, Ack::Attachment(id) if !id.is_empty()))
        {
            if let Some(parts) = item.input_payload["parts"].as_array_mut() {
                for part in parts {
                    if marker(part) == Some(p.local()) {
                        *part = json!({"type":"attachment_ref","attachment_id":id});
                    }
                }
            }
        } else {
            pause(app, p.seq(), "missing attachment reference");
        }
        return;
    }
    let file = &item.files.items()[p.local()];
    let ack = match ack {
        Some(Ack::Offset(n)) => Some(n),
        _ => None,
    }
    .filter(|n| {
        *n <= file.bytes.len()
            && match p.stage() {
                UploadStage::Chunk(end) => *n == *end,
                _ => true,
            }
    });
    let (Some(start), Some(id)) = (ack, p.upload_id().map(str::to_owned)) else {
        cancel(tx, p.upload_id());
        pause(app, p.seq(), "invalid upload acknowledgement");
        return;
    };
    let (next_stage, next) = if start == file.bytes.len() {
        (
            UploadStage::Finish,
            UploadRequest::Finish(AttachmentUploadIdParams { upload_id: id }),
        )
    } else {
        let end = (start + p.chunk_bytes()).min(file.bytes.len());
        (
            UploadStage::Chunk(end),
            UploadRequest::Chunk(AttachmentUploadChunkParams {
                upload_id: id,
                offset: start as i64,
                data: STANDARD.encode(&file.bytes[start..end]),
            }),
        )
    };
    p.advance(next_stage, tx.next_id(), Instant::now());
    request(app, tx, p, next);
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::app::runtime::MockRuntimeTx;
    use crate::app::state::upload::UploadLimits;
    use crate::app::util::attachments::StagedAttachment;

    #[test]
    fn file_steer_finishes_upload_before_text_steer_and_fallback_reuses_reference() {
        let mut app = AppState::default();
        app.runtime_info.supports_attachment_upload = true;
        app.runtime_info.attachment_upload_limits = Some(UploadLimits {
            max_chunk_bytes: 2,
            max_message_bytes: 16,
            max_file_bytes: 16,
            max_attachments: 1,
        });
        app.runtime_info.active_run_id = Some("r1".into());
        app.update_run_status("running".into());
        let file =
            StagedAttachment::from_bytes("data.bin".into(), vec![0xff, 0, 5], "file").unwrap();
        app.pending_staged_attachments.insert("f".into(), file);
        let mut tx = MockRuntimeTx::default();
        let snapshot = |index: u64, input: Value| PendingPromptRun {
            seq: index,
            queue_id: format!("q{index}"),
            queued_at: Instant::now(),
            preview: String::new(),
            user_text: String::new(),
            display_text: String::new(),
            image_descriptions: vec![],
            files: snapshot(&app, &input),
            input_payload: input,
            attachment_count: 1,
            shell_result_count: 0,
            dispatch_attempts: 0,
        };
        let mut first = snapshot(
            1,
            json!({"type":"parts","parts":[{"type":"staged_attachment","local_id":"f"}]}),
        );
        let mut second = snapshot(2, json!({"type":"text","text":"second"}));
        first.files.steer_target = Some("r1".into());
        second.files.steer_target = Some("r1".into());
        app.pending_prompt_queue.extend([first, second]);
        app.clear_composer();
        assert_eq!(drive(&mut app, &mut tx), Some(true));
        let mut methods = vec![];
        for (expected_method, result, expected_bytes) in [
            (
                "attachment.upload.begin",
                json!({"upload_id":"u","offset":0}),
                None,
            ),
            (
                "attachment.upload.chunk",
                json!({"offset":2}),
                Some(vec![0xff, 0]),
            ),
            (
                "attachment.upload.chunk",
                json!({"offset":3}),
                Some(vec![5]),
            ),
            (
                "attachment.upload.finish",
                json!({"attachment_id":"a"}),
                None,
            ),
        ] {
            let rpc = tx.sent.last().unwrap();
            assert_eq!(rpc["method"], expected_method);
            if let Some(bytes) = expected_bytes {
                assert_eq!(
                    STANDARD
                        .decode(rpc["params"]["data"].as_str().unwrap())
                        .unwrap(),
                    bytes
                );
            }
            let response = RpcResponse {
                id: rpc["id"].as_str().unwrap().into(),
                result: Some(result),
                error: None,
            };
            assert_eq!(drive(&mut app, &mut tx), Some(false));
            let pending = match app.rpc_pending.take(&response.id) {
                Some(crate::app::PendingRpc::Upload(pending)) => pending,
                other => panic!("expected pending upload, got {other:?}"),
            };
            handle_response(&mut app, pending, &response, &mut tx);
        }
        for _ in 0..2 {
            assert_eq!(drive(&mut app, &mut tx), Some(true));
            let rpc = tx.sent.last().unwrap();
            assert_eq!(rpc["method"], "run.steer");
            methods.push(rpc["params"]["input"].clone());
        }
        assert_eq!(
            methods[0]["parts"][0],
            json!({"type":"attachment_ref","attachment_id":"a"})
        );
        assert_eq!(methods[1]["text"], "second");
        let mut fallback = app.in_flight_steers.pop_front().unwrap().submission;
        fallback.files.steer_target = Some("r1".into());
        app.pending_prompt_queue.push_front(fallback);
        app.runtime_info.active_run_id = None;
        app.update_run_status("completed".into());
        assert!(prompt::try_dispatch_queued_prompt(&mut app, &mut tx));
        let rpc = tx.sent.last().unwrap();
        assert_eq!(rpc["method"], "run.start");
        assert_eq!(rpc["params"]["input"], methods[0]);
        assert_eq!(tx.sent.len(), 7);
    }

    #[test]
    fn upload_send_failure_pauses_item_without_leaving_pending_upload() {
        let mut app = AppState::default();
        app.runtime_info.supports_attachment_upload = true;
        app.runtime_info.attachment_upload_limits = Some(UploadLimits {
            max_chunk_bytes: 16,
            max_message_bytes: 64,
            max_file_bytes: 64,
            max_attachments: 1,
        });
        let file = StagedAttachment::from_bytes("a.txt".into(), b"hello".to_vec(), "file").unwrap();
        app.pending_staged_attachments.insert("f".into(), file);
        let input = json!({"type":"parts","parts":[{"type":"staged_attachment","local_id":"f"}]});
        let files = snapshot(&app, &input);
        app.pending_prompt_queue.push_back(PendingPromptRun {
            seq: 1,
            queue_id: "q1".into(),
            queued_at: Instant::now(),
            preview: String::new(),
            user_text: String::new(),
            display_text: String::new(),
            image_descriptions: vec![],
            files,
            input_payload: input,
            attachment_count: 1,
            shell_result_count: 0,
            dispatch_attempts: 0,
        });
        let mut tx = MockRuntimeTx::default();
        tx.fail_next = Some(std::io::ErrorKind::BrokenPipe);

        assert_eq!(drive(&mut app, &mut tx), Some(true));
        assert!(app.rpc_pending.upload().is_none());
        assert_eq!(
            app.pending_prompt_queue.front().unwrap().dispatch_attempts,
            PROMPT_DISPATCH_MAX_ATTEMPTS
        );
        assert!(tx.sent.is_empty());
    }
}
