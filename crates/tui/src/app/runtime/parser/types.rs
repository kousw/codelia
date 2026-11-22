use crate::app::state::LogLine;
use serde_json::Value;

pub struct ParsedOutput {
    pub stream_update: Option<crate::app::state::stream_preview::StreamUpdate>,
    pub lines: Vec<LogLine>,
    pub status: Option<String>,
    pub run_error: Option<super::errors::RunErrorPresentation>,
    pub status_run_id: Option<String>,
    pub context_left_percent: Option<u8>,
    pub llm_metrics: Option<LlmMetricsUpdate>,
    pub assistant_text: Option<String>,
    pub reasoning_text: Option<String>,
    pub stream_reset: bool,
    pub canonical_run_id: Option<String>,
    pub final_text: Option<String>,
    pub rpc_response: Option<RpcResponse>,
    pub goal_notification: Option<crate::app::goal::GoalNotification>,
    pub confirm_request: Option<UiConfirmRequest>,
    pub prompt_request: Option<UiPromptRequest>,
    pub pick_request: Option<UiPickRequest>,
    pub cancelled_pick_id: Option<String>,
    pub client_tool_request: Option<ClientToolRequest>,
    pub client_tool_cancel: Option<ClientToolCancel>,
    /// Malformed `client.tool.call`: reply with a failure instead of waiting
    /// for the runtime timeout.
    pub client_tool_rejection: Option<ClientToolRejection>,
    pub replay_progress: Option<ReplayProgressEvent>,
    pub tool_call_start_id: Option<String>,
    pub tool_call_result: Option<ToolCallResultUpdate>,
    pub compaction_started: bool,
    pub compaction_completed: bool,
    pub permission_preview_update: Option<PermissionPreviewUpdate>,
    pub permission_ready_update: Option<PermissionReadyUpdate>,
    pub applied_steer_id: Option<String>,
    pub unconsumed_steer_ids: Vec<String>,
}

impl ParsedOutput {
    pub(super) fn empty() -> Self {
        Self {
            stream_update: None,
            lines: Vec::new(),
            status: None,
            run_error: None,
            status_run_id: None,
            context_left_percent: None,
            llm_metrics: None,
            assistant_text: None,
            reasoning_text: None,
            stream_reset: false,
            canonical_run_id: None,
            final_text: None,
            rpc_response: None,
            goal_notification: None,
            confirm_request: None,
            prompt_request: None,
            pick_request: None,
            cancelled_pick_id: None,
            client_tool_request: None,
            client_tool_cancel: None,
            client_tool_rejection: None,
            replay_progress: None,
            tool_call_start_id: None,
            tool_call_result: None,
            compaction_started: false,
            compaction_completed: false,
            permission_preview_update: None,
            permission_ready_update: None,
            applied_steer_id: None,
            unconsumed_steer_ids: Vec::new(),
        }
    }
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

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct ClientToolRejection {
    pub id: String,
    pub message: String,
}
