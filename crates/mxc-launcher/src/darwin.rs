use crate::request::{LaunchRequest, VERSION};
use mxc_sdk::v1::{
    self, ContainerRequest, Containment, MxcProcess, SpawnExtendedOptions, SpawnStdio, WaitResult,
    configs::SeatbeltConfig,
};
use std::io::{self, Read, Write};
use std::mem::MaybeUninit;
use std::net::Shutdown;
use std::os::fd::{AsRawFd, FromRawFd};
use std::os::unix::{net::UnixStream, process::CommandExt};
use std::process::{Child, Command, ExitCode};
use std::sync::atomic::{AtomicBool, Ordering};
use std::thread;
use std::time::{Duration, Instant};

const CONTROL_FD: libc::c_int = 3;
const FAILED: u8 = 125;
const CANCELLED: u8 = 143;
const POLL: Duration = Duration::from_millis(15);
static STOP: AtomicBool = AtomicBool::new(false);

extern "C" fn stop(_: libc::c_int) {
    STOP.store(true, Ordering::Relaxed);
}

fn signal_handlers() {
    for signal in [libc::SIGTERM, libc::SIGINT, libc::SIGHUP] {
        // The handler only sets an atomic flag; cleanup runs on the main thread.
        unsafe { libc::signal(signal, stop as *const () as libc::sighandler_t) };
    }
}

fn control() -> io::Result<UnixStream> {
    // Do not pass the control channel to the workload or any of its descendants.
    if unsafe { libc::fcntl(CONTROL_FD, libc::F_SETFD, libc::FD_CLOEXEC) } == -1 {
        return Err(io::Error::last_os_error());
    }
    Ok(unsafe { UnixStream::from_raw_fd(CONTROL_FD) })
}

fn launch(request: LaunchRequest) -> io::Result<MxcProcess> {
    let mut container = ContainerRequest::new(request.command());
    container.working_directory = Some(request.cwd);
    container.inherit_default_environment = Some(false);
    let mut environment = vec![
        ("PATH".to_string(), request.path),
        ("LANG".to_string(), "C".to_string()),
        ("HOME".to_string(), request.scratch.clone()),
        ("TMPDIR".to_string(), request.scratch.clone()),
        ("XDG_CACHE_HOME".to_string(), request.scratch),
        ("GIT_OPTIONAL_LOCKS".to_string(), "0".to_string()),
    ];
    environment.extend(
        [
            ("CARGO_HOME", request.cargo_home),
            ("RUSTUP_HOME", request.rustup_home),
        ]
        .into_iter()
        .filter_map(|(name, value)| value.map(|value| (name.to_string(), value))),
    );
    container.environment = Some(environment);
    let mut seatbelt = SeatbeltConfig::default();
    seatbelt.profile_override = Some(request.profile);
    container.containment = Containment::Seatbelt(seatbelt);
    let mut options = SpawnExtendedOptions::default();
    options.stdio = SpawnStdio::Inherit;
    v1::spawn_with_extended_options(container, options)
        .map_err(|_| io::Error::other("MXC could not admit the native launch"))
}

fn exit_code(result: WaitResult) -> u8 {
    match result {
        WaitResult::Exited(code) => u8::try_from(code).unwrap_or(1),
        WaitResult::TimedOut => 124,
    }
}

fn verified_wait(process: &mut MxcProcess) -> io::Result<u8> {
    let result = process.wait()?;
    // This profile requests no optional capture. Any warning prevents treating
    // a successful workload exit as confirmed cleanup.
    if !process.warnings().is_empty() {
        return Err(io::Error::other("MXC reported incomplete cleanup"));
    }
    Ok(exit_code(result))
}

fn stop_requested(control: &mut UnixStream) -> bool {
    if STOP.load(Ordering::Relaxed) {
        return true;
    }
    // After the one request, any input or closure revokes the lifetime lease.
    match control.read(&mut [0]) {
        Err(error)
            if matches!(
                error.kind(),
                io::ErrorKind::WouldBlock | io::ErrorKind::Interrupted
            ) =>
        {
            false
        }
        _ => true,
    }
}

