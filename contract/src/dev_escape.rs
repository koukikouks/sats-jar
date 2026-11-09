//! The dev-only escape: compiled only with the `dev-escape` feature, which the reproducible
//! (locked) build never enables, so the locked contract's code hash shows it is absent (ADR 0008).

use crate::error::{self, refuse};
use crate::{SatsJar, SatsJarExt};
use near_sdk::json_types::U64;
use near_sdk::near;

#[near]
impl SatsJar {
    /// Releases the coins a payment reserved, for a payment whose broadcast Bitcoin rejected as
    /// invalid. Payments arrive in T04, so for now every id is unknown.
    #[private]
    pub fn dev_cancel_payment(&mut self, payment_id: U64) {
        refuse(
            error::UNKNOWN_PAYMENT,
            &format!("there is no payment {}", payment_id.0),
        )
    }
}
