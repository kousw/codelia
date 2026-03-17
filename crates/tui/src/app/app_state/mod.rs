use crate::app::state::InputState;
use crate::app::state::LogLine;
use crate::app::state::{
    ConfirmDialogState, ContextPanelState, LaneListPanelState, ModelListMode, ModelListPanelState,
    ModelPickerState, PendingImageAttachment, PerfDebugStats, PickDialogState, PromptDialogState,
    ProviderPickerState, ReasoningPickerState, RenderState, SessionListPanelState,
    SkillsListItemState, SkillsListPanelState, SkillsScopeFilter, StatusLineMode,
    ThemeListPanelState, WrappedLogCache,
};
use serde_json::Value;
use std::collections::{BTreeSet, HashMap, HashSet, VecDeque};
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

pub(crate) const PROMPT_DISPATCH_RETRY_BACKOFF: Duration = Duration::from_millis(200);
pub(crate) const PROMPT_DISPATCH_MAX_ATTEMPTS: u32 = 5;

#[derive(Debug, Clone)]
pub struct PendingShellResult {
    pub id: String,
    pub command_preview: String,
    pub exit_code: Option<i64>,
    pub signal: Option<String>,
    pub duration_ms: u64,
    pub stdout: Option<String>,
    pub stderr: Option<String>,
    pub stdout_excerpt: Option<String>,
    pub stderr_excerpt: Option<String>,
    pub stdout_cache_id: Option<String>,
    pub stderr_cache_id: Option<String>,
    pub truncated_stdout: bool,
    pub truncated_stderr: bool,
    pub truncated_combined: bool,
}

#[derive(Debug, Clone)]
pub struct PendingPromptRun {
    pub queue_id: String,
    pub queued_at: Instant,
    pub preview: String,
    pub user_text: String,
    pub input_payload: Value,
    pub attachment_count: usize,
    pub shell_result_count: usize,
    pub dispatch_attempts: u32,
}

#[derive(Debug, Clone, Default)]
pub struct PermissionPreviewRecord {
    pub has_diff: bool,
    pub truncated: bool,
    pub diff_fingerprint: Option<String>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct LogComponentSpan {
    pub start: usize,
    pub end: usize,
}

impl LogComponentSpan {
    pub fn single(index: usize) -> Self {
        Self {
            start: index,
            end: index.saturating_add(1),
        }
    }

