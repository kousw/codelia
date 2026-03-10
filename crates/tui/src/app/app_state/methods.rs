use super::{
    new_composer_nonce, AppState, ErrorDetailMode, ERROR_DETAIL_MAX_LINES, ERROR_SUMMARY_MAX_CHARS,
};
use crate::app::state::{
    ConfirmPhase, LogKind, LogLine, LogTone, PendingImageAttachment, RenderState, StatusLineMode,
    SyncPhase,
};
use crate::app::util::{attachments::referenced_attachment_ids, PerfMemorySample};
use std::time::{Duration, Instant};

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

    pub fn record_memory_sample(&mut self, sample: PerfMemorySample) -> bool {
        if !self.debug_perf_enabled {
            return false;
        }
        let changed = self.perf_debug.tui_rss_bytes != sample.tui_rss_bytes
            || self.perf_debug.runtime_rss_bytes != sample.runtime_rss_bytes;
        self.perf_debug.tui_rss_bytes = sample.tui_rss_bytes;
        self.perf_debug.runtime_rss_bytes = sample.runtime_rss_bytes;
        changed
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
                self.context_left_percent = None;
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
        self.pending_component_lines.clear();
        self.compaction_sequence_by_scope.clear();
        self.active_compaction_component_by_scope.clear();
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
