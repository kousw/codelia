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
    WrappedLogCache,
};
use crate::app::state::{LogKind, LogLine};
use crate::app::util::attachments::referenced_attachment_ids;
use std::collections::{BTreeSet, HashMap};
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

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
    pub pending_skills_query: Option<String>,
    pub pending_skills_scope: Option<SkillsScopeFilter>,
    pub pending_logout_id: Option<String>,
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
    pub status_line_mode: StatusLineMode,
    pub pending_shift_enter_backslash: Option<Instant>,
    pub pending_tool_lines: HashMap<String, usize>,
    pub pending_image_attachments: HashMap<String, PendingImageAttachment>,
    pub composer_nonce: String,
    pub next_attachment_id: u64,
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
            pending_skills_query: None,
            pending_skills_scope: None,
            pending_logout_id: None,
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
            status_line_mode: StatusLineMode::Info,
            pending_shift_enter_backslash: None,
            pending_tool_lines: HashMap::new(),
            pending_image_attachments: HashMap::new(),
            composer_nonce: new_composer_nonce(),
            next_attachment_id: 0,
        }
    }
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
        AppState, ConfirmDialogState, ConfirmMode, ConfirmPhase, CursorPhase, SkillsListItemState,
        SkillsListPanelState, SkillsScopeFilter, SyncPhase,
    };

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
}
