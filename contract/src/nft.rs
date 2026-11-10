//! The jar as an NFT: NEP-171 core, NEP-177 metadata, NEP-178 approvals and NEP-181
//! enumeration. The token id is the jar id and the holder is `Jar.owner_id`.

use crate::error::{self, refuse};
use crate::events::{Nep171Event, NftTransferData};
use crate::handover::Handover;
use crate::jar::Jar;
use crate::svg::{self, Picture};
use crate::{SatsJar, SatsJarExt, StorageKey};
use near_sdk::base64::{engine::general_purpose::STANDARD, Engine};
use near_sdk::json_types::{Base64VecU8, U128};
use near_sdk::store::IterableSet;
use near_sdk::{assert_one_yocto, env, near, AccountId, Promise, PromiseOrValue};
use std::collections::HashMap;

/// At most this many tokens per enumeration page (each one carries its picture).
const MAX_TOKENS_PAGE: u64 = 50;

/// NEP-171's token, with NEP-177's metadata and NEP-178's approvals.
#[near(serializers = [json])]
pub struct Token {
    pub token_id: String,
    pub owner_id: AccountId,
    pub metadata: Option<TokenMetadata>,
    pub approved_account_ids: Option<HashMap<AccountId, u64>>,
}

/// NEP-177's contract metadata.
#[near(serializers = [json])]
pub struct NftContractMetadata {
    pub spec: String,
    pub name: String,
    pub symbol: String,
    pub icon: Option<String>,
    pub base_uri: Option<String>,
    pub reference: Option<String>,
    pub reference_hash: Option<Base64VecU8>,
}

/// NEP-177's token metadata, built from the jar's state on every view.
#[near(serializers = [json])]
pub struct TokenMetadata {
    pub title: Option<String>,
    pub description: Option<String>,
    /// The picture as a `data:` URL, so it lives on chain.
    pub media: Option<String>,
    /// SHA-256 of the SVG; NEP-177 requires it whenever `media` is set.
    pub media_hash: Option<Base64VecU8>,
    pub copies: Option<u64>,
    pub issued_at: Option<String>,
    pub expires_at: Option<String>,
    pub starts_at: Option<String>,
    pub updated_at: Option<String>,
    pub extra: Option<String>,
    pub reference: Option<String>,
    pub reference_hash: Option<Base64VecU8>,
}

#[near]
impl SatsJar {
    pub fn nft_metadata(&self) -> NftContractMetadata {
        NftContractMetadata {
            spec: "nft-1.0.0".to_owned(),
            name: "Sats Jar".to_owned(),
            symbol: "JAR".to_owned(),
            icon: None,
            base_uri: None,
            reference: None,
            reference_hash: None,
        }
    }

    pub fn nft_token(&self, token_id: String) -> Option<Token> {
        self.jars.get(&token_id).map(|jar| token(&token_id, jar))
    }

    /// Refused: a jar moves only through `start_transfer`. Payable so a wallet's 1 yoctoNEAR
    /// reaches this reason rather than the SDK's deposit refusal.
    #[payable]
    #[allow(unused_variables)]
    pub fn nft_transfer(
        &mut self,
        receiver_id: AccountId,
        token_id: String,
        approval_id: Option<u64>,
        memo: Option<String>,
    ) {
        refuse_plain_transfer()
    }

    /// Refused, as `nft_transfer`.
    #[payable]
    #[allow(unused_variables)]
    pub fn nft_transfer_call(
        &mut self,
        receiver_id: AccountId,
        token_id: String,
        approval_id: Option<u64>,
        memo: Option<String>,
        msg: String,
    ) -> PromiseOrValue<bool> {
        refuse_plain_transfer()
    }

    /// Refused before handover (spec #1), so nobody approved by an adult can take the jar.
    /// Approvals after handover arrive with T12.
    #[payable]
    #[allow(unused_variables)]
    pub fn nft_approve(
        &mut self,
        token_id: String,
        account_id: AccountId,
        msg: Option<String>,
    ) -> Option<Promise> {
        let jar = self.jar(&token_id);
        // Exhaustive on purpose: each new handover state must decide whether approvals open.
        match jar.handover {
            Handover::None
            | Handover::Claimed { .. }
            | Handover::Confirmed { .. }
            | Handover::Completing { .. } => refuse(
                error::APPROVAL_BEFORE_HANDOVER,
                "a jar takes no approvals before handover",
            ),
            // Placeholder until T12 builds approvals after handover; it must be gone before T14.
            Handover::Done { .. } => refuse(
                error::APPROVALS_UNAVAILABLE,
                "this contract does not take approvals yet",
            ),
        }
    }

    /// The holder only, with 1 yoctoNEAR. Nothing to clear: no jar has an approval before
    /// handover.
    #[payable]
    #[allow(unused_variables)]
    pub fn nft_revoke(&mut self, token_id: String, account_id: AccountId) {
        self.check_holder(&token_id);
    }

    /// As `nft_revoke`, for every approved account.
    #[payable]
    pub fn nft_revoke_all(&mut self, token_id: String) {
        self.check_holder(&token_id);
    }

    /// No jar has an approval before handover.
    #[allow(unused_variables)]
    pub fn nft_is_approved(
        &self,
        token_id: String,
        approved_account_id: AccountId,
        approval_id: Option<u64>,
    ) -> bool {
        false
    }

    /// Jars are never burned, so the supply is the number of jars created.
    pub fn nft_total_supply(&self) -> U128 {
        U128(u128::from(self.next_jar_id - 1))
    }

