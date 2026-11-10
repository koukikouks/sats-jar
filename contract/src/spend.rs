//! The holder's own spend after handover. Before handover nobody spends, guardians included:
//! the rule pays out only the allowance and an emergency payment, and only to the child's address.

use crate::error::{self, refuse};
use crate::events::SatsJarEvent;
use crate::handover::Handover;
use crate::payment::{self, Output, PaymentKind, Shortfall};
use crate::{hex, history, topup, Network, SatsJar, SatsJarExt};
use btc::{BtcError, SegwitAddress};
use near_sdk::json_types::U64;
use near_sdk::{assert_one_yocto, env, near, Promise};

#[near]
impl SatsJar {
    /// The holder sends `amount` sats of the jar's Bitcoin to `to` at `fee_rate` sat/vB, only
    /// after handover; the fee is the holder's to set, with no bound. The change goes back to
    /// the jar's current address. 1 yoctoNEAR: a full-access key only. The result is the
    /// payment id.
    #[payable]
    pub fn request_spend(
        &mut self,
        jar_id: String,
        to: String,
        amount: U64,
        fee_rate: U64,
    ) -> Promise {
        let jar = self.jar(&jar_id).clone();
        // Before the deposit check, so anyone trying, a guardian included, reads this reason.
        if !matches!(jar.handover, Handover::Done { .. }) {
            refuse(
                error::SPEND_BEFORE_HANDOVER,
                "before handover only the allowance and an emergency payment can pay out, and \
                 only to the child's address",
            );
        }
        assert_one_yocto();
        if jar.owner_id != env::predecessor_account_id() {
            refuse(
                error::NOT_THE_HOLDER,
                &format!("the caller is not the holder of jar {jar_id}"),
            );
        }
        if jar.transfer.is_open() {
            refuse(
                error::TRANSFER_OPEN,
                "a transfer of this jar is open; cancel it before spending",
            );
        }
        let payee_script = payee_script(&to, self.network);
        if amount.0 < topup::DUST_FLOOR {
            refuse(
                error::AMOUNT_BELOW_DUST,
                &format!(
                    "a spend must send at least {} sats (the jar's dust floor)",
                    topup::DUST_FLOOR
                ),
            );
        }
        if fee_rate.0 < 1 {
            refuse(error::FEE_TOO_LOW, "the fee rate must be at least 1 sat/vB");
        }
        let change_script = jar.script_pubkey();
        let free = self.free_coins.get(&jar_id).cloned().unwrap_or_default();
        let shape = payment::Shape {
            payee_script_len: payee_script.len() as u64,
            change_script_len: change_script.len() as u64,
            // Coins may sit at any of the jar's addresses; size for the longest script.
            witness_script_len: (0..=jar.address_index())
                .map(|index| jar.address_at(index).witness_script.len() as u64)
                .max()
                .unwrap_or_else(|| env::abort()),
        };
        // A size floor of the whole amount (cap = 2 × amount) pays exactly `amount` or
        // refuses; the fee budget is unbounded, since the holder sets the fee freely.
        let plan = payment::plan(
            &free,
            amount.0,
            amount.0.saturating_mul(2),
            u64::MAX,
            fee_rate.0,
            &shape,
        )
        .unwrap_or_else(|shortfall| match shortfall {
            Shortfall::InsufficientBalance | Shortfall::PaymentTooSmall { .. } => refuse(
                error::INSUFFICIENT_BALANCE,
                &format!(
                    "the jar's coins (its 10 largest) cannot pay {} sats and the fee",
                    amount.0
                ),
            ),
            Shortfall::ChangeBelowDust { change } => refuse(
                error::CHANGE_BELOW_DUST,
                &format!(
                    "the change would be {change} sats, below the {}-sat dust floor; send a \
                     little more or a little less",
                    topup::DUST_FLOOR
                ),
            ),
            // The budget is u64::MAX, which no fee exceeds.
            Shortfall::FeeOverBudget { .. } => env::abort(),
        });
        crate::refuse_short_gas(plan.inputs.len());
        let mut outputs = vec![Output {
            value: plan.amount,
            script_pubkey: payee_script,
        }];
        if plan.change > 0 {
            outputs.push(Output {
                value: plan.change,
                script_pubkey: change_script,
            });
        }
        let (payment_id, txid, sighashes) = self.start_payment(
            &jar_id,
            &jar,
            &plan.inputs,
            outputs,
            plan.fee,
            PaymentKind::Spend,
        );
        self.record(
            &jar_id,
            history::Event::SpendRequested {
                payment_id: U64(payment_id),
            },
        );
        SatsJarEvent::SpendRequested {
            jar_id: jar_id.clone(),
            payment_id: U64(payment_id),
            to,
            amount: U64(plan.amount),
            fee: U64(plan.fee),
            txid: hex::display(&txid),
        }
        .emit();
        self.sign_round(&jar_id, payment_id, &sighashes, 0)
    }
}

/// The output script paying `to`, a native segwit v0 address on the contract's network (the
/// only kind the contract encodes).
fn payee_script(to: &str, network: Network) -> Vec<u8> {
    match SegwitAddress::decode(to, network.into()) {
        Ok(address) => address.script_pubkey(),
        Err(BtcError::AddressWrongNetwork) => refuse(
            error::INVALID_ADDRESS,
            "the address belongs to another Bitcoin network",
        ),
        Err(BtcError::AddressNotSegwitV0) => refuse(
            error::INVALID_ADDRESS,
            "the address must be a native segwit v0 address (bc1q or tb1q); taproot is not \
             supported",
        ),
        Err(_) => refuse(
            error::INVALID_ADDRESS,
            "the address is not a valid native segwit Bitcoin address",
        ),
    }
}
