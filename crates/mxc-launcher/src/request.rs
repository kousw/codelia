use serde::{Deserialize, Serialize};
use std::io::{self, BufRead, BufReader, Read};
use std::path::Path;

pub const VERSION: u8 = 2;
const MAX_REQUEST_BYTES: u64 = 256 * 1024;

#[derive(Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
pub struct LaunchRequest {
    pub version: u8,
    pub executable: String,
    pub args: Vec<String>,
    pub cwd: String,
    pub profile: String,
    pub path: String,
    pub scratch: String,
    /// The login user's home; private scratch when absent.
    #[serde(default)]
    pub home: Option<String>,
    pub cargo_home: Option<String>,
    pub rustup_home: Option<String>,
}

impl LaunchRequest {
    pub fn read(source: impl Read) -> io::Result<Self> {
        let mut bytes = Vec::new();
        BufReader::new(source.take(MAX_REQUEST_BYTES + 1)).read_until(b'\n', &mut bytes)?;
        if bytes.len() as u64 > MAX_REQUEST_BYTES || bytes.last() != Some(&b'\n') {
            return Err(io::Error::other("invalid launch frame"));
        }
        let request: Self = serde_json::from_slice(&bytes)?;
        if request.version != VERSION
            || [&request.executable, &request.cwd, &request.scratch]
                .iter()
                .any(|value| !Path::new(value).is_absolute())
            || request.profile.is_empty()
            || [&request.home, &request.cargo_home, &request.rustup_home]
                .into_iter()
                .flatten()
                .any(|value| !Path::new(value).is_absolute() || value.chars().any(char::is_control))
            || [
                &request.executable,
                &request.cwd,
                &request.scratch,
                &request.profile,
                &request.path,
            ]
            .into_iter()
            .chain(&request.args)
            .any(|value| value.contains('\0'))
        {
            return Err(io::Error::other("invalid launch request"));
        }
        Ok(request)
    }

    // The SDK takes a POSIX command line. Quote each argument independently.
    pub fn command(&self) -> String {
        let mut command = String::from("exec");
        for argument in std::iter::once(&self.executable).chain(&self.args) {
            command.push_str(" '");
            command.push_str(&argument.replace('\'', "'\\''"));
            command.push('\'');
        }
        command
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn framed_request_preserves_distinct_arguments() {
        #[cfg(windows)]
        let (executable, cwd, scratch) = (r"C:\bin\echo.exe", r"C:\tmp", r"C:\tmp\scratch");
        #[cfg(not(windows))]
        let (executable, cwd, scratch) = ("/bin/echo", "/tmp", "/tmp/scratch");
        let mut request = serde_json::json!({
            "version": VERSION,
            "executable": executable,
            "args": ["", "a b", "x'$(id)"],
            "cwd": cwd,
            "profile": "fixture",
            "path": "",
            "scratch": scratch,
        });
        let frame = format!("{request}\n");
        assert_eq!(
            LaunchRequest::read(frame.as_bytes()).unwrap().command(),
            format!("exec '{executable}' '' 'a b' 'x'\\''$(id)'")
        );
        assert!(LaunchRequest::read(frame.trim_end().as_bytes()).is_err());
        request["version"] = (VERSION + 1).into();
        let unsupported_frame = format!("{request}\n");
        assert!(LaunchRequest::read(unsupported_frame.as_bytes()).is_err());
    }
}
