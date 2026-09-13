use crate::app::state::log::LogLine;
use std::ops::Deref;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum SyncPhase {
    Idle,
    NeedsInsert,
    InsertedNeedsRedraw,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ConfirmPhase {
    None,
    Pending,
    Active,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum CursorPhase {
    VisibleAtComposer,
    HiddenDuringScrollbackInsert,
}

/// Next uncommitted source position, independent of terminal width and padding.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq, PartialOrd, Ord)]
pub struct LogPosition {
    pub line: usize,
    pub grapheme: usize,
}

pub struct RenderState {
    pub wrapped_total: usize,
    pub visible_start: usize,
    pub visible_end: usize,
    pub inserted_until: usize,
    pub committed: LogPosition,
    pub sync_phase: SyncPhase,
    pub confirm_phase: ConfirmPhase,
    pub cursor_phase: CursorPhase,
}

impl Default for RenderState {
    fn default() -> Self {
        Self {
            wrapped_total: 0,
            visible_start: 0,
            visible_end: 0,
            inserted_until: 0,
            committed: LogPosition::default(),
            sync_phase: SyncPhase::Idle,
            confirm_phase: ConfirmPhase::None,
            cursor_phase: CursorPhase::VisibleAtComposer,
        }
    }
}

#[derive(Clone, Debug)]
pub struct SelectableFragment {
    pub cell_start: usize,
    pub cell_end: usize,
    pub text: String,
}

#[derive(Clone, Debug)]
pub struct WrappedLogRow {
    pub line: LogLine,
    pub selectable_fragments: Vec<SelectableFragment>,
    pub soft_wrap_after: bool,
    pub source_end: LogPosition,
}

impl Deref for WrappedLogRow {
    type Target = LogLine;

    fn deref(&self) -> &Self::Target {
        &self.line
    }
}

pub struct WrappedLogCache {
    pub width: usize,
    pub log_version: u64,
    pub committed: LogPosition,
    pub wrapped: Vec<WrappedLogRow>,
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
    pub tui_rss_bytes: Option<u64>,
    pub runtime_rss_bytes: Option<u64>,
}
