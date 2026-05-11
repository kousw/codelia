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

fn tui_client_tools() -> Value {
    json!([
        {
            "name": "tui_ask_user_choice",
            "description": "Ask the user to pick exactly one option in the TUI; use this instead of writing numbered choices in chat when asking the user to choose follow-up questions, suggestions, or next actions.",
            "approval": "never",
            "parameters": {
                "type": "object",
                "properties": {
                    "title": {
                        "type": "string",
                        "description": "Short dialog title, such as \"Choose next topic\"."
                    },
                    "message": {
                        "type": "string",
                        "description": "Optional one-sentence context shown above the choices."
                    },
                    "allow_none": {
                        "type": "boolean",
                        "description": "When true, append a fallback option for when none of the choices fit; selecting it returns selected_id=\"__none_of_these__\"."
                    },
                    "none_label": {
                        "type": "string",
                        "description": "Optional label for the allow_none fallback option. Default: \"None of these\"."
                    },
                    "none_description": {
                        "type": "string",
                        "description": "Optional description for the allow_none fallback option."
                    },
                    "allow_other": {
                        "type": "boolean",
                        "description": "When true, append an Other option for when the user wants a different path; selecting it returns selected_id=\"__other__\"."
                    },
                    "other_label": {
                        "type": "string",
                        "description": "Optional label for the allow_other fallback option. Default: \"Other\"."
                    },
                    "other_description": {
                        "type": "string",
                        "description": "Optional description for the allow_other fallback option."
                    },
                    "choices": {
                        "type": "array",
                        "description": "Candidate options for the user; keep labels short and put extra context in description.",
                        "items": {
                            "type": "object",
                            "properties": {
                                "id": {
                                    "type": "string",
                                    "description": "Stable machine-readable choice id returned as selected_id."
                                },
                                "label": {
                                    "type": "string",
                                    "description": "Short user-facing option label."
                                },
                                "description": {
                                    "type": "string",
                                    "description": "Optional brief explanation of what selecting this option means."
                                }
                            },
                            "required": ["id", "label"],
                            "additionalProperties": false
                        },
                        "minItems": 1
                    }
                },
                "required": ["title", "choices"],
                "additionalProperties": false
            }
        },
        {
            "name": "tui_open_selector",
            "description": "Show a read-only list panel in the TUI for scan-and-compare information; use this for candidate files, sessions, tools, or options that should be visible without asking the user to answer.",
            "approval": "never",
            "parameters": {
                "type": "object",
                "properties": {
                    "title": {
                        "type": "string",
                        "description": "Short panel title."
                    },
                    "header": {
                        "type": "string",
                        "description": "Optional column or summary header for the rows."
                    },
                    "items": {
                        "type": "array",
                        "description": "Rows to display; this panel is read-only and does not return a selection.",
                        "items": {
                            "type": "object",
                            "properties": {
                                "label": {
                                    "type": "string",
                                    "description": "Primary row text."
                                },
                                "detail": {
                                    "type": "string",
                                    "description": "Optional secondary text for the row."
                                }
                            },
                            "required": ["label"],
                            "additionalProperties": false
                        }
                    }
                },
                "required": ["title", "items"],
                "additionalProperties": false
            }
        },
        {
            "name": "tui_preview_artifact",
            "description": "Show a read-only artifact preview in the TUI; use this for substantial text, markdown, JSON, or diff content that would clutter the chat log.",
            "approval": "never",
            "parameters": {
                "type": "object",
                "properties": {
                    "title": {
                        "type": "string",
                        "description": "Short preview title."
                    },
                    "kind": {
                        "type": "string",
                        "enum": ["text", "markdown", "json", "diff"],
                        "description": "Content format for display."
                    },
                    "content": {
                        "type": "string",
                        "description": "Preview body. Keep it bounded; very large content should be summarized first."
                    }
                },
                "required": ["title", "content"],
                "additionalProperties": false
            }
        },
        {
            "name": "tui_focus_context",
            "description": "Move the TUI log focus to a useful location after producing or inspecting context, such as the bottom, top, latest error, or latest tool call.",
            "approval": "never",
            "parameters": {
                "type": "object",
                "properties": {
                    "target": {
                        "type": "string",
                        "enum": ["bottom", "top", "latest_error", "latest_tool_call"],
                        "description": "Destination to focus in the current TUI log."
                    }
                },
                "required": ["target"],
                "additionalProperties": false
            }
        },
        {
            "name": "tui_show_progress",
            "description": "Show or update a graphical progress row in the TUI log; use repeated calls with the same id, or the same phase when id is absent, instead of writing progress messages in chat.",
            "approval": "never",
            "parameters": {
                "type": "object",
                "properties": {
                    "phase": {
                        "type": "string",
                        "description": "Short progress phase label, used as the update key when id is absent."
                    },
                    "id": {
                        "type": "string",
                        "description": "Optional stable update key for one logical progress row."
                    },
                    "message": {
                        "type": "string",
                        "description": "Optional short status detail for the current progress step."
                    },
                    "status": {
                        "type": "string",
                        "enum": ["running", "completed", "error"],
                        "description": "Current progress status. Use completed or error for the final update."
                    },
                    "current": {
                        "type": "number",
                        "description": "Optional current amount completed."
                    },
                    "total": {
                        "type": "number",
                        "description": "Optional total amount; when positive, the TUI shows a percentage."
                    }
                },
                "required": ["phase"],
                "additionalProperties": false
            }
        }
    ])
}

