//! The rule's period clock: pure arithmetic on unix seconds, no I/O. Periods are numbered from
//! the jar's first proven top-up (ADR 0005): period 0 starts then, period n `n × period` later.

/// The period `now` falls in. `period` is at least 60 seconds (checked at creation).
pub fn period_index(started_at: u64, period: u64, now: u64) -> u64 {
    now.saturating_sub(started_at) / period
}

/// Seconds from `now` until the period after `index` starts.
pub fn until_next_period(started_at: u64, period: u64, index: u64, now: u64) -> u64 {
    index
        .saturating_add(1)
        .saturating_mul(period)
        .saturating_add(started_at)
        .saturating_sub(now)
}

/// A wait in the two largest units, as a refusal reads it: `3d 4h`, `2h 5m`, `4m 10s`, `10s`.
pub fn wait(seconds: u64) -> String {
    const MINUTE: u64 = 60;
    const HOUR: u64 = 60 * MINUTE;
    const DAY: u64 = 24 * HOUR;
    match seconds {
        s if s >= DAY => format!("{}d {}h", s / DAY, s % DAY / HOUR),
        s if s >= HOUR => format!("{}h {}m", s / HOUR, s % HOUR / MINUTE),
        s if s >= MINUTE => format!("{}m {}s", s / MINUTE, s % MINUTE),
        s => format!("{s}s"),
    }
}
