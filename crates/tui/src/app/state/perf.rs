use std::time::Duration;

/// Fixed-capacity allocation-free ring buffer storing durations in microseconds.
#[derive(Debug, Clone)]
pub struct RingMicros<const N: usize> {
    buf: [u32; N],
    len: usize,
    head: usize,
    last: u32,
}

impl<const N: usize> Default for RingMicros<N> {
    fn default() -> Self {
        Self {
            buf: [0; N],
            len: 0,
            head: 0,
            last: 0,
        }
    }
}

impl<const N: usize> RingMicros<N> {
    pub fn push(&mut self, duration: Duration) {
        let micros = duration.as_micros().min(u128::from(u32::MAX)) as u32;
        self.push_micros(micros);
    }

    pub fn push_micros(&mut self, micros: u32) {
        if N == 0 {
            return;
        }
        self.last = micros;
        self.buf[self.head] = micros;
        self.head = (self.head + 1) % N;
        if self.len < N {
            self.len += 1;
        }
    }

    #[cfg(test)]
    pub fn count(&self) -> usize {
        self.len
    }

    pub fn last_ms(&self) -> f64 {
        f64::from(self.last) / 1000.0
    }

    pub fn p95_ms(&self) -> f64 {
        if self.len == 0 {
            return 0.0;
        }
        let mut sorted = [0_u32; N];
        sorted[..self.len].copy_from_slice(&self.buf[..self.len]);
        sorted[..self.len].sort_unstable();
        let idx = ((self.len * 95).saturating_sub(1)) / 100;
        f64::from(sorted[idx.min(self.len - 1)]) / 1000.0
    }

    pub fn max_ms(&self) -> f64 {
        if self.len == 0 {
            return 0.0;
        }
        let max_us = self.buf[..self.len].iter().copied().max().unwrap_or(0);
        f64::from(max_us) / 1000.0
    }
}

/// Always-on TUI rendering and event-loop performance store.
/// Recording is allocation-free and O(1); percentiles are only computed on display.
#[derive(Debug, Default)]
pub struct TuiPerfStore {
    pub frame: RingMicros<64>,
    pub draw: RingMicros<64>,
    pub wrap_miss: RingMicros<32>,
    pub stream_flush: RingMicros<64>,
    pub effect: RingMicros<64>,
    pub tick_total: RingMicros<64>,
    pub wrap_cache_hits: u64,
    pub wrap_cache_misses: u64,
    pub redraw_count: u64,
    pub wrapped_total: usize,
    pub log_lines_total: usize,
    pub runtime_lines_processed: u64,
    pub runtime_tick_cap_hits: u64,
    pub slow_ticks_16ms: u64,
    pub slow_ticks_50ms: u64,
    pub tui_rss_bytes: Option<u64>,
    pub runtime_rss_bytes: Option<u64>,
}

impl TuiPerfStore {
    pub fn record_frame(&mut self, frame_duration: Duration, draw_duration: Duration) {
        self.frame.push(frame_duration);
        self.draw.push(draw_duration);
        self.redraw_count = self.redraw_count.saturating_add(1);
    }

    pub fn record_wrap_hit(&mut self, wrapped_total: usize, log_lines_total: usize) {
        self.wrap_cache_hits = self.wrap_cache_hits.saturating_add(1);
        self.wrapped_total = wrapped_total;
        self.log_lines_total = log_lines_total;
    }

    pub fn record_wrap_miss(
        &mut self,
        duration: Duration,
        wrapped_total: usize,
        log_lines_total: usize,
    ) {
        self.wrap_miss.push(duration);
        self.wrap_cache_misses = self.wrap_cache_misses.saturating_add(1);
        self.wrapped_total = wrapped_total;
        self.log_lines_total = log_lines_total;
    }

    pub fn record_stream_flush(&mut self, duration: Duration) {
        self.stream_flush.push(duration);
    }

    pub fn record_effect(&mut self, duration: Duration) {
        self.effect.push(duration);
    }

    pub fn record_runtime_drain(&mut self, processed: usize, hit_cap: bool) {
        if processed > 0 {
            self.runtime_lines_processed = self
                .runtime_lines_processed
                .saturating_add(processed as u64);
        }
        if hit_cap {
            self.runtime_tick_cap_hits = self.runtime_tick_cap_hits.saturating_add(1);
        }
    }

    pub fn record_tick(&mut self, duration: Duration) {
        self.tick_total.push(duration);
        if duration >= Duration::from_millis(16) {
            self.slow_ticks_16ms = self.slow_ticks_16ms.saturating_add(1);
        }
        if duration >= Duration::from_millis(50) {
            self.slow_ticks_50ms = self.slow_ticks_50ms.saturating_add(1);
        }
    }

    pub fn wrap_hit_rate(&self) -> f64 {
        let total = self.wrap_cache_hits.saturating_add(self.wrap_cache_misses);
        if total == 0 {
            0.0
        } else {
            (self.wrap_cache_hits as f64 * 100.0) / total as f64
        }
    }
}

#[cfg(test)]
mod tests {
    use super::{RingMicros, TuiPerfStore};
    use std::time::Duration;

    #[test]
    fn ring_micros_computes_last_p95_and_max_across_wraparound() {
        let mut ring = RingMicros::<4>::default();
        assert_eq!(ring.count(), 0);
        assert_eq!(ring.last_ms(), 0.0);
        assert_eq!(ring.p95_ms(), 0.0);
        assert_eq!(ring.max_ms(), 0.0);

        for ms in [1, 2, 10, 4, 20] {
            ring.push(Duration::from_millis(ms));
        }
        // Oldest sample (1ms) evicted; remaining are [2, 10, 4, 20].
        assert_eq!(ring.count(), 4);
        assert_eq!(ring.last_ms(), 20.0);
        assert_eq!(ring.max_ms(), 20.0);
        // Sorted: [2, 4, 10, 20], idx = ((4*95)-1)/100 = 3 -> 20ms
        assert_eq!(ring.p95_ms(), 20.0);
    }

    #[test]
    fn perf_store_tracks_slow_ticks_and_hit_rate() {
        let mut perf = TuiPerfStore::default();
        perf.record_wrap_hit(100, 50);
        perf.record_wrap_hit(100, 50);
        perf.record_wrap_hit(100, 50);
        perf.record_wrap_miss(Duration::from_micros(2500), 120, 60);
        assert_eq!(perf.wrap_hit_rate(), 75.0);
        assert_eq!(perf.wrap_miss.last_ms(), 2.5);
        assert_eq!(perf.wrapped_total, 120);
        assert_eq!(perf.log_lines_total, 60);

        perf.record_tick(Duration::from_millis(5));
        perf.record_tick(Duration::from_millis(20));
        perf.record_tick(Duration::from_millis(60));
        assert_eq!(perf.slow_ticks_16ms, 2);
        assert_eq!(perf.slow_ticks_50ms, 1);
    }
}
