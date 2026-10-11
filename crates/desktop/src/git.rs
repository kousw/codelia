use anyhow::{Context, Result, bail};
use std::{
    io::Read,
    path::{Path, PathBuf},
    process::{Command, Stdio},
};

#[derive(Default)]
pub struct GitSnapshot {
    pub error: Option<String>,
    pub branch: String,
    pub status: String,
    pub diff: String,
    pub worktrees: Vec<PathBuf>,
}

fn read(root: &Path, args: &[&str]) -> Result<String> {
    let mut child = Command::new("git")
        .arg("--no-optional-locks")
        .arg("-C")
        .arg(root)
        .args(args)
        .stdout(Stdio::piped())
        .stderr(Stdio::null())
        .spawn()?;
    let mut bytes = vec![];
    child
        .stdout
        .take()
        .context("Missing git output")?
        .take(1024 * 1024 + 1)
        .read_to_end(&mut bytes)?;
    if bytes.len() > 1024 * 1024 {
        let _ = child.kill();
        let _ = child.wait();
        bail!("Diff exceeds 1 MiB; inspect with git locally")
    }
    if !child.wait()?.success() {
        bail!("Git read failed; this folder may not be a repository")
    }
    Ok(String::from_utf8_lossy(&bytes).into_owned())
}

pub fn snapshot(root: &Path) -> Result<GitSnapshot> {
    let branch = read(root, &["branch", "--show-current"])?;
    let status = read(root, &["status", "--short"])?;
    let diff = read(root, &["diff", "HEAD", "--no-ext-diff", "--no-color"])?;
    let worktree_output = read(root, &["worktree", "list", "--porcelain"])?;
    let worktrees = worktree_output
        .lines()
        .filter_map(|line| line.strip_prefix("worktree ").map(PathBuf::from))
        .collect();
    Ok(GitSnapshot {
        error: None,
        branch: if branch.trim().is_empty() {
            "detached HEAD".into()
        } else {
            branch.trim().into()
        },
        status,
        diff,
        worktrees,
    })
}
