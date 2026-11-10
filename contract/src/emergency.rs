//! The emergency payment (ADR 0005): a guardian proposes an amount of at most 3 × cap, a second
//! guardian approves, a public delay runs during which the giver can cancel, then anyone
//! executes it to the child's address. One proposal at a time. The state machine is pure (time
//! comes in as `now`); the contract's calls follow it.

use crate::error::{self, refuse};
use crate::events::SatsJarEvent;
use crate::handover::Handover;
use crate::jar::{demo_timing, Jar, LARGEST_ONE_INPUT_PAYMENT_VSIZE};
use crate::payment::{self, Output, PaymentKind, Shape, Shortfall};
use crate::{hex, history, refuse_short_gas, rule, topup, Network, SatsJar, SatsJarExt};
use near_sdk::json_types::U64;
use near_sdk::{assert_one_yocto, env, near, AccountId, Promise};

/// An emergency payment is at most this many caps (ADR 0005).
const MAX_CAPS: u64 = 3;
const DAY: u64 = 86_400;
/// The public delay after the 2nd approval (ADR 0005).
const DELAY: u64 = 30 * DAY;
/// Under demo timing off mainnet, days become minutes.
const DEMO_DELAY: u64 = 30 * 60;
/// Guardians needed to approve a proposal, the proposer included.
const APPROVALS: usize = 2;

/// Seconds from the 2nd approval until the public delay ends.
pub fn delay(demo_timing: bool, network: Network) -> u64 {
    if demo_timing && network != Network::Mainnet {
        DEMO_DELAY
    } else {
        DELAY
    }
}

/// A jar's emergency payments: the latest proposal.
#[near(serializers = [borsh])]
#[derive(Debug, Clone, Default)]
pub struct Emergency {
    /// The latest proposal's id; a jar's proposals are numbered from 1.
    pub last_id: u32,
    pub proposal: Proposal,
    /// The latest emergency payment, so a new one waits until it is confirmed.
    pub payment: Option<u64>,
}

/// Where the latest proposal is.
#[near(serializers = [borsh])]
#[derive(Debug, Clone, Default)]
pub enum Proposal {
    #[default]
    None,
    /// Waiting for a second approval, or (once `delay_ends_at` is set) for its public delay.
    Open {
        id: u32,
        /// Sats.
        amount: u64,
        /// The proposer first.
        approved_by: Vec<AccountId>,
        /// Unix seconds.
        proposed_at: u64,
        /// Unix seconds; set by the 2nd approval.
        delay_ends_at: Option<u64>,
    },
    /// The giver cancelled it.
    Cancelled { id: u32 },
    /// Paid by payment `payment_id`.
    Executed { id: u32, payment_id: u64 },
    /// Still open when a handover's public delay ended at `lapsed_at` (unix seconds). Recorded
    /// when that handover is cancelled; until then an open proposal reads as lapsed from the
    /// delay's end.
    Lapsed { id: u32, lapsed_at: u64 },
}

/// The latest proposal as `get_jar` shows it at a given time.
#[near(serializers = [json])]
#[derive(Debug, Clone)]
#[serde(rename_all = "snake_case")]
pub enum EmergencyView {
    None,
    Open {
        proposal_id: u32,
        amount: U64,
        approved_by: Vec<AccountId>,
        proposed_at: U64,
        delay_ends_at: Option<U64>,
    },
    Cancelled {
        proposal_id: u32,
    },
    Executed {
        proposal_id: u32,
        payment_id: U64,
    },
    Lapsed {
        proposal_id: u32,
    },
}

