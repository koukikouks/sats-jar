//! A jar's history: one record per state change, kept so `get_history` can list what came in
//! and what was paid out (events are logs, which a view cannot read back). Refusals are failed
//! transactions and change nothing, so they live only in the indexer.

use near_sdk::json_types::U64;
use near_sdk::near;

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
