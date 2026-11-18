use serde::{Deserialize, Serialize};
use std::io::{self, BufRead, BufReader, Read};
use std::path::Path;

pub const VERSION: u8 = 1;
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
        let frame = b"{\"version\":1,\"executable\":\"/bin/echo\",\"args\":[\"\",\"a b\",\"x'$(id)\"],\"cwd\":\"/tmp\",\"profile\":\"fixture\",\"path\":\"/bin\",\"scratch\":\"/tmp/a\"}\n";
        assert_eq!(
            LaunchRequest::read(&frame[..]).unwrap().command(),
            "exec '/bin/echo' '' 'a b' 'x'\\''$(id)'"
        );
        assert!(LaunchRequest::read(&frame[..frame.len() - 1]).is_err());
        assert!(LaunchRequest::read(&b"{\"version\":2}\n"[..]).is_err());
    }
}