fn worker(supervisor: &mut UnixStream) -> io::Result<()> {
    supervisor.set_read_timeout(Some(Duration::from_secs(5)))?;
    let request = LaunchRequest::read(&*supervisor)?;
    supervisor.set_nonblocking(true)?;
    if stop_requested(supervisor) {
        return supervisor.write_all(b"C");
    }
    let mut process = launch(request)?;
    if supervisor.write_all(b"S").is_err() {
        process.kill()?;
        verified_wait(&mut process)?;
        return Ok(());
    }
    loop {
        if stop_requested(supervisor) {
            process.kill()?;
            verified_wait(&mut process)?;
            return supervisor.write_all(b"C");
        }
        if process.try_wait()?.is_some() {
            // MXC wait, rather than try_wait, also cleans up its descendants.
            let code = verified_wait(&mut process)?;
            return supervisor.write_all(&[b'X', code]);
        }
        thread::sleep(POLL);
    }
}

fn has_exited(child: &Child) -> io::Result<bool> {
    let mut status = MaybeUninit::<libc::siginfo_t>::zeroed();
    // Keep the session leader unreaped until we signal its original group.
    let result = unsafe {
        libc::waitid(
            libc::P_PID,
            child.id(),
            status.as_mut_ptr(),
            libc::WEXITED | libc::WNOHANG | libc::WNOWAIT,
        )
    };
    if result == -1 {
        let error = io::Error::last_os_error();
        return if error.kind() == io::ErrorKind::Interrupted {
            Ok(false)
        } else {
            Err(error)
        };
    }
    Ok(unsafe { status.assume_init().si_pid() != 0 })
}

fn start_worker(request: &LaunchRequest) -> io::Result<(Child, UnixStream)> {
    let (supervisor, worker) = UnixStream::pair()?;
    let fd = worker.as_raw_fd();
    let mut command = Command::new(std::env::current_exe()?);
    command.arg("--worker").env_clear();
    // The SDK's inherited-stdio launch stays in this dedicated session.
    // This also lets close-on-exit cover a child still in sandbox pre-exec.
    unsafe {
        command.pre_exec(move || {
            if libc::setsid() == -1 || libc::dup2(fd, CONTROL_FD) == -1 {
                return Err(io::Error::last_os_error());
            }
            Ok(())
        });
    }
    let mut child = command.spawn()?;
    drop(worker);
    let send = (|| {
        supervisor.set_write_timeout(Some(Duration::from_secs(5)))?;
        serde_json::to_writer(&supervisor, request)?;
        (&supervisor).write_all(b"\n")?;
        supervisor.set_nonblocking(true)
    })();
    if let Err(error) = send {
        stop_worker_group(&mut child)?;
        return Err(error);
    }
    Ok((child, supervisor))
}

fn stop_worker_group(child: &mut Child) -> io::Result<std::process::ExitStatus> {
    // setsid made this authentic, still-unreaped child the group leader.
    let outcome = unsafe { libc::kill(-(child.id() as libc::pid_t), libc::SIGKILL) };
    if outcome == -1 {
        let error = io::Error::last_os_error();
        if error.raw_os_error() != Some(libc::ESRCH) {
            return Err(error);
        }
    }
    child.wait()
}

#[derive(Default)]
enum WorkerReport {
    #[default]
    Pending,
    Started,
    WaitingForExitCode,
    Finished(u8),
    Cancelled,
    Failed,
}

impl WorkerReport {
    fn drain(&mut self, inner: &mut UnixStream, mut started: impl FnMut()) -> io::Result<()> {
        loop {
            let mut byte = [0];
            match inner.read(&mut byte) {
                Ok(0) => return Ok(()),
                Ok(_) => {}
                Err(error) if error.kind() == io::ErrorKind::Interrupted => continue,
                Err(error) if error.kind() == io::ErrorKind::WouldBlock => return Ok(()),
                Err(error) => return Err(error),
            }
            *self = match (&*self, byte[0]) {
                (Self::Pending, b'S') => {
                    started();
                    Self::Started
                }
                (Self::Started, b'X') => Self::WaitingForExitCode,
                (Self::WaitingForExitCode, code) => Self::Finished(code),
                (Self::Pending | Self::Started, b'C') => Self::Cancelled,
                (Self::Pending | Self::Started, b'F') => Self::Failed,
                _ => return Err(io::Error::other("invalid worker report")),
            };
        }
    }
}

