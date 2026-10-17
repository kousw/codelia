use std::{
    ffi::OsString,
    fs,
    io::Cursor,
    path::PathBuf,
    sync::{
        atomic::{AtomicU64, Ordering},
        mpsc,
    },
};

use crossterm::event::{KeyCode, KeyEvent, KeyEventKind, KeyModifiers};
use image::{DynamicImage, ImageFormat, RgbaImage};
use ratatui::{backend::TestBackend, layout::Rect, Terminal};
use ratatui_image::{
    protocol::{halfblocks::Halfblocks, StatefulProtocol, StatefulProtocolType},
    thread::{ResizeRequest, ThreadProtocol},
    FontSize,
};

use super::{
    in_tmux, parse_args, source,
    ui::{self, Mode, Preview},
    Options,
};

fn args(values: &[&str]) -> Vec<OsString> {
    values.iter().map(OsString::from).collect()
}

#[test]
fn cli_supports_demo_paths_flags_and_help_without_a_terminal() {
    assert_eq!(parse_args(args(&[])).unwrap(), Some(Options::default()));
    assert_eq!(
        parse_args(args(&["--halfblocks", "some image.png"])).unwrap(),
        Some(Options {
            path: Some("some image.png".into()),
            halfblocks: true
        })
    );
    assert_eq!(
        parse_args(args(&["--", "-image.png"]))
            .unwrap()
            .unwrap()
            .path,
        Some("-image.png".into())
    );
    assert_eq!(parse_args(args(&["--help"])).unwrap(), None);
    assert!(parse_args(args(&["--invalid"])).is_err());
    assert!(parse_args(args(&["a.png", "b.png"])).is_err());
}

#[test]
fn multiplexer_guard_covers_picker_side_effect_detection() {
    assert!(in_tmux(true, "xterm-256color", "ghostty"));
    assert!(in_tmux(false, "tmux-256color", ""));
    assert!(in_tmux(false, "xterm", "tmux"));
    assert!(!in_tmux(false, "xterm-ghostty", "ghostty"));
}

#[test]
fn labels_escape_terminal_controls() {
    let label = source::safe_label("image\x1b[31m\n\r\t.png");
    assert!(label.contains("\\u{1b}"));
    assert!(!label.chars().any(char::is_control));
}

#[test]
fn image_decoding_preserves_aspect_ratio_and_bounds_preview() {
    let original = DynamicImage::ImageRgba8(RgbaImage::new(2048, 512));
    let mut bytes = Cursor::new(Vec::new());
    original.write_to(&mut bytes, ImageFormat::Png).unwrap();
    let (preview, width, height) = source::decode(bytes.get_ref()).unwrap();
    assert_eq!((width, height), (2048, 512));
    assert_eq!((preview.width(), preview.height()), (1024, 256));
    assert!(source::decode(b"not an image").is_err());
    assert!(source::decode(&bytes.get_ref()[..30]).is_err());
    assert!(source::validate_dimensions(4096, 4096).is_ok());
    assert!(source::validate_dimensions(4097, 1).is_err());
    assert!(source::validate_dimensions(1, 0).is_err());
}

struct TempDir(PathBuf);
impl TempDir {
    fn new() -> Self {
        static NEXT: AtomicU64 = AtomicU64::new(0);
        let path = std::env::temp_dir().join(format!(
            "codelia-image-test-{}-{}",
            std::process::id(),
            NEXT.fetch_add(1, Ordering::Relaxed)
        ));
        fs::create_dir(&path).unwrap();
        Self(path)
    }
}
impl Drop for TempDir {
    fn drop(&mut self) {
        if let Err(error) = fs::remove_dir_all(&self.0) {
            // Test-owned temporary data only; preserve any original test failure.
            eprintln!("Failed to clean image test directory: {error}");
        }
    }
}

#[test]
fn loader_checks_file_limits_and_reads_local_pixels() {
    let dir = TempDir::new();
    let valid = dir.0.join("image with spaces.png");
    source::demo_image().save(&valid).unwrap();
    let (image, label) = source::load(Some(&valid)).unwrap();
    assert_eq!((image.width(), image.height()), (640, 360));
    assert!(label.contains("image with spaces.png"));
    assert!(source::load(Some(&dir.0)).is_err());
    assert!(source::load(Some(&dir.0.join("missing.png"))).is_err());
    let huge = dir.0.join("oversized.png");
    fs::File::create(&huge)
        .unwrap()
        .set_len(source::MAX_FILE_BYTES + 1)
        .unwrap();
    assert!(source::load(Some(&huge))
        .unwrap_err()
        .to_string()
        .contains("8 MiB"));
}

