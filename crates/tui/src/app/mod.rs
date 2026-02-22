pub(crate) mod handlers;
pub(crate) mod render;
pub(crate) mod runtime;
pub(crate) mod state;
pub(crate) mod util;
pub(crate) mod view;

use crate::app::state::InputState;
pub(crate) use crate::app::state::{
    ConfirmDialogState, ConfirmMode, ConfirmPhase, ContextPanelState, CursorPhase, LaneListItem,
    LaneListPanelState, ModelListMode, ModelListPanelState, ModelListSubmitAction,
    ModelListViewMode, ModelPickerState, PendingImageAttachment, PerfDebugStats, PickDialogItem,
    PickDialogState, PromptDialogState, ProviderPickerState, RenderState, SessionListPanelState,
    SkillsListItemState, SkillsListPanelState, SkillsScopeFilter, StatusLineMode, SyncPhase,
    ThemeListPanelState, WrappedLogCache,
};
use crate::app::state::{LogKind, LogLine, LogTone};
use crate::app::util::attachments::referenced_attachment_ids;
use serde_json::Value;
use std::collections::{BTreeSet, HashMap, VecDeque};
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

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
}

#[derive(Debug, Clone, Default)]
pub struct PermissionPreviewRecord {
    pub has_diff: bool,
    pub truncated: bool,
    pub diff_fingerprint: Option<String>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ErrorDetailMode {
    Summary,
    Detail,
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
    pub pending_model_list_id: Option<String>,
    pub pending_model_list_mode: Option<ModelListMode>,
    pub pending_model_set_id: Option<String>,
    pub pending_run_start_id: Option<String>,
    pub pending_run_cancel_id: Option<String>,
    pub pending_session_list_id: Option<String>,
    pub pending_session_history_id: Option<String>,
    pub pending_lane_list_id: Option<String>,
    pub pending_lane_status_id: Option<String>,
    pub pending_lane_close_id: Option<String>,
    pub pending_lane_create_id: Option<String>,
    pub pending_new_lane_seed_context: Option<String>,
    pub pending_mcp_list_id: Option<String>,
    pub pending_mcp_detail_id: Option<String>,
    pub pending_context_inspect_id: Option<String>,
    pub pending_skills_list_id: Option<String>,
    pub pending_theme_set_id: Option<String>,
    pub pending_skills_query: Option<String>,
    pub pending_skills_scope: Option<SkillsScopeFilter>,
    pub pending_logout_id: Option<String>,
    pub pending_shell_exec_id: Option<String>,
    pub active_run_id: Option<String>,
    pub session_id: Option<String>,
    pub current_provider: Option<String>,
    pub current_model: Option<String>,
    pub skills_catalog_items: Vec<SkillsListItemState>,
    pub skills_catalog_loaded: bool,
    pub disabled_skill_paths: BTreeSet<String>,
    pub enable_debug_print: bool,
    pub supports_mcp_list: bool,
    pub supports_skills_list: bool,
    pub supports_context_inspect: bool,
    pub supports_tool_call: bool,
    pub supports_theme_set: bool,
    pub supports_shell_exec: bool,
    pub status_line_mode: StatusLineMode,
    pub error_detail_mode: ErrorDetailMode,
    pub last_error_detail: Option<String>,
    pub pending_shift_enter_backslash: Option<Instant>,
    pub pending_tool_lines: HashMap<String, usize>,
    pub permission_preview_by_tool_call: HashMap<String, PermissionPreviewRecord>,
    pub pending_image_attachments: HashMap<String, PendingImageAttachment>,
    pub composer_nonce: String,
    pub next_attachment_id: u64,
    pub pending_shell_results: Vec<PendingShellResult>,
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
            pending_model_list_id: None,
            pending_model_list_mode: None,
            pending_model_set_id: None,
            pending_run_start_id: None,
            pending_run_cancel_id: None,
            pending_session_list_id: None,
            pending_session_history_id: None,
            pending_lane_list_id: None,
            pending_lane_status_id: None,
            pending_lane_close_id: None,
            pending_lane_create_id: None,
            pending_new_lane_seed_context: None,
            pending_mcp_list_id: None,
            pending_mcp_detail_id: None,
            pending_context_inspect_id: None,
            pending_skills_list_id: None,
            pending_theme_set_id: None,
            pending_skills_query: None,
            pending_skills_scope: None,
            pending_logout_id: None,
            pending_shell_exec_id: None,
            active_run_id: None,
            session_id: None,
            current_provider: None,
            current_model: None,
            skills_catalog_items: Vec::new(),
            skills_catalog_loaded: false,
            disabled_skill_paths: BTreeSet::new(),
            enable_debug_print: false,
            supports_mcp_list: false,
            supports_skills_list: false,
            supports_context_inspect: false,
            supports_tool_call: false,
            supports_theme_set: false,
            supports_shell_exec: false,
            status_line_mode: StatusLineMode::Info,
            error_detail_mode: ErrorDetailMode::Summary,
            last_error_detail: None,
            pending_shift_enter_backslash: None,
            pending_tool_lines: HashMap::new(),
            permission_preview_by_tool_call: HashMap::new(),
            pending_image_attachments: HashMap::new(),
            composer_nonce: new_composer_nonce(),
            next_attachment_id: 0,
            pending_shell_results: Vec::new(),
            pending_prompt_queue: VecDeque::new(),
            dispatching_prompt: None,
            next_prompt_queue_id: 1,
            next_queue_dispatch_retry_at: None,
            bang_input_mode: false,
        }
    }
}

