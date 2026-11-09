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
