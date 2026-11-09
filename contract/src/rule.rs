//! The rule's period clock: pure arithmetic on unix seconds, no I/O. Periods are numbered from
//! the jar's first proven top-up (ADR 0005): period 0 starts then, period n `n × period` later.

use near_sdk::near;

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

/// At most three periods' allowance can wait at once, the current period included (ADR 0005).
const MAX_PERIODS_WAITING: u64 = 3;

/// A jar's allowance account: the last period paid and what it left over. Each period adds the
/// cap; a payment takes what it paid; anything over 3 × cap lapses.
#[near(serializers = [borsh])]
#[derive(Debug, Clone, Default)]
pub struct Ledger {
    /// The period of the last allowance requested. Set when it is requested, so a second
    /// request in that period is refused even while the first is unconfirmed.
    pub paid_period: Option<u64>,
    /// Allowance left unpaid after that payment, carried into later periods.
    pub carried: u64,
    /// The allowance fees spent in `paid_period`.
    pub fees: u64,
    /// The last allowance's payment id.
    pub payment: Option<u64>,
}

impl Ledger {
    /// What an allowance requested in `period` may pay: 0 once that period is paid.
    pub fn available(&self, cap: u64, period: u64) -> u64 {
        let credit = match self.paid_period {
            Some(paid) if paid == period => return 0,
            Some(paid) => self
                .carried
                .saturating_add(period.saturating_sub(paid).saturating_mul(cap)),
            None => period.saturating_add(1).saturating_mul(cap),
        };
        credit.min(cap.saturating_mul(MAX_PERIODS_WAITING))
    }

    /// The period's fee budget (cap / 10) less the allowance fees already spent in it.
    pub fn fee_budget_left(&self, cap: u64, period: u64) -> u64 {
        let spent = if self.paid_period == Some(period) {
            self.fees
        } else {
            0
        };
        (cap / 10).saturating_sub(spent)
    }

    /// When an allowance may next be requested, in unix seconds: the next period's start once
    /// this one is paid, else this period's start (due now). The rule's time only: a pending
    /// payment can still hold the jar after it.
    pub fn next_allowance_at(&self, started_at: u64, length: u64, period: u64) -> u64 {
        let next = if self.paid_period == Some(period) {
            period.saturating_add(1)
        } else {
            period
        };
        next.saturating_mul(length).saturating_add(started_at)
    }

    /// Records the allowance `payment` of `amount` sats (fee `fee`) requested in `period`.
    pub fn record(&mut self, cap: u64, period: u64, amount: u64, fee: u64, payment: u64) {
        let available = self.available(cap, period);
        *self = Ledger {
            paid_period: Some(period),
            carried: available.saturating_sub(amount),
            fees: fee,
            payment: Some(payment),
        };
    }
}