fn truncate_chars(text: &str, max: usize) -> String {
    if max == 0 {
        return String::new();
    }
    let count = text.chars().count();
    if count <= max {
        return text.to_string();
    }
    let take = max.saturating_sub(3);
    let truncated: String = text.chars().take(take).collect();
    format!("{truncated}...")
}

fn first_non_empty_line(text: &str) -> Option<String> {
    text.lines()
        .map(str::trim)
        .find(|line| !line.is_empty())
        .map(|line| line.to_string())
}

fn actionable_error_hint(text: &str) -> Option<&'static str> {
    let lower = text.to_ascii_lowercase();
    if lower.contains("runtime busy") {
        return Some("wait for the active run to finish, then retry");
    }
    if lower.contains("invalid params") || lower.contains("usage:") {
        return Some("check command arguments and retry");
    }
    if lower.contains("method not found") {
        return Some("runtime may be outdated; check supported commands");
    }
    if lower.contains("timeout") || lower.contains("timed out") {
        return Some("retry after a short wait");
    }
    if lower.contains("auth")
        || lower.contains("unauthorized")
        || lower.contains("forbidden")
        || lower.contains("api key")
    {
        return Some("check authentication/API key settings");
    }
    if lower.contains("permission")
        || lower.contains("denied")
        || lower.contains("eacces")
        || lower.contains("security error")
    {
        return Some("review sandbox/permission settings");
    }
    None
}

impl AppState {
    fn mark_log_changed(&mut self) {
        self.log_version = self.log_version.wrapping_add(1);
        self.wrapped_log_cache = None;
        self.log_changed = true;
    }

    pub fn is_running(&self) -> bool {
        matches!(
            self.run_status.as_deref(),
            Some("starting") | Some("running") | Some("awaiting_ui")
        )
    }

    pub fn record_perf_frame(&mut self, frame_duration: Duration, draw_duration: Duration) {
        if !self.debug_perf_enabled {
            return;
        }
        self.perf_debug.frame_last_ms = frame_duration.as_secs_f64() * 1000.0;
        self.perf_debug.draw_last_ms = draw_duration.as_secs_f64() * 1000.0;
        self.perf_debug.redraw_count = self.perf_debug.redraw_count.saturating_add(1);
    }

    pub fn record_wrap_cache_hit(&mut self, wrapped_total: usize) {
        if !self.debug_perf_enabled {
            return;
        }
        self.perf_debug.wrap_cache_hits = self.perf_debug.wrap_cache_hits.saturating_add(1);
        self.perf_debug.wrapped_total = wrapped_total;
    }

    pub fn record_wrap_cache_miss(&mut self, duration: Duration, wrapped_total: usize) {
        if !self.debug_perf_enabled {
            return;
        }
        self.perf_debug.wrap_last_miss_ms = duration.as_secs_f64() * 1000.0;
        self.perf_debug.wrap_cache_misses = self.perf_debug.wrap_cache_misses.saturating_add(1);
        self.perf_debug.wrapped_total = wrapped_total;
    }

