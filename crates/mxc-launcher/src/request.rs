use serde::{Deserialize, Serialize};
use std::io::{self, BufRead, BufReader, Read};
use std::path::{Component, Path};

pub const VERSION: u8 = 2;
const MAX_REQUEST_BYTES: u64 = 256 * 1024;

#[derive(Deserialize, Serialize, Debug, Clone, PartialEq, Eq)]
#[serde(deny_unknown_fields)]
pub struct FilesystemSpec {
    #[serde(default)]
    pub readwrite_paths: Vec<String>,
    #[serde(default)]
    pub readonly_paths: Vec<String>,
    #[serde(default)]
    pub denied_paths: Vec<String>,
}

impl FilesystemSpec {
    fn is_valid(&self) -> bool {
        self.readwrite_paths
            .iter()
            .chain(&self.readonly_paths)
            .chain(&self.denied_paths)
            .all(|value| valid_policy_path(value))
    }
}

fn valid_policy_path(value: &str) -> bool {
    if value.is_empty() || value.chars().any(char::is_control) {
        return false;
    }
    if value
        .split(['/', '\\'])
        .any(|segment| segment == "." || segment == "..")
    {
        return false;
    }
    let path = Path::new(value);
    if !path.is_absolute() {
        return false;
    }
    let mut has_normal = false;
    for component in path.components() {
        match component {
            Component::CurDir | Component::ParentDir => return false,
            Component::Normal(_) => has_normal = true,
            Component::RootDir | Component::Prefix(_) => {}
        }
    }
    // Never accept bare filesystem roots (e.g. "/" or "C:\").
    has_normal
}

#[derive(Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
pub struct LaunchRequest {
    pub version: u8,
    pub executable: String,
    pub args: Vec<String>,
    pub cwd: String,
    /// macOS Seatbelt SBPL profile. Mutually exclusive with `filesystem`.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub profile: Option<String>,
    /// Linux Bubblewrap filesystem policy. Mutually exclusive with `profile`.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub filesystem: Option<FilesystemSpec>,
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
        let valid_containment = match (&request.profile, &request.filesystem) {
            (Some(profile), None) => !profile.is_empty() && !profile.contains('\0'),
            (None, Some(filesystem)) => filesystem.is_valid(),
            _ => false,
        };
        if request.version != VERSION
            || !valid_containment
            || [&request.executable, &request.cwd, &request.scratch]
                .iter()
                .any(|value| !Path::new(value).is_absolute())
            || [&request.home, &request.cargo_home, &request.rustup_home]
                .into_iter()
                .flatten()
                .any(|value| !Path::new(value).is_absolute() || value.chars().any(char::is_control))
            || [
                &request.executable,
                &request.cwd,
                &request.scratch,
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

    fn fixture_paths() -> (&'static str, &'static str, &'static str, &'static str) {
        #[cfg(windows)]
        {
            (r"C:\bin\echo.exe", r"C:\tmp", r"C:\tmp\scratch", r"C:\work")
        }
        #[cfg(not(windows))]
        {
            ("/bin/echo", "/tmp", "/tmp/scratch", "/work")
        }
    }

    #[test]
    fn framed_request_preserves_distinct_arguments() {
        let (executable, cwd, scratch, _) = fixture_paths();
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

    #[test]
    fn filesystem_request_validates_paths_and_mutual_exclusivity() {
        let (executable, cwd, scratch, work) = fixture_paths();
        let valid = serde_json::json!({
            "version": VERSION,
            "executable": executable,
            "args": [],
            "cwd": cwd,
            "filesystem": {
                "readwrite_paths": [work, scratch],
                "readonly_paths": [cwd],
                "denied_paths": [],
            },
            "path": "",
            "scratch": scratch,
        });
        let parsed = LaunchRequest::read(format!("{valid}\n").as_bytes()).unwrap();
        assert!(parsed.profile.is_none());
        assert_eq!(parsed.filesystem.unwrap().readwrite_paths, vec![work, scratch]);

        // Both profile and filesystem specified -> rejected.
        let mut both = valid.clone();
        both["profile"] = "fixture".into();
        assert!(LaunchRequest::read(format!("{both}\n").as_bytes()).is_err());

        // Neither profile nor filesystem -> rejected.
        let mut neither = valid.clone();
        neither.as_object_mut().unwrap().remove("filesystem");
        assert!(LaunchRequest::read(format!("{neither}\n").as_bytes()).is_err());

        // Root, relative, traversal, and control-char policy paths -> rejected.
        #[cfg(windows)]
        let invalid_paths = [r"C:\", "relative", r"C:\work\..\secret", "C:\\work\nline"];
        #[cfg(not(windows))]
        let invalid_paths = ["/", "relative", "/work/../secret", "/work/./sub", "/work\nline"];
        for bad in invalid_paths {
            let mut mutated = valid.clone();
            mutated["filesystem"]["readonly_paths"] = serde_json::json!([bad]);
            assert!(
                LaunchRequest::read(format!("{mutated}\n").as_bytes()).is_err(),
                "expected invalid path to be rejected: {bad:?}"
            );
        }
    }
}
