use crate::app::state::log::LogLine;
use std::ops::{Deref, Range};

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum SyncPhase {
    Idle,
    NeedsInsert,
    InsertedNeedsRedraw,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum CursorPhase {
    VisibleAtComposer,
    VisibleAtImagePreview,
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
    pub cursor_phase: CursorPhase,
    pub(crate) drawn_update_choice: Option<(String, usize)>,
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
            cursor_phase: CursorPhase::VisibleAtComposer,
            drawn_update_choice: None,
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
    pub line_row_ranges: Vec<Range<usize>>,
    pub dirty_from: usize,
}

impl WrappedLogCache {
    pub fn mark_dirty_from(&mut self, line_index: usize) {
        self.dirty_from = self.dirty_from.min(line_index);
    }
}
