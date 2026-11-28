use std::env;
use std::fs;
use std::path::{Path, PathBuf};
use std::process::Command;

fn git_dir() -> Option<PathBuf> {
    let manifest_dir = PathBuf::from(env::var("CARGO_MANIFEST_DIR").ok()?);
    let repo_root = manifest_dir.parent()?.parent()?;
    let dot_git = repo_root.join(".git");
    if dot_git.is_dir() {
        return Some(dot_git);
    }
    if dot_git.is_file() {
        let content = fs::read_to_string(&dot_git).ok()?;
        let rel = content.trim().strip_prefix("gitdir:")?.trim();
        let path = Path::new(rel);
        return Some(if path.is_absolute() {
            path.to_path_buf()
        } else {
            repo_root.join(path)
        });
    }
    None
}

fn emit_git_rerun_hints(git_dir: &Path) {
    let head_path = git_dir.join("HEAD");
    if head_path.exists() {
        println!("cargo:rerun-if-changed={}", head_path.display());
        if let Ok(head) = fs::read_to_string(&head_path) {
            if let Some(ref_name) = head.trim().strip_prefix("ref:") {
                let ref_path = git_dir.join(ref_name.trim());
                if ref_path.exists() {
                    println!("cargo:rerun-if-changed={}", ref_path.display());
                }
                let packed = git_dir.join("packed-refs");
                if packed.exists() {
                    println!("cargo:rerun-if-changed={}", packed.display());
                }
            }
        }
    }
}

fn is_hex_sha(value: &str) -> bool {
    (7..=40).contains(&value.len()) && value.bytes().all(|b| b.is_ascii_hexdigit())
}

fn read_head_sha_from_git_dir(git_dir: &Path) -> Option<String> {
    let head = fs::read_to_string(git_dir.join("HEAD")).ok()?;
    let head = head.trim();
    if is_hex_sha(head) {
        return Some(head.chars().take(8).collect());
    }
    let ref_name = head.strip_prefix("ref:")?.trim();
    let ref_path = git_dir.join(ref_name);
    if let Ok(sha) = fs::read_to_string(&ref_path) {
        let sha = sha.trim();
        if is_hex_sha(sha) {
            return Some(sha.chars().take(8).collect());
        }
    }
    if let Ok(packed) = fs::read_to_string(git_dir.join("packed-refs")) {
        for line in packed.lines() {
            let line = line.trim();
            if line.is_empty() || line.starts_with('#') || line.starts_with('^') {
                continue;
            }
            let mut parts = line.split_whitespace();
            if let (Some(sha), Some(name)) = (parts.next(), parts.next()) {
                if name == ref_name && is_hex_sha(sha) {
                    return Some(sha.chars().take(8).collect());
                }
            }
        }
    }
    None
}

fn resolve_dev_build_id(git_dir: Option<&Path>) -> String {
    if env::var("CI").as_deref() == Ok("true")
        || env::var("CODELIA_RELEASE_BUILD").as_deref() == Ok("1")
    {
        return String::new();
    }
    let sha = git_dir.and_then(read_head_sha_from_git_dir).or_else(|| {
        Command::new("git")
            .args(["rev-parse", "--short=8", "HEAD"])
            .output()
            .ok()
            .filter(|out| out.status.success())
            .map(|out| String::from_utf8_lossy(&out.stdout).trim().to_string())
            .filter(|value| !value.is_empty())
    });
    let Some(sha) = sha else {
        return String::new();
    };
    let dirty = Command::new("git")
        .args(["status", "--porcelain", "--untracked-files=no"])
        .output()
        .ok()
        .is_some_and(|out| {
            out.status.success() && !String::from_utf8_lossy(&out.stdout).trim().is_empty()
        });
    if dirty {
        format!("{sha}-dirty")
    } else {
        sha
    }
}

fn main() {
    println!("cargo:rerun-if-env-changed=CI");
    println!("cargo:rerun-if-env-changed=CODELIA_RELEASE_BUILD");
    let dir = git_dir();
    if let Some(dir) = dir.as_deref() {
        emit_git_rerun_hints(dir);
    }
    println!(
        "cargo:rustc-env=CODELIA_TUI_BUILD={}",
        resolve_dev_build_id(dir.as_deref())
    );
}
