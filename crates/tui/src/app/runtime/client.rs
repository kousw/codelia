use serde_json::{json, Value};
use std::env;
use std::io::{BufRead, BufReader, BufWriter, Write};
use std::process::{Child, Command, Stdio};
use std::sync::mpsc::{self, Receiver};
use std::thread;

fn split_args(value: &str) -> Vec<String> {
    match shell_words::split(value) {
        Ok(parts) => parts.into_iter().filter(|part| !part.is_empty()).collect(),
        Err(error) => {
            if !cfg!(test) {
                let _ = writeln!(
                    std::io::stderr(),
                    "[codelia-tui] CODELIA_RUNTIME_ARGS parse warning ({error}); falling back to whitespace split"
                );
            }
            value
                .split_whitespace()
                .filter(|part| !part.is_empty())
                .map(|part| part.to_string())
                .collect()
        }
    }
}

type RuntimeSpawn = (Child, BufWriter<std::process::ChildStdin>, Receiver<String>);
type RuntimeSpawnResult = Result<RuntimeSpawn, Box<dyn std::error::Error>>;

fn json_line(value: Value) -> String {
    value.to_string() + "\n"
}

fn spawn_reader<T: std::io::Read + Send + 'static>(
    reader: T,
    prefix: Option<&'static str>,
    tx: mpsc::Sender<String>,
) {
    thread::spawn(move || {
        let mut reader = BufReader::new(reader);
        let mut line = String::new();
        loop {
            line.clear();
            match reader.read_line(&mut line) {
                Ok(0) => break,
                Ok(_) => {
                    let trimmed = line.trim_end();
                    if trimmed.is_empty() {
                        continue;
                    }
                    let output = if let Some(tag) = prefix {
                        if trimmed.starts_with(tag) {
                            trimmed.to_string()
                        } else {
                            format!("{tag} {trimmed}")
                        }
                    } else {
                        trimmed.to_string()
                    };
                    let _ = tx.send(output);
                }
                Err(_) => break,
            }
        }
    });
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum RuntimeTransportMode {
    Local,
    Ssh,
}

fn resolve_transport_mode() -> RuntimeTransportMode {
    match env::var("CODELIA_RUNTIME_TRANSPORT") {
        Ok(value) if value.trim().eq_ignore_ascii_case("ssh") => RuntimeTransportMode::Ssh,
        _ => RuntimeTransportMode::Local,
    }
}

fn build_local_runtime_command() -> Command {
    let runtime_cmd = env::var("CODELIA_RUNTIME_CMD").unwrap_or_else(|_| "bun".to_string());
    let runtime_args = env::var("CODELIA_RUNTIME_ARGS")
        .map(|value| split_args(&value))
        .unwrap_or_else(|_| vec!["packages/runtime/src/index.ts".to_string()]);

    let mut command = Command::new(runtime_cmd);
    command.args(runtime_args);
    command
}

fn shell_join(parts: &[String]) -> String {
    parts
        .iter()
        .map(|part| shell_words::quote(part).to_string())
        .collect::<Vec<_>>()
        .join(" ")
}

#[derive(Clone, Debug, PartialEq, Eq)]
struct RemoteBootstrapOptions {
    target_cli_version: Option<String>,
    ready_timeout_sec: u64,
}

fn sanitize_cli_version_for_npm(value: &str) -> Option<String> {
    let trimmed = value.trim();
    if trimmed.is_empty() {
        return None;
    }
    let valid = trimmed
        .chars()
        .all(|ch| ch.is_ascii_alphanumeric() || matches!(ch, '.' | '-' | '+' | '_'));
    if valid {
        Some(trimmed.to_string())
    } else {
        None
    }
}

fn resolve_remote_bootstrap_options() -> RemoteBootstrapOptions {
    let target_cli_version = env::var("CODELIA_CLI_VERSION")
        .ok()
        .and_then(|value| sanitize_cli_version_for_npm(&value));
    let ready_timeout_sec = env::var("CODELIA_RUNTIME_REMOTE_READY_TIMEOUT_SEC")
        .ok()
        .and_then(|value| value.trim().parse::<u64>().ok())
        .filter(|value| *value > 0)
        .unwrap_or(120);
    RemoteBootstrapOptions {
        target_cli_version,
        ready_timeout_sec,
    }
}

fn build_remote_bootstrap_script(
    remote_exec: &str,
    remote_cwd: Option<&str>,
    options: &RemoteBootstrapOptions,
) -> String {
    let mut lines = vec![
        "set -eu".to_string(),
        "log_bootstrap() { printf '%s\\n' \"[bootstrap] $1\" >&2; }".to_string(),
    ];

    if let Some(cwd) = remote_cwd {
        lines.push(format!(
            "log_bootstrap \"changing directory: {}\"",
            cwd.replace('"', "\\\"")
        ));
        lines.push(format!("cd {}", shell_words::quote(cwd)));
    }

    lines.push("if command -v codelia >/dev/null 2>&1; then".to_string());
    lines.push("  log_bootstrap \"found codelia on remote host\"".to_string());
    lines.push("else".to_string());
    lines.push("  if ! command -v npm >/dev/null 2>&1; then".to_string());
    lines.push("    log_bootstrap \"npm is required to install @codelia/cli\"".to_string());
    lines.push("    exit 1".to_string());
    lines.push("  fi".to_string());
    let install_target = options
        .target_cli_version
        .as_ref()
        .map(|version| format!("@codelia/cli@{version}"))
        .unwrap_or_else(|| "@codelia/cli".to_string());
    lines.push(format!(
        "  log_bootstrap \"installing {}\"",
        install_target.replace('"', "\\\"")
    ));
    lines.push(format!(
        "  npm install -g {}",
        shell_words::quote(&install_target)
    ));
    lines.push("fi".to_string());
    lines.push(format!(
        "deadline=$(( $(date +%s) + {} ))",
        options.ready_timeout_sec
    ));
    lines.push("while true; do".to_string());
    lines.push(
        "  if command -v codelia >/dev/null 2>&1 && codelia --version >/dev/null 2>&1; then"
            .to_string(),
    );
    lines.push("    log_bootstrap \"codelia ready\"".to_string());
    lines.push("    break".to_string());
    lines.push("  fi".to_string());
    lines.push("  if [ \"$(date +%s)\" -ge \"$deadline\" ]; then".to_string());
    lines.push("    log_bootstrap \"timed out waiting for codelia command\"".to_string());
    lines.push("    exit 1".to_string());
    lines.push("  fi".to_string());
    lines.push("  sleep 1".to_string());
    lines.push("done".to_string());
    lines.push("log_bootstrap \"starting runtime command\"".to_string());
    lines.push(format!("exec {remote_exec}"));

    lines.join("; ")
}

fn build_ssh_runtime_command() -> Result<Command, Box<dyn std::error::Error>> {
    let host = env::var("CODELIA_RUNTIME_SSH_HOST")
        .map(|value| value.trim().to_string())
        .ok()
        .filter(|value| !value.is_empty())
        .ok_or_else(|| {
            "CODELIA_RUNTIME_SSH_HOST is required when runtime transport is ssh".to_string()
        })?;

    let remote_cmd_raw = env::var("CODELIA_RUNTIME_REMOTE_CMD")
        .ok()
        .filter(|value| !value.trim().is_empty())
        .unwrap_or_else(|| "bun packages/runtime/src/index.ts".to_string());
    let remote_cmd_parts = split_args(&remote_cmd_raw);
    if remote_cmd_parts.is_empty() {
        return Err("CODELIA_RUNTIME_REMOTE_CMD resolved to an empty command".into());
    }

    let remote_exec = shell_join(&remote_cmd_parts);
    let remote_cwd = env::var("CODELIA_RUNTIME_REMOTE_CWD")
        .ok()
        .filter(|value| !value.trim().is_empty());
    let bootstrap_options = resolve_remote_bootstrap_options();
    let remote_script =
        build_remote_bootstrap_script(&remote_exec, remote_cwd.as_deref(), &bootstrap_options);

    let mut command = Command::new("ssh");
    command.arg("-T");

    let ssh_opts = env::var("CODELIA_RUNTIME_SSH_OPTS")
        .ok()
        .filter(|value| !value.trim().is_empty())
        .map(|value| split_args(&value))
        .unwrap_or_else(|| {
            vec![
                "-o".to_string(),
                "BatchMode=yes".to_string(),
                "-o".to_string(),
                "StrictHostKeyChecking=yes".to_string(),
                "-o".to_string(),
                "ServerAliveInterval=15".to_string(),
                "-o".to_string(),
                "ServerAliveCountMax=3".to_string(),
            ]
        });
    command.args(ssh_opts);
    command.arg(host);
    command.arg("sh");
    command.arg("-lc");
    command.arg(remote_script);
    Ok(command)
}

pub fn spawn_runtime(enable_diagnostics: bool) -> RuntimeSpawnResult {
    let mut command = match resolve_transport_mode() {
        RuntimeTransportMode::Local => build_local_runtime_command(),
        RuntimeTransportMode::Ssh => build_ssh_runtime_command()?,
    };

    command
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
    if enable_diagnostics {
        command.env("CODELIA_DIAGNOSTICS", "1");
    }
    let mut child = command.spawn()?;

    let child_stdin = BufWriter::new(child.stdin.take().expect("stdin missing"));
    let child_stdout = child.stdout.take().expect("stdout missing");
    let child_stderr = child.stderr.take().expect("stderr missing");
    let (tx, rx) = mpsc::channel::<String>();
    spawn_reader(child_stdout, None, tx.clone());
    spawn_reader(child_stderr, Some("[runtime]"), tx);

    Ok((child, child_stdin, rx))
}

pub fn send_initialize(
    writer: &mut BufWriter<std::process::ChildStdin>,
    id: &str,
) -> std::io::Result<()> {
    let msg = json!({
        "jsonrpc": "2.0",
        "id": id,
        "method": "initialize",
        "params": {
            "protocol_version": "0",
            "client": { "name": "codelia-tui", "version": "0.1.0" },
            "ui_capabilities": {
                "supports_confirm": true,
                "supports_prompt": true,
                "supports_pick": true,
                "supports_clipboard_read": true,
                "supports_permission_preflight_events": true
            }
        }
    });
    writer.write_all(json_line(msg).as_bytes())?;
    writer.flush()?;
    Ok(())
}

pub fn send_confirm_response(
    writer: &mut BufWriter<std::process::ChildStdin>,
    id: &str,
    ok: bool,
    remember: bool,
    reason: Option<&str>,
) -> std::io::Result<()> {
    let msg = json!({
        "jsonrpc": "2.0",
        "id": id,
        "result": { "ok": ok, "remember": remember, "reason": reason }
    });
    writer.write_all(json_line(msg).as_bytes())?;
    writer.flush()?;
    Ok(())
}

pub fn send_prompt_response(
    writer: &mut BufWriter<std::process::ChildStdin>,
    id: &str,
    value: Option<&str>,
) -> std::io::Result<()> {
    let msg = json!({
        "jsonrpc": "2.0",
        "id": id,
        "result": { "value": value }
    });
    writer.write_all(json_line(msg).as_bytes())?;
    writer.flush()?;
    Ok(())
}

pub fn send_pick_response(
    writer: &mut BufWriter<std::process::ChildStdin>,
    id: &str,
    ids: &[String],
) -> std::io::Result<()> {
    let msg = json!({
        "jsonrpc": "2.0",
        "id": id,
        "result": { "ids": ids }
    });
    writer.write_all(json_line(msg).as_bytes())?;
    writer.flush()?;
    Ok(())
}

pub fn send_run_start(
    writer: &mut BufWriter<std::process::ChildStdin>,
    id: &str,
    session_id: Option<&str>,
    input: Value,
    force_compaction: bool,
) -> std::io::Result<()> {
    let mut params = serde_json::Map::new();
    params.insert("input".to_string(), input);
    if let Some(session_id) = session_id {
        params.insert("session_id".to_string(), json!(session_id));
    }
    if force_compaction {
        params.insert("force_compaction".to_string(), json!(true));
    }
    let msg = json!({
        "jsonrpc": "2.0",
        "id": id,
        "method": "run.start",
        "params": params
    });
    writer.write_all(json_line(msg).as_bytes())?;
    writer.flush()?;
    Ok(())
}

pub fn send_run_cancel(
    writer: &mut BufWriter<std::process::ChildStdin>,
    id: &str,
    run_id: &str,
    reason: Option<&str>,
) -> std::io::Result<()> {
    let mut params = serde_json::Map::new();
    params.insert("run_id".to_string(), json!(run_id));
    if let Some(reason) = reason {
        params.insert("reason".to_string(), json!(reason));
    }
    let msg = json!({
        "jsonrpc": "2.0",
        "id": id,
        "method": "run.cancel",
        "params": params
    });
    writer.write_all(json_line(msg).as_bytes())?;
    writer.flush()?;
    Ok(())
}

pub fn send_session_list(
    writer: &mut BufWriter<std::process::ChildStdin>,
    id: &str,
    limit: Option<usize>,
) -> std::io::Result<()> {
    let mut params = serde_json::Map::new();
    if let Some(limit) = limit {
        params.insert("limit".to_string(), json!(limit));
    }
    let msg = json!({
        "jsonrpc": "2.0",
        "id": id,
        "method": "session.list",
        "params": params
    });
    writer.write_all(json_line(msg).as_bytes())?;
    writer.flush()?;
    Ok(())
}

pub fn send_auth_logout(
    writer: &mut BufWriter<std::process::ChildStdin>,
    id: &str,
    clear_session: bool,
) -> std::io::Result<()> {
    let msg = json!({
        "jsonrpc": "2.0",
        "id": id,
        "method": "auth.logout",
        "params": { "clear_session": clear_session }
    });
    writer.write_all(json_line(msg).as_bytes())?;
    writer.flush()?;
    Ok(())
}

pub fn send_model_list(
    writer: &mut BufWriter<std::process::ChildStdin>,
    id: &str,
    provider: Option<&str>,
    include_details: bool,
) -> std::io::Result<()> {
    let mut params = serde_json::Map::new();
    if let Some(provider) = provider {
        params.insert("provider".to_string(), json!(provider));
    }
    params.insert("include_details".to_string(), json!(include_details));
    let msg = json!({
        "jsonrpc": "2.0",
        "id": id,
        "method": "model.list",
        "params": params
    });
    writer.write_all(json_line(msg).as_bytes())?;
    writer.flush()?;
    Ok(())
}

pub fn send_model_set(
    writer: &mut BufWriter<std::process::ChildStdin>,
    id: &str,
    provider: Option<&str>,
    model: &str,
) -> std::io::Result<()> {
    let mut params = serde_json::Map::new();
    params.insert("name".to_string(), json!(model));
    if let Some(provider) = provider {
        params.insert("provider".to_string(), json!(provider));
    }
    let msg = json!({
        "jsonrpc": "2.0",
        "id": id,
        "method": "model.set",
        "params": params
    });
    writer.write_all(json_line(msg).as_bytes())?;
    writer.flush()?;
    Ok(())
}

pub fn send_theme_set(
    writer: &mut BufWriter<std::process::ChildStdin>,
    id: &str,
    name: &str,
) -> std::io::Result<()> {
    let msg = json!({
        "jsonrpc": "2.0",
        "id": id,
        "method": "theme.set",
        "params": { "name": name }
    });
    writer.write_all(json_line(msg).as_bytes())?;
    writer.flush()?;
    Ok(())
}

pub fn send_shell_exec(
    writer: &mut BufWriter<std::process::ChildStdin>,
    id: &str,
    command: &str,
    timeout_seconds: Option<u64>,
) -> std::io::Result<()> {
    let mut params = serde_json::Map::new();
    params.insert("command".to_string(), json!(command));
    if let Some(timeout_seconds) = timeout_seconds {
        params.insert("timeout_seconds".to_string(), json!(timeout_seconds));
    }
    let msg = json!({
        "jsonrpc": "2.0",
        "id": id,
        "method": "shell.exec",
        "params": params
    });
    writer.write_all(json_line(msg).as_bytes())?;
    writer.flush()?;
    Ok(())
}

pub fn send_tool_call(
    writer: &mut BufWriter<std::process::ChildStdin>,
    id: &str,
    name: &str,
    arguments: Value,
) -> std::io::Result<()> {
    let msg = json!({
        "jsonrpc": "2.0",
        "id": id,
        "method": "tool.call",
        "params": {
            "name": name,
            "arguments": arguments
        }
    });
    writer.write_all(json_line(msg).as_bytes())?;
    writer.flush()?;
    Ok(())
}

pub fn send_mcp_list(
    writer: &mut BufWriter<std::process::ChildStdin>,
    id: &str,
    scope: Option<&str>,
) -> std::io::Result<()> {
    let mut params = serde_json::Map::new();
    if let Some(scope) = scope {
        params.insert("scope".to_string(), json!(scope));
    }
    let msg = json!({
        "jsonrpc": "2.0",
        "id": id,
        "method": "mcp.list",
        "params": params
    });
    writer.write_all(json_line(msg).as_bytes())?;
    writer.flush()?;
    Ok(())
}

pub fn send_context_inspect(
    writer: &mut BufWriter<std::process::ChildStdin>,
    id: &str,
    include_agents: bool,
    include_skills: bool,
) -> std::io::Result<()> {
    let msg = json!({
        "jsonrpc": "2.0",
        "id": id,
        "method": "context.inspect",
        "params": {
            "include_agents": include_agents,
            "include_skills": include_skills
        }
    });
    writer.write_all(json_line(msg).as_bytes())?;
    writer.flush()?;
    Ok(())
}

pub fn send_skills_list(
    writer: &mut BufWriter<std::process::ChildStdin>,
    id: &str,
    force_reload: bool,
) -> std::io::Result<()> {
    let msg = json!({
        "jsonrpc": "2.0",
        "id": id,
        "method": "skills.list",
        "params": { "force_reload": force_reload }
    });
    writer.write_all(json_line(msg).as_bytes())?;
    writer.flush()?;
    Ok(())
}

pub fn send_session_history(
    writer: &mut BufWriter<std::process::ChildStdin>,
    id: &str,
    session_id: &str,
    max_runs: Option<usize>,
    max_events: Option<usize>,
) -> std::io::Result<()> {
    let mut params = serde_json::Map::new();
    params.insert("session_id".to_string(), json!(session_id));
    if let Some(max_runs) = max_runs {
        params.insert("max_runs".to_string(), json!(max_runs));
    }
    if let Some(max_events) = max_events {
        params.insert("max_events".to_string(), json!(max_events));
    }
    let msg = json!({
        "jsonrpc": "2.0",
        "id": id,
        "method": "session.history",
        "params": params
    });
    writer.write_all(json_line(msg).as_bytes())?;
    writer.flush()?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::{
        build_remote_bootstrap_script, json_line, sanitize_cli_version_for_npm, shell_join,
        split_args, RemoteBootstrapOptions,
    };
    use serde_json::json;

    #[test]
    fn split_args_supports_quoted_values() {
        let args = split_args("node script.js \"hello world\" --name='agent zero'");
        assert_eq!(
            args,
            vec!["node", "script.js", "hello world", "--name=agent zero"]
        );
    }

    #[test]
    fn split_args_falls_back_when_quotes_are_unbalanced() {
        let args = split_args("node \"unterminated");
        assert_eq!(args, vec!["node", "\"unterminated"]);
    }

    #[test]
    fn run_input_payload_text_shape_example() {
        let payload = json!({ "type": "text", "text": "hello" });
        assert_eq!(payload["type"], json!("text"));
    }

    #[test]
    fn run_input_payload_parts_shape_example() {
        let payload = json!({
            "type": "parts",
            "parts": [
                { "type": "text", "text": "hello" },
                {
                    "type": "image_url",
                    "image_url": {
                        "url": "data:image/png;base64,AAAA",
                        "media_type": "image/png",
                        "detail": "auto"
                    }
                }
            ]
        });
        assert_eq!(
            payload,
            json!({
                "type": "parts",
                "parts": [
                    {"type": "text", "text": "hello"},
                    {
                        "type": "image_url",
                        "image_url": {
                            "url": "data:image/png;base64,AAAA",
                            "media_type": "image/png",
                            "detail": "auto"
                        }
                    }
                ]
            })
        );
    }

    #[test]
    fn tool_call_payload_shape_example() {
        let payload = json!({
            "jsonrpc": "2.0",
            "id": "id-1",
            "method": "tool.call",
            "params": {
                "name": "lane_list",
                "arguments": {}
            }
        });
        let line = json_line(payload);
        assert!(line.contains("\"method\":\"tool.call\""));
        assert!(line.contains("\"name\":\"lane_list\""));
    }

    #[test]
    fn shell_join_quotes_unsafe_parts() {
        let joined = shell_join(&[
            "bun".to_string(),
            "packages/runtime/src/index.ts".to_string(),
            "--flag=value with space".to_string(),
        ]);
        assert!(joined.contains("'--flag=value with space'"));
    }

    #[test]
    fn sanitize_cli_version_for_npm_accepts_semver_like() {
        assert_eq!(
            sanitize_cli_version_for_npm(" 0.1.13 "),
            Some("0.1.13".to_string())
        );
        assert_eq!(
            sanitize_cli_version_for_npm("1.2.3-beta.1+build"),
            Some("1.2.3-beta.1+build".to_string())
        );
    }

    #[test]
    fn sanitize_cli_version_for_npm_rejects_invalid_chars() {
        assert_eq!(sanitize_cli_version_for_npm(""), None);
        assert_eq!(sanitize_cli_version_for_npm("latest && rm -rf /"), None);
    }

    #[test]
    fn build_remote_bootstrap_script_uses_versioned_install() {
        let script = build_remote_bootstrap_script(
            "bun packages/runtime/src/index.ts",
            Some("/srv/codelia"),
            &RemoteBootstrapOptions {
                target_cli_version: Some("0.1.13".to_string()),
                ready_timeout_sec: 45,
            },
        );
        assert!(script.contains("npm install -g "));
        assert!(script.contains("@codelia/cli@0.1.13"));
        assert!(script.contains("deadline=$(( $(date +%s) + 45 ))"));
        assert!(script.contains("cd /srv/codelia"));
        assert!(script.contains("[bootstrap]"));
        assert!(script.contains("exec bun packages/runtime/src/index.ts"));
    }

    #[test]
    fn build_remote_bootstrap_script_falls_back_to_unversioned_install() {
        let script = build_remote_bootstrap_script(
            "bun packages/runtime/src/index.ts",
            None,
            &RemoteBootstrapOptions {
                target_cli_version: None,
                ready_timeout_sec: 120,
            },
        );
        assert!(script.contains("npm install -g "));
        assert!(script.contains("@codelia/cli"));
        assert!(!script.contains("@codelia/cli@0."));
    }
}