    pub fn update_run_status(&mut self, status: String) {
        let previous = self.run_status.clone();
        let changed = self.run_status.as_deref() != Some(status.as_str());
        self.run_status = Some(status.clone());
        if changed {
            let was_active = matches!(
                previous.as_deref(),
                Some("starting") | Some("running") | Some("awaiting_ui")
            );
            let now_active = matches!(status.as_str(), "starting" | "running" | "awaiting_ui");
            if now_active && !was_active {
                self.run_started_at = Some(Instant::now());
                self.run_elapsed = None;
            }
            if matches!(status.as_str(), "completed" | "error" | "cancelled") {
                if let Some(start) = self.run_started_at {
                    self.run_elapsed = Some(start.elapsed());
                }
            }
        }
    }

    pub fn run_duration(&self) -> Option<Duration> {
        self.run_elapsed
            .or_else(|| self.run_started_at.map(|start| start.elapsed()))
    }

    pub fn toggle_status_line_mode(&mut self) {
        self.status_line_mode = match self.status_line_mode {
            StatusLineMode::Info => StatusLineMode::Help,
            StatusLineMode::Help => StatusLineMode::Info,
        };
    }

    pub fn set_error_detail_mode(&mut self, mode: ErrorDetailMode) {
        self.error_detail_mode = mode;
    }

    fn push_error_detail_lines(lines: &mut Vec<LogLine>, detail: &str) {
        let mut detail_lines = detail
            .lines()
            .map(|line| line.trim_end_matches('\r').to_string())
            .collect::<Vec<_>>();
        if detail_lines.is_empty() {
            return;
        }
        let truncated = detail_lines.len().saturating_sub(ERROR_DETAIL_MAX_LINES);
        if truncated > 0 {
            detail_lines.truncate(ERROR_DETAIL_MAX_LINES);
        }
        for line in detail_lines {
            lines.push(LogLine::new_with_tone(
                LogKind::Error,
                LogTone::Detail,
                format!("  {line}"),
            ));
        }
        if truncated > 0 {
            lines.push(LogLine::new_with_tone(
                LogKind::Error,
                LogTone::Detail,
                format!("  ... ({truncated} more lines)"),
            ));
        }
    }

    pub fn push_error_report(&mut self, summary: impl Into<String>, detail: impl Into<String>) {
        let summary_raw = summary.into();
        let detail_raw = detail.into();
        let normalized_detail = detail_raw
            .replace("\r\n", "\n")
            .replace('\r', "\n")
            .trim()
            .to_string();
        let first_detail = first_non_empty_line(&normalized_detail)
            .map(|line| truncate_chars(&line, ERROR_SUMMARY_MAX_CHARS));

        let mut summary_text = summary_raw.trim().to_string();
        if let Some(first) = first_detail.as_deref() {
            if summary_text.is_empty() {
                summary_text = first.to_string();
            } else if !summary_text.contains(':')
                && !summary_text
                    .to_ascii_lowercase()
                    .contains(&first.to_ascii_lowercase())
            {
                summary_text = format!("{summary_text}: {first}");
            }
        } else if summary_text.is_empty() {
            summary_text = "error".to_string();
        }

        if let Some(hint) = actionable_error_hint(&normalized_detail) {
            let lower = summary_text.to_ascii_lowercase();
            if !lower.contains("retry")
                && !lower.contains("check ")
                && !lower.contains("wait ")
                && !lower.contains("review ")
            {
                summary_text = format!("{summary_text} ({hint})");
            }
        }

        let mut detail_for_log = if normalized_detail.is_empty() {
            None
        } else {
            Some(normalized_detail)
        };
        if let (Some(first), Some(detail_text)) = (first_detail.as_deref(), detail_for_log.as_mut())
        {
            let detail_lines = detail_text
                .lines()
                .map(|line| line.trim_end_matches('\r'))
                .collect::<Vec<_>>();
            if detail_lines.len() == 1
                && summary_text
                    .to_ascii_lowercase()
                    .contains(&first.to_ascii_lowercase())
            {
                detail_for_log = None;
            } else if !detail_lines.is_empty()
                && summary_text
                    .to_ascii_lowercase()
                    .contains(&first.to_ascii_lowercase())
            {
                let tail = detail_lines
                    .into_iter()
                    .skip(1)
                    .collect::<Vec<_>>()
                    .join("\n")
                    .trim()
                    .to_string();
                detail_for_log = if tail.is_empty() { None } else { Some(tail) };
            }
        }

        self.last_error_detail = detail_for_log.clone();
        let mut lines = vec![LogLine::new(LogKind::Error, summary_text)];
        if let Some(detail_text) = detail_for_log {
            if self.error_detail_mode == ErrorDetailMode::Detail {
                Self::push_error_detail_lines(&mut lines, &detail_text);
            } else if detail_text.contains('\n')
                || detail_text.chars().count() > ERROR_SUMMARY_MAX_CHARS
            {
                lines.push(LogLine::new_with_tone(
                    LogKind::Status,
                    LogTone::Detail,
                    "  details hidden; run /errors show",
                ));
            }
        }
        self.extend_lines(lines);
    }