impl Emergency {
    /// Opens a proposal of `amount` sats by `guardian`, who is its first approval; returns its id.
    pub fn propose(&mut self, guardian: AccountId, amount: u64, now: u64) -> u32 {
        if let Proposal::Open { id, .. } = self.proposal {
            refuse(
                error::PROPOSAL_OPEN,
                &format!("emergency proposal {id} is still open; only one runs at a time"),
            );
        }
        // 2^32 proposals, each needing a guardian's transaction, would cost far more gas than exists.
        let id = self.last_id.checked_add(1).unwrap_or_else(|| env::abort());
        self.last_id = id;
        self.proposal = Proposal::Open {
            id,
            amount,
            approved_by: vec![guardian],
            proposed_at: now,
            delay_ends_at: None,
        };
        id
    }

    /// Records `guardian`'s approval, at `now`, of proposal `proposal_id`, which must be the open
    /// one; the 2nd approval starts the public delay, and its end is returned.
    pub fn approve(
        &mut self,
        guardian: &AccountId,
        proposal_id: u32,
        now: u64,
        delay: u64,
    ) -> Option<u64> {
        self.refuse_cancelled(Some(proposal_id));
        let Proposal::Open {
            id,
            approved_by,
            delay_ends_at,
            ..
        } = &mut self.proposal
        else {
            refuse(error::NO_OPEN_PROPOSAL, "no emergency proposal is open")
        };
        if *id != proposal_id {
            refuse(
                error::PROPOSAL_CHANGED,
                &format!(
                    "the open emergency proposal is {id}, not {proposal_id}; read it again before \
                     approving"
                ),
            );
        }
        if approved_by.contains(guardian) {
            refuse(
                error::ALREADY_APPROVED,
                &format!("{guardian} already approved this proposal"),
            );
        }
        if approved_by.len() >= APPROVALS {
            refuse(
                error::ALREADY_APPROVED,
                "2 guardians already approved this proposal",
            );
        }
        approved_by.push(guardian.clone());
        if approved_by.len() < APPROVALS {
            return None;
        }
        *delay_ends_at = Some(now.saturating_add(delay));
        *delay_ends_at
    }

    /// Cancels the open proposal at `now`, while its public delay has not passed; returns its id.
    pub fn cancel(&mut self, now: u64) -> u32 {
        self.refuse_cancelled(None);
        let Proposal::Open {
            id, delay_ends_at, ..
        } = self.proposal
        else {
            refuse(error::NO_OPEN_PROPOSAL, "no emergency proposal is open")
        };
        // One boundary with execution: from `delay_ends_at` on it can be executed, not cancelled.
        if delay_ends_at.is_some_and(|end| now >= end) {
            refuse(
                error::DELAY_PASSED,
                &format!(
                    "the public delay of emergency proposal {id} has passed; it can no longer be \
                     cancelled"
                ),
            );
        }
        self.proposal = Proposal::Cancelled { id };
        id
    }

    /// The open proposal's id and amount, if it can be paid at `now`: approved by 2 guardians
    /// and past its public delay.
    pub fn due(&self, now: u64) -> (u32, u64) {
        self.refuse_cancelled(None);
        let Proposal::Open {
            id,
            amount,
            approved_by,
            delay_ends_at,
            ..
        } = &self.proposal
        else {
            refuse(error::NO_OPEN_PROPOSAL, "no emergency proposal is open")
        };
        let Some(delay_ends_at) = delay_ends_at.filter(|_| approved_by.len() >= APPROVALS) else {
            refuse(
                error::EMERGENCY_NOT_APPROVED,
                &format!(
                    "emergency proposal {id} needs a 2nd guardian's approval, which starts its \
                     public delay"
                ),
            )
        };
        if now < delay_ends_at {
            refuse(
                error::DELAY_NOT_PASSED,
                &format!(
                    "the public delay of emergency proposal {id} ends in {}",
                    rule::wait(delay_ends_at - now)
                ),
            );
        }
        (*id, *amount)
    }

    /// Marks the open proposal paid by `payment_id`.
    pub fn executed(&mut self, payment_id: u64) {
        if let Proposal::Open { id, .. } = self.proposal {
            self.proposal = Proposal::Executed { id, payment_id };
            self.payment = Some(payment_id);
        }
    }

