use super::*;
use crate::app::{
    handlers, render::frame::draw_frame, state::LogKind, AppState, PendingImageAttachment,
};
use base64::Engine;
use image::{DynamicImage, ImageFormat, RgbaImage};
use ratatui::{backend::TestBackend, Terminal};
use std::{
    io::Cursor,
    thread,
    time::{Duration, Instant},
};

fn png(width: u32, height: u32) -> Vec<u8> {
    let mut bytes = Cursor::new(Vec::new());
    DynamicImage::ImageRgba8(RgbaImage::from_pixel(
        width,
        height,
        image::Rgba([230, 70, 30, 255]),
    ))
    .write_to(&mut bytes, ImageFormat::Png)
    .unwrap();
    bytes.into_inner()
}

pub(crate) fn source(id: &str, width: u32, height: u32) -> Source {
    Source::Attachment {
        id: id.into(),
        data_url: format!(
            "data:image/png;base64,{}",
            base64::engine::general_purpose::STANDARD.encode(png(width, height))
        )
        .into(),
    }
}

pub(crate) fn settle(preview: &mut ImagePreview) {
    let until = Instant::now() + Duration::from_secs(5);
    loop {
        preview.poll();
        if !preview.busy && preview.pending.is_none() {
            return;
        }
        assert!(Instant::now() < until, "worker did not settle");
        thread::sleep(Duration::from_millis(2));
    }
}

fn buffer_text(terminal: &Terminal<TestBackend>) -> String {
    terminal
        .backend()
        .buffer()
        .content
        .iter()
        .map(|cell| cell.symbol())
        .collect()
}

fn draw_ready(terminal: &mut Terminal<TestBackend>, app: &mut AppState, inline: bool) {
    draw_frame(terminal, app, inline).unwrap();
    settle(&mut app.image_preview);
    draw_frame(terminal, app, inline).unwrap();
}

#[test]
fn bounded_decoder_rejects_invalid_input_and_never_upscales_small_sources() {
    let (image, width, height) = decode::decode(&png(2, 3)).unwrap();
    assert_eq!((width, height, image.width(), image.height()), (2, 3, 2, 3));
    let (image, _, _) = decode::decode(&png(1100, 550)).unwrap();
    assert_eq!((image.width(), image.height()), (1024, 512));
    for dimensions in [(0, 1), (1, 0), (4097, 1), (1, 4097)] {
        assert!(decode::validate_dimensions(dimensions.0, dimensions.1).is_err());
    }
    assert!(decode::decode(b"not an image").is_err());
    assert!(decode::decode(&vec![0; decode::MAX_FILE_BYTES as usize + 1]).is_err());
    assert_eq!(
        decode::safe_label("x\x1b\n\u{202e}y"),
        "x\\u{1b}\\n\\u{202e}y"
    );
}

#[test]
fn query_free_policy_requires_explicit_safe_kitty_environment() {
    let font = Some(ratatui_image::FontSize::new(8, 16));
    assert!(PreviewPolicy::resolve(None, true, false, font)
        .kitty_id
        .is_none());
    assert!(PreviewPolicy::resolve(Some("kitty"), false, false, font)
        .kitty_id
        .is_none());
    assert!(PreviewPolicy::resolve(Some("kitty"), true, true, font)
        .kitty_id
        .is_none());
    assert!(PreviewPolicy::resolve(Some("kitty"), true, false, None)
        .kitty_id
        .is_none());
    assert!(PreviewPolicy::resolve(
        Some("kitty"),
        true,
        false,
        Some(ratatui_image::FontSize::new(0, 16))
    )
    .kitty_id
    .is_none());
    let native = PreviewPolicy::resolve(Some("kitty"), true, false, font);
    assert!(native.kitty_id.is_some());
    assert_eq!(
        native.kitty_id,
        PreviewPolicy::resolve(Some("kitty"), true, false, font).kitty_id
    );
    assert!(PreviewPolicy::resolve(Some("invalid"), true, false, font)
        .label
        .contains("unknown"));
}

#[test]
fn worker_rejects_stale_results_and_close_does_not_reopen() {
    let mut preview = ImagePreview::default();
    preview.open(source("old", 100, 60));
    preview.poll();
    assert!(preview.busy);
    for index in 0..20 {
        preview.open(source(&format!("new-{index}"), 4, 3));
    }
    preview.close();
    settle(&mut preview);
    assert!(preview.label.contains("new-19"));
    assert!(!preview.is_open());
    assert!(preview.reopen());
    assert_eq!(preview.mode, Some(PreviewMode::Small));
    assert!(preview.ready.is_some());
}

#[test]
fn intent_revision_changes_without_invalidating_reusable_worker_output() {
    let mut preview = ImagePreview::default();
    let initial_revision = preview.revision();
    assert!(!preview.reopen());
    assert_eq!(preview.revision(), initial_revision);

    preview.open(source("retained", 4, 3));
    let open_revision = preview.revision();
    assert_ne!(open_revision, initial_revision);
    preview.poll();
    assert!(preview.busy);
    let generation = preview.generation;
    preview.close();
    let closed_revision = preview.revision();
    assert_ne!(closed_revision, open_revision);
    assert_eq!(preview.generation, generation);
    settle(&mut preview);
    let ready = preview.ready.as_deref().unwrap() as *const ReadyImage;

    assert!(preview.reopen());
    assert_ne!(preview.revision(), closed_revision);
    assert_eq!(preview.generation, generation);
    assert_eq!(
        preview.ready.as_deref().unwrap() as *const ReadyImage,
        ready
    );
    assert!(preview.pending.is_none());
}

