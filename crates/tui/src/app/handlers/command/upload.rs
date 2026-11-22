//! Clipboard file transfer is driven by one acknowledged RPC at a time.
//! Keep the submission in the queue so cancellation and retry own the same snapshot.
use super::{prompt, RuntimeStdin};
use crate::app::runtime::{send_rpc_request, RpcResponse};
use crate::app::state::LogKind;
use crate::app::util::attachments::StagedAttachment;
use crate::app::{AppState, PendingPromptRun, PROMPT_DISPATCH_MAX_ATTEMPTS};
use base64::{engine::general_purpose::STANDARD, Engine};
use serde::Deserialize;
use serde_json::{json, Value};
use std::collections::HashMap;
use std::time::{Duration, Instant};

#[derive(Debug, Deserialize)]
pub struct UploadLimits {
    max_chunk_bytes: usize,
    max_file_bytes: usize,
    max_attachments: usize,
    max_message_bytes: usize,
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
pub struct SubmissionFiles {
    pub items: HashMap<String, StagedAttachment>,
    pub steer_target: Option<String>,
    epoch: u64,
    draft_nonce: String,
    // Only the occupied part positions are needed to retry a lost reference.
    positions: Vec<(usize, String)>,
    inline_bytes: usize,
}

fn marker(part: &Value) -> Option<&str> {
    (part["type"] == "staged_attachment")
        .then(|| part["local_id"].as_str())
        .flatten()
}

impl SubmissionFiles {
    pub fn snapshot(app: &AppState, input: &Value) -> Self {
        let mut files = Self {
            epoch: app.runtime_info.attachment_session_epoch,
            draft_nonce: app.composer_nonce.clone(),
            ..Default::default()
        };
        for (index, part) in input["parts"].as_array().into_iter().flatten().enumerate() {
            if let Some(id) = marker(part) {
                if let Some(file) = app.pending_staged_attachments.get(id) {
                    files.items.insert(id.to_owned(), file.clone());
                    files.positions.push((index, id.to_owned()));
                }
            }
        }
        // Bitmap-only inputs use the legacy image path. Mixed submissions share the byte budget.
        if !files.items.is_empty() {
            files.inline_bytes = input["parts"]
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
        }
        files
    }
    pub fn belongs_to_session(&self, epoch: u64) -> bool {
        self.items.is_empty() || self.epoch == epoch
    }

