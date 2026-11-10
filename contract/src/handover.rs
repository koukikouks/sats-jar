//! Handover (ADR 0009): the child's account claims the jar with its Bitcoin key, 2 guardians
//! confirm, a public delay runs, then anyone completes it: the jar's coins are re-homed to a new
//! address whose exit branch is the child's key, and once every coin fixed at the first call has
//! moved and been confirmed, the jar NFT moves to the child's account. The state machine is pure
//! (time comes in as `now`); the contract's calls follow it.

use crate::coins::Coin;
use crate::error::{self, refuse};
use crate::events::SatsJarEvent;
use crate::jar::{demo_timing, exit_delay, JarAddress};
use crate::payment::{self, Output, PaymentKind, RehomingShortfall};
use crate::{hex, history, rule, Network, SatsJar, SatsJarExt};
use k256::elliptic_curve::sec1::FromEncodedPoint;
use k256::{AffinePoint, EncodedPoint};
use near_sdk::json_types::U64;
use near_sdk::{assert_one_yocto, env, near, AccountId, PromiseOrValue};

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
    /// `complete_handover` has run: the coins are moving to the new address. The coins to move
    /// are those free at the first call, all with an index below `fixed_below`; `left` of them
    /// are not yet spent by a confirmed payment.
    Completing {
        claim: Claim,
        confirmed_by: Vec<AccountId>,
        delay_ends_at: u64,
        fixed_below: u32,
        left: u32,
    },
    /// The jar NFT moved to the child's account at `completed_at` (unix seconds).
    Done {
        child_account: AccountId,
        completed_at: u64,
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
    Completing {
        child_account: AccountId,
        /// Hex.
        child_btc_pubkey: String,
        confirmed_by: Vec<AccountId>,
        delay_ends_at: U64,
        /// Fixed coins not yet in a re-homing payment.
        coins_to_move: u32,
        /// Fixed coins not yet moved and confirmed; the NFT moves when this reaches 0.
        coins_left: u32,
    },
    Done {
        child_account: AccountId,
        completed_at: U64,
    },
}