fn env_bool_like(value: Option<&str>) -> Option<bool> {
    match value?.trim().to_ascii_lowercase().as_str() {
        "1" | "true" | "yes" | "on" => Some(true),
        "0" | "false" | "no" | "off" => Some(false),
        _ => None,
    }
}

fn should_include_tui_client_tools_from_values(
    benchmark_mode: Option<&str>,
    tui_client_tools: Option<&str>,
) -> bool {
    if env_bool_like(benchmark_mode).unwrap_or(false) {
        return false;
    }
    env_bool_like(tui_client_tools).unwrap_or(true)
}

fn should_include_tui_client_tools() -> bool {
    let benchmark_mode = env::var("CODELIA_BENCHMARK_MODE").ok();
    let tui_client_tools = env::var("CODELIA_TUI_CLIENT_TOOLS").ok();
    should_include_tui_client_tools_from_values(
        benchmark_mode.as_deref(),
        tui_client_tools.as_deref(),
    )
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

pub fn spawn_runtime(enable_diagnostics: bool, approval_mode: Option<&str>) -> RuntimeSpawnResult {
    let runtime_cmd = env::var("CODELIA_RUNTIME_CMD").unwrap_or_else(|_| "bun".to_string());
    let mut runtime_args = env::var("CODELIA_RUNTIME_ARGS")
        .map(|value| split_args(&value))
        .unwrap_or_else(|_| vec!["packages/runtime/src/index.ts".to_string()]);

    if let Some(mode) = approval_mode {
        runtime_args.push("--approval-mode".to_string());
        runtime_args.push(mode.to_string());
    }

    let mut command = Command::new(runtime_cmd);
    command
        .args(runtime_args)
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
    if should_include_tui_client_tools() {
        params.insert("tools".to_string(), tui_client_tools());
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

pub fn send_client_tool_success(
    writer: &mut BufWriter<std::process::ChildStdin>,
    id: &str,
    result: Value,
) -> std::io::Result<()> {
    let msg = json!({
        "jsonrpc": "2.0",
        "id": id,
        "result": { "ok": true, "result": { "type": "json", "value": result } }
    });
    writer.write_all(json_line(msg).as_bytes())?;
    writer.flush()?;
    Ok(())
}

pub fn send_client_tool_text_success(
    writer: &mut BufWriter<std::process::ChildStdin>,
    id: &str,
    text: &str,
) -> std::io::Result<()> {
    let msg = json!({
        "jsonrpc": "2.0",
        "id": id,
        "result": { "ok": true, "result": { "type": "text", "text": text } }
    });
    writer.write_all(json_line(msg).as_bytes())?;
    writer.flush()?;
    Ok(())
}

pub fn send_client_tool_error(
    writer: &mut BufWriter<std::process::ChildStdin>,
    id: &str,
    error: &str,
) -> std::io::Result<()> {
    let msg = json!({
        "jsonrpc": "2.0",
        "id": id,
        "result": { "ok": false, "error": error }
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
    show_all: bool,
) -> std::io::Result<()> {
    let mut params = serde_json::Map::new();
    if let Some(limit) = limit {
        params.insert("limit".to_string(), json!(limit));
    }
    params.insert(
        "scope".to_string(),
        json!(if show_all { "all" } else { "current_workspace" }),
    );
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
    reasoning: Option<&str>,
    fast: Option<bool>,
    scope: Option<&str>,
    reset: bool,
) -> std::io::Result<()> {
    let mut params = serde_json::Map::new();
    if !reset {
        params.insert("name".to_string(), json!(model));
    }
    if let Some(provider) = provider {
        params.insert("provider".to_string(), json!(provider));
    }
    if let Some(reasoning) = reasoning {
        params.insert("reasoning".to_string(), json!(reasoning));
    }
    if let Some(fast) = fast {
        params.insert("fast".to_string(), json!(fast));
    }
    if let Some(scope) = scope {
        params.insert("scope".to_string(), json!(scope));
    }
    if reset {
        params.insert("reset".to_string(), json!(true));
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

pub fn send_shell_start(
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
        "method": "shell.start",
        "params": params
    });
    writer.write_all(json_line(msg).as_bytes())?;
    writer.flush()?;
    Ok(())
}

pub fn send_shell_wait(
    writer: &mut BufWriter<std::process::ChildStdin>,
    id: &str,
    task_id: &str,
) -> std::io::Result<()> {
    let msg = json!({
        "jsonrpc": "2.0",
        "id": id,
        "method": "shell.wait",
        "params": { "task_id": task_id }
    });
    writer.write_all(json_line(msg).as_bytes())?;
    writer.flush()?;
    Ok(())
}

pub fn send_shell_detach(
    writer: &mut BufWriter<std::process::ChildStdin>,
    id: &str,
    task_id: &str,
) -> std::io::Result<()> {
    let msg = json!({
        "jsonrpc": "2.0",
        "id": id,
        "method": "shell.detach",
        "params": { "task_id": task_id }
    });
    writer.write_all(json_line(msg).as_bytes())?;
    writer.flush()?;
    Ok(())
}

pub fn send_task_list(
    writer: &mut BufWriter<std::process::ChildStdin>,
    id: &str,
) -> std::io::Result<()> {
    let msg = json!({
        "jsonrpc": "2.0",
        "id": id,
        "method": "task.list",
        "params": {}
    });
    writer.write_all(json_line(msg).as_bytes())?;
    writer.flush()?;
    Ok(())
}

pub fn send_task_status(
    writer: &mut BufWriter<std::process::ChildStdin>,
    id: &str,
    task_id: &str,
) -> std::io::Result<()> {
    let msg = json!({
        "jsonrpc": "2.0",
        "id": id,
        "method": "task.status",
        "params": { "task_id": task_id }
    });
    writer.write_all(json_line(msg).as_bytes())?;
    writer.flush()?;
    Ok(())
}

pub fn send_task_cancel(
    writer: &mut BufWriter<std::process::ChildStdin>,
    id: &str,
    task_id: &str,
) -> std::io::Result<()> {
    let msg = json!({
        "jsonrpc": "2.0",
        "id": id,
        "method": "task.cancel",
        "params": { "task_id": task_id }
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
        json_line, should_include_tui_client_tools_from_values, split_args, tui_client_tools,
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
    fn tui_client_tools_include_choice_and_preview_tools() {
        let tools = tui_client_tools();
        let choice_tool = tools
            .as_array()
            .expect("tools array")
            .iter()
            .find(|tool| {
                tool.get("name").and_then(|name| name.as_str()) == Some("tui_ask_user_choice")
            })
            .expect("choice tool");
        let choice_properties = choice_tool
            .get("parameters")
            .and_then(|value| value.get("properties"))
            .and_then(|value| value.as_object())
            .expect("choice properties");
        let names = tools
            .as_array()
            .expect("tools array")
            .iter()
            .filter_map(|tool| tool.get("name").and_then(|name| name.as_str()))
            .collect::<Vec<_>>();
        assert!(names.contains(&"tui_ask_user_choice"));
        assert!(names.contains(&"tui_open_selector"));
        assert!(names.contains(&"tui_preview_artifact"));
        assert!(names.contains(&"tui_focus_context"));
        assert!(names.contains(&"tui_show_progress"));
        assert!(choice_properties.contains_key("message"));
        assert!(choice_properties.contains_key("allow_none"));
        assert!(choice_properties.contains_key("allow_other"));
    }

    #[test]
    fn tui_client_tools_are_disabled_in_benchmark_mode() {
        assert!(!should_include_tui_client_tools_from_values(
            Some("1"),
            None
        ));
        assert!(!should_include_tui_client_tools_from_values(
            Some("true"),
            Some("true")
        ));
        assert!(!should_include_tui_client_tools_from_values(
            None,
            Some("false")
        ));
        assert!(should_include_tui_client_tools_from_values(None, None));
    }
}
