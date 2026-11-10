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
    /// The first `complete_handover` moved the jar to its new `address`, whose exit branch is
    /// the child's key from `locktime` (unix seconds); `coins` are fixed to move there.
    #[event_version("1.0.0")]
    RehomingStarted {
        jar_id: String,
        address: String,
        locktime: u32,
        coins: u32,
    },
    /// The contract built a re-homing payment and asked the signer for each input. `txid` in
    /// display hex; `amount` (to the new address) and `fee` in sats.
    #[event_version("1.0.0")]
    RehomingRequested {
        jar_id: String,
        payment_id: U64,
        amount: U64,
        fee: U64,
        txid: String,
    },
    /// Every fixed coin moved and confirmed: the jar NFT moved to `child_account`.
    #[event_version("1.0.0")]
    HandoverCompleted {
        jar_id: String,
        child_account: AccountId,
    },
}

#[near(serializers = [json])]
pub struct NftMintData {
    pub owner_id: AccountId,
    pub token_ids: Vec<String>,
}

/// NEP-171's `nft_transfer` data; `authorized_id` and `memo` are left out (never set).
#[near(serializers = [json])]
pub struct NftTransferData {
    pub old_owner_id: AccountId,
    pub new_owner_id: AccountId,
    pub token_ids: Vec<String>,
}

/// NEP-171's events (version 1.0.0 defines `nft_mint` and `nft_transfer`).
#[near(event_json(standard = "nep171"))]
pub enum Nep171Event {
    #[event_version("1.0.0")]
    NftMint(Vec<NftMintData>),
    #[event_version("1.0.0")]
    NftTransfer(Vec<NftTransferData>),
}