    pub fn show_last_error_detail(&mut self) -> bool {
        let Some(detail) = self.last_error_detail.clone() else {
            self.push_line(LogKind::Status, "No stored error details.");
            return false;
        };
        let mut lines = vec![LogLine::new(LogKind::Status, "Last error details:")];
        Self::push_error_detail_lines(&mut lines, &detail);
        self.extend_lines(lines);
        true
    }

    pub fn spinner_frame(&self) -> &'static str {
        const FRAMES: [&str; 8] = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧"];
        FRAMES[self.spinner_index % FRAMES.len()]
    }

    pub fn update_spinner(&mut self, now: Instant) -> bool {
        if !self.is_running() {
            self.spinner_index = 0;
            self.spinner_last_tick = now;
            return false;
        }
        if now.duration_since(self.spinner_last_tick) >= Duration::from_millis(120) {
            self.spinner_last_tick = now;
            self.spinner_index = self.spinner_index.saturating_add(1);
            return true;
        }
        false
    }

    pub fn clear_log(&mut self) {
        self.log.clear();
        self.pending_tool_lines.clear();
        self.permission_preview_by_tool_call.clear();
        self.last_error_detail = None;
        self.scroll_from_bottom = 0;
        self.mark_log_changed();
        self.render_state = RenderState::default();
        self.render_state.confirm_phase = if self.confirm_dialog.is_some() {
            ConfirmPhase::Active
        } else if self.pending_confirm_dialog.is_some() {
            ConfirmPhase::Pending
        } else {
            ConfirmPhase::None
        };
    }

    pub fn referenced_attachment_ids(&self) -> Vec<String> {
        referenced_attachment_ids(
            &self.input.current(),
            &self.composer_nonce,
            &self.pending_image_attachments,
        )
    }

    pub fn referenced_attachment_count(&self) -> usize {
        self.referenced_attachment_ids().len()
    }

    pub fn prune_unreferenced_attachments(&mut self) {
        let keep = self
            .referenced_attachment_ids()
            .into_iter()
            .collect::<std::collections::HashSet<_>>();
        self.pending_image_attachments
            .retain(|attachment_id, _| keep.contains(attachment_id));
    }

    pub fn clear_composer(&mut self) {
        self.input.clear();
        self.pending_image_attachments.clear();
        self.composer_nonce = new_composer_nonce();
        self.bang_input_mode = false;
    }

    pub fn next_image_attachment_id(&mut self) -> String {
        self.next_attachment_id = self.next_attachment_id.saturating_add(1);
        format!("img{}", self.next_attachment_id)
    }

    pub fn add_pending_image_attachment(&mut self, id: String, attachment: PendingImageAttachment) {
        self.pending_image_attachments.insert(id, attachment);
    }

    pub fn replace_log_line(&mut self, index: usize, line: LogLine) {
        if let Some(slot) = self.log.get_mut(index) {
            *slot = line;
            self.mark_log_changed();
        }
    }

    pub fn push_line(&mut self, kind: LogKind, text: impl Into<String>) {
        self.log.push(LogLine::new(kind, text));
        self.mark_log_changed();
    }

    pub fn extend_lines(&mut self, lines: Vec<LogLine>) {
        if lines.is_empty() {
            return;
        }
        self.log.extend(lines);
        self.mark_log_changed();
    }

    pub fn scroll_up(&mut self, lines: usize) {
        self.scroll_from_bottom = self.scroll_from_bottom.saturating_add(lines);
    }

    pub fn scroll_down(&mut self, lines: usize) {
        self.scroll_from_bottom = self.scroll_from_bottom.saturating_sub(lines);
    }

    pub fn scroll_page_up(&mut self) {
        let page = self.last_log_viewport_height.saturating_sub(1).max(1);
        self.scroll_up(page);
    }

    pub fn scroll_page_down(&mut self) {
        let page = self.last_log_viewport_height.saturating_sub(1).max(1);
        self.scroll_down(page);
    }

    pub fn request_scrollback_sync(&mut self) {
        self.render_state.sync_phase = SyncPhase::NeedsInsert;
    }

    pub fn assert_render_invariants(&self) {
        debug_assert!(
            self.render_state.inserted_until <= self.render_state.visible_start
                && self.render_state.visible_start <= self.render_state.visible_end
                && self.render_state.visible_end <= self.render_state.wrapped_total,
            "render invariant failed: inserted={} visible=[{}, {}) wrapped_total={}",
            self.render_state.inserted_until,
            self.render_state.visible_start,
            self.render_state.visible_end,
            self.render_state.wrapped_total
        );
        debug_assert!(
            self.render_state.confirm_phase == ConfirmPhase::None
                && self.confirm_dialog.is_none()
                && self.pending_confirm_dialog.is_none()
                || self.render_state.confirm_phase == ConfirmPhase::Pending
                    && self.confirm_dialog.is_none()
                    && self.pending_confirm_dialog.is_some()
                || self.render_state.confirm_phase == ConfirmPhase::Active
                    && self.confirm_dialog.is_some()
                    && self.pending_confirm_dialog.is_none(),
            "confirm invariant failed: phase={:?} confirm={} pending={}",
            self.render_state.confirm_phase,
            self.confirm_dialog.is_some(),
            self.pending_confirm_dialog.is_some()
        );
    }
}

