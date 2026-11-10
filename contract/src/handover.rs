//! Handover (ADR 0009) up to the point the Bitcoin starts moving: the child's account claims the
//! jar with its Bitcoin key, 2 guardians confirm, then a public delay runs. The state machine is
//! pure (time comes in as `now`); the contract's calls follow it.

use crate::error::{self, refuse};
use crate::events::SatsJarEvent;
use crate::jar::demo_timing;
use crate::{hex, history, Network, SatsJar, SatsJarExt};
use k256::elliptic_curve::sec1::FromEncodedPoint;
use k256::{AffinePoint, EncodedPoint};
use near_sdk::json_types::U64;
use near_sdk::{assert_one_yocto, env, near, AccountId};

const DAY: u64 = 86_400;
/// The public delay after the 2nd guardian confirms.
const DELAY: u64 = 3 * DAY;
/// A claim short of 2 confirmations lapses this long after it was made.
const LAPSE: u64 = 7 * DAY;
/// Under demo timing off mainnet, days become minutes.
const DEMO_DELAY: u64 = 3 * 60;
const DEMO_LAPSE: u64 = 7 * 60;
/// Guardians needed to confirm a claim.
const CONFIRMATIONS: usize = 2;

/// Seconds from the 2nd confirmation until the public delay ends.
pub fn delay(demo_timing: bool, network: Network) -> u64 {
    if demo_timing && network != Network::Mainnet {
        DEMO_DELAY
    } else {
        DELAY
    }
}

/// Seconds after a claim until it lapses unless 2 guardians have confirmed it.
pub fn lapse(demo_timing: bool, network: Network) -> u64 {
    if demo_timing && network != Network::Mainnet {
        DEMO_LAPSE
    } else {
        LAPSE
    }
}

/// The child's account and the Bitcoin key the jar's coins will answer to after re-homing.
#[near(serializers = [borsh])]
#[derive(Debug, Clone)]
pub struct Claim {
    pub child_account: AccountId,
    /// SEC1 compressed.
    pub child_btc_pubkey: [u8; 33],
    /// Unix seconds.
    pub claimed_at: u64,
}

/// Where the jar is in handover.
#[near(serializers = [borsh])]
#[derive(Debug, Clone, Default)]
pub enum Handover {
    #[default]
    None,
    /// Waiting for 2 guardians.
    Claimed {
        claim: Claim,
        confirmed_by: Vec<AccountId>,
        /// Unix seconds.
        lapses_at: u64,
    },
    /// 2 guardians confirmed; the public delay runs until `delay_ends_at` (unix seconds).
    Confirmed {
        claim: Claim,
        confirmed_by: Vec<AccountId>,
        delay_ends_at: u64,
    },
}

/// The handover as `get_jar` shows it at a given time.
#[near(serializers = [json])]
#[derive(Debug, Clone)]
#[serde(rename_all = "snake_case")]
pub enum HandoverView {
    None,
    Claimed {
        child_account: AccountId,
        /// Hex.
        child_btc_pubkey: String,
        claimed_at: U64,
        lapses_at: U64,
        confirmed_by: Vec<AccountId>,
    },
    Confirmed {
        child_account: AccountId,
        /// Hex.
        child_btc_pubkey: String,
        claimed_at: U64,
        confirmed_by: Vec<AccountId>,
        delay_ends_at: U64,
    },
}

impl Handover {
    /// Opens `claim`; returns when it lapses unless 2 guardians confirm it, and when the claim
    /// it replaces lapsed, if it replaces one.
    pub fn claim(&mut self, claim: Claim, lapse: u64) -> (u64, Option<u64>) {
        let now = claim.claimed_at;
        if self.open_claim(now).is_some() {
            refuse(
                error::CLAIM_OPEN,
                "a handover claim is already open; a guardian or its claimer can cancel it",
            );
        }
        let lapsed = self.lapsed_at(now);
        let lapses_at = now.saturating_add(lapse);
        *self = Handover::Claimed {
            claim,
            confirmed_by: Vec::new(),
            lapses_at,
        };
        (lapses_at, lapsed)
    }

