//! NEP-297 events: one `satsjar` event per state change, plus NEP-171's own NFT events.

use near_sdk::json_types::U64;
use near_sdk::{near, AccountId};

#[near(event_json(standard = "satsjar"))]
pub enum SatsJarEvent {
    #[event_version("1.0.0")]
    JarCreated { jar_id: String, address: String },
    /// `txid` in display hex; `value` in sats.
    #[event_version("1.0.0")]
    TopupProven {
        jar_id: String,
        txid: String,
        vout: u32,
        value: U64,
    },
    /// The contract built the period's allowance and asked the signer for each input.
    /// `txid` in display hex; amounts in sats.
    #[event_version("1.0.0")]
    AllowanceRequested {
        jar_id: String,
        payment_id: U64,
        period: U64,
        amount: U64,
        fee: U64,
        txid: String,
    },
    /// Every input's signature checked; `tx` is the signed transaction, hex, ready to broadcast.
    #[event_version("1.0.0")]
    PaymentSigned {
        jar_id: String,
        payment_id: U64,
        txid: String,
        tx: String,
    },
    /// Signing failed; the inputs stay reserved for a retry of the same transaction.
    #[event_version("1.0.0")]
    PaymentSigningFailed {
        jar_id: String,
        payment_id: U64,
        reason: String,
    },
    /// A failed or stalled signing asked again, as round `attempt`, for the same transaction.
    #[event_version("1.0.0")]
    PaymentSigningRetried {
        jar_id: String,
        payment_id: U64,
        attempt: u32,
    },
    /// Proven on Bitcoin: its inputs are spent and its change (sats, 0 for none) is a coin.
    #[event_version("1.0.0")]
    PaymentConfirmed {
        jar_id: String,
        payment_id: U64,
        txid: String,
        change: U64,
    },
    /// The dev-only escape released the payment's inputs.
    #[cfg_attr(not(feature = "dev-escape"), allow(dead_code))]
    #[event_version("1.0.0")]
    PaymentCancelled { jar_id: String, payment_id: U64 },
    /// The child's account claimed the jar; `child_btc_pubkey` in hex, `lapses_at` in unix
    /// seconds (unless 2 guardians confirm first).
    #[event_version("1.0.0")]
    HandoverClaimed {
        jar_id: String,
        child_account: AccountId,
        child_btc_pubkey: String,
        lapses_at: U64,
    },
    /// A guardian confirmed the claim; the 2nd confirmation starts the public delay, which ends
    /// at `delay_ends_at` (unix seconds), null before then.
    #[event_version("1.0.0")]
    HandoverConfirmed {
        jar_id: String,
        guardian: AccountId,
        delay_ends_at: Option<U64>,
    },
    /// A guardian or the claimer cancelled the claim.
    #[event_version("1.0.0")]
    HandoverCancelled { jar_id: String, by: AccountId },
    /// A claim short of 2 confirmations lapsed at `lapsed_at` (unix seconds). Logged by the
    /// claim that replaces it, since nothing runs at the moment it lapses.
    #[event_version("1.0.0")]
    HandoverLapsed { jar_id: String, lapsed_at: U64 },
    /// A guardian proposed an emergency payment of `amount` sats to the child's address; the
    /// proposer is its first approval.
    #[event_version("1.0.0")]
    EmergencyProposed {
        jar_id: String,
        proposal_id: u32,
        guardian: AccountId,
        amount: U64,
    },
    /// A guardian approved the proposal; the 2nd approval starts the public delay, which ends
    /// at `delay_ends_at` (unix seconds), null before then.
    #[event_version("1.0.0")]
    EmergencyApproved {
        jar_id: String,
        proposal_id: u32,
        guardian: AccountId,
        delay_ends_at: Option<U64>,
    },
    /// The giver cancelled the proposal.
    #[event_version("1.0.0")]
    EmergencyCancelled { jar_id: String, proposal_id: u32 },
    /// The contract built the emergency payment and asked the signer for each input. `txid`
    /// in display hex; amounts in sats.
    #[event_version("1.0.0")]
    EmergencyExecuted {
        jar_id: String,
        proposal_id: u32,
        payment_id: U64,
        amount: U64,
        fee: U64,
        txid: String,
    },
    /// The proposal was still open when a handover's public delay ended at `lapsed_at` (unix
    /// seconds). Logged by the `cancel_handover` that follows, since nothing runs at that moment.
    #[event_version("1.0.0")]
    EmergencyLapsed {
        jar_id: String,
        proposal_id: u32,
        lapsed_at: U64,
    },
}

#[near(serializers = [json])]
pub struct NftMintData {
    pub owner_id: AccountId,
    pub token_ids: Vec<String>,
}

/// NEP-171's events (version 1.0.0 is the one that defines `nft_mint`).
#[near(event_json(standard = "nep171"))]
pub enum Nep171Event {
    #[event_version("1.0.0")]
    NftMint(Vec<NftMintData>),
}