#[cfg(test)]
mod tests {
    use super::{
        AppState, ConfirmDialogState, ConfirmMode, ConfirmPhase, CursorPhase, ErrorDetailMode,
        SkillsListItemState, SkillsListPanelState, SkillsScopeFilter, SyncPhase,
    };
    use crate::app::state::LogKind;

    fn sample_panel() -> SkillsListPanelState {
        let mut panel = SkillsListPanelState {
            title: "Skills".to_string(),
            header: String::new(),
            rows: Vec::new(),
            filtered_indices: Vec::new(),
            items: vec![
                SkillsListItemState {
                    name: "repo-review".to_string(),
                    description: "Review repo changes".to_string(),
                    path: "/repo/.agents/skills/repo-review/SKILL.md".to_string(),
                    scope: "repo".to_string(),
                    enabled: true,
                },
                SkillsListItemState {
                    name: "user-helper".to_string(),
                    description: "User helper".to_string(),
                    path: "/home/user/.agents/skills/user-helper/SKILL.md".to_string(),
                    scope: "user".to_string(),
                    enabled: false,
                },
            ],
            selected: 0,
            search_query: String::new(),
            scope_filter: SkillsScopeFilter::All,
        };
        panel.rebuild();
        panel
    }

    #[test]
    fn skills_panel_rebuild_filters_by_scope() {
        let mut panel = sample_panel();
        panel.scope_filter = SkillsScopeFilter::Repo;
        panel.rebuild();
        assert_eq!(panel.filtered_indices.len(), 1);
        assert!(panel.rows[0].contains("[repo]"));
    }

    #[test]
    fn skills_panel_rebuild_filters_by_query() {
        let mut panel = sample_panel();
        panel.search_query = "user".to_string();
        panel.rebuild();
        assert_eq!(panel.filtered_indices.len(), 1);
        assert!(panel.rows[0].contains("user-helper"));
    }

    fn sample_confirm_dialog() -> ConfirmDialogState {
        ConfirmDialogState {
            id: "confirm_1".to_string(),
            title: "Permission".to_string(),
            message: "Allow tool?".to_string(),
            danger_level: None,
            confirm_label: "Allow".to_string(),
            cancel_label: "Deny".to_string(),
            allow_remember: true,
            allow_reason: true,
            selected: 0,
            mode: ConfirmMode::Select,
        }
    }