    /// Jar ids run 1, 2, 3..., so index i is jar i + 1.
    pub fn nft_tokens(&self, from_index: Option<U128>, limit: Option<u64>) -> Vec<Token> {
        let total = self.next_jar_id - 1;
        let Ok(start) = u64::try_from(from_index.map_or(0, |i| i.0)) else {
            return Vec::new();
        };
        let end = start.saturating_add(page(limit)).min(total);
        (start..end)
            .filter_map(|i| {
                let jar_id = (i + 1).to_string();
                self.jars.get(&jar_id).map(|jar| token(&jar_id, jar))
            })
            .collect()
    }

    pub fn nft_supply_for_owner(&self, account_id: AccountId) -> U128 {
        U128(
            self.holders
                .get(&account_id)
                .map_or(0, |jars| jars.len().into()),
        )
    }

    pub fn nft_tokens_for_owner(
        &self,
        account_id: AccountId,
        from_index: Option<U128>,
        limit: Option<u64>,
    ) -> Vec<Token> {
        let (Some(held), Ok(start)) = (
            self.holders.get(&account_id),
            usize::try_from(from_index.map_or(0, |i| i.0)),
        ) else {
            return Vec::new();
        };
        held.iter()
            .skip(start)
            .take(usize::try_from(page(limit)).unwrap_or(0))
            .filter_map(|jar_id| self.jars.get(jar_id).map(|jar| token(jar_id, jar)))
            .collect()
    }
}

impl SatsJar {
    /// The jar, or a refusal naming the unknown id.
    pub(crate) fn jar(&self, jar_id: &str) -> &Jar {
        self.jars
            .get(jar_id)
            .unwrap_or_else(|| refuse(error::UNKNOWN_JAR, &format!("there is no jar {jar_id}")))
    }

    /// Refuses unless the caller holds the jar and attached exactly 1 yoctoNEAR (a full-access
    /// key signed it).
    fn check_holder(&self, jar_id: &str) {
        assert_one_yocto();
        if self.jar(jar_id).owner_id != env::predecessor_account_id() {
            refuse(
                error::NOT_THE_HOLDER,
                &format!("the caller is not the holder of jar {jar_id}"),
            );
        }
    }

    /// Moves the jar to `to`: its holder, both holders' sets and NEP-171's `nft_transfer` event
    /// change together. The caller writes `jar` back.
    pub(crate) fn move_jar(&mut self, jar_id: &str, jar: &mut Jar, to: AccountId) {
        let from = std::mem::replace(&mut jar.owner_id, to.clone());
        let emptied = self.holders.get_mut(&from).is_some_and(|held| {
            held.remove(jar_id);
            held.flush();
            held.is_empty()
        });
        if emptied {
            self.holders.remove(&from);
        }
        self.add_to_holder(&to, jar_id);
        Nep171Event::NftTransfer(vec![NftTransferData {
            old_owner_id: from,
            new_owner_id: to,
            token_ids: vec![jar_id.to_owned()],
        }])
        .emit();
    }

    /// Adds a jar to its holder's set and writes both the set and the map, so a storage
    /// measurement taken after this call counts every byte.
    pub(crate) fn add_to_holder(&mut self, holder: &AccountId, jar_id: &str) {
        let held = self.holders.entry(holder.clone()).or_insert_with(|| {
            IterableSet::new(StorageKey::HolderJars {
                account_hash: env::sha256_array(holder.as_bytes()),
            })
        });
        held.insert(jar_id.to_owned());
        held.flush();
        self.holders.flush();
    }
}

fn refuse_plain_transfer() -> ! {
    refuse(
        error::PLAIN_TRANSFER_REFUSED,
        "a jar moves only through start_transfer, which re-homes its Bitcoin first",
    )
}

/// A page size: the caller's limit, at most `MAX_TOKENS_PAGE`.
fn page(limit: Option<u64>) -> u64 {
    limit.unwrap_or(MAX_TOKENS_PAGE).min(MAX_TOKENS_PAGE)
}

fn token(jar_id: &str, jar: &Jar) -> Token {
    Token {
        token_id: jar_id.to_owned(),
        owner_id: jar.owner_id.clone(),
        metadata: Some(metadata(jar_id, jar)),
        // Approvals open only after handover (T12); until then there are none.
        approved_account_ids: Some(HashMap::new()),
    }
}

fn metadata(jar_id: &str, jar: &Jar) -> TokenMetadata {
    let now = env::block_timestamp_ms() / 1_000;
    let svg = svg::render(&Picture {
        nickname: jar.args.nickname.clone(),
        balance: jar.proven_balance,
        cap: jar.args.cap.0,
        unlock_at: jar.args.unlock_at.0,
        next_allowance_at: jar.allowance_at(now).2,
        now,
    });
    TokenMetadata {
        title: Some(format!("Sats Jar #{jar_id}")),
        description: Some(format!(
            "{}: {} sats, unlocks {}",
            jar.args.nickname,
            svg::sats(jar.proven_balance),
            svg::date(jar.args.unlock_at.0)
        )),
        media: Some(format!(
            "data:image/svg+xml;base64,{}",
            STANDARD.encode(&svg)
        )),
        media_hash: Some(env::sha256_array(svg.as_bytes()).to_vec().into()),
        copies: None,
        issued_at: None,
        expires_at: None,
        starts_at: None,
        updated_at: None,
        extra: None,
        reference: None,
        reference_hash: None,
    }
}
