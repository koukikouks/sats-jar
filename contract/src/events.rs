//! NEP-297 events: one `satsjar` event per state change, plus NEP-171's own NFT events.

use near_sdk::{near, AccountId};

#[near(event_json(standard = "satsjar"))]
pub enum SatsJarEvent {
    #[event_version("1.0.0")]
    JarCreated { jar_id: String, address: String },
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