    #[test]
    fn render_state_invariants_hold_for_confirm_request_activation_and_close() {
        let mut app = AppState::default();
        app.render_state.wrapped_total = 12;
        app.render_state.visible_start = 6;
        app.render_state.visible_end = 12;
        app.assert_render_invariants();

        app.pending_confirm_dialog = Some(sample_confirm_dialog());
        app.render_state.confirm_phase = ConfirmPhase::Pending;
        app.assert_render_invariants();

        app.confirm_dialog = app.pending_confirm_dialog.take();
        app.render_state.confirm_phase = ConfirmPhase::Active;
        app.assert_render_invariants();

        app.confirm_dialog = None;
        app.render_state.confirm_phase = ConfirmPhase::None;
        app.request_scrollback_sync();
        assert_eq!(app.render_state.sync_phase, SyncPhase::NeedsInsert);
        app.assert_render_invariants();
    }

    #[test]
    fn render_state_scenario_tracks_sync_confirm_and_cursor_phases() {
        let mut app = AppState::default();

        // startup first frame
        app.render_state.wrapped_total = 8;
        app.render_state.visible_start = 0;
        app.render_state.visible_end = 8;
        app.assert_render_invariants();

        // append logs -> insertion needed
        app.render_state.wrapped_total = 24;
        app.render_state.visible_start = 10;
        app.render_state.visible_end = 24;
        app.request_scrollback_sync();
        assert_eq!(app.render_state.sync_phase, SyncPhase::NeedsInsert);
        app.assert_render_invariants();

        // insertion applied once
        app.render_state.inserted_until = app.render_state.visible_start;
        app.render_state.sync_phase = SyncPhase::InsertedNeedsRedraw;
        app.render_state.cursor_phase = CursorPhase::HiddenDuringScrollbackInsert;
        app.assert_render_invariants();

        // follow-up redraw completes cursor restore
        app.render_state.sync_phase = SyncPhase::Idle;
        app.render_state.cursor_phase = CursorPhase::VisibleAtComposer;
        app.assert_render_invariants();

        // confirm pending -> active
        app.pending_confirm_dialog = Some(sample_confirm_dialog());
        app.render_state.confirm_phase = ConfirmPhase::Pending;
        app.assert_render_invariants();
        app.confirm_dialog = app.pending_confirm_dialog.take();
        app.render_state.confirm_phase = ConfirmPhase::Active;
        app.assert_render_invariants();

        // confirm close -> next input cycle
        app.confirm_dialog = None;
        app.render_state.confirm_phase = ConfirmPhase::None;
        app.request_scrollback_sync();
        assert_eq!(app.render_state.sync_phase, SyncPhase::NeedsInsert);
        app.assert_render_invariants();
    }

    #[test]
    fn push_error_report_keeps_summary_compact_by_default() {
        let mut app = AppState::default();
        app.push_error_report("run.start error", "runtime busy");
        assert_eq!(app.log.len(), 1);
        assert_eq!(app.log[0].kind(), LogKind::Error);
        assert!(app.log[0]
            .plain_text()
            .contains("run.start error: runtime busy"));
        assert!(app.log[0].plain_text().contains("wait for the active run"));
        assert!(app.last_error_detail.is_none());
    }

    #[test]
    fn push_error_report_can_expand_multiline_details() {
        let mut app = AppState::default();
        app.set_error_detail_mode(ErrorDetailMode::Detail);
        app.push_error_report(
            "rpc error",
            "invalid params\npath: input.text\nexpected string",
        );

        assert_eq!(app.log[0].kind(), LogKind::Error);
        assert!(app.log[0].plain_text().contains("invalid params"));
        assert!(app
            .log
            .iter()
            .any(|line| line.plain_text().contains("path: input.text")));
        assert!(app.last_error_detail.is_some());
    }

    #[test]
    fn show_last_error_detail_prints_stored_payload() {
        let mut app = AppState::default();
        app.push_error_report("rpc error", "first line\nsecond line");
        let shown = app.show_last_error_detail();
        assert!(shown);
        assert!(app
            .log
            .iter()
            .any(|line| line.plain_text().contains("second line")));
    }
}