    /// Lapses the open proposal if `handover`'s public delay has ended by `now`; returns its id
    /// and when it lapsed (the delay's end).
    pub fn lapse(&mut self, handover: &Handover, now: u64) -> Option<(u32, u64)> {
        let (Proposal::Open { id, .. }, Handover::Confirmed { delay_ends_at, .. }) =
            (&self.proposal, handover)
        else {
            return None;
        };
        if now < *delay_ends_at {
            return None;
        }
        let (id, lapsed_at) = (*id, *delay_ends_at);
        self.proposal = Proposal::Lapsed { id, lapsed_at };
        Some((id, lapsed_at))
    }

    /// Refuses when the latest proposal was cancelled and is the one named (any, for `None`).
    fn refuse_cancelled(&self, named: Option<u32>) {
        if let Proposal::Cancelled { id } = self.proposal {
            if named.is_none_or(|named| named == id) {
                refuse(
                    error::EMERGENCY_CANCELLED,
                    &format!("the giver cancelled emergency proposal {id}"),
                );
            }
        }
    }

    /// The latest proposal as it stands at `now`, beside `handover`.
    pub fn view(&self, now: u64, handover: &Handover) -> EmergencyView {
        match &self.proposal {
            Proposal::Open { id, .. } if handover.payouts_stopped(now) => {
                EmergencyView::Lapsed { proposal_id: *id }
            }
            Proposal::None => EmergencyView::None,
            Proposal::Open {
                id,
                amount,
                approved_by,
                proposed_at,
                delay_ends_at,
            } => EmergencyView::Open {
                proposal_id: *id,
                amount: U64(*amount),
                approved_by: approved_by.clone(),
                proposed_at: U64(*proposed_at),
                delay_ends_at: delay_ends_at.map(U64),
            },
            Proposal::Cancelled { id } => EmergencyView::Cancelled { proposal_id: *id },
            Proposal::Executed { id, payment_id } => EmergencyView::Executed {
                proposal_id: *id,
                payment_id: U64(*payment_id),
            },
            Proposal::Lapsed { id, .. } => EmergencyView::Lapsed { proposal_id: *id },
        }
    }
}

#[near]
impl SatsJar {
    /// A guardian proposes an emergency payment of `amount` sats to the child's address; the
    /// result is the proposal id. 1 yoctoNEAR: a full-access key only.
    #[payable]
    pub fn propose_emergency(&mut self, jar_id: String, amount: U64) -> u32 {
        assert_one_yocto();
        let mut jar = self.jar(&jar_id).clone();
        let guardian = env::predecessor_account_id();
        refuse_non_guardian(&jar.args.guardians, &guardian, &jar_id);
        let now = env::block_timestamp_ms() / 1_000;
        refuse_handover_in_progress(&jar.handover, now);
        // ADR 0005: three periods' allowance. Saturating: a cap that large has no limit to pass.
        let most = jar.args.cap.0.saturating_mul(MAX_CAPS);
        if amount.0 > most {
            refuse(
                error::OVER_EMERGENCY_CAP,
                &format!("an emergency payment is at most {most} sats, 3 times the cap"),
            );
        }
        if amount.0 / 10 < LARGEST_ONE_INPUT_PAYMENT_VSIZE {
            refuse(
                error::EMERGENCY_TOO_SMALL,
                &format!(
                    "an emergency payment under {} sats could never pay its fee from its 10%",
                    LARGEST_ONE_INPUT_PAYMENT_VSIZE * 10
                ),
            );
        }
        let proposal_id = jar.emergency.propose(guardian.clone(), amount.0, now);
        self.jars.insert(jar_id.clone(), jar);
        self.record(
            &jar_id,
            history::Event::EmergencyProposed {
                proposal_id,
                guardian: guardian.clone(),
                amount,
            },
        );
        SatsJarEvent::EmergencyProposed {
            jar_id,
            proposal_id,
            guardian,
            amount,
        }
        .emit();
        proposal_id
    }

