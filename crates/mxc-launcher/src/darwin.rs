use crate::request::{LaunchRequest, VERSION};
use crate::unix::build_environment;
use mxc_sdk::v1::{
    self, ContainerRequest, Containment, MxcProcess, SpawnExtendedOptions, SpawnStdio,
    configs::SeatbeltConfig,
};
use std::io;

pub fn launch(request: LaunchRequest) -> io::Result<MxcProcess> {
    let profile = request
        .profile
        .clone()
        .ok_or_else(|| io::Error::other("missing Seatbelt profile"))?;
    let environment = build_environment(&request);
    let mut container = ContainerRequest::new(request.command());
    container.working_directory = Some(request.cwd);
    container.inherit_default_environment = Some(false);
    container.environment = Some(environment);
    let mut seatbelt = SeatbeltConfig::default();
    seatbelt.profile_override = Some(profile);
    container.containment = Containment::Seatbelt(seatbelt);
    let mut options = SpawnExtendedOptions::default();
    options.stdio = SpawnStdio::Inherit;
    v1::spawn_with_extended_options(container, options)
        .map_err(|_| io::Error::other("MXC could not admit the native launch"))
}

pub fn probe_request() -> LaunchRequest {
    LaunchRequest {
        version: VERSION,
        executable: "/usr/bin/true".into(),
        args: vec![],
        cwd: "/".into(),
        scratch: "/private/tmp".into(),
        path: "/usr/bin:/bin".into(),
        home: Some("/private/tmp".into()),
        cargo_home: None,
        rustup_home: None,
        profile: Some(
            "(version 1)(deny default)(allow process-exec process-fork file-read* sysctl-read)(deny network*)"
                .into(),
        ),
        filesystem: None,
    }
}