impl Handover {
    /// Opens `claim`; returns when it lapses unless 2 guardians confirm it, and when the claim
    /// it replaces lapsed, if it replaces one.
    pub fn claim(&mut self, claim: Claim, lapse: u64) -> (u64, Option<u64>) {
        self.refuse_if_completing();
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
            Handover::Claimed { claim, .. }
            | Handover::Confirmed { claim, .. }
            | Handover::Completing { claim, .. } => Some(claim),
            Handover::Done { .. } => None,
        }
    }

    /// From the first `complete_handover` the claim can be neither cancelled nor replaced.
    fn refuse_if_completing(&self) {
        match self {
            Handover::Completing { .. } => refuse(
                error::HANDOVER_COMPLETING,
                "the handover is completing and its Bitcoin is moving, so its claim can no \
                 longer be cancelled or replaced",
            ),
            Handover::Done { .. } => refuse(
                error::HANDOVER_DONE,
                "this jar has already been handed over",
            ),
            Handover::None | Handover::Claimed { .. } | Handover::Confirmed { .. } => {}
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
        self.refuse_if_completing();
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
            Handover::Completing { .. } | Handover::Done { .. } => true,
            Handover::None | Handover::Claimed { .. } => false,
        }
    }

    /// Refuses unless, at `now`, 2 guardians have confirmed the claim, its public delay has
    /// ended and the jar has unlocked (`unlock_at`, unix seconds).
    pub fn refuse_unless_due(&self, now: u64, unlock_at: u64) {
        let delay_ends_at = match self {
            Handover::Done { .. } => refuse(
                error::HANDOVER_DONE,
                "this jar has already been handed over",
            ),
            Handover::None | Handover::Claimed { .. } => refuse(
                error::HANDOVER_NOT_CONFIRMED,
                "2 guardians have not confirmed a handover claim",
            ),
            Handover::Confirmed { delay_ends_at, .. }
            | Handover::Completing { delay_ends_at, .. } => *delay_ends_at,
        };
        if now < delay_ends_at {
            refuse(
                error::HANDOVER_DELAY_RUNNING,
                &format!(
                    "the handover's public delay ends in {}",
                    rule::wait(delay_ends_at - now)
                ),
            );
        }
        if now < unlock_at {
            refuse(
                error::BEFORE_UNLOCK,
                &format!("the jar unlocks in {}", rule::wait(unlock_at - now)),
            );
        }
    }

    /// Starts completing a confirmed handover: the `coins` free coins, all with an index below
    /// `fixed_below`, are the ones to move.
    fn start(&mut self, fixed_below: u32, coins: u32) {
        let Handover::Confirmed {
            claim,
            confirmed_by,
            delay_ends_at,
        } = self
        else {
            env::abort()
        };
        *self = Handover::Completing {
            claim: claim.clone(),
            confirmed_by: std::mem::take(confirmed_by),
            delay_ends_at: *delay_ends_at,
            fixed_below,
            left: coins,
        };
    }

    /// While completing, counts down the fixed coins among `spent` (the coin indices a payment
    /// spent, now confirmed), whatever kind of payment spent them; true once none is left.
    pub fn count_down(&mut self, spent: &[u32]) -> bool {
        let Handover::Completing {
            fixed_below, left, ..
        } = self
        else {
            return false;
        };
        let fixed = spent.iter().filter(|&&index| index < *fixed_below).count();
        // More fixed coins spent than were fixed would be a broken invariant: never move early.
        *left = u32::try_from(fixed)
            .ok()
            .and_then(|fixed| left.checked_sub(fixed))
            .unwrap_or_else(|| env::abort());
        *left == 0
    }

    /// Ends a completing handover at `now`; returns the child's account the jar moves to.
    fn finish(&mut self, now: u64) -> AccountId {
        let Handover::Completing { claim, .. } = self else {
            env::abort()
        };
        let child_account = claim.child_account.clone();
        *self = Handover::Done {
            child_account: child_account.clone(),
            completed_at: now,
        };
        child_account
    }

    /// The bound below which coins are fixed to move, while completing.
    pub fn fixed_below(&self) -> Option<u32> {
        match self {
            Handover::Completing { fixed_below, .. } => Some(*fixed_below),
            _ => None,
        }
    }

    /// The handover as it stands at `now`; `coins_to_move` is how many fixed coins are in no
    /// re-homing payment yet (the contract counts them from the free list).
    pub fn view(&self, now: u64, coins_to_move: u32) -> HandoverView {
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
            Handover::Completing {
                claim,
                confirmed_by,
                delay_ends_at,
                left,
                ..
            } => HandoverView::Completing {
                child_account: claim.child_account.clone(),
                child_btc_pubkey: hex::encode(&claim.child_btc_pubkey),
                confirmed_by: confirmed_by.clone(),
                delay_ends_at: U64(*delay_ends_at),
                coins_to_move,
                coins_left: *left,
            },
            Handover::Done {
                child_account,
                completed_at,
            } => HandoverView::Done {
                child_account: child_account.clone(),
                completed_at: U64(*completed_at),
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

#[near]
impl SatsJar {
    /// Completes the handover after its public delay and the unlock date; anyone may call it.
    /// The first call moves the jar to a new address whose exit branch is the child's key,
    /// timelocked two years ahead, and fixes the coins to move: every coin proven by then. Each
    /// call builds one re-homing payment of up to 10 of them to the new address and asks the
    /// signer for each input; call again, once it is confirmed, until every coin has moved. The
    /// result is the payment id, or null when nothing was left to move and the jar NFT moved to
    /// the child's account in this call.
    pub fn complete_handover(
        &mut self,
        jar_id: String,
        fee_rate: U64,
    ) -> PromiseOrValue<Option<U64>> {
        let mut jar = self.jar(&jar_id).clone();
        let now = env::block_timestamp_ms() / 1_000;
        jar.handover.refuse_unless_due(now, jar.args.unlock_at.0);
        let free = self.free_coins.get(&jar_id).cloned().unwrap_or_default();
        // Every pending payment reserves at least one coin, and the proven balance still counts
        // reserved coins, so a free list worth less means a payment is pending.
        let free_value = free
            .iter()
            .fold(0u64, |sum, coin| sum.saturating_add(coin.value));
        if free_value < jar.proven_balance {
            refuse(
                error::PAYMENT_PENDING,
                "a payment from this jar is not yet confirmed on Bitcoin; confirm it before the \
                 handover continues",
            );
        }
        if fee_rate.0 < 1 {
            refuse(error::FEE_TOO_LOW, "the fee rate must be at least 1 sat/vB");
        }
        let first_call = match &jar.handover {
            Handover::Confirmed { claim, .. } => Some(claim.child_btc_pubkey),
            _ => None,
        };
        if let Some(child_btc_pubkey) = first_call {
            // HASH160 of the child's key: the exit branch's key hash (`OP_HASH160` checks it).
            let exit_key_hash = env::ripemd160_array(env::sha256_array(child_btc_pubkey));
            let locktime = now
                .checked_add(exit_delay(demo_timing(jar.args.period.0), self.network))
                .and_then(|t| u32::try_from(t).ok())
                .unwrap_or_else(|| {
                    refuse(
                        error::LOCKTIME_OUT_OF_RANGE,
                        "the exit date two years from now is past what Bitcoin can lock to (2106)",
                    )
                });
            jar.rehome(JarAddress::new(&jar.mpc_key, exit_key_hash, locktime));
            // Nothing is pending, so every coin not yet spent is free and moves.
            let coins = u32::try_from(free.len()).unwrap_or_else(|_| env::abort());
            jar.handover.start(jar.coin_count, coins);
            let address = jar.address(self.network);
            self.record(
                &jar_id,
                history::Event::RehomingStarted {
                    address: address.clone(),
                    locktime,
                    coins,
                },
            );
            SatsJarEvent::RehomingStarted {
                jar_id: jar_id.clone(),
                address,
                locktime,
                coins,
            }
            .emit();
            if coins == 0 {
                self.jars.insert(jar_id.clone(), jar);
                self.finish_handover(&jar_id, now);
                return PromiseOrValue::Value(None);
            }
        }
        let fixed_below = jar.handover.fixed_below().unwrap_or_else(|| env::abort());
        let fixed: Vec<payment::FreeCoin> = free
            .iter()
            .filter(|coin| coin.index < fixed_below)
            .take(payment::MAX_INPUTS)
            .copied()
            .collect();
        let inputs: Vec<Coin> = fixed
            .iter()
            .map(|coin| self.coin(&jar_id, coin.index))
            .collect();
        let to = jar.script_pubkey();
        let shape = payment::Shape {
            payee_script_len: to.len() as u64,
            change_script_len: 0,
            witness_script_len: inputs
                .iter()
                .map(|coin| jar.address_at(coin.address).witness_script.len() as u64)
                .max()
                // Completing with nothing left to move and nothing pending is a broken invariant.
                .unwrap_or_else(|| env::abort()),
        };
        let plan = payment::plan_rehoming(&fixed, fee_rate.0, &shape).unwrap_or_else(
            |shortfall| match shortfall {
                RehomingShortfall::FeeTooHigh { fee, bound } => refuse(
                    error::FEE_TOO_HIGH,
                    &format!(
                        "the fee would be {fee} sats, over the {bound} sats a re-homing may pay (5% \
                         of the value it moves, or the cost at 1 sat/vB if that is higher)"
                    ),
                ),
                RehomingShortfall::OutputBelowDust { amount } => refuse(
                    error::OUTPUT_BELOW_DUST,
                    &format!(
                        "the re-homed output would be {amount} sats, under Bitcoin's {}-sat dust \
                         limit",
                        payment::P2WSH_DUST
                    ),
                ),
            },
        );
        crate::refuse_short_gas(plan.inputs.len());
        let outputs = vec![Output {
            value: plan.amount,
            script_pubkey: to,
        }];
        let (payment_id, txid, sighashes) = self.start_payment(
            &jar_id,
            &jar,
            &plan.inputs,
            outputs,
            plan.fee,
            PaymentKind::Rehoming,
        );
        self.jars.insert(jar_id.clone(), jar);
        self.record(
            &jar_id,
            history::Event::RehomingRequested {
                payment_id: U64(payment_id),
            },
        );
        SatsJarEvent::RehomingRequested {
            jar_id: jar_id.clone(),
            payment_id: U64(payment_id),
            amount: U64(plan.amount),
            fee: U64(plan.fee),
            txid: hex::display(&txid),
        }
        .emit();
        PromiseOrValue::Promise(self.sign_round(&jar_id, payment_id, &sighashes, 0))
    }
}

impl SatsJar {
    /// Moves the jar NFT to the child's account once every fixed coin has moved and been
    /// confirmed; the handover is done.
    pub(crate) fn finish_handover(&mut self, jar_id: &str, now: u64) {
        let mut jar = self.jar(jar_id).clone();
        let child_account = jar.handover.finish(now);
        self.move_jar(jar_id, &mut jar, child_account.clone());
        self.jars.insert(jar_id.to_owned(), jar);
        self.record(
            jar_id,
            history::Event::HandoverCompleted {
                child_account: child_account.clone(),
            },
        );
        SatsJarEvent::HandoverCompleted {
            jar_id: jar_id.to_owned(),
            child_account,
        }
        .emit();
    }
}
