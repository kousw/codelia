use crate::app::ModelFastMode;
use crate::protocol::{
    methods, AuthLogoutParams, ClientRequest, ClientToolCallFailure, ClientToolCallResult,
    ClientToolCallSuccess, ClientToolDefinition, GoalContinueParams, InitializeParams, PeerInfo,
    RunCancelParams, RunInput, RunStartParams, RunSteerParams, ServerRequestReply,
    SessionHistoryParams, SessionListParams, SessionListScope, SessionOpenParams,
    SessionUpdateParams, ThemeSetParams, UiCapabilities, PROTOCOL_VERSION,
};
use crate::protocol::{ModelListParams, ModelReasoningLevel, ModelSelectionSource, ModelSetParams};
use serde_json::{json, Value};
use std::env;
use std::io::{self, BufRead, BufReader, BufWriter, Write};
use std::process::{Child, Command, Stdio};
use std::sync::mpsc::{self, Receiver};
use std::thread;
use std::time::{Duration, Instant};

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
const ASK_USER_CHOICE_TIMEOUT_MS: u64 = 15 * 60 * 1_000;

fn json_line(value: Value) -> String {
    value.to_string() + "\n"
}

fn tui_client_tools() -> Value {
    json!([
        {
            "name": "tui_ask_user_choice",
            "description": "Ask the user to pick exactly one option in the TUI. Call with choices=[{id,label,description?}]; every choice must include a non-empty id and label. Never use questions or options. Prefer this over writing numbered choices in chat when the next step depends on the answer.",
            "approval": "never",
            "timeout_ms": ASK_USER_CHOICE_TIMEOUT_MS,
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
                        "description": "Required candidate choices. Every item must contain a unique non-empty id and a non-empty label; use description only for optional context. Do not pass strings or use an options field.",
                        "items": {
                            "type": "object",
                            "properties": {
                                "id": {
                                    "type": "string",
                                    "minLength": 1,
                                    "description": "Required unique machine-readable id returned as selected_id. Do not use reserved ids beginning with __."
                                },
                                "label": {
                                    "type": "string",
                                    "minLength": 1,
                                    "description": "Required short user-facing option label."
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

pub fn spawn_runtime(
    enable_diagnostics: bool,
    sandbox_mode: Option<(&str, &str)>,
) -> RuntimeSpawnResult {
    let runtime_cmd = env::var("CODELIA_RUNTIME_CMD").unwrap_or_else(|_| "bun".to_string());
    let mut runtime_args = env::var("CODELIA_RUNTIME_ARGS")
        .map(|value| split_args(&value))
        .unwrap_or_else(|_| vec!["packages/runtime/src/index.ts".to_string()]);

    if let Some((flag, mode)) = sandbox_mode {
        runtime_args.push(flag.to_string());
        runtime_args.push(mode.to_string());
    }

    let mut command = Command::new(runtime_cmd);
    command
        .args(runtime_args)
        .env(
            "CODELIA_NATIVE_TUI_PARENT_PID",
            std::process::id().to_string(),
        )
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

pub fn shutdown_runtime(
    child: &mut Child,
    child_stdin: BufWriter<std::process::ChildStdin>,
    grace: Duration,
) -> io::Result<()> {
    // EOF lets runtime cancel owned tasks and close MCP before its process exits.
    drop(child_stdin);
    let deadline = Instant::now() + grace;
    loop {
        if child.try_wait()?.is_some() {
            return Ok(());
        }
        if Instant::now() >= deadline {
            break;
        }
        thread::sleep(
            Duration::from_millis(20).min(deadline.saturating_duration_since(Instant::now())),
        );
    }
    if let Err(error) = child.kill() {
        if child.try_wait()?.is_none() {
            return Err(error);
        }
    }
    child.wait()?;
    Ok(())
}

/// Converts a JSON value assembled by the TUI (composer input, client tool
/// definitions) into its wire type before sending. A mismatch is a TUI bug and
/// fails the send without writing anything.
pub(crate) fn wire_value<T: serde::de::DeserializeOwned>(
    method: &str,
    field: &str,
    value: Value,
) -> io::Result<T> {
    serde_json::from_value(value).map_err(|error| {
        io::Error::new(
            io::ErrorKind::InvalidData,
            format!(
                "{method} {field} does not match the protocol: {}",
                crate::protocol::redact_values(&error.to_string())
            ),
        )
    })
}

fn client_tool_definitions(method: &str) -> io::Result<Option<Vec<ClientToolDefinition>>> {
    if !should_include_tui_client_tools() {
        return Ok(None);
    }
    wire_value(method, "tools", tui_client_tools()).map(Some)
}

/// Writes a catalogued UI -> runtime request.
pub(crate) fn send_request<R: ClientRequest>(
    writer: &mut BufWriter<std::process::ChildStdin>,
    id: &str,
    params: &R::Params,
) -> std::io::Result<()> {
    writer.write_all(crate::protocol::request_line::<R>(id, params).as_bytes())?;
    writer.flush()
}

/// Writes the result of a catalogued runtime -> UI request.
pub(crate) fn send_reply<R: ServerRequestReply>(
    writer: &mut BufWriter<std::process::ChildStdin>,
    id: &str,
    result: &R::Result,
) -> std::io::Result<()> {
    writer.write_all(crate::protocol::reply_line::<R>(id, result).as_bytes())?;
    writer.flush()
}

pub(crate) fn initialize_params() -> InitializeParams {
    InitializeParams {
        protocol_version: Some(PROTOCOL_VERSION.to_owned()),
        client: Some(PeerInfo {
            name: "codelia-tui".to_owned(),
            version: "0.1.0".to_owned(),
        }),
        ui_capabilities: Some(UiCapabilities {
            supports_confirm: Some(true),
            supports_prompt: Some(true),
            supports_pick: Some(true),
            supports_structured_approval: Some(true),
            supports_permission_preflight_events: Some(true),
            supports_text_delta: Some(true),
            supports_goals: Some(true),
            ..Default::default()
        }),
    }
}

pub fn send_initialize(
    writer: &mut BufWriter<std::process::ChildStdin>,
    id: &str,
) -> std::io::Result<()> {
    send_request::<methods::Initialize>(writer, id, &initialize_params())
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
    let params = RunStartParams {
        input: wire_value("run.start", "input", input)?,
        session_id: session_id.map(str::to_owned),
        force_compaction: force_compaction.then_some(true),
        tools: client_tool_definitions("run.start")?,
        tool_choice: None,
        ui_context: None,
        meta: None,
    };
    send_request::<methods::RunStart>(writer, id, &params)
}

pub(crate) fn send_goal_continue(
    writer: &mut BufWriter<std::process::ChildStdin>,
    id: &str,
    offer: &crate::app::goal::GoalOffer,
) -> std::io::Result<()> {
    let mut params: GoalContinueParams = wire_value("goal.continue", "offer", json!(offer))?;
    params.tools = client_tool_definitions("goal.continue")?;
    send_request::<methods::GoalContinue>(writer, id, &params)
}

pub fn send_run_steer(
    writer: &mut BufWriter<std::process::ChildStdin>,
    id: &str,
    run_id: &str,
    input: Value,
    client_steer_id: Option<&str>,
) -> std::io::Result<()> {
    let input: RunInput = wire_value("run.steer", "input", input)?;
    let params = RunSteerParams {
        run_id: run_id.to_owned(),
        input,
        client_steer_id: client_steer_id
            .filter(|value| !value.trim().is_empty())
            .map(str::to_owned),
    };
    send_request::<methods::RunSteer>(writer, id, &params)
}

pub fn send_client_tool_success(
    writer: &mut BufWriter<std::process::ChildStdin>,
    id: &str,
    result: Value,
) -> std::io::Result<()> {
    send_client_tool_result(
        writer,
        id,
        ClientToolCallResult::Success(ClientToolCallSuccess {
            result: Some(json!({ "type": "json", "value": result })),
        }),
    )
}

pub fn send_client_tool_text_success(
    writer: &mut BufWriter<std::process::ChildStdin>,
    id: &str,
    text: &str,
) -> std::io::Result<()> {
    send_client_tool_result(
        writer,
        id,
        ClientToolCallResult::Success(ClientToolCallSuccess {
            result: Some(json!({ "type": "text", "text": text })),
        }),
    )
}

pub fn send_client_tool_error(
    writer: &mut BufWriter<std::process::ChildStdin>,
    id: &str,
    error: &str,
) -> std::io::Result<()> {
    send_client_tool_result(
        writer,
        id,
        ClientToolCallResult::Failure(ClientToolCallFailure {
            error: error.to_owned(),
        }),
    )
}

fn send_client_tool_result(
    writer: &mut BufWriter<std::process::ChildStdin>,
    id: &str,
    result: ClientToolCallResult,
) -> std::io::Result<()> {
    send_reply::<methods::ClientToolCall>(writer, id, &result)
}

pub fn send_run_cancel(
    writer: &mut BufWriter<std::process::ChildStdin>,
    id: &str,
    run_id: &str,
    reason: Option<&str>,
) -> std::io::Result<()> {
    let params = RunCancelParams {
        run_id: run_id.to_owned(),
        reason: reason.map(str::to_owned),
    };
    send_request::<methods::RunCancel>(writer, id, &params)
}

pub fn send_session_list(
    writer: &mut BufWriter<std::process::ChildStdin>,
    id: &str,
    limit: Option<usize>,
    show_all: bool,
) -> std::io::Result<()> {
    let params = SessionListParams {
        limit: limit.map(|limit| limit as i64),
        scope: Some(if show_all {
            SessionListScope::All
        } else {
            SessionListScope::CurrentWorkspace
        }),
        workspace_root: None,
        include_archived: Some(show_all),
    };
    send_request::<methods::SessionList>(writer, id, &params)
}

pub fn send_session_update(
    writer: &mut BufWriter<std::process::ChildStdin>,
    id: &str,
    session_id: &str,
    pinned: Option<bool>,
    archived: Option<bool>,
) -> std::io::Result<()> {
    let params = SessionUpdateParams {
        session_id: session_id.to_owned(),
        pinned,
        archived,
    };
    send_request::<methods::SessionUpdate>(writer, id, &params)
}

pub fn send_auth_logout(
    writer: &mut BufWriter<std::process::ChildStdin>,
    id: &str,
    clear_session: bool,
    provider: Option<&str>,
) -> std::io::Result<()> {
    let params = AuthLogoutParams {
        provider: provider.map(str::to_owned),
        clear_session: Some(clear_session),
        confirmed: None,
    };
    send_request::<methods::AuthLogout>(writer, id, &params)
}

pub fn send_model_list(
    writer: &mut BufWriter<std::process::ChildStdin>,
    id: &str,
    provider: Option<&str>,
    include_details: bool,
) -> std::io::Result<()> {
    let params = ModelListParams {
        provider: provider.map(str::to_owned),
        include_details: Some(include_details),
    };
    send_request::<methods::ModelList>(writer, id, &params)
}

#[allow(clippy::too_many_arguments)]
pub fn send_model_set(
    writer: &mut BufWriter<std::process::ChildStdin>,
    id: &str,
    provider: Option<&str>,
    model: &str,
    reasoning: Option<&str>,
    fast: Option<ModelFastMode>,
    scope: Option<&str>,
    reset: bool,
) -> std::io::Result<()> {
    let params = ModelSetParams {
        name: (!reset).then(|| model.to_owned()),
        provider: provider.map(str::to_owned),
        reasoning: reasoning.map(|level| ModelReasoningLevel::from(level.to_owned())),
        fast: fast.map(ModelFastMode::to_wire),
        scope: scope.map(|scope| ModelSelectionSource::from(scope.to_owned())),
        reset: reset.then_some(true),
    };
    send_request::<methods::ModelSet>(writer, id, &params)
}

pub fn send_theme_set(
    writer: &mut BufWriter<std::process::ChildStdin>,
    id: &str,
    name: &str,
) -> std::io::Result<()> {
    send_request::<methods::ThemeSet>(
        writer,
        id,
        &ThemeSetParams {
            name: name.to_owned(),
        },
    )
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
    let params = SessionHistoryParams {
        session_id: session_id.to_owned(),
        max_runs: max_runs.map(|value| value as i64),
        max_events: max_events.map(|value| value as i64),
    };
    send_request::<methods::SessionHistory>(writer, id, &params)
}

pub fn send_session_open(
    writer: &mut BufWriter<std::process::ChildStdin>,
    id: &str,
    session_id: &str,
) -> std::io::Result<()> {
    let params = SessionOpenParams {
        session_id: session_id.to_owned(),
    };
    send_request::<methods::SessionOpen>(writer, id, &params)
}

#[cfg(test)]
mod tests {
    use super::{
        json_line, should_include_tui_client_tools_from_values, shutdown_runtime, split_args,
        tui_client_tools, ASK_USER_CHOICE_TIMEOUT_MS,
    };
    use serde_json::json;

    #[cfg(unix)]
    #[test]
    fn runtime_shutdown_closes_stdin_and_waits_for_cleanup() {
        use std::io::{BufWriter, Read};
        use std::process::{Command, Stdio};
        use std::time::Duration;

        let mut child = Command::new("sh")
            .args(["-c", "while IFS= read -r line; do :; done; printf cleaned"])
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .spawn()
            .expect("spawn runtime fixture");
        let writer = BufWriter::new(child.stdin.take().expect("stdin"));
        shutdown_runtime(&mut child, writer, Duration::from_secs(2)).expect("shutdown");
        let mut output = String::new();
        child
            .stdout
            .take()
            .unwrap()
            .read_to_string(&mut output)
            .unwrap();
        assert_eq!(output, "cleaned");
        assert!(child.try_wait().unwrap().unwrap().success());
    }

    #[cfg(unix)]
    #[test]
    fn runtime_shutdown_kills_and_reaps_unresponsive_child() {
        use std::io::BufWriter;
        use std::process::{Command, Stdio};
        use std::time::Duration;

        let mut child = Command::new("sh")
            .args(["-c", "while :; do :; done"])
            .stdin(Stdio::piped())
            .spawn()
            .expect("spawn runtime fixture");
        let writer = BufWriter::new(child.stdin.take().expect("stdin"));
        shutdown_runtime(&mut child, writer, Duration::from_millis(60)).expect("shutdown");
        assert!(!child.try_wait().unwrap().unwrap().success());
    }

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
        assert_eq!(
            choice_tool
                .get("timeout_ms")
                .and_then(|value| value.as_u64()),
            Some(ASK_USER_CHOICE_TIMEOUT_MS)
        );
        let description = choice_tool
            .get("description")
            .and_then(|value| value.as_str())
            .expect("choice description");
        assert!(description.contains("choices=[{id,label,description?}]"));
        assert!(description.contains("Never use questions or options"));
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
