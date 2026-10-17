mod source;
mod ui;

#[cfg(test)]
mod tests;

use std::{
    env,
    ffi::OsString,
    io::{self, IsTerminal},
    path::PathBuf,
    sync::mpsc::{self, TryRecvError},
    thread,
    time::Duration,
};

use crossterm::event::{self, Event};
use ratatui::DefaultTerminal;
use ratatui_image::{
    picker::Picker,
    thread::{ResizeRequest, ThreadProtocol},
};

#[derive(Debug, Default, PartialEq, Eq)]
struct Options {
    path: Option<PathBuf>,
    halfblocks: bool,
}

fn parse_args(args: impl IntoIterator<Item = OsString>) -> Result<Option<Options>, String> {
    let mut options = Options::default();
    let mut paths_only = false;
    for arg in args {
        if !paths_only {
            if arg == "--help" || arg == "-h" {
                return Ok(None);
            }
            if arg == "--halfblocks" {
                options.halfblocks = true;
                continue;
            }
            if arg == "--" {
                paths_only = true;
                continue;
            }
            if arg.to_string_lossy().starts_with('-') {
                return Err(format!(
                    "Unknown option: {}",
                    source::safe_label(&arg.to_string_lossy())
                ));
            }
        }
        if options.path.replace(PathBuf::from(arg)).is_some() {
            return Err("Pass at most one local image path".into());
        }
    }
    Ok(Some(options))
}

fn in_tmux(tmux: bool, term: &str, program: &str) -> bool {
    tmux || term.starts_with("tmux") || program == "tmux"
}

fn main() -> io::Result<()> {
    let Some(options) = parse_args(env::args_os().skip(1)).map_err(io::Error::other)? else {
        println!("usage: codelia-image-preview [--halfblocks] [--] [local-image]");
        println!("No path: use an in-memory demo. PNG/JPEG/GIF/WebP, at most 8 MiB.");
        println!("Enter/Space: modal or small panel; Esc: close/hide; v: hide/show; q: quit.");
        println!("Experimental, alternate-screen only. No runtime, model calls, or uploads.");
        println!("Run outside tmux; --halfblocks skips terminal capability queries.");
        return Ok(());
    };
    // Picker construction can change tmux passthrough settings, even for halfblocks.
    // Keep this isolated lab from modifying the user's multiplexer configuration.
    if in_tmux(
        env::var_os("TMUX").is_some(),
        &env::var("TERM").unwrap_or_default(),
        &env::var("TERM_PROGRAM").unwrap_or_default(),
    ) {
        return Err(io::Error::other(
            "Run this preview lab outside tmux (no tmux settings are changed)",
        ));
    }
    if !io::stdin().is_terminal() || !io::stdout().is_terminal() {
        return Err(io::Error::other(
            "Image preview requires an interactive terminal; use --help for usage",
        ));
    }
    // Decode/validate before entering raw mode or starting the redraw loop.
    let (image, label) = source::load(options.path.as_deref())?;
    let result = match ratatui::try_init() {
        Ok(mut terminal) => run(&mut terminal, image, label, options.halfblocks),
        Err(error) => Err(error),
    };
    // Restore even if initialization partially failed; init also installs the panic hook.
    let restored = ratatui::try_restore();
    match (result, restored) {
        (Err(error), Err(restore)) => Err(io::Error::other(format!(
            "{error}; terminal restore failed: {restore}"
        ))),
        (Err(error), _) | (_, Err(error)) => Err(error),
        _ => Ok(()),
    }
}

fn run(
    terminal: &mut DefaultTerminal,
    image: image::DynamicImage,
    label: String,
    halfblocks: bool,
) -> io::Result<()> {
    // Query before event::poll/read starts; never compete for terminal replies.
    let (picker, note) = if halfblocks {
        (
            Picker::halfblocks(),
            "Forced halfblocks (no capability query)".to_string(),
        )
    } else {
        let picker = Picker::from_query_stdio().map_err(|error| {
            io::Error::other(format!(
                "Terminal detection failed: {error}; retry with --halfblocks"
            ))
        })?;
        // In 11.0.8 a query timeout can leave its stdin reader alive. Do not start
        // a competing event reader after the library returns a fallback picker.
        if picker.capabilities().is_empty() {
            return Err(io::Error::other(
                "No completed terminal capability response; retry with --halfblocks",
            ));
        }
        (
            picker,
            "Auto-detected protocol; text/path fallback remains visible".into(),
        )
    };
    let font = picker.font_size();
    if font.width == 0 || font.height == 0 || font.width > 128 || font.height > 256 {
        return Err(io::Error::other(
            "Unsupported terminal cell size; retry with --halfblocks",
        ));
    }
    let protocol_label = format!("{:?}", picker.protocol_type());
    let (request_tx, request_rx) = mpsc::channel::<ResizeRequest>();
    let (result_tx, result_rx) = mpsc::channel();
    let worker = thread::Builder::new()
        .name("codelia-image-encoder".into())
        .spawn(move || {
            while let Ok(request) = request_rx.recv() {
                if result_tx.send(request.resize_encode()).is_err() {
                    break; // The preview has closed; there is no consumer left.
                }
            }
        })?;
    // ThreadProtocol moves its state into one outstanding request, preventing a
    // resize-event backlog of cloned source images. Encoding never runs in draw().
    let mut app = ui::Preview::new(
        label,
        protocol_label,
        source::safe_label(&note),
        ThreadProtocol::new(request_tx, Some(picker.new_resize_protocol(image))),
    );
    let result = (|| {
        let mut dirty = true;
        loop {
            match result_rx.try_recv() {
                Ok(Ok(response)) => dirty |= app.image.update_resized_protocol(response),
                Ok(Err(error)) => {
                    return Err(io::Error::other(format!("Image encoding failed: {error}")))
                }
                Err(TryRecvError::Disconnected) => {
                    return Err(io::Error::other("Image encoder disconnected"))
                }
                Err(TryRecvError::Empty) => {}
            }
            if dirty {
                terminal.draw(|frame| ui::draw(frame, &mut app))?;
                dirty = false;
            }
            if event::poll(Duration::from_millis(40))? {
                match event::read()? {
                    Event::Key(key) => {
                        if app.handle_key(key) {
                            break;
                        }
                        dirty = true;
                    }
                    Event::Resize(_, _) => dirty = true,
                    _ => {}
                }
            }
        }
        Ok(())
    })();
    drop(app); // Close the request sender so the worker can exit.
    let joined = worker.join();
    if joined.is_err() {
        return Err(io::Error::other("Image encoder panicked"));
    }
    result
}