    pub fn retry(&self, input: &mut Value) {
        if let Some(parts) = input["parts"].as_array_mut() {
            for (idx, id) in &self.positions {
                parts[*idx] = json!({"type":"staged_attachment","local_id":id});
            }
        }
    }
}

#[derive(Debug)]
enum Expected {
    Begin,
    Chunk(usize),
    Finish,
}

#[derive(Debug)]
pub struct PendingUpload {
    request: String,
    sent: Instant,
    seq: u64,
    local: String,
    upload: Option<String>,
    expected: Expected,
    chunk_bytes: usize,
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

fn cancel(writer: &mut RuntimeStdin, next_id: &mut impl FnMut() -> String, upload: Option<&str>) {
    if let Some(id) = upload {
        let _ = send_rpc_request(
            writer,
            &next_id(),
            "attachment.upload.cancel",
            json!({"upload_id":id}),
        );
    }
}

fn request(
    app: &mut AppState,
    writer: &mut RuntimeStdin,
    pending: PendingUpload,
    method: &str,
    params: Value,
) {
    if let Err(error) = send_rpc_request(writer, &pending.request, method, params) {
        pause(app, pending.seq, &error.to_string());
    } else {
        app.rpc_pending.upload = Some(pending);
    }
}

fn eligible(app: &AppState, item: &PendingPromptRun) -> bool {
    item.dispatch_attempts < PROMPT_DISPATCH_MAX_ATTEMPTS
        && item.files.epoch == app.runtime_info.attachment_session_epoch
}

// None delegates to ordinary run.start dispatch. Some(false) waits for a gate.
pub fn drive(
    app: &mut AppState,
    writer: &mut RuntimeStdin,
    next_id: &mut impl FnMut() -> String,
) -> Option<bool> {
    if let Some(p) = &app.rpc_pending.upload {
        if p.sent.elapsed() >= Duration::from_secs(30) {
            let p = app.rpc_pending.upload.take().unwrap();
            cancel(writer, next_id, p.upload.as_deref());
            pause(app, p.seq, "attachment upload timed out");
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
    if item.files.items.is_empty() && item.files.steer_target.is_none() {
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
            prompt::send_ready_steer(app, writer, next_id, &run_id, item);
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
    let Some(file) = item.files.items.get(local) else {
        pause(app, seq, "staged file is unavailable");
        return Some(true);
    };
    if limits.max_chunk_bytes == 0
        || item.attachment_count > limits.max_attachments
        || item
            .files
            .items
            .values()
            .any(|f| f.bytes.len() > limits.max_file_bytes)
        || item.files.inline_bytes
            + item
                .files
                .items
                .values()
                .map(|f| f.bytes.len())
                .sum::<usize>()
            > limits.max_message_bytes
    {
        pause(app, seq, "attachments exceed runtime limits");
        return Some(true);
    }
    let mut params = json!({
        "upload_key":format!("{}-{}-{}", item.files.draft_nonce, seq, local),
        "display_name":file.display_name, "byte_size":file.bytes.len(), "sha256":file.sha256
    });
    if let Some(session) = &app.runtime_info.session_id {
        params["session_id"] = json!(session);
    }
    let pending = PendingUpload {
        seq,
        local: local.to_string(),
        request: next_id(),
        sent: Instant::now(),
        upload: None,
        expected: Expected::Begin,
        chunk_bytes: limits.max_chunk_bytes.min(256 * 1024),
    };
    request(app, writer, pending, "attachment.upload.begin", params);
    Some(true)
}

fn offset(result: &Value) -> Option<usize> {
    usize::try_from(result["offset"].as_u64()?).ok()
}

pub fn handle_response(
    app: &mut AppState,
    response: &RpcResponse,
    writer: &mut RuntimeStdin,
    next_id: &mut impl FnMut() -> String,
) -> bool {
    if !app
        .rpc_pending
        .upload
        .as_ref()
        .is_some_and(|p| p.request == response.id)
    {
        return false;
    }
    let mut p = app.rpc_pending.upload.take().unwrap();
    let result = response.result.as_ref().unwrap_or(&Value::Null);
    if matches!(p.expected, Expected::Begin) {
        p.upload = result["upload_id"]
            .as_str()
            .filter(|s| !s.is_empty())
            .map(str::to_owned);
    }
    let Some(pos) = app
        .pending_prompt_queue
        .iter()
        .position(|item| item.seq == p.seq && eligible(app, item))
    else {
        cancel(writer, next_id, p.upload.as_deref());
        return true;
    };
    if let Some(error) = &response.error {
        cancel(writer, next_id, p.upload.as_deref());
        pause(
            app,
            p.seq,
            error["message"]
                .as_str()
                .unwrap_or("attachment transfer rejected"),
        );
        return true;
    }
    let item = &mut app.pending_prompt_queue[pos];
    if matches!(p.expected, Expected::Finish) {
        if let Some(id) = result["attachment_id"].as_str().filter(|s| !s.is_empty()) {
            if let Some(parts) = item.input_payload["parts"].as_array_mut() {
                for part in parts {
                    if marker(part) == Some(&p.local) {
                        *part = json!({"type":"attachment_ref","attachment_id":id});
                    }
                }
            }
        } else {
            pause(app, p.seq, "missing attachment reference");
        }
        return true;
    }
    let file = &item.files.items[&p.local];
    let ack = offset(result).filter(|n| {
        *n <= file.bytes.len()
            && match p.expected {
                Expected::Chunk(end) => *n == end,
                _ => true,
            }
    });
    let (Some(start), Some(id)) = (ack, p.upload.as_ref()) else {
        cancel(writer, next_id, p.upload.as_deref());
        pause(app, p.seq, "invalid upload acknowledgement");
        return true;
    };
    let (method, params) = if start == file.bytes.len() {
        p.expected = Expected::Finish;
        ("attachment.upload.finish", json!({"upload_id":id}))
    } else {
        let end = (start + p.chunk_bytes).min(file.bytes.len());
        p.expected = Expected::Chunk(end);
        (
            "attachment.upload.chunk",
            json!({"upload_id":id,"offset":start,"data":STANDARD.encode(&file.bytes[start..end])}),
        )
    };
    p.sent = Instant::now();
    p.request = next_id();
    request(app, writer, p, method, params);
    true
}

#[cfg(all(test, unix))]
mod tests {
    use super::*;
    use std::io::{BufRead, BufReader, BufWriter};
    use std::process::{Command, Stdio};

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
        let mut child = Command::new("cat")
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .spawn()
            .unwrap();
        let mut writer = BufWriter::new(child.stdin.take().unwrap());
        let mut output = BufReader::new(child.stdout.take().unwrap()).lines();
        let mut seq = 0;
        let mut next_id = || {
            seq += 1;
            seq.to_string()
        };
        let mut next_rpc =
            || serde_json::from_str::<Value>(&output.next().unwrap().unwrap()).unwrap();
        let snapshot = |index: u64, input: Value| PendingPromptRun {
            seq: index,
            queue_id: format!("q{index}"),
            queued_at: Instant::now(),
            preview: String::new(),
            user_text: String::new(),
            display_text: String::new(),
            image_descriptions: vec![],
            files: SubmissionFiles::snapshot(&app, &input),
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
        assert_eq!(drive(&mut app, &mut writer, &mut next_id), Some(true));
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
            let rpc = next_rpc();
            assert_eq!(rpc["method"], expected_method);
            if let Some(bytes) = expected_bytes {
                assert_eq!(
                    STANDARD
                        .decode(rpc["params"]["data"].as_str().unwrap())
                        .unwrap(),
                    bytes
                );
            }
            assert_eq!(drive(&mut app, &mut writer, &mut next_id), Some(false));
            let response = RpcResponse {
                id: rpc["id"].as_str().unwrap().into(),
                result: Some(result),
                error: None,
            };
            assert!(handle_response(
                &mut app,
                &response,
                &mut writer,
                &mut next_id
            ));
        }
        for _ in 0..2 {
            assert_eq!(drive(&mut app, &mut writer, &mut next_id), Some(true));
            let rpc = next_rpc();
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
        assert!(prompt::try_dispatch_queued_prompt(
            &mut app,
            &mut writer,
            &mut next_id
        ));
        let rpc = next_rpc();
        assert_eq!(rpc["method"], "run.start");
        assert_eq!(rpc["params"]["input"], methods[0]);
        drop(writer);
        assert!(child.wait().unwrap().success());
    }
}
