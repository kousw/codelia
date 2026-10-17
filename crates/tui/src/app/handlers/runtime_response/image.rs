use super::formatters::push_rpc_error;
use crate::app::image_preview::Source;
use crate::app::runtime::RpcResponse;
use crate::app::state::LogKind;
use crate::app::AppState;

pub(super) fn model(app: &mut AppState, response: RpcResponse) {
    if let Some(error) = response.error {
        push_rpc_error(app, "image.model", &error);
        return;
    }
    let result = response.result.as_ref();
    let message = result
        .and_then(|v| v.get("message"))
        .and_then(|v| v.as_str())
        .unwrap_or("Image settings response missing status.");
    let unavailable =
        result.and_then(|v| v.get("state")).and_then(|v| v.as_str()) == Some("unavailable");
    app.push_line(
        if unavailable {
            LogKind::Error
        } else {
            LogKind::Status
        },
        message,
    );
}

pub(super) fn artifact(
    app: &mut AppState,
    response: RpcResponse,
    expected: &str,
    preview_revision: u64,
) {
    if app.image_preview.revision() != preview_revision {
        return;
    }
    if let Some(error) = response.error {
        push_rpc_error(app, "image.artifact.get", &error);
        return;
    }
    let result = response.result.as_ref();
    let data = result
        .and_then(|v| v.get("data_url"))
        .and_then(|v| v.as_str());
    let id = result
        .and_then(|v| v.get("metadata"))
        .and_then(|v| v.get("artifact_id"))
        .and_then(|v| v.as_str());
    let media_type = result
        .and_then(|v| v.get("metadata"))
        .and_then(|v| v.get("media_type"))
        .and_then(|v| v.as_str())
        .unwrap_or("image/png");
    let Some(data) = data.filter(|d| {
        matches!(
            media_type,
            "image/png" | "image/jpeg" | "image/webp" | "image/gif"
        ) && d.starts_with(&format!("data:{media_type};base64,"))
            && d.len() <= 12 * 1024 * 1024
            && id == Some(expected)
    }) else {
        app.push_line(
            LogKind::Error,
            "Invalid, mismatched or oversized image artifact preview response.",
        );
        return;
    };
    if app.has_interaction_panel() {
        app.push_line(LogKind::Status, "Image received while another dialog is active; use /image-artifact again after closing it.");
        return;
    }
    app.clear_text_selection();
    app.image_preview.open(Source::Attachment {
        id: expected.to_string(),
        data_url: data.into(),
    });
    app.push_line(LogKind::Status, format!("Previewing image artifact {expected}. Original remains on the runtime host; no local path was inferred."));
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::app::handlers::image_preview::{handle_command, preview_composer_image};
    use crate::app::{PendingImageArtifactRequest, PendingImageAttachment, PendingRpcMatch};
    use crossterm::event::{KeyCode, KeyModifiers};
    use serde_json::json;

    fn begin_artifact_request(app: &mut AppState) {
        app.rpc_pending.image_artifact_id = Some(PendingImageArtifactRequest {
            request_id: "request".into(),
            artifact_id: "expected".into(),
            preview_revision: app.image_preview.revision(),
        });
    }

    fn deliver_artifact_response(app: &mut AppState) {
        deliver_response(
            app,
            RpcResponse {
                id: "request".into(),
                error: None,
                result: Some(json!({
                    "metadata": {"artifact_id": "expected"},
                    "data_url": "data:image/png;base64,AAAA"
                })),
            },
        );
    }

    fn deliver_response(app: &mut AppState, response: RpcResponse) {
        let pending = app
            .rpc_pending
            .take_match_for_response(&response.id)
            .unwrap();
        let PendingRpcMatch::ImageArtifact {
            artifact_id,
            preview_revision,
        } = pending
        else {
            panic!("Expected image artifact request");
        };
        artifact(app, response, &artifact_id, preview_revision);
        assert!(app.rpc_pending.image_artifact_id.is_none());
    }

    #[test]
    fn late_artifact_response_preserves_newer_local_preview_open_or_closed() {
        for close in [false, true] {
            let mut app = AppState::default();
            begin_artifact_request(&mut app);
            handle_command(&mut app, "newer.png");
            if close {
                app.image_preview
                    .handle_key(KeyCode::Char('q'), KeyModifiers::NONE);
            }
            let label = app.image_preview.label.clone();
            let log_len = app.log.len();
            deliver_artifact_response(&mut app);
            assert_eq!(app.image_preview.is_open(), !close);
            assert_eq!(app.image_preview.label, label);
            assert_eq!(app.log.len(), log_len);
        }
    }

    #[test]
    fn late_artifact_response_preserves_reopened_retained_preview() {
        let mut app = AppState::default();
        handle_command(&mut app, "retained.png");
        app.image_preview.close();
        begin_artifact_request(&mut app);
        handle_command(&mut app, "");
        deliver_artifact_response(&mut app);
        assert!(app.image_preview.is_open());
        assert_eq!(app.image_preview.label, "Local: retained.png");
    }

    #[test]
    fn late_artifact_response_does_not_undo_preview_dismissal() {
        for (key, modifiers) in [
            (KeyCode::Esc, KeyModifiers::NONE),
            (KeyCode::Char('q'), KeyModifiers::NONE),
            (KeyCode::Char('c'), KeyModifiers::CONTROL),
        ] {
            let mut app = AppState::default();
            handle_command(&mut app, "retained.png");
            begin_artifact_request(&mut app);
            app.image_preview.handle_key(key, modifiers);
            deliver_artifact_response(&mut app);
            assert!(!app.image_preview.is_open());
            assert_eq!(app.image_preview.label, "Local: retained.png");
        }
    }

    #[test]
    fn late_artifact_response_preserves_newer_composer_preview() {
        let mut app = AppState::default();
        app.pending_image_attachments.insert(
            "composer-image".into(),
            PendingImageAttachment {
                data_url: "data:image/png;base64,AAAA".into(),
                width: 1,
                height: 1,
                encoded_bytes: 3,
            },
        );
        let token = crate::app::util::attachments::make_attachment_token(
            &app.composer_nonce,
            "composer-image",
        );
        app.input.insert_str(&token);
        let input = app.input.current();
        begin_artifact_request(&mut app);
        preview_composer_image(&mut app);
        deliver_artifact_response(&mut app);
        assert_eq!(app.image_preview.label, "Attachment composer-image");
        assert_eq!(app.input.current(), input);
        assert_eq!(app.pending_image_attachments.len(), 1);
    }

    #[test]
    fn invalid_local_preview_command_does_not_supersede_artifact_request() {
        let mut app = AppState::default();
        begin_artifact_request(&mut app);
        handle_command(&mut app, "two paths.png");
        deliver_artifact_response(&mut app);
        assert!(app.image_preview.is_open());
        assert_eq!(app.image_preview.label, "Attachment expected");
    }

    #[test]
    fn absent_retained_or_composer_image_does_not_supersede_artifact_request() {
        let mut app = AppState::default();
        begin_artifact_request(&mut app);
        handle_command(&mut app, "");
        preview_composer_image(&mut app);
        deliver_artifact_response(&mut app);
        assert!(app.image_preview.is_open());
        assert_eq!(app.image_preview.label, "Attachment expected");
    }

    #[test]
    fn artifact_errors_are_shown_only_for_current_preview_intent() {
        for superseded in [false, true] {
            let mut app = AppState::default();
            begin_artifact_request(&mut app);
            if superseded {
                handle_command(&mut app, "newer.png");
            }
            let log_len = app.log.len();
            deliver_response(
                &mut app,
                RpcResponse {
                    id: "request".into(),
                    error: Some(json!({"code": -32603, "message": "fixture artifact error"})),
                    result: None,
                },
            );
            if superseded {
                assert_eq!(app.log.len(), log_len);
            } else {
                assert!(app.log[log_len..].iter().any(|line| {
                    line.kind() == LogKind::Error
                        && line.plain_text().contains("fixture artifact error")
                }));
            }
            assert_eq!(app.image_preview.is_open(), superseded);
        }
    }

    #[test]
    fn late_artifact_response_cannot_restore_forgotten_preview() {
        let mut app = AppState::default();
        handle_command(&mut app, "retained.png");
        begin_artifact_request(&mut app);
        app.image_preview.forget();
        deliver_artifact_response(&mut app);
        assert!(!app.image_preview.is_open());
        assert!(!app.image_preview.reopen());
        assert!(app.image_preview.label.is_empty());
    }

    #[test]
    fn artifact_transport_never_opens_runtime_paths_or_remote_urls() {
        let mut app = AppState::default();
        for data in [
            "https://example.test/image.png",
            "/tmp/remote.png",
            "data:image/jpeg;base64,AAAA",
        ] {
            let revision = app.image_preview.revision();
            artifact(
                &mut app,
                RpcResponse {
                    id: "request".into(),
                    error: None,
                    result: Some(json!({"metadata":{"artifact_id":"expected"},"data_url":data})),
                },
                "expected",
                revision,
            );
            assert!(!app.image_preview.is_open());
        }
    }

    #[test]
    fn attachment_artifacts_accept_matching_inline_mime_only() {
        for media_type in ["image/png", "image/jpeg", "image/webp", "image/gif"] {
            let mut app = AppState::default();
            let revision = app.image_preview.revision();
            artifact(
                &mut app,
                RpcResponse {
                    id: "request".into(),
                    error: None,
                    result: Some(
                        json!({"metadata":{"artifact_id":"expected","media_type":media_type},"data_url":format!("data:{media_type};base64,AAAA")}),
                    ),
                },
                "expected",
                revision,
            );
            assert!(app.image_preview.is_open());
        }
    }
}
