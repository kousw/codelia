use crate::app::state::log::LogLine;

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

pub struct RenderState {
    pub wrapped_total: usize,
    pub visible_start: usize,
    pub visible_end: usize,
    pub inserted_until: usize,
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
            sync_phase: SyncPhase::Idle,
            confirm_phase: ConfirmPhase::None,
            cursor_phase: CursorPhase::VisibleAtComposer,
        }
    }
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
