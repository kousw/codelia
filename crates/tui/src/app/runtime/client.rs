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

pub fn spawn_runtime() -> RuntimeSpawnResult {
    let runtime_cmd = env::var("CODELIA_RUNTIME_CMD").unwrap_or_else(|_| "bun".to_string());
    let runtime_args = env::var("CODELIA_RUNTIME_ARGS")
        .map(|value| split_args(&value))
        .unwrap_or_else(|_| vec!["packages/runtime/src/index.ts".to_string()]);

    let mut child = Command::new(runtime_cmd)
        .args(runtime_args)
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()?;

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
    use super::split_args;
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
}
