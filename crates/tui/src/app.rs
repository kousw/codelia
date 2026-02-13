use crate::input::InputState;
use crate::model::{LogKind, LogLine};
use std::collections::{BTreeSet, HashMap};
use std::time::{Duration, Instant};

pub struct ModelPickerState {
    pub models: Vec<String>,
    pub selected: usize,
}

#[derive(Debug, Clone, Copy)]
pub enum ModelListMode {
    Picker,
    List,
    Silent,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ModelListViewMode {
    Limits,
    Cost,
}

impl ModelListViewMode {
    pub fn toggle(self) -> Self {
        match self {
            ModelListViewMode::Limits => ModelListViewMode::Cost,
            ModelListViewMode::Cost => ModelListViewMode::Limits,
        }
    }

    pub fn label(self) -> &'static str {
        match self {
            ModelListViewMode::Limits => "limits",
            ModelListViewMode::Cost => "cost",
        }
    }
}

pub enum ModelListSubmitAction {
    ModelSet,
    UiPick {
        request_id: String,
        item_ids: Vec<String>,
    },
}

pub struct ProviderPickerState {
    pub providers: Vec<String>,
    pub selected: usize,
    pub mode: ModelListMode,
}

#[derive(Debug, Clone, Copy)]
pub enum StatusLineMode {
    Info,
    Help,
}

pub struct ModelListPanelState {
    pub title: String,
    pub header_limits: String,
    pub rows_limits: Vec<String>,
    pub header_cost: String,
    pub rows_cost: Vec<String>,
    pub model_ids: Vec<String>,
    pub selected: usize,
    pub view_mode: ModelListViewMode,
    pub submit_action: ModelListSubmitAction,
}

pub struct SessionListPanelState {
    pub title: String,
    pub header: String,
    pub rows: Vec<String>,
    pub session_ids: Vec<String>,
    pub selected: usize,
}

pub struct ContextPanelState {
    pub title: String,
    pub header: String,
    pub rows: Vec<String>,
    pub selected: usize,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum SkillsScopeFilter {
    All,
    Repo,
    User,
}

impl SkillsScopeFilter {
    pub fn cycle(self) -> Self {
        match self {
            SkillsScopeFilter::All => SkillsScopeFilter::Repo,
            SkillsScopeFilter::Repo => SkillsScopeFilter::User,
            SkillsScopeFilter::User => SkillsScopeFilter::All,
        }
    }

    pub fn label(self) -> &'static str {
        match self {
            SkillsScopeFilter::All => "all",
            SkillsScopeFilter::Repo => "repo",
            SkillsScopeFilter::User => "user",
        }
    }

    pub fn matches(self, scope: &str) -> bool {
        match self {
            SkillsScopeFilter::All => true,
            SkillsScopeFilter::Repo => scope == "repo",
            SkillsScopeFilter::User => scope == "user",
        }
    }
}

#[derive(Clone)]
pub struct SkillsListItemState {
    pub name: String,
    pub description: String,
    pub path: String,
    pub scope: String,
    pub enabled: bool,
}

pub struct SkillsListPanelState {
    pub title: String,
    pub header: String,
    pub rows: Vec<String>,
    pub filtered_indices: Vec<usize>,
    pub items: Vec<SkillsListItemState>,
    pub selected: usize,
    pub search_query: String,
    pub scope_filter: SkillsScopeFilter,
}

impl SkillsListPanelState {
    pub fn rebuild(&mut self) {
        let query = self.search_query.trim().to_lowercase();
        self.filtered_indices = self
            .items
            .iter()
            .enumerate()
            .filter_map(|(index, item)| {
                if !self.scope_filter.matches(&item.scope) {
                    return None;
                }
                if query.is_empty() {
                    return Some(index);
                }
                let haystack = format!(
                    "{} {} {}",
                    item.name.to_lowercase(),
                    item.description.to_lowercase(),
                    item.path.to_lowercase()
                );
                haystack.contains(&query).then_some(index)
            })
            .collect();

        if self.filtered_indices.is_empty() {
            self.selected = 0;
            self.rows = vec!["(no skills matched)".to_string()];
        } else {
            self.selected = self
                .selected
                .min(self.filtered_indices.len().saturating_sub(1));
            self.rows = self
                .filtered_indices
                .iter()
                .map(|index| {
                    let item = &self.items[*index];
                    let marker = if item.enabled { "*" } else { "x" };
                    format!(
                        "{marker} [{:<4}] {:<24} {}",
                        item.scope, item.name, item.description
                    )
                })
                .collect();
        }

        let enabled_count = self.items.iter().filter(|item| item.enabled).count();
        self.header = format!(
            "scope={} query=\"{}\" enabled={}/{} | Enter:insert  Space/E:toggle  Tab:scope  type:search",
            self.scope_filter.label(),
            self.search_query,
            enabled_count,
            self.items.len()
        );
    }

    pub fn selected_item_index(&self) -> Option<usize> {
        self.filtered_indices.get(self.selected).copied()
    }
}

pub struct ConfirmDialogState {
    pub id: String,
    pub title: String,
    pub message: String,
    pub danger_level: Option<String>,
    pub confirm_label: String,
    pub cancel_label: String,
    pub allow_remember: bool,
    pub allow_reason: bool,
    pub selected: usize,
    pub mode: ConfirmMode,
}

pub struct PromptDialogState {
    pub id: String,
    pub title: String,
    pub message: String,
    pub multiline: bool,
    pub secret: bool,
}

pub struct PickDialogItem {
    pub id: String,
    pub label: String,
    pub detail: Option<String>,
}

pub struct PickDialogState {
    pub id: String,
    pub title: String,
    pub items: Vec<PickDialogItem>,
    pub selected: usize,
    pub multi: bool,
    pub chosen: Vec<bool>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ConfirmMode {
    Select,
    Reason,
}

pub struct WrappedLogCache {
    pub width: usize,
    pub log_version: u64,
    pub wrapped: Vec<LogLine>,
}

#[derive(Default)]
pub struct PerfDebugStats {
    pub frame_last_ms: f64,
    pub draw_last_ms: f64,
    pub wrap_last_miss_ms: f64,
    pub wrap_cache_hits: u64,
    pub wrap_cache_misses: u64,
    pub redraw_count: u64,
    pub wrapped_total: usize,
}

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
    pub inline_scrollback_inserted: usize,
    pub inline_scrollback_width: usize,
    pub inline_scrollback_pending: bool,
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
    pub context_panel: Option<ContextPanelState>,
    pub skills_list_panel: Option<SkillsListPanelState>,
    pub confirm_dialog: Option<ConfirmDialogState>,
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
    pub status_line_mode: StatusLineMode,
    pub pending_shift_enter_backslash: Option<Instant>,
    pub pending_tool_lines: HashMap<String, usize>,
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
            inline_scrollback_inserted: 0,
            inline_scrollback_width: 0,
            inline_scrollback_pending: false,
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
            context_panel: None,
            skills_list_panel: None,
            confirm_dialog: None,
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
            status_line_mode: StatusLineMode::Info,
            pending_shift_enter_backslash: None,
            pending_tool_lines: HashMap::new(),
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
        self.inline_scrollback_inserted = 0;
        self.inline_scrollback_width = 0;
        self.inline_scrollback_pending = false;
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
}

#[cfg(test)]
mod tests {
    use super::{SkillsListItemState, SkillsListPanelState, SkillsScopeFilter};

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
}