fn app() -> (Preview, mpsc::Receiver<ResizeRequest>) {
    let (tx, rx) = mpsc::channel();
    // Construct directly: no env mutation, terminal query, or tmux configuration.
    let protocol = StatefulProtocol::new(
        source::demo_image(),
        FontSize::new(10, 20),
        None,
        StatefulProtocolType::Halfblocks(Halfblocks::default()),
    );
    (
        Preview::new(
            "demo.png".into(),
            "Halfblocks".into(),
            "test".into(),
            ThreadProtocol::new(tx, Some(protocol)),
        ),
        rx,
    )
}

fn key(code: KeyCode) -> KeyEvent {
    KeyEvent::new(code, KeyModifiers::NONE)
}

#[test]
fn modal_close_visibility_and_quit_are_distinct() {
    let (mut app, _) = app();
    assert!(!app.handle_key(key(KeyCode::Enter)));
    assert_eq!(app.mode, Mode::Modal);
    assert!(!app.handle_key(key(KeyCode::Esc)));
    assert_eq!(app.mode, Mode::Small);
    app.handle_key(key(KeyCode::Esc));
    assert_eq!(app.mode, Mode::Hidden);
    app.handle_key(key(KeyCode::Char('v')));
    assert_eq!(app.mode, Mode::Small);
    let mut released = key(KeyCode::Char('q'));
    released.kind = KeyEventKind::Release;
    assert!(!app.handle_key(released));
    assert!(app.handle_key(key(KeyCode::Char('q'))));
    assert!(app.handle_key(KeyEvent::new(KeyCode::Char('c'), KeyModifiers::CONTROL)));
}

#[test]
fn panel_and_modal_stay_inside_resized_viewports() {
    for width in 0..150 {
        for height in 0..55 {
            let area = Rect::new(3, 7, width, height);
            for mode in [Mode::Small, Mode::Modal, Mode::Hidden] {
                if let Some(panel) = ui::preview_area(area, mode) {
                    assert_eq!(panel.intersection(area), panel);
                    assert!(panel.width > 2 && panel.height > 2);
                }
            }
        }
    }
    let area = Rect::new(0, 0, 100, 30);
    assert!(
        ui::preview_area(area, Mode::Modal).unwrap().area()
            > ui::preview_area(area, Mode::Small).unwrap().area()
    );
}

fn settle(
    terminal: &mut Terminal<TestBackend>,
    app: &mut Preview,
    rx: &mpsc::Receiver<ResizeRequest>,
) {
    terminal.draw(|f| ui::draw(f, app)).unwrap();
    if let Ok(request) = rx.try_recv() {
        // Drawing again while encoding is outstanding must not enqueue a clone.
        terminal.draw(|f| ui::draw(f, app)).unwrap();
        assert!(rx.try_recv().is_err());
        assert!(app
            .image
            .update_resized_protocol(request.resize_encode().unwrap()));
        terminal.draw(|f| ui::draw(f, app)).unwrap();
    }
}

fn has_image(terminal: &Terminal<TestBackend>) -> bool {
    terminal
        .backend()
        .buffer()
        .content
        .iter()
        .any(|cell| cell.symbol().contains(['\u{2580}', '\u{2584}']))
}

#[test]
fn halfblock_pixels_render_resize_and_disappear_on_hide() {
    let (mut app, rx) = app();
    let mut terminal = Terminal::new(TestBackend::new(100, 30)).unwrap();
    for mode in [Mode::Small, Mode::Modal, Mode::Hidden, Mode::Small] {
        app.mode = mode;
        settle(&mut terminal, &mut app, &rx);
        assert_eq!(has_image(&terminal), mode != Mode::Hidden);
    }
    terminal.backend_mut().resize(60, 18);
    terminal.resize(Rect::new(0, 0, 60, 18)).unwrap();
    settle(&mut terminal, &mut app, &rx);
    assert!(has_image(&terminal));
    terminal.backend_mut().resize(20, 8);
    terminal.resize(Rect::new(0, 0, 20, 8)).unwrap();
    settle(&mut terminal, &mut app, &rx);
    assert!(!has_image(&terminal));
}
