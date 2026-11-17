use super::{parse_file_list, ClipboardImageError, GNOME_LIST, MAX_URI_LIST_BYTES, URI_LIST};
use std::io::{self, Read};
use std::os::fd::AsRawFd;
use std::path::PathBuf;
use std::thread;
use std::time::{Duration, Instant};
use wl_clipboard_rs::paste::{get_contents, ClipboardType, Error as WaylandError, MimeType, Seat};
use x11rb::connection::Connection;
use x11rb::protocol::{xproto::*, Event};

const CLIPBOARD_TIMEOUT: Duration = Duration::from_secs(2);

pub(in crate::app::util::clipboard) fn read_file_list() -> Result<Vec<PathBuf>, ClipboardImageError>
{
    if std::env::var_os("WAYLAND_DISPLAY").is_some() || std::env::var_os("WAYLAND_SOCKET").is_some()
    {
        if let Some(paths) = wayland_file_list()? {
            return Ok(paths);
        }
    }
    if std::env::var_os("DISPLAY").is_some() {
        return read_x11_file_list()
            .map_err(|error| ClipboardImageError::Clipboard(error.to_string()));
    }
    Ok(Vec::new())
}

fn wayland_file_list() -> Result<Option<Vec<PathBuf>>, ClipboardImageError> {
    for mime in [URI_LIST, GNOME_LIST] {
        match get_contents(
            ClipboardType::Regular,
            Seat::Unspecified,
            MimeType::Specific(mime),
        ) {
            Ok((pipe, selected)) => {
                let bytes = read_pipe(pipe)
                    .map_err(|error| ClipboardImageError::Clipboard(error.to_string()))?;
                return parse_file_list(&bytes, &selected).map(Some);
            }
            Err(WaylandError::NoMimeType) => {}
            Err(WaylandError::NoSeats | WaylandError::ClipboardEmpty) => {
                return Ok(Some(Vec::new()))
            }
            // XWayland can carry the clipboard when direct data-control is disabled.
            Err(_) => return Ok(None),
        }
    }
    Ok(Some(Vec::new()))
}

fn read_pipe(mut pipe: impl AsRawFd + Read) -> io::Result<Vec<u8>> {
    let mut poll = libc::pollfd {
        fd: pipe.as_raw_fd(),
        events: libc::POLLIN,
        revents: 0,
    };
    let deadline = Instant::now() + CLIPBOARD_TIMEOUT;
    let mut bytes = Vec::new();
    let mut buffer = [0u8; 8 * 1024];
    loop {
        if Instant::now() >= deadline {
            return Err(io::Error::other("Clipboard file list timed out"));
        }
        let remaining = deadline
            .saturating_duration_since(Instant::now())
            .as_millis() as libc::c_int;
        // SAFETY: poll references one initialized descriptor for the duration of the call.
        let ready = unsafe { libc::poll(&mut poll, 1, remaining) };
        if ready == 0 {
            return Err(io::Error::other("Clipboard file list timed out"));
        }
        if ready < 0 {
            let error = io::Error::last_os_error();
            if error.kind() == io::ErrorKind::Interrupted {
                continue;
            }
            return Err(error);
        }
        let read = pipe.read(&mut buffer)?;
        if read == 0 {
            return Ok(bytes);
        }
        if bytes.len() + read > MAX_URI_LIST_BYTES {
            return Err(io::Error::other("Clipboard file list is too large"));
        }
        bytes.extend_from_slice(&buffer[..read]);
    }
}

fn read_x11_file_list() -> Result<Vec<PathBuf>, Box<dyn std::error::Error>> {
    let Ok((connection, screen)) = x11rb::connect(None) else {
        return Ok(Vec::new());
    };
    let intern = |name: &str| -> Result<Atom, Box<dyn std::error::Error>> {
        Ok(connection
            .intern_atom(false, name.as_bytes())?
            .reply()?
            .atom)
    };
    let clipboard = intern("CLIPBOARD")?;
    if connection.get_selection_owner(clipboard)?.reply()?.owner == x11rb::NONE {
        return Ok(Vec::new());
    }
    let property = intern("CODELIA_CLIPBOARD_FILE_LIST")?;
    let window = connection.generate_id()?;
    let root = connection.setup().roots[screen].root;
    connection
        .create_window(
            0,
            window,
            root,
            0,
            0,
            1,
            1,
            0,
            WindowClass::INPUT_ONLY,
            0,
            &CreateWindowAux::new(),
        )?
        .check()?;

    for mime in [URI_LIST, GNOME_LIST] {
        let target = intern(mime)?;
        connection
            .convert_selection(window, clipboard, target, property, x11rb::CURRENT_TIME)?
            .check()?;
        let deadline = Instant::now() + CLIPBOARD_TIMEOUT;
        loop {
            if Instant::now() >= deadline {
                return Err(io::Error::other("Clipboard file list timed out").into());
            }
            if let Some(Event::SelectionNotify(event)) = connection.poll_for_event()? {
                if event.requestor != window
                    || event.selection != clipboard
                    || event.target != target
                {
                    continue;
                }
                if event.property == x11rb::NONE {
                    break;
                }
                let data = connection
                    .get_property(
                        true,
                        window,
                        property,
                        AtomEnum::ANY,
                        0,
                        (MAX_URI_LIST_BYTES as u32 / 4) + 1,
                    )?
                    .reply()?;
                if data.format != 8 || data.bytes_after != 0 {
                    return Err(io::Error::other(
                        "Clipboard file list is unsupported or too large",
                    )
                    .into());
                }
                return parse_file_list(&data.value, mime)
                    .map_err(|error| io::Error::other(error.to_string()).into());
            }
            thread::sleep(Duration::from_millis(5));
        }
    }
    Ok(Vec::new())
}
