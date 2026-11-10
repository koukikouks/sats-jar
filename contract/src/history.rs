//! A jar's history: one record per state change, kept so `get_history` can list what came in
//! and what was paid out (events are logs, which a view cannot read back). Refusals are failed
//! transactions and change nothing, so they live only in the indexer.

use near_sdk::json_types::U64;
use near_sdk::{near, AccountId};

/// What happened, as the matching `satsjar` event names it.
#[near(serializers = [borsh, json])]
#[derive(Debug, Clone, PartialEq, Eq)]
#[serde(tag = "event", rename_all = "snake_case")]
pub enum Event {
    JarCreated,
    /// `txid` in display hex; `value` in sats.
    TopupProven {
        txid: String,
        vout: u32,
        value: U64,
    },
    AllowanceRequested {
        payment_id: U64,
    },
    PaymentSigned {
        payment_id: U64,
    },
    PaymentSigningFailed {
        payment_id: U64,
        reason: String,
    },
    PaymentSigningRetried {
        payment_id: U64,
        attempt: u32,
    },
    PaymentConfirmed {
        payment_id: U64,
    },
    PaymentCancelled {
        payment_id: U64,
    },
    /// `child_btc_pubkey` in hex; `lapses_at` in unix seconds.
    HandoverClaimed {
        child_account: AccountId,
        child_btc_pubkey: String,
        lapses_at: U64,
    },
    /// `delay_ends_at` (unix seconds) is set by the 2nd confirmation, which starts the delay.
    HandoverConfirmed {
        guardian: AccountId,
        delay_ends_at: Option<U64>,
    },
    HandoverCancelled {
        by: AccountId,
    },
    /// Recorded when the next claim replaces the lapsed one; `lapsed_at` is when it lapsed.
    HandoverLapsed {
        lapsed_at: U64,
    },
    /// The first `complete_handover`: the jar's new `address`, whose exit branch opens at
    /// `locktime` (unix seconds), and how many coins are fixed to move there.
    RehomingStarted {
        address: String,
        locktime: u32,
        coins: u32,
    },
    RehomingRequested {
        payment_id: U64,
    },
    /// Every fixed coin moved and confirmed: the jar NFT moved to `child_account`.
    HandoverCompleted {
        child_account: AccountId,
    },
    /// `amount` in sats; the proposer is its first approval.
    EmergencyProposed {
        proposal_id: u32,
        guardian: AccountId,
        amount: U64,
    },
    /// `delay_ends_at` (unix seconds) is set by the 2nd approval, which starts the delay.
    EmergencyApproved {
        proposal_id: u32,
        guardian: AccountId,
        delay_ends_at: Option<U64>,
    },
    /// The giver cancelled it.
    EmergencyCancelled {
        proposal_id: u32,
    },
    EmergencyExecuted {
        proposal_id: u32,
        payment_id: U64,
    },
    /// Still open when a handover's public delay ended at `lapsed_at` (unix seconds); recorded
    /// by the `cancel_handover` that follows.
    EmergencyLapsed {
        proposal_id: u32,
        lapsed_at: U64,
    },
}

#[near(serializers = [borsh])]
#[derive(Debug, Clone)]
pub struct Record {
    /// Unix seconds.
    pub at: u64,
    pub event: Event,
}

#[near(serializers = [json])]
#[derive(Debug, Clone)]
pub struct Entry {
    /// The record's place in the jar's history, from 0.
    pub index: u32,
    /// Unix seconds.
    pub at: U64,
    #[serde(flatten)]
    pub event: Event,
}