    /// Records `guardian`'s confirmation, at `now`, of the open claim for `child_account`; the
    /// 2nd starts the public delay, and its end is returned.
    pub fn confirm(
        &mut self,
        guardian: &AccountId,
        child_account: &AccountId,
        now: u64,
        delay: u64,
    ) -> Option<u64> {
        let claim = self
            .open_claim(now)
            .unwrap_or_else(|| refuse(error::NO_OPEN_CLAIM, "no handover claim is open"));
        if claim.child_account != *child_account {
            refuse(
                error::CLAIM_CHANGED,
                &format!(
                    "the open claim is not for {child_account}; check the code on the claiming \
                     phone again"
                ),
            );
        }
        let Handover::Claimed {
            claim,
            confirmed_by,
            ..
        } = self
        else {
            refuse(
                error::CLAIM_ALREADY_CONFIRMED,
                "2 guardians already confirmed this claim",
            )
        };
        if confirmed_by.contains(guardian) {
            refuse(
                error::CLAIM_ALREADY_CONFIRMED,
                &format!("{guardian} already confirmed this claim"),
            );
        }
        confirmed_by.push(guardian.clone());
        if confirmed_by.len() < CONFIRMATIONS {
            return None;
        }
        let delay_ends_at = now.saturating_add(delay);
        *self = Handover::Confirmed {
            claim: claim.clone(),
            confirmed_by: std::mem::take(confirmed_by),
            delay_ends_at,
        };
        Some(delay_ends_at)
    }

    /// The claim open at `now`: a claim short of 2 confirmations counts as none from its lapse.
    fn open_claim(&self, now: u64) -> Option<&Claim> {
        match self {
            Handover::None => None,
            Handover::Claimed { lapses_at, .. } if now >= *lapses_at => None,
            Handover::Claimed { claim, .. } | Handover::Confirmed { claim, .. } => Some(claim),
        }
    }

    /// When the stored claim lapsed, if it has by `now`. Nothing runs at that moment, so the lapse
    /// is only recorded when the next claim replaces it.
    fn lapsed_at(&self, now: u64) -> Option<u64> {
        match self {
            Handover::Claimed { lapses_at, .. } if now >= *lapses_at => Some(*lapses_at),
            _ => None,
        }
    }

    /// Cancels the claim open at `now` for `caller`, who must be one of `guardians` or the
    /// claimer.
    pub fn cancel(&mut self, caller: &AccountId, guardians: &[AccountId], now: u64) {
        let claim = self
            .open_claim(now)
            .unwrap_or_else(|| refuse(error::NO_OPEN_CLAIM, "no handover claim is open"));
        if !guardians.contains(caller) && claim.child_account != *caller {
            refuse(
                error::NOT_GUARDIAN_OR_CLAIMER,
                &format!(
                    "only a guardian or {} can cancel this claim",
                    claim.child_account
                ),
            );
        }
        *self = Handover::None;
    }

    /// Whether no allowance (or emergency payment) may run at `now`: from the end of the public
    /// delay until the claim is cancelled.
    pub fn payouts_stopped(&self, now: u64) -> bool {
        match self {
            Handover::Confirmed { delay_ends_at, .. } => now >= *delay_ends_at,
            Handover::None | Handover::Claimed { .. } => false,
        }
    }

    /// The handover as it stands at `now`.
    pub fn view(&self, now: u64) -> HandoverView {
        if self.lapsed_at(now).is_some() {
            return HandoverView::None;
        }
        match self {
            Handover::None => HandoverView::None,
            Handover::Claimed {
                claim,
                confirmed_by,
                lapses_at,
            } => HandoverView::Claimed {
                child_account: claim.child_account.clone(),
                child_btc_pubkey: hex::encode(&claim.child_btc_pubkey),
                claimed_at: U64(claim.claimed_at),
                lapses_at: U64(*lapses_at),
                confirmed_by: confirmed_by.clone(),
            },
            Handover::Confirmed {
                claim,
                confirmed_by,
                delay_ends_at,
            } => HandoverView::Confirmed {
                child_account: claim.child_account.clone(),
                child_btc_pubkey: hex::encode(&claim.child_btc_pubkey),
                claimed_at: U64(claim.claimed_at),
                confirmed_by: confirmed_by.clone(),
                delay_ends_at: U64(*delay_ends_at),
            },
        }
    }
}

/// The child's Bitcoin key from its hex: a secp256k1 point in SEC1 compressed form, the only
/// form segwit v0 relays, so the re-homed exit branch can always be spent.
fn parse_key(text: &str) -> [u8; 33] {
    hex::decode(text)
        .and_then(|bytes| <[u8; 33]>::try_from(bytes).ok())
        .filter(|key| matches!(key[0], 0x02 | 0x03))
        .filter(|key| {
            EncodedPoint::from_bytes(key)
                .ok()
                .is_some_and(|point| bool::from(AffinePoint::from_encoded_point(&point).is_some()))
        })
        .unwrap_or_else(|| {
            refuse(
                error::INVALID_CHILD_KEY,
                "the child's Bitcoin key must be a compressed secp256k1 public key (33 bytes of hex, \
                 starting 02 or 03)",
            )
        })
}

