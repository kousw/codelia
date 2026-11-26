use crate::app::state::InputState;
use crate::app::state::LogLine;
use crate::app::state::{
    PendingImageAttachment, PerfDebugStats, RenderState, SkillsListItemState, StatusLineMode,
    TextSelectionPhase, TranscriptHitMap, WrappedLogCache,
};
use crate::app::util::attachments::{ClipboardImport, StagedAttachment};
use crate::app::OverlayState;
use serde_json::Value;
use std::collections::{BTreeSet, HashMap, HashSet, VecDeque};
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

pub(crate) use pending_rpcs::{PendingRpc, PendingRpcSlot, PendingRpcs};

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

#[derive(Debug, Clone, Copy, PartialEq, Eq, Default)]
pub enum ActiveRunSubmitMode {
    #[default]
    Queue,
    Steer,
}

impl ActiveRunSubmitMode {
    pub fn label(self) -> &'static str {
        match self {
            Self::Queue => "queue",
            Self::Steer => "steer",
        }
    }

    pub fn toggled(self) -> Self {
        match self {
            Self::Queue => Self::Steer,
            Self::Steer => Self::Queue,
        }
    }
}

#[derive(Debug, Clone)]
pub struct PendingPromptRun {
    pub seq: u64,
    pub queue_id: String,
    pub queued_at: Instant,
    pub preview: String,
    pub user_text: String,
    pub display_text: String,
    pub image_descriptions: Vec<String>,
    pub input_payload: Value,
    pub attachment_count: usize,
    pub files: crate::app::state::upload::SubmissionFiles,
    pub shell_result_count: usize,
    pub dispatch_attempts: u32,
}

#[derive(Debug, Clone)]
pub struct InFlightSteer {
    pub client_steer_id: String,
    /// Id the runtime confirmed in a valid `run.steer` result.
    pub server_steer_id: Option<String>,
    /// Id read from a `run.steer` result that broke the contract. It is only
    /// used when no confirmed id matches a `steer_applied`.
    pub unverified_steer_id: Option<String>,
    pub run_id: String,
    pub submitted_at: Instant,
    pub submission: PendingPromptRun,
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

#[derive(Debug, Clone, Copy, PartialEq, Eq, serde::Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum ShellRuleScope {
    Session,
    Project,
}

impl ShellRuleScope {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Session => "session",
            Self::Project => "project",
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum ShellRuleRpc {
    InspectTrust {
        trusted: bool,
        session_id: Option<String>,
    },
    SetTrust {
        trusted: bool,
        workspace: String,
        session_id: Option<String>,
    },
    Run {
        session_id: Option<String>,
    },
    List {
        choose_removal: bool,
        session_id: Option<String>,
    },
    Remove {
        rule_id: String,
        scope: ShellRuleScope,
    },
    RemoveTool {
        tool: String,
    },
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ModelFastMode {
    Off,
    Fast,
    Ultrafast,
}

impl ModelFastMode {
    /// Reads the wire value; a speed tier this client does not know is ignored.
    pub(crate) fn from_wire(value: &crate::protocol::ModelFastMode) -> Option<Self> {
        use crate::protocol::{ModelFastMode as Wire, ModelSpeedTier};
        match value {
            Wire::Bool(false) => Some(Self::Off),
            Wire::Bool(true) => Some(Self::Fast),
            Wire::ModelSpeedTier(ModelSpeedTier::Ultrafast) => Some(Self::Ultrafast),
            Wire::ModelSpeedTier(ModelSpeedTier::Unknown(_)) => None,
        }
    }

    pub(crate) fn to_wire(self) -> crate::protocol::ModelFastMode {
        match self {
            Self::Off => crate::protocol::ModelFastMode::Bool(false),
            Self::Fast => crate::protocol::ModelFastMode::Bool(true),
            Self::Ultrafast => crate::protocol::ModelFastMode::ModelSpeedTier(
                crate::protocol::ModelSpeedTier::Ultrafast,
            ),
        }
    }

    pub fn label(self) -> &'static str {
        match self {
            Self::Off => "fast:off",
            Self::Fast => "fast",
            Self::Ultrafast => "ultrafast",
        }
    }
}

#[derive(Debug, Default)]
pub struct RuntimeInfoState {
    pub last_llm_tps: Option<f64>,
    pub model_providers: Vec<String>,
    pub model_reasoning_levels: HashMap<String, Vec<String>>,
    pub supports_auto_review_configure: bool,
    pub supports_permissions_rw: bool,
    pub supports_project_allow_trust: bool,
    pub supports_ui_requests: bool,
    pub supports_structured_approval: bool,
    pub supports_image_generation: bool,
    pub supports_session_lifecycle: bool,
    pub active_run_id: Option<String>,
    pub session_id: Option<String>,
    pub current_provider: Option<String>,
    pub current_model: Option<String>,
    pub current_reasoning: Option<String>,
    pub current_fast: Option<ModelFastMode>,
    pub current_model_source: Option<String>,
    pub supports_mcp_list: bool,
    pub supports_skills_list: bool,
    pub supports_context_inspect: bool,
    pub supports_tool_call: bool,
    pub supports_theme_set: bool,
    pub supports_scoped_logout: bool,
    pub supports_model_ultrafast: bool,
    pub supports_shell_exec: bool,
    pub supports_shell_tasks: bool,
    pub supports_shell_detach: bool,
    pub supports_tasks: bool,
    pub supports_run_steer: bool,
    pub supports_attachment_upload: bool,
    pub attachment_upload_limits: Option<crate::app::state::upload::UploadLimits>,
    pub attachment_session_epoch: u64,
}

impl ErrorDetailMode {
    pub fn label(self) -> &'static str {
        match self {
            Self::Summary => "summary",
            Self::Detail => "detail",
        }
    }
}

