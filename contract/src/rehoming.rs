//! Re-homing payments: moving coins to the jar's current address, one payment of up to 10 coins
//! at a time, for a handover, a transfer (ADR 0009: one code path covers both) and strays
//! (top-ups to an address the jar has moved away from).

use crate::error::{self, refuse};
use crate::events::SatsJarEvent;
use crate::handover::Handover;
use crate::jar::{demo_timing, exit_delay, Jar, JarAddress};
use crate::payment::{self, FreeCoin, Output, PaymentKind, RehomingShortfall};
use crate::transfer::Transfer;
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

/// Refuses while the jar's coins are being re-homed for a move (a completing handover or an
/// accepted transfer): the strays are swept once the jar has moved, so a sweep never makes the
/// move wait for it.
fn refuse_while_rehoming(jar: &Jar) {
    if matches!(jar.handover, Handover::Completing { .. })
        || matches!(jar.transfer, Transfer::Accepted { .. })
    {
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
        let coins = &coins[..coins.len().min(payment::MAX_INPUTS)];
        // Every caller has at least one coin to move.
        if coins.is_empty() {
            env::abort();
        }
        let to = jar.script_pubkey();
        // Sized exactly as `rehoming_batch` sized it when choosing the coins.
        let shape = rehoming_shape(&jar, coins);
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

impl SatsJar {
    /// Whether a payment from the jar is pending. Every pending payment reserves at least one
    /// coin, and the proven balance still counts reserved coins, so a free list worth less
    /// means one is.
    pub(crate) fn payment_pending(&self, jar_id: &str, jar: &Jar) -> bool {
        let free_value = self
            .free_coins
            .get(jar_id)
            .map_or(&[][..], Vec::as_slice)
            .iter()
            .fold(0u64, |sum, coin| sum.saturating_add(coin.value));
        free_value < jar.proven_balance
    }

    /// Moves `jar` to a new address whose exit branch is `key` (SEC1 compressed), timelocked two
    /// years from `now` (3 hours under demo timing off mainnet); returns the address and its
    /// locktime. The old address keeps its index.
    pub(crate) fn rehome_to(&self, jar: &mut Jar, key: &[u8; 33], now: u64) -> (String, u32) {
        // HASH160 of the key: the exit branch's key hash (`OP_HASH160` checks it).
        let exit_key_hash = env::ripemd160_array(env::sha256_array(key));
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
        (jar.address(self.network), locktime)
    }

    /// The next re-homing batch of a move: up to the 10 largest free coins fixed to move (index
    /// below `fixed_below`), or, if their output at `fee_rate` would fall under dust, up to 9 of
    /// them and the largest free coin not fixed as a carrier.
    pub(crate) fn rehoming_batch(
        &self,
        jar: &Jar,
        free: &[FreeCoin],
        fixed_below: u32,
        fee_rate: u64,
    ) -> Vec<FreeCoin> {
        let fixed: Vec<FreeCoin> = free
            .iter()
            .filter(|coin| coin.index < fixed_below)
            .take(payment::MAX_INPUTS)
            .copied()
            .collect();
        // The free list is largest first.
        let carrier = free.iter().find(|coin| coin.index >= fixed_below).copied();
        payment::rehoming_batch(&fixed, carrier, fee_rate, |coins| {
            rehoming_shape(jar, coins)
        })
    }
}

/// The size inputs of a re-homing of `coins` to the jar's current address, for both the carrier
/// check and `start_rehoming`: one output, the longest input script.
fn rehoming_shape(jar: &Jar, coins: &[FreeCoin]) -> payment::Shape {
    payment::Shape {
        payee_script_len: jar.script_pubkey().len() as u64,
        change_script_len: 0,
        witness_script_len: coins
            .iter()
            .map(|coin| jar.address_at(coin.address).witness_script.len() as u64)
            .max()
            .unwrap_or(0),
    }
}

/// Counts down the coins fixed to move (index below `fixed_below`) among `spent`, a confirmed
/// payment's inputs, whatever kind of payment spent them; true once `left` reaches 0.
pub fn count_down(fixed_below: u32, left: &mut u32, spent: &[u32]) -> bool {
    let fixed = spent.iter().filter(|&&index| index < fixed_below).count();
    // More fixed coins spent than were fixed would be a broken invariant: never move early.
    *left = u32::try_from(fixed)
        .ok()
        .and_then(|fixed| left.checked_sub(fixed))
        .unwrap_or_else(|| env::abort());
    *left == 0
}