#[near]
impl SatsJar {
    /// Claims the jar for the child's own account, which sends this call, with the Bitcoin key
    /// its recovery phrase derives (SEC1 compressed, hex). 1 yoctoNEAR: a full-access key only.
    #[payable]
    pub fn claim_handover(
        &mut self,
        jar_id: String,
        child_account: AccountId,
        child_btc_pubkey: String,
    ) {
        assert_one_yocto();
        let mut jar = self.jar(&jar_id).clone();
        if env::predecessor_account_id() != child_account {
            refuse(
                error::NOT_THE_CHILD_ACCOUNT,
                &format!("a claim for {child_account} must be sent by {child_account} itself"),
            );
        }
        let key = parse_key(&child_btc_pubkey);
        let now = env::block_timestamp_ms() / 1_000;
        let (lapses_at, lapsed) = jar.handover.claim(
            Claim {
                child_account: child_account.clone(),
                child_btc_pubkey: key,
                claimed_at: now,
            },
            lapse(demo_timing(jar.args.period.0), self.network),
        );
        self.jars.insert(jar_id.clone(), jar);
        if let Some(lapsed_at) = lapsed.map(U64) {
            self.record(&jar_id, history::Event::HandoverLapsed { lapsed_at });
            SatsJarEvent::HandoverLapsed {
                jar_id: jar_id.clone(),
                lapsed_at,
            }
            .emit();
        }
        let (child_btc_pubkey, lapses_at) = (hex::encode(&key), U64(lapses_at));
        self.record(
            &jar_id,
            history::Event::HandoverClaimed {
                child_account: child_account.clone(),
                child_btc_pubkey: child_btc_pubkey.clone(),
                lapses_at,
            },
        );
        SatsJarEvent::HandoverClaimed {
            jar_id,
            child_account,
            child_btc_pubkey,
            lapses_at,
        }
        .emit();
    }

    /// A guardian confirms the open claim after checking, in person, the code the child's phone
    /// shows for `child_account`. Naming the account means a confirmation can never count toward
    /// a claim that changed after the check. 1 yoctoNEAR: a full-access key only.
    #[payable]
    pub fn confirm_handover(&mut self, jar_id: String, child_account: AccountId) {
        assert_one_yocto();
        let mut jar = self.jar(&jar_id).clone();
        let guardian = env::predecessor_account_id();
        if !jar.args.guardians.contains(&guardian) {
            refuse(
                error::NOT_A_GUARDIAN,
                &format!("{guardian} is not a guardian of jar {jar_id}"),
            );
        }
        let now = env::block_timestamp_ms() / 1_000;
        let delay_ends_at = jar
            .handover
            .confirm(
                &guardian,
                &child_account,
                now,
                delay(demo_timing(jar.args.period.0), self.network),
            )
            .map(U64);
        self.jars.insert(jar_id.clone(), jar);
        self.record(
            &jar_id,
            history::Event::HandoverConfirmed {
                guardian: guardian.clone(),
                delay_ends_at,
            },
        );
        SatsJarEvent::HandoverConfirmed {
            jar_id,
            guardian,
            delay_ends_at,
        }
        .emit();
    }

    /// Any guardian or the claimer cancels the open claim, before or after the public delay
    /// ends; allowances resume and a fresh claim can follow. 1 yoctoNEAR: a full-access key only.
    #[payable]
    pub fn cancel_handover(&mut self, jar_id: String) {
        assert_one_yocto();
        let mut jar = self.jar(&jar_id).clone();
        let by = env::predecessor_account_id();
        let now = env::block_timestamp_ms() / 1_000;
        // Before the reset forgets the delay's end: a proposal that lapsed then stays lapsed.
        self.lapse_emergency(&jar_id, &mut jar, now);
        jar.handover.cancel(&by, &jar.args.guardians, now);
        self.jars.insert(jar_id.clone(), jar);
        self.record(
            &jar_id,
            history::Event::HandoverCancelled { by: by.clone() },
        );
        SatsJarEvent::HandoverCancelled { jar_id, by }.emit();
    }
}
