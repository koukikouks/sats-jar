//! Re-homing payments: moving coins to the jar's current address, one payment of up to 10 coins
//! at a time, for a handover and for strays (top-ups to an address the jar has moved away from).

use crate::coins::Coin;
use crate::error::{self, refuse};
use crate::events::SatsJarEvent;
use crate::handover::Handover;
use crate::jar::Jar;
use crate::payment::{self, FreeCoin, Output, PaymentKind, RehomingShortfall};
use crate::{hex, history, SatsJar, SatsJarExt};
use near_sdk::json_types::U64;
use near_sdk::{env, near, Promise};

#[near]
impl SatsJar {
    /// Moves the jar's strays, its proven coins at old jar addresses, to the current address;
    /// anyone may call it. Each call moves up to 10, largest first, in one payment whose fee is
    /// at most 5% of the value moved or the cost at 1 sat/vB if that is higher. The result is
    /// the payment id.
    pub fn rehome_stray(&mut self, jar_id: String, fee_rate: U64) -> Promise {
        let jar = self.jar(&jar_id).clone();
        refuse_while_rehoming(&jar);
        let current = jar.address_index();
        let strays: Vec<FreeCoin> = self
            .free_coins
            .get(&jar_id)
            .map_or(&[][..], Vec::as_slice)
            .iter()
            .filter(|coin| coin.address != current)
            .take(payment::MAX_INPUTS)
            .copied()
            .collect();
        if strays.is_empty() {
            refuse(
                error::NO_STRAYS,
                "no proven coin waits at an old address of this jar",
            );
        }
        if fee_rate.0 < 1 {
            refuse(error::FEE_TOO_LOW, "the fee rate must be at least 1 sat/vB");
        }
        self.start_rehoming(&jar_id, jar, &strays, fee_rate.0)
    }
}

/// Refuses while the jar's coins are being re-homed for a move (a completing handover): the
/// strays are swept once the jar has moved, so a sweep never makes the move wait for it.
fn refuse_while_rehoming(jar: &Jar) {
    if matches!(jar.handover, Handover::Completing { .. }) {
        refuse(
            error::REHOMING_IN_PROGRESS,
            "the jar's coins are moving to its new address; strays are swept once the jar has \
             moved",
        );
    }
}

impl SatsJar {
    /// Builds one re-homing payment of `coins` (free, at most the first 10, never empty) into one
    /// output to the jar's current address at `fee_rate` sat/vB, stores `jar`, and asks the
    /// signer for each input; the promise returns the payment id. Each input signs with its own
    /// address's script.
    pub(crate) fn start_rehoming(
        &mut self,
        jar_id: &str,
        jar: Jar,
        coins: &[FreeCoin],
        fee_rate: u64,
    ) -> Promise {
        let inputs: Vec<Coin> = coins
            .iter()
            .take(payment::MAX_INPUTS)
            .map(|coin| self.coin(jar_id, coin.index))
            .collect();
        let to = jar.script_pubkey();
        let shape = payment::Shape {
            payee_script_len: to.len() as u64,
            change_script_len: 0,
            witness_script_len: inputs
                .iter()
                .map(|coin| jar.address_at(coin.address).witness_script.len() as u64)
                .max()
                // Every caller has at least one coin to move.
                .unwrap_or_else(|| env::abort()),
        };
        let plan = payment::plan_rehoming(coins, fee_rate, &shape).unwrap_or_else(
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
            jar_id,
            &jar,
            &plan.inputs,
            outputs,
            plan.fee,
            PaymentKind::Rehoming,
        );
        self.jars.insert(jar_id.to_owned(), jar);
        self.record(
            jar_id,
            history::Event::RehomingRequested {
                payment_id: U64(payment_id),
            },
        );
        SatsJarEvent::RehomingRequested {
            jar_id: jar_id.to_owned(),
            payment_id: U64(payment_id),
            amount: U64(plan.amount),
            fee: U64(plan.fee),
            txid: hex::display(&txid),
        }
        .emit();
        self.sign_round(jar_id, payment_id, &sighashes, 0)
    }
}