    /// A guardian approves the open proposal `proposal_id`, the one they read. Naming it means an
    /// approval can never count toward a proposal that changed after it was read. The 2nd
    /// approval starts the public delay. 1 yoctoNEAR: a full-access key only.
    #[payable]
    pub fn approve_emergency(&mut self, jar_id: String, proposal_id: u32) {
        assert_one_yocto();
        let mut jar = self.jar(&jar_id).clone();
        let guardian = env::predecessor_account_id();
        refuse_non_guardian(&jar.args.guardians, &guardian, &jar_id);
        let now = env::block_timestamp_ms() / 1_000;
        refuse_handover_in_progress(&jar.handover, now);
        let delay_ends_at = jar
            .emergency
            .approve(
                &guardian,
                proposal_id,
                now,
                delay(demo_timing(jar.args.period.0), self.network),
            )
            .map(U64);
        self.jars.insert(jar_id.clone(), jar);
        self.record(
            &jar_id,
            history::Event::EmergencyApproved {
                proposal_id,
                guardian: guardian.clone(),
                delay_ends_at,
            },
        );
        SatsJarEvent::EmergencyApproved {
            jar_id,
            proposal_id,
            guardian,
            delay_ends_at,
        }
        .emit();
    }
}

#[near]
impl SatsJar {
    /// The giver cancels the open proposal, before its 2nd approval or during its public delay.
    /// 1 yoctoNEAR: a full-access key only.
    #[payable]
    pub fn cancel_emergency(&mut self, jar_id: String) {
        assert_one_yocto();
        let mut jar = self.jar(&jar_id).clone();
        if env::predecessor_account_id() != jar.giver {
            refuse(
                error::NOT_THE_GIVER,
                &format!(
                    "only {}, the giver, can cancel an emergency payment",
                    jar.giver
                ),
            );
        }
        let now = env::block_timestamp_ms() / 1_000;
        refuse_handover_in_progress(&jar.handover, now);
        let proposal_id = jar.emergency.cancel(now);
        self.jars.insert(jar_id.clone(), jar);
        self.record(&jar_id, history::Event::EmergencyCancelled { proposal_id });
        SatsJarEvent::EmergencyCancelled {
            jar_id,
            proposal_id,
        }
        .emit();
    }
}