    pub fn first_index(self) -> usize {
        self.start
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ErrorDetailMode {
    Summary,
    Detail,
}

#[derive(Debug, Default)]
pub struct RpcPendingState {
    pub model_list_id: Option<String>,
    pub model_list_mode: Option<ModelListMode>,
    pub model_set_id: Option<String>,
    pub run_start_id: Option<String>,
    pub run_cancel_id: Option<String>,
    pub session_list_id: Option<String>,
    pub session_history_id: Option<String>,
    pub lane_list_id: Option<String>,
    pub lane_status_id: Option<String>,
    pub lane_close_id: Option<String>,
    pub lane_create_id: Option<String>,
    pub new_lane_seed_context: Option<String>,
    pub mcp_list_id: Option<String>,
    pub mcp_detail_id: Option<String>,
    pub context_inspect_id: Option<String>,
    pub skills_list_id: Option<String>,
    pub theme_set_id: Option<String>,
    pub skills_query: Option<String>,
    pub skills_scope: Option<SkillsScopeFilter>,
    pub logout_id: Option<String>,
    pub shell_exec_id: Option<String>,
    pub shell_start_id: Option<String>,
    pub shell_wait_id: Option<String>,
    pub shell_detach_id: Option<String>,
    pub task_list_id: Option<String>,
    pub task_status_id: Option<String>,
    pub task_cancel_id: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum PendingRpcMatch {
    SessionList,
    SessionHistory,
    ModelList { mode: ModelListMode },
    ModelSet,
    McpList { detail_id: Option<String> },
    LaneList,
    LaneStatus,
    LaneClose,
    LaneCreate,
    SkillsList,
    ContextInspect,
    Logout,
    ShellExec,
    ShellStart,
    ShellWait,
    ShellDetach,
    TaskList,
    TaskStatus,
    TaskCancel,
    ThemeSet,
    RunStart,
    RunCancel,
}

#[derive(Debug, Default)]
pub struct RuntimeInfoState {
    pub active_run_id: Option<String>,
    pub session_id: Option<String>,
    pub current_provider: Option<String>,
    pub current_model: Option<String>,
    pub current_reasoning: Option<String>,
    pub supports_mcp_list: bool,
    pub supports_skills_list: bool,
    pub supports_context_inspect: bool,
    pub supports_tool_call: bool,
    pub supports_theme_set: bool,
    pub supports_shell_exec: bool,
    pub supports_shell_tasks: bool,
    pub supports_shell_detach: bool,
    pub supports_tasks: bool,
}

impl ErrorDetailMode {
    pub fn label(self) -> &'static str {
        match self {
            Self::Summary => "summary",
            Self::Detail => "detail",
        }
    }
}

impl RpcPendingState {
    pub fn has_auto_start_blockers(&self) -> bool {
        self.model_list_id.is_some()
            || self.model_set_id.is_some()
            || self.theme_set_id.is_some()
            || self.session_list_id.is_some()
            || self.session_history_id.is_some()
            || self.mcp_list_id.is_some()
            || self.context_inspect_id.is_some()
            || self.skills_list_id.is_some()
            || self.lane_list_id.is_some()
            || self.lane_status_id.is_some()
            || self.lane_close_id.is_some()
            || self.lane_create_id.is_some()
            || self.logout_id.is_some()
            || self.shell_exec_id.is_some()
            || self.shell_start_id.is_some()
            || self.shell_wait_id.is_some()
            || self.shell_detach_id.is_some()
            || self.task_list_id.is_some()
            || self.task_status_id.is_some()
            || self.task_cancel_id.is_some()
    }

    pub fn take_match_for_response(&mut self, response_id: &str) -> Option<PendingRpcMatch> {
        if self.session_list_id.as_deref() == Some(response_id) {
            self.session_list_id = None;
            return Some(PendingRpcMatch::SessionList);
        }

        if self.session_history_id.as_deref() == Some(response_id) {
            self.session_history_id = None;
            return Some(PendingRpcMatch::SessionHistory);
        }

        if self.model_list_id.as_deref() == Some(response_id) {
            self.model_list_id = None;
            let mode = self.model_list_mode.take().unwrap_or(ModelListMode::Picker);
            return Some(PendingRpcMatch::ModelList { mode });
        }

        if self.model_set_id.as_deref() == Some(response_id) {
            self.model_set_id = None;
            return Some(PendingRpcMatch::ModelSet);
        }

        if self.mcp_list_id.as_deref() == Some(response_id) {
            self.mcp_list_id = None;
            return Some(PendingRpcMatch::McpList {
                detail_id: self.mcp_detail_id.take(),
            });
        }

        if self.lane_list_id.as_deref() == Some(response_id) {
            self.lane_list_id = None;
            return Some(PendingRpcMatch::LaneList);
        }

        if self.lane_status_id.as_deref() == Some(response_id) {
            self.lane_status_id = None;
            return Some(PendingRpcMatch::LaneStatus);
        }

        if self.lane_close_id.as_deref() == Some(response_id) {
            self.lane_close_id = None;
            return Some(PendingRpcMatch::LaneClose);
        }

        if self.lane_create_id.as_deref() == Some(response_id) {
            self.lane_create_id = None;
            return Some(PendingRpcMatch::LaneCreate);
        }

        if self.skills_list_id.as_deref() == Some(response_id) {
            self.skills_list_id = None;
            return Some(PendingRpcMatch::SkillsList);
        }

        if self.context_inspect_id.as_deref() == Some(response_id) {
            self.context_inspect_id = None;
            return Some(PendingRpcMatch::ContextInspect);
        }

        if self.logout_id.as_deref() == Some(response_id) {
            self.logout_id = None;
            return Some(PendingRpcMatch::Logout);
        }

        if self.shell_exec_id.as_deref() == Some(response_id) {
            self.shell_exec_id = None;
            return Some(PendingRpcMatch::ShellExec);
        }

        if self.shell_start_id.as_deref() == Some(response_id) {
            self.shell_start_id = None;
            return Some(PendingRpcMatch::ShellStart);
        }

        if self.shell_wait_id.as_deref() == Some(response_id) {
            self.shell_wait_id = None;
            return Some(PendingRpcMatch::ShellWait);
        }

        if self.shell_detach_id.as_deref() == Some(response_id) {
            self.shell_detach_id = None;
            return Some(PendingRpcMatch::ShellDetach);
        }

        if self.task_list_id.as_deref() == Some(response_id) {
            self.task_list_id = None;
            return Some(PendingRpcMatch::TaskList);
        }

        if self.task_status_id.as_deref() == Some(response_id) {
            self.task_status_id = None;
            return Some(PendingRpcMatch::TaskStatus);
        }

        if self.task_cancel_id.as_deref() == Some(response_id) {
            self.task_cancel_id = None;
            return Some(PendingRpcMatch::TaskCancel);
        }

        if self.theme_set_id.as_deref() == Some(response_id) {
            self.theme_set_id = None;
            return Some(PendingRpcMatch::ThemeSet);
        }

        if self.run_start_id.as_deref() == Some(response_id) {
            self.run_start_id = None;
            return Some(PendingRpcMatch::RunStart);
        }

        if self.run_cancel_id.as_deref() == Some(response_id) {
            self.run_cancel_id = None;
            return Some(PendingRpcMatch::RunCancel);
        }

        None
    }
}

const ERROR_SUMMARY_MAX_CHARS: usize = 180;
const ERROR_DETAIL_MAX_LINES: usize = 24;

pub struct AppState {
    pub log: Vec<LogLine>,
    pub log_version: u64,
    pub wrapped_log_cache: Option<WrappedLogCache>,
    pub debug_perf_enabled: bool,
    pub perf_debug: PerfDebugStats,
    pub input: InputState,
    pub scroll_from_bottom: usize,
    pub log_changed: bool,
    pub last_wrapped_total: usize,
    pub last_wrap_width: usize,
    pub last_log_viewport_height: usize,
    pub render_state: RenderState,
    pub run_status: Option<String>,
    pub context_left_percent: Option<u8>,
    pub mouse_capture_enabled: bool,
    pub last_assistant_text: Option<String>,
    pub run_started_at: Option<Instant>,
    pub run_elapsed: Option<Duration>,
    pub spinner_index: usize,
    pub spinner_last_tick: Instant,
    pub model_picker: Option<ModelPickerState>,
    pub provider_picker: Option<ProviderPickerState>,
    pub reasoning_picker: Option<ReasoningPickerState>,
    pub model_list_panel: Option<ModelListPanelState>,
    pub session_list_panel: Option<SessionListPanelState>,
    pub lane_list_panel: Option<LaneListPanelState>,
    pub context_panel: Option<ContextPanelState>,
    pub skills_list_panel: Option<SkillsListPanelState>,
    pub theme_list_panel: Option<ThemeListPanelState>,
    pub confirm_dialog: Option<ConfirmDialogState>,
    pub pending_confirm_dialog: Option<ConfirmDialogState>,
    pub confirm_input: InputState,
    pub prompt_dialog: Option<PromptDialogState>,
    pub prompt_input: InputState,
    pub pick_dialog: Option<PickDialogState>,
    pub rpc_pending: RpcPendingState,
    pub runtime_info: RuntimeInfoState,
    pub skills_catalog_items: Vec<SkillsListItemState>,
    pub skills_catalog_loaded: bool,
    pub disabled_skill_paths: BTreeSet<String>,
    pub enable_debug_print: bool,
    pub status_line_mode: StatusLineMode,
    pub error_detail_mode: ErrorDetailMode,
    pub last_error_detail: Option<String>,
    pub pending_shift_enter_backslash: Option<Instant>,
    pub pending_component_lines: HashMap<String, LogComponentSpan>,
    pub compaction_sequence_by_scope: HashMap<String, u64>,
    pub active_compaction_component_by_scope: HashMap<String, String>,
    pub permission_preview_by_tool_call: HashMap<String, PermissionPreviewRecord>,
    pub permission_ready_tool_call_ids: HashSet<String>,
    pub pending_image_attachments: HashMap<String, PendingImageAttachment>,
    pub composer_nonce: String,
    pub next_attachment_id: u64,
    pub pending_shell_results: Vec<PendingShellResult>,
    pub active_shell_wait_task_id: Option<String>,
    pub pending_prompt_queue: VecDeque<PendingPromptRun>,
    pub dispatching_prompt: Option<PendingPromptRun>,
    pub next_prompt_queue_id: u64,
    pub next_queue_dispatch_retry_at: Option<Instant>,
    pub bang_input_mode: bool,
}

fn new_composer_nonce() -> String {
    let nanos = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|value| value.as_nanos())
        .unwrap_or(0);
    format!("{nanos:x}")
}

impl Default for AppState {
    fn default() -> Self {
        Self {
            log: Vec::new(),
            log_version: 0,
            wrapped_log_cache: None,
            debug_perf_enabled: false,
            perf_debug: PerfDebugStats::default(),
            input: InputState::default(),
            scroll_from_bottom: 0,
            log_changed: false,
            last_wrapped_total: 0,
            last_wrap_width: 0,
            last_log_viewport_height: 0,
            render_state: RenderState::default(),
            run_status: None,
            context_left_percent: None,
            mouse_capture_enabled: false,
            last_assistant_text: None,
            run_started_at: None,
            run_elapsed: None,
            spinner_index: 0,
            spinner_last_tick: Instant::now(),
            model_picker: None,
            provider_picker: None,
            reasoning_picker: None,
            model_list_panel: None,
            session_list_panel: None,
            lane_list_panel: None,
            context_panel: None,
            skills_list_panel: None,
            theme_list_panel: None,
            confirm_dialog: None,
            pending_confirm_dialog: None,
            confirm_input: InputState::default(),
            prompt_dialog: None,
            prompt_input: InputState::default(),
            pick_dialog: None,
            rpc_pending: RpcPendingState::default(),
            runtime_info: RuntimeInfoState::default(),
            skills_catalog_items: Vec::new(),
            skills_catalog_loaded: false,
            disabled_skill_paths: BTreeSet::new(),
            enable_debug_print: false,
            status_line_mode: StatusLineMode::Info,
            error_detail_mode: ErrorDetailMode::Summary,
            last_error_detail: None,
            pending_shift_enter_backslash: None,
            pending_component_lines: HashMap::new(),
            compaction_sequence_by_scope: HashMap::new(),
            active_compaction_component_by_scope: HashMap::new(),
            permission_preview_by_tool_call: HashMap::new(),
            permission_ready_tool_call_ids: HashSet::new(),
            pending_image_attachments: HashMap::new(),
            composer_nonce: new_composer_nonce(),
            next_attachment_id: 0,
            pending_shell_results: Vec::new(),
            active_shell_wait_task_id: None,
            pending_prompt_queue: VecDeque::new(),
            dispatching_prompt: None,
            next_prompt_queue_id: 1,
            next_queue_dispatch_retry_at: None,
            bang_input_mode: false,
        }
    }
}

mod methods;

#[cfg(test)]
mod tests;
