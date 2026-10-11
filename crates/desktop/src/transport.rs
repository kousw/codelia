use anyhow::{Context, Result, bail};
use serde_json::Value;
use std::{
    collections::BTreeMap,
    io::{BufRead, BufReader, Write},
    path::{Path, PathBuf},
    process::{Child, ChildStdin, Command, Stdio},
    sync::mpsc::{self, Receiver},
    thread,
};

#[derive(Clone)]
pub struct RuntimeOptions {
    pub entry: PathBuf,
    pub command: String,
    pub environment: BTreeMap<String, String>,
    pub stderr_log: Option<PathBuf>,
}
impl RuntimeOptions {
    pub fn for_entry(entry: PathBuf) -> Self {
        let command = std::env::var("CODELIA_DESKTOP_RUNTIME_CMD").unwrap_or_else(|_| {
            let candidate =
                std::env::var_os("HOME").map(|home| PathBuf::from(home).join(".bun/bin/bun"));
            candidate
                .filter(|path| path.is_file())
                .map(|path| path.to_string_lossy().into_owned())
                .unwrap_or_else(|| "bun".into())
        });
        Self {
            entry,
            command,
            environment: BTreeMap::new(),
            stderr_log: None,
        }
    }
}

pub enum Incoming {
    Message(Value),
    Closed(String),
}

pub struct Runtime {
    child: Option<Child>,
    input: ChildStdin,
    pub incoming: Receiver<Incoming>,
}

// Cap individual frames before allocating an unbounded newline buffer.
pub const FRAME_LIMIT: usize = 8 * 1024 * 1024;
pub fn read_frame(reader: &mut impl BufRead) -> Result<Option<Vec<u8>>> {
    let mut frame = Vec::new();
    loop {
        let bytes = reader.fill_buf()?;
        if bytes.is_empty() {
            return if frame.is_empty() {
                Ok(None)
            } else {
                bail!("Runtime closed mid-frame")
            };
        }
        let end = bytes.iter().position(|b| *b == b'\n').map(|i| i + 1);
        let count = end.unwrap_or(bytes.len());
        if frame.len() + count > FRAME_LIMIT {
            bail!("Runtime frame exceeded 8 MiB")
        }
        frame.extend_from_slice(&bytes[..count]);
        reader.consume(count);
        if end.is_some() {
            return Ok(Some(frame));
        }
    }
}

impl Runtime {
    pub fn start(root: &Path, options: &RuntimeOptions) -> Result<Self> {
        let stderr = match &options.stderr_log {
            Some(path) => {
                use std::os::unix::fs::OpenOptionsExt;
                Stdio::from(
                    std::fs::OpenOptions::new()
                        .create(true)
                        .append(true)
                        .mode(0o600)
                        .open(path)
                        .context("Open native fixture runtime diagnostics")?,
                )
            }
            None => Stdio::null(),
        };
        let mut child = Command::new(&options.command)
            .arg(&options.entry)
            .envs(&options.environment)
            .current_dir(root)
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(stderr)
            .spawn()
            .context("Could not start runtime; ensure Bun is on PATH")?;
        let input = child.stdin.take().context("Missing runtime stdin")?;
        let output = child.stdout.take().context("Missing runtime stdout")?;
        let (tx, incoming) = mpsc::sync_channel(256);
        thread::spawn(move || {
            let mut reader = BufReader::new(output);
            loop {
                match read_frame(&mut reader) {
                    Ok(Some(bytes)) => match serde_json::from_slice(&bytes) {
                        Ok(value) => {
                            if tx.send(Incoming::Message(value)).is_err() {
                                break;
                            }
                        }
                        Err(_) => {
                            let _ = tx.send(Incoming::Closed("Invalid JSON from runtime".into()));
                            break;
                        }
                    },
                    Ok(None) => {
                        let _ = tx.send(Incoming::Closed("Runtime disconnected; inspect workspace and reconnect. No request was replayed.".into()));
                        break;
                    }
                    Err(error) => {
                        let _ = tx.send(Incoming::Closed(error.to_string()));
                        break;
                    }
                }
            }
        });
        Ok(Self {
            child: Some(child),
            input,
            incoming,
        })
    }

    pub fn send(&mut self, message: &Value) -> Result<()> {
        let mut bytes = serde_json::to_vec(message)?;
        if bytes.len() > FRAME_LIMIT {
            bail!("Request exceeded 8 MiB")
        }
        bytes.push(b'\n');
        self.input
            .write_all(&bytes)
            .context("Runtime write failed; outcome may be unknown")?;
        self.input.flush()?;
        Ok(())
    }
}

impl Runtime {
    pub fn shutdown(&mut self) -> Option<thread::JoinHandle<()>> {
        // Signal only this owned subprocess. Runtime handles SIGTERM task cleanup.
        let mut child = self.child.take()?;
        if matches!(child.try_wait(), Ok(Some(_))) {
            return None;
        }
        match Command::new("/bin/kill")
            .args(["-TERM", &child.id().to_string()])
            .status()
        {
            Ok(status) if status.success() => {}
            Ok(_) => {
                eprintln!("codelia-desktop: runtime did not accept shutdown signal; checking exit")
            }
            Err(error) => eprintln!("codelia-desktop: runtime shutdown signal failed: {error}"),
        }
        Some(thread::spawn(move || {
            for _ in 0..400 {
                match child.try_wait() {
                    Ok(Some(_)) => return,
                    Ok(None) => thread::sleep(std::time::Duration::from_millis(100)),
                    Err(error) => {
                        eprintln!("codelia-desktop: runtime reap failed: {error}");
                        break;
                    }
                }
            }
            if let Err(error) = child.kill() {
                eprintln!("codelia-desktop: runtime kill failed: {error}");
            }
            if let Err(error) = child.wait() {
                eprintln!("codelia-desktop: runtime wait failed: {error}");
            }
        }))
    }
}

impl Drop for Runtime {
    fn drop(&mut self) {
        // Reconnect/drop remain nonblocking; normal app quit explicitly awaits reaping.
        let _ = self.shutdown();
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn rejects_oversized_and_partial_frames() {
        assert!(read_frame(&mut &vec![b'a'; FRAME_LIMIT + 1][..]).is_err());
        assert!(read_frame(&mut &b"{}"[..]).is_err());
        assert_eq!(
            read_frame(&mut &b"{}\n"[..]).unwrap(),
            Some(b"{}\n".to_vec())
        );
    }
}
