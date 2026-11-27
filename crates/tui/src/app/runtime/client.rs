use crate::app::ModelFastMode;
use crate::protocol::{
    methods, AuthLogoutParams, ClientRequest, ClientToolCallFailure, ClientToolCallResult,
    ClientToolCallSuccess, ClientToolDefinition, GoalContinueParams, InitializeParams, PeerInfo,
    RunCancelParams, RunInput, RunStartParams, RunSteerParams, ServerRequestReply,
    SessionHistoryParams, SessionListParams, SessionListScope, SessionOpenParams,
    SessionUpdateParams, ThemeSetParams, UiCapabilities, PROTOCOL_VERSION,
};
use crate::protocol::{
    ContextInspectParams, McpListParams, McpListScope, ShellExecParams, ShellTaskIdParams,
    ShellWaitParams, SkillsListParams, TaskIdParams, TaskListParams, TelemetryGetParams,
    ToolCallParams,
};
use crate::protocol::{ModelListParams, ModelReasoningLevel, ModelSelectionSource, ModelSetParams};
use crate::protocol::{UiConfirmResult, UiPickResult, UiPromptResult};
use serde_json::{json, Value};
use std::env;
use std::io::{self, BufRead, BufReader, BufWriter, Write};
use std::process::{Child, ChildStdin, Command, Stdio};
use std::sync::mpsc::{self, Receiver};
use std::sync::Arc;
use std::thread;
use std::time::{Duration, Instant};

/// Synchronous runtime RPC transport and request ID allocator.
///
/// An error returned from `send_line` means delivery outcome is unknown (for example,
/// buffered bytes may remain in `BufWriter` after a failed flush); callers must treat
/// state as uncertain rather than retrying blindly.
pub(crate) trait RuntimeTx {
    fn next_id(&mut self) -> String;
    fn send_line(&mut self, line: &str) -> io::Result<()>;
}

/// Stdio JSON-RPC transport backed by a single runtime child's stdin.
/// Create one instance per runtime connection so monotonically increasing IDs
/// stay unique for the connection lifetime.
pub(crate) struct StdioRuntimeTx<'a> {
    stdin: &'a mut BufWriter<ChildStdin>,
    rpc_id: u64,
}

impl<'a> StdioRuntimeTx<'a> {
    pub(crate) fn new(stdin: &'a mut BufWriter<ChildStdin>) -> Self {
        Self { stdin, rpc_id: 0 }
    }
}

impl RuntimeTx for StdioRuntimeTx<'_> {
    fn next_id(&mut self) -> String {
        self.rpc_id += 1;
        self.rpc_id.to_string()
    }

    fn send_line(&mut self, line: &str) -> io::Result<()> {
        self.stdin.write_all(line.as_bytes())?;
        self.stdin.flush()
    }
}

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
    on_line: Option<Arc<dyn Fn() + Send + Sync>>,
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
                    if tx.send(output).is_ok() {
                        if let Some(notify) = &on_line {
                            notify();
                        }
                    }
                }
                Err(_) => break,
            }
        }
    });
}

pub(crate) struct RuntimeLaunchConfig<'a> {
    pub(crate) command: &'a str,
    pub(crate) args: &'a [String],
}

/// `CODELIA_RUNTIME_CMD` / `_ARGS` developer override first (including values
/// set by a `CODELIA_TUI_CMD` wrapper), then the launcher context's bundled
/// runtime, then the source checkout default.
pub(crate) fn resolve_runtime_command(
    launch: Option<&RuntimeLaunchConfig<'_>>,
    env_cmd: Option<String>,
    env_args: Option<String>,
) -> (String, Vec<String>) {
    if env_cmd.is_some() || env_args.is_some() {
        let runtime_cmd = env_cmd.unwrap_or_else(|| "bun".to_string());
        let runtime_args = env_args
            .map(|value| split_args(&value))
            .unwrap_or_else(|| vec!["packages/runtime/src/index.ts".to_string()]);
        return (runtime_cmd, runtime_args);
    }
    if let Some(runtime) = launch {
        return (runtime.command.to_owned(), runtime.args.to_vec());
    }
    (
        "bun".to_string(),
        vec!["packages/runtime/src/index.ts".to_string()],
    )
}

