#[cfg(any(target_os = "macos", target_os = "linux", test))]
mod request;

#[cfg(any(target_os = "macos", target_os = "linux"))]
mod unix;

#[cfg(target_os = "macos")]
mod darwin;
#[cfg(target_os = "macos")]
use darwin as platform;

#[cfg(target_os = "linux")]
mod linux;
#[cfg(target_os = "linux")]
use linux as platform;

fn main() -> std::process::ExitCode {
    #[cfg(any(target_os = "macos", target_os = "linux"))]
    return unix::main();

    #[cfg(not(any(target_os = "macos", target_os = "linux")))]
    {
        eprintln!("codelia-mxc: this platform is not qualified");
        std::process::ExitCode::from(125)
    }
}