const ERROR_SUMMARY_MAX_CHARS: usize = 180;
const ERROR_DETAIL_MAX_LINES: usize = 24;

pub struct AppState {
    pub(crate) stream_preview: crate::app::state::stream_preview::StreamPreview,
    pub image_preview: crate::app::image_preview::ImagePreview,
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
    pub text_selection: TextSelectionPhase,
    pub transcript_hit_map: Option<TranscriptHitMap>,
    pub transcript_frame_revision: u64,
    pub selection_notice: Option<String>,
    pub selection_notice_expires_at: Option<Instant>,
    pub last_assistant_text: Option<String>,
    pub(crate) streamed_completion: bool,
    pub(crate) stream_dirty: bool,
    pub run_started_at: Option<Instant>,
    pub run_elapsed: Option<Duration>,
    pub spinner_index: usize,
    pub spinner_last_tick: Instant,
    pub overlays: OverlayState,
    pub(crate) startup_confirmations: crate::app::startup_confirmations::StartupConfirmations,
    pub(crate) update_control_launcher: Option<crate::app::self_update::LauncherPaths>,
    pub(crate) pending_update_control: Option<crate::app::self_update::PendingUpdateControl>,
    pub(crate) rpc_pending: PendingRpcs,
    pub(crate) new_lane_task_id: Option<String>,
    pub runtime_info: RuntimeInfoState,
    pub(crate) goal: crate::app::goal::GoalUi,
    pub skills_catalog_items: Vec<SkillsListItemState>,
    pub skills_catalog_loaded: bool,
    pub disabled_skill_paths: BTreeSet<String>,
    pub enable_debug_print: bool,
    pub status_line_mode: StatusLineMode,
    pub error_detail_mode: ErrorDetailMode,
    pub last_error_detail: Option<String>,
    pub pending_shift_enter_backslash: Option<Instant>,
    pub pending_component_lines: HashMap<String, LogComponentSpan>,
    pub progress_component_lines: HashMap<String, usize>,
    pub pending_history_progress: HashMap<(String, String), Value>,
    pub compaction_sequence_by_scope: HashMap<String, u64>,
    pub active_compaction_component_by_scope: HashMap<String, String>,
    pub permission_preview_by_tool_call: HashMap<String, PermissionPreviewRecord>,
    pub permission_ready_tool_call_ids: HashSet<String>,
    pub pending_image_attachments: HashMap<String, PendingImageAttachment>,
    pub pending_staged_attachments: HashMap<String, StagedAttachment>,
    pub(crate) clipboard_import: ClipboardImport,
    pub composer_nonce: String,
    pub next_attachment_id: u64,
    pub pending_shell_results: Vec<PendingShellResult>,
    pub active_shell_wait_task_id: Option<String>,
    pub pending_prompt_queue: VecDeque<PendingPromptRun>,
    pub dispatching_prompt: Option<PendingPromptRun>,
    pub in_flight_steers: VecDeque<InFlightSteer>,
    pub active_run_submit_mode: ActiveRunSubmitMode,
    pub next_submit_seq: u64,
    pub next_prompt_queue_id: u64,
    pub next_steer_client_id: u64,
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
            image_preview: crate::app::image_preview::ImagePreview::default(),
            stream_preview: Default::default(),
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
            text_selection: TextSelectionPhase::default(),
            transcript_hit_map: None,
            transcript_frame_revision: 0,
            selection_notice: None,
            selection_notice_expires_at: None,
            last_assistant_text: None,
            streamed_completion: false,
            stream_dirty: false,
            run_started_at: None,
            run_elapsed: None,
            spinner_index: 0,
            spinner_last_tick: Instant::now(),
            overlays: OverlayState::default(),
            startup_confirmations: Default::default(),
            update_control_launcher: None,
            pending_update_control: None,
            rpc_pending: PendingRpcs::default(),
            new_lane_task_id: None,
            runtime_info: RuntimeInfoState::default(),
            goal: crate::app::goal::GoalUi::default(),
            skills_catalog_items: Vec::new(),
            skills_catalog_loaded: false,
            disabled_skill_paths: BTreeSet::new(),
            enable_debug_print: false,
            status_line_mode: StatusLineMode::Info,
            error_detail_mode: ErrorDetailMode::Summary,
            last_error_detail: None,
            pending_shift_enter_backslash: None,
            pending_component_lines: HashMap::new(),
            progress_component_lines: HashMap::new(),
            pending_history_progress: HashMap::new(),
            compaction_sequence_by_scope: HashMap::new(),
            active_compaction_component_by_scope: HashMap::new(),
            permission_preview_by_tool_call: HashMap::new(),
            permission_ready_tool_call_ids: HashSet::new(),
            pending_image_attachments: HashMap::new(),
            pending_staged_attachments: HashMap::new(),
            clipboard_import: ClipboardImport::default(),
            composer_nonce: new_composer_nonce(),
            next_attachment_id: 0,
            pending_shell_results: Vec::new(),
            active_shell_wait_task_id: None,
            pending_prompt_queue: VecDeque::new(),
            dispatching_prompt: None,
            in_flight_steers: VecDeque::new(),
            active_run_submit_mode: ActiveRunSubmitMode::default(),
            next_submit_seq: 1,
            next_prompt_queue_id: 1,
            next_steer_client_id: 1,
            next_queue_dispatch_retry_at: None,
            bang_input_mode: false,
        }
    }
}

mod clipboard_import;
mod methods;
mod pending_rpcs;
mod streaming;

#[cfg(test)]
mod tests;
