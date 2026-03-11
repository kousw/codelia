#[cfg(target_os = "linux")]
use std::fs;

#[cfg(target_os = "macos")]
use libc::{c_int, proc_pid_rusage, rusage_info_v4, RUSAGE_INFO_V4};

#[cfg(target_os = "windows")]
use std::mem::size_of;
#[cfg(target_os = "windows")]
use windows_sys::Win32::Foundation::CloseHandle;
#[cfg(target_os = "windows")]
use windows_sys::Win32::System::ProcessStatus::{K32GetProcessMemoryInfo, PROCESS_MEMORY_COUNTERS};
#[cfg(target_os = "windows")]
use windows_sys::Win32::System::Threading::{
    OpenProcess, PROCESS_QUERY_LIMITED_INFORMATION, PROCESS_VM_READ,
};

#[derive(Debug, Clone, Copy, Default, PartialEq, Eq)]
pub(crate) struct PerfMemorySample {
    pub tui_rss_bytes: Option<u64>,
    pub runtime_rss_bytes: Option<u64>,
}

pub(crate) fn sample_memory(runtime_pid: Option<u32>) -> PerfMemorySample {
    PerfMemorySample {
        tui_rss_bytes: read_process_rss_bytes(std::process::id()),
        runtime_rss_bytes: runtime_pid.and_then(read_process_rss_bytes),
    }
}

#[cfg(target_os = "linux")]
fn read_process_rss_bytes(pid: u32) -> Option<u64> {
    let status_path = format!("/proc/{pid}/status");
    let status = fs::read_to_string(status_path).ok()?;
    parse_linux_status_rss_bytes(&status)
}

#[cfg(target_os = "macos")]
fn read_process_rss_bytes(pid: u32) -> Option<u64> {
    let mut info = std::mem::MaybeUninit::<rusage_info_v4>::zeroed();
    let rc = unsafe {
        proc_pid_rusage(
            pid as c_int,
            RUSAGE_INFO_V4,
            info.as_mut_ptr() as _,
        )
    };
    if rc != 0 {
        return None;
    }
    let info = unsafe { info.assume_init() };
    Some(info.ri_resident_size)
}

#[cfg(target_os = "windows")]
fn read_process_rss_bytes(pid: u32) -> Option<u64> {
    unsafe {
        let handle = OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION | PROCESS_VM_READ, 0, pid);
        if handle.is_null() {
            return None;
        }

        let mut counters = PROCESS_MEMORY_COUNTERS {
            cb: size_of::<PROCESS_MEMORY_COUNTERS>() as u32,
            ..Default::default()
        };
        let ok = K32GetProcessMemoryInfo(handle, &mut counters, counters.cb);
        let _ = CloseHandle(handle);
        if ok == 0 {
            return None;
        }
        Some(counters.WorkingSetSize as u64)
    }
}

#[cfg(not(any(target_os = "linux", target_os = "macos", target_os = "windows")))]
fn read_process_rss_bytes(_: u32) -> Option<u64> {
    None
}

#[cfg(target_os = "linux")]
fn parse_linux_status_rss_bytes(status: &str) -> Option<u64> {
    let line = status.lines().find(|line| line.starts_with("VmRSS:"))?;
    let value = line.split_ascii_whitespace().nth(1)?.parse::<u64>().ok()?;
    value.checked_mul(1024)
}

#[cfg(test)]
mod tests {
    #[cfg(target_os = "linux")]
    use super::parse_linux_status_rss_bytes;

    #[cfg(target_os = "linux")]
    #[test]
    fn parse_linux_status_rss_extracts_kib_value() {
        let status = "Name:\tcodelia-tui\nVmRSS:\t   12345 kB\nThreads:\t7\n";
        assert_eq!(parse_linux_status_rss_bytes(status), Some(12_641_280));
    }

    #[cfg(target_os = "linux")]
    #[test]
    fn parse_linux_status_rss_returns_none_when_missing() {
        let status = "Name:\tcodelia-tui\nThreads:\t7\n";
        assert_eq!(parse_linux_status_rss_bytes(status), None);
    }
}
