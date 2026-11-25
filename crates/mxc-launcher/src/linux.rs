use crate::request::{FilesystemSpec, LaunchRequest, VERSION};
use crate::unix::build_environment_with_path;
use mxc_sdk::v1::{
    self, ContainerRequest, Containment, FilesystemPolicy, MxcProcess, NetworkAction,
    NetworkEgressPolicy, NetworkIngressPolicy, NetworkPolicy, SpawnExtendedOptions, SpawnStdio,
};
use std::fs;
use std::io;
use std::os::unix::fs::MetadataExt;
use std::path::{Path, PathBuf};

const BWRAP_CANDIDATES: &[&str] = &[
    "/usr/bin/bwrap",
    "/bin/bwrap",
    "/usr/local/bin/bwrap",
    "/run/current-system/sw/bin/bwrap",
];

fn validate_trusted_bwrap(candidate: &Path) -> io::Result<PathBuf> {
    if !candidate.is_absolute()
        || candidate.file_name().and_then(|name| name.to_str()) != Some("bwrap")
    {
        return Err(io::Error::other("invalid bwrap candidate"));
    }
    let resolved = fs::canonicalize(candidate)?;
    if resolved.file_name().and_then(|name| name.to_str()) != Some("bwrap") {
        return Err(io::Error::other("bwrap target name mismatch"));
    }
    let mut current: &Path = &resolved;
    loop {
        let meta = fs::metadata(current)?;
        if meta.uid() != 0 || (meta.mode() & 0o022) != 0 {
            return Err(io::Error::other("untrusted bwrap installation"));
        }
        if current == resolved && (!meta.is_file() || (meta.mode() & 0o111) == 0) {
            return Err(io::Error::other("bwrap is not executable"));
        }
        match current.parent() {
            Some(parent) if parent != current => current = parent,
            _ => return Ok(resolved),
        }
    }
}

fn resolve_trusted_bwrap(explicit: Option<&str>) -> io::Result<PathBuf> {
    if let Some(candidate) = explicit {
        return validate_trusted_bwrap(Path::new(candidate));
    }
    for candidate in BWRAP_CANDIDATES {
        if let Ok(resolved) = validate_trusted_bwrap(Path::new(candidate)) {
            return Ok(resolved);
        }
    }
    Err(io::Error::other("no trusted bwrap installation found"))
}

pub fn worker_path_env(request: &LaunchRequest) -> io::Result<Option<String>> {
    let bwrap = resolve_trusted_bwrap(request.bwrap_path.as_deref())?;
    let parent = bwrap
        .parent()
        .and_then(|dir| dir.to_str())
        .ok_or_else(|| io::Error::other("invalid bwrap parent directory"))?;
    Ok(Some(parent.to_string()))
}

pub fn launch(request: LaunchRequest) -> io::Result<MxcProcess> {
    let filesystem = request
        .filesystem
        .clone()
        .ok_or_else(|| io::Error::other("missing Bubblewrap filesystem policy"))?;
    // Defense-in-depth: re-verify bwrap before delegating to mxc-sdk.
    let _ = resolve_trusted_bwrap(request.bwrap_path.as_deref())?;
    // Pin container PATH to standard system directories so Bubblewrap's
    // `execvp("sh", ...)` cannot resolve a workspace-controlled `sh`. The
    // workload's actual PATH is exported inside the trusted system shell right
    // before `exec`.
    let environment = build_environment_with_path(&request, "/usr/bin:/bin".to_string());
    let mut container = ContainerRequest::new(request.command_with_workload_path());
    container.working_directory = Some(request.cwd);
    container.inherit_default_environment = Some(false);
    container.environment = Some(environment);
    container.containment = Containment::Bubblewrap;
    container.filesystem = Some(FilesystemPolicy {
        readwrite_paths: filesystem.readwrite_paths,
        readonly_paths: filesystem.readonly_paths,
        denied_paths: filesystem.denied_paths,
        clear_policy_on_exit: Some(true),
    });
    container.network = Some(NetworkPolicy {
        egress: Some(NetworkEgressPolicy {
            default: Some(NetworkAction::Deny),
            allow: None,
            deny: None,
        }),
        ingress: Some(NetworkIngressPolicy {
            default: Some(NetworkAction::Deny),
            host_loopback: Some(NetworkAction::Deny),
        }),
        runtime_config: None,
    });
    let mut options = SpawnExtendedOptions::default();
    options.stdio = SpawnStdio::Inherit;
    v1::spawn_with_extended_options(container, options)
        .map_err(|_| io::Error::other("MXC could not admit the native launch"))
}

pub fn probe_request(bwrap_path: Option<String>) -> LaunchRequest {
    let executable = if Path::new("/usr/bin/true").exists() {
        "/usr/bin/true"
    } else {
        "/bin/true"
    };
    LaunchRequest {
        version: VERSION,
        executable: executable.into(),
        args: vec![],
        cwd: "/".into(),
        scratch: "/tmp".into(),
        path: "/usr/bin:/bin".into(),
        home: Some("/tmp".into()),
        cargo_home: None,
        rustup_home: None,
        profile: None,
        filesystem: Some(FilesystemSpec {
            readwrite_paths: vec![],
            readonly_paths: vec![],
            denied_paths: vec![],
        }),
        bwrap_path,
    }
}
