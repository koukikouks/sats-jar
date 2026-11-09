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