fn supervise(outer: &mut UnixStream) -> io::Result<u8> {
    outer.set_read_timeout(Some(Duration::from_secs(5)))?;
    let request = LaunchRequest::read(&*outer)?;
    outer.set_nonblocking(true)?;
    if stop_requested(outer) {
        let _ = writeln!(outer, "{{\"event\":\"cancelled\"}}");
        return Ok(CANCELLED);
    }
    let (mut child, mut inner) = start_worker(&request)?;
    let worker_pid = child.id();
    let mut report = WorkerReport::default();
    let mut drain = |outer: &mut UnixStream, inner: &mut UnixStream| {
        report.drain(inner, || {
            let _ = writeln!(
                outer,
                "{{\"event\":\"started\",\"worker_pid\":{worker_pid}}}"
            );
        })
    };
    let mut cancelling = None;
    let wait = (|| loop {
        if has_exited(&child)? {
            break drain(outer, &mut inner).map(|()| true);
        }
        drain(outer, &mut inner)?;
        if cancelling.is_none() && stop_requested(outer) {
            let _ = inner.shutdown(Shutdown::Write);
            cancelling = Some(Instant::now() + Duration::from_secs(5));
        }
        if cancelling.is_some_and(|deadline| Instant::now() >= deadline) {
            break Ok(false);
        }
        thread::sleep(POLL);
    })();
    // Only a clean SDK report proves disposal of detached processes. A failed
    // worker still owns this unreaped process group, which can be stopped safely.
    let response = if matches!(wait, Ok(true))
        && matches!(report, WorkerReport::Finished(_) | WorkerReport::Cancelled)
    {
        child.wait()
    } else {
        stop_worker_group(&mut child)
    };
    wait?;
    let response = response?;
    match report {
        WorkerReport::Finished(code) if response.success() => {
            let _ = writeln!(outer, "{{\"event\":\"finished\",\"exit_code\":{code}}}");
            Ok(code)
        }
        WorkerReport::Cancelled if response.success() => {
            let _ = writeln!(outer, "{{\"event\":\"cancelled\"}}");
            Ok(CANCELLED)
        }
        _ => Err(io::Error::other(
            "worker did not confirm containment cleanup",
        )),
    }
}

pub fn main() -> ExitCode {
    let operation = std::env::args().nth(1);
    if matches!(operation.as_deref(), Some("--run" | "--worker")) {
        signal_handlers();
    }
    let result = match operation.as_deref() {
        Some("--probe") => launch(LaunchRequest {
            version: VERSION,
            executable: "/usr/bin/true".into(),
            args: vec![],
            cwd: "/".into(),
            scratch: "/private/tmp".into(),
            path: "/usr/bin:/bin".into(),
            cargo_home: None,
            rustup_home: None,
            profile: "(version 1)(deny default)(allow process-exec process-fork file-read* sysctl-read)(deny network*)".into(),
        }).and_then(|mut child| verified_wait(&mut child)),
        Some("--worker") => control().and_then(|mut socket| match worker(&mut socket) {
            Ok(()) => Ok(0),
            Err(error) => {
                let _ = socket.write_all(b"F");
                Err(error)
            }
        }),
        Some("--run") => control().and_then(|mut socket| {
            let result = supervise(&mut socket);
            if result.is_err() { let _ = writeln!(socket, "{{\"event\":\"failed\"}}"); }
            result
        }),
        _ => Err(io::Error::other("unknown launcher operation")),
    };
    match result {
        Ok(code) => ExitCode::from(code),
        Err(_) => {
            eprintln!("codelia-mxc: native launch or cleanup failed");
            ExitCode::from(FAILED)
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn drains_buffered_frames_after_worker_exit_and_distinguishes_internal_errors() {
        for (bytes, expected) in [
            (&b"SX\0"[..], Some(0)),
            (b"SX\x7d", Some(125)),
            (b"SF", None),
            (b"S", None),
        ] {
            let (mut writer, mut reader) = UnixStream::pair().unwrap();
            reader.set_nonblocking(true).unwrap();
            let mut report = WorkerReport::default();
            let mut starts = 0;
            report.drain(&mut reader, || starts += 1).unwrap();
            assert_eq!(starts, 0);
            writer.write_all(bytes).unwrap();
            drop(writer);
            report.drain(&mut reader, || starts += 1).unwrap();
            assert_eq!(starts, 1);
            assert_eq!(
                match report {
                    WorkerReport::Finished(code) => Some(code),
                    _ => None,
                },
                expected
            );
        }
    }
}