pub(crate) fn spawn_runtime(
    launch: Option<&RuntimeLaunchConfig<'_>>,
    sandbox_mode: Option<(&str, &str)>,
    on_line: Option<Arc<dyn Fn() + Send + Sync>>,
) -> RuntimeSpawnResult {
    let (runtime_cmd, mut runtime_args) = resolve_runtime_command(
        launch,
        env::var("CODELIA_RUNTIME_CMD").ok(),
        env::var("CODELIA_RUNTIME_ARGS").ok(),
    );

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
    let mut child = command.spawn()?;

    let child_stdin = BufWriter::new(child.stdin.take().expect("stdin missing"));
    let child_stdout = child.stdout.take().expect("stdout missing");
    let child_stderr = child.stderr.take().expect("stderr missing");
    let (tx, rx) = mpsc::channel::<String>();
    spawn_reader(child_stdout, None, tx.clone(), on_line.clone());
    spawn_reader(child_stderr, Some("[runtime]"), tx, on_line);

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
    tx: &mut dyn RuntimeTx,
    id: &str,
    params: &R::Params,
) -> std::io::Result<()> {
    tx.send_line(&crate::protocol::request_line::<R>(id, params))
}

/// Writes the result of a catalogued runtime -> UI request.
pub(crate) fn send_reply<R: ServerRequestReply>(
    tx: &mut dyn RuntimeTx,
    id: &str,
    result: &R::Result,
) -> std::io::Result<()> {
    tx.send_line(&crate::protocol::reply_line::<R>(id, result))
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

pub fn send_initialize(tx: &mut dyn RuntimeTx, id: &str) -> std::io::Result<()> {
    send_request::<methods::Initialize>(tx, id, &initialize_params())
}

pub fn send_confirm_response(
    tx: &mut dyn RuntimeTx,
    id: &str,
    ok: bool,
    remember: bool,
    reason: Option<&str>,
) -> std::io::Result<()> {
    let result = UiConfirmResult {
        ok,
        remember: Some(remember),
        reason: reason.map(str::to_owned),
    };
    send_reply::<methods::UiConfirmRequest>(tx, id, &result)
}

pub fn send_prompt_response(
    tx: &mut dyn RuntimeTx,
    id: &str,
    value: Option<&str>,
) -> std::io::Result<()> {
    let result = UiPromptResult {
        value: value.map(str::to_owned),
    };
    send_reply::<methods::UiPromptRequest>(tx, id, &result)
}

pub fn send_pick_response(tx: &mut dyn RuntimeTx, id: &str, ids: &[String]) -> std::io::Result<()> {
    let result = UiPickResult { ids: ids.to_vec() };
    send_reply::<methods::UiPickRequest>(tx, id, &result)
}

pub fn send_run_start(
    tx: &mut dyn RuntimeTx,
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
    send_request::<methods::RunStart>(tx, id, &params)
}

pub(crate) fn send_goal_continue(
    tx: &mut dyn RuntimeTx,
    id: &str,
    offer: &crate::protocol::GoalOffer,
) -> std::io::Result<()> {
    let params = GoalContinueParams {
        session_id: offer.session_id.clone(),
        goal_id: offer.goal_id.clone(),
        revision: offer.revision,
        continuation_id: offer.continuation_id.clone(),
        after_run_id: offer.after_run_id.clone(),
        tools: client_tool_definitions("goal.continue")?,
        ui_context: None,
    };
    send_request::<methods::GoalContinue>(tx, id, &params)
}

pub fn send_run_steer(
    tx: &mut dyn RuntimeTx,
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
    send_request::<methods::RunSteer>(tx, id, &params)
}

pub fn send_client_tool_success(
    tx: &mut dyn RuntimeTx,
    id: &str,
    result: Value,
) -> std::io::Result<()> {
    send_client_tool_result(
        tx,
        id,
        ClientToolCallResult::Success(ClientToolCallSuccess {
            result: Some(json!({ "type": "json", "value": result })),
        }),
    )
}

pub fn send_client_tool_text_success(
    tx: &mut dyn RuntimeTx,
    id: &str,
    text: &str,
) -> std::io::Result<()> {
    send_client_tool_result(
        tx,
        id,
        ClientToolCallResult::Success(ClientToolCallSuccess {
            result: Some(json!({ "type": "text", "text": text })),
        }),
    )
}

pub fn send_client_tool_error(
    tx: &mut dyn RuntimeTx,
    id: &str,
    error: &str,
) -> std::io::Result<()> {
    send_client_tool_result(
        tx,
        id,
        ClientToolCallResult::Failure(ClientToolCallFailure {
            error: error.to_owned(),
        }),
    )
}

fn send_client_tool_result(
    tx: &mut dyn RuntimeTx,
    id: &str,
    result: ClientToolCallResult,
) -> std::io::Result<()> {
    send_reply::<methods::ClientToolCall>(tx, id, &result)
}

pub fn send_run_cancel(
    tx: &mut dyn RuntimeTx,
    id: &str,
    run_id: &str,
    reason: Option<&str>,
) -> std::io::Result<()> {
    let params = RunCancelParams {
        run_id: run_id.to_owned(),
        reason: reason.map(str::to_owned),
    };
    send_request::<methods::RunCancel>(tx, id, &params)
}

pub fn send_session_list(
    tx: &mut dyn RuntimeTx,
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
    send_request::<methods::SessionList>(tx, id, &params)
}

pub fn send_session_update(
    tx: &mut dyn RuntimeTx,
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
    send_request::<methods::SessionUpdate>(tx, id, &params)
}

pub fn send_auth_logout(
    tx: &mut dyn RuntimeTx,
    id: &str,
    clear_session: bool,
    provider: Option<&str>,
) -> std::io::Result<()> {
    let params = AuthLogoutParams {
        provider: provider.map(str::to_owned),
        clear_session: Some(clear_session),
        confirmed: None,
    };
    send_request::<methods::AuthLogout>(tx, id, &params)
}

pub fn send_model_list(
    tx: &mut dyn RuntimeTx,
    id: &str,
    provider: Option<&str>,
    include_details: bool,
) -> std::io::Result<()> {
    let params = ModelListParams {
        provider: provider.map(str::to_owned),
        include_details: Some(include_details),
    };
    send_request::<methods::ModelList>(tx, id, &params)
}

#[allow(clippy::too_many_arguments)]
pub fn send_model_set(
    tx: &mut dyn RuntimeTx,
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
    send_request::<methods::ModelSet>(tx, id, &params)
}

pub fn send_theme_set(tx: &mut dyn RuntimeTx, id: &str, name: &str) -> std::io::Result<()> {
    send_request::<methods::ThemeSet>(
        tx,
        id,
        &ThemeSetParams {
            name: name.to_owned(),
        },
    )
}

pub fn send_shell_exec(
    tx: &mut dyn RuntimeTx,
    id: &str,
    command: &str,
    timeout_seconds: Option<u64>,
) -> std::io::Result<()> {
    let params = ShellExecParams {
        command: command.to_owned(),
        timeout_seconds: timeout_seconds.map(|value| value as f64),
        cwd: None,
    };
    send_request::<methods::ShellExec>(tx, id, &params)
}

pub fn send_shell_start(
    tx: &mut dyn RuntimeTx,
    id: &str,
    command: &str,
    timeout_seconds: Option<u64>,
) -> std::io::Result<()> {
    let params = ShellExecParams {
        command: command.to_owned(),
        timeout_seconds: timeout_seconds.map(|value| value as f64),
        cwd: None,
    };
    send_request::<methods::ShellStart>(tx, id, &params)
}

pub fn send_shell_wait(tx: &mut dyn RuntimeTx, id: &str, task_id: &str) -> std::io::Result<()> {
    let params = ShellWaitParams {
        task_id: task_id.to_owned(),
        wait_timeout_seconds: None,
    };
    send_request::<methods::ShellWait>(tx, id, &params)
}

pub fn send_shell_detach(tx: &mut dyn RuntimeTx, id: &str, task_id: &str) -> std::io::Result<()> {
    let params = ShellTaskIdParams {
        task_id: task_id.to_owned(),
    };
    send_request::<methods::ShellDetach>(tx, id, &params)
}

pub fn send_task_list(tx: &mut dyn RuntimeTx, id: &str) -> std::io::Result<()> {
    send_request::<methods::TaskList>(tx, id, &TaskListParams::default())
}

pub fn send_task_status(tx: &mut dyn RuntimeTx, id: &str, task_id: &str) -> std::io::Result<()> {
    let params = TaskIdParams {
        task_id: task_id.to_owned(),
    };
    send_request::<methods::TaskStatus>(tx, id, &params)
}

pub fn send_task_cancel(tx: &mut dyn RuntimeTx, id: &str, task_id: &str) -> std::io::Result<()> {
    let params = TaskIdParams {
        task_id: task_id.to_owned(),
    };
    send_request::<methods::TaskCancel>(tx, id, &params)
}

pub fn send_tool_call(
    tx: &mut dyn RuntimeTx,
    id: &str,
    name: &str,
    arguments: Value,
) -> std::io::Result<()> {
    let params = ToolCallParams {
        name: name.to_owned(),
        arguments: wire_value("tool.call", "arguments", arguments)?,
    };
    send_request::<methods::ToolCall>(tx, id, &params)
}

pub fn send_mcp_list(tx: &mut dyn RuntimeTx, id: &str, scope: Option<&str>) -> std::io::Result<()> {
    let params = McpListParams {
        scope: scope.map(|scope| McpListScope::from(scope.to_owned())),
    };
    send_request::<methods::McpList>(tx, id, &params)
}

pub fn send_context_inspect(
    tx: &mut dyn RuntimeTx,
    id: &str,
    include_agents: bool,
    include_skills: bool,
) -> std::io::Result<()> {
    let params = ContextInspectParams {
        include_agents: Some(include_agents),
        include_skills: Some(include_skills),
    };
    send_request::<methods::ContextInspect>(tx, id, &params)
}

pub fn send_telemetry_get(tx: &mut dyn RuntimeTx, id: &str) -> std::io::Result<()> {
    send_request::<methods::TelemetryGet>(tx, id, &TelemetryGetParams::default())
}

pub fn send_skills_list(
    tx: &mut dyn RuntimeTx,
    id: &str,
    force_reload: bool,
) -> std::io::Result<()> {
    let params = SkillsListParams {
        cwd: None,
        force_reload: Some(force_reload),
    };
    send_request::<methods::SkillsList>(tx, id, &params)
}

pub fn send_session_history(
    tx: &mut dyn RuntimeTx,
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
    send_request::<methods::SessionHistory>(tx, id, &params)
}

pub fn send_session_open(
    tx: &mut dyn RuntimeTx,
    id: &str,
    session_id: &str,
) -> std::io::Result<()> {
    let params = SessionOpenParams {
        session_id: session_id.to_owned(),
    };
    send_request::<methods::SessionOpen>(tx, id, &params)
}

#[cfg(test)]
#[derive(Default)]
pub(crate) struct MockRuntimeTx {
    rpc_id: u64,
    id_prefix: String,
    pub(crate) sent: Vec<Value>,
    pub(crate) fail_next: Option<io::ErrorKind>,
}

#[cfg(test)]
impl MockRuntimeTx {
    pub(crate) fn with_id_prefix(prefix: &str) -> Self {
        Self {
            id_prefix: prefix.to_owned(),
            ..Self::default()
        }
    }
}

#[cfg(test)]
impl RuntimeTx for MockRuntimeTx {
    fn next_id(&mut self) -> String {
        self.rpc_id += 1;
        format!("{}{}", self.id_prefix, self.rpc_id)
    }

    fn send_line(&mut self, line: &str) -> io::Result<()> {
        if let Some(kind) = self.fail_next.take() {
            return Err(kind.into());
        }
        assert!(
            line.ends_with('\n') && !line[..line.len() - 1].contains('\n'),
            "RPC wire frame must end with a single trailing newline: {line:?}"
        );
        let payload: Value = serde_json::from_str(&line[..line.len() - 1])
            .map_err(|error| io::Error::new(io::ErrorKind::InvalidData, error))?;
        self.sent.push(payload);
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::{
        initialize_params, resolve_runtime_command, should_include_tui_client_tools_from_values,
        shutdown_runtime, split_args, tui_client_tools, RuntimeLaunchConfig,
        ASK_USER_CHOICE_TIMEOUT_MS,
    };
    use serde_json::json;

    #[test]
    fn runtime_command_prefers_env_override_then_launcher_context() {
        let launch = RuntimeLaunchConfig {
            command: "/usr/bin/node",
            args: &["/opt/O'Neill runtime/index.cjs".to_owned()],
        };
        assert_eq!(
            resolve_runtime_command(Some(&launch), None, None),
            (
                "/usr/bin/node".to_owned(),
                vec!["/opt/O'Neill runtime/index.cjs".to_owned()]
            )
        );
        assert_eq!(
            resolve_runtime_command(Some(&launch), Some("bun".to_owned()), None),
            (
                "bun".to_owned(),
                vec!["packages/runtime/src/index.ts".to_owned()]
            )
        );
        assert_eq!(
            resolve_runtime_command(
                Some(&launch),
                Some("bun".to_owned()),
                Some("'a b' c".to_owned()),
            ),
            ("bun".to_owned(), vec!["a b".to_owned(), "c".to_owned()])
        );
        assert_eq!(
            resolve_runtime_command(None, None, None),
            (
                "bun".to_owned(),
                vec!["packages/runtime/src/index.ts".to_owned()]
            )
        );
    }

    #[test]
    fn initialize_params_advertises_core_tui_capabilities() {
        let caps = initialize_params()
            .ui_capabilities
            .expect("ui_capabilities");
        assert_eq!(caps.supports_text_delta, Some(true));
        assert_eq!(caps.supports_goals, Some(true));
    }

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
    fn tool_call_request_line_uses_the_generated_params() {
        use super::{send_request, MockRuntimeTx, RuntimeTx};
        use crate::protocol::methods::ToolCall;

        let params = crate::protocol::ToolCallParams {
            name: "lane_list".to_owned(),
            arguments: Some(serde_json::Map::new()),
        };
        let mut tx = MockRuntimeTx::with_id_prefix("id-");
        let id = tx.next_id();
        send_request::<ToolCall>(&mut tx, &id, &params).unwrap();
        let [value] = tx.sent.as_slice() else {
            panic!("expected one tool request");
        };
        assert_eq!(
            *value,
            json!({"jsonrpc":"2.0","id":"id-1","method":"tool.call","params":{"name":"lane_list","arguments":{}}})
        );
        assert_eq!(
            format!("{value}\n"),
            crate::protocol::request_line::<ToolCall>(&id, &params)
        );
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