#[test]
fn load_failure_is_recoverable_without_replacing_worker_or_leaking_data_urls() {
    let mut preview = ImagePreview::default();
    preview.open(Source::Attachment {
        id: "bad".into(),
        data_url: "https://example.test/private-token".into(),
    });
    settle(&mut preview);
    assert!(preview.error.is_some());
    assert!(!preview.error.as_ref().unwrap().contains("private-token"));
    preview.open(source("valid", 16, 16));
    settle(&mut preview);
    assert!(preview.error.is_none());
    assert!(preview.ready.is_some());
}

#[test]
fn real_view_halfblocks_toggle_resize_and_close_restore_transcript_and_composer() {
    let mut app = AppState::default();
    app.push_line(LogKind::Assistant, "Transcript stays text-only");
    app.input.insert_str("composer stays intact");
    let mut terminal = Terminal::new(TestBackend::new(100, 30)).unwrap();
    draw_frame(&mut terminal, &mut app, false).unwrap();
    let original = terminal.backend().buffer().clone();
    app.image_preview.open(source("test", 200, 120));
    settle(&mut app.image_preview);
    draw_ready(&mut terminal, &mut app, false);
    assert!(buffer_text(&terminal).contains("Image preview - Small"));
    assert!(buffer_text(&terminal).contains("200 x 120"));
    assert_eq!(
        app.render_state.cursor_phase,
        crate::app::CursorPhase::VisibleAtImagePreview
    );
    assert!(terminal
        .backend()
        .buffer()
        .content
        .iter()
        .any(|cell| cell.symbol() == "▀"));
    assert!(app.selection_input_blocked());
    assert!(!handlers::can_dispatch_prompt_now(&app));
    assert!(crate::event_loop::input::blocks_input_paste(&app));
    for key in [KeyCode::Char('x'), KeyCode::Backspace] {
        assert!(app.image_preview.handle_key(key, KeyModifiers::NONE));
    }
    assert_eq!(app.input.current(), "composer stays intact");
    app.image_preview
        .handle_key(KeyCode::Enter, KeyModifiers::NONE);
    draw_ready(&mut terminal, &mut app, false);
    assert!(buffer_text(&terminal).contains("Image preview - Modal"));
    terminal.backend_mut().resize(22, 9);
    terminal.resize(Rect::new(0, 0, 22, 9)).unwrap();
    draw_ready(&mut terminal, &mut app, false);
    assert_eq!(app.image_preview.desired_size, Size::default());
    terminal.backend_mut().resize(100, 30);
    terminal.resize(Rect::new(0, 0, 100, 30)).unwrap();
    app.image_preview
        .handle_key(KeyCode::Char('c'), KeyModifiers::CONTROL);
    draw_frame(&mut terminal, &mut app, false).unwrap();
    assert_eq!(terminal.backend().buffer(), &original);
    assert_eq!(
        app.render_state.cursor_phase,
        crate::app::CursorPhase::VisibleAtComposer
    );
    assert_eq!(app.log.len(), 1);
    assert!(handlers::can_dispatch_prompt_now(&app));
}

#[test]
fn session_reset_forgets_source_and_discards_loading_completion() {
    let mut app = AppState::default();
    app.image_preview.open(source("private", 200, 100));
    app.image_preview.poll();
    app.clear_log();
    settle(&mut app.image_preview);
    assert!(!app.image_preview.is_open());
    assert!(!app.image_preview.reopen());
    assert!(app.image_preview.ready.is_none());
    assert!(app.image_preview.label.is_empty());
}

#[test]
fn composer_preview_uses_last_referenced_image_without_consuming_attachments() {
    let mut app = AppState::default();
    let data_url = match source("test", 20, 20) {
        Source::Attachment { data_url, .. } => data_url,
        _ => unreachable!(),
    };
    for id in ["one", "two"] {
        app.pending_image_attachments.insert(
            id.into(),
            PendingImageAttachment {
                data_url: data_url.to_string(),
                width: 20,
                height: 20,
                encoded_bytes: 100,
            },
        );
        let token = crate::app::util::attachments::make_attachment_token(&app.composer_nonce, id);
        app.input.insert_str(&token);
    }
    let input = app.input.current();
    handlers::image_preview::preview_composer_image(&mut app);
    settle(&mut app.image_preview);
    assert!(app.image_preview.label.contains("two"));
    app.image_preview.close();
    app.prune_unreferenced_attachments();
    assert_eq!(app.input.current(), input);
    assert_eq!(app.pending_image_attachments.len(), 2);
}

#[test]
fn kitty_frames_use_one_owned_image_id_across_resize_and_replacement() {
    let mut app = AppState::default();
    app.image_preview.policy = PreviewPolicy::resolve(
        Some("kitty"),
        true,
        false,
        Some(ratatui_image::FontSize::new(8, 16)),
    );
    let id = app.image_preview.policy.kitty_id.unwrap();
    let mut terminal = Terminal::new(TestBackend::new(100, 30)).unwrap();
    for name in ["first", "replacement"] {
        app.image_preview.open(source(name, 900, 800));
        settle(&mut app.image_preview);
        draw_ready(&mut terminal, &mut app, false);
        let text = buffer_text(&terminal);
        assert!(text.contains("\x1b_G"));
        assert!(text.contains(&format!("i={id}")));
        app.image_preview
            .handle_key(KeyCode::Enter, KeyModifiers::NONE);
        draw_ready(&mut terminal, &mut app, false);
        assert!(buffer_text(&terminal).contains(&format!("i={id}")));
        app.image_preview.close();
        draw_frame(&mut terminal, &mut app, false).unwrap();
        assert!(!buffer_text(&terminal).contains("\x1b_G"));
    }
}
