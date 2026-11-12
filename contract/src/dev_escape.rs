//! The dev-only escape: compiled only with the `dev-escape` feature, which the reproducible
//! (locked) build never enables, so the locked contract's code hash shows it is absent (ADR 0008).

use crate::coins::CoinStatus;
use crate::error::{self, refuse};
use crate::events::SatsJarEvent;
use crate::history;
use crate::payment::{self, FreeCoin, PaymentStatus};
use crate::{SatsJar, SatsJarExt};
use near_sdk::json_types::U64;
use near_sdk::near;

#[near]
impl SatsJar {
    /// Releases the coins a payment reserved, for a payment whose broadcast Bitcoin rejected as
    /// invalid. The payment becomes `cancelled` (final, so a late signing answer is ignored and
    /// it can never be confirmed); its period stays paid.
    #[private]
    pub fn dev_cancel_payment(&mut self, payment_id: U64) {
        let mut payment = self.payment(payment_id.0);
        match payment.status {
            PaymentStatus::Confirmed => refuse(
                error::PAYMENT_ALREADY_CONFIRMED,
                "a confirmed payment cannot be cancelled",
            ),
            PaymentStatus::Cancelled => refuse(
                error::PAYMENT_CANCELLED,
                "this payment is already cancelled",
            ),
            _ => {}
        }
        let jar_id = payment.jar_id.clone();
        let mut free = self.free_coins.get(&jar_id).cloned().unwrap_or_default();
        for &index in &payment.inputs {
            let mut coin = self.coin(&jar_id, index);
            coin.status = CoinStatus::Confirmed;
            payment::insert_free(
                &mut free,
                FreeCoin {
                    value: coin.value,
                    index,
                    address: coin.address,
                },
            );
            self.coins.insert((jar_id.clone(), index), coin);
        }
        self.free_coins.insert(jar_id.clone(), free);
        payment.status = PaymentStatus::Cancelled;
        self.payments.insert(payment_id.0, payment);
        self.record(&jar_id, history::Event::PaymentCancelled { payment_id });
        SatsJarEvent::PaymentCancelled { jar_id, payment_id }.emit();
    }
}
