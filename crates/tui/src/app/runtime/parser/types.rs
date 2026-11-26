use super::errors::RunErrorPresentation;
use crate::app::state::stream_preview::StreamUpdate;
use crate::app::state::LogLine;
use crate::protocol::{GoalOffer, GoalSnapshot};
use serde_json::Value;

#[derive(Debug)]
pub(crate) enum GoalNotification {
    Updated(Box<GoalSnapshot>),
    Ready(GoalOffer),
}

pub(crate) enum RuntimeMsg {
    /// No state changes or redraw requested.
    Ignored,
    /// Pure log lines (diagnostics, raw runtime log, protocol mismatch warning,
    /// or replayed `steer_applied` display lines).
    LogLines(Vec<LogLine>),
    /// Response to an outgoing client RPC.
    RpcResponse(RpcResponse),
    /// Server-initiated UI modal requests & cancellations.
    UiRequest(ServerUiMsg),
    /// Server-initiated client tool lifecycle.
    ClientTool(ClientToolMsg),
    /// Run status, context %, LLM metrics, and goal notifications.
    RunControl(RunControlMsg),
    /// Agent transcript/tool/stream/steer/replay events (`agent.event`).
    Agent(AgentMsg),
}

pub(crate) enum ServerUiMsg {
    Confirm(UiConfirmRequest),
    Prompt(UiPromptRequest),
    Pick(UiPickRequest),
    PickCancelled { id: String },
}

pub(crate) enum ClientToolMsg {
    Call(ClientToolRequest),
    Cancel(ClientToolCancel),
    /// Rejection reply metadata and diagnostics for a malformed server request.
    RejectMalformed {
        rejection: ClientToolRejection,
        lines: Vec<LogLine>,
    },
}

pub(crate) enum RunControlMsg {
    Status {
        status: String,
        run_id: Option<String>,
        run_error: Option<RunErrorPresentation>,
        lines: Vec<LogLine>,
        unconsumed_steer_ids: Vec<String>,
        unconsumed_client_steer_ids: Option<Vec<String>>,
    },
    Context {
        left_percent: Option<u8>,
    },
    Metrics(LlmMetricsUpdate),
    Goal(GoalNotification),
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub(crate) enum CompactionPhase {
    Started,
    Completed,
}

pub(crate) enum AgentMsg {
    StreamDelta(StreamUpdate),
    Text {
        lines: Vec<LogLine>,
        content: String,
        canonical_run_id: Option<String>,
    },
    Reasoning {
        lines: Vec<LogLine>,
        content: String,
        canonical_run_id: Option<String>,
    },
    Final {
        lines: Vec<LogLine>,
        content: String,
        canonical_run_id: Option<String>,
    },
    StreamReset {
        lines: Vec<LogLine>,
        run_id: Option<String>,
    },
    /// Replayed progress call or successful result without a tool component.
    ReplayProgress(ReplayProgressEvent),
    ToolCallStart {
        tool_call_id: String,
        lines: Vec<LogLine>,
    },
    ToolCallResult {
        update: ToolCallResultUpdate,
        lines: Vec<LogLine>,
        replay_progress: Option<ReplayProgressEvent>,
    },
    PermissionPreview {
        update: Option<PermissionPreviewUpdate>,
        lines: Vec<LogLine>,
    },
    PermissionReady {
        update: Option<PermissionReadyUpdate>,
        lines: Vec<LogLine>,
    },
    Compaction {
        phase: CompactionPhase,
        lines: Vec<LogLine>,
    },
    SteerApplied {
        steer_id: String,
        client_id: Option<String>,
        run_id: String,
        lines: Vec<LogLine>,
    },
    UnreadableSteerApplied {
        run_id: Option<String>,
        lines: Vec<LogLine>,
    },
}

pub enum ReplayProgressEvent {
    Call {
        run_id: String,
        tool_call_id: String,
        args: Value,
    },
    Result {
        run_id: String,
        tool_call_id: String,
        is_error: bool,
    },
}

pub struct LlmMetricsUpdate {
    pub run_id: String,
    pub output_tokens_per_second: Option<f64>,
}

pub struct ToolCallResultUpdate {
    pub tool_call_id: String,
    pub tool: String,
    pub is_error: bool,
    pub preserve_call_summary: bool,
    pub fallback_summary: LogLine,
    pub edit_diff_fingerprint: Option<String>,
}

pub struct PermissionPreviewUpdate {
    pub tool_call_id: String,
    pub has_diff: bool,
    pub truncated: bool,
    pub diff_fingerprint: Option<String>,
}

pub struct PermissionReadyUpdate {
    pub tool_call_id: String,
}

pub struct RpcResponse {
    pub id: String,
    pub result: Option<Value>,
    pub error: Option<Value>,
}

pub struct UiConfirmRequest {
    pub id: String,
    pub title: String,
    pub message: String,
    pub danger_level: Option<String>,
    pub confirm_label: Option<String>,
    pub cancel_label: Option<String>,
    pub allow_remember: bool,
    pub allow_reason: bool,
}

pub struct UiPromptRequest {
    pub id: String,
    pub title: String,
    pub message: String,
    pub default_value: Option<String>,
    pub multiline: bool,
    pub secret: bool,
}

pub struct UiPickItem {
    pub id: String,
    pub label: String,
    pub detail: Option<String>,
}

pub struct UiPickRequest {
    pub id: String,
    pub title: String,
    pub message: Option<String>,
    pub items: Vec<UiPickItem>,
    pub multi: bool,
    pub approval: bool,
}

pub struct ClientToolRequest {
    pub id: String,
    pub name: String,
    pub arguments: Value,
}

pub struct ClientToolCancel {
    pub request_id: String,
    pub reason: String,
}

/// A runtime -> UI request that failed to decode. The TUI answers it at once
/// with the method's declined reply so the runtime does not wait.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct ClientToolRejection {
    pub id: String,
    pub method: String,
    pub message: String,
}