#[near]
impl SatsJar {
    /// Pays the open proposal once 2 guardians approved it and its public delay passed; anyone
    /// may call it. The contract picks the coins and pays exactly the proposal's amount to the
    /// child's address, with change back to the jar; the caller proposes only the fee rate in
    /// sat/vB, and the fee, from the jar, is at most 10% of the amount. The result is the
    /// payment id.
    pub fn execute_emergency(&mut self, jar_id: String, fee_rate: U64) -> Promise {
        let mut jar = self.jar(&jar_id).clone();
        let now = env::block_timestamp_ms() / 1_000;
        refuse_handover_in_progress(&jar.handover, now);
        let (proposal_id, amount) = jar.emergency.due(now);
        if let Some(pending) = jar
            .emergency
            .payment
            .filter(|id| self.payment(*id).is_pending())
        {
            refuse(
                error::PAYMENT_PENDING,
                &format!(
                    "emergency payment {pending} is not yet confirmed on Bitcoin; confirm it \
                     before the next"
                ),
            );
        }
        if fee_rate.0 < 1 {
            refuse(error::FEE_TOO_LOW, "the fee rate must be at least 1 sat/vB");
        }
        let child_script = jar.child_script_pubkey(self.network);
        let change_script = jar.script_pubkey();
        let free = self.free_coins.get(&jar_id).cloned().unwrap_or_default();
        let shape = Shape {
            payee_script_len: child_script.len() as u64,
            change_script_len: change_script.len() as u64,
            witness_script_len: jar.address.witness_script.len() as u64,
        };
        let budget = amount / 10;
        // A size floor of the whole amount: the plan pays exactly `amount` or refuses. No jar
        // holds half of u64::MAX sats, so a saturated floor only ever refuses.
        let plan = payment::plan(
            &free,
            amount,
            amount.saturating_mul(2),
            budget,
            fee_rate.0,
            &shape,
        )
        .unwrap_or_else(|shortfall| match shortfall {
            Shortfall::InsufficientBalance | Shortfall::PaymentTooSmall { .. } => refuse(
                error::INSUFFICIENT_BALANCE,
                &format!(
                    "the jar's coins cannot pay {amount} sats and the fee; wait for more top-ups"
                ),
            ),
            Shortfall::FeeOverBudget { fee, budget } => refuse(
                error::FEE_OVER_BUDGET,
                &format!(
                    "the fee would be {fee} sats, over {budget} sats, 10% of the emergency \
                     amount; wait for lower fees"
                ),
            ),
            Shortfall::ChangeBelowDust { change } => refuse(
                error::CHANGE_BELOW_DUST,
                &format!(
                    "the change would be {change} sats, below the {}-sat dust floor; wait for \
                     another top-up",
                    topup::DUST_FLOOR
                ),
            ),
        });
        refuse_short_gas(plan.inputs.len());

        let mut outputs = vec![Output {
            value: plan.amount,
            script_pubkey: child_script,
        }];
        if plan.change > 0 {
            outputs.push(Output {
                value: plan.change,
                script_pubkey: change_script,
            });
        }
        // The guard goes in before the calls: the reservation and the executed proposal are
        // what stop other transactions before the callback.
        let (payment_id, txid, sighashes) = self.start_payment(
            &jar_id,
            &jar,
            &plan.inputs,
            outputs,
            plan.fee,
            PaymentKind::Emergency { proposal_id },
        );
        jar.emergency.executed(payment_id);
        self.jars.insert(jar_id.clone(), jar);
        self.record(
            &jar_id,
            history::Event::EmergencyExecuted {
                proposal_id,
                payment_id: U64(payment_id),
            },
        );
        SatsJarEvent::EmergencyExecuted {
            jar_id: jar_id.clone(),
            proposal_id,
            payment_id: U64(payment_id),
            amount: U64(plan.amount),
            fee: U64(plan.fee),
            txid: hex::display(&txid),
        }
        .emit();
        self.sign_round(&jar_id, payment_id, &sighashes, 0)
    }
}

impl SatsJar {
    /// Records the lapse of `jar`'s open proposal if a handover's public delay has ended by
    /// `now`; `cancel_handover` calls it before it forgets that delay, so the cancel can never
    /// revive the proposal.
    pub(crate) fn lapse_emergency(&mut self, jar_id: &str, jar: &mut Jar, now: u64) {
        let Some((proposal_id, lapsed_at)) = jar.emergency.lapse(&jar.handover, now) else {
            return;
        };
        let lapsed_at = U64(lapsed_at);
        self.record(
            jar_id,
            history::Event::EmergencyLapsed {
                proposal_id,
                lapsed_at,
            },
        );
        SatsJarEvent::EmergencyLapsed {
            jar_id: jar_id.to_owned(),
            proposal_id,
            lapsed_at,
        }
        .emit();
    }
}

/// From the end of a handover's public delay no emergency call runs (spec #1, ADR 0009).
fn refuse_handover_in_progress(handover: &Handover, now: u64) {
    if handover.payouts_stopped(now) {
        refuse(
            error::HANDOVER_IN_PROGRESS,
            "the handover's public delay has ended, so no emergency payment runs and open \
             proposals have lapsed",
        );
    }
}

fn refuse_non_guardian(guardians: &[AccountId], caller: &AccountId, jar_id: &str) {
    if !guardians.contains(caller) {
        refuse(
            error::NOT_A_GUARDIAN,
            &format!("{caller} is not a guardian of jar {jar_id}"),
        );
    }
}
