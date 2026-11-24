use crate::request::{FilesystemSpec, LaunchRequest, VERSION};
use crate::unix::build_environment;
use mxc_sdk::v1::{
    self, ContainerRequest, Containment, FilesystemPolicy, MxcProcess, NetworkAction,
    NetworkEgressPolicy, NetworkIngressPolicy, NetworkPolicy, SpawnExtendedOptions, SpawnStdio,
};
use std::io;
use std::path::Path;

pub fn launch(request: LaunchRequest) -> io::Result<MxcProcess> {
    let filesystem = request
        .filesystem
        .clone()
        .ok_or_else(|| io::Error::other("missing Bubblewrap filesystem policy"))?;
    let environment = build_environment(&request);
    let mut container = ContainerRequest::new(request.command());
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

pub fn probe_request() -> LaunchRequest {
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
    }
}
