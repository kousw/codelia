use crate::app::state::LogLine;
use serde_json::Value;

pub struct ParsedOutput {
    pub lines: Vec<LogLine>,
    pub status: Option<String>,
    pub status_run_id: Option<String>,
    pub context_left_percent: Option<u8>,
    pub assistant_text: Option<String>,
    pub final_text: Option<String>,
    pub rpc_response: Option<RpcResponse>,
    pub confirm_request: Option<UiConfirmRequest>,
    pub prompt_request: Option<UiPromptRequest>,
    pub pick_request: Option<UiPickRequest>,
    pub tool_call_start_id: Option<String>,
    pub tool_call_result: Option<ToolCallResultUpdate>,
    pub compaction_started: bool,
    pub compaction_completed: bool,
    pub permission_preview_update: Option<PermissionPreviewUpdate>,
}

impl ParsedOutput {
    pub(super) fn empty() -> Self {
        Self {
            lines: Vec::new(),
            status: None,
            status_run_id: None,
            context_left_percent: None,
            assistant_text: None,
            final_text: None,
            rpc_response: None,
            confirm_request: None,
            prompt_request: None,
            pick_request: None,
            tool_call_start_id: None,
            tool_call_result: None,
            compaction_started: false,
            compaction_completed: false,
            permission_preview_update: None,
        }
    }
}

pub struct ToolCallResultUpdate {
    pub tool_call_id: String,
    pub tool: String,
    pub is_error: bool,
    pub fallback_summary: LogLine,
    pub edit_diff_fingerprint: Option<String>,
}

pub struct PermissionPreviewUpdate {
    pub tool_call_id: String,
    pub has_diff: bool,
    pub truncated: bool,
    pub diff_fingerprint: Option<String>,
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
    pub items: Vec<UiPickItem>,
    pub multi: bool,
}
