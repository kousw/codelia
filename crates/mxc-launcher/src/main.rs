#[cfg(any(target_os = "macos", test))]
mod request;

#[cfg(target_os = "macos")]
mod darwin;
fn main() -> std::process::ExitCode {
    #[cfg(target_os = "macos")]
    return darwin::main();

    #[cfg(not(target_os = "macos"))]
    {
        eprintln!("codelia-mxc: this platform is not qualified");
        std::process::ExitCode::from(125)
    }
}
